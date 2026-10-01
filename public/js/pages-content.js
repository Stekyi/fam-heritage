import {
  state, $, $$, esc, fullName, aliasesOf, api, toast, toastError, openSheet, confirmDialog, loadingView, emptyView, errorView, reportError,
  fmtWhen, avatar, lifeLine, pager, prepareImage, safeUrl, loadTree, setHelp,
} from './core.js';
import { attachPersonSearch, openPersonSheet, personFacts, canEdit } from './tree.js';
import { refreshMe } from './session.js';

const paragraphs = (t) => esc(t).split(/\n{2,}/).map((x) => `<p>${x.replace(/\n/g, '<br>')}</p>`).join('');
const nav = (h) => { location.hash = h; };

// Shown on Family History. Order as requested by the family.
const ORIGINATORS = ['E.B Cudjoe', 'Agnes Obiri-Yeboah', 'Matthew Obiri-Yeboah', 'Samuel Tekyi', 'Ursef'];

// ================================================================= FAMILY HISTORY
export async function renderHistory(root, tabName = 'clan') {
  root.innerHTML = `<div class="page"><header class="page-head"><span class="eyebrow">FAMILY HISTORY</span><h1>Our story</h1><p>The history of the clan, and the stories family members have chosen to share.</p></header>
    <div class="tabs" role="tablist"><button role="tab" class="tab ${tabName === 'clan' ? 'active' : ''}" data-tab="clan">Clan history</button><button role="tab" class="tab ${tabName === 'stories' ? 'active' : ''}" data-tab="stories">Family stories</button></div><div id="historyBody">${loadingView('Loading family history…')}</div></div>`;
  $$('.tab', root).forEach((b) => { b.onclick = () => nav(b.dataset.tab === 'clan' ? '#/history' : '#/history/stories'); });
  if (tabName === 'stories') return renderStoriesList($('#historyBody', root));
  return renderClan($('#historyBody', root));
}

async function renderClan(body) {
  let h;
  try { h = await api('/api/history', { auth: false }); } catch (e) { return reportError(body, e, () => renderClan(body)); }
  const a = h.article;
  if (!a) { body.innerHTML = emptyView('The clan history is not available yet.', 'Please check back soon.'); return; }
  const comments = h.comments || [];
  body.innerHTML = `<div class="split"><div class="stack"><article class="card article"><div class="source-note">${esc(a.source_note || '')}</div><h2>${esc(a.title)}</h2><div class="article-body">${paragraphs(a.body)}</div></article>
  <section class="card originators" aria-labelledby="origTitle"><span class="eyebrow">ORIGINATORS</span><h2 id="origTitle">The people who began this archive</h2><p class="muted">With gratitude to the family members who first gathered and preserved our history.</p><ul class="originator-list">${ORIGINATORS.map((n) => `<li><span class="avatar avatar-md unknown no-photo" aria-hidden="true">${esc(n.charAt(0))}</span><strong>${esc(n)}</strong></li>`).join('')}</ul></section></div>
  <aside class="card comments"><h3>Family comments</h3><p class="muted small">Anyone can leave a comment. New comments are reviewed before they appear.</p>
  <div id="commentList">${comments.length ? comments.map((c) => `<div class="comment"><strong>${esc(c.author_name)}</strong><span>${esc(fmtWhen(c.created_at))}</span><p>${esc(c.body)}</p></div>`).join('') : '<p class="muted">No comments yet. Be the first to share a thought.</p>'}</div>
  <form id="commentForm" class="form" novalidate><label class="field">Your name<input class="input" name="author_name" maxlength="80" autocomplete="name"><small class="err" data-err="author_name"></small></label>
  <label class="field">Comment<textarea class="input" name="body" rows="4" maxlength="2000" placeholder="Share a memory or a thought…"></textarea><small class="err" data-err="body"></small></label>
  <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
  <button class="btn primary" type="submit">Submit comment</button></form></aside></div>`;
  const form = $('#commentForm', body);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form).entries());
    $$('.err', form).forEach((x) => { x.textContent = ''; });
    if (!v.author_name.trim()) { $('[data-err="author_name"]', form).textContent = 'Please enter your name.'; return; }
    if (!v.body.trim()) { $('[data-err="body"]', form).textContent = 'Please write a comment before submitting.'; return; }
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      const r = await api('/api/comment', { method: 'POST', body: v, auth: false });
      toast(r.message || 'Thank you. Your comment has been submitted.');
      form.reset();
    } catch (err) { toastError(err); } finally { btn.disabled = false; }
  });
}

async function renderStoriesList(body, page = 1) {
  body.innerHTML = loadingView('Loading family stories…');
  let r;
  try { r = await api(`/api/stories?page=${page}&limit=9`, { auth: false }); } catch (e) { return reportError(body, e, () => renderStoriesList(body, page)); }
  if (!r.stories.length) { body.innerHTML = emptyView('No stories have been published yet.', 'Linked contributors can share memories, places and traditions from the Contribute page.', '<a class="btn primary" href="#/contribute">Share a story</a>'); return; }
  body.innerHTML = `<div class="story-grid">${r.stories.map(storyCard).join('')}</div>${pager(r)}`;
  $$('[data-page]', body).forEach((b) => { b.onclick = () => { renderStoriesList(body, Number(b.dataset.page)); window.scrollTo({ top: 0, behavior: 'smooth' }); }; });
}

export const storyCard = (s) => `<a class="story-card card" href="#/story/${esc(s.id)}">${s.cover_url ? `<div class="story-cover"><img src="${esc(safeUrl(s.cover_url))}" alt="" loading="lazy"></div>` : '<div class="story-cover story-cover-empty" aria-hidden="true">❦</div>'}<div class="story-card-body"><h3>${esc(s.title)}</h3><p class="muted small">${esc(s.author_name)} · ${esc(fmtWhen(s.created_at))}</p><p>${esc(s.excerpt || '')}${(s.excerpt || '').length >= 280 ? '…' : ''}</p></div></a>`;

export async function renderStory(root, id) {
  root.innerHTML = `<div class="page narrow">${loadingView('Loading this story…')}</div>`;
  const wrap = $('.page', root);
  let r;
  try { r = await api(`/api/stories?id=${encodeURIComponent(id)}`, { auth: false }); } catch (e) { return reportError(wrap, e, () => renderStory(root, id)); }
  const s = r.story;
  const mine = state.me?.linked_person?.id === s.person_id;
  wrap.innerHTML = `<a class="back" href="#/history/stories">← All stories</a><article class="card article">${s.cover_url ? `<img class="story-hero" src="${esc(safeUrl(s.cover_url))}" alt="">` : ''}<h1>${esc(s.title)}</h1><p class="muted">By <a href="#/person/${esc(s.person_id)}">${esc(s.author_name)}</a> · ${esc(fmtWhen(s.created_at))}</p><div class="article-body">${paragraphs(s.content)}</div><div class="sheet-actions"><a class="btn primary" href="#/tree/${esc(s.person_id)}">View ${esc(s.author_name.split(' ')[0])} in the Family Tree</a>${mine ? '<button class="btn" id="editStory" type="button">Edit this story</button>' : ''}</div></article>`;
  $('#editStory', wrap)?.addEventListener('click', () => openStoryForm(s, () => renderStory(root, id)));
}

// ================================================================= PERSON PROFILE PAGE
export async function renderPerson(root, id) {
  root.innerHTML = `<div class="page narrow">${loadingView('Loading this family member…')}</div>`;
  const wrap = $('.page', root);
  const render = async () => {
    let r;
    try { r = await api(`/api/person?id=${encodeURIComponent(id)}`, { auth: false }); } catch (e) { return reportError(wrap, e, render); }
    const p = r.person;
    const aka = aliasesOf(p);
    const idx = state.data.people.findIndex((x) => x.id === p.id);
    if (idx >= 0) state.data.people[idx] = { ...state.data.people[idx], ...p };
    wrap.innerHTML = `<a class="back" href="#/tree">← Family tree</a><section class="card profile-card"><div class="person-hero big">${avatar(p, 'xxl')}<div><span class="eyebrow">FAMILY MEMBER</span><h1>${esc(fullName(p))}</h1>${aka.length ? `<p class="aka-line"><b>AKA:</b> ${esc(aka.join(' · '))}</p>` : ''}<p class="muted">${esc(lifeLine(p))}</p></div></div>
      ${personFacts(p)}${p.notes ? `<div class="focus-note">${esc(p.notes)}</div>` : ''}
      <div class="sheet-actions"><a class="btn primary" href="#/tree/${esc(p.id)}">View in Family Tree</a><button class="btn" id="editHere" type="button">${canEdit() ? 'Edit details' : '🔒 Edit details'}</button></div></section>
      <section class="card"><h2>About ${esc(p.given_name)}</h2>${r.profile ? `<div class="prose">${paragraphs(r.profile.about)}</div><p class="muted small">Last updated ${esc(fmtWhen(r.profile.updated_at))}</p>` : emptyView('No profile has been written yet.', `${p.given_name} has not published a personal profile.`)}</section>
      <section class="card"><h2>Stories</h2>${r.stories.length ? `<ul class="plain-list">${r.stories.map((st) => `<li><a href="#/story/${esc(st.id)}">${esc(st.title)}</a> <small class="muted">${esc(fmtWhen(st.created_at))}</small></li>`).join('')}</ul>` : '<p class="muted">No stories have been published yet.</p>'}</section>`;
    $('#editHere', wrap).onclick = () => { if (!canEdit()) return toast('You need a contributor token to make changes.', 'info'); openPersonSheet(p.id, { edit: true }); };
  };
  await render();
  const onUpd = (e) => { if (e.detail.id === id && location.hash.startsWith('#/person/')) render(); };
  window.addEventListener('person-updated', onUpd, { once: true });
}

// ================================================================= STORY FORM (shared)
export function openStoryForm(story, onDone) {
  const s = openSheet(`<form id="storyForm" class="form" novalidate><div class="sheet-head"><div><span class="eyebrow">${story ? 'EDIT STORY' : 'NEW STORY'}</span><h2>${story ? 'Edit your story' : 'Share a story'}</h2><p class="muted">Stories are public. They are shown with your name and linked to your place in the family tree.</p></div><button type="button" class="modal-close" data-close aria-label="Close">×</button></div>
    <label class="field">Title <span class="req">*</span><input class="input" name="title" maxlength="160" value="${esc(story?.title || '')}" placeholder="e.g. The year we planted the cocoa farm"><small class="err" data-err="title"></small></label>
    <label class="field">Story <span class="req">*</span><textarea class="input" name="content" rows="10" maxlength="20000" placeholder="Write about a memory, ancestor, place, event or tradition…">${esc(story?.content || '')}</textarea><small class="err" data-err="content"></small></label>
    <div class="field"><span class="label">Cover image (optional)</span><div class="photo-edit"><div id="coverPreview">${story?.cover_url ? `<img class="cover-thumb" src="${esc(safeUrl(story.cover_url))}" alt="">` : ''}</div><div><input type="file" id="coverFile" accept="image/jpeg,image/png,image/webp" class="sr-only"><label for="coverFile" class="btn">Choose image…</label>${story?.cover_url ? ' <button type="button" class="btn" id="coverRemove">Remove</button>' : ''}<small class="err" data-err="cover"></small></div></div></div>
    <div class="sheet-actions"><button class="btn primary" type="submit">${story ? 'Save story' : 'Publish story'}</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, { wide: true, label: 'Story' });
  const form = $('#storyForm', s.el);
  let cover; // undefined = unchanged, null = remove, object = new
  $('#coverFile', s.el).addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return; $('[data-err="cover"]', s.el).textContent = '';
    try { cover = await prepareImage(f, 1200); $('#coverPreview', s.el).innerHTML = `<img class="cover-thumb" src="${cover.preview}" alt="">`; } catch (err) { $('[data-err="cover"]', s.el).textContent = err.message; }
  });
  $('#coverRemove', s.el)?.addEventListener('click', () => { cover = null; $('#coverPreview', s.el).innerHTML = ''; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form).entries());
    $$('.err', form).forEach((x) => { x.textContent = ''; });
    if (!v.title.trim()) { $('[data-err="title"]', form).textContent = 'Please give your story a title.'; return; }
    if (!v.content.trim()) { $('[data-err="content"]', form).textContent = 'Please write your story before publishing.'; return; }
    const btn = $('button[type=submit]', form); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const payload = { title: v.title, content: v.content };
      if (cover && cover.data) { const im = await api('/api/image', { method: 'POST', body: { kind: 'story', content_type: cover.content_type, data: cover.data } }); payload.cover_image_id = im.id; }
      else if (cover === null) payload.cover_image_id = null;
      if (story) await api(`/api/stories?id=${story.id}`, { method: 'PUT', body: payload });
      else await api('/api/stories', { method: 'POST', body: payload });
      toast(story ? 'Your story has been updated.' : 'Your story has been published.');
      s.close(); onDone?.();
    } catch (err) { btn.disabled = false; btn.textContent = story ? 'Save story' : 'Publish story'; toastError(err); }
  });
}

// ================================================================= CONTRIBUTE / MY FAMILY PROFILE
export async function renderContribute(root) {
  const page = document.createElement('div'); page.className = 'page';
  root.replaceChildren(page);
  const draw = async () => {
    await loadTree();
    const me = state.me;
    page.innerHTML = `<header class="page-head"><span class="eyebrow">CONTRIBUTE</span><h1>My Family Profile</h1><p>Link your contributor token to your place in the family tree, tell your story, and help the archive grow.</p></header>${tokenCard(me)}<div id="mine"></div><div id="suggest"></div>`;
    if (me?.valid) { await renderMine($('#mine', page), draw); renderSuggest($('#suggest', page)); }
    $('#focusToken', page)?.addEventListener('click', () => $('#tokenInput')?.focus());
  };
  await draw();
}

function tokenCard(me) {
  if (!state.token) return `<section class="card callout"><h2>You need a contributor token</h2><p>Anyone can browse the tree, read the history and leave comments. A 5-digit contributor token lets you edit family members, publish a profile and stories, and post business ideas. Ask the family administrator for yours, then enter it in the <strong>Token</strong> box at the top of the page.</p><button class="btn primary" id="focusToken" type="button">Enter my token</button></section>`;
  if (me && me.valid === false) return `<section class="card callout warn"><h2>Your token is invalid or has expired</h2><p>Please check the 5 digits and try again, or ask the administrator for a new token.</p><button class="btn primary" id="focusToken" type="button">Re-enter my token</button></section>`;
  if (!me) return `<section class="card">${loadingView('Checking your token…')}</section>`;
  return '';
}

async function renderMine(box, redraw) {
  const me = state.me;
  if (!me.linked_person) { renderLink(box, redraw); return; }
  const p = me.linked_person;
  let prof = null; let stories = { stories: [], total: 0 };
  try { [prof, stories] = await Promise.all([api(`/api/profile?person_id=${p.id}`), api(`/api/stories?person_id=${p.id}&limit=30`)]); } catch (e) { box.innerHTML = errorView(e.message); return; }
  const about = prof.profile?.about || '';
  box.innerHTML = `<section class="card linked-card"><div class="person-hero">${avatar(p, 'lg')}<div><span class="eyebrow">YOU ARE LINKED TO</span><h2>${esc(fullName(p))}</h2><p class="muted">${esc(lifeLine(p))}</p></div></div><div class="sheet-actions"><a class="btn" href="#/person/${esc(p.id)}">View my public profile</a><a class="btn" href="#/tree/${esc(p.id)}">View in Family Tree</a><button class="btn" id="editMe" type="button">Edit my details</button><button class="btn btn-ghost" id="unlink" type="button">Unlink</button></div></section>
  <section class="card"><h2>My profile ${setHelp('A short public “About me”. Anyone can read it.')}</h2><form id="aboutForm" class="form" novalidate><label class="field"><span class="sr-only">About me</span><textarea class="input" name="about" rows="7" maxlength="5000" placeholder="Tell the family about yourself…">${esc(about)}</textarea><small class="err" data-err="about"></small></label><div class="sheet-actions"><button class="btn primary" type="submit">${about ? 'Update profile' : 'Publish profile'}</button></div></form></section>
  <section class="card"><div class="row-between"><h2>My stories</h2><button class="btn primary" id="newStory" type="button">Write a story</button></div>
  <div id="myStories">${stories.stories.length ? stories.stories.map((s) => `<div class="list-row"><div><a href="#/story/${esc(s.id)}"><strong>${esc(s.title)}</strong></a><small class="muted block">${esc(fmtWhen(s.created_at))}</small></div><div class="row-actions"><button class="btn" data-edit="${esc(s.id)}" type="button">Edit</button><button class="btn btn-danger-ghost" data-del="${esc(s.id)}" type="button">Delete</button></div></div>`).join('') : '<p class="muted">No stories have been published yet.</p>'}</div></section>`;
  $('#editMe', box).onclick = () => openPersonSheet(p.id, { edit: true });
  $('#unlink', box).onclick = async () => {
    const ok = await confirmDialog({ title: 'Unlink your contributor identity?', message: 'You will need to link your token again before creating your public family profile.', confirmText: 'Unlink' });
    if (!ok) return;
    try { await api('/api/me', { method: 'DELETE' }); toast('Your token has been unlinked.', 'info'); await refreshMe(); } catch (e) { toastError(e); }
  };
  const form = $('#aboutForm', box);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = new FormData(form).get('about');
    if (!String(v).trim()) { $('[data-err="about"]', form).textContent = 'Please write something about yourself before publishing.'; return; }
    $('[data-err="about"]', form).textContent = '';
    try { await api('/api/profile', { method: 'PUT', body: { about: v } }); toast(about ? 'Your profile has been updated.' : 'Profile published successfully.'); redraw(); } catch (err) { toastError(err); }
  });
  $('#newStory', box).onclick = () => openStoryForm(null, redraw);
  $$('[data-edit]', box).forEach((b) => { b.onclick = async () => { try { const r = await api(`/api/stories?id=${b.dataset.edit}`, { auth: false }); openStoryForm(r.story, redraw); } catch (e) { toastError(e); } }; });
  $$('[data-del]', box).forEach((b) => { b.onclick = async () => {
    const ok = await confirmDialog({ title: 'Delete this story?', message: 'This action cannot be undone.', confirmText: 'Delete Story' });
    if (!ok) return;
    try { await api(`/api/stories?id=${b.dataset.del}`, { method: 'DELETE' }); toast('Your story has been deleted.'); redraw(); } catch (e) { toastError(e); }
  }; });
}

function renderLink(box, redraw) {
  box.innerHTML = `<section class="card"><h2>Find yourself in the family tree</h2><p class="muted">Search for your name, select your entry, then link your token to it. Each token links to one person.</p>
  <label class="sr-only" for="linkSearch">Search family tree</label><input id="linkSearch" class="input" type="search" placeholder="Search family tree…" autocomplete="off"><div id="linkResults" class="results"></div><div id="linkPick"></div></section>`;
  attachPersonSearch($('#linkSearch', box), $('#linkResults', box), {
    onPick: (p) => {
      $('#linkPick', box).innerHTML = `<div class="pick-card"><span class="eyebrow">FOUND</span><div class="person-hero">${avatar(p, 'lg')}<div><h3>${esc(fullName(p))}</h3><p class="muted">${esc(lifeLine(p))}</p></div></div><button class="btn primary" id="doLink" type="button">Link my token to this person</button></div>`;
      $('#doLink', box).onclick = async () => {
        try { const r = await api('/api/me', { method: 'POST', body: { person_id: p.id } }); toast(`Your contributor token is now linked to ${fullName(r.linked_person)}.`); await refreshMe(); } catch (e) { toastError(e); }
      };
    },
  });
}

function renderSuggest(box) {
  box.innerHTML = `<section class="card"><h2>Suggest a new relative</h2><p class="muted">Adding people changes the shape of the tree, so these suggestions are checked by the administrator before they appear.</p>
  <form id="suggestForm" class="form" novalidate><div class="field"><span class="label">Existing family member</span><input id="sgSearch" class="input" type="search" placeholder="Search family tree…" autocomplete="off"><div id="sgResults" class="results"></div><div id="sgPicked" class="muted small">No one selected yet.</div></div>
  <div class="form-grid"><label class="field">This new person is their<select class="input" name="kind"><option value="child">Child</option><option value="parent">Parent</option><option value="spouse">Spouse / partner</option></select></label><span></span>
  <label class="field">New person's name <span class="req">*</span><input class="input" name="given_name" maxlength="120"><small class="err" data-err="given_name"></small></label><label class="field">Surname<input class="input" name="surname" maxlength="120"></label></div>
  <div class="sheet-actions"><button class="btn primary" type="submit">Send suggestion</button></div></form></section>`;
  let picked = null;
  attachPersonSearch($('#sgSearch', box), $('#sgResults', box), { onPick: (p) => { picked = p; $('#sgPicked', box).innerHTML = `Selected: <strong>${esc(fullName(p))}</strong>`; $('#sgResults', box).innerHTML = ''; } });
  const form = $('#suggestForm', box);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form).entries());
    if (!picked) return toast('Please select a family member first.', 'error');
    if (!v.given_name.trim()) { $('[data-err="given_name"]', form).textContent = 'Please enter a name before submitting.'; return; }
    $('[data-err="given_name"]', form).textContent = '';
    const payload = { given_name: v.given_name, surname: v.surname, relationship_kind: v.kind };
    if (v.kind === 'child') payload.parent_id = picked.id; else payload.anchor_id = picked.id;
    try { const r = await api('/api/proposals', { method: 'POST', body: { action: 'add_person', payload } }); toast(r.message); form.reset(); picked = null; $('#sgPicked', box).textContent = 'No one selected yet.'; } catch (err) { toastError(err); }
  });
}
