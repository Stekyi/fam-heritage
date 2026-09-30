#!/usr/bin/env node
// Regenerates public/demo.json (the offline fallback) from the same merged graph the seed writes.
//   node scripts/build-demo.mjs
import fs from 'node:fs';
import { loadGraph } from './build-graph.mjs';
import { buildRows } from './lib/db.mjs';

const { graph, checks } = await loadGraph();
if (!checks.every((c) => c.pass)) { console.error('Graph invalid; demo.json not written.'); process.exit(1); }
const { people, relationships } = buildRows(graph);
fs.writeFileSync(new URL('../public/demo.json', import.meta.url), JSON.stringify({
  people: people.map(({ source_ref, ...p }) => ({ ...p, photo_url: null })),
  relationships: relationships.map(({ evidence, ...r }) => r),
}));
console.log(`public/demo.json: ${people.length} people, ${relationships.length} relationships`);
