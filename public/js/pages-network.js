import {
  state, $, $$, esc, fullName, aliasesOf, api, toast, toastError, openSheet, confirmDialog, loadingView, emptyView, reportError,
  fmtWhen, avatar, pager, debounce, setHelp, pluralize, genderLabel,
} from './core.js';

const nav = (h) => { location.hash = h; };
const paragraphs = (t) => esc(t).split(/\n{2,}/).map((x) => `<p>${x.replace(/\n/g, '<br>')}</p>`).join('');

// ================================================================= NETWORK
export function renderNetwork(root, tabName = 'people') {
  root.innerHTML = `<div class="page"><header class="page-head"><span class="eyebrow">NETWORK</span><h1>Family network</h1><p>Find relatives by profession and place, and discover business ideas shared within the family.</p></header>
  <div class="tabs" role="tablist"><button role="tab" class="tab ${tabName === 'people' ? 'active' : ''}" data-tab="people">Find family</button><button role="tab" class="tab ${tabName === 'ideas' ? 'active' : ''}" data-tab="ideas">Business ideas</button></div><div id="netBody"></div></div>`;
  $$('.tab', root).forEach((b) => { b.onclick = () => nav(b.dataset.tab === 'people' ? '#/network' : '#/network/ideas'); });
  if (tabName === 'ideas') renderIdeas($('#netBody', root)); else renderPeopleSearch($('#netBody', root));
}

const NET = { occupation: '', location: '', gender: '', age_min: '', age_max: '', page: 1 };

function renderPeopleSearch(body) {
  body.innerHTML = `<form id="netForm" class="card filters" novalidate>
    <label class="field"><span class="label">Profession ${setHelp('Matches any part of a recorded occupation, e.g. “engineer”.')}</span><input class="input" name="occupation" list="occList" value="${esc(NET.occupation)}" placeholder="e.g. Engineer"><datalist id="occList"></datalist></label>
    <label class="field"><span class="label">Location ${setHelp('Matches where someone lives now or was born.')}</span><input class="input" name="location" list="locList" value="${esc(NET.location)}" placeholder="e.g. Ghana"><datalist id="locList"></datalist></label>
    <label class="field"><span class="label">Gender</span><select class="input" name="gender"><option value="">Any</option><option value="F">Female</option><option value="M">Male</option><option value="O">Other</option></select></label>
    <div class="field"><span class="label">Age range</span><div class="range"><input class="input" name="age_min" type="number" min="0" max="120" placeholder="From" value="${esc(NET.age_min)}" aria-label="Minimum age"><span>–</span><input class="input" name="age_max" type="number" min="0" max="120" placeholder="To" value="${esc(NET.age_max)}" aria-label="Maximum age"></div></div>
    <div class="filter-actions"><button class="btn primary" type="submit">Search</button><button class="btn" type="button" id="netReset">Clear</button></div></form>
    <p class="muted small note">Only living relatives with a recorded occupation are listed. Add yours in your profile so others can find you.</p><div id="netResults"></div>`;
  $('[name=gender]', body).value = NET.gender;
  const form = $('#netForm', body);
  const read = () => { const v = Object.fromEntries(new FormData(form).entries()); Object.assign(NET, { occupation: v.occupation.trim(), location: v.location.trim(), gender: v.gender, age_min: v.age_min, age_max: v.age_max }); };
  const fillList = (sel, list) => { const dl = $(sel, body); if (dl && !dl.children.length) dl.innerHTML = list.map((v) => `<option value="${esc(v)}">`).join(''); };
  const run = async (page = 1) => {
    NET.page = page;
    const out = $('#netResults', body);
    out.innerHTML = loadingView('Finding family members…');
    const q = new URLSearchParams({ page, limit: 12 });
    for (const k of ['occupation', 'location', 'gender', 'age_min', 'age_max']) if (NET[k] !== '') q.set(k, NET[k]);
    let r;
    try { r = await api(`/api/network?${q}`, { auth: false }); } catch (e) { return reportError(out, e, () => run(page)); }
    fillList('#occList', r.suggestions.occupations); fillList('#locList', r.suggestions.locations);
    if (!r.results.length) { out.innerHTML = emptyView('No family members match these filters.', 'Try a broader profession or location, or clear the age range.'); return; }
    out.innerHTML = `<p class="muted small">${pluralize(r.total, 'family member', 'family members')} found</p><div class="people-grid">${r.results.map(personResult).join('')}</div>${pager(r)}`;
    $$('[data-page]', out).forEach((b) => { b.onclick = () => { run(Number(b.dataset.page)); window.scrollTo({ top: 0, behavior: 'smooth' }); }; });
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); read(); run(1); });
  $('#netReset', body).onclick = () => { Object.assign(NET, { occupation: '', location: '', gender: '', age_min: '', age_max: '', page: 1 }); renderPeopleSearch(body); };
  run(NET.page);
}

const personResult = (p) => {
  const aka = aliasesOf(p);
  return `<article class="card person-result">${avatar(p, 'lg')}<div class="grow"><h3>${esc(fullName(p))}</h3>${aka.length ? `<p class="aka-line small"><b>AKA:</b> ${esc(aka.join(' · '))}</p>` : ''}<p><strong>${esc(p.occupation || '')}</strong></p><p class="muted small">${esc([p.location, p.age != null ? `age ${p.age}` : '', genderLabel(p.sex) !== 'Unknown' ? genderLabel(p.sex) : ''].filter(Boolean).join(' · '))}</p>${p.short_profile ? `<p class="small">${esc(p.short_profile)}${p.short_profile.length >= 180 ? '…' : ''}</p>` : ''}</div><div class="result-actions"><a class="btn primary" href="#/person/${esc(p.id)}">View Profile</a><a class="btn" href="#/tree/${esc(p.id)}">View in Family Tree</a></div></article>`;
};

// ================================================================= BUSINESS IDEAS
const IDEAS = { q: '', category: '', location: '', page: 1 };

async function renderIdeas(body) {
  body.innerHTML = `<div class="row-between wrap"><form id="ideaFilter" class="inline-filters" novalidate><input class="input" name="q" type="search" placeholder="Search business ideas…" value="${esc(IDEAS.q)}" aria-label="Search business ideas"><select class="input" name="category" aria-label="Category"><option value="">All categories</option></select><input class="input" name="location" placeholder="Location" value="${esc(IDEAS.location)}" aria-label="Location"></form><button class="btn primary" id="newIdea" type="button">Post a business idea</button></div><div id="ideaList"></div>`;
  const form = $('#ideaFilter', body);
  const loadList = async (page = IDEAS.page) => {
    IDEAS.page = page;
    const out = $('#ideaList', body); out.innerHTML = loadingView('Loading business ideas…');
    const q = new URLSearchParams({ page, limit: 8 });
    for (const k of ['q', 'category', 'location']) if (IDEAS[k]) q.set(k, IDEAS[k]);
    let r;
    try { r = await api(`/api/business?${q}`); } catch (e) { return reportError(out, e, () => loadList(page)); }
    const sel = $('[name=category]', form);
    if (sel.options.length === 1) { sel.innerHTML += r.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(''); sel.value = IDEAS.category; }
    if (!r.ideas.length) { out.innerHTML = emptyView(IDEAS.q || IDEAS.category || IDEAS.location ? 'No business ideas match these filters.' : 'No business ideas have been posted yet.', 'Family members with a linked token can share ideas for others to join.'); return; }
    out.innerHTML = `<div class="idea-grid">${r.ideas.map(ideaCard).join('')}</div>${pager(r)}`;
    $$('[data-page]', out).forEach((b) => { b.onclick = () => { loadList(Number(b.dataset.page)); window.scrollTo({ top: 0, behavior: 'smooth' }); }; });
    $$('[data-idea]', out).forEach((c) => {
      const open = () => openIdea(c.dataset.idea, () => loadList(IDEAS.page));
      c.onclick = open; c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    });
    $$('[data-interest]', out).forEach((b) => { b.onclick = (e) => { e.stopPropagation(); toggleInterest(b.dataset.interest, b.dataset.on === '1', () => loadList(IDEAS.page)); }; });
  };
  $('#newIdea', body).onclick = () => {
    if (!state.me?.valid) return toast('You need a contributor token to post a business idea.', 'info');
    if (!state.me.linked_person) return toast('Link your token to your family-tree person first (Contribute → My Family Profile).', 'info');
    openIdeaForm(null, () => loadList(1));
  };
  const apply = debounce(() => { const v = Object.fromEntries(new FormData(form).entries()); Object.assign(IDEAS, { q: v.q.trim(), category: v.category, location: v.location.trim() }); loadList(1); }, 300);
  form.addEventListener('input', apply); form.addEventListener('change', apply); form.addEventListener('submit', (e) => e.preventDefault());
  loadList(IDEAS.page);
}

const ideaCard = (i) => `<article class="card idea-card" data-idea="${esc(i.id)}" tabindex="0" role="button" aria-label="Open ${esc(i.title)}"><div class="idea-tags"><span class="tag">${esc(i.category || 'General')}</span><span class="tag tag-quiet">${esc(i.location || '')}</span></div><h3>${esc(i.title)}</h3><p class="idea-desc">${esc(i.description.slice(0, 200))}${i.description.length > 200 ? '…' : ''}</p><p class="muted small">Posted by ${esc(i.author_name)} · ${esc(fmtWhen(i.created_at))}</p><div class="idea-foot"><span class="count" title="Family members who have said they are interested">Interested: <strong>${i.interested_count}</strong></span>${i.is_owner ? '<span class="tag tag-own">Your idea</span>' : `<button type="button" class="btn ${i.i_am_interested ? '' : 'primary'}" data-interest="${esc(i.id)}" data-on="${i.i_am_interested ? '1' : '0'}">${i.i_am_interested ? "I'm no longer interested" : "I'm Interested"}</button>`}</div></article>`;

async function toggleInterest(id, currentlyOn, done) {
  if (!state.me?.valid) return toast('You need a contributor token to express interest.', 'info');
  if (!state.me.linked_person) return toast('Link your token to your family-tree person first (Contribute → My Family Profile).', 'info');
  if (currentlyOn) {
    try { await api(`/api/business?id=${id}&interest=1`, { method: 'DELETE' }); toast('Your interest has been removed.', 'info'); done?.(); } catch (e) { toastError(e); }
    return;
  }
  const s = openSheet(`<form id="interestForm" class="form" novalidate><div class="sheet-head"><div><span class="eyebrow">I'M INTERESTED</span><h2>How should we reach you?</h2><p class="muted">Your contact details are only shared with the person who posted this idea.</p></div><button type="button" class="modal-close" data-close aria-label="Close">×</button></div>
    <label class="field">Preferred contact method<select class="input" name="contact_method"><option value="email">Email</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option><option value="other">Other</option></select></label>
    <label class="field">Contact information <span class="req">*</span><input class="input" name="contact_value" maxlength="160" placeholder="name@example.com"><small class="err" data-err="contact_value"></small></label>
    <div class="sheet-actions"><button class="btn primary" type="submit">Record my interest</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, { label: "I'm interested" });
  const form = $('#interestForm', s.el);
  const method = $('[name=contact_method]', form); const val = $('[name=contact_value]', form);
  method.addEventListener('change', () => { val.placeholder = { email: 'name@example.com', phone: '+1 555 000 0000', whatsapp: '+233 24 000 0000', other: 'How should they reach you?' }[method.value]; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!val.value.trim()) { $('[data-err="contact_value"]', form).textContent = 'Please provide your contact information.'; return; }
    try { await api(`/api/business?id=${id}&interest=1`, { method: 'POST', body: { contact_method: method.value, contact_value: val.value } }); toast('Your interest has been recorded.'); s.close(); done?.(); }
    catch (err) { toastError(err); }
  });
}

async function openIdea(id, done) {
  const s = openSheet(`<div class="sheet-body" id="ideaSheet">${loadingView('Loading this business idea…')}</div>`, { wide: true, label: 'Business idea' });
  const body = $('#ideaSheet', s.el);
  const draw = async () => {
    let r;
    try { r = await api(`/api/business?id=${id}`); } catch (e) { body.innerHTML = `<div class="state state-error"><p>${esc(e.message)}</p></div>`; return; }
    const i = r.idea;
    body.innerHTML = `<div class="sheet-head"><div><div class="idea-tags"><span class="tag">${esc(i.category || 'General')}</span><span class="tag tag-quiet">${esc(i.location || '')}</span></div><h2>${esc(i.title)}</h2><p class="muted">Posted by <a href="#/person/${esc(i.person_id)}" data-close>${esc(i.author_name)}</a> · ${esc(fmtWhen(i.created_at))}</p></div><button class="modal-close" type="button" data-close aria-label="Close">×</button></div>
      <div class="prose">${paragraphs(i.description)}</div>
      <dl class="facts">${i.funding_needed ? `<div class="fact"><dt>Funding needed</dt><dd>${esc(i.funding_needed)}</dd></div>` : ''}${i.skills_needed ? `<div class="fact"><dt>Skills needed</dt><dd>${esc(i.skills_needed)}</dd></div>` : ''}${i.website ? `<div class="fact"><dt>Website</dt><dd><a href="${esc(i.website)}" target="_blank" rel="noopener noreferrer">${esc(i.website)}</a></dd></div>` : ''}</dl>
      <p class="count big">Interested: <strong>${i.interested_count}</strong></p>
      ${i.is_owner ? ownerPanel(r.interests || []) : `<div class="sheet-actions"><button class="btn ${r.my_interest ? '' : 'primary'}" id="toggleInt" type="button">${r.my_interest ? "I'm no longer interested" : "I'm Interested"}</button></div>${r.my_interest ? `<p class="muted small">You shared your ${esc(r.my_interest.contact_method)} contact with the owner.</p>` : ''}`}
      ${i.is_owner ? '<div class="sheet-actions"><button class="btn" id="editIdea" type="button">Edit</button><button class="btn btn-danger-ghost" id="rmIdea" type="button">Remove idea</button></div>' : ''}`;
    $$('[data-close]', body).forEach((b) => b.addEventListener('click', s.close));
    $('#toggleInt', body)?.addEventListener('click', () => toggleInterest(id, !!r.my_interest, async () => { await draw(); done?.(); }));
    $('#editIdea', body)?.addEventListener('click', () => openIdeaForm(i, async () => { await draw(); done?.(); }));
    $('#rmIdea', body)?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Remove this business idea?', message: 'This will remove it from the family network.', confirmText: 'Remove' });
      if (!ok) return;
      try { await api(`/api/business?id=${id}`, { method: 'DELETE' }); toast('Your business idea has been removed.', 'info'); s.close(); done?.(); } catch (e) { toastError(e); }
    });
  };
  await draw();
}

const METHOD_LABEL = { email: 'Email', phone: 'Phone', whatsapp: 'WhatsApp', other: 'Other' };
const ownerPanel = (list) => `<section class="sheet-section"><h3>Interested family members (${list.length})</h3>${list.length ? `<ul class="interest-list">${list.map((x) => `<li><div><a href="#/person/${esc(x.person_id)}" data-close><strong>${esc(x.name)}</strong></a><small class="muted block">${esc(fmtWhen(x.created_at))}</small></div><div class="contact"><span class="tag">${esc(METHOD_LABEL[x.contact_method] || x.contact_method)}</span> <span>${esc(x.contact_value)}</span></div></li>`).join('')}</ul><p class="muted small">Only you can see these contact details.</p>` : '<p class="muted">No one has expressed interest yet.</p>'}</section>`;

function openIdeaForm(idea, done) {
  const s = openSheet(`<form id="ideaForm" class="form" novalidate><div class="sheet-head"><div><span class="eyebrow">${idea ? 'EDIT IDEA' : 'NEW IDEA'}</span><h2>${idea ? 'Edit your business idea' : 'Post a business idea'}</h2><p class="muted">Share an opportunity with the family. Anyone can read it.</p></div><button type="button" class="modal-close" data-close aria-label="Close">×</button></div>
    <div class="form-grid"><label class="field span-2">Title <span class="req">*</span><input class="input" name="title" maxlength="160" value="${esc(idea?.title || '')}"><small class="err" data-err="title"></small></label>
    <label class="field span-2">Description <span class="req">*</span><textarea class="input" name="description" rows="6" maxlength="5000">${esc(idea?.description || '')}</textarea><small class="err" data-err="description"></small></label>
    <label class="field">Industry / category <span class="req">*</span><input class="input" name="category" maxlength="80" value="${esc(idea?.category || '')}" placeholder="e.g. Agriculture"><small class="err" data-err="category"></small></label>
    <label class="field">Location <span class="req">*</span><input class="input" name="location" maxlength="120" value="${esc(idea?.location || '')}" placeholder="e.g. Kumasi, Ghana"><small class="err" data-err="location"></small></label>
    <label class="field">Funding needed<input class="input" name="funding_needed" maxlength="120" value="${esc(idea?.funding_needed || '')}" placeholder="Optional"></label>
    <label class="field">Website<input class="input" name="website" maxlength="200" value="${esc(idea?.website || '')}" placeholder="Optional"></label>
    <label class="field span-2">Skills needed<input class="input" name="skills_needed" maxlength="500" value="${esc(idea?.skills_needed || '')}" placeholder="Optional"></label></div>
    <div class="sheet-actions"><button class="btn primary" type="submit">${idea ? 'Save changes' : 'Post idea'}</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, { wide: true, label: 'Business idea' });
  const form = $('#ideaForm', s.el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form).entries());
    $$('.err', form).forEach((x) => { x.textContent = ''; });
    const need = { title: 'Please give your business idea a title.', description: 'Please describe your business idea.', category: 'Please choose an industry or category.', location: 'Please add a location.' };
    let ok = true;
    for (const [k, m] of Object.entries(need)) if (!String(v[k] || '').trim()) { $(`[data-err="${k}"]`, form).textContent = m; ok = false; }
    if (!ok) return;
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      if (idea) await api(`/api/business?id=${idea.id}`, { method: 'PUT', body: v }); else await api('/api/business', { method: 'POST', body: v });
      toast(idea ? 'Your business idea has been updated.' : 'Your business idea has been posted.');
      s.close(); done?.();
    } catch (err) { btn.disabled = false; toastError(err); }
  });
}

// ================================================================= ANALYSIS
const nf = new Intl.NumberFormat();
const NOT_ENOUGH = '<p class="muted not-enough">Not enough recorded data to display this analysis.</p>';

function barChart(rows, { horizontal = false, color = 'var(--green)', label = '' } = {}) {
  if (!rows?.length || rows.every((r) => !r.count)) return NOT_ENOUGH;
  const max = Math.max(...rows.map((r) => r.count));
  if (horizontal) return `<div class="hbars" role="img" aria-label="${esc(label)}">${rows.map((r) => `<div class="hbar" title="${esc(r.label)}: ${r.count}"><span class="hbar-label">${esc(r.label)}</span><span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(3, (r.count / max) * 100)}%;background:${color}"></span></span><span class="hbar-val">${nf.format(r.count)}</span></div>`).join('')}</div>`;
  return `<div class="vbars" role="img" aria-label="${esc(label)}">${rows.map((r) => `<div class="vbar" title="${esc(r.label)}: ${r.count}"><span class="vbar-val">${r.count ? nf.format(r.count) : ''}</span><span class="vbar-col"><span class="vbar-fill" style="height:${Math.max(r.count ? 3 : 0, (r.count / max) * 100)}%;background:${color}"></span></span><span class="vbar-label">${esc(r.label)}</span></div>`).join('')}</div>`;
}

function donut(parts, { label = '' } = {}) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) return NOT_ENOUGH;
  const R = 54; const C = 2 * Math.PI * R; let off = 0;
  const arcs = parts.filter((p) => p.value > 0).map((p) => { const len = (p.value / total) * C; const a = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${p.color}" stroke-width="22" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"><title>${esc(p.label)}: ${p.value} (${Math.round((p.value / total) * 100)}%)</title></circle>`; off += len; return a; }).join('');
  return `<div class="donut-wrap"><svg viewBox="0 0 140 140" class="donut" role="img" aria-label="${esc(label)}">${arcs}<text x="70" y="66" text-anchor="middle" class="donut-n">${nf.format(total)}</text><text x="70" y="84" text-anchor="middle" class="donut-t">people</text></svg><ul class="legend-list">${parts.map((p) => `<li><i style="background:${p.color}"></i>${esc(p.label)} <strong>${nf.format(p.value)}</strong> <span class="muted">(${Math.round((p.value / total) * 100)}%)</span></li>`).join('')}</ul></div>`;
}

const stat = (label, value, sub = '') => `<div class="stat"><span class="stat-v">${value}</span><span class="stat-l">${esc(label)}</span>${sub ? `<span class="stat-s">${sub}</span>` : ''}</div>`;
const chartCard = (title, help, inner, extra = '') => `<section class="card chart-card"><div class="chart-head"><h3>${esc(title)}</h3>${help ? setHelp(help) : ''}</div>${extra}${inner}</section>`;
const fmtN = (n) => (n == null ? '—' : String(n));

export async function renderAnalysis(root) {
  root.innerHTML = `<div class="page"><header class="page-head"><span class="eyebrow">ANALYSIS</span><h1>Family in numbers</h1><p>Statistics drawn only from what has been recorded in the archive. Nothing is estimated or invented.</p></header><div id="anaBody">${loadingView('Loading family analysis…')}</div></div>`;
  const body = $('#anaBody', root);
  let a;
  try { a = await api('/api/analysis', { auth: false }); } catch (e) { return reportError(body, e, () => renderAnalysis(root)); }
  const t = a.totals;
  const living = t.living + t.presumed_living;
  body.innerHTML = `<div class="stat-row">${stat('People in the archive', nf.format(t.total))}${stat('Living', nf.format(living), t.presumed_living ? `incl. ${t.presumed_living} with no death recorded` : '')}${stat('Deceased', nf.format(t.deceased))}${stat('Not enough information', nf.format(t.unknown))}</div>
  <div class="chart-grid">
    ${chartCard('Living and deceased', 'People are counted as deceased when a death date or status is recorded. Those born in the last 100 years with no death recorded are counted as living.', donut([{ label: 'Living', value: living, color: '#2f6b57' }, { label: 'Deceased', value: t.deceased, color: '#a36b30' }, { label: 'Unknown', value: t.unknown, color: '#b9b2a6' }], { label: 'Living, deceased and unknown' }))}
    ${chartCard('Gender', 'Based on the gender recorded for each person.', donut([{ label: 'Female', value: a.gender.female, color: '#c0788a' }, { label: 'Male', value: a.gender.male, color: '#4f86a8' }, { label: 'Other / unknown', value: a.gender.other + a.gender.unknown, color: '#b9b2a6' }], { label: 'Gender' }))}
    ${chartCard('Current age of living relatives', 'Age today, for living people with a known birth year. This is different from age at death.', barChart(a.current_age.distribution, { label: 'Age distribution of living relatives' }), a.current_age.n ? `<div class="mini-stats">${stat('Average', fmtN(a.current_age.average))}${stat('Median', fmtN(a.current_age.median))}${stat('Youngest', a.current_age.youngest ? String(a.current_age.youngest.age) : '—', a.current_age.youngest ? esc(a.current_age.youngest.name) : '')}${stat('Oldest', a.current_age.oldest ? String(a.current_age.oldest.age) : '—', a.current_age.oldest ? esc(a.current_age.oldest.name) : '')}</div><p class="muted small">Based on ${a.current_age.n} living people with a recorded birth year.</p>` : '')}
    ${chartCard('Age at death', 'How long people lived, for deceased people with both a birth and a death year recorded.', barChart(a.age_at_death.distribution, { color: '#a36b30', label: 'Age at death distribution' }), a.age_at_death.n ? `<div class="mini-stats">${stat('Average', fmtN(a.age_at_death.average))}${stat('Median', fmtN(a.age_at_death.median))}</div><p class="muted small">Based on ${a.age_at_death.n} deceased people with both dates recorded.</p>` : '')}
    ${chartCard('Births by decade', 'Number of people born in each decade, where a birth year is known.', barChart(a.births_by_decade, { label: 'Births by decade' }))}
    ${chartCard('Deaths by decade', 'Number of people who died in each decade, where a death year is known.', barChart(a.deaths_by_decade, { color: '#a36b30', label: 'Deaths by decade' }))}
    ${chartCard('People by generation', 'Generation 1 is the earliest recorded ancestors. Spouses who married into the family are placed with their partner.', barChart(a.generations, { horizontal: true, label: 'People by generation' }), a.generations_unplaced ? `<p class="muted small">${a.generations_unplaced} people are not yet connected to the main tree.</p>` : '')}
    ${chartCard('Most common occupations', 'Occupations recorded on family profiles. Add yours so the picture grows.', barChart(a.occupations, { horizontal: true, label: 'Common occupations' }))}
    ${chartCard('Most common birthplaces', 'Where relatives were born, where a birth place is recorded.', barChart(a.birthplaces, { horizontal: true, color: '#7a5a8a', label: 'Common birthplaces' }))}
  </div>
  <p class="muted small coverage">Recorded so far: ${nf.format(a.coverage.with_birth_year)} birth years · ${nf.format(a.coverage.with_occupation)} occupations · ${nf.format(a.coverage.with_birthplace)} birth places${a.coverage.placeholders ? `. ${a.coverage.placeholders} placeholder entries (unknown ancestors and the sacred rock) are not counted` : ''}${a.coverage.excluded_implausible ? ` · ${a.coverage.excluded_implausible} entries left out because the dates look wrong` : ''}.</p>`;
}
