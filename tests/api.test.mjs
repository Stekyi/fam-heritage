import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, makeToken, call, relationshipSnapshot } from './helpers.mjs';
import { handler as tree } from '../netlify/functions/tree.mjs';
import { handler as search } from '../netlify/functions/search.mjs';
import { handler as person } from '../netlify/functions/person.mjs';
import { handler as me } from '../netlify/functions/me.mjs';
import { handler as profile } from '../netlify/functions/profile.mjs';
import { handler as stories } from '../netlify/functions/stories.mjs';
import { handler as business } from '../netlify/functions/business.mjs';
import { handler as network } from '../netlify/functions/network.mjs';
import { handler as analysis } from '../netlify/functions/analysis.mjs';
import { handler as comment } from '../netlify/functions/comment.mjs';
import { handler as history } from '../netlify/functions/history.mjs';
import { handler as admin } from '../netlify/functions/admin.mjs';
import { handler as tokens } from '../netlify/functions/tokens.mjs';
import { handler as image } from '../netlify/functions/image.mjs';
import { handler as proposals } from '../netlify/functions/proposals.mjs';
import { runMigrations } from '../netlify/lib/db.mjs';

let pg;
let baseline;
const T1 = '11111';
const T2 = '22222';
const T3 = '33333';
let samuel; let ama; let isaac;

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  pg = await freshDatabase();
  await makeToken(pg, T1, 'Token One');
  await makeToken(pg, T2, 'Token Two');
  await makeToken(pg, T3, 'Token Three');
  baseline = await relationshipSnapshot(pg);
  samuel = (await pg.query("select id from people where given_name||' '||coalesce(surname,'')='Matthew Obiri-Yeboah' or (given_name||' '||coalesce(surname,''))='Matthew Obiri-Yeboah' limit 1")).rows[0]?.id;
  ama = (await pg.query("select p.id from people p where 'Nana Mansa'=any(p.aliases)")).rows[0].id;
  isaac = (await pg.query("select id from people where 'Kofi Gyima'=any(aliases)")).rows[0].id;
});

describe('migrations', () => {
  test('are idempotent and additive', async () => {
    const before = await pg.query('select count(*)::int n from people');
    await runMigrations(pg);
    await runMigrations(pg);
    const after = await pg.query('select count(*)::int n from people');
    assert.equal(after.rows[0].n, before.rows[0].n);
    const v = await pg.query('select version from schema_migrations');
    assert.deepEqual(v.rows.map((r) => r.version).sort(), ['002_heritage_platform', '003_hardening', '004_features']);
    assert.equal(await relationshipSnapshot(pg), baseline);
  });
});

describe('family tree integrity (validated structure)', () => {
  const kids = async (id) => (await pg.query("select p.given_name||' '||coalesce(p.surname,'') n from relationships r join people p on p.id=r.to_person_id where r.from_person_id=$1 and r.relationship_type='parent'", [id])).rows.map((r) => r.n).sort();
  test('Nana Mansa has exactly the five validated children', async () => {
    assert.deepEqual(await kids(ama), ['Abena Gyampraa', 'Afua Ampomaa', 'Charles Buafo', 'John Kwaku Buafo', 'Yaa Brefaa']);
  });
  test('Yaa Brefaa children, and Maame Ansaba is not her direct child', async () => {
    const yaa = (await pg.query("select id from people where given_name||' '||coalesce(surname,'')='Yaa Brefaa'")).rows[0].id;
    const k = await kids(yaa);
    assert.deepEqual(k, ['Agnes Baidoo', 'Helena Baidoo', 'Isaac Baidoo', 'Margaret Buafo', 'Matthew Baidoo', 'Vida Armoo']);
    assert.ok(!k.includes('Maame Ansaba'));
    const helena = (await pg.query("select id from people where given_name||' '||coalesce(surname,'')='Helena Baidoo'")).rows[0].id;
    assert.ok((await kids(helena)).includes('Maame Ansaba'));
  });
  test('Isaac Obiri-Yeboah (Kofi Gyima) children are not Matthew Obiri-Yeboah children', async () => {
    assert.deepEqual(await kids(isaac), ['Bernice Obiri-Yeboah', 'Harriette Obiri-Yeboah', 'Wendy Obiri-Yeboah']);
    const matthew = (await pg.query("select id from people where given_name||' '||coalesce(surname,'')='Matthew Obiri-Yeboah'")).rows[0].id;
    const mk = await kids(matthew);
    for (const n of ['Harriette Obiri-Yeboah', 'Bernice Obiri-Yeboah', 'Wendy Obiri-Yeboah']) assert.ok(!mk.includes(n));
  });
});

describe('search', () => {
  const q = (s) => call(search, { query: { q: s } });
  test('name, AKA and alias find the same person, case-insensitively', async () => {
    for (const term of ['Ama Buah', 'Nana Mansa', 'Mansa', 'nana mansa', 'NANA MANSA', 'ama buah']) {
      const r = await q(term);
      assert.equal(r.status, 200);
      assert.ok(r.data.results.some((p) => p.id === ama), `"${term}" should find the person`);
    }
  });
  test('no match returns an empty list', async () => {
    assert.deepEqual((await q('zzzzqqq')).data.results, []);
    assert.deepEqual((await q('')).data.results, []);
  });
  test('cannot be opened as a document', async () => {
    const r = await call(search, { query: { q: 'ama' }, headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } });
    assert.equal(r.status, 403);
  });
});

describe('tree data', () => {
  test('returns the whole graph without secrets', async () => {
    const r = await call(tree);
    assert.equal(r.status, 200);
    assert.equal(r.data.people.length, 272);
    assert.equal(r.data.relationships.length, 300);
    assert.ok(!JSON.stringify(r.data).includes('token'));
  });
});

describe('editing people', () => {
  test('rejects missing and invalid tokens', async () => {
    assert.equal((await call(person, { method: 'PATCH', query: { id: ama }, body: { occupation: 'x' } })).status, 401);
    assert.equal((await call(person, { method: 'PATCH', query: { id: ama }, token: '99999', body: { occupation: 'x' } })).status, 401);
    assert.equal((await call(person, { method: 'PATCH', query: { id: ama }, token: 'abcde', body: { occupation: 'x' } })).status, 401);
  });
  test('a token holder can edit ANY person, only the name is mandatory', async () => {
    const r = await call(person, { method: 'PATCH', query: { id: ama }, token: T1, body: { given_name: 'Ama Buah', aliases: ['Nana Mansa', 'Mansa', 'Nana Mansa'] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.person.aliases, ['Nana Mansa', 'Mansa']);
    const other = await call(person, { method: 'PATCH', query: { id: isaac }, token: T2, body: { occupation: 'Engineer', location: 'Ghana', birth_place: 'Kumasi', sex: 'M', birth: '1960-04-09', living_status: 'living' } });
    assert.equal(other.status, 200);
    assert.equal(other.data.person.occupation, 'Engineer');
    assert.equal(other.data.person.birth_date, '1960-04-09');
    assert.equal(other.data.person.birth_year, 1960);
    assert.equal(other.data.person.sex, 'M');
  });
  test('validation messages', async () => {
    const empty = await call(person, { method: 'PATCH', query: { id: isaac }, token: T1, body: { given_name: '   ' } });
    assert.equal(empty.status, 422); assert.match(empty.data.error, /enter a name/i);
    const bad = await call(person, { method: 'PATCH', query: { id: isaac }, token: T1, body: { birth: '31/02/1990' } });
    assert.equal(bad.status, 422); assert.match(bad.data.error, /valid date/i);
    const feb = await call(person, { method: 'PATCH', query: { id: isaac }, token: T1, body: { birth: '1990-02-31' } });
    assert.equal(feb.status, 422);
    const future = await call(person, { method: 'PATCH', query: { id: isaac }, token: T1, body: { birth: '2999-01-01' } });
    assert.equal(future.status, 422);
    const order = await call(person, { method: 'PATCH', query: { id: isaac }, token: T1, body: { death: '1950' } });
    assert.equal(order.status, 422); assert.match(order.data.error, /before/i);
    const sex = await call(person, { method: 'PATCH', query: { id: isaac }, token: T1, body: { sex: 'robot' } });
    assert.equal(sex.status, 422);
  });
  test('relationships are never changed by editing', async () => {
    await call(person, { method: 'PATCH', query: { id: ama }, token: T1, body: { given_name: 'Ama Buah', surname: null, occupation: 'Matriarch', birth: '1900', death: '1980' } });
    assert.equal(await relationshipSnapshot(pg), baseline);
  });
  test('year-only dates are stored without inventing a day', async () => {
    const r = await call(person, { method: 'PATCH', query: { id: ama }, token: T1, body: { birth: '1900' } });
    assert.equal(r.data.person.birth_year, 1900);
    assert.equal(r.data.person.birth_date, null);
  });
  test('public users cannot read protected fields through me/profile', async () => {
    assert.equal((await call(me)).status, 401);
    assert.equal((await call(profile, { method: 'PUT', body: { about: 'x' } })).status, 401);
  });
});

describe('profile images', () => {
  test('persist in the database, validate type and size', async () => {
    const ok = await call(image, { method: 'POST', token: T1, body: { kind: 'person', ref_id: isaac, content_type: 'image/png', data: png.toString('base64') } });
    assert.equal(ok.status, 201);
    const photo = (await pg.query('select photo_url from people where id=$1', [isaac])).rows[0].photo_url;
    assert.equal(photo, ok.data.url);
    const get = await call(image, { query: { id: ok.data.id } });
    assert.equal(get.status, 200);
    assert.equal(get.headers['Content-Type'], 'image/png');
    assert.deepEqual(Buffer.from(get.data, 'base64'), png);
    const wrong = await call(image, { method: 'POST', token: T1, body: { kind: 'person', ref_id: isaac, content_type: 'image/png', data: Buffer.from('not an image').toString('base64') } });
    assert.equal(wrong.status, 415);
    const gif = await call(image, { method: 'POST', token: T1, body: { kind: 'person', ref_id: isaac, content_type: 'image/gif', data: png.toString('base64') } });
    assert.equal(gif.status, 415);
    const big = Buffer.concat([png, Buffer.alloc(1.6 * 1024 * 1024)]);
    const huge = await call(image, { method: 'POST', token: T1, body: { kind: 'person', ref_id: isaac, content_type: 'image/png', data: big.toString('base64') } });
    assert.equal(huge.status, 413);
    const noTok = await call(image, { method: 'POST', body: { kind: 'person', ref_id: isaac, content_type: 'image/png', data: png.toString('base64') } });
    assert.equal(noTok.status, 401);
    const second = await call(image, { method: 'POST', token: T1, body: { kind: 'person', ref_id: isaac, content_type: 'image/png', data: png.toString('base64') } });
    assert.equal(second.status, 201);
    assert.equal((await pg.query("select count(*)::int n from images where kind='person' and ref_id=$1", [isaac])).rows[0].n, 2);
  });
});

describe('linking a token to a family member', () => {
  test('link, show current link, block a second link and duplicates', async () => {
    assert.equal((await call(me, { method: 'POST', token: T1, body: {} })).status, 422);
    const link = await call(me, { method: 'POST', token: T1, body: { person_id: isaac } });
    assert.equal(link.status, 201);
    assert.equal((await call(me, { token: T1 })).data.linked_person.id, isaac);
    const again = await call(me, { method: 'POST', token: T1, body: { person_id: ama } });
    assert.equal(again.status, 409);
    const dup = await call(me, { method: 'POST', token: T2, body: { person_id: isaac } });
    assert.equal(dup.status, 409);
  });
});

describe('profile and stories', () => {
  let storyId;
  test('profile needs a linked token and can only be written for the linked person', async () => {
    assert.equal((await call(profile, { method: 'PUT', token: T3, body: { about: 'Hello' } })).status, 403);
    assert.equal((await call(profile, { method: 'PUT', token: T1, body: { about: '   ' } })).status, 422);
    const ok = await call(profile, { method: 'PUT', token: T1, body: { about: 'I live in Accra.' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.person_id, isaac);
    const pub = await call(profile, { query: { person_id: isaac } });
    assert.equal(pub.data.profile.about, 'I live in Accra.');
    const t = await call(tree);
    assert.equal(t.data.people.find((p) => p.id === isaac).has_profile, true);
  });
  test('create, list, edit, delete stories with ownership rules', async () => {
    assert.equal((await call(stories, { method: 'POST', token: T3, body: { title: 'x', content: 'y' } })).status, 403);
    assert.equal((await call(stories, { method: 'POST', token: T1, body: { title: '', content: 'y' } })).status, 422);
    const cover = await call(image, { method: 'POST', token: T1, body: { kind: 'story', content_type: 'image/png', data: png.toString('base64') } });
    assert.equal(cover.status, 201);
    const c = await call(stories, { method: 'POST', token: T1, body: { title: 'Our village', content: 'It began at the river.', cover_image_id: cover.data.id } });
    assert.equal(c.status, 201);
    storyId = c.data.id;
    const list = await call(stories, {});
    assert.equal(list.data.total, 1);
    assert.equal(list.data.stories[0].author_name, 'Isaac Obiri-Yeboah');
    assert.ok(list.data.stories[0].cover_url);
    const one = await call(stories, { query: { id: storyId } });
    assert.equal(one.data.story.person_id, isaac);
    await call(me, { method: 'POST', token: T2, body: { person_id: ama } });
    assert.equal((await call(stories, { method: 'PUT', token: T2, query: { id: storyId }, body: { title: 'Hijack', content: 'no' } })).status, 403);
    assert.equal((await call(stories, { method: 'DELETE', token: T2, query: { id: storyId } })).status, 403);
    const upd = await call(stories, { method: 'PUT', token: T1, query: { id: storyId }, body: { title: 'Our village (updated)', content: 'It began at the river.' } });
    assert.equal(upd.status, 200);
    assert.equal((await call(stories, { query: { id: storyId } })).data.story.title, 'Our village (updated)');
  });
  test('person endpoint exposes the public profile and stories', async () => {
    const r = await call(person, { query: { id: isaac } });
    assert.equal(r.data.profile.about, 'I live in Accra.');
    assert.equal(r.data.stories.length, 1);
  });
  test('deleting a story removes it', async () => {
    const d = await call(stories, { method: 'DELETE', token: T1, query: { id: storyId } });
    assert.equal(d.status, 200);
    assert.equal((await call(stories, {})).data.total, 0);
  });
  test('unlinking then re-linking works', async () => {
    assert.equal((await call(me, { method: 'DELETE', token: T2 })).status, 200);
    assert.equal((await call(me, { token: T2 })).data.linked_person, null);
    assert.equal((await call(me, { method: 'POST', token: T2, body: { person_id: ama } })).status, 201);
  });
});

describe('comments and moderation', () => {
  test('public commenting goes to moderation; admin approves; it then appears', async () => {
    const empty = await call(comment, { method: 'POST', body: { author_name: '', body: 'x' } });
    assert.equal(empty.status, 422);
    const ok = await call(comment, { method: 'POST', body: { author_name: 'Visitor', body: 'Lovely history.' } });
    assert.equal(ok.status, 201);
    assert.match(ok.data.message, /awaiting moderation/i);
    assert.equal((await call(history)).data.comments.length, 0);
    assert.equal((await call(admin)).status, 403);
    const q = await call(admin, { admin: true });
    assert.equal(q.data.comments.length, 1);
    await call(admin, { method: 'POST', admin: true, body: { kind: 'comment', id: q.data.comments[0].id, status: 'approved' } });
    assert.equal((await call(history)).data.comments.length, 1);
  });
  test('honeypot and rate limit', async () => {
    const bot = await call(comment, { method: 'POST', body: { author_name: 'Bot', body: 'spam', website: 'http://spam' } });
    assert.equal(bot.status, 201);
    assert.equal((await pg.query("select count(*)::int n from comments where author_name='Bot'")).rows[0].n, 0);
    let last;
    for (let i = 0; i < 7; i++) last = await call(comment, { method: 'POST', ip: '9.9.9.9', body: { author_name: 'Fast', body: `c${i}` } });
    assert.equal(last.status, 429);
  });
  test('the history article is available', async () => {
    const h = await call(history);
    assert.equal(h.data.article.slug, 'asankran-history');
    assert.ok(h.data.article.body.length > 1000);
  });
});

describe('network', () => {
  test('filters by occupation, location, gender and age and combinations', async () => {
    await call(person, { method: 'PATCH', query: { id: ama }, token: T1, body: { occupation: 'Software Engineer', location: 'Accra, Ghana', sex: 'F', birth: '1985-05-05', death: '', living_status: 'living' } });
    const n = (query) => call(network, { query });
    assert.equal((await n({ occupation: 'engineer' })).data.total, 2);
    assert.equal((await n({ occupation: 'ENGINEER', location: 'ghana' })).data.total, 2);
    assert.equal((await n({ occupation: 'engineer', gender: 'F' })).data.total, 1);
    assert.equal((await n({ occupation: 'engineer', gender: 'M' })).data.total, 1);
    assert.equal((await n({ occupation: 'engineer', location: 'Kumasi' })).data.total, 1);
    assert.equal((await n({ occupation: 'engineer', age_min: '30', age_max: '45' })).data.total, 1);
    const none = await n({ occupation: 'astronaut' });
    assert.equal(none.data.total, 0);
    const r = (await n({ occupation: 'engineer', gender: 'M' })).data.results[0];
    assert.equal(r.id, isaac);
    assert.equal(r.short_profile, 'I live in Accra.');
    assert.ok((await n({})).data.suggestions.occupations.includes('Engineer'));
  });
  test('deceased people are not offered as network contacts', async () => {
    await call(person, { method: 'PATCH', query: { id: isaac }, token: T1, body: { death: '2001' } });
    assert.equal((await call(network, { query: { occupation: 'engineer', gender: 'M' } })).data.total, 0);
  });
});

describe('business ideas', () => {
  let ideaId;
  test('create requires a linked token and valid fields', async () => {
    assert.equal((await call(business, { method: 'POST', body: {} })).status, 401);
    assert.equal((await call(business, { method: 'POST', token: T3, body: { title: 't', description: 'd', category: 'c', location: 'l' } })).status, 403);
    assert.equal((await call(business, { method: 'POST', token: T2, body: { title: 'Farm', description: '', category: 'Agri', location: 'Ghana' } })).status, 422);
    assert.equal((await call(business, { method: 'POST', token: T2, body: { title: 'Farm', description: 'Cocoa', category: 'Agri', location: 'Ghana', website: 'javascript:alert(1)' } })).status, 422);
    const ok = await call(business, { method: 'POST', token: T2, body: { title: 'Cocoa farm', description: 'Invest in cocoa.', category: 'Agriculture', location: 'Ghana', funding_needed: '$20,000', skills_needed: 'Agronomy', website: 'cocoa.example.com' } });
    assert.equal(ok.status, 201);
    ideaId = ok.data.id;
  });
  test('anyone can view; contact information is never public', async () => {
    const list = await call(business, {});
    assert.equal(list.data.total, 1);
    assert.equal(list.data.ideas[0].interested_count, 0);
    assert.equal(list.data.ideas[0].website, 'https://cocoa.example.com/');
    const one = await call(business, { query: { id: ideaId } });
    assert.equal(one.status, 200);
    assert.equal(one.data.interests, undefined);
  });
  test('interest requires valid contact info, owner cannot self-register, owner sees contacts', async () => {
    assert.equal((await call(business, { method: 'POST', query: { id: ideaId, interest: '1' }, token: T1, body: { contact_method: 'email', contact_value: 'nope' } })).status, 422);
    assert.equal((await call(business, { method: 'POST', query: { id: ideaId, interest: '1' }, token: T1, body: { contact_method: 'fax', contact_value: '123' } })).status, 422);
    assert.equal((await call(business, { method: 'POST', query: { id: ideaId, interest: '1' }, token: T2, body: { contact_method: 'email', contact_value: 'a@b.co' } })).status, 409);
    const ok = await call(business, { method: 'POST', query: { id: ideaId, interest: '1' }, token: T1, body: { contact_method: 'whatsapp', contact_value: '+233 24 000 0000' } });
    assert.equal(ok.status, 200);
    assert.equal((await call(business, {})).data.ideas[0].interested_count, 1);
    const asOther = await call(business, { query: { id: ideaId }, token: T1 });
    assert.equal(asOther.data.interests, undefined);
    assert.equal(asOther.data.my_interest.contact_method, 'whatsapp');
    const asOwner = await call(business, { query: { id: ideaId }, token: T2 });
    assert.equal(asOwner.data.idea.is_owner, true);
    assert.equal(asOwner.data.interests.length, 1);
    assert.equal(asOwner.data.interests[0].contact_value, '+233 24 000 0000');
    assert.equal(asOwner.data.interests[0].name, 'Isaac Obiri-Yeboah');
    assert.equal(JSON.stringify((await call(business, {})).data).includes('233 24'), false);
  });
  test('interest can be updated and removed', async () => {
    await call(business, { method: 'POST', query: { id: ideaId, interest: '1' }, token: T1, body: { contact_method: 'email', contact_value: 'me@family.org' } });
    assert.equal((await call(business, { query: { id: ideaId }, token: T2 })).data.interests.length, 1);
    assert.equal((await call(business, { method: 'DELETE', query: { id: ideaId, interest: '1' }, token: T1 })).status, 200);
    assert.equal((await call(business, {})).data.ideas[0].interested_count, 0);
  });
  test('only the owner (or admin) can remove an idea', async () => {
    assert.equal((await call(business, { method: 'DELETE', query: { id: ideaId }, token: T1 })).status, 403);
    assert.equal((await call(business, { method: 'DELETE', query: { id: ideaId }, token: T2 })).status, 200);
    assert.equal((await call(business, {})).data.total, 0);
  });
  test('search and category filters', async () => {
    await call(business, { method: 'POST', token: T2, body: { title: 'Tech hub', description: 'Coworking', category: 'Technology', location: 'Accra' } });
    await call(business, { method: 'POST', token: T2, body: { title: 'Bakery', description: 'Bread', category: 'Food', location: 'Kumasi' } });
    assert.equal((await call(business, { query: { q: 'tech' } })).data.total, 1);
    assert.equal((await call(business, { query: { category: 'food' } })).data.total, 1);
    assert.equal((await call(business, { query: { location: 'kum' } })).data.total, 1);
    assert.equal((await call(business, { query: { limit: '1' } })).data.ideas.length, 1);
  });
});

describe('analysis', () => {
  test('numbers come from real data and nothing is invented', async () => {
    const r = await call(analysis);
    assert.equal(r.status, 200);
    const a = r.data;
    const real = (await pg.query("select count(*)::int n from people where kind='person'")).rows[0].n;
    assert.equal(a.totals.total, real);
    assert.ok(real < 272, 'placeholders are excluded');
    assert.equal(a.totals.living + a.totals.presumed_living + a.totals.deceased + a.totals.unknown, real);
    assert.equal(a.gender.male + a.gender.female + a.gender.other + a.gender.unknown, real);
    const placed = a.generations.reduce((n, g) => n + g.count, 0);
    assert.equal(placed + a.generations_unplaced, real);
    assert.ok(a.generations.length >= 3);
    assert.equal(a.current_age.n, a.current_age.distribution.reduce((n, b) => n + b.count, 0));
  });
});

describe('security', () => {
  test('admin endpoints are closed without the secret', async () => {
    assert.equal((await call(admin)).status, 403);
    assert.equal((await call(admin, { admin: 'wrong' })).status, 403);
    assert.equal((await call(tokens)).status, 403);
    assert.equal((await call(tokens, { method: 'POST' })).status, 403);
    assert.equal((await call(admin, { method: 'POST', body: { kind: 'story_remove', id: ama } })).status, 403);
  });
  test('a token is not an admin credential', async () => {
    assert.equal((await call(admin, { token: T1 })).status, 403);
  });
  test('admin can create, list, revoke tokens and unlink', async () => {
    const c = await call(tokens, { method: 'POST', admin: true, body: { label: 'New cousin' } });
    assert.match(c.data.token, /^([A-HJ-NP-Z][A-HJ-NP-Z2-9]{7}|\d{5})$/);
    const list = await call(tokens, { admin: true });
    assert.ok(list.data.some((t) => t.label === 'New cousin'));
    assert.ok(list.data.some((t) => t.person_name === 'Isaac Obiri-Yeboah'));
    const t = list.data.find((x) => x.label === 'New cousin');
    await call(tokens, { method: 'PATCH', admin: true, body: { id: t.id, active: false } });
    assert.equal((await call(person, { method: 'PATCH', query: { id: ama }, token: c.data.token, body: { occupation: 'x' } })).status, 401);
    const linked = list.data.find((x) => x.person_name === 'Isaac Obiri-Yeboah');
    await call(tokens, { method: 'PATCH', admin: true, body: { id: linked.id, unlink: true } });
    assert.equal((await call(me, { token: T1 })).data.linked_person, null);
  });
  test('failed token guesses are rate limited per IP but valid use is not', async () => {
    for (let i = 0; i < 20; i++) await call(person, { method: 'PATCH', query: { id: ama }, token: '00000', body: { occupation: 'x' }, ip: '7.7.7.7' });
    assert.equal((await call(person, { method: 'PATCH', query: { id: ama }, token: T1, body: { occupation: 'x' }, ip: '7.7.7.7' })).status, 401);
    for (let i = 0; i < 40; i++) assert.equal((await call(person, { method: 'PATCH', query: { id: ama }, token: T1, body: { occupation: 'Rate test' }, ip: '8.8.8.8' })).status, 200);
  });
  test('there is no public export or database dump', async () => {
    const { readdirSync, existsSync } = await import('node:fs');
    const fns = readdirSync(new URL('../netlify/functions/', import.meta.url));
    assert.ok(!fns.some((f) => /export|dump|download|csv|gedcom/i.test(f)));
    for (const f of ['demo.json', 'history.txt', 'seed.json']) assert.ok(!existsSync(new URL(`../public/${f}`, import.meta.url)), `public/${f} must not be served`);
  });
  test('proposals: add person needs a token and a name, relationships preserved until approved', async () => {
    assert.equal((await call(proposals, { method: 'POST', body: { action: 'add_person', payload: { given_name: 'X' } } })).status, 401);
    assert.equal((await call(proposals, { method: 'POST', token: T2, body: { action: 'add_person', payload: { given_name: ' ' } } })).status, 422);
    assert.equal((await call(proposals, { method: 'POST', token: T2, body: { action: 'delete_person', payload: { id: ama } } })).status, 400);
    const ok = await call(proposals, { method: 'POST', token: T2, body: { action: 'add_person', payload: { given_name: 'Newborn', surname: 'Tekyi', parent_id: ama, relationship_kind: 'child' } } });
    assert.equal(ok.status, 201);
    assert.equal(await relationshipSnapshot(pg), baseline);
    const q = await call(admin, { admin: true });
    const pr = q.data.proposals[0];
    await call(admin, { method: 'POST', admin: true, body: { kind: 'proposal', id: pr.id, status: 'approved' } });
    assert.equal((await pg.query("select count(*)::int n from relationships r join people p on p.id=r.to_person_id where r.from_person_id=$1 and p.given_name='Newborn'", [ama])).rows[0].n, 1);
  });
});
