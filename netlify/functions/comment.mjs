import { getDb, json, NO_DB, parseBody, clean, cleanMultiline, clientIp } from './_db.mjs';

// Anyone can comment. Every comment waits for administrator approval before it appears.
export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
  if (b.website) return json(201, { ok: true, message: 'Thank you. Your comment has been submitted and is awaiting moderation.' }); // honeypot
  const name = clean(b.author_name, 80);
  const body = cleanMultiline(b.body, 2000);
  if (!name) return json(422, { error: 'Please enter your name.' });
  if (!body) return json(422, { error: 'Please write a comment before submitting.' });
  const key = `comment:${clientIp(event)}`;
  const recent = await pool.query("select count(*)::int as n from token_attempts where ip=$1 and attempted_at > now()-interval '10 minutes'", [key]);
  if (recent.rows[0].n >= 5) return json(429, { error: 'You are commenting quite quickly. Please wait a few minutes and try again.' });
  const a = await pool.query("select id from articles where slug='asankran-history'");
  if (!a.rows[0]) return json(404, { error: 'Comments are not available yet.' });
  await pool.query('insert into comments(article_id,author_name,body) values($1,$2,$3)', [a.rows[0].id, name, body]);
  await pool.query('insert into token_attempts(ip) values($1)', [key]);
  return json(201, { ok: true, message: 'Thank you. Your comment has been submitted and is awaiting moderation.' });
}
