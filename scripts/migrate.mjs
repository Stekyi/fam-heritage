#!/usr/bin/env node
// npm run migrate   applies the additive schema changes (safe to run any number of times).
// The Netlify Functions also apply them automatically the first time they run.
import pg from 'pg';
import { runMigrations } from '../netlify/lib/db.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const client = new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 2 });
try {
  await runMigrations(client);
  const v = await client.query('select version, applied_at from schema_migrations order by version');
  for (const r of v.rows) console.log(`applied: ${r.version} (${new Date(r.applied_at).toISOString()})`);
  console.log('MIGRATIONS UP TO DATE');
} catch (e) {
  console.error('MIGRATION FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
