// Draft Twi labels for the main navigation. Please have an elder review them before wide release.
const DICT = {
  en: { tree: 'Family Tree', history: 'Family History', network: 'Network', analysis: 'Analysis', relate: 'Relationship', journey: 'Our Journey', contribute: 'Contribute', admin: 'Admin',
    brand: 'Our Family Heritage', token: 'Token', install: 'Install app', print: 'Print', share: 'Share', me: 'My place', simple: 'Large text', offline: 'You are offline. Showing saved family information.', lang: 'Twi' },
  tw: { tree: 'Abusua Dua', history: 'Abusua Abakɔsɛm', network: 'Abusua Nkitahodi', analysis: 'Akontaabu', relate: 'Abusua Ntam', journey: 'Yɛn Akwantuo', contribute: 'Boa', admin: 'Admin',
    brand: 'Yɛn Abusua Agyapadeɛ', token: 'Token', install: 'Fa app no si', print: 'Tintim', share: 'Kyɛ', me: 'Me gyinabea', simple: 'Nkyerɛwee akɛse', offline: 'Wonni intanɛt. Ɛno nti na wo hwɛ nsɛm a ɛwɔ hɔ dedaw.', lang: 'English' },
};
let lang = localStorage.getItem('heritageLang') === 'tw' ? 'tw' : 'en';
export const getLang = () => lang;
export const t = (k) => DICT[lang][k] || DICT.en[k] || k;
export function setLang(l) { lang = l === 'tw' ? 'tw' : 'en'; localStorage.setItem('heritageLang', lang); document.documentElement.lang = lang === 'tw' ? 'tw' : 'en'; applyLang(); }
export function applyLang() {
  document.querySelectorAll('#nav a[data-route]').forEach((a) => { a.textContent = t(a.dataset.route); });
  const b = document.querySelector('.brand-text strong'); if (b) b.textContent = t('brand');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { const v = t(el.dataset.i18nTitle); el.title = v; el.setAttribute('aria-label', v); });
}
