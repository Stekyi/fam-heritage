import { livingClass } from './_people.mjs';

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const fullName = (p) => [p.given_name, p.surname].filter(Boolean).join(' ');

function exactYears(fromYear, fromDate, toYear, toDate) {
  if (fromDate && toDate) {
    const a = new Date(`${fromDate}T00:00:00Z`);
    const b = new Date(`${toDate}T00:00:00Z`);
    let y = b.getUTCFullYear() - a.getUTCFullYear();
    const before = b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate());
    if (before) y -= 1;
    return y;
  }
  return toYear - fromYear;
}

function buckets(values, size, max) {
  const out = new Map();
  for (const v of values) {
    const b = Math.min(Math.floor(v / size) * size, max);
    out.set(b, (out.get(b) || 0) + 1);
  }
  const top = Math.max(0, ...out.keys());
  const rows = [];
  for (let b = 0; b <= top; b += size) rows.push({ label: b >= max ? `${max}+` : `${b}–${b + size - 1}`, from: b, count: out.get(b) || 0 });
  return rows;
}

function decades(years) {
  const m = new Map();
  for (const y of years) m.set(Math.floor(y / 10) * 10, (m.get(Math.floor(y / 10) * 10) || 0) + 1);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([d, count]) => ({ label: `${d}s`, from: d, count }));
}

function topValues(list, n) {
  const m = new Map();
  for (const raw of list) {
    const v = String(raw || '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    const e = m.get(k) || { label: v, count: 0, forms: new Map() };
    e.count += 1;
    e.forms.set(v, (e.forms.get(v) || 0) + 1);
    m.set(k, e);
  }
  return [...m.values()]
    .map((e) => ({ label: [...e.forms.entries()].sort((a, b) => b[1] - a[1])[0][0], count: e.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, n);
}

export function computeGenerations(people, relationships) {
  const ids = new Set(people.map((p) => p.id));
  const parents = new Map(); const children = new Map(); const spouses = new Map();
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  for (const r of relationships) {
    if (!ids.has(r.from_person_id) || !ids.has(r.to_person_id)) continue;
    if (r.relationship_type === 'parent') { add(children, r.from_person_id, r.to_person_id); add(parents, r.to_person_id, r.from_person_id); }
    else if (r.relationship_type === 'spouse') { add(spouses, r.from_person_id, r.to_person_id); add(spouses, r.to_person_id, r.from_person_id); }
  }
  const hasParents = (id) => (parents.get(id)?.size || 0) > 0;
  const gen = new Map();
  const assign = (id, g, next) => {
    gen.set(id, g); next.push(id);
    for (const s of spouses.get(id) || []) if (!gen.has(s) && !hasParents(s)) { gen.set(s, g); next.push(s); }
  };
  let frontier = [];
  for (const p of people) {
    if (hasParents(p.id) || !(children.get(p.id)?.size)) continue;
    if ([...(spouses.get(p.id) || [])].some(hasParents)) continue; // married into the family: placed through the spouse
    assign(p.id, 1, frontier);
  }
  let g = 1;
  while (frontier.length) {
    const next = [];
    g += 1;
    for (const id of frontier) for (const c of children.get(id) || []) if (!gen.has(c)) assign(c, g, next);
    frontier = next;
  }
  const counts = new Map();
  for (const v of gen.values()) counts.set(v, (counts.get(v) || 0) + 1);
  const rows = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([n, count]) => ({ label: `Generation ${n}`, from: n, count }));
  return { rows, unplaced: people.length - gen.size };
}

export function computeAnalysis(people, relationships, now = new Date()) {
  const nowYear = now.getUTCFullYear();
  const today = now.toISOString().slice(0, 10);
  const cls = { living: 0, presumed_living: 0, deceased: 0, unknown: 0 };
  const sex = { M: 0, F: 0, O: 0, U: 0 };
  const ages = [];
  const lifespans = [];
  let excluded = 0;
  for (const p of people) {
    const c = livingClass(p, nowYear);
    cls[c] += 1;
    sex[['M', 'F', 'O'].includes(p.sex) ? p.sex : 'U'] += 1;
    if ((c === 'living' || c === 'presumed_living') && p.birth_year) {
      const age = exactYears(p.birth_year, p.birth_date, nowYear, p.birth_date ? today : null);
      if (age < 0 || age > 125) excluded += 1; else ages.push({ age, name: fullName(p), id: p.id });
    }
    if (c === 'deceased' && p.birth_year && p.death_year) {
      const span = exactYears(p.birth_year, p.birth_date, p.death_year, p.birth_date && p.death_date ? p.death_date : null);
      if (span < 0 || span > 125) excluded += 1; else lifespans.push(span);
    }
  }
  const ageVals = ages.map((a) => a.age);
  const youngest = ages.length ? ages.reduce((a, b) => (b.age < a.age ? b : a)) : null;
  const oldest = ages.length ? ages.reduce((a, b) => (b.age > a.age ? b : a)) : null;
  const gens = computeGenerations(people, relationships);
  return {
    generated_at: now.toISOString(),
    totals: { total: people.length, living: cls.living, presumed_living: cls.presumed_living, deceased: cls.deceased, unknown: cls.unknown },
    gender: { male: sex.M, female: sex.F, other: sex.O, unknown: sex.U },
    current_age: {
      n: ageVals.length, average: round1(mean(ageVals)), median: median(ageVals),
      youngest: youngest && { age: youngest.age, name: youngest.name, id: youngest.id },
      oldest: oldest && { age: oldest.age, name: oldest.name, id: oldest.id },
      distribution: buckets(ageVals, 10, 90),
    },
    age_at_death: { n: lifespans.length, average: round1(mean(lifespans)), median: median(lifespans), distribution: buckets(lifespans, 10, 100) },
    births_by_decade: decades(people.map((p) => p.birth_year).filter(Boolean)),
    deaths_by_decade: decades(people.map((p) => p.death_year).filter(Boolean)),
    generations: gens.rows,
    generations_unplaced: gens.unplaced,
    occupations: topValues(people.map((p) => p.occupation), 12),
    birthplaces: topValues(people.map((p) => p.birth_place), 12),
    coverage: {
      with_birth_year: people.filter((p) => p.birth_year).length,
      with_occupation: people.filter((p) => p.occupation).length,
      with_birthplace: people.filter((p) => p.birth_place).length,
      excluded_implausible: excluded,
    },
  };
}
