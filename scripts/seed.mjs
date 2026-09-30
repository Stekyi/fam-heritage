#!/usr/bin/env node
// npm run seed        clean rebuild of people + relationships in Neon (DATABASE_URL). Articles are not touched.
// npm run seed:dry    build + validate the graph only; touches no database
import fs from 'node:fs';
import pg from 'pg';
import { loadGraph, printReport } from './build-graph.mjs';
import { runSeed, SeedError } from './lib/db.mjs';

const dry = process.argv.includes('--dry-run');
const built = await loadGraph();
if (!built.checks.every((c) => c.pass)) {
  printReport(built, 'FAMILY HERITAGE SEED - GRAPH INVALID');
  console.error('\nThe merged graph failed validation before touching the database. Nothing was changed.');
  process.exit(1);
}
if (dry) process.exit(printReport(built, 'FAMILY HERITAGE SEED (dry run - no database touched)') ? 0 : 1);

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
try {
  await client.connect();
  // idempotent (create ... if not exists): makes a brand-new database usable, no-op otherwise
  await client.query(fs.readFileSync(new URL('../netlify/db/001_schema.sql', import.meta.url), 'utf8'));
  console.log(`Connected to ${new URL(url).host}. Rebuilding people and relationships (articles untouched)...`);
  const { checks, warnings, kept } = await runSeed({ client, graph: built.graph, mergeMap: built.mergeMap });
  printReport({ ...built, checks }, 'FAMILY HERITAGE SEED');
  for (const w of warnings) console.log('NOTE:', w);
  console.log(`\nArticles kept: ${kept.articles}   Comments kept: ${kept.comments}\nDATABASE SEED SUCCESSFUL`);
} catch (e) {
  console.error('\n' + (e instanceof SeedError ? e.message : `SEED FAILED (rolled back): ${e.stack ?? e}`));
  console.error('\nDATABASE SEED FAILED - the database was left as it was.');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
