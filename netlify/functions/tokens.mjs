import { getDb, json, NO_DB, requireAdmin, hmacToken, parseBody, clean, isUuid, newStrongToken, newDigitToken } from '../lib/db.mjs';

export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  if (!(await requireAdmin(event, pool))) return json(403, { error: 'Administrator authentication required.' });

  if (event.httpMethod === 'GET') {
    const r = await pool.query(
      `select t.id,t.label,t.active,t.created_at,t.last_used_at, l.person_id,
              trim(coalesce(p.given_name,'')||' '||coalesce(p.surname,'')) as person_name
         from access_tokens t left join token_person_links l on l.token_id=t.id left join people p on p.id=l.person_id
        order by t.created_at desc`);
    return json(200, r.rows);
  }
  if (event.httpMethod === 'POST') {
    const body = parseBody(event) || {};
    const label = clean(body.label, 80) || 'Family contributor';
    const make = body.style === 'digits' ? newDigitToken : newStrongToken;
    let token; let tries = 0;
    do {
      token = make();
      const q = await pool.query('select 1 from access_tokens where token_hash=$1', [hmacToken(token)]);
      if (!q.rowCount) break;
      tries += 1;
    } while (tries < 50);
    if (tries >= 50) return json(500, { error: 'Could not generate a unique token. Please try again.' });
    await pool.query('insert into access_tokens(token_hash,label) values($1,$2)', [hmacToken(token), label]);
    return json(201, { token, label });
  }
  if (event.httpMethod === 'PATCH') {
    const body = parseBody(event) || {};
    if (!isUuid(body.id)) return json(400, { error: 'Missing token id.' });
    if (body.unlink) await pool.query('delete from token_person_links where token_id=$1', [body.id]);
    if (typeof body.active === 'boolean') await pool.query('update access_tokens set active=$1 where id=$2', [body.active, body.id]);
    return json(200, { ok: true });
  }
  return json(405, { error: 'Method not allowed' });
}
