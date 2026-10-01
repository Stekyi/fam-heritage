import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { setPool, getDb, hmacToken } from '../netlify/lib/db.mjs';

process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.TOKEN_PEPPER = 'test-pepper';

const root = new URL('../', import.meta.url);

export async function freshDatabase({ loadFamily = true } = {}) {
  const pg = new PGlite();
  const base = fs.readFileSync(new URL('netlify/db/001_schema.sql', root), 'utf8').replace(/create extension[^;]*;/i, '');
  await pg.exec(base);
  if (loadFamily) {
    const fx = JSON.parse(fs.readFileSync(new URL('tests/fixtures/family.json', root), 'utf8'));
    for (const p of fx.people) {
      await pg.query(
        'insert into people(id,given_name,surname,aliases,sex,birth_year,death_year,notes,source,photo_url) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [p.id, p.given_name, p.surname, p.aliases || [], p.sex, p.birth_year, p.death_year, p.notes, p.source, p.photo_url]);
    }
    for (const r of fx.relationships) {
      await pg.query('insert into relationships(from_person_id,to_person_id,relationship_type,status,source) values($1,$2,$3,$4,$5)',
        [r.from_person_id, r.to_person_id, r.relationship_type, r.status, r.source]);
    }
  }
  setPool(pg);
  await getDb();
  return pg;
}

export async function makeToken(pg, token, label = 'Tester') {
  const r = await pg.query('insert into access_tokens(token_hash,label) values($1,$2) returning id', [hmacToken(token), label]);
  return r.rows[0].id;
}

let ipCounter = 0;
export async function call(handler, { method = 'GET', query = {}, body, token, admin, headers = {}, ip } = {}) {
  const h = { 'x-nf-client-connection-ip': ip || `10.0.0.${(ipCounter++ % 250) + 1}`, ...headers };
  if (token) h['x-family-token'] = token;
  if (admin) h['x-admin-secret'] = admin === true ? process.env.ADMIN_SECRET : admin;
  const res = await handler({ httpMethod: method, queryStringParameters: query, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = res.isBase64Encoded ? res.body : JSON.parse(res.body); } catch { data = res.body; }
  return { status: res.statusCode, data, headers: res.headers, raw: res };
}

export async function relationshipSnapshot(pg) {
  const r = await pg.query('select from_person_id,to_person_id,relationship_type,status from relationships order by 1,2,3');
  return JSON.stringify(r.rows);
}

export async function personByName(pg, given, surname) {
  const r = await pg.query("select * from people where lower(given_name)=lower($1) and ($2::text is null or lower(coalesce(surname,''))=lower($2))", [given, surname ?? null]);
  return r.rows;
}
