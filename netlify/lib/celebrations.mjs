import { livingClass } from './people.mjs';

// Upcoming birthdays (living people with a recorded full birth date) and remembrance days (deceased with a full death date).
export function nextOccurrence(isoDate, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  if (!m) return null;
  const mon = Number(m[2]) - 1; const day = Number(m[3]);
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let year = today.getUTCFullYear();
  let at = Date.UTC(year, mon, day); // Feb 29 in a common year rolls to 1 March
  if (at < t0) { year += 1; at = Date.UTC(year, mon, day); }
  return { year, days: Math.round((at - t0) / 86400000), month: mon + 1, day };
}

export function computeCelebrations(people, { today = new Date(), withinDays = 30, includeBirthdays = false } = {}) {
  const birthdays = []; const remembrances = [];
  for (const p of people) {
    if ((p.kind || 'person') !== 'person') continue;
    const cls = livingClass(p, today.getUTCFullYear());
    const name = [p.given_name, p.surname].filter(Boolean).join(' ');
    if (cls === 'deceased') {
      const o = nextOccurrence(p.death_date, today);
      if (o && o.days <= withinDays) remembrances.push({ id: p.id, name, month: o.month, day: o.day, days: o.days, years: p.death_year ? o.year - p.death_year : null });
    } else if (includeBirthdays) {
      const o = nextOccurrence(p.birth_date, today);
      if (o && o.days <= withinDays) birthdays.push({ id: p.id, name, month: o.month, day: o.day, days: o.days, turning: p.birth_year ? o.year - p.birth_year : null });
    }
  }
  const by = (a, b) => a.days - b.days || a.name.localeCompare(b.name);
  return { birthdays: includeBirthdays ? birthdays.sort(by) : null, remembrances: remembrances.sort(by) };
}

// Content of the weekly administrator digest.
export async function buildDigest(pool, now = new Date()) {
  const q = async (sql) => (await pool.query(sql)).rows[0];
  const pending = await q("select (select count(*)::int from proposals where status='pending') as suggestions, (select count(*)::int from comments where status='pending') as comments");
  const week = await q(`select (select count(*)::int from person_revisions where created_at > now()-interval '7 days' and action='edit') as edits,
                               (select count(*)::int from stories where created_at > now()-interval '7 days' and status='published') as stories,
                               (select count(*)::int from business_ideas where created_at > now()-interval '7 days' and status='active') as ideas,
                               (select count(*)::int from invites where used_at > now()-interval '7 days') as joined`);
  const sec = await q("select count(*)::int as failed from token_attempts where ip like 'tok:%' and ip <> 'tok:*' and attempted_at > now()-interval '7 days'");
  const rows = (await pool.query("select id,given_name,surname,sex,birth_year,death_year,to_char(birth_date,'YYYY-MM-DD') as birth_date,to_char(death_date,'YYYY-MM-DD') as death_date,living_status,kind from people where birth_date is not null or death_date is not null")).rows;
  const cel = computeCelebrations(rows, { today: now, withinDays: 7, includeBirthdays: true });
  const lines = [];
  if (pending.suggestions || pending.comments) lines.push(`Waiting for you: ${pending.suggestions} tree suggestion${pending.suggestions === 1 ? '' : 's'} and ${pending.comments} comment${pending.comments === 1 ? '' : 's'}.`);
  else lines.push('Nothing is waiting for your approval.');
  lines.push(`Last 7 days: ${week.edits} edit${week.edits === 1 ? '' : 's'}, ${week.stories} new stor${week.stories === 1 ? 'y' : 'ies'}, ${week.ideas} new business idea${week.ideas === 1 ? '' : 's'}, ${week.joined} new member${week.joined === 1 ? '' : 's'} joined by invitation.`);
  if (cel.birthdays.length) lines.push(`Birthdays this week: ${cel.birthdays.map((b) => `${b.name} (${b.days === 0 ? 'today' : `in ${b.days} day${b.days === 1 ? '' : 's'}`})`).join(', ')}.`);
  if (cel.remembrances.length) lines.push(`Remembering: ${cel.remembrances.map((b) => `${b.name} (${b.days === 0 ? 'today' : `in ${b.days} day${b.days === 1 ? '' : 's'}`})`).join(', ')}.`);
  if (sec.failed > 30) lines.push(`Security: ${sec.failed} failed token attempts in the last 7 days. Consider retiring any 5-digit tokens.`);
  const busy = pending.suggestions + pending.comments;
  return { subject: busy ? `Family Heritage weekly digest (${busy} waiting)` : 'Family Heritage weekly digest', lines, pending: busy };
}
