import { clientIp } from './db.mjs';

// Sends an alert to the administrator through Resend. Never throws and never blocks a request for long.
// Needs RESEND_API_KEY and ADMIN_EMAIL; MAIL_FROM and SITE_URL are optional. Without them it does nothing.
let transport = null;
export function setMailTransport(fn) { transport = fn; }

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const siteUrl = () => String(process.env.SITE_URL || process.env.URL || '').replace(/\/$/, '');

export function mailConfigured() { return !!transport || !!(process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL); }

async function underBudget(pool) {
  const ins = await pool.query("insert into token_attempts(ip) values('mail:admin') returning id");
  const n = await pool.query("select count(*)::int as n from token_attempts where ip='mail:admin' and attempted_at > now()-interval '1 hour'");
  if (n.rows[0].n > 20) { await pool.query('delete from token_attempts where id=$1', [ins.rows[0].id]).catch(() => {}); return false; }
  return true;
}

export function renderMail({ heading, lines = [], link = '', linkText = 'Open administration' }) {
  const body = lines.map((l) => `<p style="margin:0 0 10px">${escHtml(l)}</p>`).join('');
  const url = link ? `<p style="margin:16px 0 0"><a href="${escHtml(link)}" style="background:#17352f;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${escHtml(linkText)}</a></p>` : '';
  return `<div style="font-family:Georgia,serif;max-width:560px;margin:auto;color:#263731"><h2 style="color:#17352f;margin:0 0 14px">${escHtml(heading)}</h2>${body}${url}<p style="color:#8a8f89;font-size:12px;margin-top:22px">Our Family Heritage administrator notice</p></div>`;
}

// `force` skips the hourly alert cap (used by the weekly digest, which must never be crowded out by spam alerts).
export async function notifyAdmin(pool, subject, content, { force = false } = {}) {
  try {
    if (!mailConfigured()) return false;
    if (pool && !force && !(await underBudget(pool))) return false;
    const html = renderMail({ ...content, link: content.link === undefined ? `${siteUrl()}/#/admin` : content.link });
    const payload = { from: process.env.MAIL_FROM || 'Family Heritage <onboarding@resend.dev>', to: [process.env.ADMIN_EMAIL || 'admin@example.invalid'], subject: String(subject).slice(0, 140), html };
    if (transport) { await transport(payload); return true; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await fetch('https://api.resend.com/emails', { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return res.ok;
    } finally { clearTimeout(timer); }
  } catch { return false; }
}

export { clientIp };
