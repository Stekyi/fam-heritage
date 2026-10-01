import { getDb, json, NO_DB, appOnly, clean, pageParams } from './_db.mjs';

const esc = (s) => s.replace(/[%_\\]/g, '\\$&');

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const blocked = appOnly(event); if (blocked) return blocked;
  const pool = await getDb(); if (!pool) return NO_DB();
  const q = event.queryStringParameters || {};
  const { limit, offset, page } = pageParams(q, 12, 30);
  const nowYear = new Date().getUTCFullYear();

  const where = ["coalesce(p.death_year,0)=0", "p.death_date is null", "coalesce(p.living_status,'')<>'deceased'"];
  const vals = [];
  const push = (v) => { vals.push(v); return `$${vals.length}`; };

  const occ = clean(q.occupation, 80);
  const loc = clean(q.location, 80);
  const name = clean(q.q, 80);
  if (occ) where.push(`p.occupation ilike ${push(`%${esc(occ)}%`)}`);
  else where.push("p.occupation is not null");
  if (loc) { const n = push(`%${esc(loc)}%`); where.push(`(coalesce(p.location,'') ilike ${n} or coalesce(p.birth_place,'') ilike ${n})`); }
  if (name) { const n = push(`%${esc(name)}%`); where.push(`(coalesce(p.given_name,'')||' '||coalesce(p.surname,'') ilike ${n} or exists(select 1 from unnest(p.aliases) a where a ilike ${n}))`); }
  if (['M', 'F', 'O', 'U'].includes(q.gender)) where.push(`p.sex=${push(q.gender)}`);
  const amin = parseInt(q.age_min, 10);
  const amax = parseInt(q.age_max, 10);
  if (Number.isFinite(amin)) where.push(`p.birth_year is not null and ${nowYear}-p.birth_year >= ${push(amin)}`);
  if (Number.isFinite(amax)) where.push(`p.birth_year is not null and ${nowYear}-p.birth_year <= ${push(amax)}`);
  const w = where.join(' and ');

  const [list, total, occs, locs] = await Promise.all([
    pool.query(
      `select p.id, p.given_name, p.surname, p.aliases, p.sex, p.occupation, p.location, p.birth_place, p.photo_url, p.birth_year,
              case when p.birth_year is null then null else ${nowYear}-p.birth_year end as age,
              left(pr.about, 180) as short_profile, (pr.about is not null) as has_profile
         from people p left join profiles pr on pr.person_id=p.id and pr.published=true
        where ${w} order by lower(p.given_name), lower(p.surname) limit ${limit} offset ${offset}`, vals),
    pool.query(`select count(*)::int as n from people p where ${w}`, vals),
    pool.query("select occupation as value, count(*)::int as n from people where occupation is not null group by 1 order by n desc, 1 limit 40"),
    pool.query("select location as value, count(*)::int as n from people where location is not null group by 1 order by n desc, 1 limit 40"),
  ]);
  return json(200, {
    results: list.rows, total: total.rows[0].n, page, limit,
    suggestions: { occupations: occs.rows.map((r) => r.value), locations: locs.rows.map((r) => r.value) },
  });
}
