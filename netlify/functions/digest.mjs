import { getDb } from '../lib/db.mjs';
import { notifyAdmin, mailConfigured, siteUrl } from '../lib/mail.mjs';
import { buildDigest } from '../lib/celebrations.mjs';

// Scheduled every Monday. Emails the administrator a short summary. Harmless if called by anyone:
// it only ever emails the configured administrator address and sends at most once every 5 days.
export default async function digest(req) {
  const pool = await getDb();
  if (!pool || !mailConfigured()) return new Response('digest skipped: not configured', { status: 200 });
  const recent = await pool.query("select 1 from audit_log where action='digest_sent' and created_at > now()-interval '5 days' limit 1");
  if (recent.rows.length) return new Response('digest skipped: sent recently', { status: 200 });
  const d = await buildDigest(pool);
  const ok = await notifyAdmin(pool, d.subject, { heading: 'This week in the family archive', lines: d.lines, link: `${siteUrl()}/#/admin`, linkText: d.pending ? 'Review what is waiting' : 'Open administration' }, { force: true });
  if (ok) await pool.query("insert into audit_log(action,entity_type,details,actor) values('digest_sent','system',$1,'scheduler')", [JSON.stringify({ pending: d.pending })]);
  return new Response(ok ? 'digest sent' : 'digest failed', { status: 200 });
}

export const config = { schedule: '0 13 * * 1' };
