import { getDb, json, NO_DB, requireAdmin, audit, PERSON_SELECT } from '../lib/db.mjs';
import zlib from 'node:zlib';
import { toGedcom } from '../lib/gedcom.mjs';
import { buildBackup } from '../lib/backup.mjs';

// Administrator-only backup. JSON is complete (so the site can be rebuilt); GEDCOM is for other genealogy software.
// Photos and recordings are listed but not embedded; they remain in the database (and in Neon point-in-time recovery).
// Weekly snapshots taken by backup-weekly.mjs can be listed (?list=1) and downloaded (?snapshot=<id>).
export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  if (!(await requireAdmin(event, pool))) return json(403, { error: 'Administrator authentication required.' });
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const q = event.queryStringParameters || {};
  const stamp = new Date().toISOString().slice(0, 10);

  if (q.list) {
    const r = await pool.query('select id,created_at,size_bytes,counts from backups order by created_at desc');
    return json(200, { snapshots: r.rows });
  }
  if (q.snapshot) {
    if (!/^[0-9a-f-]{36}$/i.test(q.snapshot)) return json(400, { error: 'Invalid snapshot.' });
    const r = await pool.query('select created_at,data from backups where id=$1', [q.snapshot]);
    if (!r.rows[0]) return json(404, { error: 'Snapshot not found.' });
    await audit(pool, 'backup_snapshot_download', 'system', q.snapshot, null, 'admin');
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="family-backup-${new Date(r.rows[0].created_at).toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' }, body: zlib.gunzipSync(Buffer.from(r.rows[0].data)).toString('utf8') };
  }

  if (q.format === 'gedcom') {
    const [people, relationships] = await Promise.all([
      pool.query(`select ${PERSON_SELECT} from people order by lower(given_name), lower(surname)`),
      pool.query('select id,from_person_id,to_person_id,relationship_type,status,source,evidence,created_at from relationships'),
    ]);
    await audit(pool, 'backup_gedcom', 'system', null, { people: people.rows.length }, 'admin');
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="family-tree-${stamp}.ged"`, 'Cache-Control': 'no-store' }, body: toGedcom(people.rows, relationships.rows) };
  }

  const data = await buildBackup(pool);
  await audit(pool, 'backup_json', 'system', null, data.counts, 'admin');
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="family-backup-${stamp}.json"`, 'Cache-Control': 'no-store' }, body: JSON.stringify(data, null, 1) };
}
