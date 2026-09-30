// Graph validation.  Runs on the in-memory graph AND on the rows read back from Neon
// (inside the seed transaction, before COMMIT).
import { norm } from './names.mjs';

export function indexGraph(g) {
  const byId = new Map(g.people.map((p) => [p.id, p]));
  const parentsOf = new Map(), childrenOf = new Map(), partnersOf = new Map();
  const push = (m, k, v) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const e of g.parentChild) { push(childrenOf, e.parentId, e.childId); push(parentsOf, e.childId, e.parentId); }
  for (const e of g.partnerships) { push(partnersOf, e.aId, e.bId); push(partnersOf, e.bId, e.aId); }
  return { byId, parentsOf, childrenOf, partnersOf };
}

/** Ranked search over canonical names and aliases (what the app's search box should behave like). */
export function searchPeople(g, query) {
  const q = norm(query);
  const hits = [];
  for (const p of g.people) {
    if (norm(p.name) === q) hits.push({ id: p.id, rank: 0, via: 'name' });
    else {
      const a = p.aliases.find((x) => norm(x.alias) === q);
      if (a) hits.push({ id: p.id, rank: a.kind === 'source-name' ? 1 : 2, via: `alias (${a.kind})` });
    }
  }
  return hits.sort((a, b) => a.rank - b.rank);
}

export function validateGraph(g, mergeMap, { fresh = null } = {}) {
  const ix = indexGraph(g);
  const A = mergeMap.anchors;
  const id = (h) => `${mergeMap.idPrefix.html}${h}`;
  const checks = [];
  const add = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
  const nameOf = (x) => ix.byId.get(x)?.name ?? `?${x}`;
  const uniqueByName = (name) => {
    const m = g.people.filter((p) => norm(p.name) === norm(name));
    return m.length === 1 ? m[0].id : null;
  };
  const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

  const kokoo = id(A.nyantahKokoo), tumtum = id(A.nyantahTumtum), mansa = id(A.mansa), abena = id(A.abena);
  const kwaku = g.people.find((p) => p.sourceNames?.some((s) => s.raw === 'Kwaku Buafo (Opayin Kankyea)'))?.id
             ?? uniqueByName('Kwaku Buafo');

  // A
  add('Nyantah (Kokoo) -> Mansa', ix.byId.has(kokoo) && ix.byId.has(mansa) && (ix.parentsOf.get(mansa) ?? []).includes(kokoo),
      `parents of ${nameOf(mansa)}: ${(ix.parentsOf.get(mansa) ?? []).map(nameOf).join(', ') || 'none'}`);
  add('Mansa is 1910-1977 "Ama Buah" with AKA Nana Mansa',
      ix.byId.get(mansa)?.name === 'Ama Buah' && ix.byId.get(mansa)?.birthYear === 1910 && ix.byId.get(mansa)?.deathYear === 1977 &&
      ix.byId.get(mansa)?.aliases.some((a) => norm(a.alias) === 'nana mansa'),
      JSON.stringify({ name: nameOf(mansa), b: ix.byId.get(mansa)?.birthYear, d: ix.byId.get(mansa)?.deathYear }));
  // B
  const fiveNames = ['Yaa Brefaa', 'Abena Gyampraa', 'Charles Buafo', 'Afua Ampomaa', 'John Kwaku Buafo'];
  const fiveIds = fiveNames.map(uniqueByName);
  const mansaKids = ix.childrenOf.get(mansa) ?? [];
  add('Mansa -> 5 children', fiveIds.every(Boolean) && sameSet(mansaKids, fiveIds),
      `children: ${mansaKids.map(nameOf).join(', ')}`);
  // C
  const abenaNames = ['Agnes Obiri-Yeboah', 'Hana Obiri-Yeboah', 'John Obiri-Yeboah', 'Matthew Obiri-Yeboah', 'Isaac Obiri-Yeboah'];
  const abenaIds = abenaNames.map(uniqueByName);
  const abenaKids = ix.childrenOf.get(abena) ?? [];
  add('Abena -> 5 children', abenaIds.every(Boolean) && sameSet(abenaKids, abenaIds),
      `children: ${abenaKids.map(nameOf).join(', ')}`);
  add('Abena is the same record as "Maa Abena" and a child of Mansa',
      searchPeople(g, 'Maa Abena')[0]?.id === abena && searchPeople(g, 'Abena Gyampraa')[0]?.id === abena && (ix.parentsOf.get(abena) ?? []).includes(mansa));
  // D / E
  add('Kwaku Buafo spouse of Mansa', kwaku && (ix.partnersOf.get(mansa) ?? []).includes(kwaku),
      `partners of ${nameOf(mansa)}: ${(ix.partnersOf.get(mansa) ?? []).map(nameOf).join(', ') || 'none'}`);
  const ancestors = (start) => { const seen = new Set(); const st = [start]; while (st.length) for (const p of ix.parentsOf.get(st.pop()) ?? []) if (!seen.has(p)) { seen.add(p); st.push(p); } return seen; };
  add('Kwaku Buafo NOT parent (or ancestor) of Mansa', kwaku && !ancestors(mansa).has(kwaku));
  // F
  const aliasNorms = (p) => new Set([norm(p.name), ...p.aliases.map((a) => norm(a.alias))]);
  const nk = ix.byId.get(kokoo), nt = ix.byId.get(tumtum);
  const overlap = nk && nt ? [...aliasNorms(nk)].filter((x) => aliasNorms(nt).has(x)) : ['missing'];
  add('Nyantah (Kokoo) and Nyantah (Tumtum) are separate', nk && nt && kokoo !== tumtum && overlap.length === 0 && !ancestors(kokoo).has(tumtum) && !ancestors(tumtum).has(kokoo),
      nk && nt ? `${nk.name} / ${nt.name}` : 'one of them is missing');
  // Siblings, not a chain
  const siblingsOnly = (ids) => ids.every((a) => ids.every((b) => a === b || !(ix.childrenOf.get(a) ?? []).includes(b)));
  add('Mansa\'s five children are siblings, not a chain', fiveIds.every(Boolean) && siblingsOnly(fiveIds));
  add('Abena\'s five children are siblings, not a chain', abenaIds.every(Boolean) && siblingsOnly(abenaIds));
  // G
  const ids = g.people.map((p) => p.id);
  const idSet = new Set(ids);
  const broken = [
    ...g.parentChild.filter((e) => !idSet.has(e.parentId) || !idSet.has(e.childId)).map((e) => `${e.parentId}>${e.childId}`),
    ...g.partnerships.filter((e) => !idSet.has(e.aId) || !idSet.has(e.bId)).map((e) => `${e.aId}&${e.bId}`),
    ...g.people.flatMap((p) => []),
  ];
  add('Broken relationships: 0', broken.length === 0 && new Set(ids).size === ids.length, broken.length ? broken.slice(0, 5).join(', ') : `${ids.length} unique ids`);
  add('No person is their own ancestor (no cycles)', g.people.every((p) => !ancestors(p.id).has(p.id)));
  // H
  const accepted = new Set((mergeMap.acceptedNameCollisions ?? []).map((c) => norm(c.name)));
  const excelCreated = g.people.filter((p) => p.id.startsWith('xl_'));
  const dup = [];
  for (const p of excelCreated) {
    const clash = g.people.filter((o) => o.id !== p.id && norm(o.name) === norm(p.name));
    if (clash.length && !accepted.has(norm(p.name))) dup.push(`${p.name} (${p.id}) = ${clash.map((c) => c.id).join(',')}`);
  }
  add('Duplicate people: 0', dup.length === 0, dup.join('; '));
  // I
  if (fresh) {
    const missing = [];
    for (const p of fresh.people) for (const a of p.aliases) {
      const q = ix.byId.get(p.id);
      if (!q || !q.aliases.some((x) => norm(x.alias) === norm(a.alias))) missing.push(`${p.name}: ${a.alias}`);
    }
    add('AKA / alias records exist for every bracketed name', missing.length === 0, missing.slice(0, 5).join('; '));
  }
  const s = (q) => searchPeople(g, q).map((h) => h.id);
  add('Search "Ama Buah", "Nana Mansa", "Mansa" all reach the same person', ['Ama Buah', 'Nana Mansa', 'Mansa'].every((q) => s(q).includes(mansa)) && s('Nana Mansa').length === 1,
      `Mansa also matches: ${searchPeople(g, 'Mansa').filter((h) => h.id !== mansa).map((h) => nameOf(h.id)).join(', ') || 'no one else'}`);
  const tiwa = uniqueByName('Agnes Obiri-Yeboah');
  add('Search "Agnes Obiri-Yeboah" and "Tiwa" reach the same person', tiwa && s('Tiwa')[0] === tiwa);
  // Family-confirmed corrections
  const kidNames = (id) => (ix.childrenOf.get(id) ?? []).map(nameOf).sort();
  const isaac = uniqueByName('Isaac Obiri-Yeboah'), matthewOY = uniqueByName('Matthew Obiri-Yeboah');
  const daughters = ['Harriette Obiri-Yeboah', 'Bernice Obiri-Yeboah', 'Wendy Obiri-Yeboah'];
  add('Harriette, Bernice and Wendy are daughters of Isaac (Kofi Gyima), not Matthew',
      isaac && matthewOY && daughters.every((d) => { const c = uniqueByName(d); return c && (ix.parentsOf.get(c) ?? []).length === 1 && ix.parentsOf.get(c)[0] === isaac; }),
      `Isaac's children: ${kidNames(isaac).join(', ') || 'none'}`);
  const hana = uniqueByName('Hana Obiri-Yeboah');
  const hanaExpected = ['Ama Buah', 'Atta Buafo', 'Kwabena Agyei Mensah', 'Kwaku Nterful', 'Silvia Mensah', 'Sister Boaa'];
  add('Hana -> 6 children (Kwabena Agyei Mensah = Kwabena Adjei, plus his 5 siblings)',
      hana && JSON.stringify(kidNames(hana)) === JSON.stringify(hanaExpected) && !(ix.childrenOf.get(hana) ?? []).includes(mansa) && searchPeople(g, 'Kwabena Adjei').length === 1 && searchPeople(g, 'Kwabena Adjei')[0].id === searchPeople(g, 'Kwabena Agyei Mensah')[0]?.id,
      `Hana's children: ${hana ? kidNames(hana).join(', ') : '?'}`);
  // L: the sheet's unlabelled boxes must have no relationships
  const unresolved = g.unresolvedLinks ?? [];
  const guessed = unresolved.filter((u) => (ix.parentsOf.get(u.personId) ?? []).length || (ix.childrenOf.get(u.personId) ?? []).length || (ix.partnersOf.get(u.personId) ?? []).length);
  add('No relationship was guessed for unlabelled "linked name" boxes', guessed.length === 0, `${unresolved.length} unresolved boxes`);
  return checks;
}
