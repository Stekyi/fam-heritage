import { getDb, json, NO_DB, parseBody, requireToken, NEED_TOKEN, NEED_LINK, isUuid, clean, cleanMultiline, audit, appOnly, pageParams, header, requireAdmin } from '../lib/db.mjs';

const METHODS = ['email', 'phone', 'whatsapp', 'other'];

function validateContact(method, value) {
  if (!METHODS.includes(method)) return 'Please choose how you would like to be contacted.';
  const v = clean(value, 160);
  if (!v) return 'Please provide your contact information.';
  if (method === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'Please enter a valid email address.';
  if ((method === 'phone' || method === 'whatsapp') && !/^\+?[\d\s().-]{7,20}$/.test(v)) return 'Please enter a valid phone number.';
  return null;
}

function validateWebsite(v) {
  const s = clean(v, 200);
  if (!s) return { value: null };
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); if (!/^https?:$/.test(u.protocol)) throw new Error('x'); return { value: u.toString() }; }
  catch { return { error: 'Please enter a valid website address.' }; }
}

const IDEA_SELECT = `i.id, i.title, i.description, i.category, i.location, i.funding_needed, i.skills_needed, i.website, i.created_at, i.person_id,
  trim(coalesce(p.given_name,'')||' '||coalesce(p.surname,'')) as author_name,
  (select count(*)::int from business_interests bi where bi.idea_id=i.id) as interested_count`;

export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  const q = event.queryStringParameters || {};
  const hasTokenHeader = !!header(event, 'x-family-token');

  if (event.httpMethod === 'GET') {
    const blocked = appOnly(event); if (blocked) return blocked;
    const token = hasTokenHeader ? await requireToken(event, pool) : null;
    const admin = header(event, 'x-admin-secret') ? await requireAdmin(event, pool) : false;

    if (q.id) {
      if (!isUuid(q.id)) return json(404, { error: 'This business idea could not be found.' });
      const r = await pool.query(`select ${IDEA_SELECT} from business_ideas i join people p on p.id=i.person_id where i.id=$1 and i.status='active'`, [q.id]);
      const idea = r.rows[0];
      if (!idea) return json(404, { error: 'This business idea could not be found.' });
      const isOwner = !!(token && token.person_id && token.person_id === idea.person_id);
      const out = { idea: { ...idea, is_owner: isOwner } };
      if (token) {
        const mine = await pool.query('select contact_method, contact_value from business_interests where idea_id=$1 and token_id=$2', [q.id, token.id]);
        out.my_interest = mine.rows[0] || null;
      }
      if (isOwner || admin) {
        // Contact details are visible to the idea owner (and the administrator) only.
        const list = await pool.query(
          `select bi.id, bi.person_id, bi.contact_method, bi.contact_value, bi.created_at,
                  trim(coalesce(p.given_name,'')||' '||coalesce(p.surname,'')) as name
             from business_interests bi join people p on p.id=bi.person_id where bi.idea_id=$1 order by bi.created_at desc`, [q.id]);
        out.interests = list.rows;
      }
      return json(200, out);
    }

    const { limit, offset, page } = pageParams(q, 10, 30);
    const where = ["i.status='active'"];
    const vals = [];
    const add = (cond, v) => { vals.push(v); where.push(cond.replace('?', `$${vals.length}`)); };
    const qs = clean(q.q, 80);
    if (qs) {
      vals.push(`%${qs.replace(/[%_\\]/g, '\\$&')}%`);
      const n = vals.length;
      where.push(`(i.title ilike $${n} or i.description ilike $${n} or coalesce(i.category,'') ilike $${n} or coalesce(i.skills_needed,'') ilike $${n})`);
    }
    if (clean(q.category, 80)) add("lower(coalesce(i.category,''))=lower(?)", clean(q.category, 80));
    if (clean(q.location, 80)) add("coalesce(i.location,'') ilike ?", `%${clean(q.location, 80).replace(/[%_\\]/g, '\\$&')}%`);
    const w = where.join(' and ');
    const [list, total, cats] = await Promise.all([
      pool.query(`select ${IDEA_SELECT} from business_ideas i join people p on p.id=i.person_id where ${w} order by i.created_at desc limit ${limit} offset ${offset}`, vals),
      pool.query(`select count(*)::int as n from business_ideas i where ${w}`, vals),
      pool.query("select distinct category from business_ideas where status='active' and category is not null order by 1 limit 50"),
    ]);
    let mineSet = new Set();
    if (token) {
      const mine = await pool.query('select idea_id from business_interests where token_id=$1', [token.id]);
      mineSet = new Set(mine.rows.map((x) => x.idea_id));
    }
    const ideas = list.rows.map((i) => ({ ...i, is_owner: !!(token?.person_id && token.person_id === i.person_id), i_am_interested: mineSet.has(i.id) }));
    return json(200, { ideas, total: total.rows[0].n, page, limit, categories: cats.rows.map((c) => c.category) });
  }

  const token = await requireToken(event, pool); if (!token) return NEED_TOKEN();
  if (!token.person_id) return NEED_LINK();

  // /api/business?id=…&interest=1
  if (q.interest) {
    if (!isUuid(q.id)) return json(400, { error: 'Unable to identify this business idea.' });
    const idea = await pool.query("select person_id from business_ideas where id=$1 and status='active'", [q.id]);
    if (!idea.rows[0]) return json(404, { error: 'This business idea could not be found.' });
    if (event.httpMethod === 'POST') {
      const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
      if (idea.rows[0].person_id === token.person_id) return json(409, { error: 'This is your own business idea.' });
      const err = validateContact(b.contact_method, b.contact_value);
      if (err) return json(422, { error: err });
      await pool.query(
        `insert into business_interests(idea_id,token_id,person_id,contact_method,contact_value) values($1,$2,$3,$4,$5)
         on conflict (idea_id,token_id) do update set contact_method=excluded.contact_method, contact_value=excluded.contact_value`,
        [q.id, token.id, token.person_id, b.contact_method, clean(b.contact_value, 160)]);
      return json(200, { ok: true });
    }
    if (event.httpMethod === 'DELETE') {
      await pool.query('delete from business_interests where idea_id=$1 and token_id=$2', [q.id, token.id]);
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  }

  if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
    const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
    const title = clean(b.title, 160);
    const description = cleanMultiline(b.description, 5000);
    const category = clean(b.category, 80);
    const location = clean(b.location, 120);
    if (!title) return json(422, { error: 'Please give your business idea a title.' });
    if (!description) return json(422, { error: 'Please describe your business idea.' });
    if (!category) return json(422, { error: 'Please choose an industry or category.' });
    if (!location) return json(422, { error: 'Please add a location.' });
    const site = validateWebsite(b.website);
    if (site.error) return json(422, { error: site.error });
    const extra = [clean(b.funding_needed, 120), cleanMultiline(b.skills_needed, 500), site.value];
    if (event.httpMethod === 'POST') {
      const r = await pool.query(
        'insert into business_ideas(person_id,token_id,title,description,category,location,funding_needed,skills_needed,website) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
        [token.person_id, token.id, title, description, category, location, ...extra]);
      await audit(pool, 'create_idea', 'business_idea', r.rows[0].id, null, token.label);
      return json(201, { id: r.rows[0].id });
    }
    if (!isUuid(q.id)) return json(400, { error: 'Unable to identify this business idea.' });
    const own = await pool.query("select person_id from business_ideas where id=$1 and status='active'", [q.id]);
    if (!own.rows[0]) return json(404, { error: 'This business idea could not be found.' });
    if (own.rows[0].person_id !== token.person_id) return json(403, { error: 'You can only edit your own business ideas.' });
    await pool.query('update business_ideas set title=$1,description=$2,category=$3,location=$4,funding_needed=$5,skills_needed=$6,website=$7,updated_at=now() where id=$8', [title, description, category, location, ...extra, q.id]);
    return json(200, { id: q.id });
  }

  if (event.httpMethod === 'DELETE') {
    if (!isUuid(q.id)) return json(400, { error: 'Unable to identify this business idea.' });
    const own = await pool.query("select person_id from business_ideas where id=$1 and status='active'", [q.id]);
    if (!own.rows[0]) return json(404, { error: 'This business idea could not be found.' });
    if (own.rows[0].person_id !== token.person_id) return json(403, { error: 'You can only remove your own business ideas.' });
    await pool.query("update business_ideas set status='removed', updated_at=now() where id=$1", [q.id]);
    await audit(pool, 'remove_idea', 'business_idea', q.id, null, token.label);
    return json(200, { ok: true });
  }
  return json(405, { error: 'Method not allowed' });
}
