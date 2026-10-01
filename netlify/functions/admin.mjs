import { getDb, json, NO_DB, requireAdmin, parseBody, isUuid, audit, PERSON_SELECT, LIMITS } from '../lib/db.mjs';
import { REVERTIBLE, recordRevision } from '../lib/people.mjs';
import { describeProposal, wouldCreateCycle, relationshipExists } from '../lib/graph.mjs';
import { newInviteCode, inviteHash } from '../lib/invites.mjs';

const EDIT_FIELDS = ['given_name', 'surname', 'sex', 'birth_year', 'death_year', 'birth_place', 'occupation', 'location', 'notes', 'aliases', 'photo_url'];
const NAME = "trim(coalesce(p.given_name,'')||' '||coalesce(p.surname,''))";

async function overview(pool) {
  const [p, c, ac, s, i, rev, sec, dup, iso, ph] = await Promise.all([
    pool.query("select * from proposals where status='pending' order by submitted_at desc"),
    pool.query("select c.id,c.author_name,c.body,c.created_at,a.slug from comments c join articles a on a.id=c.article_id where c.status='pending' order by c.created_at desc"),
    pool.query("select c.id,c.author_name,c.body,c.created_at from comments c where c.status='approved' order by c.created_at desc limit 30"),
    pool.query(`select s.id,s.title,s.created_at, ${NAME} as author_name from stories s join people p on p.id=s.person_id where s.status='published' order by s.created_at desc limit 50`),
    pool.query(`select i.id,i.title,i.created_at, ${NAME} as author_name,
                       (select count(*)::int from business_interests bi where bi.idea_id=i.id) as interested_count
                  from business_ideas i join people p on p.id=i.person_id where i.status='active' order by i.created_at desc limit 50`),
    pool.query(`select r.id, r.person_id, ${NAME} as person_name, r.token_label, r.actor, r.action, r.before, r.after, r.reverted_of, r.created_at,
                       exists(select 1 from person_revisions x where x.reverted_of = r.id) as is_reverted
                  from person_revisions r join people p on p.id=r.person_id order by r.created_at desc limit 80`),
    pool.query(`select
        (select count(*)::int from token_attempts where ip like 'tok:%' and ip <> 'tok:*' and attempted_at > now()-interval '24 hours') as failed_token_24h,
        (select count(*)::int from token_attempts where ip like 'adm:%' and ip <> 'adm:*' and attempted_at > now()-interval '24 hours') as failed_admin_24h,
        (select count(distinct ip)::int from token_attempts where ip like 'tok:%' and ip <> 'tok:*' and attempted_at > now()-interval '24 hours') as token_sources_24h,
        (select count(*)::int from token_attempts where ip = 'tok:*' and attempted_at > now()-interval '10 minutes') as token_recent,
        (select count(*)::int from token_attempts where ip = 'adm:*' and attempted_at > now()-interval '10 minutes') as admin_recent`),
    pool.query(`select lower(trim(given_name||' '||coalesce(surname,''))) as name,
                       json_agg(json_build_object('id',p.id,'name',${NAME},'source',p.source,
                         'parents',(select count(*)::int from relationships r where r.to_person_id=p.id and r.relationship_type='parent'),
                         'children',(select count(*)::int from relationships r where r.from_person_id=p.id and r.relationship_type='parent'))) as people
                  from people p where p.kind='person' group by 1 having count(*) > 1 order by 1`),
    pool.query(`select p.id, ${NAME} as name from people p where p.kind='person'
                   and not exists (select 1 from relationships r where r.from_person_id=p.id or r.to_person_id=p.id) order by 2 limit 40`),
    pool.query("select count(*)::int as n from people where kind <> 'person'"),
  ]);
  const s0 = sec.rows[0];
  // Readable descriptions of pending suggestions (who and what), so the administrator does not have to read raw data.
  const ids = new Set();
  for (const pr of p.rows) { const x = pr.payload || {}; for (const k of ['parent_id', 'anchor_id', 'from_person_id', 'to_person_id']) if (x[k]) ids.add(x[k]); for (const k of ['from_person_id', 'to_person_id']) if (x.relationship?.[k]) ids.add(x.relationship[k]); }
  const named = ids.size ? (await pool.query('select id,given_name,surname from people where id = any($1::uuid[])', [[...ids]])).rows : [];
  const nameMap = new Map(named.map((r) => [r.id, r]));
  const proposals = p.rows.map((pr) => ({ ...pr, summary: describeProposal(pr, nameMap) }));
  const inv = await pool.query(`select i.id,i.label,i.created_at,i.expires_at,i.used_at,i.revoked, ${NAME} as person_name
                                   from invites i left join people p on p.id=i.person_id order by i.created_at desc limit 50`);
  const invites = inv.rows.map((r) => ({ ...r, status: r.revoked ? 'revoked' : r.used_at ? 'used' : new Date(r.expires_at) < new Date() ? 'expired' : 'open' }));
  return {
    proposals, invites, comments: c.rows, approved_comments: ac.rows, stories: s.rows, ideas: i.rows,
    revisions: rev.rows,
    security: { ...s0, token_locked: s0.token_recent > LIMITS.tokenGlobal, admin_locked: s0.admin_recent > LIMITS.adminGlobal },
    quality: { duplicates: dup.rows, isolated: iso.rows, placeholders: ph.rows[0].n },
  };
}

export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();
  if (!(await requireAdmin(event, pool))) return json(403, { error: 'Administrator authentication required.' });

  if (event.httpMethod === 'GET') return json(200, await overview(pool));
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });
  if (b.id && !isUuid(b.id)) return json(400, { error: 'Invalid id.' });

  if (b.kind === 'comment') {
    if (!['approved', 'rejected'].includes(b.status)) return json(400, { error: 'Invalid status.' });
    await pool.query('update comments set status=$1,reviewed_at=now(),reviewed_by=$2 where id=$3', [b.status, 'admin', b.id]);
    return json(200, { ok: true });
  }
  if (b.kind === 'story_remove') {
    await pool.query("update stories set status='removed', updated_at=now() where id=$1", [b.id]);
    await audit(pool, 'admin_remove_story', 'story', b.id, null, 'admin');
    return json(200, { ok: true });
  }
  if (b.kind === 'idea_remove') {
    await pool.query("update business_ideas set status='removed', updated_at=now() where id=$1", [b.id]);
    await audit(pool, 'admin_remove_idea', 'business_idea', b.id, null, 'admin');
    return json(200, { ok: true });
  }
  if (b.kind === 'invite_create') {
    let personId = null;
    if (b.person_id) {
      if (!isUuid(b.person_id)) return json(400, { error: 'Invalid family member.' });
      const per = await pool.query("select 1 from people where id=$1 and kind='person'", [b.person_id]);
      if (!per.rows[0]) return json(404, { error: 'That family member could not be found.' });
      const linked = await pool.query('select 1 from token_person_links where person_id=$1', [b.person_id]);
      if (linked.rows[0]) return json(409, { error: 'That family member already has a linked token.' });
      personId = b.person_id;
    }
    const days = Math.min(60, Math.max(1, parseInt(b.days, 10) || 14));
    const code = newInviteCode();
    const label = String(b.label || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null;
    const ins = await pool.query("insert into invites(code_hash,person_id,label,expires_at) values($1,$2,$3, now() + ($4 || ' days')::interval) returning id, expires_at", [inviteHash(code), personId, label, String(days)]);
    await audit(pool, 'invite_created', 'invite', ins.rows[0].id, { person_id: personId }, 'admin');
    return json(201, { id: ins.rows[0].id, code, expires_at: ins.rows[0].expires_at });
  }
  if (b.kind === 'invite_revoke') {
    await pool.query('update invites set revoked=true where id=$1 and used_at is null', [b.id]);
    return json(200, { ok: true });
  }
  if (b.kind === 'revert') {
    const rr = await pool.query('select * from person_revisions where id=$1', [b.id]);
    const rev = rr.rows[0]; if (!rev) return json(404, { error: 'That change could not be found.' });
    const cur = await pool.query(`select ${PERSON_SELECT} from people where id=$1`, [rev.person_id]);
    if (!cur.rows[0]) return json(404, { error: 'That family member no longer exists.' });
    const target = {}; const skipped = [];
    for (const [k, v] of Object.entries(rev.before)) {
      if (!REVERTIBLE.includes(k)) continue;
      if (k === 'photo_url' && v) {
        const m = /id=([0-9a-f-]{36})$/i.exec(v);
        const still = m ? await pool.query('select 1 from images where id=$1', [m[1]]) : { rows: [] };
        if (!still.rows[0]) { skipped.push('photo'); continue; }
      }
      target[k] = v;
    }
    const keys = Object.keys(target);
    if (!keys.length) return json(409, { error: 'Nothing could be restored from that change.', skipped });
    const sets = keys.map((k, i) => `${k}=$${i + 1}`);
    const vals = keys.map((k) => target[k]);
    vals.push(rev.person_id);
    await pool.query(`update people set ${sets.join(',')}, updated_by='admin (revert)', updated_at=now() where id=$${keys.length + 1}`, vals);
    await recordRevision(pool, rev.person_id, cur.rows[0], target, { label: 'admin', actor: 'admin', action: 'revert', revertedOf: rev.id });
    await audit(pool, 'admin_revert', 'person', rev.person_id, { revision: rev.id, fields: keys }, 'admin');
    return json(200, { ok: true, restored: keys, skipped });
  }
  if (b.kind === 'proposal') {
    const q = await pool.query('select * from proposals where id=$1', [b.id]);
    const pr = q.rows[0]; if (!pr) return json(404, { error: 'Proposal not found.' });
    if (b.status === 'rejected') {
      await pool.query('update proposals set status=$1,reviewed_at=now(),reviewed_by=$2,review_note=$3 where id=$4', ['rejected', 'admin', b.note || null, b.id]);
      return json(200, { ok: true });
    }
    if (b.status !== 'approved') return json(400, { error: 'Invalid status.' });
    const p = pr.payload;
    if (pr.action === 'add_person') {
      const ins = await pool.query('insert into people(given_name,surname,aliases,sex,birth_year,death_year,notes,source,source_ref) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
        [p.given_name, p.surname || null, p.aliases || [], p.sex || 'U', p.birth_year || null, p.death_year || null, p.notes || null, 'contributor', pr.id]);
      const newId = ins.rows[0].id;
      if (p.parent_id) await pool.query("insert into relationships(from_person_id,to_person_id,relationship_type,status,source,proposed_by) values($1,$2,'parent','approved','contributor',$3)", [p.parent_id, newId, 'admin']);
      if (p.anchor_id && p.relationship_kind === 'parent') await pool.query("insert into relationships(from_person_id,to_person_id,relationship_type,status,source,proposed_by) values($1,$2,'parent','approved','contributor',$3)", [newId, p.anchor_id, 'admin']);
      if (p.anchor_id && p.relationship_kind === 'spouse') await pool.query("insert into relationships(from_person_id,to_person_id,relationship_type,status,source,proposed_by) values($1,$2,'spouse','approved','contributor',$3) on conflict do nothing", [newId, p.anchor_id, 'admin']);
    } else if (pr.action === 'edit_person') {
      const f = p.fields || {};
      const sets = []; const vals = []; let n = 1;
      for (const k of EDIT_FIELDS) if (k in f) { sets.push(`${k}=$${n++}`); vals.push(f[k]); }
      if (sets.length) { vals.push(p.id); await pool.query(`update people set ${sets.join(',')},updated_at=now() where id=$${n}`, vals); }
    } else if (pr.action === 'delete_person') {
      await pool.query('delete from people where id=$1', [p.id]);
    } else if (pr.action === 'add_relationship') {
      if (await relationshipExists(pool, p.from_person_id, p.to_person_id, p.relationship_type)) return json(409, { error: 'That link is already in the tree.' });
      if (p.relationship_type === 'parent' && (await wouldCreateCycle(pool, p.from_person_id, p.to_person_id))) return json(422, { error: 'That link would make someone their own ancestor, so it was not added.' });
      await pool.query("insert into relationships(from_person_id,to_person_id,relationship_type,status,source,proposed_by) values($1,$2,$3,'approved',$4,$5) on conflict do nothing", [p.from_person_id, p.to_person_id, p.relationship_type, 'contributor', pr.id]);
    } else if (pr.action === 'delete_relationship') {
      const rid = p.relationship_id || p.id;
      const gone = await pool.query('delete from relationships where id=$1 returning *', [rid]);
      // The removed link is kept in the audit log so it can be put back by approving an "add link" suggestion.
      if (gone.rows[0]) await audit(pool, 'relationship_removed', 'relationship', rid, { relationship: gone.rows[0], reason: p.reason || null }, 'admin');
    }
    await pool.query('update proposals set status=$1,reviewed_at=now(),reviewed_by=$2,review_note=$3 where id=$4', ['approved', 'admin', b.note || null, b.id]);
    return json(200, { ok: true });
  }
  return json(400, { error: 'Unknown admin action.' });
}
