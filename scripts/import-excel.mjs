#!/usr/bin/env node
// Standalone inspection tool:  node scripts/import-excel.mjs [path-to-xlsx]
import { readFile } from 'node:fs/promises';
import { importExcelTree } from './lib/excel.mjs';

export async function importExcel(xlsxPath, mergeMap) {
  return importExcelTree(xlsxPath, mergeMap.excel);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mergeMap = JSON.parse(await readFile(new URL('../data/merge-map.json', import.meta.url), 'utf8'));
  const path = process.argv[2] ?? 'data/source/Kankyea_and_Mansa_Family_Tree.xlsx';
  const { persons, linked, warnings } = await importExcel(path, mergeMap);
  for (const p of persons) {
    console.log(`G${p.tier}  ${p.sourceName}  ${p.birthYear}-${p.deathYear ?? ''}${p.parentSourceName ? '  <- child of ' + p.parentSourceName : ''}`);
    for (const l of linked.filter((x) => x.besidePerson === p.sourceName)) console.log(`      linked: ${l.sourceName}`);
  }
  console.log(`\n${persons.length} people + ${linked.length} linked names. Warnings: ${warnings.length}`);
  warnings.forEach((w) => console.log('  !', w));
}
