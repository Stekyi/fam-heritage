import zlib from 'node:zlib';
import { getDb } from '../lib/db.mjs';
import { buildBackup } from '../lib/backup.mjs';

// Scheduled every Sunday. Keeps the last 8 compressed snapshots inside the database so a bad edit or a
// mistake can be rolled back even without Neon recovery. Download them from Admin -> Backup.
export default async function weeklyBackup() {
  const pool = await getDb();
  if (!pool) return new Response('backup skipped: no database', { status: 200 });
  const recent = await pool.query("select 1 from backups where created_at > now()-interval '5 days' limit 1");
  if (recent.rows.length) return new Response('backup skipped: taken recently', { status: 200 });
  const data = await buildBackup(pool);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  await pool.query('insert into backups(size_bytes,counts,data) values($1,$2,$3)', [gz.length, JSON.stringify(data.counts), gz]);
  await pool.query('delete from backups where id not in (select id from backups order by created_at desc limit 8)');
  await pool.query("insert into audit_log(action,entity_type,details,actor) values('backup_scheduled','system',$1,'scheduler')", [JSON.stringify(data.counts)]);
  return new Response('backup stored', { status: 200 });
}

export const config = { schedule: '0 6 * * 0' };
