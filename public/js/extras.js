import { state, $, toast, api } from './core.js';
import { t, getLang, setLang, applyLang } from './i18n.js';

const swPost = (msg) => navigator.serviceWorker?.controller?.postMessage(msg);

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Contributor-only data must not outlive the token that unlocked it.
  window.addEventListener('token-changed', () => swPost('clear-private'));
  window.addEventListener('me-changed', () => { if (!state.me?.valid) swPost('clear-private'); });
}

function offlineBanner() {
  const bar = document.createElement('div');
  bar.id = 'offlineBar'; bar.setAttribute('role', 'status'); bar.hidden = true; bar.dataset.i18n = 'offline'; bar.textContent = t('offline');
  document.body.prepend(bar);
  const sync = () => { bar.hidden = navigator.onLine; };
  window.addEventListener('online', sync); window.addEventListener('offline', sync); sync();
}

let installEvent = null;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;

function buildTools() {
  const bar = $('.topbar');
  const tools = document.createElement('div');
  tools.className = 'app-tools';
  tools.innerHTML = `<button type="button" id="toolMe" hidden data-i18n="me">${t('me')}</button>
    <button type="button" id="toolInstall" hidden data-i18n="install">${t('install')}</button>
    <button type="button" id="toolPush" hidden aria-pressed="false" data-i18n="notify">${t('notify')}</button>
    <button type="button" id="toolSimple" aria-pressed="false" data-i18n="simple">${t('simple')}</button>
    <button type="button" id="toolLang" data-i18n="lang">${t('lang')}</button>
    <button type="button" id="toolPrint" data-i18n="print">${t('print')}</button>`;
  bar.appendChild(tools);

  $('#toolLang').onclick = () => { setLang(getLang() === 'en' ? 'tw' : 'en'); };
  $('#toolPrint').onclick = () => window.print();

  const applySimple = (on) => { document.documentElement.classList.toggle('simple', on); $('#toolSimple').setAttribute('aria-pressed', String(on)); localStorage.setItem('heritageSimple', on ? '1' : '0'); };
  applySimple(localStorage.getItem('heritageSimple') === '1');
  $('#toolSimple').onclick = () => applySimple(!document.documentElement.classList.contains('simple'));

  const me = $('#toolMe');
  const syncMe = () => { me.hidden = !state.me?.linked_person; };
  window.addEventListener('me-changed', syncMe); syncMe();
  me.onclick = () => { const p = state.me?.linked_person; if (p) location.hash = `#/tree/${p.id}`; };

  setupPush();
  const inst = $('#toolInstall');
  if (!isStandalone()) {
    if (isIos) inst.hidden = false;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; inst.hidden = false; });
  }
  window.addEventListener('appinstalled', () => { inst.hidden = true; toast('The app is installed.', 'success'); });
  inst.onclick = async () => {
    if (installEvent) { installEvent.prompt(); await installEvent.userChoice.catch(() => {}); installEvent = null; inst.hidden = true; }
    else if (isIos) toast('On iPhone: tap the Share icon, then "Add to Home Screen".', 'info', 9000);
  };
}

// Notifications: birthdays, remembrance days and new stories. The button only appears when the site has notifications switched on.
const b64ToBytes = (s) => { const pad = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
async function setupPush() {
  const btn = $('#toolPush');
  if (!btn || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  let cfg; try { cfg = await api('/api/push', { auth: false }); } catch { return; }
  if (!cfg.enabled || !cfg.publicKey) return;
  const reg = await navigator.serviceWorker.ready;
  const sync = async () => { const on = !!(await reg.pushManager.getSubscription()); btn.setAttribute('aria-pressed', String(on)); btn.textContent = on ? t('notifyOn') : t('notify'); };
  btn.hidden = false; await sync();
  window.addEventListener('lang-changed', sync);
  btn.onclick = async () => {
    const existing = await reg.pushManager.getSubscription();
    try {
      if (existing) { await api('/api/push', { method: 'DELETE', body: { endpoint: existing.endpoint } }); await existing.unsubscribe(); toast('Notifications are off.', 'info'); }
      else {
        if ((await Notification.requestPermission()) !== 'granted') return toast('Please allow notifications in your browser settings.', 'error');
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.publicKey) });
        const r = await api('/api/push', { method: 'POST', body: { subscription: sub.toJSON() } });
        toast(r.contributor ? 'Notifications are on, including family birthdays.' : 'Notifications are on. Enter your token to also get birthdays.', 'success');
      }
    } catch (e) { toast(e.message || 'Notifications could not be changed.', 'error'); }
    sync();
  };
  // A new token means birthday notifications need re-subscribing so the server knows who this is.
  window.addEventListener('me-changed', async () => { if (state.me?.valid) { const s = await reg.pushManager.getSubscription(); if (s) api('/api/push', { method: 'POST', body: { subscription: s.toJSON() } }).catch(() => {}); } });
}

// A share button inside each person's sheet sends a link whose preview names the person on WhatsApp.
function bindShare() {
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-share-person]'); if (!b) return;
    const url = `${location.origin}/share?id=${encodeURIComponent(b.dataset.sharePerson)}`;
    const title = b.dataset.shareName ? `${b.dataset.shareName} · Our Family Heritage` : 'Our Family Heritage';
    try {
      if (navigator.share) await navigator.share({ title, text: title, url });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(url); toast('Link copied. Paste it into WhatsApp.', 'success'); }
      else window.open(`https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}`, '_blank', 'noopener');
    } catch { /* share dismissed */ }
  });
}

// Phone-style bottom tab bar for the four most-used sections, with "More" opening the full menu.
function buildTabbar() {
  const bar = document.createElement('nav');
  bar.id = 'tabbar'; bar.setAttribute('aria-label', 'Main');
  const ico = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const items = [
    ['tree', 'tree', ico('<path d="M12 21v-8"/><circle cx="12" cy="8" r="5"/><path d="M12 15l-3-2M12 13l3-2"/>')],
    ['history', 'history', ico('<path d="M4 5h11a3 3 0 0 1 3 3v11H7a3 3 0 0 1-3-3z"/><path d="M8 9h6M8 13h6"/>')],
    ['relate', 'relate', ico('<circle cx="7" cy="8" r="3"/><circle cx="17" cy="8" r="3"/><path d="M4 20c0-3 2-5 5-5M20 20c0-3-2-5-5-5M10 17h4"/>')],
    ['network', 'network', ico('<circle cx="12" cy="12" r="2.5"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="20" r="2"/><path d="M7 7l3.5 3.5M17 7l-3.5 3.5M12 14.5V18"/>')],
  ];
  bar.innerHTML = items.map(([r, k, svg]) => `<a href="#/${r}" data-tab="${r}">${svg}<span data-i18n="tab_${k}">${t('tab_' + k)}</span></a>`).join('')
    + `<button type="button" id="tabMore" aria-expanded="false">${ico('<path d="M4 7h16M4 12h16M4 17h16"/>')}<span data-i18n="tab_more">${t('tab_more')}</span></button>`;
  document.body.appendChild(bar);
  const mark = () => { const r = (location.hash.replace(/^#\/?/, '') || 'tree').split('/')[0]; bar.querySelectorAll('a').forEach((a) => { const on = a.dataset.tab === r || (r === 'person' && a.dataset.tab === 'tree') || (r === 'story' && a.dataset.tab === 'history'); a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }); };
  window.addEventListener('hashchange', mark); mark();
  $('#tabMore').onclick = () => { $('#menuBtn').click(); const open = $('#nav').classList.contains('open'); $('#tabMore').setAttribute('aria-expanded', String(open)); if (open) window.scrollTo({ top: 0, behavior: 'smooth' }); };
}

export function initExtras() {
  document.documentElement.lang = getLang() === 'tw' ? 'tw' : 'en';
  buildTools(); buildTabbar(); offlineBanner(); registerWorker(); bindShare(); applyLang();
}
