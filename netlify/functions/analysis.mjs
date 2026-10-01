import { getDb, json, NO_DB, appOnly, PERSON_SELECT } from './_db.mjs';
import { computeAnalysis } from './_analysis.mjs';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const blocked = appOnly(event); if (blocked) return blocked;
  const pool = await getDb(); if (!pool) return NO_DB();
  const [p, r] = await Promise.all([
    pool.query(`select ${PERSON_SELECT} from people`),
    pool.query("select from_person_id,to_person_id,relationship_type from relationships where status='approved'"),
  ]);
  return json(200, computeAnalysis(p.rows, r.rows));
}
