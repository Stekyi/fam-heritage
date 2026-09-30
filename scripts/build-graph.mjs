#!/usr/bin/env node
// Builds and validates the merged graph WITHOUT touching a database.
//   npm run graph   -> writes data/family-graph.json (review it) and prints the report
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseFamilyEchoHtml } from './lib/gedcom.mjs';
import { importExcelTree } from './lib/excel.mjs';
import { buildGraph } from './lib/merge.mjs';
import { validateGraph } from './lib/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCES = {
  html: path.join(root, 'data/source/My-Family-29-Sep-2026-185445461.html'),
  xlsx: path.join(root, 'data/source/Kankyea_and_Mansa_Family_Tree.xlsx'),
  mergeMap: path.join(root, 'data/merge-map.json'),
  graph: path.join(root, 'data/family-graph.json'),
};

export async function loadGraph() {
  const mergeMap = JSON.parse(await readFile(SOURCES.mergeMap, 'utf8'));
  const family = parseFamilyEchoHtml(await readFile(SOURCES.html, 'utf8'));
  const excel = await importExcelTree(SOURCES.xlsx, mergeMap.excel);
  const graph = buildGraph({ family, excel, mergeMap });
  const checks = validateGraph(graph, mergeMap, { fresh: graph });
  return { mergeMap, family, excel, graph, checks };
}

export function printReport({ graph, checks, mergeMap, excel }, title = 'FAMILY HERITAGE SEED') {
  const aliasCount = graph.people.reduce((n, p) => n + p.aliases.length, 0);
  const pad = (s, n = 28) => (s + ':').padEnd(n);
  console.log(`\n${title}\n${'='.repeat(title.length)}\n`);
  console.log(pad('HTML people loaded') + graph.stats.htmlPeople);
  console.log(pad('Excel people loaded') + graph.stats.excelPeople);
  console.log(pad('People merged') + graph.stats.merged);
  console.log(pad('New Excel people') + graph.stats.newExcelPeople);
  console.log(pad('Aliases created') + aliasCount + '\n');
  console.log(pad('Parent/child relationships') + graph.parentChild.length);
  console.log(pad('Spouse relationships') + graph.partnerships.length);
  console.log(pad('Unresolved linked names') + graph.unresolvedLinks.length + '  (kept as people, no relationship)\n');
  console.log('VALIDATION\n' + '-'.repeat(20));
  for (const c of checks) console.log(`${c.name}: ${c.pass ? 'PASS' : 'FAIL'}${c.detail && (!c.pass || /Mansa also|linked|unique/.test(c.detail)) ? '   [' + c.detail + ']' : ''}`);
  for (const w of excel?.warnings ?? []) console.log('WARNING:', w);
  return checks.every((c) => c.pass);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await loadGraph();
  const ok = printReport(r, 'FAMILY HERITAGE GRAPH (no database)');
  await writeFile(SOURCES.graph, JSON.stringify({ people: r.graph.people, parentChild: r.graph.parentChild, partnerships: r.graph.partnerships, unresolvedLinks: r.graph.unresolvedLinks }, null, 1));
  console.log(`\nWrote ${path.relative(root, SOURCES.graph)}`);
  if (r.mergeMap.candidates.length) console.log('\nNOT MERGED - needs your decision:');
  for (const c of r.mergeMap.candidates) console.log(`  Excel "${c.excel}"  ~  Family Echo ${c.html}: ${c.reason}`);
  process.exit(ok ? 0 : 1);
}
