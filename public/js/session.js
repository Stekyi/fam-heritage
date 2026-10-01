import { state, api } from './core.js';

export function setToken(v) {
  state.token = String(v || '').replace(/\D/g, '').slice(0, 5);
  localStorage.setItem('familyToken', state.token);
  state.me = null;
}

// Validates the token with the server and loads the linked family member (if any).
export async function refreshMe() {
  if (!/^\d{5}$/.test(state.token)) { state.me = null; window.dispatchEvent(new CustomEvent('me-changed')); return null; }
  try {
    const r = await api('/api/me');
    state.me = { valid: true, label: r.token?.label, linked_person: r.linked_person };
  } catch (e) {
    state.me = e.status === 401 ? { valid: false } : state.me;
  }
  window.dispatchEvent(new CustomEvent('me-changed'));
  return state.me;
}
