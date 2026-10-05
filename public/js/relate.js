import { $, esc, fullName, buildIndex, avatar, lifeLine } from './core.js';
import { attachPersonSearch } from './tree.js';

const ordinal = (n) => ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'][n] || `${n}th`;
const great = (n) => (n > 0 ? `${'great-'.repeat(n)}` : '');
const pick = (sex, m, f, n) => (sex === 'M' ? m : sex === 'F' ? f : n);

// da: generations from A up to the shared ancestor, db: from B up to it. Returns what B is to A.
export function describeBlood(da, db, sexB) {
  if (da === 0 && db === 0) return 'the same person';
  if (da === 0) return db === 1 ? pick(sexB, 'son', 'daughter', 'child') : `${great(db - 2)}${pick(sexB, 'grandson', 'granddaughter', 'grandchild')}`;
  if (db === 0) return da === 1 ? pick(sexB, 'father', 'mother', 'parent') : `${great(da - 2)}${pick(sexB, 'grandfather', 'grandmother', 'grandparent')}`;
  if (da === 1 && db === 1) return pick(sexB, 'brother', 'sister', 'sibling');
  if (db === 1) return `${great(da - 2)}${pick(sexB, 'uncle', 'aunt', 'aunt or uncle')}`;
  if (da === 1) return `${great(db - 2)}${pick(sexB, 'nephew', 'niece', 'niece or nephew')}`;
  const k = Math.min(da, db) - 1; const removed = Math.abs(da - db);
  const rem = removed === 0 ? '' : removed === 1 ? ' once removed' : removed === 2 ? ' twice removed' : ` ${removed} times removed`;
  return `${ordinal(k)} cousin${rem}`;
}

function ancestorsOf(index, id) {
  const dist = new Map([[id, 0]]); let frontier = [id]; let d = 0;
  while (frontier.length && d < 30) {
    d += 1; const next = [];
    for (const x of frontier) for (const p of index.parents.get(x) || []) if (!dist.has(p)) { dist.set(p, d); next.push(p); }
    frontier = next;
  }
  return dist;
}

function blood(index, aId, bId) {
  const A = ancestorsOf(index, aId); const B = ancestorsOf(index, bId);
  let best = null;
  for (const [id, da] of A) if (B.has(id)) { const db = B.get(id); if (!best || da + db < best.da + best.db) best = { da, db, via: id }; }
  return best;
}

export function relate(index, aId, bId) {
  const a = index.people.get(aId); const b = index.people.get(bId);
  if (!a || !b) return null;
  const direct = blood(index, aId, bId);
  if (direct) return { text: describeBlood(direct.da, direct.db, b.sex), via: direct.via, kind: 'blood' };
  if ((index.spouses.get(aId) || []).includes(bId)) return { text: pick(b.sex, 'husband', 'wife', 'spouse'), kind: 'spouse' };
  for (const s of index.spouses.get(bId) || []) {
    const r = blood(index, aId, s); if (r) return { text: `married to your ${describeBlood(r.da, r.db, index.people.get(s)?.sex)}, ${fullName(index.people.get(s))}`, via: r.via, kind: 'in-law' };
  }
  for (const s of index.spouses.get(aId) || []) {
    const r = blood(index, s, bId); if (r) return { text: `the ${describeBlood(r.da, r.db, b.sex)} of your spouse, ${fullName(index.people.get(s))}`, via: r.via, kind: 'in-law' };
  }
  return { text: null, kind: 'none' };
}

export function renderRelate(root) {
  root.innerHTML = `<section class="content relate-page"><div class="card"><span class="eyebrow">RELATIONSHIP FINDER</span><h2>How are we related?</h2><p class="muted">Pick two family members to see how they are connected on the recorded tree.</p>
    <div class="relate-grid">${['A', 'B'].map((k) => `<div class="relate-pick" id="pick${k}"><label class="field"><span class="label">${k === 'A' ? 'First person' : 'Second person'}</span><input class="input" id="in${k}" placeholder="Search by name" autocomplete="off"></label><div class="results" id="res${k}"></div><div class="relate-chosen" id="chosen${k}"></div></div>`).join('')}</div>
    <div id="relateOut" class="relate-out" aria-live="polite"></div></div></section>`;
  const sel = {};
  const out = $('#relateOut', root);
  const draw = () => {
    for (const k of ['A', 'B']) $('#chosen' + k, root).innerHTML = sel[k] ? `<div class="relate-card">${avatar(sel[k], 'sm')}<span><strong>${esc(fullName(sel[k]))}</strong><small>${esc(lifeLine(sel[k]))}</small></span></div>` : '';
    if (!sel.A || !sel.B) { out.innerHTML = ''; return; }
    const idx = buildIndex();
    const r = relate(idx, sel.A.id, sel.B.id);
    if (!r?.text) { out.innerHTML = `<p class="relate-none">No recorded connection between ${esc(fullName(sel.A))} and ${esc(fullName(sel.B))} yet. If you know how they are related, suggest it from their profile.</p>`; return; }
    const via = r.via && r.kind === 'blood' && idx.people.get(r.via) ? `<small>Shared ancestor: ${esc(fullName(idx.people.get(r.via)))}</small>` : '';
    out.innerHTML = `<p class="relate-answer"><strong>${esc(fullName(sel.B))}</strong> is ${esc(fullName(sel.A))}'s <em>${esc(r.text)}</em>.</p>${via}`;
  };
  for (const k of ['A', 'B']) {
    attachPersonSearch($('#in' + k, root), $('#res' + k, root), { onPick: (p) => { sel[k] = p; $('#res' + k, root).innerHTML = ''; $('#in' + k, root).value = ''; draw(); } });
  }
  return { select: (k, p) => { sel[k] = p; draw(); } };
}
