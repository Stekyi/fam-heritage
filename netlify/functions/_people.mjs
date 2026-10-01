import { clean, cleanMultiline } from './_db.mjs';

export const SEX_MAP = { m: 'M', male: 'M', f: 'F', female: 'F', o: 'O', other: 'O', u: 'U', unknown: 'U', '': 'U' };
export const LIVING = ['living', 'deceased', 'unknown'];

export function parseFlexDate(value, label) {
  const s = String(value ?? '').trim();
  if (!s) return { year: null, date: null };
  const thisYear = new Date().getUTCFullYear();
  if (/^\d{4}$/.test(s)) {
    const y = Number(s);
    if (y < 1000 || y > thisYear) return { error: `Please provide a valid ${label}.` };
    return { year: y, date: null };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { error: `Please provide a valid ${label} (a year like 1950, or a date like 1950-03-21).` };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1000) return { error: `Please provide a valid ${label}.` };
  if (dt.getTime() > Date.now()) return { error: `The ${label} cannot be in the future.` };
  return { year: y, date: s };
}

export function cleanAliases(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[;\n]/);
  const out = [];
  const seen = new Set();
  for (const a of list) {
    const c = clean(a, 120);
    if (!c) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out.slice(0, 20);
}

// Validates a partial update. Returns { fields } (column -> value) or { error }.
export function validatePersonUpdate(input, current = {}) {
  const f = {};
  if ('given_name' in input) {
    const name = clean(input.given_name, 120);
    if (!name) return { error: 'Please enter a name before saving.' };
    f.given_name = name;
  }
  if ('surname' in input) f.surname = clean(input.surname, 120);
  if ('aliases' in input) f.aliases = cleanAliases(input.aliases);
  if ('sex' in input) {
    const s = SEX_MAP[String(input.sex ?? '').trim().toLowerCase()];
    if (!s) return { error: 'Please choose Female, Male, Other or Unknown for gender.' };
    f.sex = s;
  }
  for (const [key, max] of [['birth_place', 160], ['occupation', 160], ['location', 160]]) {
    if (key in input) f[key] = clean(input[key], max);
  }
  if ('notes' in input) f.notes = cleanMultiline(input.notes, 4000);
  if ('living_status' in input) {
    const v = input.living_status ? String(input.living_status).toLowerCase() : null;
    if (v && !LIVING.includes(v)) return { error: 'Please choose Living, Deceased or Unknown.' };
    f.living_status = v;
  }
  let birth = null;
  let death = null;
  if ('birth' in input) {
    birth = parseFlexDate(input.birth, 'date of birth');
    if (birth.error) return { error: birth.error };
    f.birth_year = birth.year;
    f.birth_date = birth.date;
  }
  if ('death' in input) {
    death = parseFlexDate(input.death, 'date of death');
    if (death.error) return { error: death.error };
    f.death_year = death.year;
    f.death_date = death.date;
  }
  const by = 'birth_year' in f ? f.birth_year : current.birth_year;
  const dy = 'death_year' in f ? f.death_year : current.death_year;
  if (by && dy && dy < by) return { error: 'The date of death cannot be before the date of birth.' };
  const bd = 'birth_date' in f ? f.birth_date : current.birth_date;
  const dd = 'death_date' in f ? f.death_date : current.death_date;
  if (bd && dd && dd < bd) return { error: 'The date of death cannot be before the date of birth.' };
  return { fields: f };
}

export const EDITABLE = ['given_name', 'surname', 'aliases', 'sex', 'birth_year', 'birth_date', 'death_year', 'death_date', 'birth_place', 'occupation', 'location', 'living_status', 'notes'];

export function livingClass(p, nowYear = new Date().getUTCFullYear()) {
  if (p.death_year || p.death_date || p.living_status === 'deceased') return 'deceased';
  if (p.living_status === 'living') return 'living';
  if (p.living_status === 'unknown') return 'unknown';
  if (p.birth_year && nowYear - p.birth_year <= 100) return 'presumed_living';
  return 'unknown';
}
