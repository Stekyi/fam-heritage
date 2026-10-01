import { getDb, json, NO_DB, appOnly, PERSON_SELECT } from './_db.mjs';

// The tree page needs the whole graph in the browser to traverse ancestors and descendants.
// Only descriptive fields and approved relationships are returned.
export async function handler(event) {
  const blocked = appOnly(event); if (blocked) return blocked;
  const pool = await getDb(); if (!pool) return NO_DB();
  const [p, r, l] = await Promise.all([
    pool.query(`select ${PERSON_SELECT} from people order by lower(given_name),lower(surname)`),
    pool.query("select from_person_id,to_person_id,relationship_type from relationships where status='approved'"),
    pool.query('select person_id from profiles where published=true and length(about)>0'),
  ]);
  const withProfile = new Set(l.rows.map((x) => x.person_id));
  const people = p.rows.map((x) => ({ ...x, has_profile: withProfile.has(x.id) }));
  return json(200, { mode: 'database', people, relationships: r.rows });
}
