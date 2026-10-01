import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeAnalysis, computeGenerations } from '../netlify/functions/_analysis.mjs';
import { parseFlexDate, validatePersonUpdate, livingClass, cleanAliases } from '../netlify/functions/_people.mjs';

const NOW = new Date('2026-10-01T12:00:00Z');
const person = (id, extra = {}) => ({ id, given_name: id, surname: null, aliases: [], sex: 'U', birth_year: null, death_year: null, birth_date: null, death_date: null, living_status: null, occupation: null, birth_place: null, ...extra });

describe('dates', () => {
  test('accepts a year or a real full date only', () => {
    assert.deepEqual(parseFlexDate('1950', 'x'), { year: 1950, date: null });
    assert.deepEqual(parseFlexDate('1950-03-21', 'x'), { year: 1950, date: '1950-03-21' });
    assert.deepEqual(parseFlexDate('', 'x'), { year: null, date: null });
    for (const bad of ['1950-02-30', '21/03/1950', 'abc', '99', '2999', '2999-01-01', '0001']) assert.ok(parseFlexDate(bad, 'date of birth').error, bad);
  });
});

describe('person validation', () => {
  test('only the name is mandatory and gender is controlled', () => {
    assert.ok(validatePersonUpdate({ given_name: '  ' }).error);
    assert.deepEqual(validatePersonUpdate({ given_name: 'Ama' }).fields, { given_name: 'Ama' });
    assert.equal(validatePersonUpdate({ sex: 'female' }).fields.sex, 'F');
    assert.equal(validatePersonUpdate({ sex: 'Other' }).fields.sex, 'O');
    assert.ok(validatePersonUpdate({ sex: 'x' }).error);
    assert.ok(validatePersonUpdate({ living_status: 'zombie' }).error);
  });
  test('aliases are trimmed, de-duplicated and capped', () => {
    assert.deepEqual(cleanAliases([' Mansa ', 'mansa', '', 'Nana  Mansa']), ['Mansa', 'Nana Mansa']);
    assert.equal(cleanAliases(Array.from({ length: 50 }, (_, i) => `a${i}`)).length, 20);
  });
  test('death cannot precede birth', () => {
    assert.ok(validatePersonUpdate({ death: '1940' }, { birth_year: 1950 }).error);
    assert.ok(validatePersonUpdate({ birth: '1990-05-05', death: '1990-05-04' }).error);
    assert.ok(!validatePersonUpdate({ birth: '1950', death: '1950' }).error);
  });
  test('editing never produces relationship columns', () => {
    const { fields } = validatePersonUpdate({ given_name: 'A', from_person_id: 'x', relationship_type: 'parent', id: 'z' });
    assert.deepEqual(Object.keys(fields), ['given_name']);
  });
});

describe('living classification', () => {
  test('deceased, living, presumed living and unknown', () => {
    assert.equal(livingClass({ death_year: 1990 }, 2026), 'deceased');
    assert.equal(livingClass({ living_status: 'deceased' }, 2026), 'deceased');
    assert.equal(livingClass({ living_status: 'living' }, 2026), 'living');
    assert.equal(livingClass({ birth_year: 1990 }, 2026), 'presumed_living');
    assert.equal(livingClass({ birth_year: 1850 }, 2026), 'unknown');
    assert.equal(livingClass({}, 2026), 'unknown');
  });
});

describe('analysis maths', () => {
  const people = [
    person('a', { sex: 'M', birth_year: 1900, death_year: 1970 }),
    person('b', { sex: 'F', birth_year: 1905, death_year: 1990 }),
    person('c', { sex: 'F', birth_year: 1950, living_status: 'living', occupation: 'Teacher', birth_place: 'Kumasi' }),
    person('d', { sex: 'M', birth_year: 1980, birth_date: '1980-12-31', living_status: 'living', occupation: 'teacher', birth_place: 'kumasi' }),
    person('e', { sex: 'O', birth_year: 2015 }),
    person('f'),
    person('g', { birth_year: 1800, death_year: 2000 }),
  ];
  const rels = [
    { from_person_id: 'a', to_person_id: 'c', relationship_type: 'parent' }, { from_person_id: 'b', to_person_id: 'c', relationship_type: 'parent' },
    { from_person_id: 'a', to_person_id: 'b', relationship_type: 'spouse' },
    { from_person_id: 'c', to_person_id: 'd', relationship_type: 'parent' }, { from_person_id: 'd', to_person_id: 'e', relationship_type: 'parent' },
  ];
  const a = computeAnalysis(people, rels, NOW);
  test('totals and gender add up', () => {
    assert.equal(a.totals.total, 7);
    assert.equal(a.totals.deceased, 3);
    assert.equal(a.totals.living, 2);
    assert.equal(a.totals.presumed_living, 1);
    assert.equal(a.totals.unknown, 1);
    assert.deepEqual(a.gender, { male: 2, female: 2, other: 1, unknown: 2 });
  });
  test('current age uses exact dates when known and excludes the deceased', () => {
    assert.equal(a.current_age.n, 3);
    assert.equal(a.current_age.oldest.age, 76);
    assert.equal(a.current_age.youngest.age, 11);
    assert.equal(a.current_age.median, 45);
    assert.equal(a.current_age.average, 44);
  });
  test('age at death is separate and ignores implausible lifespans', () => {
    assert.equal(a.age_at_death.n, 2);
    assert.equal(a.age_at_death.average, 77.5);
    assert.equal(a.age_at_death.median, 77.5);
    assert.equal(a.coverage.excluded_implausible, 1);
  });
  test('decades, occupations and birthplaces group case-insensitively', () => {
    assert.deepEqual(a.births_by_decade.map((d) => [d.label, d.count]), [['1800s', 1], ['1900s', 2], ['1950s', 1], ['1980s', 1], ['2010s', 1]]);
    assert.deepEqual(a.deaths_by_decade.map((d) => [d.label, d.count]), [['1970s', 1], ['1990s', 1], ['2000s', 1]]);
    assert.deepEqual(a.occupations, [{ label: 'Teacher', count: 2 }]);
    assert.deepEqual(a.birthplaces, [{ label: 'Kumasi', count: 2 }]);
  });
  test('generations place spouses with their partner and report unplaced people', () => {
    const g = computeGenerations(people, rels);
    assert.deepEqual(g.rows.map((r) => [r.label, r.count]), [['Generation 1', 2], ['Generation 2', 1], ['Generation 3', 1], ['Generation 4', 1]]);
    assert.equal(g.unplaced, 2);
  });
  test('empty data does not invent statistics', () => {
    const e = computeAnalysis([], [], NOW);
    assert.equal(e.current_age.n, 0); assert.equal(e.current_age.average, null);
    assert.deepEqual(e.occupations, []); assert.deepEqual(e.generations, []);
  });
});
