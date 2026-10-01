import { getDb, json, NO_DB, parseBody, requireToken, NEED_TOKEN, isUuid, audit, PERSON_SELECT, appOnly } from '../lib/db.mjs';

// "My Family Profile": links the caller's contributor token to exactly one person in the tree.
export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
  const person = async (id) => (id ? (await pool.query(`select ${PERSON_SELECT} from people where id=$1`, [id])).rows[0] || null : null);

  if (event.httpMethod === 'GET') {
    const blocked = appOnly(event); if (blocked) return blocked;
    return json(200, { token: { label: token.label }, linked_person: await person(token.person_id) });
  }

  if (event.httpMethod === 'POST') {
    const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
    if (token.person_id) {
      const cur = await person(token.person_id);
      return json(409, { error: `Your contributor token is already linked to ${[cur?.given_name, cur?.surname].filter(Boolean).join(' ')}. Unlink it first to choose someone else.`, linked_person: cur });
    }
    if (!isUuid(b.person_id)) return json(422, { error: 'Please select a family member before linking your token.' });
    const target = await person(b.person_id);
    if (!target) return json(404, { error: 'This family member could not be found.' });
    const taken = await pool.query('select 1 from token_person_links where person_id=$1', [b.person_id]);
    if (taken.rows[0]) return json(409, { error: 'That family member is already linked to another contributor. Please ask the administrator for help.' });
    await pool.query('insert into token_person_links(token_id,person_id) values($1,$2)', [token.id, b.person_id]);
    await audit(pool, 'link_token', 'person', b.person_id, null, token.label);
    return json(201, { linked_person: target });
  }

  if (event.httpMethod === 'DELETE') {
    await pool.query('delete from token_person_links where token_id=$1', [token.id]);
    return json(200, { ok: true });
  }
  return json(405, { error: 'Method not allowed' });
}
