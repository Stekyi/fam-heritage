import { getDb } from '../lib/db.mjs';
import { pushConfigured, pushToAll } from '../lib/push.mjs';
import { computeCelebrations } from '../lib/celebrations.mjs';

// Scheduled daily. Remembrance days go to everyone who subscribed; birthdays of living relatives only to contributors.
export default async function pushDaily() {
  const pool = await getDb();
  if (!pool || !pushConfigured()) return new Response('push skipped: not configured', { status: 200 });
  const done = await pool.query("select 1 from audit_log where action='push_daily' and created_at > now()-interval '20 hours' limit 1");
  if (done.rows.length) return new Response('push skipped: already sent today', { status: 200 });
  const rows = (await pool.query("select id,given_name,surname,sex,birth_year,death_year,to_char(birth_date,'YYYY-MM-DD') as birth_date,to_char(death_date,'YYYY-MM-DD') as death_date,living_status,kind from people where birth_date is not null or death_date is not null")).rows;
  const cel = computeCelebrations(rows, { withinDays: 0, includeBirthdays: true });
  let sent = 0;
  for (const r of cel.remembrances) sent += (await pushToAll(pool, { title: 'Remembering today', body: `${r.name}${r.years ? ` (${r.years} years)` : ''}`, url: `/#/tree/${r.id}` })).sent;
  for (const b of cel.birthdays) sent += (await pushToAll(pool, { title: 'Birthday today', body: `${b.name}${b.turning ? ` is ${b.turning} today` : ''}`, url: `/#/tree/${b.id}` }, { contributorOnly: true })).sent;
  await pool.query("insert into audit_log(action,entity_type,details,actor) values('push_daily','system',$1,'scheduler')", [JSON.stringify({ sent })]);
  return new Response(`push sent ${sent}`, { status: 200 });
}

export const config = { schedule: '0 12 * * *' };
