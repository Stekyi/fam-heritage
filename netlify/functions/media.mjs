import { getDb, json, NO_DB, parseBody, requireToken, requireAdmin, NEED_TOKEN, NEED_LINK, isUuid, clean, audit, appOnly } from '../lib/db.mjs';

// Voice and video memories attached to a family member. Stored in Postgres like photos, so they survive deploys.
const MAX_BYTES = 3.8 * 1024 * 1024; // base64 upload must fit inside the serverless request limit
const PER_PERSON = 20;
const PER_TOKEN_PER_DAY = 12;
const TYPES = { 'audio/webm': 'audio', 'audio/ogg': 'audio', 'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/wav': 'audio', 'audio/x-m4a': 'audio', 'video/webm': 'video', 'video/mp4': 'video' };

export function sniffMedia(b) {
  if (b.length < 12) return null;
  const head = b.subarray(0, 4).toString('latin1');
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ['audio/webm', 'video/webm']; // EBML
  if (head === 'OggS') return ['audio/ogg'];
  if (head === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') return ['audio/wav'];
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return ['audio/mp4', 'audio/x-m4a', 'video/mp4'];
  if (head.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return ['audio/mpeg'];
  return null;
}

export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  const q = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    if (q.all) {
      if (!(await requireAdmin(event, pool))) return json(403, { error: 'Administrator authentication required.' });
      const r = await pool.query("select m.id,m.kind,m.title,m.uploader_label,m.created_at, trim(coalesce(p.given_name,'')||' '||coalesce(p.surname,'')) as person_name from person_media m join people p on p.id=m.person_id order by m.created_at desc limit 100");
      return json(200, { media: r.rows.map((x) => ({ ...x, url: `/api/media?id=${x.id}` })) });
    }
    if (q.id) {
      if (!isUuid(q.id)) return json(404, { error: 'Not found.' });
      const r = await pool.query('select content_type,data,size_bytes from person_media where id=$1', [q.id]);
      const m = r.rows[0]; if (!m) return json(404, { error: 'Not found.' });
      const buf = Buffer.from(m.data); const total = buf.length;
      const h = { 'Content-Type': m.content_type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' };
      const range = /^bytes=(\d*)-(\d*)$/.exec((event.headers?.range || event.headers?.Range || '').trim());
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : total - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : total - 1;
        start = Math.max(0, start); end = Math.min(total - 1, end);
        if (start > end || start >= total) return { statusCode: 416, headers: { 'Content-Range': `bytes */${total}` }, body: '' };
        return { statusCode: 206, headers: { ...h, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) }, body: buf.subarray(start, end + 1).toString('base64'), isBase64Encoded: true };
      }
      return { statusCode: 200, headers: { ...h, 'Content-Length': String(total) }, body: buf.toString('base64'), isBase64Encoded: true };
    }
    const blocked = appOnly(event); if (blocked) return blocked;
    if (!isUuid(q.person_id)) return json(400, { error: 'Please select a family member.' });
    const r = await pool.query('select id,kind,title,content_type,size_bytes,uploader_label,created_at from person_media where person_id=$1 order by created_at desc', [q.person_id]);
    return json(200, { media: r.rows.map((m) => ({ ...m, url: `/api/media?id=${m.id}` })) });
  }

  if (event.httpMethod === 'POST') {
    const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
    if (!token.person_id) return NEED_LINK();
    const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
    if (!isUuid(b.person_id)) return json(422, { error: 'Please select a family member.' });
    const type = String(b.content_type || '').split(';')[0].trim().toLowerCase();
    if (!TYPES[type]) return json(415, { error: 'Please record or choose an audio or video file (WebM, MP4, M4A, MP3, OGG or WAV).' });
    const title = clean(b.title, 120); if (!title) return json(422, { error: 'Please give this memory a title.' });
    const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64');
    if (!buf.length) return json(400, { error: 'The recording appears to be empty.' });
    if (buf.length > MAX_BYTES) return json(413, { error: 'That recording is too large. Please keep it under about 3.5 MB (a few minutes of audio, or about 30 seconds of video).' });
    const ok = sniffMedia(buf);
    if (!ok || !ok.includes(type)) return json(415, { error: 'That file is not a valid recording of the selected type.' });
    const person = await pool.query('select 1 from people where id=$1', [b.person_id]);
    if (!person.rows[0]) return json(404, { error: 'This family member could not be found.' });
    const [n, d] = await Promise.all([
      pool.query('select count(*)::int as n from person_media where person_id=$1', [b.person_id]),
      pool.query("select count(*)::int as n from person_media where token_id=$1 and created_at > now()-interval '1 day'", [token.id]),
    ]);
    if (n.rows[0].n >= PER_PERSON) return json(429, { error: 'This family member already has the maximum number of memories.' });
    if (d.rows[0].n >= PER_TOKEN_PER_DAY) return json(429, { error: 'You have added many memories today. Please try again tomorrow.' });
    const ins = await pool.query('insert into person_media(person_id,token_id,uploader_label,kind,title,content_type,size_bytes,data) values($1,$2,$3,$4,$5,$6,$7,$8) returning id', [b.person_id, token.id, token.label, TYPES[type], title, type, buf.length, buf]);
    await audit(pool, 'add_media', 'person', b.person_id, { media: ins.rows[0].id, kind: TYPES[type] }, token.label);
    return json(201, { id: ins.rows[0].id, url: `/api/media?id=${ins.rows[0].id}` });
  }

  if (event.httpMethod === 'DELETE') {
    const id = q.id; if (!isUuid(id)) return json(400, { error: 'Invalid request.' });
    if (event.headers?.['x-admin-secret']) {
      if (!(await requireAdmin(event, pool))) return json(403, { error: 'Administrator authentication required.' });
    } else {
      const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
      const own = await pool.query('select 1 from person_media where id=$1 and token_id=$2', [id, token.id]);
      if (!own.rows[0]) return json(403, { error: 'You can only remove memories you added.' });
    }
    await pool.query('delete from person_media where id=$1', [id]);
    await audit(pool, 'remove_media', 'media', id, null, 'delete');
    return json(200, { ok: true });
  }
  return json(405, { error: 'Method not allowed' });
}
