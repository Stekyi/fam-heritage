#!/usr/bin/env node
// Standalone inspection tool:  node scripts/import-family-echo.mjs [path-to-html]
import { readFile } from 'node:fs/promises';
import { parseFamilyEchoHtml } from './lib/gedcom.mjs';

export async function importFamilyEcho(htmlPath) {
  return parseFamilyEchoHtml(await readFile(htmlPath, 'utf8'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? 'data/source/My-Family-29-Sep-2026-185445461.html';
  const { people, families } = await importFamilyEcho(path);
  console.log(`Family Echo: ${people.length} people, ${families.length} family units`);
  for (const p of people.slice(0, 15)) console.log(' ', p.htmlId.padEnd(6), p.name);
  console.log('  ...');
}
