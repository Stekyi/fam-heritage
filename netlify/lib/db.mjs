import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_SQL, MIGRATIONS } from './schema.mjs';

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
  // Only the platform-set header is trusted. client-ip / x-forwarded-for can be forged by the caller.
  return String(header(event, 'x-nf-client-connection-ip') || 'unknown').slice(0, 64);
}

// Data endpoints are meant for the app itself. This only stops casual "open it as a page" downloads;
// real protection against bulk copying is the per-IP read limit below plus redaction of living people's details.
export function appOnly(event) {
  const dest = header(event, 'sec-fetch-dest');
  const mode = header(event, 'sec-fetch-mode');
  if (dest === 'document' || dest === 'iframe' || mode === 'navigate') {
    return json(403, { error: 'This information is only available inside the Family Heritage app.' });
  }
  return null;
}

export function readOnlyMethods(event) {
  return ['GET', 'HEAD'].includes(event.httpMethod) ? null : json(405, { error: 'Method not allowed' });
}

// ---------------------------------------------------------------- rate limiting (shared Postgres table)
export const LIMITS = { tokenIp: 20, tokenGlobal: 500, adminIp: 10, adminGlobal: 100, comment: 5, tree: 60, search: 300, network: 120, analysis: 120, join: 30, celebrations: 120 };

async function prune(p) {
  if (Math.random() < 0.02) await p.query("delete from token_attempts where attempted_at < now()-interval '1 day'").catch(() => {});
}

// Inserts the attempt first, then counts, so parallel requests cannot all slip under the limit.
async function hit(p, buckets) {
  await prune(p);
  const ins = await p.query(`insert into token_attempts(ip) select unnest($1::text[]) returning id`, [buckets]);
  const ids = ins.rows.map((r) => r.id);
  const cnt = await p.query(
    "select ip, count(*)::int as n from token_attempts where ip = any($1::text[]) and attempted_at > now()-interval '10 minutes' group by ip", [buckets]);
  const counts = Object.fromEntries(cnt.rows.map((r) => [r.ip, r.n]));
  const release = () => p.query('delete from token_attempts where id = any($1::uuid[])', [ids]).catch(() => {});
  return { counts, release };
}

// Per-IP read limit for bulk-copyable endpoints. Returns a 429 response or null.
export async function readLimit(event, p, name) {
  const limit = LIMITS[name];
  const h = await hit(p, [`rd:${name}:${clientIp(event)}`]);
  const n = Object.values(h.counts)[0] || 0;
  if (n > limit) return json(429, { error: 'You are making requests very quickly. Please wait a few minutes and try again.' }, { 'Retry-After': '600' });
  return null;
}

// ---------------------------------------------------------------- admin
export async function requireAdmin(event, p) {
  const supplied = header(event, 'x-admin-secret');
  const secret = process.env.ADMIN_SECRET;
  if (!supplied) return false;
  const ip = clientIp(event);
  const h = await hit(p, [`adm:${ip}`, 'adm:*']);
  if ((h.counts[`adm:${ip}`] || 0) > LIMITS.adminIp || (h.counts['adm:*'] || 0) > LIMITS.adminGlobal) { await h.release(); return false; }
  if (!secret) return false;
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(String(secret)).digest();
  const ok = crypto.timingSafeEqual(a, b);
  if (ok) await h.release();
  return ok;
}

// ---------------------------------------------------------------- contributor tokens
export function hmacToken(token) {
  const pepper = process.env.TOKEN_PEPPER || process.env.ADMIN_SECRET;
  if (!pepper) throw new Error('TOKEN_PEPPER (or ADMIN_SECRET) must be set');
  return crypto.createHmac('sha256', pepper).update(String(token)).digest('hex');
}

// Legacy 5-digit tokens still work. New tokens are 8 characters (a letter first, no look-alike characters).
const STRONG_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normToken = (t) => String(t ?? '').trim().toUpperCase();
export function validTokenShape(token) { return /^(\d{5}|[A-HJ-NP-Z][A-HJ-NP-Z2-9]{7})$/.test(normToken(token)); }
export function newStrongToken() {
  let s = STRONG_ALPHA.slice(0, 24)[crypto.randomInt(0, 24)];
  for (let i = 0; i < 7; i++) s += STRONG_ALPHA[crypto.randomInt(0, STRONG_ALPHA.length)];
  return s;
}
export function newDigitToken() { return String(crypto.randomInt(0, 100000)).padStart(5, '0'); }

function tokenFrom(event) {
  let token = header(event, 'x-family-token');
  if (!token && event.body) { try { token = JSON.parse(event.body).token; } catch { /* no body token */ } }
  return token;
}

// Resolves the contributor token to { id, label, person_id } or null.
// Verification only happens while the per-IP and sitewide failure budgets allow it, so guessing is rate bound.
export async function requireToken(event, p) {
  const raw = tokenFrom(event);
  if (!validTokenShape(raw)) return null;
  const token = normToken(raw);
  const ip = clientIp(event);
  const h = await hit(p, [`tok:${ip}`, 'tok:*']);
  if ((h.counts[`tok:${ip}`] || 0) > LIMITS.tokenIp || (h.counts['tok:*'] || 0) > LIMITS.tokenGlobal) { await h.release(); return null; }
  const r = await p.query(
    `select t.id, t.label, l.person_id from access_tokens t
       left join token_person_links l on l.token_id=t.id
      where t.token_hash=$1 and t.active=true`, [hmacToken(token)]);
  if (!r.rows[0]) return null; // the failed attempt stays counted
  await h.release();
  p.query("update access_tokens set last_used_at=now() where id=$1 and (last_used_at is null or last_used_at < now()-interval '1 minute')", [r.rows[0].id]).catch(() => {});
  return r.rows[0];
}

// Like requireToken but only when a token header is present (public visitors stay anonymous).
export async function optionalToken(event, p) {
  return header(event, 'x-family-token') ? requireToken(event, p) : null;
}

export const NEED_TOKEN = () => json(401, { error: 'You need a valid contributor token to do this.' });
export const NEED_LINK = () => json(403, { error: 'Link your contributor token to your family-tree person first (Contribute \u2192 My Family Profile).' });

export async function audit(p, action, entityType, entityId, details, actor) {
  await p.query('insert into audit_log(action,entity_type,entity_id,details,actor) values($1,$2,$3,$4,$5)',
    [action, entityType, entityId ? String(entityId) : null, details ? JSON.stringify(details) : null, actor || null]).catch(() => {});
}

export const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

// Folds Akan letters and common accents to plain a-z0-9 so "Odo" finds "\u0186d\u0254".
const FOLD_FROM_L = '\u0254\u025b\u014b\u0256\u0192\u0263\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f2\u00f3\u00f4\u00f5\u00f6\u00f9\u00fa\u00fb\u00fc\u00f1\u00e7\u00fd\u00ff';
const FOLD_TO_L = 'oendfgaaaaaaeeeeiiiioooooouuuuncyy';
const FOLD_FROM = FOLD_FROM_L + FOLD_FROM_L.toUpperCase();
const FOLD_TO = FOLD_TO_L + FOLD_TO_L;
export const normName = (s) => {
  let out = '';
  for (const ch of String(s || '').toLowerCase().normalize('NFC')) { const i = FOLD_FROM.indexOf(ch); out += i >= 0 ? FOLD_TO[i] : ch; }
  return out.replace(/[^a-z0-9]/g, '');
};
export const foldSql = (expr) => `regexp_replace(translate(lower(${expr}),'${FOLD_FROM}','${FOLD_TO}'),'[^a-z0-9]','','g')`;

export const clean = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };
export const cleanMultiline = (v, max) => { const s = String(v ?? '').replace(/\r\n/g, '\n').trim(); return s ? s.slice(0, max) : null; };

export const PERSON_SELECT = "id,given_name,surname,aliases,sex,birth_year,death_year,to_char(birth_date,'YYYY-MM-DD') as birth_date,to_char(death_date,'YYYY-MM-DD') as death_date,birth_place,occupation,location,living_status,notes,source,photo_url,kind";

export function pageParams(query, defLimit = 20, maxLimit = 50) {
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query?.limit, 10) || defLimit));
  const page = Math.max(1, parseInt(query?.page, 10) || 1);
  return { limit, offset: (page - 1) * limit, page };
}
