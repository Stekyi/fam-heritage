import { getDb, json, NO_DB, parseBody, requireToken, requireAdmin, header, readLimit, clean, NEED_TOKEN, NEED_LINK, isUuid, audit, PERSON_SELECT } from '../lib/db.mjs';
import { notifyAdmin, siteUrl } from '../lib/mail.mjs';
import { recordRevision } from '../lib/people.mjs';

const MAX_BYTES = 1.5 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_UNATTACHED_PER_TOKEN = 20;
const KEEP_PERSON_IMAGES = 4;
const PENDING_PER_PERSON = 3;
const PENDING_TOTAL = 150;

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export async function canReview(event, pool) {
  if (header(event, 'x-admin-secret')) return requireAdmin(event, pool);
  const t = header(event, 'x-family-token') ? await requireToken(event, pool) : null;
  return !!(t && t.role === 'elder');
}

// Anyone can offer a photo. It stays hidden until an administrator or elder approves it.
async function publicSubmission(event, pool) {
  const limited = await readLimit(event, pool, 'photo'); if (limited) return limited;
  const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
  if (!isUuid(b.ref_id)) return json(400, { error: 'Please select a family member for this photo.' });
  if (!TYPES[b.content_type]) return json(415, { error: 'Please choose a JPEG, PNG or WebP image.' });
  const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length) return json(400, { error: 'The image appears to be empty.' });
  if (buf.length > MAX_BYTES) return json(413, { error: 'That image is too large. Please choose one under 1.5 MB.' });
  if (sniff(buf) !== b.content_type) return json(415, { error: 'That file is not a valid image of the selected type.' });
  const person = await pool.query("select given_name,surname from people where id=$1 and kind='person'", [b.ref_id]);
  if (!person.rows[0]) return json(404, { error: 'This family member could not be found.' });
  // Abandoned requests expire after 30 days.
  await pool.query("delete from images where status='pending' and created_at < now()-interval '30 days'");
  const [n, total] = await Promise.all([
    pool.query("select count(*)::int as n from images where status='pending' and kind='person' and ref_id=$1", [b.ref_id]),
    pool.query("select count(*)::int as n from images where status='pending'"),
  ]);
  if (n.rows[0].n >= PENDING_PER_PERSON) return json(429, { error: 'There are already photos waiting for this person. Please try again after they have been reviewed.' });
  if (total.rows[0].n >= PENDING_TOTAL) return json(429, { error: 'Too many photos are waiting for review right now. Please try again later.' });
  const submitter = clean(b.submitter, 80) || null;
  const ins = await pool.query("insert into images(kind,ref_id,content_type,size_bytes,data,status,submitter) values('person',$1,$2,$3,$4,'pending',$5) returning id", [b.ref_id, b.content_type, buf.length, buf, submitter]);
  await audit(pool, 'photo_submitted', 'person', b.ref_id, { image: ins.rows[0].id }, submitter || 'visitor');
  const nm = [person.rows[0].given_name, person.rows[0].surname].filter(Boolean).join(' ');
  await notifyAdmin(pool, 'A photo is waiting for approval', { heading: 'New photo to review', lines: [`${submitter || 'A visitor'} offered a photo for ${nm}. It will not show until you approve it.`], link: `${siteUrl()}/#/admin`, linkText: 'Review photos' }).catch(() => {});
  return json(202, { pending: true });
}

export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  const q = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    if (!isUuid(q.id)) return json(404, { error: 'Image not found.' });
    const r = await pool.query('select content_type,data,status from images where id=$1', [q.id]);
    if (!r.rows[0]) return json(404, { error: 'Image not found.' });
    // A photo waiting for approval is only visible to the people who approve it.
    if (r.rows[0].status === 'pending' && !(await canReview(event, pool))) return json(404, { error: 'Image not found.' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': r.rows[0].content_type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' },
      body: Buffer.from(r.rows[0].data).toString('base64'),
      isBase64Encoded: true,
    };
  }

  if (event.httpMethod === 'POST') {
    const hasToken = !!header(event, 'x-family-token');
    if (!hasToken) return publicSubmission(event, pool);
    const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
    const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
    const kind = b.kind === 'story' ? 'story' : 'person';
    if (kind === 'story' && !token.person_id) return NEED_LINK();
    if (kind === 'person' && !isUuid(b.ref_id)) return json(400, { error: 'Please select a family member for this photo.' });
    if (!TYPES[b.content_type]) return json(415, { error: 'Please choose a JPEG, PNG or WebP image.' });
    const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64');
    if (!buf.length) return json(400, { error: 'The image appears to be empty.' });
    if (buf.length > MAX_BYTES) return json(413, { error: 'That image is too large. Please choose one under 1.5 MB.' });
    if (sniff(buf) !== b.content_type) return json(415, { error: 'That file is not a valid image of the selected type.' });

    if (kind === 'person') {
      const cur = await pool.query(`select ${PERSON_SELECT} from people where id=$1`, [b.ref_id]);
      if (!cur.rows[0]) return json(404, { error: 'This family member could not be found.' });
      const ins = await pool.query("insert into images(kind,ref_id,content_type,size_bytes,data,token_id) values('person',$1,$2,$3,$4,$5) returning id", [b.ref_id, b.content_type, buf.length, buf, token.id]);
      const url = `/api/image?id=${ins.rows[0].id}`;
      await recordRevision(pool, b.ref_id, cur.rows[0], { photo_url: url }, { label: token.label, action: 'photo' });
      await pool.query('update people set photo_url=$1, updated_by=$2, updated_at=now() where id=$3', [url, token.label || 'contributor', b.ref_id]);
      // keep a few earlier photos so an administrator can restore one; drop the rest
      await pool.query(
        `delete from images where kind='person' and status='approved' and ref_id=$1 and id not in (select id from images where kind='person' and status='approved' and ref_id=$1 order by created_at desc limit ${KEEP_PERSON_IMAGES})`, [b.ref_id]);
      await audit(pool, 'person_photo', 'person', b.ref_id, { bytes: buf.length }, token.label);
      return json(201, { id: ins.rows[0].id, url });
    }

    // Story cover images: purge abandoned uploads, then cap what one token can leave unattached.
    await pool.query(
      `delete from images where kind='story' and created_at < now()-interval '24 hours'
         and not exists (select 1 from stories s where s.cover_image_id = images.id)`);
    const pending = await pool.query(
      `select count(*)::int as n from images i where i.kind='story' and i.token_id=$1
         and not exists (select 1 from stories s where s.cover_image_id = i.id)`, [token.id]);
    if (pending.rows[0].n >= MAX_UNATTACHED_PER_TOKEN) return json(429, { error: 'You have too many unused uploads. Please publish or discard them first.' });
    const ins = await pool.query("insert into images(kind,ref_id,content_type,size_bytes,data,token_id) values('story',null,$1,$2,$3,$4) returning id", [b.content_type, buf.length, buf, token.id]);
    return json(201, { id: ins.rows[0].id, url: `/api/image?id=${ins.rows[0].id}` });
  }

  if (event.httpMethod === 'DELETE') {
    const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
    if (!isUuid(q.person_id)) return json(400, { error: 'Please select a family member.' });
    const cur = await pool.query(`select ${PERSON_SELECT} from people where id=$1`, [q.person_id]);
    if (!cur.rows[0]) return json(404, { error: 'This family member could not be found.' });
    await recordRevision(pool, q.person_id, cur.rows[0], { photo_url: null }, { label: token.label, action: 'photo' });
    await pool.query('update people set photo_url=null, updated_by=$1, updated_at=now() where id=$2', [token.label || 'contributor', q.person_id]);
    await audit(pool, 'person_photo_removed', 'person', q.person_id, null, token.label);
    return json(200, { ok: true });
  }
  return json(405, { error: 'Method not allowed' });
}
