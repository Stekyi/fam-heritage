import { createRequire } from 'node:module';

// Web Push. Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (mailto:...). Without them nothing is sent.
let transport = null;
export const setPushTransport = (fn) => { transport = fn; };
export const pushConfigured = () => !!transport || !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY || null;

async function send(sub, payload) {
  if (transport) return transport(sub, payload);
  const webpush = createRequire(import.meta.url)('web-push');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.invalid', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 86400 });
}

// contributorOnly: only people holding a valid contributor token (used for birthdays of living relatives).
export async function pushToAll(pool, payload, { contributorOnly = false } = {}) {
  if (!pushConfigured()) return { sent: 0, removed: 0 };
  const subs = (await pool.query(`select id,endpoint,p256dh,auth from push_subscriptions ${contributorOnly ? 'where contributor=true' : ''} limit 5000`)).rows;
  let sent = 0; const dead = [];
  for (const s of subs) {
    try { await send(s, payload); sent += 1; } catch (e) { if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.id); }
  }
  if (dead.length) await pool.query('delete from push_subscriptions where id = any($1::uuid[])', [dead]);
  return { sent, removed: dead.length };
}
