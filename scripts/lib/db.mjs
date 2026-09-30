// Writes the merged graph into the app's real schema (netlify/db/001_schema.sql):
//   people(id uuid, given_name, surname, aliases text[], ...)   relationships(from,to,type parent|spouse)
// Cleared: relationships, people, and proposals created by the earlier Excel import.
// NEVER touched: articles, comments, access_tokens, token_attempts, audit_log (one row is appended).
import crypto from 'node:crypto';
import { validateGraph } from './validate.mjs';

export class SeedError extends Error {}

// ---- deterministic UUIDv5: the same source key always becomes the same people.id ----
const NAMESPACE = Buffer.from('b1c8f1e05d0a4f439d0e2f6d2a3c7a11', 'hex');
export function uuidFor(key) {
  const h = crypto.createHash('sha1').update(NAMESPACE).update(String(key)).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const NEEDS = {
  people: ['id', 'given_name', 'surname', 'aliases', 'sex', 'birth_year', 'death_year', 'notes', 'source', 'source_ref', 'photo_url'],
  relationships: ['from_person_id', 'to_person_id', 'relationship_type', 'status', 'source', 'evidence'],
  proposals: ['token_label', 'status'],
  articles: ['id'], comments: ['article_id'],
  audit_log: ['action', 'entity_type', 'entity_id', 'details', 'actor'],
};

/** Read-only: confirms the live database matches the schema this seed writes to. */
export async function preflight(client) {
  const r = await client.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`);
  const have = new Map();
  for (const c of r.rows) have.set(`${c.table_name}.${c.column_name}`, c.data_type);
  const errors = [];
  for (const [t, cols] of Object.entries(NEEDS)) for (const c of cols) {
    if (!have.has(`${t}.${c}`)) errors.push(`${t}.${c} does not exist`);
  }
  if (have.get('people.id') && have.get('people.id') !== 'uuid') errors.push(`people.id is ${have.get('people.id')}, expected uuid`);
  if (have.get('people.aliases') && have.get('people.aliases') !== 'ARRAY') errors.push(`people.aliases is ${have.get('people.aliases')}, expected text[]`);
  if (errors.length) throw new SeedError('PREFLIGHT FAILED - nothing was changed:\n  - ' + errors.join('\n  - '));
}

const dbSource = (p) => (p.origin === 'excel' ? 'excel' : 'html'); // merged people stay "Family record"
const displayNotes = (p) =>
  [p.bio, ...p.seedNotes.filter((n) => !n.startsWith('Merged:'))].filter(Boolean).join(' ') || null;
const fullName = (r) => [r.given_name, r.surname].filter(Boolean).join(' ');


/** The exact rows written to `people` and `relationships` (also used to build public/demo.json). */
export function buildRows(graph) {
  const idOf = new Map(graph.people.map((p) => [p.id, uuidFor(p.id)]));
  const evidence = (sources) => (sources.includes('family-confirmed') ? 'Confirmed by the family.' : sources.includes('excel') ? 'Drawn in the Kankyea & Mansa Excel family tree.' : null);
  return {
    idOf,
    people: graph.people.map((p) => ({
      id: idOf.get(p.id), given_name: p.given || 'Unknown', surname: p.surname || null,
      aliases: p.aliases.map((a) => a.alias), sex: ['M', 'F'].includes(p.sex) ? p.sex : 'U',
      birth_year: p.birthYear, death_year: p.deathYear, notes: displayNotes(p), source: dbSource(p),
      source_ref: p.sourceIds.html && p.sourceIds.excel ? `${p.id};${p.sourceIds.excel}` : p.id, // graph key first
    })),
    relationships: [
      ...graph.parentChild.map((e) => ({ from_person_id: idOf.get(e.parentId), to_person_id: idOf.get(e.childId), relationship_type: 'parent', status: 'approved', source: e.sources.join('+'), evidence: evidence(e.sources) })),
      ...graph.partnerships.map((e) => ({ from_person_id: idOf.get(e.aId), to_person_id: idOf.get(e.bId), relationship_type: 'spouse', status: 'approved', source: e.sources.join('+'), evidence: evidence(e.sources) })),
    ],
  };
}

async function insertBatch(client, table, cols, rows, casts = {}) {
  const per = Math.max(1, Math.floor(30000 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const ph = chunk.map((_, r) => '(' + cols.map((c, k) => `$${r * cols.length + k + 1}${casts[c] ?? ''}`).join(',') + ')');
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph.join(',')}`, chunk.flatMap((row) => cols.map((c) => row[c])));
  }
}

async function readBack(client, graph) {
  const people = (await client.query('SELECT id, given_name, surname, aliases, birth_year, death_year, source_ref FROM people')).rows;
  const rels = (await client.query(`SELECT from_person_id, to_person_id, relationship_type FROM relationships WHERE status = 'approved'`)).rows;
  const keyOf = new Map(people.map((p) => [p.id, p.source_ref.split(';')[0]]));
  return {
    people: people.map((p) => ({
      id: keyOf.get(p.id), name: fullName(p), birthYear: p.birth_year, deathYear: p.death_year,
      aliases: (p.aliases ?? []).map((a) => ({ alias: a, kind: 'aka' })),
    })),
    parentChild: rels.filter((r) => r.relationship_type === 'parent').map((r) => ({ parentId: keyOf.get(r.from_person_id), childId: keyOf.get(r.to_person_id) })),
    partnerships: rels.filter((r) => r.relationship_type === 'spouse').map((r) => ({ aId: keyOf.get(r.from_person_id), bId: keyOf.get(r.to_person_id) })),
    unresolvedLinks: graph.unresolvedLinks, // no table for these: they are simply people without relationships
  };
}

export function compareGraphs(expected, actual) {
  const diff = [];
  const cmp = (e, a, label) => {
    const A = new Set(a), E = new Set(e);
    const miss = [...E].filter((x) => !A.has(x)), extra = [...A].filter((x) => !E.has(x));
    if (miss.length || extra.length) diff.push(`${label}: ${miss.length} missing, ${extra.length} unexpected${miss[0] ? ` (e.g. missing ${miss[0]})` : ''}`);
  };
  const pk = (p) => `${p.id}|${p.name}|${p.birthYear ?? ''}|${p.deathYear ?? ''}`;
  cmp(expected.people.map(pk), actual.people.map(pk), 'people');
  cmp(expected.people.flatMap((p) => p.aliases.map((a) => `${p.id}|${a.alias}`)), actual.people.flatMap((p) => p.aliases.map((a) => `${p.id}|${a.alias}`)), 'aliases');
  cmp(expected.parentChild.map((e) => `${e.parentId}>${e.childId}`), actual.parentChild.map((e) => `${e.parentId}>${e.childId}`), 'parent/child');
  const pair = (e) => [e.aId, e.bId].sort().join('&');
  cmp(expected.partnerships.map(pair), actual.partnerships.map(pair), 'spouses');
  return { name: 'Database contents equal the built graph exactly', pass: diff.length === 0, detail: diff.join('; ') };
}

const count = async (client, t) => (await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;

export async function runSeed({ client, graph, mergeMap, validator = validateGraph }) {
  await preflight(client);
  const warnings = [];
  const keep = { articles: await count(client, 'articles'), comments: await count(client, 'comments') };
  let began = false;
  try {
    await client.query('BEGIN'); began = true;

    // Photos added by admins live on the people rows we are about to rebuild: remember them.
    const photos = (await client.query(`SELECT given_name, surname, photo_url FROM people WHERE photo_url IS NOT NULL`)).rows;

    await client.query('DELETE FROM relationships');
    await client.query('DELETE FROM people');
    await client.query(`DELETE FROM proposals WHERE token_label = 'Excel import'`); // written by the old, incorrect seed

    const { idOf, people: peopleRows, relationships: relRows } = buildRows(graph);
    await insertBatch(client, 'people',
      ['id', 'given_name', 'surname', 'aliases', 'sex', 'birth_year', 'death_year', 'notes', 'source', 'source_ref'],
      peopleRows, { id: '::uuid', aliases: '::text[]' });
    await insertBatch(client, 'relationships',
      ['from_person_id', 'to_person_id', 'relationship_type', 'status', 'source', 'evidence'],
      relRows, { from_person_id: '::uuid', to_person_id: '::uuid' });

    // give restored photos back to the same-named person (only when the match is unambiguous)
    let restored = 0;
    for (const ph of photos) {
      const old = [ph.given_name, ph.surname].filter(Boolean).join(' ').toLowerCase();
      // same full name, or the old name is now an alias (e.g. "Nana Mansa" -> Ama Buah)
      const m = await client.query(
        `SELECT id, source FROM people WHERE lower(trim(given_name || ' ' || coalesce(surname, ''))) = $1
            OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = $1)`, [old]);
      // several people can share a name (e.g. two "Ama Buah" boxes): prefer the Family Echo / merged record
      const hits = m.rows.length > 1 ? m.rows.filter((r) => r.source !== 'excel') : m.rows;
      if (hits.length === 1) {
        await client.query('UPDATE people SET photo_url = $1 WHERE id = $2', [ph.photo_url, hits[0].id]);
        restored++;
      }
    }
    if (photos.length - restored > 0) warnings.push(`${photos.length - restored} photo(s) could not be re-attached automatically (person renamed or ambiguous).`);

    const dangling = await count(client, `proposals WHERE status = 'pending'`);
    if (dangling) warnings.push(`${dangling} pending proposal(s) from contributors refer to the previous person ids. Review them in Admin before approving.`);

    const actual = await readBack(client, graph);
    const checks = [...validator(actual, mergeMap, { fresh: graph }), compareGraphs(graph, actual)];
    const now = { articles: await count(client, 'articles'), comments: await count(client, 'comments') };
    checks.push({ name: 'Articles and comments untouched', pass: now.articles === keep.articles && now.comments === keep.comments, detail: `${now.articles} articles, ${now.comments} comments` });
    const failed = checks.filter((c) => !c.pass);
    if (failed.length) throw new SeedError('VALIDATION FAILED - rolled back:\n  - ' + failed.map((c) => `${c.name}${c.detail ? ' [' + c.detail + ']' : ''}`).join('\n  - '));

    await client.query(`INSERT INTO audit_log(action, entity_type, details, actor) VALUES ('seed_rebuild','people',$1::jsonb,'seed script')`, [JSON.stringify({
      people: graph.people.length, relationships: graph.parentChild.length + graph.partnerships.length,
      merges: mergeMap.merges.map((m) => ({ excel: m.excel, html: m.html, basis: m.basis })), notMerged: mergeMap.candidates })]);
    await client.query('COMMIT');
    return { checks, warnings, restoredPhotos: restored, kept: now };
  } catch (e) {
    if (began) await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
