import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { freshDatabase, makeToken, call } from './helpers.mjs';
import { handler as me } from '../netlify/functions/me.mjs';
import { handler as person } from '../netlify/functions/person.mjs';
import { handler as verify } from '../netlify/functions/verify.mjs';
import { handler as tokens } from '../netlify/functions/tokens.mjs';
import { handler as media } from '../netlify/functions/media.mjs';
import { handler as push } from '../netlify/functions/push.mjs';
import { handler as image } from '../netlify/functions/image.mjs';
import { handler as photos } from '../netlify/functions/photos.mjs';
import { handler as backup } from '../netlify/functions/backup.mjs';
import weeklyBackup from '../netlify/functions/backup-weekly.mjs';
import { setPushTransport, pushToAll } from '../netlify/lib/push.mjs';
import { sniffMedia } from '../netlify/functions/media.mjs';

let pg; let A; let B; let C; let isaac; let ama;
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 7)]);
const sub = (n) => ({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${n}-abcdefghij`, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } } });

before(async () => {
  pg = await freshDatabase();
  A = await makeToken(pg, '11111', 'Elder Kofi'); B = await makeToken(pg, '22222', 'Contributor'); C = await makeToken(pg, '33333', 'Unlinked');
  isaac = (await pg.query("select id from people where 'Kofi Gyima'=any(aliases)")).rows[0].id;
  ama = (await pg.query("select id from people where 'Nana Mansa'=any(aliases)")).rows[0].id;
  assert.equal((await call(me, { method: 'POST', token: '11111', body: { person_id: isaac } })).status, 201);
  assert.equal((await call(me, { method: 'POST', token: '22222', body: { person_id: ama } })).status, 201);
});

describe('roles and verification', () => {
  test('only an elder can verify; the role shows on /api/me', async () => {
    assert.equal((await call(verify, { method: 'POST', token: '22222', body: { person_id: ama } })).status, 403);
    assert.equal((await call(tokens, { method: 'PATCH', admin: true, body: { id: A, role: 'elder' } })).status, 200);
    assert.equal((await call(me, { token: '11111' })).data.token.role, 'elder');
    const r = await call(verify, { method: 'POST', token: '11111', body: { person_id: ama } });
    assert.equal(r.status, 200); assert.equal(r.data.verified_by, 'Elder Kofi');
    assert.equal((await call(person, { query: { id: ama } })).data.person.verified_by, 'Elder Kofi');
  });
  test('editing a recorded fact removes the verification, editing a note does not', async () => {
    assert.equal((await call(person, { method: 'PATCH', query: { id: ama }, token: '22222', body: { occupation: 'Trader' } })).status, 200);
    assert.equal((await call(person, { query: { id: ama } })).data.person.verified_by, 'Elder Kofi');
    assert.equal((await call(person, { method: 'PATCH', query: { id: ama }, token: '22222', body: { birth_place: 'Oda' } })).status, 200);
    assert.equal((await call(person, { query: { id: ama } })).data.person.verified_by, null);
  });
  test('the administrator can verify and remove verification', async () => {
    assert.equal((await call(verify, { method: 'POST', admin: true, body: { person_id: ama } })).data.verified_by, 'Administrator');
    assert.equal((await call(verify, { method: 'DELETE', admin: true, body: { person_id: ama } })).data.verified_by, null);
  });
});

describe('voice and video memories', () => {
  test('sniffing recognises real containers only', () => {
    assert.ok(sniffMedia(WEBM).includes('audio/webm'));
    assert.equal(sniffMedia(Buffer.from('not media at all, just text')), null);
  });
  test('needs a linked token', async () => {
    const body = { person_id: ama, title: 'Hello', content_type: 'audio/webm', data: WEBM.toString('base64') };
    assert.equal((await call(media, { method: 'POST', body })).status, 401);
    assert.equal((await call(media, { method: 'POST', token: '33333', body })).status, 403);
  });
  test('upload, list, range playback, delete own, reject fakes', async () => {
    const up = await call(media, { method: 'POST', token: '22222', body: { person_id: ama, title: 'Grandma tells the story', content_type: 'audio/webm;codecs=opus', data: WEBM.toString('base64') } });
    assert.equal(up.status, 201);
    const list = await call(media, { query: { person_id: ama } });
    assert.equal(list.data.media.length, 1); assert.equal(list.data.media[0].kind, 'audio');
    const full = await media({ httpMethod: 'GET', queryStringParameters: { id: up.data.id }, headers: {} });
    assert.equal(full.statusCode, 200); assert.equal(Buffer.from(full.body, 'base64').length, WEBM.length);
    const part = await media({ httpMethod: 'GET', queryStringParameters: { id: up.data.id }, headers: { range: 'bytes=0-9' } });
    assert.equal(part.statusCode, 206); assert.equal(part.headers['Content-Range'], `bytes 0-9/${WEBM.length}`);
    const fake = await call(media, { method: 'POST', token: '22222', body: { person_id: ama, title: 'x', content_type: 'audio/webm', data: Buffer.from('hello world, this is not audio').toString('base64') } });
    assert.equal(fake.status, 415);
    assert.equal((await call(media, { method: 'DELETE', query: { id: up.data.id }, token: '11111' })).status, 403);
    assert.equal((await call(media, { method: 'DELETE', query: { id: up.data.id }, token: '22222' })).status, 200);
  });
  test('the administrator can list and remove any recording', async () => {
    const up = await call(media, { method: 'POST', token: '22222', body: { person_id: ama, title: 'Keep me', content_type: 'audio/webm', data: WEBM.toString('base64') } });
    assert.equal((await call(media, { query: { all: '1' } })).status, 403);
    const all = await call(media, { query: { all: '1' }, admin: true });
    assert.ok(all.data.media.some((m) => m.id === up.data.id && m.person_name));
    assert.equal((await call(media, { method: 'DELETE', query: { id: up.data.id }, admin: true })).status, 200);
  });
  test('oversized recordings are refused', async () => {
    const big = Buffer.concat([WEBM, Buffer.alloc(4 * 1024 * 1024)]);
    assert.equal((await call(media, { method: 'POST', token: '22222', body: { person_id: ama, title: 'Big', content_type: 'audio/webm', data: big.toString('base64') } })).status, 413);
  });
});

describe('notifications', () => {
  test('off until the keys are configured', async () => {
    delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
    assert.equal((await call(push, {})).data.enabled, false);
    assert.equal((await call(push, { method: 'POST', body: sub(1) })).status, 503);
  });
  test('subscribe, tell contributors apart, send, and drop dead subscriptions', async () => {
    process.env.VAPID_PUBLIC_KEY = 'pub'; process.env.VAPID_PRIVATE_KEY = 'priv';
    assert.equal((await call(push, { method: 'POST', body: { subscription: { endpoint: 'http://insecure', keys: {} } } })).status, 422);
    assert.equal((await call(push, { method: 'POST', body: { subscription: { endpoint: 'https://internal.example.org/hook-abcdefg', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } } } })).status, 422);
    assert.equal((await call(push, { method: 'POST', body: sub(1) })).data.contributor, false);
    assert.equal((await call(push, { method: 'POST', token: '22222', body: sub(2) })).data.contributor, true);
    assert.equal((await call(push, { method: 'POST', body: sub(3) })).status, 201);
    const seen = [];
    setPushTransport(async (s) => { seen.push(s.endpoint); if (s.endpoint.includes('/3-')) { const e = new Error('gone'); e.statusCode = 410; throw e; } });
    assert.deepEqual(await pushToAll(pg, { title: 't' }), { sent: 2, removed: 1 });
    seen.length = 0;
    assert.deepEqual(await pushToAll(pg, { title: 'b' }, { contributorOnly: true }), { sent: 1, removed: 0 });
    assert.ok(seen[0].includes('/2-'));
    setPushTransport(null);
  });
});

describe('audit fixes', () => {
  test('a token cannot hop to a different person after unlinking; the administrator can reset it', async () => {
    assert.equal((await call(me, { method: 'DELETE', token: '22222' })).status, 200);
    const other = (await pg.query("select id from people where id <> $1 and id not in (select person_id from token_person_links) limit 1", [ama])).rows[0].id;
    assert.equal((await call(me, { method: 'POST', token: '22222', body: { person_id: other } })).status, 403);
    assert.equal((await call(me, { method: 'POST', token: '22222', body: { person_id: ama } })).status, 201);
    assert.equal((await call(me, { method: 'DELETE', token: '22222' })).status, 200);
    assert.equal((await call(tokens, { method: 'PATCH', admin: true, body: { id: B, unlink: true } })).status, 200);
    assert.equal((await call(me, { method: 'POST', token: '22222', body: { person_id: other } })).status, 201);
    assert.equal((await call(me, { method: 'DELETE', token: '22222' })).status, 200);
    assert.equal((await call(tokens, { method: 'PATCH', admin: true, body: { id: B, unlink: true } })).status, 200);
    assert.equal((await call(me, { method: 'POST', token: '22222', body: { person_id: ama } })).status, 201);
  });
  test('disabling a token removes its notification subscriptions and stops birthday pushes', async () => {
    process.env.VAPID_PUBLIC_KEY = 'pub'; process.env.VAPID_PRIVATE_KEY = 'priv';
    assert.equal((await call(push, { method: 'POST', token: '22222', body: sub(9) })).status, 201);
    setPushTransport(async () => {});
    assert.equal((await pushToAll(pg, { title: 'b' }, { contributorOnly: true })).sent >= 1, true);
    assert.equal((await call(tokens, { method: 'PATCH', admin: true, body: { id: B, active: false } })).status, 200);
    assert.deepEqual(await pushToAll(pg, { title: 'b' }, { contributorOnly: true }), { sent: 0, removed: 0 });
    await call(tokens, { method: 'PATCH', admin: true, body: { id: B, active: true } });
    setPushTransport(null);
  });
  test('5-digit tokens can be switched off', async () => {
    process.env.DISABLE_LEGACY_TOKENS = '1';
    assert.equal((await call(me, { token: '22222' })).status, 401);
    delete process.env.DISABLE_LEGACY_TOKENS;
    assert.equal((await call(me, { token: '22222' })).status, 200);
  });
});

describe('public photo offers', () => {
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 5)]);
  const offer = (extra = {}, opts = {}) => call(image, { method: 'POST', ...opts, body: { kind: 'person', ref_id: ama, content_type: 'image/jpeg', data: JPG.toString('base64'), ...extra } });
  let pendingId;
  test('a visitor can offer a photo, but it stays hidden until approved', async () => {
    const r = await offer({ submitter: 'Cousin Efua' });
    assert.equal(r.status, 202); assert.equal(r.data.pending, true);
    assert.equal((await call(person, { query: { id: ama } })).data.person.photo_url, null);
    pendingId = (await pg.query("select id from images where status='pending' order by created_at desc limit 1")).rows[0].id;
    assert.equal((await call(image, { query: { id: pendingId } })).status, 404);
  });
  test('only the administrator or an elder can see and review the queue', async () => {
    assert.equal((await call(photos, {})).status, 401);
    assert.equal((await call(photos, { token: '22222' })).status, 403);
    const q = await call(photos, { admin: true });
    assert.equal(q.data.pending.length, 1); assert.equal(q.data.pending[0].submitter, 'Cousin Efua');
    assert.equal((await call(image, { query: { id: pendingId }, admin: true })).status, 200);
    assert.equal((await call(image, { query: { id: pendingId }, token: '11111' })).status, 200);
  });
  test('rejecting deletes it; approving sets the profile photo and is logged', async () => {
    assert.equal((await call(photos, { method: 'POST', admin: true, body: { id: pendingId, action: 'reject' } })).status, 200);
    assert.equal((await pg.query("select count(*)::int n from images where id=$1", [pendingId])).rows[0].n, 0);
    await offer(); const id2 = (await pg.query("select id from images where status='pending'")).rows[0].id;
    const ok = await call(photos, { method: 'POST', token: '11111', body: { id: id2, action: 'approve' } });
    assert.equal(ok.status, 200);
    assert.equal((await call(person, { query: { id: ama } })).data.person.photo_url, `/api/image?id=${id2}`);
    assert.equal((await call(image, { query: { id: id2 } })).status, 200);
    assert.equal((await call(photos, { method: 'POST', admin: true, body: { id: id2, action: 'approve' } })).status, 404);
  });
  test('fakes, oversize, invalid people and floods are refused', async () => {
    assert.equal((await offer({ data: Buffer.from('not an image at all, honest').toString('base64') })).status, 415);
    assert.equal((await offer({ data: Buffer.concat([JPG, Buffer.alloc(1.6 * 1024 * 1024)]).toString('base64') })).status, 413);
    assert.equal((await offer({ ref_id: '00000000-0000-4000-8000-000000000000' })).status, 404);
    assert.equal((await call(image, { method: 'POST', token: 'ZZZZZZZZ', body: { kind: 'person', ref_id: ama, content_type: 'image/jpeg', data: JPG.toString('base64') } })).status, 401);
    for (let i = 0; i < 3; i += 1) assert.equal((await offer()).status, 202);
    assert.equal((await offer()).status, 429);
    await pg.query("delete from images where status='pending'");
  });
});

describe('scheduled backups', () => {
  test('weekly snapshot is stored, listed and downloadable, and not repeated within days', async () => {
    assert.equal(await (await weeklyBackup()).text(), 'backup stored');
    assert.equal(await (await weeklyBackup()).text(), 'backup skipped: taken recently');
    const list = await call(backup, { admin: true, query: { list: '1' } });
    assert.equal(list.data.snapshots.length, 1);
    const dl = await call(backup, { admin: true, query: { snapshot: list.data.snapshots[0].id } });
    const json = JSON.parse(dl.raw.body);
    assert.equal(json.format, 'family-heritage-backup/1'); assert.ok(json.people.length > 10);
    assert.equal((await call(backup, { query: { list: '1' } })).status, 403);
    assert.ok(zlib.gzipSync(Buffer.from('x')).length > 0);
  });
});
