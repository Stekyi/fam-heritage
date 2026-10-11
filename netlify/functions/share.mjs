import { getDb, json, isUuid, PERSON_SELECT } from '../lib/db.mjs';
import { livingClass } from '../lib/people.mjs';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Opens in WhatsApp/Facebook previews with the person's name, then sends visitors on to the app.
// Living people are shown by name only; no dates or places are exposed.
export async function handler(event) {
  const id = event.queryStringParameters?.id;
  const base = (process.env.SITE_URL || process.env.URL || `https://${event.headers?.host || ''}`).replace(/\/$/, '');
  let title = 'Our Family Heritage';
  let desc = 'The family tree, history and stories of the Asankran clan.';
  let target = `${base}/`;
  if (isUuid(id)) {
    const pool = await getDb();
    const r = pool ? await pool.query(`select ${PERSON_SELECT} from people where id=$1`, [id]).catch(() => null) : null;
    const p = r?.rows?.[0];
    if (p) {
      const name = [p.given_name, p.surname].filter(Boolean).join(' ');
      title = `${name} · Our Family Heritage`;
      desc = livingClass(p) === 'deceased' && (p.birth_year || p.death_year)
        ? `${name} (${p.birth_year || '?'} – ${p.death_year || '?'}). Find them on the Asankran family tree.`
        : `Find ${name} on the Asankran family tree.`;
      target = `${base}/#/tree/${id}`;
    }
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(base)}/icons/share.png"><meta property="og:url" content="${esc(target)}">
<meta name="twitter:card" content="summary"><meta http-equiv="refresh" content="0;url=${esc(target)}"></head>
<body><p><a href="${esc(target)}">Open Our Family Heritage</a></p></body></html>`;
  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, body: html };
}
