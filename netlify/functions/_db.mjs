import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_SQL, MIGRATIONS } from './_schema.mjs';

const { Pool } = pg;
let pool;
let injected = false;
let migrated;

// Tests inject an in-memory Postgres (PGlite); production uses DATABASE_URL.
export function setPool(p, { pooled = false } = {}) { pool = p; injected = !pooled; migrated = null; }

export function db() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) return null;
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
  return pool;
}

// Applies pending migrations inside one transaction guarded by a transaction-scoped advisory lock.
// (Session-level locks are unreliable behind Neon's pooled connections; transaction locks are not.)
export async function runMigrations(p) {
  const exec = (c, sql) => (typeof c.exec === 'function' ? c.exec(sql) : c.query(sql));
  await exec(p, BASE_SQL);
  for (const m of MIGRATIONS) {
    const done = await p.query('select 1 from schema_migrations where version=$1', [m.version]);
    if (done.rows[0]) continue;
    if (injected || typeof p.connect !== 'function') {
      await exec(p, m.sql);
      await p.query('insert into schema_migrations(version) values($1) on conflict do nothing', [m.version]);
      continue;
    }
    const c = await p.connect();
    try {
      await c.query('BEGIN');
      await c.query('select pg_advisory_xact_lock($1)', [7421001]);
      const again = await c.query('select 1 from schema_migrations where version=$1', [m.version]);
      if (!again.rows[0]) {
        await c.query(m.sql);
        await c.query('insert into schema_migrations(version) values($1) on conflict do nothing', [m.version]);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
}

async function seedArticle(p) {
  const have = await p.query("select 1 from articles where slug='asankran-history'");
  if (have.rows[0]) return;
  let body = '';
  const candidates = [new URL('../../data/history.txt', import.meta.url), path.join(process.cwd(), 'data/history.txt'), path.join(process.env.LAMBDA_TASK_ROOT || '/var/task', 'data/history.txt')];
  for (const file of candidates) {
    try { body = fs.readFileSync(file, 'utf8'); if (body) break; } catch { /* try next */ }
  }
  if (!body) return;
  await p.query(
    "insert into articles(slug,title,body,source_note) values('asankran-history','The History of the Asankran Kona Clan',$1,'Source document: Asankra history.pdf') on conflict (slug) do nothing",
    [body],
  );
}

// Returns a ready pool (schema migrated once per warm instance) or null when no database is configured.
export async function getDb() {
  const p = db();
  if (!p) return null;
  if (!migrated) {
    migrated = (async () => { await runMigrations(p); await seedArticle(p).catch(() => {}); })().catch((e) => { migrated = null; throw e; });
  }
  await migrated;
  return p;
}

export function json(statusCode, body, headers = {}) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }, body: JSON.stringify(body) };
}

export const NO_DB = () => json(503, { error: 'The family database is not configured yet.' });

export function parseBody(event) {
  try { return JSON.parse(event.body || '{}') || {}; } catch { return null; }
}

export function header(event, name) {
  const h = event.headers || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return undefined;
}

export function clientIp(event) {
  return header(event, 'x-nf-client-connection-ip') || header(event, 'client-ip') || (header(event, 'x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

// Data endpoints are for the app itself: refuse a visitor opening them as a downloadable page.
export function appOnly(event) {
  const dest = header(event, 'sec-fetch-dest');
  const mode = header(event, 'sec-fetch-mode');
  if (dest === 'document' || dest === 'iframe' || mode === 'navigate') {
    return json(403, { error: 'This information is only available inside the Family Heritage app.' });
  }
  return null;
}

export function adminOk(event) {
  const supplied = header(event, 'x-admin-secret');
  const secret = process.env.ADMIN_SECRET;
  if (!secret || !supplied) return false;
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

export function hmacToken(token) {
  return crypto.createHmac('sha256', process.env.TOKEN_PEPPER || process.env.ADMIN_SECRET || 'change-me').update(String(token)).digest('hex');
}
export function validTokenShape(token) { return /^\d{5}$/.test(String(token || '')); }

const FAIL_LIMIT = 20;

// Resolves the contributor token to { id, label, person_id } or null. Only FAILED attempts are rate limited.
export async function requireToken(event, p) {
  let token = header(event, 'x-family-token');
  if (!token && event.body) { try { token = JSON.parse(event.body).token; } catch { /* no body token */ } }
  if (!validTokenShape(token)) return null;
  const ip = clientIp(event);
  const failures = await p.query("select count(*)::int as n from token_attempts where ip=$1 and attempted_at > now()-interval '10 minutes'", [ip]);
  if (failures.rows[0].n >= FAIL_LIMIT) return null;
  const r = await p.query(
    `select t.id, t.label, l.person_id from access_tokens t
       left join token_person_links l on l.token_id=t.id
      where t.token_hash=$1 and t.active=true`, [hmacToken(token)]);
  if (!r.rows[0]) { await p.query('insert into token_attempts(ip) values($1)', [ip]); return null; }
  p.query("update access_tokens set last_used_at=now() where id=$1 and (last_used_at is null or last_used_at < now()-interval '1 minute')", [r.rows[0].id]).catch(() => {});
  return r.rows[0];
}

export const NEED_TOKEN = () => json(401, { error: 'You need a valid contributor token to do this.' });
export const NEED_LINK = () => json(403, { error: 'Link your contributor token to your family-tree person first (Contribute â†’ My Family Profile).' });

export async function audit(p, action, entityType, entityId, details, actor) {
  await p.query('insert into audit_log(action,entity_type,entity_id,details,actor) values($1,$2,$3,$4,$5)',
    [action, entityType, entityId ? String(entityId) : null, details ? JSON.stringify(details) : null, actor || null]).catch(() => {});
}

export const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
export const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const clean = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };
export const cleanMultiline = (v, max) => { const s = String(v ?? '').replace(/\r\n/g, '\n').trim(); return s ? s.slice(0, max) : null; };

export const PERSON_SELECT = "id,given_name,surname,aliases,sex,birth_year,death_year,to_char(birth_date,'YYYY-MM-DD') as birth_date,to_char(death_date,'YYYY-MM-DD') as death_date,birth_place,occupation,location,living_status,notes,source,photo_url";

export function pageParams(query, defLimit = 20, maxLimit = 50) {
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query?.limit, 10) || defLimit));
  const page = Math.max(1, parseInt(query?.page, 10) || 1);
  return { limit, offset: (page - 1) * limit, page };
}

