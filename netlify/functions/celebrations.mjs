import { getDb, json, NO_DB, appOnly, readOnlyMethods, readLimit, optionalToken } from '../lib/db.mjs';
import { computeCelebrations } from '../lib/celebrations.mjs';

// Remembrance days are public (deceased only). Birthdays of living people are only shown to contributors.
export async function handler(event) {
  const bad = readOnlyMethods(event); if (bad) return bad;
  const blocked = appOnly(event); if (blocked) return blocked;
  const pool = await getDb(); if (!pool) return NO_DB();
  const limited = await readLimit(event, pool, 'celebrations'); if (limited) return limited;
  const token = await optionalToken(event, pool);
  const days = Math.min(90, Math.max(1, parseInt(event.queryStringParameters?.days, 10) || 30));
  const rows = (await pool.query(
    `select id,given_name,surname,sex,birth_year,death_year,to_char(birth_date,'YYYY-MM-DD') as birth_date,to_char(death_date,'YYYY-MM-DD') as death_date,living_status,kind
       from people where birth_date is not null or death_date is not null`)).rows;
  const out = computeCelebrations(rows, { today: new Date(), withinDays: days, includeBirthdays: !!token });
  return json(200, { ...out, days, viewer: token ? 'contributor' : 'public' });
}
