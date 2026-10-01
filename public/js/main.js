import { state, $, $$, esc, api, toast, toastError, loadTree, loadingView, errorView, fullName } from './core.js';
import { setToken, refreshMe } from './session.js';
import { renderTreePage, closeTreeModal, ensureHomeRoot } from './tree.js';
import { renderHistory, renderStory, renderPerson, renderContribute } from './pages-content.js';
import { renderNetwork, renderAnalysis } from './pages-network.js';
import { renderAdmin } from './pages-admin.js';

const view = $('#view');
// A broken photo falls back to the initial (no inline handlers, so a strict CSP can be used).
document.addEventListener('error', (e) => { const i = e.target; if (i?.tagName === 'IMG' && i.closest('.avatar')) { i.parentNode.classList.add('no-photo'); i.remove(); } }, true);
let routeSeq = 0;

const parse = () => {
  const parts = (location.hash.replace(/^#\/?/, '') || 'tree').split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'tree', arg: parts[1] };
};

async function route() {
  const my = ++routeSeq;
  const { name, arg } = parse();
  closeTreeModal();
  $$('.sheet-wrap').forEach((s) => s.remove()); document.body.classList.remove('sheet-open');
  $$('#nav a').forEach((a) => { const on = a.dataset.route === (name === 'person' ? 'tree' : name === 'story' ? 'history' : name); a.classList.toggle('active', on); a.toggleAttribute('aria-current', on); if (!on) a.removeAttribute('aria-current'); else a.setAttribute('aria-current', 'page'); });
  $('#nav').classList.remove('open'); $('#menuBtn').setAttribute('aria-expanded', 'false');
  window.scrollTo(0, 0);
  const needsTree = ['tree', 'person', 'contribute'].includes(name);
  if (needsTree && !state.loaded) {
    view.innerHTML = loadingView(name === 'tree' ? 'Loading the family tree…' : 'Loading…');
    try { await loadTree(); ensureHomeRoot(); } catch (e) {
      if (my !== routeSeq) return;
      view.innerHTML = errorView(e.message); $('[data-retry]', view)?.addEventListener('click', route); return;
    }
    if (my !== routeSeq) return;
  }
  document.title = { tree: 'Family Tree', person: 'Family member', history: 'Family History', story: 'Story', network: 'Network', analysis: 'Analysis', contribute: 'Contribute', admin: 'Admin' }[name] ? `${{ tree: 'Family Tree', person: 'Family member', history: 'Family History', story: 'Story', network: 'Network', analysis: 'Analysis', contribute: 'Contribute', admin: 'Administration' }[name]} · Our Family Heritage` : 'Our Family Heritage';
  switch (name) {
    case 'person': return renderPerson(view, arg);
    case 'history': return renderHistory(view, arg === 'stories' ? 'stories' : 'clan');
    case 'story': return renderStory(view, arg);
    case 'network': return renderNetwork(view, arg === 'ideas' ? 'ideas' : 'people');
    case 'analysis': return renderAnalysis(view);
    case 'contribute': return renderContribute(view);
    case 'admin': return renderAdmin(view);
    default: return renderTreePage(view, name === 'tree' ? arg : undefined);
  }
}

// ---------- token control ----------
function updateChip() {
  const chip = $('#tokenChip'); const box = $('.token-box');
  box.classList.remove('ok', 'bad');
  if (!state.token) { chip.textContent = 'Public view'; chip.title = 'You are viewing a public family profile. You need a contributor token to make changes.'; return; }
  if (state.token.length < 5) { chip.textContent = 'Enter 5 digits'; return; }
  if (!state.me) { chip.textContent = 'Checking…'; return; }
  if (!state.me.valid) { chip.textContent = 'Invalid token'; box.classList.add('bad'); chip.title = 'Your token is invalid or has expired.'; return; }
  box.classList.add('ok');
  chip.textContent = state.me.linked_person ? `✓ ${fullName(state.me.linked_person)}` : '✓ Contributor';
  chip.title = state.me.linked_person ? 'Your token is linked to this family member.' : 'Token accepted. Link it to yourself in Contribute → My Family Profile.';
}

const tokenInput = $('#tokenInput');
tokenInput.value = state.token;
let announced = false;
tokenInput.addEventListener('input', async (e) => {
  setToken(e.target.value); e.target.value = state.token; updateChip();
  if (state.token.length === 5) {
    const me = await refreshMe();
    if (me?.valid) { if (!announced) toast(me.linked_person ? `Welcome back, ${me.linked_person.given_name}.` : 'Token accepted. You can now edit family members.', 'success'); announced = true; }
    else toast('Your token is invalid or has expired.', 'error');
  } else announced = false;
});

window.addEventListener('me-changed', () => {
  updateChip();
  if (parse().name === 'contribute' && !$('.sheet-wrap')) renderContribute(view);
});
window.addEventListener('token-invalid', () => { state.me = { valid: false }; updateChip(); });
window.addEventListener('hashchange', route);
$('#menuBtn').addEventListener('click', () => { const open = $('#nav').classList.toggle('open'); $('#menuBtn').setAttribute('aria-expanded', String(open)); });
$('#clearToken').addEventListener('click', () => { setToken(''); tokenInput.value = ''; announced = false; window.dispatchEvent(new CustomEvent('me-changed')); toast('Your token has been cleared from this browser.', 'info'); });

updateChip();
route();
if (state.token.length === 5) refreshMe().then(() => { announced = true; });
