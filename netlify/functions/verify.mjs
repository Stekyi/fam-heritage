import { getDb, json, NO_DB, parseBody, requireToken, requireAdmin, NEED_TOKEN, isUuid, audit } from '../lib/db.mjs';

// An elder (a token the administrator has marked as "elder") or the administrator can stamp a person's
// recorded facts as verified. Editing a core fact later removes the stamp automatically.
export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  if (!['POST', 'DELETE'].includes(event.httpMethod)) return json(405, { error: 'Method not allowed' });
  const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
  if (!isUuid(b.person_id)) return json(422, { error: 'Please select a family member.' });

  let who = null;
  if (event.headers && (event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'])) {
    if (!(await requireAdmin(event, pool))) return json(403, { error: 'Administrator authentication required.' });
    who = 'Administrator';
  } else {
    const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
    if (token.role !== 'elder') return json(403, { error: 'Only a family elder can verify information.' });
    who = token.label || 'Elder';
  }
  const exists = await pool.query('select 1 from people where id=$1', [b.person_id]);
  if (!exists.rows[0]) return json(404, { error: 'This family member could not be found.' });

  if (event.httpMethod === 'POST') {
    await pool.query('update people set verified_by=$1, verified_at=now() where id=$2', [who, b.person_id]);
    await audit(pool, 'verify_person', 'person', b.person_id, null, who);
    return json(200, { verified_by: who });
  }
  await pool.query('update people set verified_by=null, verified_at=null where id=$1', [b.person_id]);
  await audit(pool, 'unverify_person', 'person', b.person_id, null, who);
  return json(200, { verified_by: null });
}
