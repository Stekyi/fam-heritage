import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { setPool, runMigrations } from '../netlify/functions/_db.mjs';

// Exercises the production path (pool.connect() -> BEGIN / advisory xact lock / DDL / COMMIT) against PGlite.
test('migrations run transactionally through a pooled client', async () => {
  const pg = new PGlite();
  const base = fs.readFileSync(new URL('../netlify/db/001_schema.sql', import.meta.url), 'utf8').replace(/create extension[^;]*;/i, '');
  await pg.exec(base);
  const log = [];
  const client = {
    query: async (sql, params) => {
      log.push(String(sql).trim().split(/\s+/).slice(0, 2).join(' '));
      return params ? pg.query(sql, params) : (/;\s*\S/.test(sql.trim()) ? (await pg.exec(sql), { rows: [] }) : pg.query(sql));
    },
    release: () => log.push('release'),
  };
  const pool = { query: client.query, connect: async () => client };
  setPool(pool, { pooled: true });
  await runMigrations(pool);
  await runMigrations(pool);
  assert.ok(log.includes('BEGIN') && log.includes('COMMIT') && log.includes('release'));
  assert.ok(log.some((l) => l.startsWith('select pg_advisory_xact_lock')));
  const v = await pg.query('select version from schema_migrations');
  assert.deepEqual(v.rows, [{ version: '002_heritage_platform' }]);
  const t = await pg.query("select count(*)::int n from information_schema.tables where table_name in ('profiles','stories','business_ideas','business_interests','token_person_links','images')");
  assert.equal(t.rows[0].n, 6);
});

test('a failing migration rolls back and leaves no half-applied schema', async () => {
  const pg = new PGlite();
  const base = fs.readFileSync(new URL('../netlify/db/001_schema.sql', import.meta.url), 'utf8').replace(/create extension[^;]*;/i, '');
  await pg.exec(base);
  await pg.exec('create table images (id int);'); // makes the later images index fail
  const client = {
    query: async (sql, params) => (params ? pg.query(sql, params) : (/;\s*\S/.test(sql.trim()) ? (await pg.exec(sql), { rows: [] }) : pg.query(sql))),
    release: () => {},
  };
  setPool({ query: client.query, connect: async () => client }, { pooled: true });
  await assert.rejects(runMigrations({ query: client.query, connect: async () => client }));
  const v = await pg.query("select count(*)::int n from schema_migrations where version='002_heritage_platform'");
  assert.equal(v.rows[0].n, 0);
  const cols = await pg.query("select count(*)::int n from information_schema.columns where table_name='people' and column_name='birth_place'");
  assert.equal(cols.rows[0].n, 0);
});
