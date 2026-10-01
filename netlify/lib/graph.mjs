// Relationship helpers shared by suggestions (proposals) and administrator approval.

// True when making `parentId` a parent of `childId` would create a loop (the child is already an ancestor of the parent).
export async function wouldCreateCycle(pool, parentId, childId) {
  if (parentId === childId) return true;
  const r = await pool.query(
    `with recursive anc(id) as (
       select $1::uuid
       union
       select r.from_person_id from relationships r join anc on r.to_person_id = anc.id
        where r.relationship_type = 'parent' and r.status = 'approved'
     ) select 1 from anc where id = $2::uuid limit 1`, [parentId, childId]);
  return r.rows.length > 0;
}

export async function relationshipExists(pool, a, b, type) {
  const r = type === 'spouse'
    ? await pool.query("select 1 from relationships where relationship_type='spouse' and status='approved' and ((from_person_id=$1 and to_person_id=$2) or (from_person_id=$2 and to_person_id=$1)) limit 1", [a, b])
    : await pool.query("select 1 from relationships where relationship_type='parent' and status='approved' and from_person_id=$1 and to_person_id=$2 limit 1", [a, b]);
  return r.rows.length > 0;
}

const nm = (p) => [p?.given_name, p?.surname].filter(Boolean).join(' ') || 'Unnamed';
const KIND = { child: 'child', parent: 'parent', spouse: 'spouse / partner' };

// Plain-language description of a pending suggestion for the administrator.
export function describeProposal(pr, people) {
  const P = (id) => nm(people.get(id));
  const p = pr.payload || {};
  if (pr.action === 'add_person') {
    const who = [p.given_name, p.surname].filter(Boolean).join(' ');
    const anchor = p.parent_id || p.anchor_id;
    const kind = p.parent_id ? 'child' : p.relationship_kind;
    return anchor ? `Add "${who}" as a ${KIND[kind] || 'relative'} of ${P(anchor)}` : `Add "${who}"`;
  }
  if (pr.action === 'add_relationship') {
    return p.relationship_type === 'spouse' ? `Link ${P(p.from_person_id)} and ${P(p.to_person_id)} as spouses / partners` : `Link ${P(p.from_person_id)} as a parent of ${P(p.to_person_id)}`;
  }
  if (pr.action === 'delete_relationship') {
    const rel = p.relationship || {};
    const what = rel.relationship_type === 'spouse' ? `${P(rel.from_person_id)} and ${P(rel.to_person_id)} are spouses / partners` : `${P(rel.from_person_id)} is a parent of ${P(rel.to_person_id)}`;
    return `Remove the link: ${what}${p.reason ? ` (reason: ${p.reason})` : ''}`;
  }
  return pr.action.replace(/_/g, ' ');
}
