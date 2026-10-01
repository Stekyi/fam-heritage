import { getDb, json, NO_DB, parseBody, requireToken, NEED_TOKEN, NEED_LINK, isUuid, cleanMultiline, audit, appOnly } from '../lib/db.mjs';

// Public short profile ("About me") for a family-tree person.
export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  const q = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    const blocked = appOnly(event); if (blocked) return blocked;
    if (!isUuid(q.person_id)) return json(400, { error: 'Unable to load this profile.' });
    const r = await pool.query('select about, updated_at from profiles where person_id=$1 and published=true', [q.person_id]);
    return json(200, { profile: r.rows[0] || null });
  }

  if (event.httpMethod === 'PUT' || event.httpMethod === 'POST') {
    const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
    if (!token.person_id) return NEED_LINK();
    const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
    const about = cleanMultiline(b.about, 5000);
    if (!about) return json(422, { error: 'Please write something about yourself before publishing.' });
    // A profile can only be written for the person this token is linked to.
    await pool.query(
      `insert into profiles(person_id,about,updated_by_token) values($1,$2,$3)
       on conflict (person_id) do update set about=excluded.about, updated_by_token=excluded.updated_by_token, updated_at=now(), published=true`,
      [token.person_id, about, token.id]);
    await audit(pool, 'save_profile', 'person', token.person_id, null, token.label);
    return json(200, { ok: true, person_id: token.person_id });
  }

  if (event.httpMethod === 'DELETE') {
    const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
    if (!token.person_id) return NEED_LINK();
    await pool.query('delete from profiles where person_id=$1', [token.person_id]);
    return json(200, { ok: true });
  }
  return json(405, { error: 'Method not allowed' });
}
