import { getDb, json, NO_DB, parseBody, requireToken, NEED_TOKEN, isUuid, clean } from './_db.mjs';

// Structural changes (new people, new relationships) are still proposals that an administrator approves.
export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
  if (event.httpMethod === 'GET') {
    const r = await pool.query("select id,action,payload,status,token_label,submitted_at from proposals where status='pending' order by submitted_at desc limit 100");
    return json(200, r.rows);
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = parseBody(event); if (!body) return json(400, { error: 'Invalid request.' });
  const allowed = ['add_person', 'add_relationship'];
  if (!allowed.includes(body.action) || !body.payload || typeof body.payload !== 'object') return json(400, { error: 'This kind of suggestion is not supported.' });
  const p = body.payload;
  if (body.action === 'add_person') {
    const name = clean(p.given_name, 120);
    if (!name) return json(422, { error: 'Please enter a name before submitting.' });
    if (p.parent_id && !isUuid(p.parent_id)) return json(422, { error: 'Please select a valid family member.' });
    if (p.anchor_id && !isUuid(p.anchor_id)) return json(422, { error: 'Please select a valid family member.' });
    if (!['parent', 'spouse', 'child', undefined, null].includes(p.relationship_kind)) return json(422, { error: 'Please choose how this person is related.' });
    const payload = { given_name: name, surname: clean(p.surname, 120), parent_id: p.parent_id || undefined, anchor_id: p.anchor_id || undefined, relationship_kind: p.relationship_kind || undefined, notes: clean(p.notes, 500) || 'Added through the family archive.' };
    const r = await pool.query('insert into proposals(action,payload,token_label) values($1,$2,$3) returning id', ['add_person', payload, token.label || null]);
    return json(201, { ok: true, id: r.rows[0].id, message: 'Your suggestion has been sent for approval.' });
  }
  if (!isUuid(p.from_person_id) || !isUuid(p.to_person_id) || !['parent', 'spouse'].includes(p.relationship_type)) return json(422, { error: 'Please select two family members and a relationship.' });
  const r = await pool.query('insert into proposals(action,payload,token_label) values($1,$2,$3) returning id', ['add_relationship', { from_person_id: p.from_person_id, to_person_id: p.to_person_id, relationship_type: p.relationship_type }, token.label || null]);
  return json(201, { ok: true, id: r.rows[0].id, message: 'Your suggestion has been sent for approval.' });
}
