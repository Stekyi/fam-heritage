import { PERSON_SELECT } from './db.mjs';

// Complete JSON backup (everything except photo/recording bytes, which stay in the database and in Neon recovery).
export async function buildBackup(pool) {
  const all = async (sql) => (await pool.query(sql)).rows;
  const [people, relationships] = await Promise.all([
    all(`select ${PERSON_SELECT} from people order by lower(given_name), lower(surname)`),
    all('select id,from_person_id,to_person_id,relationship_type,status,source,evidence,created_at from relationships'),
  ]);
  const data = {
    exported_at: new Date().toISOString(),
    format: 'family-heritage-backup/1',
    people, relationships,
    access_tokens: await all('select id,label,role,active,created_at,last_used_at,token_hash from access_tokens order by created_at'),
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
    person_media: await all('select id,person_id,kind,title,content_type,size_bytes,uploader_label,created_at from person_media'),
  };
  data.counts = Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
  return data;
}
