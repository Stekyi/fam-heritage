// Deterministic merge of the Family Echo tree (base) and the Excel branch.
//
// Rules, in order of importance:
//   1. The Family Echo tree is kept as it is; Excel adds to it and never replaces it.
//   2. An Excel person is merged into an existing person ONLY when data/merge-map.json says so.
//      Nothing is merged on name similarity alone.
//   3. Relationships are created only where a source establishes them.  The Excel's small
//      "linked name" boxes have no stated relationship, so they get none.
//   4. Every source spelling and every bracketed AKA is kept.
import { norm, splitName, yearOf } from './names.mjs';

const collapse2 = (t) => (t ?? '').replace(/\s+/g, ' ').trim();

export function buildGraph({ family, excel, mergeMap }) {
  const idFor = (htmlId) => `${mergeMap.idPrefix.html}${htmlId}`;
  const problems = [];

  // ---- 0. the Excel import must still look the way it was verified ----
  const exp = mergeMap.excelExpectations;
  const tierCount = (t) => excel.persons.filter((p) => p.tier === t).length;
  const got = { tier1: tierCount(1), tier2: tierCount(2), tier3: tierCount(3), linked: excel.linked.length };
  for (const k of Object.keys(exp.counts)) {
    if (got[k] !== exp.counts[k]) problems.push(`Excel import: expected ${exp.counts[k]} ${k}, found ${got[k]}.`);
  }
  for (const [parent, kids] of Object.entries(exp.childrenOf)) {
    const found = excel.persons.filter((p) => p.parentSourceName === parent).map((p) => p.sourceName);
    if (JSON.stringify(found.slice().sort()) !== JSON.stringify(kids.slice().sort())) {
      problems.push(`Excel import: children of "${parent}" are [${found.join('; ')}], expected [${kids.join('; ')}].`);
    }
  }
  for (const [person, names] of Object.entries(exp.linkedBeside)) {
    const found = excel.linked.filter((l) => l.besidePerson === person).map((l) => l.sourceName);
    if (JSON.stringify(found.slice().sort()) !== JSON.stringify(names.slice().sort())) {
      problems.push(`Excel import: boxes beside "${person}" are [${found.join('; ')}], expected [${names.join('; ')}].`);
    }
  }
  if (problems.length) throw new Error('Excel structure check failed:\n  ' + problems.join('\n  '));

  // ---- 1. base: Family Echo people ----
  const people = new Map();
  const htmlNode = new Map();
  for (const p of family.people) {
    // Use Family Echo's own given/surname split when it reproduces the full name; otherwise split on the last word.
    const own = collapse2([p.given, p.surname].filter(Boolean).join(' '));
    const parts = own === p.name ? { given: p.given ?? p.name, surname: p.surname ?? null } : splitName(p.name);
    const node = {
      id: idFor(p.htmlId), name: p.name, given: parts.given, surname: parts.surname, sex: p.sex ?? null,
      birthYear: yearOf(p.birthDate), deathYear: yearOf(p.deathDate), birthDate: p.birthDate, deathDate: p.deathDate,
      occupation: p.occupation, bio: p.bio,
      origin: 'html', sourceIds: { html: p.htmlId },
      sourceNames: [{ source: 'html', name: p.name, raw: p.rawName }],
      aliases: [], seedNotes: [],
    };
    people.set(node.id, node);
    htmlNode.set(p.htmlId, node);
  }

  const addAlias = (node, alias, kind) => {
    const a = alias?.trim();
    if (!a) return;
    if (norm(a) === norm(node.name)) return;
    if (node.aliases.some((x) => norm(x.alias) === norm(a))) return;
    node.aliases.push({ alias: a, kind });
  };

  // ---- 2. Excel people: merge where the map says so, otherwise create ----
  const excelAll = [...excel.persons, ...excel.linked];
  const bySource = new Map(excelAll.map((x) => [x.sourceName, x]));
  if (bySource.size !== excelAll.length) {
    // the same box text twice (e.g. two boxes reading "Ama Buah") is legitimate; only merges need uniqueness
  }
  const merged = new Map(); // excel key -> node
  const usedHtml = new Set();
  for (const m of mergeMap.merges) {
    const matches = excelAll.filter((x) => x.sourceName === m.excel);
    if (matches.length !== 1) throw new Error(`merge-map: "${m.excel}" matches ${matches.length} Excel boxes (need exactly 1).`);
    const node = htmlNode.get(m.html);
    if (!node) throw new Error(`merge-map: Family Echo person ${m.html} does not exist.`);
    if (usedHtml.has(m.html)) throw new Error(`merge-map: ${m.html} is mapped twice.`);
    usedHtml.add(m.html);
    const x = matches[0];
    const htmlName = node.name;
    node.name = m.canonicalName ?? htmlName;
    if (m.canonicalName) Object.assign(node, splitName(node.name));
    node.origin = 'merged';
    node.sourceIds.excel = x.key;
    node.sourceNames.push({ source: 'excel', name: x.name, raw: x.sourceName });
    if (x.birthYear != null) node.birthYear = x.birthYear;
    if (x.deathYear != null) node.deathYear = x.deathYear;
    addAlias(node, x.aka, 'aka');
    addAlias(node, htmlName, 'source-name');
    addAlias(node, x.name, 'source-name');
    node.seedNotes.push(`Also recorded in the Excel family tree as “${x.sourceName}”.`);
    node.seedNotes.push(`Merged: Family Echo "${htmlName}" (${m.html}) = Excel "${x.sourceName}". ${m.basis}`);
    merged.set(x.key, node);
  }

  const flagFor = new Map(mergeMap.spellingFlags.map((f) => [f.excel, f.note]));
  const nodeForExcel = (x) => {
    if (merged.has(x.key)) return merged.get(x.key);
    const node = {
      id: x.key, name: x.name, ...splitName(x.name), sex: null,
      birthYear: x.birthYear ?? null, deathYear: x.deathYear ?? null, birthDate: null, deathDate: null,
      occupation: null, bio: null,
      origin: 'excel', sourceIds: { excel: x.key },
      sourceNames: [{ source: 'excel', name: x.name, raw: x.sourceName }],
      aliases: [], seedNotes: [],
    };
    addAlias(node, x.aka, 'aka');
    const flag = flagFor.get(x.sourceName) ?? flagFor.get(x.name);
    if (flag) node.seedNotes.push(flag);
    people.set(node.id, node);
    return node;
  };
  for (const x of excel.persons) nodeForExcel(x);
  for (const x of excel.linked) nodeForExcel(x);

  // ---- 3. relationships ----
  const edgeKey = (a, b) => `${a}>${b}`;
  const pc = new Map();
  const addParent = (parentId, childId, role, source) => {
    const k = edgeKey(parentId, childId);
    const e = pc.get(k);
    if (e) { if (!e.sources.includes(source)) e.sources.push(source); if (e.role === 'parent' && role !== 'parent') e.role = role; }
    else pc.set(k, { parentId, childId, role, sources: [source] });
  };
  const pairs = new Map();
  const addPartners = (a, b, source) => {
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = edgeKey(x, y);
    const e = pairs.get(k);
    if (e) { if (!e.sources.includes(source)) e.sources.push(source); }
    else pairs.set(k, { aId: x, bId: y, sources: [source] });
  };

  for (const f of family.families) {
    for (const c of f.children) {
      if (f.wife) addParent(idFor(f.wife), idFor(c), 'mother', 'html');
      if (f.husband) addParent(idFor(f.husband), idFor(c), 'father', 'html');
    }
    if (f.husband && f.wife) addPartners(idFor(f.husband), idFor(f.wife), 'html');
  }

  const byExcelKey = new Map(excelAll.map((x) => [x.key, x]));
  const tier1 = excel.persons.filter((p) => p.tier === 1);
  const nodeOf = (x) => merged.get(x.key) ?? people.get(x.key);
  if (tier1.length === 2) addPartners(nodeOf(tier1[0]).id, nodeOf(tier1[1]).id, 'excel'); // the founding couple
  for (const p of excel.persons.filter((x) => x.tier === 2)) {
    for (const parent of tier1) addParent(nodeOf(parent).id, nodeOf(p).id, 'parent', 'excel'); // both stems join the same bus
  }
  for (const p of excel.persons.filter((x) => x.tier === 3)) {
    addParent(nodeOf(byExcelKey.get(p.parentKey)).id, nodeOf(p).id, 'parent', 'excel');
  }

  // ---- 3b. relationships the family has confirmed (the sheet cannot say, or draws them in the wrong place) ----
  const confirmed = new Set();
  for (const c of mergeMap.confirmedRelationships ?? []) {
    const parentBox = excelAll.filter((x) => x.sourceName === c.parent);
    if (parentBox.length !== 1) throw new Error(`merge-map: confirmed parent "${c.parent}" matches ${parentBox.length} Excel boxes.`);
    for (const childName of c.children) {
      const box = excelAll.filter((x) => x.sourceName === childName);
      if (box.length !== 1) throw new Error(`merge-map: confirmed child "${childName}" matches ${box.length} Excel boxes.`);
      addParent(nodeOf(parentBox[0]).id, nodeOf(box[0]).id, 'parent', 'family-confirmed');
      confirmed.add(box[0].key);
    }
  }

  // ---- 4. "linked names": recorded, deliberately unresolved ----
  const unresolvedLinks = [];
  for (const l of excel.linked) {
    const node = nodeOf(l);
    if (node.origin === 'merged') continue; // relationship already established by Family Echo
    if (confirmed.has(l.key)) continue;     // relationship confirmed by the family (section 3b)
    const beside = nodeOf(byExcelKey.get(l.besideKey));
    node.seedNotes.push(`Listed beside ${beside.name} in the Excel tree. The source does not say whether this is a spouse or a child, so no relationship was created.`);
    unresolvedLinks.push({ personId: node.id, besideId: beside.id });
  }

  const stats = {
    htmlPeople: family.people.length,
    excelPeople: excel.persons.length + excel.linked.length,
    merged: merged.size,
    newExcelPeople: excelAll.length - merged.size,
  };
  return {
    people: [...people.values()],
    parentChild: [...pc.values()],
    partnerships: [...pairs.values()],
    unresolvedLinks,
    stats,
  };
}
