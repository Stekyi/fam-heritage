import {
  state, $, $$, esc, norm, fullName, aliasesOf, debounce, api, toast, toastError, openSheet, loadingView, emptyView, errorView,
  buildIndex, patchPerson, lifeLine, avatar, genderLabel, birthText, deathText, ageInfo, livingClass, safeUrl, prepareImage, fmtWhen, setHelp, reportError,
} from './core.js';

const T = { ancestors: 3, descendants: 4, zoom: 0.72, selected: null, search: '' };

// ---------------------------------------------------------------- cards
function cardMeta(p) {
  const bits = [p.occupation, p.birth_place ? `b. ${p.birth_place}` : ''].filter(Boolean);
  return bits.length ? `<span class="person-meta">${esc(bits.join(' · '))}</span>` : '';
}

export function personCard(p, { selected = false, compact = false } = {}) {
  if (!p) return '';
  const aka = aliasesOf(p);
  return `<button class="gene-person ${selected ? 'is-selected' : ''} ${compact ? 'compact' : ''}" data-node="${esc(p.id)}" type="button">${avatar(p, 'sm')}<span class="person-copy"><strong>${esc(fullName(p))}</strong>${aka.length ? `<span class="person-aka"><b>AKA:</b> ${esc(aka.join(' · '))}</span>` : ''}<small>${esc(lifeLine(p))}</small>${cardMeta(p)}</span></button>`;
}

// ---------------------------------------------------------------- search (server side, debounced)
export function attachPersonSearch(input, results, { onPick, emptyText = 'No family members found matching your search.', limit = 12 } = {}) {
  let seq = 0;
  const run = debounce(async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (!q) { results.innerHTML = ''; return; }
    results.innerHTML = `<p class="muted search-note">Finding family members…</p>`;
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, { auth: false });
      if (my !== seq) return;
      if (!r.results.length) { results.innerHTML = `<p class="muted search-note">${esc(emptyText)}</p>`; return; }
      results.innerHTML = r.results.map((p) => {
        const aka = aliasesOf(p);
        const info = [lifeLine(p) !== 'Dates unknown' ? lifeLine(p) : '', p.occupation, p.birth_place].filter(Boolean).join(' · ');
        return `<button type="button" class="result" data-person="${esc(p.id)}">${avatar(p, 'sm')}<span class="result-person"><strong>${esc(fullName(p))}</strong>${aka.length ? `<small class="result-aka">AKA: ${esc(aka.join(' · '))}</small>` : ''}${info ? `<small class="result-info">${esc(info)}</small>` : ''}</span></button>`;
      }).join('');
      $$('[data-person]', results).forEach((b) => { b.onclick = () => onPick(r.results.find((x) => x.id === b.dataset.person)); });
    } catch (e) {
      if (my === seq) results.innerHTML = `<p class="muted search-note error-text">${esc(e.message)}</p>`;
    }
  }, 260);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; results.innerHTML = ''; } });
  return { clear: () => { input.value = ''; results.innerHTML = ''; } };
}

// ---------------------------------------------------------------- tree data helpers
export function ensureHomeRoot() {
  const index = buildIndex();
  const preferred = [...index.people.values()].find((p) => norm(fullName(p)) === 'kyeboadu');
  if (preferred) { state.homeRootId = preferred.id; return preferred; }
  const roots = [...index.people.values()].filter((p) => !(index.parents.get(p.id) || []).length);
  const score = (p) => { let n = 0; const q = [p.id]; const seen = new Set(q); while (q.length) { const id = q.shift(); for (const c of index.children.get(id) || []) if (!seen.has(c)) { seen.add(c); q.push(c); n++; } } return n; };
  const root = roots.sort((a, b) => score(b) - score(a))[0] || [...index.people.values()][0];
  state.homeRootId = root?.id || null;
  return root;
}
const homeRoot = () => buildIndex().people.get(state.homeRootId) || ensureHomeRoot();

function generationLabel(distance, direction) {
  if (direction === 'ancestor') { if (distance === 1) return 'Parents'; if (distance === 2) return 'Grandparents'; if (distance === 3) return 'Great-grandparents'; return `${'Great-'.repeat(Math.max(0, distance - 2))}grandparents`; }
  if (distance === 1) return 'Children'; if (distance === 2) return 'Grandchildren'; if (distance === 3) return 'Great-grandchildren'; return `${'Great-'.repeat(Math.max(0, distance - 2))}grandchildren`;
}
function walk(root, index, maxLevels, mapKey) {
  const generations = []; let frontier = [root]; const seen = new Set([root.id]); let distance = 0;
  while (frontier.length && distance < maxLevels) {
    const next = [];
    for (const person of frontier) for (const id of index[mapKey].get(person.id) || []) { if (seen.has(id)) continue; seen.add(id); const p = index.people.get(id); if (p) next.push(p); }
    if (!next.length) break;
    distance += 1; generations.push({ distance, people: next }); frontier = next;
  }
  return generations;
}
const ancestorGenerations = (root, index, n) => walk(root, index, n, 'parents').reverse();
const descendantGenerations = (root, index, n) => walk(root, index, n, 'children');
function siblings(root, index) {
  const ids = new Set();
  for (const pid of index.parents.get(root.id) || []) for (const cid of index.children.get(pid) || []) if (cid !== root.id) ids.add(cid);
  return [...ids].map((id) => index.people.get(id)).filter(Boolean).sort((a, b) => fullName(a).localeCompare(fullName(b)));
}
function familyUnits(people, index) {
  const ids = new Set(people.map((p) => p.id)); const units = []; const used = new Set();
  for (const p of people) {
    if (used.has(p.id)) continue;
    const partner = (index.spouses.get(p.id) || []).map((id) => index.people.get(id)).find((s) => s && ids.has(s.id) && !used.has(s.id));
    if (partner) { used.add(p.id); used.add(partner.id); units.push([p, partner].sort((a, b) => fullName(a).localeCompare(fullName(b)))); }
    else { used.add(p.id); units.push([p]); }
  }
  return units.sort((a, b) => fullName(a[0]).localeCompare(fullName(b[0])));
}
function renderGeneration(g, index, direction) {
  const units = familyUnits(g.people, index);
  return `<section class="generation"><div class="generation-heading"><span>${esc(generationLabel(g.distance, direction))}</span><small>${g.people.length} ${g.people.length === 1 ? 'person' : 'people'}</small></div><div class="generation-units">${units.map((unit) => `<div class="family-unit">${unit.map((p, i) => `${i ? '<span class="union">&amp;</span>' : ''}${personCard(p, { compact: true })}`).join('')}</div>`).join('')}</div></section>`;
}

// ---------------------------------------------------------------- tree page
export function renderTreePage(root, openId) {
  const people = state.data.people || [];
  ensureHomeRoot();
  if (!T.selected || !people.some((p) => p.id === T.selected)) T.selected = state.homeRootId || people[0]?.id;
  if (openId && people.some((p) => p.id === openId)) T.selected = openId;
  const selected = people.find((p) => p.id === T.selected);
  if (!selected) { root.innerHTML = emptyView('No family members yet', 'The family tree is empty.'); return; }
  const index = buildIndex();
  const ancestors = ancestorGenerations(selected, index, 2);
  const descendants = descendantGenerations(selected, index, 3);
  const sibs = siblings(selected, index);
  const spouses = (index.spouses.get(selected.id) || []).map((id) => index.people.get(id)).filter(Boolean);
  const home = homeRoot();
  const isRoot = selected.id === home?.id;

  root.innerHTML = `<div class="tree-page"><aside class="tree-sidebar"><div class="sidebar-title"><span class="eyebrow">FAMILY TREE</span><h2>Find a person</h2></div>
    <label class="sr-only" for="search">Search family members</label>
    <input id="search" class="input" value="${esc(T.search)}" placeholder="Search by name or AKA…" autocomplete="off" type="search">
    <div id="searchResults" class="results" aria-live="polite"></div>
    <button id="homeTree" class="btn primary block" type="button">⌂ View family from the roots</button>
    <div class="tree-help"><strong>How to read the tree</strong><p>Search for a family member, then open the full tree and choose how many generations to show.</p><p>Spouses sit beside each other; generations run top to bottom. Select a person in the centre of the tree to see their profile.</p></div>
    <div class="legend"><div><i class="legend-dot male"></i> Male</div><div><i class="legend-dot female"></i> Female</div><div><i class="legend-dot unknown"></i> Other / not recorded</div></div></aside>
    <section class="tree-area"><div class="tree-toolbar"><div><strong>${esc(fullName(selected))}</strong><span>${isRoot ? 'Family roots' : 'Family member preview'}</span></div><div class="toolbar-actions"><button id="openProfile" class="btn" type="button">Profile</button><button id="openSelected" class="btn primary" type="button">Open full tree</button><button id="homeTreeTop" class="btn" type="button">⌂ Roots</button></div></div>
    <div class="lineage-scroll"><div class="lineage"><section class="focus-section home-preview"><div class="section-title"><span>${isRoot ? 'FAMILY ROOT' : 'SELECTED FAMILY MEMBER'}</span><small>${isRoot ? 'Beginning of the recorded clan line' : 'Preview — open the full tree for more generations'}</small></div><div class="focus-family"><div class="focus-person">${personCard(selected, { selected: true })}</div>${spouses.length ? `<div class="focus-spouses">${spouses.map((s) => `<span class="union">&amp;</span>${personCard(s, { compact: true })}`).join('')}</div>` : ''}</div>${selected.notes ? `<div class="focus-note">${esc(selected.notes)}</div>` : ''}</section>
    ${ancestors.length ? `<div class="preview-desc"><div class="section-title"><span>ANCESTORS</span><small>Preview</small></div>${ancestors.map((g) => renderGeneration(g, index, 'ancestor')).join('<div class="generation-arrow">↓</div>')}</div>` : ''}
    ${sibs.length ? `<section class="siblings-section"><div class="section-title"><span>SIBLINGS</span><small>Children of the same parent(s)</small></div><div class="sibling-list">${sibs.map((p) => personCard(p, { compact: true })).join('')}</div></section>` : ''}
    ${descendants.length ? `<div class="lineage-section descendants"><div class="section-title"><span>DESCENDANTS</span><small>Preview</small></div>${descendants.map((g) => renderGeneration(g, index, 'descendant')).join('<div class="generation-arrow">↓</div>')}</div>` : ''}</div></div></section></div>`;

  attachPersonSearch($('#search', root), $('#searchResults', root), { onPick: (p) => { T.search = ''; $('#search').value = ''; $('#searchResults').innerHTML = ''; openTreeModal(p.id); } });
  const goRoots = () => { T.selected = state.homeRootId; T.search = ''; renderTreePage(root); };
  $('#homeTree', root).onclick = goRoots; $('#homeTreeTop', root).onclick = goRoots;
  $('#openSelected', root).onclick = () => openTreeModal(selected.id);
  $('#openProfile', root).onclick = () => openPersonSheet(selected.id);
  $$('[data-node]', root).forEach((b) => { b.onclick = () => { if (b.dataset.node === selected.id) openPersonSheet(b.dataset.node); else openTreeModal(b.dataset.node); }; });
  if (openId) openTreeModal(openId);
}

// ---------------------------------------------------------------- full tree modal
const levelInput = (id, value) => `<label>${id === 'ancestorLevel' ? 'Parent generations' : 'Offspring generations'}<input id="${id}" class="level-input" type="number" min="0" step="1" value="${Number.isFinite(value) ? value : 0}" inputmode="numeric"></label>`;

function lineageError(personId, error) {
  const p = buildIndex().people.get(personId);
  return `<div class="lineage-error"><div class="error-icon">!</div><h3>We could not display this lineage</h3><p>We found <strong>${esc(p ? fullName(p) : 'this family member')}</strong>, but the family relationships could not be displayed.</p><p class="error-detail">${esc(error?.message || 'No usable relationship data was returned.')}</p><div class="error-actions"><button id="errorRetry" class="btn primary" type="button">Try again</button><button id="errorRoots" class="btn" type="button">⌂ View family roots</button></div></div>`;
}

function renderModalTree(personId) {
  try {
    const index = buildIndex(); const rootP = index.people.get(personId);
    if (!rootP) throw Error('The selected family member is not present in the loaded family data.');
    const ancestors = ancestorGenerations(rootP, index, T.ancestors); const descendants = descendantGenerations(rootP, index, T.descendants);
    const sibs = siblings(rootP, index); const spouses = (index.spouses.get(rootP.id) || []).map((id) => index.people.get(id)).filter(Boolean);
    const parentCount = (index.parents.get(rootP.id) || []).length; const childCount = (index.children.get(rootP.id) || []).length;
    if (!ancestors.length && !descendants.length && !sibs.length && !spouses.length && parentCount + childCount === 0 && T.ancestors + T.descendants > 0) throw Error('This person is in the family data, but no parent/child relationship is currently recorded for them.');
    const visible = ancestors.reduce((n, g) => n + g.people.length, 0) + descendants.reduce((n, g) => n + g.people.length, 0) + sibs.length + 1 + spouses.length;
    return `<div class="modal-tree-shell"><div class="modal-toolbar"><div><span class="eyebrow">FAMILY LINEAGE</span><h2>${esc(fullName(rootP))}</h2><p>${visible} people visible • scroll to explore</p></div><div class="modal-toolbar-actions"><button id="modalProfile" class="btn" type="button">Profile</button><button id="closeTreeModal" class="modal-close" type="button" aria-label="Close">×</button></div></div>
    <div class="tree-controls"><div class="level-control-group">${levelInput('ancestorLevel', T.ancestors)}</div><div class="level-control-group">${levelInput('descendantLevel', T.descendants)}</div><button id="applyLevels" class="btn primary" type="button">Apply generations</button><div class="zoom-controls"><span>Zoom</span><button id="zoomOut" type="button" aria-label="Zoom out">−</button><output id="zoomValue">${Math.round(T.zoom * 100)}%</output><button id="zoomIn" type="button" aria-label="Zoom in">+</button><button id="zoomReset" type="button">Reset</button></div><button id="modalFocus" class="btn" type="button">◎ Centre person</button><button id="modalHome" class="btn" type="button">⌂ Roots</button></div>
    <div class="modal-tree-scroll" id="modalTreeScroll"><div class="modal-tree-canvas" id="modalTreeCanvas" style="--tree-scale:${T.zoom}"><div class="tree-flow">
    ${ancestors.length ? `<div class="lineage-section ancestor-section"><div class="section-title"><span>ANCESTORS</span><small>${T.ancestors} level${T.ancestors === 1 ? '' : 's'} requested</small></div>${ancestors.map((g) => renderGeneration(g, index, 'ancestor')).join('<div class="generation-arrow">↓</div>')}</div><div class="flow-arrow">↓</div>` : ''}
    <section class="focus-section modal-focus"><div class="section-title"><span>CENTRE OF THE TREE</span><small>Select this person to view their profile</small></div><div class="focus-family"><div class="focus-person">${personCard(rootP, { selected: true })}</div>${spouses.length ? `<div class="focus-spouses">${spouses.map((s) => `<span class="union">&amp;</span>${personCard(s, { compact: true })}`).join('')}</div>` : ''}</div>${rootP.notes ? `<div class="focus-note">${esc(rootP.notes)}</div>` : ''}</section>
    ${sibs.length ? `<section class="siblings-section"><div class="section-title"><span>SIBLINGS</span><small>Children of the same parent(s)</small></div><div class="sibling-list">${sibs.map((p) => personCard(p, { compact: true })).join('')}</div></section>` : ''}
    ${descendants.length ? `<div class="flow-arrow">↓</div><div class="lineage-section descendant-section"><div class="section-title"><span>DESCENDANTS</span><small>${T.descendants} level${T.descendants === 1 ? '' : 's'} requested</small></div>${descendants.map((g) => renderGeneration(g, index, 'descendant')).join('<div class="generation-arrow">↓</div>')}</div>` : ''}
    ${!ancestors.length && !descendants.length && !sibs.length ? `<div class="open-prompt"><h3>No lineage recorded yet</h3><p>${esc(fullName(rootP))} is in the family database, but no connected relatives were found for the requested direction.</p></div>` : ''}
    </div></div></div></div>`;
  } catch (e) {
    return `<div class="modal-tree-shell"><div class="modal-toolbar"><div><span class="eyebrow">FAMILY LINEAGE</span><h2>Lineage unavailable</h2><p>Something prevented this family member's tree from being displayed.</p></div><button id="closeTreeModal" class="modal-close" type="button" aria-label="Close">×</button></div><div class="modal-error-wrap">${lineageError(personId, e)}</div></div>`;
  }
}

function applyZoom() { const c = $('#modalTreeCanvas'); if (!c) return; c.style.setProperty('--tree-scale', T.zoom); $('#zoomValue').textContent = `${Math.round(T.zoom * 100)}%`; }
function centreFocus(smooth = true) { $('#treeModal .modal-focus')?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center', inline: 'center' }); }

function bindModal() {
  const modal = $('#treeModal'); if (!modal) return;
  $('#closeTreeModal').onclick = closeTreeModal;
  modal.onclick = (e) => { if (e.target.id === 'treeModal') closeTreeModal(); };
  const apply = () => {
    const a = Math.floor(Number($('#ancestorLevel')?.value)); const d = Math.floor(Number($('#descendantLevel')?.value));
    if (!Number.isFinite(a) || a < 0 || !Number.isFinite(d) || d < 0) return toast('Generation levels must be whole numbers of 0 or greater.', 'error');
    T.ancestors = a; T.descendants = d; refreshModal();
  };
  $('#applyLevels')?.addEventListener('click', apply);
  ['ancestorLevel', 'descendantLevel'].forEach((id) => $('#' + id)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); }));
  $('#zoomOut')?.addEventListener('click', () => { T.zoom = Math.max(0.25, Math.round((T.zoom - 0.1) * 100) / 100); applyZoom(); });
  $('#zoomIn')?.addEventListener('click', () => { T.zoom = Math.min(3, Math.round((T.zoom + 0.1) * 100) / 100); applyZoom(); });
  $('#zoomReset')?.addEventListener('click', () => { T.zoom = 0.72; applyZoom(); });
  $('#modalHome')?.addEventListener('click', () => { closeTreeModal(); T.selected = state.homeRootId; T.search = ''; refreshTreeViews(); });
  $('#modalFocus')?.addEventListener('click', () => centreFocus(true));
  $('#modalProfile')?.addEventListener('click', () => openPersonSheet(T.selected));
  $('#errorRetry')?.addEventListener('click', () => refreshModal());
  $('#errorRoots')?.addEventListener('click', () => $('#modalHome')?.click());
  $$('#treeModal [data-node]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); if (b.dataset.node === T.selected) openPersonSheet(b.dataset.node); else openTreeModal(b.dataset.node); }; });
}

export function openTreeModal(personId) {
  T.selected = personId; T.zoom = 0.72;
  $('#treeModal')?.remove();
  const wrap = document.createElement('div'); wrap.id = 'treeModal'; wrap.className = 'tree-modal'; wrap.innerHTML = renderModalTree(personId);
  document.body.appendChild(wrap); document.body.classList.add('modal-open');
  bindModal(); setTimeout(() => centreFocus(false), 40);
}
function refreshModal() { const m = $('#treeModal'); if (!m) return; m.innerHTML = renderModalTree(T.selected); bindModal(); setTimeout(() => centreFocus(false), 20); }
export function closeTreeModal() {
  $('#treeModal')?.remove(); document.body.classList.remove('modal-open');
  if (/^#\/tree\/./.test(location.hash)) history.replaceState(null, '', '#/tree');
}

// Re-draws whatever tree views are open after the underlying data changed.
export function refreshTreeViews() {
  const page = $('#view .tree-page');
  if (page) { const r = $('#view'); const scroll = $('.lineage-scroll', r)?.scrollTop || 0; renderTreePage(r); const s = $('.lineage-scroll', r); if (s) s.scrollTop = scroll; }
  if ($('#treeModal')) { const sc = $('#modalTreeScroll'); const t = sc?.scrollTop; const l = sc?.scrollLeft; refreshModal(); const n = $('#modalTreeScroll'); if (n && t != null) { n.scrollTop = t; n.scrollLeft = l; } }
}

// ---------------------------------------------------------------- person sheet (profile + edit)
export const canEdit = () => !!state.me?.valid;

function factRow(label, value) { return value ? `<div class="fact"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>` : ''; }

export function personFacts(p) {
  const age = ageInfo(p);
  const cls = livingClass(p);
  const status = cls === 'deceased' ? 'Deceased' : cls === 'living' ? 'Living' : cls === 'presumed_living' ? 'No death recorded' : '';
  return `<dl class="facts">${factRow('Born', birthText(p))}${factRow('Died', deathText(p))}${age ? factRow(age.kind === 'current' ? 'Current age' : 'Age at death', `${age.years} years`) : ''}${factRow('Status', status)}${factRow('Gender', genderLabel(p.sex))}${factRow('Birth place', p.birth_place)}${factRow('Occupation', p.occupation)}${factRow('Lives in', p.location)}</dl>`;
}

export async function openPersonSheet(personId, { edit = false } = {}) {
  const p = state.data.people.find((x) => x.id === personId);
  if (!p) return toast('Unable to load this family member. Please try again.', 'error');
  const s = openSheet(`<div class="sheet-body" id="personSheet">${loadingView('Loading this family member…')}</div>`, { wide: true, label: fullName(p) });
  const body = $('#personSheet', s.el);
  let detail = { profile: null, stories: [] };
  try { detail = await api(`/api/person?id=${personId}`); if (detail.person) patchPerson(detail.person); } catch { /* shown without profile */ }
  const draw = () => {
    const cur = state.data.people.find((x) => x.id === personId) || p;
    const aka = aliasesOf(cur);
    body.innerHTML = `<div class="sheet-head"><div class="person-hero">${avatar(cur, 'xl')}<div><span class="eyebrow">FAMILY MEMBER</span><h2>${esc(fullName(cur))}</h2>${aka.length ? `<p class="aka-line"><b>AKA:</b> ${esc(aka.join(' · '))}</p>` : ''}<p class="muted">${esc(lifeLine(cur))}</p></div></div><button class="modal-close" type="button" data-close aria-label="Close">×</button></div>
      ${personFacts(cur)}
      ${cur.notes ? `<div class="focus-note">${esc(cur.notes)}</div>` : ''}
      ${detail.profile ? `<section class="sheet-section"><h3>About ${esc(cur.given_name)}</h3><div class="prose">${esc(detail.profile.about).split(/\n{2,}/).map((x) => `<p>${x.replace(/\n/g, '<br>')}</p>`).join('')}</div></section>` : ''}
      ${detail.stories.length ? `<section class="sheet-section"><h3>Stories</h3><ul class="plain-list">${detail.stories.map((st) => `<li><a href="#/story/${esc(st.id)}" data-close>${esc(st.title)}</a> <small class="muted">${esc(fmtWhen(st.created_at))}</small></li>`).join('')}</ul></section>` : ''}
      <div class="sheet-actions"><a class="btn primary" href="#/tree/${esc(cur.id)}" data-close>View in Family Tree</a><a class="btn" href="#/person/${esc(cur.id)}" data-close>Full profile page</a><button class="btn" type="button" id="suggestFix">Suggest a correction</button><button class="btn" type="button" id="editPerson">${canEdit() ? 'Edit details' : '🔒 Edit details'}</button></div>`;
    $$('[data-close]', body).forEach((b) => b.addEventListener('click', s.close));
    $('#suggestFix', body).onclick = () => { if (!canEdit()) return toast('You need a contributor token to make changes.', 'info'); s.close(); openCorrectionSheet(personId); };
    $('#editPerson', body).onclick = () => {
      if (!canEdit()) return toast('You need a contributor token to make changes.', 'info');
      drawEdit();
    };
  };
  const drawEdit = () => {
    const cur = state.data.people.find((x) => x.id === personId) || p;
    body.innerHTML = editFormHtml(cur);
    bindEditForm(body, cur, {
      onCancel: draw,
      onSaved: async () => { draw(); refreshTreeViews(); window.dispatchEvent(new CustomEvent('person-updated', { detail: { id: personId } })); },
    });
  };
  if (edit && canEdit()) drawEdit(); else draw();
  return s;
}

// ---------------------------------------------------------------- edit form
function editFormHtml(p) {
  const photo = safeUrl(p.photo_url);
  const dateVal = (iso, y) => iso || (y ? String(y) : '');
  return `<form id="editForm" novalidate class="form" autocomplete="off">
    <div class="sheet-head"><div><span class="eyebrow">EDIT FAMILY MEMBER</span><h2>${esc(fullName(p))}</h2><p class="muted">Only the name is required. Relationships are not changed here.</p></div><button class="modal-close" type="button" data-cancel aria-label="Close">×</button></div>
    <div class="form-grid">
      <label class="field span-2">Name <span class="req" aria-hidden="true">*</span><input class="input" name="given_name" value="${esc(p.given_name)}" maxlength="120" required><small class="hint">Given name(s), as the person is usually known.</small><small class="err" data-err="given_name"></small></label>
      <label class="field span-2">Surname / family name<input class="input" name="surname" value="${esc(p.surname || '')}" maxlength="120"></label>
      <div class="field span-2"><span class="label">AKA ${setHelp('Add other names this person is known by.')}</span><div class="chips" id="akaChips"></div><div class="chip-add"><input class="input" id="akaInput" placeholder="Add another name and press Enter" maxlength="120"><button type="button" class="btn" id="akaAdd">Add</button></div><small class="hint">Add other names this person is known by.</small></div>
      <label class="field">Gender<select class="input" name="sex"><option value="F" ${p.sex === 'F' ? 'selected' : ''}>Female</option><option value="M" ${p.sex === 'M' ? 'selected' : ''}>Male</option><option value="O" ${p.sex === 'O' ? 'selected' : ''}>Other</option><option value="U" ${!['M', 'F', 'O'].includes(p.sex) ? 'selected' : ''}>Unknown</option></select></label>
      <label class="field">Living status<select class="input" name="living_status"><option value="" ${!p.living_status ? 'selected' : ''}>Not recorded</option><option value="living" ${p.living_status === 'living' ? 'selected' : ''}>Living</option><option value="deceased" ${p.living_status === 'deceased' ? 'selected' : ''}>Deceased</option><option value="unknown" ${p.living_status === 'unknown' ? 'selected' : ''}>Unknown</option></select><small class="hint">Helps the family statistics stay accurate.</small></label>
      <label class="field">Date of birth<input class="input" name="birth" value="${esc(dateVal(p.birth_date, p.birth_year))}" placeholder="1950 or 1950-03-21" inputmode="numeric" maxlength="10"><small class="hint">A year, or a full date as YYYY-MM-DD.</small><small class="err" data-err="birth"></small></label>
      <label class="field">Date of death<input class="input" name="death" value="${esc(dateVal(p.death_date, p.death_year))}" placeholder="Leave blank if living" inputmode="numeric" maxlength="10"><small class="err" data-err="death"></small></label>
      <label class="field">Birth place<input class="input" name="birth_place" value="${esc(p.birth_place || '')}" maxlength="160" placeholder="Town, Country"></label>
      <label class="field">Occupation<input class="input" name="occupation" value="${esc(p.occupation || '')}" maxlength="160" placeholder="e.g. Teacher, Engineer"></label>
      <label class="field span-2">Where they live now<input class="input" name="location" value="${esc(p.location || '')}" maxlength="160" placeholder="City, Country"><small class="hint">Used by Network search.</small></label>
      <div class="field span-2"><span class="label">Profile image</span><div class="photo-edit"><div id="photoPreview">${avatar(p, 'xl')}</div><div><input type="file" id="photoFile" accept="image/jpeg,image/png,image/webp" class="sr-only"><label for="photoFile" class="btn">Choose image…</label> ${photo ? '<button type="button" class="btn" id="photoRemove">Remove image</button>' : ''}<small class="hint block">JPEG, PNG or WebP. It is resized automatically.</small><small class="err" data-err="photo"></small></div></div></div>
    </div>
    <div class="sheet-actions"><button type="submit" class="btn primary" id="saveBtn">Save changes</button><button type="button" class="btn" data-cancel>Cancel</button></div></form>`;
}

function bindEditForm(root, person, { onCancel, onSaved }) {
  const form = $('#editForm', root);
  let aliases = [...(person.aliases || [])].filter((a) => norm(a) !== norm(fullName(person)) || true);
  let newPhoto = null; let removePhoto = false;
  const drawChips = () => {
    $('#akaChips', root).innerHTML = aliases.length ? aliases.map((a, i) => `<span class="chip">${esc(a)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(a)}">×</button></span>`).join('') : '<span class="muted small">No other names yet.</span>';
    $$('[data-rm]', root).forEach((b) => { b.onclick = () => { aliases.splice(Number(b.dataset.rm), 1); drawChips(); }; });
  };
  const addAlias = () => { const i = $('#akaInput', root); const v = i.value.trim(); if (v && !aliases.some((a) => a.toLowerCase() === v.toLowerCase())) aliases.push(v); i.value = ''; drawChips(); };
  drawChips();
  $('#akaAdd', root).onclick = addAlias;
  $('#akaInput', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAlias(); } });
  $$('[data-cancel]', root).forEach((b) => b.addEventListener('click', onCancel));
  $('#photoFile', root).addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    $('[data-err="photo"]', root).textContent = '';
    try { newPhoto = await prepareImage(f); removePhoto = false; $('#photoPreview', root).innerHTML = `<span class="avatar avatar-xl"><img src="${newPhoto.preview}" alt="Preview"></span>`; }
    catch (err) { newPhoto = null; $('[data-err="photo"]', root).textContent = err.message; }
  });
  $('#photoRemove', root)?.addEventListener('click', () => { removePhoto = true; newPhoto = null; $('#photoPreview', root).innerHTML = avatar({ ...person, photo_url: null }, 'xl'); });
  const bad = (name, msg) => { $(`[data-err="${name}"]`, root).textContent = msg; $(`[name="${name}"]`, root)?.classList.add('invalid'); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $$('.err', root).forEach((x) => { x.textContent = ''; }); $$('.invalid', root).forEach((x) => x.classList.remove('invalid'));
    const v = Object.fromEntries(new FormData(form).entries());
    let ok = true;
    if (!String(v.given_name || '').trim()) { bad('given_name', 'Please enter a name before saving.'); ok = false; }
    const dre = /^(\d{4}|\d{4}-\d{2}-\d{2})?$/;
    if (!dre.test(String(v.birth || '').trim())) { bad('birth', 'Please provide a valid date.'); ok = false; }
    if (!dre.test(String(v.death || '').trim())) { bad('death', 'Please provide a valid date.'); ok = false; }
    if (!ok) { toast('Please check the highlighted fields.', 'error'); return; }
    const btn = $('#saveBtn', root); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await api(`/api/person?id=${person.id}`, { method: 'PATCH', body: { given_name: v.given_name, surname: v.surname, aliases, sex: v.sex, living_status: v.living_status || null, birth: String(v.birth).trim(), death: String(v.death).trim(), birth_place: v.birth_place, occupation: v.occupation, location: v.location } });
      let updated = r.person;
      if (newPhoto) { const im = await api('/api/image', { method: 'POST', body: { kind: 'person', ref_id: person.id, content_type: newPhoto.content_type, data: newPhoto.data } }); updated = { ...updated, photo_url: im.url }; }
      else if (removePhoto) { await api(`/api/image?person_id=${person.id}`, { method: 'DELETE' }); updated = { ...updated, photo_url: null }; }
      patchPerson(updated);
      toast('Changes saved successfully.');
      await onSaved();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save changes';
      if (err.status === 401) { toast('Your token is invalid or has expired.', 'error'); window.dispatchEvent(new CustomEvent('token-invalid')); }
      else if (err.status === 422) { toast(err.message, 'error'); }
      else toast('Something went wrong while saving your changes. Please try again.', 'error');
    }
  });
}

export { reportError, errorView };

// ---------------------------------------------------------------- suggest a correction (links)
export function openCorrectionSheet(personId) {
  const person = state.data.people.find((x) => x.id === personId);
  if (!person) return;
  const index = buildIndex();
  const nameOf = (id) => fullName(index.people.get(id));
  const rels = (state.data.relationships || []).filter((r) => r.id && (r.from_person_id === personId || r.to_person_id === personId));
  const label = (r) => {
    if (r.relationship_type === 'spouse') return `Partner: ${nameOf(r.from_person_id === personId ? r.to_person_id : r.from_person_id)}`;
    return r.from_person_id === personId ? `Child: ${nameOf(r.to_person_id)}` : `Parent: ${nameOf(r.from_person_id)}`;
  };
  const s = openSheet(`<div class="sheet-body"><div class="sheet-head"><div><span class="eyebrow">SUGGEST A CORRECTION</span><h2>${esc(fullName(person))}</h2><p class="muted">The tree only changes after the administrator approves, so nothing is lost if you are unsure.</p></div><button class="modal-close" type="button" data-close aria-label="Close">&times;</button></div>
    <form id="rmForm" class="form" novalidate><h3>A link looks wrong</h3>
      <label class="field"><span class="label">Which link?</span><select class="input" name="rel">${rels.length ? rels.map((r) => `<option value="${esc(r.id)}">${esc(label(r))}</option>`).join('') : '<option value="">No links recorded</option>'}</select></label>
      <label class="field"><span class="label">Why is it wrong?</span><textarea class="input" name="reason" rows="3" maxlength="400" placeholder="e.g. She is the daughter of Helena, not of Yaa Brefaa"></textarea><small class="err" data-err="reason"></small></label>
      <div class="sheet-actions"><button class="btn primary" type="submit" ${rels.length ? '' : 'disabled'}>Suggest removing this link</button></div></form>
    <hr class="soft">
    <form id="addForm" class="form" novalidate><h3>A link is missing</h3>
      <label class="field"><span class="label">${esc(person.given_name)} is...</span><select class="input" name="kind"><option value="parent_of">a parent of</option><option value="child_of">a child of</option><option value="spouse">a partner of</option></select></label>
      <div class="field"><span class="label">Who?</span><input id="addSearch" class="input" type="search" placeholder="Search family tree..." autocomplete="off"><div id="addResults" class="results"></div><div id="addPicked" class="muted small">No one selected yet.</div></div>
      <div class="sheet-actions"><button class="btn primary" type="submit">Suggest this link</button></div></form></div>`, { wide: true, label: 'Suggest a correction' });
  $$('[data-close]', s.el).forEach((b) => b.addEventListener('click', s.close));
  const send = async (payload, action) => { const r = await api('/api/proposals', { method: 'POST', body: { action, payload } }); toast(r.message || 'Your suggestion has been sent for approval.'); s.close(); };
  $('#rmForm', s.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target).entries());
    if (String(v.reason || '').trim().length < 5) { $('[data-err="reason"]', s.el).textContent = 'Please tell us briefly why this link is wrong.'; return; }
    try { await send({ relationship_id: v.rel, reason: v.reason }, 'delete_relationship'); } catch (err) { toastError(err); }
  });
  let other = null;
  attachPersonSearch($('#addSearch', s.el), $('#addResults', s.el), { onPick: (p) => { other = p; $('#addPicked', s.el).innerHTML = `Selected: <strong>${esc(fullName(p))}</strong>`; $('#addResults', s.el).innerHTML = ''; } });
  $('#addForm', s.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!other) return toast('Please select a family member first.', 'error');
    const kind = new FormData(e.target).get('kind');
    const payload = kind === 'spouse' ? { from_person_id: personId, to_person_id: other.id, relationship_type: 'spouse' }
      : kind === 'parent_of' ? { from_person_id: personId, to_person_id: other.id, relationship_type: 'parent' }
        : { from_person_id: other.id, to_person_id: personId, relationship_type: 'parent' };
    try { await send(payload, 'add_relationship'); } catch (err) { toastError(err); }
  });
}
