import { state, $, $$, esc, api, toast, toastError, openSheet, confirmDialog, loadingView, emptyView, fmtWhen, fullName } from './core.js';

let ADMIN_TAB = 'approvals';

export function renderAdmin(root) {
  if (!state.adminSecret) {
    root.innerHTML = `<div class="page narrow"><header class="page-head"><span class="eyebrow">ADMINISTRATOR</span><h1>Administration</h1><p>Moderate comments and tree suggestions, manage contributor tokens and keep content tidy.</p></header>
      <form id="adminLogin" class="card form" novalidate><label class="field">Administrator secret<input class="input" id="adminSecret" type="password" autocomplete="current-password" placeholder="ADMIN_SECRET"><small class="hint">The secret is kept in memory only and is cleared when you leave or refresh this page.</small></label><button class="btn primary" type="submit">Open administration</button></form></div>`;
    $('#adminLogin', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = $('#adminSecret', root).value;
      if (!v) return toast('Please enter the administrator secret.', 'error');
      state.adminSecret = v;
      await load(root, true);
    });
    return;
  }
  load(root);
}

async function load(root, first = false) {
  root.innerHTML = `<div class="page">${loadingView('Loading administration…')}</div>`;
  let q; let tokens;
  try { [q, tokens] = await Promise.all([api('/api/admin', { admin: true, auth: false }), api('/api/tokens', { admin: true, auth: false })]); }
  catch (e) {
    if (e.status === 403) { state.adminSecret = ''; toast('The administrator secret was not accepted.', 'error'); return renderAdmin(root); }
    root.innerHTML = `<div class="page">${emptyView('Could not load administration', e.message)}</div>`; return;
  }
  if (first) toast('Administration unlocked.', 'info');
  const counts = { approvals: q.proposals.length, comments: q.comments.length };
  root.innerHTML = `<div class="page"><header class="page-head row-between wrap"><div><span class="eyebrow">ADMINISTRATOR</span><h1>Administration</h1></div><button class="btn" id="lockAdmin" type="button">Lock</button></header>
  <div class="tabs" role="tablist">${[['approvals', `Tree suggestions${counts.approvals ? ` (${counts.approvals})` : ''}`], ['comments', `Comments${counts.comments ? ` (${counts.comments})` : ''}`], ['tokens', 'Contributor tokens'], ['history', 'Edit history'], ['content', 'Stories & ideas'], ['quality', `Data quality${q.quality.duplicates.length ? ` (${q.quality.duplicates.length})` : ''}`], ['security', q.security.token_locked || q.security.admin_locked ? 'Security (paused)' : 'Security']].map(([k, l]) => `<button class="tab ${ADMIN_TAB === k ? 'active' : ''}" data-tab="${k}">${esc(l)}</button>`).join('')}</div><div id="adminPane"></div></div>`;
  $('#lockAdmin', root).onclick = () => { state.adminSecret = ''; renderAdmin(root); toast('Administration locked.', 'info'); };
  $$('.tab', root).forEach((b) => { b.onclick = () => { ADMIN_TAB = b.dataset.tab; load(root); }; });
  const pane = $('#adminPane', root);
  const reload = () => load(root);
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); reload(); } catch (e) { toastError(e); } };
  const post = (body) => api('/api/admin', { method: 'POST', admin: true, auth: false, body });

  if (ADMIN_TAB === 'approvals') {
    pane.innerHTML = q.proposals.length ? q.proposals.map((p) => `<div class="card queue"><div><strong>${esc(p.action.replace(/_/g, ' '))}</strong><small class="muted block">From ${esc(p.token_label || 'a contributor')} · ${esc(fmtWhen(p.submitted_at))}</small><pre>${esc(JSON.stringify(p.payload, null, 2))}</pre></div><div class="row-actions"><button class="btn primary" data-pa="${esc(p.id)}">Approve</button><button class="btn" data-pr="${esc(p.id)}">Reject</button></div></div>`).join('') : emptyView('No pending tree suggestions.');
    $$('[data-pa]', pane).forEach((b) => { b.onclick = () => act(() => post({ kind: 'proposal', id: b.dataset.pa, status: 'approved' }), 'Suggestion approved.'); });
    $$('[data-pr]', pane).forEach((b) => { b.onclick = () => act(() => post({ kind: 'proposal', id: b.dataset.pr, status: 'rejected' }), 'Suggestion rejected.'); });
  } else if (ADMIN_TAB === 'comments') {
    const row = (c, pending) => `<div class="list-row"><div><strong>${esc(c.author_name)}</strong> <small class="muted">${esc(fmtWhen(c.created_at))}</small><p>${esc(c.body)}</p></div><div class="row-actions">${pending ? `<button class="btn primary" data-ca="${esc(c.id)}">Approve</button>` : ''}<button class="btn ${pending ? '' : 'btn-danger-ghost'}" data-cr="${esc(c.id)}">${pending ? 'Reject' : 'Hide'}</button></div></div>`;
    pane.innerHTML = `<section class="card"><h2>Awaiting moderation</h2>${q.comments.length ? q.comments.map((c) => row(c, true)).join('') : '<p class="muted">No comments are waiting.</p>'}</section><section class="card"><h2>Published comments</h2>${q.approved_comments.length ? q.approved_comments.map((c) => row(c, false)).join('') : '<p class="muted">No published comments.</p>'}</section>`;
    $$('[data-ca]', pane).forEach((b) => { b.onclick = () => act(() => post({ kind: 'comment', id: b.dataset.ca, status: 'approved' }), 'Comment approved.'); });
    $$('[data-cr]', pane).forEach((b) => { b.onclick = () => act(() => post({ kind: 'comment', id: b.dataset.cr, status: 'rejected' }), 'Comment rejected.'); });
  } else if (ADMIN_TAB === 'tokens') {
    pane.innerHTML = `<section class="card"><div class="row-between wrap"><div><h2>Contributor tokens</h2><p class="muted small">A token lets someone edit the tree, publish a profile and stories, and post business ideas. Prefer the 8-character kind: a 5-digit token is much easier to guess.</p></div><form id="newTokenForm" class="inline-filters"><input class="input" name="label" placeholder="Who is this for?" maxlength="80" aria-label="Token label"><button class="btn primary" type="submit" value="strong">Generate token (8 characters)</button><button class="btn" type="submit" value="digits">5-digit token</button></form></div>
      ${tokens.length ? tokens.map((t) => `<div class="list-row"><div><strong>${esc(t.label || 'Family contributor')}</strong> <span class="tag ${t.active ? '' : 'tag-quiet'}">${t.active ? 'Active' : 'Disabled'}</span><small class="muted block">Created ${esc(fmtWhen(t.created_at))}${t.last_used_at ? ` · last used ${esc(fmtWhen(t.last_used_at))}` : ' · never used'}</small><small class="block">${t.person_name ? `Linked to <strong>${esc(t.person_name)}</strong>` : '<span class="muted">Not linked to anyone</span>'}</small></div><div class="row-actions">${t.person_id ? `<button class="btn" data-unlink="${esc(t.id)}">Unlink</button>` : ''}<button class="btn ${t.active ? 'btn-danger-ghost' : ''}" data-toggle="${esc(t.id)}" data-active="${t.active ? '0' : '1'}">${t.active ? 'Disable' : 'Enable'}</button></div></div>`).join('') : '<p class="muted">No tokens have been created yet.</p>'}</section>`;
    $('#newTokenForm', pane).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/tokens', { method: 'POST', admin: true, auth: false, body: { label: new FormData(e.target).get('label'), style: e.submitter && e.submitter.value === 'digits' ? 'digits' : 'strong' } });
        const s = openSheet(`<div class="confirm"><span class="eyebrow">NEW TOKEN</span><h3>${esc(r.label)}</h3><p class="big-token" aria-label="Token">${esc(r.token)}</p><p class="muted">Copy this now and share it privately. For security it cannot be shown again.</p><div class="confirm-actions"><button class="btn" type="button" id="copyTok">Copy token</button><button class="btn primary" type="button" data-close>Done</button></div></div>`, { label: 'New token', onClose: reload });
        $('#copyTok', s.el).onclick = async () => { try { await navigator.clipboard.writeText(r.token); toast('Token copied to the clipboard.'); } catch { toast('Please copy the token manually.', 'info'); } };
      } catch (err) { toastError(err); }
    });
    $$('[data-toggle]', pane).forEach((b) => { b.onclick = () => act(() => api('/api/tokens', { method: 'PATCH', admin: true, auth: false, body: { id: b.dataset.toggle, active: b.dataset.active === '1' } }), b.dataset.active === '1' ? 'Token enabled.' : 'Token disabled.'); });
    $$('[data-unlink]', pane).forEach((b) => { b.onclick = async () => { if (!(await confirmDialog({ title: 'Unlink this token?', message: 'The contributor will need to link their token to a family member again.', confirmText: 'Unlink' }))) return; act(() => api('/api/tokens', { method: 'PATCH', admin: true, auth: false, body: { id: b.dataset.unlink, unlink: true } }), 'Token unlinked.'); }; });
  } else if (ADMIN_TAB === 'history') {
    const fmtVal = (v) => (v == null || v === '' ? '(empty)' : Array.isArray(v) ? v.join(', ') : String(v).startsWith('/api/image') ? '(photo)' : String(v));
    const diff = (r) => Object.keys(r.after).map((k) => `<li><strong>${esc(k.replace(/_/g, ' '))}</strong>: <span class="old">${esc(fmtVal(r.before[k]))}</span> &rarr; <span class="new">${esc(fmtVal(r.after[k]))}</span></li>`).join('');
    const who = (r) => (r.actor === 'admin' ? 'administrator' : r.token_label || 'a contributor');
    const action = (r) => (r.action === 'revert' || r.is_reverted
      ? `<span class="tag tag-quiet">${r.is_reverted ? 'Restored' : 'Restore'}</span>`
      : `<button class="btn" data-rv="${esc(r.id)}">Restore old values</button>`);
    pane.innerHTML = `<section class="card"><h2>Recent edits</h2><p class="muted small">Every change to a family member is recorded with the old and new values. Restore puts the old values back and is itself recorded.</p>${q.revisions.length ? q.revisions.map((r) => `<div class="list-row"><div><a href="#/person/${esc(r.person_id)}"><strong>${esc(r.person_name)}</strong></a> <small class="muted">${esc(fmtWhen(r.created_at))} &middot; ${esc(who(r))}${r.action === 'revert' ? ' &middot; restore' : ''}</small><ul class="diff">${diff(r)}</ul></div><div class="row-actions">${action(r)}</div></div>`).join('') : '<p class="muted">No edits have been made yet.</p>'}</section>`;
    $$('[data-rv]', pane).forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog({ title: 'Restore the old values?', message: 'The previous details will be put back. You can see this in the history afterwards.', confirmText: 'Restore', danger: false }))) return;
        try { const r = await post({ kind: 'revert', id: b.dataset.rv }); toast(r.skipped?.length ? 'Restored, except the photo, which is no longer stored.' : 'The previous details have been restored.'); reload(); } catch (e) { toastError(e); }
      };
    });
  } else if (ADMIN_TAB === 'quality') {
    const d = q.quality;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const dupGroup = (g) => `<div class="list-row"><div><strong>${esc(g.people[0].name)}</strong> <small class="muted">${plural(g.people.length, 'entry', 'entries')}</small><ul class="plain-list small">${g.people.map((p) => `<li><a href="#/person/${esc(p.id)}">${esc(p.name)}</a> <span class="muted">${plural(p.parents, 'parent', 'parents')}, ${plural(p.children, 'child', 'children')} &middot; ${esc(p.source || '')}</span></li>`).join('')}</ul></div></div>`;
    pane.innerHTML = `<section class="card"><h2>Possible duplicates</h2><p class="muted small">Different people can share a name. These are worth a look: a duplicate usually has no children or only one parent recorded.</p>${d.duplicates.length ? d.duplicates.map(dupGroup).join('') : '<p class="muted">No duplicate names found.</p>'}</section>
      <section class="card"><h2>Not connected to anyone</h2>${d.isolated.length ? `<ul class="plain-list">${d.isolated.map((p) => `<li><a href="#/person/${esc(p.id)}">${esc(p.name)}</a></li>`).join('')}</ul>` : '<p class="muted">Everyone is connected to the tree.</p>'}</section>
      <section class="card"><h2>Placeholders</h2><p>${plural(d.placeholders, 'entry', 'entries')} (unknown ancestors and the sacred rock) are shown in the tree but left out of the Analysis statistics.</p></section>`;
  } else if (ADMIN_TAB === 'security') {
    const s = q.security;
    const sources = `from ${s.token_sources_24h} source${s.token_sources_24h === 1 ? '' : 's'}`;
    pane.innerHTML = `<section class="card"><h2>Sign-in activity</h2><p class="muted small">Failed attempts are rate limited. After too many from one place, or too many overall, token checks pause for ten minutes.</p><div class="stat-row"><div class="stat"><span class="stat-v">${s.failed_token_24h}</span><span class="stat-l">Failed token attempts (24h)</span><span class="stat-s">${sources}</span></div><div class="stat"><span class="stat-v">${s.failed_admin_24h}</span><span class="stat-l">Failed admin attempts (24h)</span></div><div class="stat"><span class="stat-v">${s.token_locked ? 'Paused' : 'Normal'}</span><span class="stat-l">Token checks</span></div><div class="stat"><span class="stat-v">${s.admin_locked ? 'Paused' : 'Normal'}</span><span class="stat-l">Admin sign-in</span></div></div>${s.failed_token_24h > 50 ? '<p class="callout warn card">Unusually many failed token attempts. Consider disabling 5-digit tokens and issuing 8-character ones.</p>' : ''}</section>`;
  } else {
    pane.innerHTML = `<section class="card"><h2>Published stories</h2>${q.stories.length ? q.stories.map((s) => `<div class="list-row"><div><a href="#/story/${esc(s.id)}"><strong>${esc(s.title)}</strong></a><small class="muted block">${esc(s.author_name)} · ${esc(fmtWhen(s.created_at))}</small></div><div class="row-actions"><button class="btn btn-danger-ghost" data-rs="${esc(s.id)}">Remove</button></div></div>`).join('') : '<p class="muted">No stories have been published yet.</p>'}</section>
      <section class="card"><h2>Business ideas</h2>${q.ideas.length ? q.ideas.map((i) => `<div class="list-row"><div><strong>${esc(i.title)}</strong><small class="muted block">${esc(i.author_name)} · ${esc(fmtWhen(i.created_at))} · ${i.interested_count} interested</small></div><div class="row-actions"><button class="btn btn-danger-ghost" data-ri="${esc(i.id)}">Remove</button></div></div>`).join('') : '<p class="muted">No business ideas have been posted yet.</p>'}</section>`;
    $$('[data-rs]', pane).forEach((b) => { b.onclick = async () => { if (!(await confirmDialog({ title: 'Remove this story?', message: 'It will no longer be visible to the family.', confirmText: 'Remove' }))) return; act(() => post({ kind: 'story_remove', id: b.dataset.rs }), 'Story removed.'); }; });
    $$('[data-ri]', pane).forEach((b) => { b.onclick = async () => { if (!(await confirmDialog({ title: 'Remove this business idea?', message: 'This will remove it from the family network.', confirmText: 'Remove' }))) return; act(() => post({ kind: 'idea_remove', id: b.dataset.ri }), 'Business idea removed.'); }; });
  }
}
