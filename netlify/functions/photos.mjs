import { getDb, json, NO_DB, parseBody, requireToken, requireAdmin, header, isUuid, audit, PERSON_SELECT, NEED_TOKEN } from '../lib/db.mjs';
import { recordRevision } from '../lib/people.mjs';

const KEEP_PERSON_IMAGES = 4;

async function reviewer(event, pool) {
  if (header(event, 'x-admin-secret')) return (await requireAdmin(event, pool)) ? 'Administrator' : null;
  const t = header(event, 'x-family-token') ? await requireToken(event, pool) : null;
  return t && t.role === 'elder' ? (t.label || 'Elder') : null;
}

// Review queue for photos offered by visitors. Administrators and elders can approve or reject.
export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  const who = await reviewer(event, pool);
  if (!who) return header(event, 'x-family-token') && !header(event, 'x-admin-secret') ? json(403, { error: 'Only a family elder or the administrator can review photos.' }) : NEED_TOKEN();

  if (event.httpMethod === 'GET') {
    const r = await pool.query(`select i.id, i.ref_id as person_id, i.submitter, i.created_at, i.size_bytes,
        trim(coalesce(p.given_name,'')||' '||coalesce(p.surname,'')) as person_name, p.photo_url as current_photo
      from images i join people p on p.id=i.ref_id where i.status='pending' and i.kind='person' order by i.created_at asc limit 100`);
    return json(200, { pending: r.rows });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const b = parseBody(event); if (!b || !isUuid(b.id)) return json(400, { error: 'Invalid request.' });
  const img = (await pool.query("select id,ref_id from images where id=$1 and status='pending' and kind='person'", [b.id])).rows[0];
  if (!img) return json(404, { error: 'This photo has already been reviewed.' });

  if (b.action === 'reject') {
    await pool.query('delete from images where id=$1', [b.id]);
    await audit(pool, 'photo_rejected', 'person', img.ref_id, { image: b.id }, who);
    return json(200, { ok: true });
  }
  if (b.action !== 'approve') return json(400, { error: 'Invalid request.' });
  const cur = await pool.query(`select ${PERSON_SELECT} from people where id=$1`, [img.ref_id]);
  if (!cur.rows[0]) return json(404, { error: 'This family member could not be found.' });
  const url = `/api/image?id=${img.id}`;
  await pool.query("update images set status='approved' where id=$1", [img.id]);
  await recordRevision(pool, img.ref_id, cur.rows[0], { photo_url: url }, { label: who, action: 'photo' });
  await pool.query('update people set photo_url=$1, updated_by=$2, updated_at=now() where id=$3', [url, who, img.ref_id]);
  await pool.query(`delete from images where kind='person' and ref_id=$1 and status='approved' and id not in (select id from images where kind='person' and ref_id=$1 and status='approved' order by created_at desc limit ${KEEP_PERSON_IMAGES})`, [img.ref_id]);
  await audit(pool, 'photo_approved', 'person', img.ref_id, { image: img.id }, who);
  return json(200, { ok: true, url });
}
