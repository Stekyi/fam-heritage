import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, makeToken, call, relationshipSnapshot } from './helpers.mjs';
import { handler as tree } from '../netlify/functions/tree.mjs';
import { handler as search } from '../netlify/functions/search.mjs';
import { handler as person } from '../netlify/functions/person.mjs';
import { handler as me } from '../netlify/functions/me.mjs';
import { handler as stories } from '../netlify/functions/stories.mjs';
import { handler as network } from '../netlify/functions/network.mjs';
import { handler as analysis } from '../netlify/functions/analysis.mjs';
import { handler as admin } from '../netlify/functions/admin.mjs';
import { handler as tokens } from '../netlify/functions/tokens.mjs';
import { handler as image } from '../netlify/functions/image.mjs';
import { handler as proposals } from '../netlify/functions/proposals.mjs';
import { handler as history } from '../netlify/functions/history.mjs';
import { hmacToken, validTokenShape, normToken, newStrongToken } from '../netlify/lib/db.mjs';

let pg; let baseline; let ama; let isaac; let kofi;
const A = '11111'; const B = '22222'; const C = '33333';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  pg = await freshDatabase();
  for (const [t, l] of [[A, 'A'], [B, 'B'], [C, 'C']]) await makeToken(pg, t, l);
  baseline = await relationshipSnapshot(pg);
  ama = (await pg.query("select id from people where 'Nana Mansa'=any(aliases)")).rows[0].id;
  isaac = (await pg.query("select id from people where 'Kofi Gyima'=any(aliases)")).rows[0].id;
  kofi = (await pg.query("select id from people where given_name||' '||coalesce(surname,'')='Matthew Obiri-Yeboah'")).rows[0].id;
  assert.equal((await call(me, { method: 'POST', token: A, body: { person_id: isaac } })).status, 201);
  assert.equal((await call(me, { method: 'POST', token: B, body: { person_id: ama } })).status, 201);
});

describe('privacy of living relatives', () => {
  test('public views hide exact birth date and location; contributors see them', async () => {
    const set = await call(person, { method: 'PATCH', query: { id: isaac }, token: A, body: { birth: '1985-06-15', location: 'Accra, Ghana', living_status: 'living' } });
    assert.equal(set.status, 200);
    const pubTree = (await call(tree)).data.people.find((p) => p.id === isaac);
    assert.equal(pubTree.birth_date, null); assert.equal(pubTree.location, null); assert.equal(pubTree.birth_year, 1985);
    const conTree = (await call(tree, { token: A })).data;
    assert.equal(conTree.people.find((p) => p.id === isaac).birth_date, '1985-06-15');
    assert.equal(conTree.viewer, 'contributor');
    const pubPerson = (await call(person, { query: { id: isaac } })).data.person;
    assert.equal(pubPerson.birth_date, null); assert.equal(pubPerson.location, null);
    assert.equal((await call(person, { query: { id: isaac }, token: A })).data.person.location, 'Accra, Ghana');
    const pubSearch = (await call(search, { query: { q: 'kofi gyima' } })).data.results[0];
    assert.equal(pubSearch.location, null); assert.equal(pubSearch.birth_date, null);
    assert.equal((await call(search, { query: { q: 'kofi gyima' }, token: A })).data.results[0].birth_date, '1985-06-15');
  });
  test('deceased people keep their recorded details public', async () => {
    await call(person, { method: 'PATCH', query: { id: kofi }, token: A, body: { birth: '1930-02-02', death: '1999', birth_place: 'Asankran' } });
    const p = (await call(tree)).data.people.find((x) => x.id === kofi);
    assert.equal(p.birth_date, '1930-02-02');
  });
  test('an invalid token header still returns the public view', async () => {
    const r = await call(tree, { token: '99999', ip: '5.5.5.5' });
    assert.equal(r.status, 200); assert.equal(r.data.viewer, 'public');
  });
});

describe('rate limiting', () => {
  test('a parallel burst cannot get more than the per-IP budget verified, even with the right token inside it', async () => {
    const guesses = Array.from({ length: 150 }, (_, i) => (i === 100 ? A : String(10000 + i)));
    const res = await Promise.all(guesses.map((g) => call(person, { method: 'PATCH', query: { id: ama }, token: g, body: { occupation: 'x' }, ip: '7.7.7.7' })));
    assert.ok(res.every((r) => r.status === 401), 'nothing in an over-budget burst is accepted');
    const n = (await pg.query("select count(*)::int n from token_attempts where ip='tok:7.7.7.7'")).rows[0].n;
    assert.ok(n <= 21, `at most the budget is charged, saw ${n}`);
    const elsewhere = await call(person, { method: 'PATCH', query: { id: ama }, token: A, body: { occupation: 'Trader' }, ip: '7.7.7.8' });
    assert.equal(elsewhere.status, 200, 'other visitors are unaffected');
  });
  test('slow sequential guessing is stopped at the budget', async () => {
    let last;
    for (let i = 0; i < 25; i++) last = await call(person, { method: 'PATCH', query: { id: ama }, token: String(30000 + i), body: { occupation: 'x' }, ip: '7.7.7.9' });
    assert.equal(last.status, 401);
    assert.equal((await call(person, { method: 'PATCH', query: { id: ama }, token: A, body: { occupation: 'x' }, ip: '7.7.7.9' })).status, 401, 'a blocked IP cannot use even a correct token');
  });
  test('valid use is never throttled', async () => {
    for (let i = 0; i < 40; i++) assert.equal((await call(person, { method: 'PATCH', query: { id: ama }, token: A, body: { occupation: `Job ${i}` }, ip: '8.8.8.8' })).status, 200);
    assert.equal((await pg.query("select count(*)::int n from token_attempts where ip='tok:8.8.8.8'")).rows[0].n, 0);
  });
  test('a sitewide failure surge pauses token checks for everyone, then recovers', async () => {
    await pg.query("insert into token_attempts(ip) select 'tok:*' from generate_series(1,501)");
    assert.equal((await call(me, { token: A, ip: '6.6.6.6' })).status, 401);
    assert.equal((await call(admin, { admin: true })).status, 200, 'the administrator is not locked out by token guessing');
    await pg.query("delete from token_attempts where ip='tok:*'");
    assert.equal((await call(me, { token: A, ip: '6.6.6.6' })).status, 200);
  });
  test('forged forwarding headers cannot reset the limiter', async () => {
    const hit = (i) => stories({ httpMethod: 'POST', queryStringParameters: {}, headers: { 'x-forwarded-for': `9.9.9.${i}`, 'client-ip': `8.1.1.${i}`, 'x-family-token': String(20000 + i) }, body: '{}' });
    let last;
    for (let i = 0; i < 25; i++) last = await hit(i);
    assert.equal(last.statusCode, 401);
    const n = (await pg.query("select count(*)::int n from token_attempts where ip='tok:unknown'")).rows[0].n;
    assert.ok(n >= 20 && n <= 21);
  });
  test('admin secret guessing is throttled per IP', async () => {
    for (let i = 0; i < 12; i++) await call(admin, { admin: `wrong-${i}`, ip: '4.4.4.4' });
    assert.equal((await call(admin, { admin: true, ip: '4.4.4.4' })).status, 403);
    assert.equal((await call(admin, { admin: true, ip: '4.4.4.5' })).status, 200);
  });
  test('bulk read endpoints are limited per IP', async () => {
    let last;
    for (let i = 0; i < 62; i++) last = await call(tree, { ip: '3.3.3.3' });
    assert.equal(last.status, 429);
    assert.equal((await call(tree, { ip: '3.3.3.4' })).status, 200);
  });
  test('data endpoints reject non-read methods', async () => {
    for (const m of ['DELETE', 'POST', 'OPTIONS', 'PUT']) { assert.equal((await call(tree, { method: m })).status, 405); assert.equal((await call(history, { method: m })).status, 405); }
  });
  test('the limiter table is pruned and does not grow without bound', async () => {
    await pg.query("insert into token_attempts(ip, attempted_at) select 'tok:old', now()-interval '3 days' from generate_series(1,50)");
    for (let i = 0; i < 400; i++) await call(history, { ip: `2.2.${i % 200}.1` }).catch(() => {});
    for (let i = 0; i < 200; i++) await call(analysis, { ip: `2.3.${i}.1` });
    assert.equal((await pg.query("select count(*)::int n from token_attempts where ip='tok:old'")).rows[0].n, 0);
  });
});

describe('contributor tokens', () => {
  test('strong 8-character tokens work, case-insensitively; the weak shape stays valid', async () => {
    const c = await call(tokens, { method: 'POST', admin: true, body: { label: 'Strong' } });
    assert.match(c.data.token, /^[A-HJ-NP-Z][A-HJ-NP-Z2-9]{7}$/);
    assert.equal((await call(me, { token: c.data.token })).status, 200);
    assert.equal((await call(me, { token: c.data.token.toLowerCase() })).status, 200);
    const d = await call(tokens, { method: 'POST', admin: true, body: { label: 'Digits', style: 'digits' } });
    assert.match(d.data.token, /^\d{5}$/);
    assert.equal((await call(me, { token: d.data.token })).status, 200);
    for (const bad of ['1234', '123456', 'ABCDEFGH1', 'I0O1L2AB', '', 'abc de']) assert.equal(validTokenShape(bad), false, bad);
    assert.match(normToken(' kq7m2xwa '), /^KQ7M2XWA$/);
    assert.match(newStrongToken(), /^[A-HJ-NP-Z]/);
  });
  test('tokens are hashed and refuse to run without any secret', () => {
    const keep = { p: process.env.TOKEN_PEPPER, a: process.env.ADMIN_SECRET };
    delete process.env.TOKEN_PEPPER; delete process.env.ADMIN_SECRET;
    try { assert.throws(() => hmacToken('12345'), /TOKEN_PEPPER/); } finally { process.env.TOKEN_PEPPER = keep.p; process.env.ADMIN_SECRET = keep.a; }
    assert.match(hmacToken('12345'), /^[0-9a-f]{64}$/);
  });
  test('only the administrator may list pending suggestions', async () => {
    assert.equal((await call(proposals, { token: A })).status, 403);
    assert.equal((await call(proposals, { admin: true })).status, 200);
  });
});

describe('edit history and restore', () => {
  let revId;
  test('every edit records old and new values', async () => {
    await call(person, { method: 'PATCH', query: { id: kofi }, token: A, body: { occupation: 'Farmer' } });
    const upd = await call(person, { method: 'PATCH', query: { id: kofi }, token: B, body: { occupation: 'Vandal', aliases: ['Defaced'] } });
    assert.equal(upd.status, 200);
    const noop = await call(person, { method: 'PATCH', query: { id: kofi }, token: B, body: { occupation: 'Vandal' } });
    assert.equal(noop.data.changed, false);
    const revs = (await call(admin, { admin: true })).data.revisions.filter((r) => r.person_id === kofi);
    const last = revs[0];
    assert.equal(last.token_label, 'B'); assert.equal(last.before.occupation, 'Farmer'); assert.equal(last.after.occupation, 'Vandal');
    revId = last.id;
  });
  test('only the administrator can restore, and restore is itself recorded', async () => {
    assert.equal((await call(admin, { method: 'POST', token: B, body: { kind: 'revert', id: revId } })).status, 403);
    const r = await call(admin, { method: 'POST', admin: true, body: { kind: 'revert', id: revId } });
    assert.equal(r.status, 200);
    const now = (await pg.query('select occupation, aliases from people where id=$1', [kofi])).rows[0];
    assert.equal(now.occupation, 'Farmer'); assert.ok(!now.aliases.includes('Defaced'));
    const top = (await call(admin, { admin: true })).data.revisions[0];
    assert.equal(top.action, 'revert'); assert.equal(top.reverted_of, revId);
    assert.equal((await call(admin, { admin: true })).data.revisions.find((x) => x.id === revId).is_reverted, true);
    assert.equal(await relationshipSnapshot(pg), baseline);
  });
  test('photo changes and removals are recorded and a removed photo can be restored', async () => {
    const up = await call(image, { method: 'POST', token: A, body: { kind: 'person', ref_id: kofi, content_type: 'image/png', data: png.toString('base64') } });
    assert.equal(up.status, 201);
    assert.equal((await call(image, { method: 'DELETE', token: A, query: { person_id: kofi } })).status, 200);
    assert.equal((await pg.query('select photo_url from people where id=$1', [kofi])).rows[0].photo_url, null);
    const rem = (await call(admin, { admin: true })).data.revisions.find((r) => r.person_id === kofi && r.action === 'photo' && r.after.photo_url === null);
    assert.ok(rem && rem.before.photo_url === up.data.url);
    assert.equal((await call(admin, { method: 'POST', admin: true, body: { kind: 'revert', id: rem.id } })).status, 200);
    assert.equal((await pg.query('select photo_url from people where id=$1', [kofi])).rows[0].photo_url, up.data.url);
    assert.ok((await pg.query("select 1 from audit_log where action='person_photo_removed'")).rows.length >= 1);
  });
  test('a person keeps at most four stored photos', async () => {
    for (let i = 0; i < 6; i++) await call(image, { method: 'POST', token: A, body: { kind: 'person', ref_id: ama, content_type: 'image/png', data: png.toString('base64') } });
    assert.equal((await pg.query("select count(*)::int n from images where kind='person' and ref_id=$1", [ama])).rows[0].n, 4);
  });
});

describe('story cover images', () => {
  const up = async (token) => (await call(image, { method: 'POST', token, body: { kind: 'story', content_type: 'image/png', data: png.toString('base64') } }));
  test('another contributor cannot attach or destroy someone else\'s cover', async () => {
    const mine = await up(A);
    const story = await call(stories, { method: 'POST', token: A, body: { title: 'Cover', content: 'Body', cover_image_id: mine.data.id } });
    assert.equal(story.status, 201);
    const steal = await call(stories, { method: 'POST', token: B, body: { title: 'Steal', content: 'x', cover_image_id: mine.data.id } });
    assert.equal(steal.status, 422);
    assert.equal((await call(image, { query: { id: mine.data.id } })).status, 200);
    const own = await up(B);
    const reuse = await call(stories, { method: 'POST', token: B, body: { title: 'Mine', content: 'x', cover_image_id: own.data.id } });
    assert.equal(reuse.status, 201);
    const again = await call(stories, { method: 'POST', token: B, body: { title: 'Dup', content: 'x', cover_image_id: own.data.id } });
    assert.equal(again.status, 422, 'an image can only belong to one story');
    await call(stories, { method: 'DELETE', token: B, query: { id: reuse.data.id } });
    assert.equal((await call(image, { query: { id: mine.data.id } })).status, 200, 'the other story keeps its cover');
    assert.equal((await call(image, { query: { id: own.data.id } })).status, 404, 'a deleted story removes its own cover');
  });
  test('unused uploads are capped per token', async () => {
    let last;
    for (let i = 0; i < 22; i++) last = await up(B);
    assert.equal(last.status, 429);
    assert.equal((await up(A)).status, 201, 'the cap is per token');
  });
  test('replacing a cover removes the old one', async () => {
    const first = await up(A);
    const s = await call(stories, { method: 'POST', token: A, body: { title: 'Swap', content: 'x', cover_image_id: first.data.id } });
    const second = await up(A);
    assert.equal((await call(stories, { method: 'PUT', token: A, query: { id: s.data.id }, body: { title: 'Swap', content: 'x', cover_image_id: second.data.id } })).status, 200);
    assert.equal((await call(image, { query: { id: first.data.id } })).status, 404);
    assert.equal((await call(image, { query: { id: second.data.id } })).status, 200);
  });
});

describe('network is for family members', () => {
  test('the people search needs a valid token; business ideas stay public', async () => {
    assert.equal((await call(network, { query: { occupation: 'engineer' } })).status, 401);
    assert.equal((await call(network, { query: {}, token: '99999', ip: '5.6.7.8' })).status, 401);
    const r = await call(network, { query: { occupation: 'engineer' }, token: A });
    assert.equal(r.status, 200);
    const raw = JSON.stringify(r.data);
    assert.ok(!raw.includes('birth_date'), 'no exact birth dates in network results');
  });
});

describe('placeholders and search', () => {
  test('unknown ancestors and the sacred rock are not counted as people', async () => {
    const kinds = (await pg.query("select kind, count(*)::int n from people group by 1")).rows;
    const ph = kinds.filter((k) => k.kind !== 'person').reduce((s, k) => s + k.n, 0);
    assert.ok(ph >= 11, `expected the placeholders to be classified, got ${ph}`);
    const a = (await call(analysis)).data;
    assert.equal(a.totals.total, 272 - ph);
    assert.equal(a.coverage.placeholders, ph);
    assert.equal(a.generations.reduce((n, g) => n + g.count, 0) + a.generations_unplaced, 272 - ph);
    assert.equal((await pg.query("select count(*)::int n from people where kind='place'")).rows[0].n, 1);
  });
  test('placeholders never appear in Network results', async () => {
    await pg.query("update people set occupation='Ancestor', living_status='living' where kind <> 'person'");
    const r = await call(network, { query: { occupation: 'Ancestor' }, token: A });
    assert.equal(r.data.total, 0);
  });
  test('Akan letters and accents are searchable with plain letters', async () => {
    await pg.query("insert into people(given_name, surname, aliases) values ($1,$2,$3)", ['\u0186d\u0254', 'Nyame \u00c0ma', ['K\u025bk\u025b']]);
    for (const q of ['odo', '\u0254d\u0254', '\u0186D\u0186', 'odo nyame ama', 'keke', 'K\u025bk\u025b']) {
      const r = (await call(search, { query: { q } })).data.results;
      assert.ok(r.some((p) => p.given_name === '\u0186d\u0254'), `"${q}" should find the person`);
    }
  });
});

describe('integrity after hardening', () => {
  test('the validated family structure is unchanged', async () => {
    assert.equal(await relationshipSnapshot(pg), baseline);
  });
  test('no public export exists in the functions folder', async () => {
    const { readdirSync, existsSync } = await import('node:fs');
    assert.ok(!readdirSync(new URL('../netlify/functions/', import.meta.url)).some((f) => /^_|export|dump|download|csv|gedcom/i.test(f)));
    for (const f of ['demo.json', 'seed.json', 'history.txt']) assert.ok(!existsSync(new URL(`../public/${f}`, import.meta.url)));
    assert.ok(!existsSync(new URL('../data/seed.json', import.meta.url)), 'the bulk family data file is no longer tracked');
  });
});
