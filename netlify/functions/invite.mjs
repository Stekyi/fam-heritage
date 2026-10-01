import { getDb, json, NO_DB, parseBody, isUuid, audit, readLimit, hmacToken, newStrongToken, appOnly, PERSON_SELECT } from '../lib/db.mjs';
import { redactPerson } from '../lib/people.mjs';
import { notifyAdmin } from '../lib/mail.mjs';
import { INVITE_RE, normCode, inviteHash } from '../lib/invites.mjs';

const INVALID = () => json(404, { error: 'This invitation is not valid, has expired, or has already been used.' });
const fullName = (p) => [p?.given_name, p?.surname].filter(Boolean).join(' ');

async function findInvite(pool, code) {
  if (!INVITE_RE.test(normCode(code))) return null;
  const r = await pool.query(
    `select * from invites where code_hash=$1 and used_at is null and not revoked and expires_at > now()`, [inviteHash(code)]);
  return r.rows[0] || null;
}

// Public: look at an invitation, then redeem it once to receive a personal contributor token.
export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  const limited = await readLimit(event, pool, 'join'); if (limited) return limited;

  if (event.httpMethod === 'GET') {
    const blocked = appOnly(event); if (blocked) return blocked;
    const inv = await findInvite(pool, event.queryStringParameters?.code);
    if (!inv) return INVALID();
    let person = null;
    if (inv.person_id) {
      const p = await pool.query(`select ${PERSON_SELECT} from people where id=$1`, [inv.person_id]);
      const linked = await pool.query('select 1 from token_person_links where person_id=$1', [inv.person_id]);
      if (linked.rows[0]) return json(409, { error: 'This family member has already joined.' });
      person = p.rows[0] ? redactPerson(p.rows[0], false) : null;
    }
    return json(200, { valid: true, label: inv.label, person, expires_at: inv.expires_at });
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
  const inv = await findInvite(pool, b.code);
  if (!inv) return INVALID();

  // Claim first so two people cannot redeem the same invitation at once.
  const claim = await pool.query('update invites set used_at=now() where id=$1 and used_at is null and not revoked and expires_at > now() returning id', [inv.id]);
  if (!claim.rows[0]) return INVALID();
  const release = () => pool.query('update invites set used_at=null, token_id=null where id=$1', [inv.id]).catch(() => {});

  const personId = inv.person_id || b.person_id;
  if (!isUuid(personId)) { await release(); return json(422, { error: 'Please select your name in the family tree.' }); }
  const person = await pool.query(`select ${PERSON_SELECT} from people where id=$1 and kind='person'`, [personId]);
  if (!person.rows[0]) { await release(); return json(404, { error: 'That family member could not be found.' }); }
  const taken = await pool.query('select 1 from token_person_links where person_id=$1', [personId]);
  if (taken.rows[0]) { await release(); return json(409, { error: 'That family member has already joined. Please ask the administrator for help.' }); }

  let token; let tokenId;
  for (let i = 0; i < 20 && !tokenId; i++) {
    token = newStrongToken();
    const ins = await pool.query('insert into access_tokens(token_hash,label) values($1,$2) on conflict (token_hash) do nothing returning id',
      [hmacToken(token), inv.label || fullName(person.rows[0])]);
    tokenId = ins.rows[0]?.id;
  }
  if (!tokenId) { await release(); return json(500, { error: 'Could not create your token. Please try again.' }); }
  try {
    await pool.query('insert into token_person_links(token_id,person_id) values($1,$2)', [tokenId, personId]);
  } catch {
    await pool.query('delete from access_tokens where id=$1', [tokenId]).catch(() => {});
    await release();
    return json(409, { error: 'That family member has already joined. Please ask the administrator for help.' });
  }
  await pool.query('update invites set token_id=$1 where id=$2', [tokenId, inv.id]);
  await audit(pool, 'invite_redeemed', 'person', personId, { invite: inv.id }, fullName(person.rows[0]));
  await notifyAdmin(pool, `${fullName(person.rows[0])} joined the family archive`, {
    heading: 'A family member joined', lines: [`${fullName(person.rows[0])} used their invitation and now has a contributor token.`], link: undefined,
  });
  return json(201, { token, person: redactPerson(person.rows[0], true) });
}
