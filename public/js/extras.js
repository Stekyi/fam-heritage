import { state, $, toast } from './core.js';
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

export function initExtras() {
  document.documentElement.lang = getLang() === 'tw' ? 'tw' : 'en';
  buildTools(); offlineBanner(); registerWorker(); bindShare(); applyLang();
}
