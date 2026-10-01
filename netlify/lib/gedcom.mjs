// Minimal GEDCOM 5.5.1 writer so the family can be opened in other genealogy software.
const clip = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/@/g, '@@');
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function gedDate(year, date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (m) return `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}`;
  return year ? String(year) : '';
}

export function toGedcom(people, relationships, { now = new Date(), source = 'Our Family Heritage' } = {}) {
  const real = people.filter((p) => (p.kind || 'person') !== 'place');
  const ids = new Set(real.map((p) => p.id));
  const indi = new Map(real.map((p, i) => [p.id, `@I${i + 1}@`]));
  const by = new Map(real.map((p) => [p.id, p]));

  const parentsOf = new Map();
  for (const r of relationships) {
    if (r.relationship_type !== 'parent' || r.status === 'rejected' || !ids.has(r.from_person_id) || !ids.has(r.to_person_id)) continue;
    if (!parentsOf.has(r.to_person_id)) parentsOf.set(r.to_person_id, new Set());
    parentsOf.get(r.to_person_id).add(r.from_person_id);
  }

  // One family per distinct set of parents; partners without children get a family of their own.
  const fams = new Map();
  const fam = (set) => {
    const k = [...set].sort().join('+');
    if (!fams.has(k)) fams.set(k, { parents: [...set].sort(), children: [] });
    return fams.get(k);
  };
  for (const [child, ps] of parentsOf) fam(ps).children.push(child);
  for (const r of relationships) {
    if (r.relationship_type !== 'spouse' || !ids.has(r.from_person_id) || !ids.has(r.to_person_id)) continue;
    fam(new Set([r.from_person_id, r.to_person_id]));
  }

  const famId = new Map([...fams.keys()].map((k, i) => [k, `@F${i + 1}@`]));
  const famsOf = new Map(); const famcOf = new Map();
  for (const [k, f] of fams) {
    for (const parent of f.parents) { if (!famsOf.has(parent)) famsOf.set(parent, []); famsOf.get(parent).push(famId.get(k)); }
    for (const child of f.children) { if (!famcOf.has(child)) famcOf.set(child, []); famcOf.get(child).push(famId.get(k)); }
  }

  const out = ['0 HEAD', `1 SOUR ${clip(source)}`, '1 GEDC', '2 VERS 5.5.1', '2 FORM LINEAGE-LINKED', '1 CHAR UTF-8',
    `1 DATE ${now.getUTCDate()} ${MON[now.getUTCMonth()]} ${now.getUTCFullYear()}`];
  for (const p of real) {
    out.push(`0 ${indi.get(p.id)} INDI`);
    out.push(`1 NAME ${clip(p.given_name)} /${clip(p.surname || '')}/`);
    for (const a of p.aliases || []) out.push(`1 NAME ${clip(a)} //`, '2 TYPE aka');
    if (['M', 'F'].includes(p.sex)) out.push(`1 SEX ${p.sex}`);
    const b = gedDate(p.birth_year, p.birth_date);
    const d = gedDate(p.death_year, p.death_date);
    if (b || p.birth_place) { out.push('1 BIRT'); if (b) out.push(`2 DATE ${b}`); if (p.birth_place) out.push(`2 PLAC ${clip(p.birth_place)}`); }
    if (d || p.living_status === 'deceased') { out.push('1 DEAT Y'); if (d) out.push(`2 DATE ${d}`); }
    if (p.occupation) out.push(`1 OCCU ${clip(p.occupation)}`);
    if (p.notes) out.push(`1 NOTE ${clip(p.notes).slice(0, 240)}`);
    for (const f of famcOf.get(p.id) || []) out.push(`1 FAMC ${f}`);
    for (const f of famsOf.get(p.id) || []) out.push(`1 FAMS ${f}`);
  }
  for (const [k, f] of fams) {
    out.push(`0 ${famId.get(k)} FAM`);
    const ps = f.parents.map((id) => by.get(id));
    let h = ps.find((x) => x.sex === 'M');
    let w = ps.find((x) => x.sex === 'F');
    const rest = ps.filter((x) => x !== h && x !== w);
    if (!h && rest.length) h = rest.shift();
    if (!w && rest.length) w = rest.shift();
    if (h) out.push(`1 HUSB ${indi.get(h.id)}`);
    if (w) out.push(`1 WIFE ${indi.get(w.id)}`);
    for (const child of f.children) out.push(`1 CHIL ${indi.get(child)}`);
  }
  out.push('0 TRLR');
  return `${out.join('\n')}\n`;
}
