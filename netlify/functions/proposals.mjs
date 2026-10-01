import { getDb, json, NO_DB, parseBody, requireToken, requireAdmin, NEED_TOKEN, isUuid, clean } from '../lib/db.mjs';
import { wouldCreateCycle, relationshipExists } from '../lib/graph.mjs';
import { notifyAdmin } from '../lib/mail.mjs';

const SENT = 'Your suggestion has been sent for approval.';

// Structural changes (new people, new links, removing a wrong link) are suggestions an administrator approves.
export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  if (event.httpMethod === 'GET') {
    // Pending suggestions can identify who submitted what, so only the administrator may list them.
    if (!(await requireAdmin(event, pool))) return json(403, { error: 'Administrator authentication required.' });
    const r = await pool.query("select id,action,payload,status,token_label,submitted_at from proposals where status='pending' order by submitted_at desc limit 100");
    return json(200, r.rows);
  }
  const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = parseBody(event); if (!body) return json(400, { error: 'Invalid request.' });
  const allowed = ['add_person', 'add_relationship', 'delete_relationship'];
  if (!allowed.includes(body.action) || !body.payload || typeof body.payload !== 'object') return json(400, { error: 'This kind of suggestion is not supported.' });
  const p = body.payload;
  let payload; let headline;

  if (body.action === 'add_person') {
    const name = clean(p.given_name, 120);
    if (!name) return json(422, { error: 'Please enter a name before submitting.' });
    if (p.parent_id && !isUuid(p.parent_id)) return json(422, { error: 'Please select a valid family member.' });
    if (p.anchor_id && !isUuid(p.anchor_id)) return json(422, { error: 'Please select a valid family member.' });
    if (!['parent', 'spouse', 'child', undefined, null].includes(p.relationship_kind)) return json(422, { error: 'Please choose how this person is related.' });
    payload = { given_name: name, surname: clean(p.surname, 120), parent_id: p.parent_id || undefined, anchor_id: p.anchor_id || undefined, relationship_kind: p.relationship_kind || undefined, notes: clean(p.notes, 500) || 'Added through the family archive.' };
    headline = `Add "${[name, payload.surname].filter(Boolean).join(' ')}"`;
  } else if (body.action === 'add_relationship') {
    if (!isUuid(p.from_person_id) || !isUuid(p.to_person_id) || !['parent', 'spouse'].includes(p.relationship_type)) return json(422, { error: 'Please select two family members and a relationship.' });
    if (p.from_person_id === p.to_person_id) return json(422, { error: 'Please select two different family members.' });
    const both = await pool.query('select count(*)::int as n from people where id = any($1::uuid[])', [[p.from_person_id, p.to_person_id]]);
    if (both.rows[0].n !== 2) return json(404, { error: 'One of those family members could not be found.' });
    if (await relationshipExists(pool, p.from_person_id, p.to_person_id, p.relationship_type)) return json(409, { error: 'That link is already in the tree.' });
    if (p.relationship_type === 'parent' && (await wouldCreateCycle(pool, p.from_person_id, p.to_person_id))) return json(422, { error: 'That would make someone their own ancestor, so it cannot be added.' });
    payload = { from_person_id: p.from_person_id, to_person_id: p.to_person_id, relationship_type: p.relationship_type };
    headline = 'Add a family link';
  } else {
    if (!isUuid(p.relationship_id)) return json(422, { error: 'Please choose the link you think is wrong.' });
    const reason = clean(p.reason, 400);
    if (!reason || reason.length < 5) return json(422, { error: 'Please tell us briefly why this link is wrong.' });
    const rel = await pool.query("select id,from_person_id,to_person_id,relationship_type from relationships where id=$1 and status='approved'", [p.relationship_id]);
    if (!rel.rows[0]) return json(404, { error: 'That link is no longer in the tree.' });
    const dup = await pool.query("select 1 from proposals where action='delete_relationship' and status='pending' and payload->>'relationship_id'=$1 limit 1", [p.relationship_id]);
    if (dup.rows[0]) return json(409, { error: 'Someone has already suggested removing this link. The administrator will review it.' });
    payload = { relationship_id: p.relationship_id, relationship: rel.rows[0], reason };
    headline = 'Remove a family link';
  }

  const r = await pool.query('insert into proposals(action,payload,token_label) values($1,$2,$3) returning id', [body.action, payload, token.label || null]);
  await notifyAdmin(pool, `Tree suggestion: ${headline}`, { heading: 'A new tree suggestion', lines: [`${token.label || 'A contributor'} suggested: ${headline}.`, payload.reason ? `Reason: ${payload.reason}` : 'Open administration to see the details.'] });
  return json(201, { ok: true, id: r.rows[0].id, message: SENT });
}
