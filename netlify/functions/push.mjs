import { getDb, json, NO_DB, parseBody, optionalToken } from '../lib/db.mjs';
import { vapidPublicKey, pushConfigured } from '../lib/push.mjs';

const MAX_SUBS = 5000;

export async function handler(event) {
  const pool = await getDb(); if (!pool) return NO_DB();

  if (event.httpMethod === 'GET') return json(200, { enabled: pushConfigured(), publicKey: vapidPublicKey() });

  const b = parseBody(event); if (!b) return json(400, { error: 'Invalid request.' });

  if (event.httpMethod === 'POST') {
    if (!pushConfigured()) return json(503, { error: 'Notifications are not switched on for this site yet.' });
    const s = b.subscription || {};
    const endpoint = String(s.endpoint || '');
    if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint) || !s.keys?.p256dh || !s.keys?.auth) return json(422, { error: 'That notification subscription is not valid.' });
    const total = await pool.query('select count(*)::int as n from push_subscriptions');
    if (total.rows[0].n >= MAX_SUBS) return json(429, { error: 'Notifications are full right now. Please try later.' });
    const token = await optionalToken(event, pool);
    await pool.query(
      `insert into push_subscriptions(endpoint,p256dh,auth,token_id,contributor) values($1,$2,$3,$4,$5)
       on conflict (endpoint) do update set p256dh=excluded.p256dh, auth=excluded.auth, token_id=excluded.token_id, contributor=excluded.contributor`,
      [endpoint, String(s.keys.p256dh).slice(0, 200), String(s.keys.auth).slice(0, 100), token?.id || null, !!token]);
    return json(201, { ok: true, contributor: !!token });
  }
  if (event.httpMethod === 'DELETE') {
    await pool.query('delete from push_subscriptions where endpoint=$1', [String(b.endpoint || '')]);
    return json(200, { ok: true });
  }
  return json(405, { error: 'Method not allowed' });
}
