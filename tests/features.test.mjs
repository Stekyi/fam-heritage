import { test, before, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, makeToken, call, relationshipSnapshot } from './helpers.mjs';
import { handler as tree } from '../netlify/functions/tree.mjs';
import { handler as person } from '../netlify/functions/person.mjs';
import { handler as me } from '../netlify/functions/me.mjs';
import { handler as admin } from '../netlify/functions/admin.mjs';
import { handler as invite } from '../netlify/functions/invite.mjs';
import { handler as proposals } from '../netlify/functions/proposals.mjs';
import { handler as comment } from '../netlify/functions/comment.mjs';
import { handler as celebrations } from '../netlify/functions/celebrations.mjs';
import { handler as backup } from '../netlify/functions/backup.mjs';
import digest from '../netlify/functions/digest.mjs';
import { setMailTransport, renderMail, notifyAdmin } from '../netlify/lib/mail.mjs';
import { nextOccurrence, computeCelebrations, buildDigest } from '../netlify/lib/celebrations.mjs';
import { toGedcom } from '../netlify/lib/gedcom.mjs';
import { wouldCreateCycle } from '../netlify/lib/graph.mjs';
import { INVITE_RE, newInviteCode } from '../netlify/lib/invites.mjs';

let pg; let baseline; let ama; let isaac; let matthew; let helena; let maame;
const A = '11111'; const B = '22222';
let mails = [];

const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(5, 10);
const mkInviteRaw = (body) => call(admin, { method: 'POST', admin: true, body: { kind: 'invite_create', ...body } });
const mkInvite = async (body = {}) => (await mkInviteRaw(body)).data;
const nameId = async (n) => (await pg.query("select id from people where given_name||' '||coalesce(surname,'')=$1", [n])).rows[0].id;
const strip = (s) => JSON.stringify(JSON.parse(s).map(({ from_person_id, to_person_id, relationship_type }) => [from_person_id, to_person_id, relationship_type]).sort());

before(async () => {
  process.env.ADMIN_EMAIL = 'admin@example.org';
  pg = await freshDatabase();
  await makeToken(pg, A, 'Token A'); await makeToken(pg, B, 'Token B');
  baseline = await relationshipSnapshot(pg);
  ama = (await pg.query("select id from people where 'Nana Mansa'=any(aliases)")).rows[0].id;
  isaac = (await pg.query("select id from people where 'Kofi Gyima'=any(aliases)")).rows[0].id;
  matthew = await nameId('Matthew Obiri-Yeboah');
  helena = await nameId('Helena Baidoo');
  maame = await nameId('Maame Ansaba');
  assert.equal((await call(me, { method: 'POST', token: A, body: { person_id: isaac } })).status, 201);
  assert.equal((await call(me, { method: 'POST', token: B, body: { person_id: ama } })).status, 201);
});
beforeEach(() => { mails = []; setMailTransport(async (m) => { mails.push(m); }); });

describe('invitations', () => {
  test('codes are long, unambiguous and stored only as a hash', async () => {
    assert.match(newInviteCode(), INVITE_RE);
    const inv = await mkInvite({ person_id: matthew, label: 'Matthew' });
    assert.match(inv.code, INVITE_RE);
    const rows = (await pg.query('select * from invites')).rows;
    assert.ok(!JSON.stringify(rows).includes(inv.code));
    assert.equal(rows[0].code_hash.length, 64);
  });
  test('only the administrator can create or revoke invitations', async () => {
    assert.equal((await call(admin, { method: 'POST', token: A, body: { kind: 'invite_create' } })).status, 403);
    assert.equal((await call(admin, { method: 'POST', body: { kind: 'invite_create' } })).status, 403);
  });
  test('previewing an invitation is public and reveals only what the person needs', async () => {
    const inv = await mkInvite({ person_id: matthew, label: 'Cousin M' });
    const r = await call(invite, { query: { code: inv.code } });
    assert.equal(r.status, 200); assert.equal(r.data.person.id, matthew); assert.equal(r.data.person.location, null);
    for (const bad of ['', 'ABC', 'AAAAAAAAAAAAAAAA', inv.code.slice(0, 15), `${inv.code}X`]) assert.equal((await call(invite, { query: { code: bad } })).status, 404, bad);
    assert.equal((await call(invite, { query: { code: inv.code.toLowerCase() } })).status, 200, 'codes are case-insensitive');
  });
  test('redeeming creates a personal token, links the person, and works exactly once', async () => {
    const inv = await mkInvite({ person_id: matthew, label: 'Matthew' });
    const r = await call(invite, { method: 'POST', body: { code: inv.code } });
    assert.equal(r.status, 201);
    assert.match(r.data.token, /^[A-HJ-NP-Z][A-HJ-NP-Z2-9]{7}$/);
    const who = await call(me, { token: r.data.token });
    assert.equal(who.status, 200); assert.equal(who.data.linked_person.id, matthew);
    assert.equal((await call(invite, { method: 'POST', body: { code: inv.code } })).status, 404);
    assert.equal((await call(invite, { query: { code: inv.code } })).status, 404);
    assert.equal(mails.length, 1); assert.match(mails[0].subject, /joined/);
  });
  test('an open invitation needs a person, survives a mistake, and cannot take someone already linked', async () => {
    const inv = await mkInvite({ label: 'Open' });
    assert.equal((await call(invite, { method: 'POST', body: { code: inv.code } })).status, 422);
    assert.equal((await call(invite, { method: 'POST', body: { code: inv.code, person_id: isaac } })).status, 409);
    assert.equal((await call(invite, { query: { code: inv.code } })).status, 200, 'still usable after the mistakes');
    const ok = await call(invite, { method: 'POST', body: { code: inv.code, person_id: helena } });
    assert.equal(ok.status, 201);
    assert.equal((await pg.query('select count(*)::int n from token_person_links where person_id=$1', [helena])).rows[0].n, 1);
  });
  test('two people racing for one invitation get exactly one token', async () => {
    const inv = await mkInvite({});
    const other = await nameId('Isaac Baidoo');
    const [x, y] = await Promise.all([
      call(invite, { method: 'POST', body: { code: inv.code, person_id: maame } }),
      call(invite, { method: 'POST', body: { code: inv.code, person_id: other } }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [201, 404]);
  });
  test('revoked and expired invitations stop working; invalid designations are refused', async () => {
    const a = await mkInvite({}); const b = await mkInvite({});
    const list = (await call(admin, { admin: true })).data.invites;
    assert.ok(list.every((i) => ['open', 'used', 'revoked', 'expired'].includes(i.status)));
    const target = list.find((i) => i.status === 'open');
    assert.equal((await call(admin, { method: 'POST', admin: true, body: { kind: 'invite_revoke', id: target.id } })).status, 200);
    await pg.query("update invites set expires_at = now() - interval '1 hour' where used_at is null and not revoked");
    assert.equal((await call(invite, { query: { code: a.code } })).status, 404);
    assert.equal((await call(invite, { query: { code: b.code } })).status, 404);
    assert.equal((await mkInviteRaw({ person_id: ama })).status, 409, 'cannot invite someone who already has a token');
    assert.equal((await mkInviteRaw({ person_id: '00000000-0000-4000-8000-000000000000' })).status, 404);
    assert.equal((await mkInviteRaw({ person_id: 'nope' })).status, 400);
  });
  test('guessing codes is rate limited', async () => {
    let last;
    for (let i = 0; i < 34; i++) last = await call(invite, { query: { code: newInviteCode() }, ip: '12.12.12.12' });
    assert.equal(last.status, 429);
  });
});

describe('administrator email alerts', () => {
  test('a new comment emails the administrator, with the content safely escaped', async () => {
    const r = await call(comment, { method: 'POST', body: { author_name: 'Visitor <b>', body: 'Hello <script>alert(1)</script>' } });
    assert.equal(r.status, 201);
    assert.equal(mails.length, 1);
    assert.deepEqual(mails[0].to, ['admin@example.org']);
    assert.ok(!mails[0].html.includes('<script>')); assert.ok(mails[0].html.includes('&lt;script&gt;'));
  });
  test('a tree suggestion emails the administrator', async () => {
    const r = await call(proposals, { method: 'POST', token: A, body: { action: 'add_person', payload: { given_name: 'Newborn', parent_id: ama, relationship_kind: 'child' } } });
    assert.equal(r.status, 201); assert.equal(mails.length, 1); assert.match(mails[0].subject, /suggestion/i);
  });
  test('a failing mail service never breaks the site', async () => {
    setMailTransport(async () => { throw new Error('mail down'); });
    assert.equal((await call(comment, { method: 'POST', body: { author_name: 'Ok', body: 'Still works' } })).status, 201);
  });
  test('without configuration nothing is attempted', async () => {
    setMailTransport(null);
    const keep = process.env.ADMIN_EMAIL; delete process.env.ADMIN_EMAIL; delete process.env.RESEND_API_KEY;
    try { assert.equal(await notifyAdmin(pg, 'x', { heading: 'x' }), false); } finally { process.env.ADMIN_EMAIL = keep; }
  });
  test('alerts are capped per hour so a spam wave cannot flood the inbox', async () => {
    await pg.query("delete from token_attempts where ip='mail:admin'");
    for (let i = 0; i < 30; i++) await notifyAdmin(pg, `n${i}`, { heading: 'h' });
    assert.equal(mails.length, 20);
  });
  test('the email template escapes everything', () => {
    const html = renderMail({ heading: '<h1>', lines: ['a & b'], link: 'https://x.test/?a="1"' });
    assert.ok(!html.includes('<h1>')); assert.ok(html.includes('a &amp; b')); assert.ok(html.includes('&quot;1&quot;'));
  });
});

describe('suggesting family-link corrections', () => {
  let rel; let relCount;
  test('relationships in the tree carry ids so a specific link can be named', async () => {
    const t = (await call(tree)).data;
    assert.ok(t.relationships.every((r) => r.id));
    relCount = t.relationships.length;
    rel = t.relationships.find((r) => r.relationship_type === 'parent' && r.from_person_id === helena && r.to_person_id === maame);
    assert.ok(rel);
  });
  test('suggestions need a token, a real link and a reason, and cannot be duplicated', async () => {
    const body = { action: 'delete_relationship', payload: { relationship_id: rel.id, reason: 'Wrong mother' } };
    assert.equal((await call(proposals, { method: 'POST', body })).status, 401);
    assert.equal((await call(proposals, { method: 'POST', token: A, body: { ...body, payload: { relationship_id: rel.id, reason: 'x' } } })).status, 422);
    assert.equal((await call(proposals, { method: 'POST', token: A, body: { ...body, payload: { relationship_id: 'nope', reason: 'Wrong mother' } } })).status, 422);
    assert.equal((await call(proposals, { method: 'POST', token: A, body: { ...body, payload: { relationship_id: '00000000-0000-4000-8000-000000000000', reason: 'Wrong mother' } } })).status, 404);
    assert.equal((await call(proposals, { method: 'POST', token: A, body })).status, 201);
    assert.equal((await call(proposals, { method: 'POST', token: B, body })).status, 409);
    assert.equal(await relationshipSnapshot(pg), baseline, 'nothing changes until approval');
  });
  test('the administrator sees a plain-language description, and approval removes exactly that link', async () => {
    const ov = (await call(admin, { admin: true })).data;
    const pr = ov.proposals.find((x) => x.action === 'delete_relationship');
    assert.match(pr.summary, /Remove the link: Helena Baidoo is a parent of Maame Ansaba \(reason: Wrong mother\)/);
    assert.ok(ov.proposals.find((x) => x.action === 'add_person').summary.includes('Newborn'));
    assert.equal((await call(admin, { method: 'POST', admin: true, body: { kind: 'proposal', id: pr.id, status: 'approved' } })).status, 200);
    const t = (await call(tree)).data;
    assert.equal(t.relationships.length, relCount - 1);
    assert.ok(!t.relationships.some((r) => r.id === rel.id));
    const log = (await pg.query("select details from audit_log where action='relationship_removed'")).rows[0].details;
    assert.equal(log.relationship.id, rel.id); assert.equal(log.reason, 'Wrong mother');
  });
  test('a removed link can be put back with an "add link" suggestion, restoring the exact structure', async () => {
    const add = await call(proposals, { method: 'POST', token: A, body: { action: 'add_relationship', payload: { from_person_id: helena, to_person_id: maame, relationship_type: 'parent' } } });
    assert.equal(add.status, 201);
    const pr = (await call(admin, { admin: true })).data.proposals.find((x) => x.id === add.data.id);
    assert.match(pr.summary, /Link Helena Baidoo as a parent of Maame Ansaba/);
    assert.equal((await call(admin, { method: 'POST', admin: true, body: { kind: 'proposal', id: pr.id, status: 'approved' } })).status, 200);
    assert.equal(strip(await relationshipSnapshot(pg)), strip(baseline));
  });
  test('impossible or redundant links are refused when suggested and when approved', async () => {
    const link = (f, t, type = 'parent') => call(proposals, { method: 'POST', token: A, body: { action: 'add_relationship', payload: { from_person_id: f, to_person_id: t, relationship_type: type } } });
    assert.equal((await link(maame, helena)).status, 422, 'a child cannot be their own ancestor');
    assert.equal((await link(maame, ama)).status, 422, 'nor a distant descendant');
    assert.equal((await link(helena, helena)).status, 422);
    assert.equal((await link(helena, maame)).status, 409, 'already in the tree');
    assert.equal((await link(helena, '00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal(await wouldCreateCycle(pg, maame, helena), true);
    assert.equal(await wouldCreateCycle(pg, helena, maame), false);
    assert.equal(await wouldCreateCycle(pg, maame, ama), true);
    const bad = await pg.query("insert into proposals(action,payload,token_label) values('add_relationship',$1,'x') returning id", [JSON.stringify({ from_person_id: maame, to_person_id: ama, relationship_type: 'parent' })]);
    assert.equal((await call(admin, { method: 'POST', admin: true, body: { kind: 'proposal', id: bad.rows[0].id, status: 'approved' } })).status, 422);
  });
});

describe('birthdays and remembrance', () => {
  test('exact dates are only shown to contributors; remembrance of the deceased is public', async () => {
    const [bm, bd] = iso(3).split('-'); const [dm, dd] = iso(5).split('-'); const [fm, fd] = iso(40).split('-');
    assert.equal((await call(person, { method: 'PATCH', query: { id: matthew }, token: A, body: { birth: `1992-${bm}-${bd}`, living_status: 'living' } })).status, 200);
    assert.equal((await call(person, { method: 'PATCH', query: { id: helena }, token: A, body: { death: `2000-${dm}-${dd}` } })).status, 200);
    assert.equal((await call(person, { method: 'PATCH', query: { id: maame }, token: A, body: { birth: `1992-${fm}-${fd}`, living_status: 'living' } })).status, 200);
    const pub = (await call(celebrations)).data;
    assert.equal(pub.viewer, 'public'); assert.equal(pub.birthdays, null);
    assert.ok(pub.remembrances.some((r) => r.name === 'Helena Baidoo' && r.days === 5 && r.years > 20));
    const con = (await call(celebrations, { token: A })).data;
    const b = con.birthdays.find((x) => x.name === 'Matthew Obiri-Yeboah');
    assert.ok(b && b.days === 3 && b.turning >= 33);
    assert.ok(!con.birthdays.some((x) => x.name === 'Maame Ansaba'), 'outside the 30-day window');
    assert.ok((await call(celebrations, { token: A, query: { days: '60' } })).data.birthdays.some((x) => x.name === 'Maame Ansaba'));
  });
  test('date arithmetic handles year end and 29 February', () => {
    assert.equal(nextOccurrence('2000-02-29', new Date('2027-01-10T12:00:00Z')).days, 50);
    assert.equal(nextOccurrence('1990-01-02', new Date('2026-12-30T08:00:00Z')).days, 3);
    assert.equal(nextOccurrence('1990-12-30', new Date('2026-12-30T23:59:00Z')).days, 0);
    assert.equal(nextOccurrence('', new Date()), null);
  });
  test('placeholders and people without full dates never appear', () => {
    const today = new Date('2026-06-01T00:00:00Z');
    const out = computeCelebrations([
      { id: 'a', given_name: 'A', birth_date: '1990-06-02', birth_year: 1990, kind: 'person' },
      { id: 'b', given_name: 'Unknown', birth_date: '1990-06-02', kind: 'placeholder' },
      { id: 'c', given_name: 'C', birth_year: 1990, kind: 'person' },
    ], { today, includeBirthdays: true });
    assert.deepEqual(out.birthdays.map((x) => x.name), ['A']);
  });
});

describe('weekly digest', () => {
  test('summarises what is waiting and what is coming up', async () => {
    const d = await buildDigest(pg);
    const text = d.lines.join(' ');
    assert.match(text, /Waiting for you: \d+ tree suggestion/);
    assert.match(text, /Last 7 days: \d+ edits?/);
    assert.match(text, /Birthdays this week: Matthew Obiri-Yeboah \(in 3 days\)/);
    assert.match(text, /Remembering: Helena Baidoo \(in 5 days\)/);
  });
  test('the scheduled function emails once, then skips for a few days; unconfigured it does nothing', async () => {
    await pg.query("delete from audit_log where action='digest_sent'");
    const r1 = await digest(new Request('http://x/'));
    assert.equal(await r1.text(), 'digest sent'); assert.equal(mails.length, 1); assert.match(mails[0].subject, /weekly digest/);
    assert.equal(await (await digest(new Request('http://x/'))).text(), 'digest skipped: sent recently'); assert.equal(mails.length, 1);
    setMailTransport(null); const keep = process.env.ADMIN_EMAIL; delete process.env.ADMIN_EMAIL;
    try { assert.match(await (await digest(new Request('http://x/'))).text(), /not configured/); } finally { process.env.ADMIN_EMAIL = keep; }
  });
});

describe('administrator backup', () => {
  test('is closed to everyone but the administrator', async () => {
    assert.equal((await call(backup)).status, 403);
    assert.equal((await call(backup, { token: A })).status, 403);
    assert.equal((await call(backup, { admin: 'wrong' })).status, 403);
    assert.equal((await call(backup, { admin: true, method: 'POST' })).status, 405);
  });
  test('the JSON backup is complete, downloadable, and never contains raw tokens or secrets', async () => {
    const r = await call(backup, { admin: true });
    assert.equal(r.status, 200); assert.match(r.headers['Content-Disposition'], /^attachment; filename="family-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    const d = r.data;
    const count = async (t) => (await pg.query(`select count(*)::int n from ${t}`)).rows[0].n;
    for (const t of ['people', 'relationships', 'access_tokens', 'stories', 'person_revisions', 'invites', 'comments']) assert.equal(d.counts[t], await count(t), t);
    assert.ok(d.people.length > 250 && d.relationships.length > 250);
    const text = JSON.stringify(d);
    for (const secret of [A, B, 'test-admin-secret', 'test-pepper']) assert.ok(!text.includes(`"${secret}"`), `must not contain ${secret}`);
    assert.ok(d.access_tokens.every((t) => t.token_hash.length === 64));
    assert.ok(d.invites.every((i) => !('code_hash' in i)), 'invite hashes are not exported');
    assert.ok((await pg.query("select 1 from audit_log where action='backup_json'")).rows.length >= 1);
  });
  test('the GEDCOM export lists every person and reproduces every parent-child link', async () => {
    const r = await call(backup, { admin: true, query: { format: 'gedcom' } });
    assert.equal(r.status, 200); assert.match(r.headers['Content-Disposition'], /\.ged"$/);
    const g = r.data;
    assert.ok(g.startsWith('0 HEAD')); assert.ok(g.trimEnd().endsWith('0 TRLR'));
    const real = (await pg.query("select count(*)::int n from people where kind <> 'place'")).rows[0].n;
    assert.equal((g.match(/^0 @I\d+@ INDI$/gm) || []).length, real);
    const indis = new Set([...g.matchAll(/^0 (@I\d+@) INDI$/gm)].map((m) => m[1]));
    const blocks = g.split(/^0 (?=@F)/m).slice(1);
    let pairs = 0;
    for (const b of blocks) {
      const parents = [...b.matchAll(/^1 (?:HUSB|WIFE) (@I\d+@)$/gm)].map((m) => m[1]);
      const kids = [...b.matchAll(/^1 CHIL (@I\d+@)$/gm)].map((m) => m[1]);
      for (const x of [...parents, ...kids]) assert.ok(indis.has(x), `${x} must be defined`);
      pairs += parents.length * kids.length;
    }
    const expected = (await pg.query(`select count(*)::int n from relationships r join people a on a.id=r.from_person_id join people b on b.id=r.to_person_id
                                        where r.relationship_type='parent' and a.kind<>'place' and b.kind<>'place'`)).rows[0].n;
    assert.equal(pairs, expected);
    assert.ok(g.includes('1 NAME Nana Mansa //') && g.includes('2 TYPE aka'));
  });
  test('GEDCOM handles unknown sexes, shared parents and escaping', () => {
    const people = [
      { id: 'a', given_name: 'A@', surname: 'X', sex: 'U', aliases: [] }, { id: 'b', given_name: 'B', surname: 'X', sex: 'U', aliases: [] },
      { id: 'c', given_name: 'C', surname: 'X', sex: 'F', aliases: [], birth_year: 1990, birth_date: '1990-03-04', birth_place: 'Accra' },
    ];
    const g = toGedcom(people, [
      { from_person_id: 'a', to_person_id: 'c', relationship_type: 'parent' }, { from_person_id: 'b', to_person_id: 'c', relationship_type: 'parent' },
      { from_person_id: 'a', to_person_id: 'b', relationship_type: 'spouse' },
    ], { now: new Date('2026-10-01T00:00:00Z') });
    assert.equal((g.match(/^0 @F\d+@ FAM$/gm) || []).length, 1, 'the couple and their child form one family');
    assert.ok(g.includes('1 HUSB') && g.includes('1 WIFE') && g.includes('1 CHIL'));
    assert.ok(g.includes('A@@') && g.includes('2 DATE 4 MAR 1990') && g.includes('2 PLAC Accra'));
  });
});

describe('integrity', () => {
  test('nothing in the new features touched the validated family structure', async () => {
    assert.equal(strip(await relationshipSnapshot(pg)), strip(baseline));
  });
});
