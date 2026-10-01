export const state = {
  token: localStorage.getItem('familyToken') || '',
  me: null,
  data: { people: [], relationships: [] },
  loaded: false,
  adminSecret: '',
  homeRootId: null,
};

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const fullName = (p) => [p?.given_name, p?.surname].filter(Boolean).join(' ') || 'Unnamed';
export const aliasesOf = (p) => [...(p?.aliases || [])].filter(Boolean).map(String).filter((a) => norm(a) !== norm(fullName(p)));
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const safeUrl = (u) => (/^\/api\/image\?id=[0-9a-f-]{36}$/i.test(u || '') || /^https:\/\//i.test(u || '') ? u : '');
export const pluralize = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}
export const fmtWhen = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
export const birthText = (p) => (p.birth_date ? fmtDay(p.birth_date) : p.birth_year ? String(p.birth_year) : '');
export const deathText = (p) => (p.death_date ? fmtDay(p.death_date) : p.death_year ? String(p.death_year) : '');

export function livingClass(p, nowYear = new Date().getFullYear()) {
  if (p.death_year || p.death_date || p.living_status === 'deceased') return 'deceased';
  if (p.living_status === 'living') return 'living';
  if (p.living_status === 'unknown') return 'unknown';
  if (p.birth_year && nowYear - p.birth_year <= 100) return 'presumed_living';
  return 'unknown';
}

export function ageInfo(p) {
  const now = new Date();
  const cls = livingClass(p);
  if (!p.birth_year) return null;
  if (cls === 'deceased') {
    if (!p.death_year) return null;
    const n = p.death_year - p.birth_year;
    return n >= 0 && n <= 125 ? { kind: 'at death', years: n, text: `aged ${n}` } : null;
  }
  if (cls === 'living' || cls === 'presumed_living') {
    let n = now.getFullYear() - p.birth_year;
    if (p.birth_date) {
      const b = new Date(`${p.birth_date}T00:00:00`);
      n = now.getFullYear() - b.getFullYear() - (now < new Date(now.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
    }
    return n >= 0 && n <= 125 ? { kind: 'current', years: n, text: `age ${n}` } : null;
  }
  return null;
}

export function lifeLine(p) {
  const b = birthText(p); const d = deathText(p);
  const age = ageInfo(p);
  if (!b && !d) return 'Dates unknown';
  const span = `${b || '?'}${d ? ` – ${d}` : ''}`;
  return age ? `${span} · ${age.text}` : span;
}

export const genderLabel = (s) => ({ M: 'Male', F: 'Female', O: 'Other', U: 'Unknown' }[s] || 'Unknown');
export const genderClass = (s) => (s === 'M' ? 'male' : s === 'F' ? 'female' : 'unknown');

export function avatar(p, size = 'md') {
  const url = safeUrl(p.photo_url);
  const cls = `avatar avatar-${size} ${genderClass(p.sex)}`;
  if (url) return `<span class="${cls}"><img src="${esc(url)}" alt="" loading="lazy"></span>`;
  return `<span class="${cls} no-photo" aria-hidden="true">${esc((p.given_name || '?').charAt(0).toUpperCase())}</span>`;
}

// ---------- network ----------
export async function api(path, { method = 'GET', body, admin = false, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && /^\d{5}$/.test(state.token)) headers['x-family-token'] = state.token;
  if (admin) headers['x-admin-secret'] = state.adminSecret;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("We couldn't reach the server. Please check your connection and try again.");
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.error || 'Something went wrong. Please try again.');
    e.status = res.status;
    throw e;
  }
  return j;
}

// ---------- toasts ----------
export function toast(message, type = 'success', ms = 4800) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = { success: '✓', error: '!', info: 'i', warn: '!' }[type] || 'i';
  el.innerHTML = `<span class="toast-icon" aria-hidden="true">${icon}</span><span class="toast-text">${esc(message)}</span><button type="button" class="toast-x" aria-label="Dismiss">×</button>`;
  const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); };
  el.querySelector('.toast-x').onclick = remove;
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  if (ms) setTimeout(remove, type === 'error' ? ms + 2500 : ms);
}
export const toastError = (e) => toast(e?.message || 'Something went wrong. Please try again.', 'error');

// ---------- dialogs ----------
export function openSheet(html, { wide = false, label = 'Dialog', onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet ${wide ? 'sheet-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1">${html}</div>`;
  const prev = document.activeElement;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); if (!$('.sheet-wrap')) document.body.classList.remove('sheet-open'); onClose?.(); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape' && wrap === [...document.querySelectorAll('.sheet-wrap')].pop()) close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  document.body.appendChild(wrap);
  document.body.classList.add('sheet-open');
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  const first = wrap.querySelector('[autofocus], input, textarea, select, button.primary') || wrap.querySelector('.sheet');
  setTimeout(() => first?.focus?.({ preventScroll: true }), 30);
  return { el: wrap, sheet: wrap.querySelector('.sheet'), close };
}

export function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const s = openSheet(`<div class="confirm"><h3>${esc(title)}</h3><p>${esc(message)}</p><div class="confirm-actions"><button type="button" class="btn" data-cancel>${esc(cancelText)}</button><button type="button" class="btn ${danger ? 'btn-danger' : 'primary'}" data-ok>${esc(confirmText)}</button></div></div>`, { label: title, onClose: () => finish(false) });
    s.el.classList.add('sheet-confirm');
    s.el.querySelector('[data-cancel]').onclick = () => { finish(false); s.close(); };
    s.el.querySelector('[data-ok]').onclick = () => { finish(true); s.close(); };
    s.el.querySelector('[data-cancel]').focus();
  });
}

// ---------- states ----------
export const loadingView = (msg = 'Loading…') => `<div class="state state-loading" role="status"><span class="spinner" aria-hidden="true"></span><p>${esc(msg)}</p></div>`;
export const emptyView = (title, sub = '', action = '') => `<div class="state state-empty"><div class="state-art" aria-hidden="true">❦</div><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}${action}</div>`;
export const errorView = (msg = "We couldn't load this information. Please try again.", retry = true) => `<div class="state state-error" role="alert"><div class="state-art" aria-hidden="true">!</div><h3>Something went wrong</h3><p>${esc(msg)}</p>${retry ? '<button type="button" class="btn primary" data-retry>Try again</button>' : ''}</div>`;

export function setHelp(text) { return `<span class="tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}">?</span>`; }

// ---------- family graph ----------
export function buildIndex() {
  const people = new Map((state.data.people || []).map((p) => [p.id, p]));
  const parents = new Map(); const children = new Map(); const spouses = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const r of state.data.relationships || []) {
    if (r.relationship_type === 'parent') { push(parents, r.to_person_id, r.from_person_id); push(children, r.from_person_id, r.to_person_id); }
    else if (r.relationship_type === 'spouse') { push(spouses, r.from_person_id, r.to_person_id); push(spouses, r.to_person_id, r.from_person_id); }
  }
  for (const m of [parents, children, spouses]) for (const [k, v] of m) m.set(k, [...new Set(v)]);
  return { people, parents, children, spouses };
}

export async function loadTree(force = false) {
  if (state.loaded && !force) return state.data;
  state.data = await api('/api/tree', { auth: false });
  state.loaded = true;
  return state.data;
}

export function patchPerson(updated) {
  const i = state.data.people.findIndex((p) => p.id === updated.id);
  if (i >= 0) state.data.people[i] = { ...state.data.people[i], ...updated };
}

export function reportError(root, e, retry) {
  root.innerHTML = errorView(e?.message, !!retry);
  root.querySelector('[data-retry]')?.addEventListener('click', retry);
}

export function pager({ page, limit, total }, attr = 'data-page') {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return '';
  return `<nav class="pager" aria-label="Pagination"><button type="button" class="btn" ${attr}="${page - 1}" ${page <= 1 ? 'disabled' : ''}>← Previous</button><span>Page ${page} of ${pages}</span><button type="button" class="btn" ${attr}="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next →</button></nav>`;
}

// Downscales a picked image in the browser so uploads stay small and fast.
export function prepareImage(file, max = 800) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Please choose an image.'));
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error('Please choose a JPEG, PNG or WebP image.'));
    if (file.size > 12 * 1024 * 1024) return reject(new Error('That image is too large. Please choose one under 12 MB.'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const data = c.toDataURL('image/jpeg', 0.86);
      resolve({ content_type: 'image/jpeg', data: data.split(',')[1], preview: data });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
    img.src = url;
  });
}
