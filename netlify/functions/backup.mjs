import { getDb, json, NO_DB, requireAdmin, audit, PERSON_SELECT } from '../lib/db.mjs';
import { toGedcom } from '../lib/gedcom.mjs';

// Administrator-only backup. JSON is complete (so the site can be rebuilt); GEDCOM is for other genealogy software.
// Images are listed but not embedded; they remain in the database (and in Neon point-in-time recovery).
export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  if (!(await requireAdmin(event, pool))) return json(403, { error: 'Administrator authentication required.' });
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const format = event.queryStringParameters?.format === 'gedcom' ? 'gedcom' : 'json';
  const stamp = new Date().toISOString().slice(0, 10);
  const all = async (sql) => (await pool.query(sql)).rows;

  const [people, relationships] = await Promise.all([
    all(`select ${PERSON_SELECT} from people order by lower(given_name), lower(surname)`),
    all('select id,from_person_id,to_person_id,relationship_type,status,source,evidence,created_at from relationships'),
  ]);

  if (format === 'gedcom') {
    await audit(pool, 'backup_gedcom', 'system', null, { people: people.length }, 'admin');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="family-tree-${stamp}.ged"`, 'Cache-Control': 'no-store' },
      body: toGedcom(people, relationships),
    };
  }

  const data = {
    exported_at: new Date().toISOString(),
    format: 'family-heritage-backup/1',
    people, relationships,
    access_tokens: await all('select id,label,active,created_at,last_used_at,token_hash from access_tokens order by created_at'),
    token_person_links: await all('select token_id,person_id,linked_at from token_person_links'),
    profiles: await all('select person_id,about,published,created_at,updated_at from profiles'),
    stories: await all('select id,person_id,title,content,status,cover_image_id,created_at,updated_at from stories'),
    business_ideas: await all('select id,person_id,title,description,category,location,funding_needed,skills_needed,website,status,created_at from business_ideas'),
    business_interests: await all('select id,idea_id,person_id,contact_method,contact_value,created_at from business_interests'),
    articles: await all('select slug,title,body,source_note,updated_at from articles'),
    comments: await all('select id,author_name,body,status,created_at,reviewed_at from comments'),
    proposals: await all('select id,action,payload,status,token_label,submitted_at,reviewed_at,review_note from proposals'),
    person_revisions: await all('select id,person_id,token_label,actor,action,before,after,created_at from person_revisions'),
    invites: await all('select id,person_id,label,expires_at,used_at,revoked,created_at from invites'),
    images: await all('select id,kind,ref_id,content_type,size_bytes,created_at from images'),
  };
  data.counts = Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
  await audit(pool, 'backup_json', 'system', null, data.counts, 'admin');
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="family-backup-${stamp}.json"`, 'Cache-Control': 'no-store' },
    body: JSON.stringify(data, null, 1),
  };
}
