import { getDb, json, NO_DB, parseBody, requireToken, NEED_TOKEN, isUuid, audit, PERSON_SELECT, appOnly, optionalToken } from '../lib/db.mjs';
import { validatePersonUpdate, EDITABLE, redactPerson, recordRevision } from '../lib/people.mjs';

// Changing a recorded fact removes the elder's verification, so a stamp never vouches for something it did not see.
const FACT_FIELDS = ['given_name', 'surname', 'birth_date', 'death_date', 'birth_year', 'death_year', 'birth_place'];

export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  const id = event.queryStringParameters?.id;

  if (event.httpMethod === 'GET') {
    const blocked = appOnly(event); if (blocked) return blocked;
    if (!isUuid(id)) return json(400, { error: 'Unable to load this family member.' });
    const token = await optionalToken(event, pool);
    const p = await pool.query(`select ${PERSON_SELECT} from people where id=$1`, [id]);
    if (!p.rows[0]) return json(404, { error: 'This family member could not be found.' });
    const [profile, stories] = await Promise.all([
      pool.query('select about, updated_at from profiles where person_id=$1 and published=true', [id]),
      pool.query("select id,title,created_at from stories where person_id=$1 and status='published' order by created_at desc limit 20", [id]),
    ]);
    return json(200, { person: redactPerson(p.rows[0], !!token), profile: profile.rows[0] || null, stories: stories.rows });
  }

  if (event.httpMethod === 'PATCH' || event.httpMethod === 'PUT') {
    const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
    const body = parseBody(event); if (!body) return json(400, { error: 'Invalid request.' });
    if (!isUuid(id)) return json(400, { error: 'Unable to identify this family member.' });
    const cur = await pool.query(`select ${PERSON_SELECT} from people where id=$1`, [id]);
    if (!cur.rows[0]) return json(404, { error: 'This family member could not be found.' });
    const { fields, error } = validatePersonUpdate(body, cur.rows[0]);
    if (error) return json(422, { error });
    const keys = Object.keys(fields).filter((k) => EDITABLE.includes(k));
    if (!keys.length) return json(200, { person: cur.rows[0], changed: false });
    const after = Object.fromEntries(keys.map((k) => [k, fields[k]]));
    const revId = await recordRevision(pool, id, cur.rows[0], after, { label: token.label });
    if (!revId) return json(200, { person: cur.rows[0], changed: false });
    const sets = keys.map((k, i) => `${k}=$${i + 1}`);
    const vals = keys.map((k) => fields[k]);
    vals.push(token.label || 'contributor', id);
    // Only descriptive columns are written; relationships are never touched here.
    await pool.query(`update people set ${sets.join(',')}, updated_by=$${keys.length + 1}, updated_at=now()${keys.some((k) => FACT_FIELDS.includes(k)) ? ', verified_by=null, verified_at=null' : ''} where id=$${keys.length + 2}`, vals);
    await audit(pool, 'edit_person', 'person', id, { fields: keys, revision: revId }, token.label);
    const out = await pool.query(`select ${PERSON_SELECT} from people where id=$1`, [id]);
    return json(200, { person: out.rows[0], changed: true, revision: revId });
  }
  return json(405, { error: 'Method not allowed' });
}
