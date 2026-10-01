import { getDb, json, NO_DB, appOnly, normName, foldSql, readLimit, optionalToken, PERSON_SELECT } from '../lib/db.mjs';
import { redactPerson } from '../lib/people.mjs';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const blocked = appOnly(event); if (blocked) return blocked;
  const pool = await getDb(); if (!pool) return NO_DB();
  const limited = await readLimit(event, pool, 'search'); if (limited) return limited;
  const token = await optionalToken(event, pool);
  const raw = String(event.queryStringParameters?.q || '').slice(0, 80);
  const q = normName(raw);
  const limit = Math.min(30, Math.max(1, parseInt(event.queryStringParameters?.limit, 10) || 15));
  if (q.length < 1) return json(200, { results: [], query: raw });
  const flat = foldSql("coalesce(given_name,'')||coalesce(surname,'')");
  const aliasFlat = foldSql('a');
  const r = await pool.query(
    `select ${PERSON_SELECT},
       case when ${flat}=$1 or exists(select 1 from unnest(aliases) a where ${aliasFlat}=$1) then 0
            when ${flat} like $1||'%' or exists(select 1 from unnest(aliases) a where ${aliasFlat} like $1||'%') then 1
            else 2 end as rank
       from people
      where ${flat} like '%'||$1||'%'
         or exists(select 1 from unnest(aliases) a where ${aliasFlat} like '%'||$1||'%')
      order by rank, lower(given_name), lower(surname)
      limit $2`, [q, limit]);
  return json(200, { results: r.rows.map(({ rank, ...p }) => redactPerson(p, !!token)), query: raw });
}
