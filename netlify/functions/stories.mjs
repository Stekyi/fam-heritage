import { getDb, json, NO_DB, parseBody, requireToken, NEED_TOKEN, NEED_LINK, isUuid, clean, cleanMultiline, audit, appOnly, pageParams } from '../lib/db.mjs';

const SELECT = `s.id, s.title, s.content, s.person_id, s.created_at, s.updated_at,
  trim(coalesce(p.given_name,'')||' '||coalesce(p.surname,'')) as author_name,
  case when s.cover_image_id is null then null else '/api/image?id='||s.cover_image_id end as cover_url,
  s.cover_image_id`;

async function dropImageIfUnused(pool, id) {
  await pool.query("delete from images where id=$1 and kind='story' and not exists (select 1 from stories s where s.cover_image_id=$1)", [id]);
}

export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  const q = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    const blocked = appOnly(event); if (blocked) return blocked;
    if (q.id) {
      if (!isUuid(q.id)) return json(404, { error: 'This story could not be found.' });
      const r = await pool.query(`select ${SELECT} from stories s join people p on p.id=s.person_id where s.id=$1 and s.status='published'`, [q.id]);
      if (!r.rows[0]) return json(404, { error: 'This story could not be found.' });
      return json(200, { story: r.rows[0] });
    }
    const { limit, offset, page } = pageParams(q, 12, 30);
    const where = ["s.status='published'"];
    const vals = [];
    if (q.person_id) { if (!isUuid(q.person_id)) return json(400, { error: 'Invalid family member.' }); vals.push(q.person_id); where.push(`s.person_id=$${vals.length}`); }
    const w = where.join(' and ');
    const [list, total] = await Promise.all([
      pool.query(`select s.id, s.title, left(s.content, 280) as excerpt, s.person_id, s.created_at,
          trim(coalesce(p.given_name,'')||' '||coalesce(p.surname,'')) as author_name,
          case when s.cover_image_id is null then null else '/api/image?id='||s.cover_image_id end as cover_url
        from stories s join people p on p.id=s.person_id where ${w} order by s.created_at desc limit ${limit} offset ${offset}`, vals),
      pool.query(`select count(*)::int as n from stories s where ${w}`, vals),
    ]);
    return json(200, { stories: list.rows, total: total.rows[0].n, page, limit });
  }

  const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
  if (!token.person_id) return NEED_LINK();

  if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
    const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
    const title = clean(b.title, 160);
    const content = cleanMultiline(b.content, 20000);
    if (!title) return json(422, { error: 'Please give your story a title.' });
    if (!content) return json(422, { error: 'Please write your story before publishing.' });
    let cover = null;
    if (b.cover_image_id) {
      if (!isUuid(b.cover_image_id)) return json(422, { error: 'The cover image is not valid.' });
      // The image must have been uploaded by this token and must not already belong to another story.
      const img = await pool.query(
        `select 1 from images i where i.id=$1 and i.kind='story' and i.token_id=$2
            and not exists (select 1 from stories s where s.cover_image_id=i.id and s.id is distinct from $3)`,
        [b.cover_image_id, token.id, isUuid(q.id) ? q.id : null]);
      if (!img.rows[0]) return json(422, { error: 'The cover image could not be found. Please upload it again.' });
      cover = b.cover_image_id;
    }
    if (event.httpMethod === 'POST') {
      const r = await pool.query('insert into stories(person_id,token_id,title,content,cover_image_id) values($1,$2,$3,$4,$5) returning id', [token.person_id, token.id, title, content, cover]);
      await audit(pool, 'create_story', 'story', r.rows[0].id, null, token.label);
      return json(201, { id: r.rows[0].id });
    }
    if (!isUuid(q.id)) return json(400, { error: 'Unable to identify this story.' });
    const own = await pool.query("select person_id, cover_image_id from stories where id=$1 and status='published'", [q.id]);
    if (!own.rows[0]) return json(404, { error: 'This story could not be found.' });
    if (own.rows[0].person_id !== token.person_id) return json(403, { error: 'You can only edit your own stories.' });
    const keepCover = b.cover_image_id === undefined;
    await pool.query(
      `update stories set title=$1, content=$2, cover_image_id=${keepCover ? 'cover_image_id' : '$4'}, updated_at=now() where id=$3`,
      keepCover ? [title, content, q.id] : [title, content, q.id, cover]);
    if (!keepCover && own.rows[0].cover_image_id && own.rows[0].cover_image_id !== cover) await dropImageIfUnused(pool, own.rows[0].cover_image_id);
    return json(200, { id: q.id });
  }

  if (event.httpMethod === 'DELETE') {
    if (!isUuid(q.id)) return json(400, { error: 'Unable to identify this story.' });
    const own = await pool.query('select person_id, cover_image_id from stories where id=$1', [q.id]);
    if (!own.rows[0]) return json(404, { error: 'This story could not be found.' });
    if (own.rows[0].person_id !== token.person_id) return json(403, { error: 'You can only delete your own stories.' });
    await pool.query('delete from stories where id=$1', [q.id]);
    if (own.rows[0].cover_image_id) await dropImageIfUnused(pool, own.rows[0].cover_image_id);
    await audit(pool, 'delete_story', 'story', q.id, null, token.label);
    return json(200, { ok: true });
  }
  return json(405, { error: 'Method not allowed' });
}
