import { getDb, json, NO_DB, appOnly } from './_db.mjs';

export async function handler(event) {
  const blocked = appOnly(event); if (blocked) return blocked;
  const pool = await getDb(); if (!pool) return NO_DB();
  const a = await pool.query("select id,slug,title,body,source_note,updated_at from articles where slug='asankran-history'");
  if (!a.rows[0]) return json(200, { article: null, comments: [] });
  const c = await pool.query("select id,author_name,body,created_at from comments where article_id=$1 and status='approved' order by created_at asc", [a.rows[0].id]);
  return json(200, { article: a.rows[0], comments: c.rows });
}
