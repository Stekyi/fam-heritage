import { state, $, $$, esc, api, toast, toastError, openSheet, fullName, avatar, lifeLine, patchPerson, buildIndex, safeUrl, livingClass } from './core.js';

const OUT = 600; const VIEW = 280;
const canEdit = () => !!state.me?.valid;

// ---------- one-tap photo ----------
export function photoBtn(p, size = 'xl') {
  const has = !!safeUrl(p.photo_url);
  return `<button type="button" class="photo-btn" data-photo-person="${esc(p.id)}" aria-label="${has ? 'Change' : 'Add'} photo of ${esc(fullName(p))}">${avatar(p, size)}<span class="photo-badge" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></span>${has ? '' : '<span class="photo-add">Add photo</span>'}</button>`;
}

async function decode(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Please choose a JPEG, PNG or WebP photo.');
  if (file.size > 20 * 1024 * 1024) throw new Error('That photo is too large. Please choose one under 20 MB.');
  if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back */ } }
  const url = URL.createObjectURL(file);
  try { return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file could not be read as a photo.')); i.src = url; }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}

export function openPhotoSheet(personId, onDone) {
  const p = state.data.people.find((x) => x.id === personId);
  if (!p) return toast('Unable to find this family member.', 'error');
  const s = openSheet(`<div class="sheet-body photo-sheet"><div class="sheet-head"><div><span class="eyebrow">PHOTO</span><h2>${esc(fullName(p))}</h2></div><button class="modal-close" type="button" data-close aria-label="Close">\u00d7</button></div>
    <div id="phPick" class="photo-pick"><label class="btn primary photo-opt">Take a photo<input type="file" id="phCam" accept="image/jpeg,image/png,image/webp" capture="environment" hidden></label>
      <label class="btn photo-opt">Choose from gallery<input type="file" id="phFile" accept="image/jpeg,image/png,image/webp" hidden></label>
      <p class="muted small">Old family pictures work too: photograph a printed photo, or choose a scan.</p>${canEdit() ? '' : '<label class="field"><span class="label">Your name (so the family knows who sent it)</span><input class="input" id="phName" maxlength="80" autocomplete="name" placeholder="e.g. Efua, Kofi\u2019s daughter"></label><p class="muted small">A family member will check your photo before it appears.</p>'}</div>
    <div id="phEdit" hidden><div class="crop-wrap"><canvas id="phCanvas" width="${VIEW}" height="${VIEW}" aria-label="Photo preview. Drag to position."></canvas><div class="crop-ring" aria-hidden="true"></div></div>
      <label class="field"><span class="label">Zoom</span><input type="range" id="phZoom" min="1" max="4" step="0.01" value="1"></label>
      <p class="muted small">Drag the picture so the face is inside the circle.</p>
      <div class="sheet-actions"><button class="btn" type="button" id="phAgain">Choose another</button><button class="btn primary" type="button" id="phSave">Save photo</button></div></div></div>`, { label: `Photo of ${fullName(p)}` });
  const root = s.el;
  const cv = $('#phCanvas', root); const ctx = cv.getContext('2d');
  let img = null; let zoom = 1; let ox = 0; let oy = 0;

  const cover = (size) => Math.max(size / img.width, size / img.height);
  const clamp = (size) => { const sc = cover(size) * zoom; const mx = Math.max(0, (img.width * sc - size) / 2); const my = Math.max(0, (img.height * sc - size) / 2); ox = Math.min(mx, Math.max(-mx, ox)); oy = Math.min(my, Math.max(-my, oy)); return sc; };
  const paint = (c, size, k = 1) => {
    const sc = clamp(VIEW) * (size / VIEW);
    const x = (size - img.width * sc) / 2 + ox * k; const y = (size - img.height * sc) / 2 + oy * k;
    c.fillStyle = '#fff'; c.fillRect(0, 0, size, size); c.drawImage(img, x, y, img.width * sc, img.height * sc);
  };
  const draw = () => paint(ctx, VIEW);

  const load = async (file) => {
    if (!file) return;
    try {
      img = await decode(file); zoom = 1; ox = 0;
      const sc = cover(VIEW); oy = Math.max(0, (img.height * sc - VIEW) / 2) * 0.55; // portraits: favour the upper part, where faces usually are
      $('#phZoom', root).value = '1'; $('#phPick', root).hidden = true; $('#phEdit', root).hidden = false; draw();
    } catch (e) { toastError(e); }
  };
  $('#phCam', root).onchange = (e) => load(e.target.files[0]);
  $('#phFile', root).onchange = (e) => load(e.target.files[0]);
  $('#phAgain', root).onclick = () => { $('#phPick', root).hidden = false; $('#phEdit', root).hidden = true; img = null; $('#phCam', root).value = ''; $('#phFile', root).value = ''; };
  $('#phZoom', root).oninput = (e) => { zoom = Number(e.target.value); draw(); };

  let drag = null;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, ox, oy }; });
  cv.addEventListener('pointermove', (e) => { if (!drag || !img) return; const k = VIEW / cv.getBoundingClientRect().width; ox = drag.ox + (e.clientX - drag.x) * k; oy = drag.oy + (e.clientY - drag.y) * k; draw(); });
  const end = () => { drag = null; }; cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('wheel', (e) => { if (!img) return; e.preventDefault(); zoom = Math.min(4, Math.max(1, zoom - e.deltaY / 500)); $('#phZoom', root).value = String(zoom); draw(); }, { passive: false });

  $('#phSave', root).onclick = async (e) => {
    if (!img) return; const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Saving\u2026';
    try {
      const out = document.createElement('canvas'); out.width = OUT; out.height = OUT;
      paint(out.getContext('2d'), OUT, OUT / VIEW);
      const data = out.toDataURL('image/jpeg', 0.86).split(',')[1];
      const member = canEdit();
      const r = await api('/api/image', { method: 'POST', auth: member, body: { kind: 'person', ref_id: p.id, content_type: 'image/jpeg', data, ...(member ? {} : { submitter: $('#phName', root)?.value.trim() || '' }) } });
      if (r.pending) { toast(`Thank you! Your photo of ${fullName(p)} will appear once the family has approved it.`, 'success', 8000); s.close(); return; }
      patchPerson({ id: p.id, photo_url: r.url });
      window.dispatchEvent(new CustomEvent('person-updated', { detail: { id: p.id } }));
      toast(`Photo saved for ${fullName(p)}.`);
      s.close(); onDone?.(r.url);
    } catch (err) { toastError(err); btn.disabled = false; btn.textContent = 'Save photo'; }
  };
  return s;
}

// Photos offered by visitors wait here. Elders see this panel on the Photos page; the administrator sees it in Admin.
export async function reviewPanel(el, { admin = false } = {}) {
  const hdr = admin ? { 'x-admin-secret': state.adminSecret } : { 'x-family-token': state.token };
  let list;
  try { list = (await api('/api/photos', { admin, auth: !admin })).pending; } catch { el.innerHTML = ''; return; }
  const urls = [];
  const draw = async () => {
    if (!list.length) { el.innerHTML = admin ? '<p class="muted">No photos are waiting.</p>' : ''; return; }
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
    const blobs = await Promise.all(list.map(async (x) => { try { const r = await fetch(`/api/image?id=${x.id}`, { headers: hdr }); if (!r.ok) return ''; const u = URL.createObjectURL(await r.blob()); urls.push(u); return u; } catch { return ''; } }));
    el.innerHTML = `<div class="review-box"><h3>Photos waiting for approval (${list.length})</h3>${list.map((x, i) => `<div class="review-row"><img src="${esc(blobs[i])}" alt="Photo offered for ${esc(x.person_name)}" width="84" height="84"><div><strong>${esc(x.person_name)}</strong><small class="muted block">from ${esc(x.submitter || 'a visitor')}</small></div><div class="row-actions"><button class="btn primary" type="button" data-ok="${esc(x.id)}">Approve</button><button class="btn" type="button" data-no="${esc(x.id)}">Reject</button></div></div>`).join('')}</div>`;
    const act = async (id, action) => { try { const r = await api('/api/photos', { method: 'POST', admin, auth: !admin, body: { id, action } }); const item = list.find((y) => y.id === id); list = list.filter((y) => y.id !== id); if (action === 'approve') { patchPerson({ id: item.person_id, photo_url: r.url }); toast('Photo approved.'); } else toast('Photo rejected.', 'info'); draw(); } catch (e) { toastError(e); } };
    $$('[data-ok]', el).forEach((b) => { b.onclick = () => act(b.dataset.ok, 'approve'); });
    $$('[data-no]', el).forEach((b) => { b.onclick = () => act(b.dataset.no, 'reject'); });
  };
  await draw();
}

export function initPhoto() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-photo-person]'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    openPhotoSheet(b.dataset.photoPerson, () => { const img = b.querySelector('.avatar'); if (img) { const p = state.data.people.find((x) => x.id === b.dataset.photoPerson); if (p) b.outerHTML = photoBtn(p, b.querySelector('.avatar-xxl') ? 'xxl' : 'xl'); } });
  });
}

// ---------- photo drive ----------
const PAGE = 30;
function descendants(index, id, memo) {
  if (memo.has(id)) return memo.get(id);
  memo.set(id, 0); // guards against cycles
  let n = 0; for (const c of index.children.get(id) || []) n += 1 + descendants(index, c, memo);
  memo.set(id, n); return n;
}

export function renderPhotos(root) {
  const index = buildIndex();
  const memo = new Map();
  let sort = 'connected'; let q = ''; let shown = PAGE;
  const hint = (p) => { const real = (id) => { const x = index.people.get(id); return x && (x.kind || 'person') === 'person' ? fullName(x) : ''; }; const par = (index.parents.get(p.id) || []).map(real).filter(Boolean); if (par.length) return `Child of ${par.slice(0, 2).join(' and ')}`; const sp = (index.spouses.get(p.id) || []).map(real).filter(Boolean); return sp.length ? `Married to ${sp[0]}` : ''; };

  const view = () => {
    const everyone = state.data.people.filter((p) => (p.kind || 'person') === 'person');
    const have = everyone.filter((p) => safeUrl(p.photo_url)).length;
    const total = everyone.length; const pct = total ? Math.round((have / total) * 100) : 0;
    let list = everyone.filter((p) => !safeUrl(p.photo_url));
    if (q) { const n = q.toLowerCase(); list = list.filter((p) => `${fullName(p)} ${(p.aliases || []).join(' ')}`.toLowerCase().includes(n)); }
    const live = (p) => (['living', 'presumed_living'].includes(livingClass(p)) ? 0 : 1);
    if (sort === 'living') list.sort((a, b) => live(a) - live(b) || descendants(index, b.id, memo) - descendants(index, a.id, memo));
    else if (sort === 'az') list.sort((a, b) => fullName(a).localeCompare(fullName(b)));
    else list.sort((a, b) => descendants(index, b.id, memo) - descendants(index, a.id, memo) || fullName(a).localeCompare(fullName(b)));
    const page = list.slice(0, shown);
    root.innerHTML = `<section class="content"><div class="card photo-drive"><div id="phReview"></div><span class="eyebrow">PHOTO DRIVE</span><h2>Put a face to every name</h2>
      <p class="muted">${have} of ${total} family members have a photo. Pick a name below and add one. Old pictures count: photograph a printed photo.</p>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Photos added"><span style="width:${pct}%"></span></div><p class="small muted">${pct}% complete${canEdit() ? '' : ' \u00b7 Photos you add are checked by the family before they appear'}</p>
      <div class="photo-tools"><input class="input" id="phQ" type="search" placeholder="Search a name" value="${esc(q)}" aria-label="Search a name"><div class="chips" role="group" aria-label="Sort">${[['connected', 'Most connected'], ['living', 'Living first'], ['az', 'A to Z']].map(([k, l]) => `<button type="button" class="chip ${sort === k ? 'on' : ''}" data-sort="${k}" aria-pressed="${sort === k}">${l}</button>`).join('')}</div></div>
      <div id="phList">${page.length ? page.map((p) => `<div class="photo-row"><div class="photo-who">${avatar(p, 'md')}<span><strong>${esc(fullName(p))}</strong><small class="muted">${esc([lifeLine(p) !== 'Dates unknown' ? lifeLine(p) : '', hint(p)].filter(Boolean).join(' \u00b7 '))}</small></span></div><button class="btn primary" type="button" data-add="${esc(p.id)}">Add photo</button></div>`).join('') : `<p class="photo-done">${total && !list.length && !q ? '\ud83c\udf89 Everyone has a photo. Thank you!' : 'No one matches that search.'}</p>`}</div>
      ${list.length > shown ? `<div class="sheet-actions"><button class="btn" type="button" id="phMore">Show more (${list.length - shown} left)</button></div>` : ''}</div></section>`;
    if (state.me?.valid && state.me.role === 'elder') reviewPanel($('#phReview', root));
    $('#phQ', root).oninput = (e) => { q = e.target.value.trim(); shown = PAGE; const pos = e.target.selectionStart; view(); const n = $('#phQ', root); n.focus(); n.setSelectionRange(pos, pos); };
    $$('[data-sort]', root).forEach((b) => { b.onclick = () => { sort = b.dataset.sort; shown = PAGE; view(); }; });
    $('#phMore', root)?.addEventListener('click', () => { shown += PAGE; view(); });
    $$('[data-add]', root).forEach((b) => { b.onclick = () => openPhotoSheet(b.dataset.add, () => view()); });
  };
  view();
  const again = () => { if (location.hash.startsWith('#/photos') && root.querySelector('.photo-drive')) view(); };
  window.addEventListener('me-changed', again, { once: true });
}
