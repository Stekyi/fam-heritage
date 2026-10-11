import { state, $, $$, esc, api, toast, toastError, fmtWhen, fullName } from './core.js';

const MAX_AUDIO_S = 300; const MAX_VIDEO_S = 30; const MAX_BYTES = 3.5 * 1024 * 1024;

// ---------- verification (elders) ----------
export function verifyHtml(p) {
  const elder = state.me?.valid && state.me.role === 'elder';
  const v = p.verified_by
    ? `<span class="verified-badge" title="Checked by an elder">\u2713 Verified by ${esc(p.verified_by)}</span>`
    : '<span class="unverified-badge">Not yet verified by an elder</span>';
  const act = elder ? `<button class="btn" type="button" data-verify="${p.verified_by ? 'remove' : 'add'}">${p.verified_by ? 'Remove verification' : 'Verify this information'}</button>` : '';
  return `<div class="verify-row">${v}${act}</div>`;
}

export function bindVerify(body, p, onChange) {
  const b = $('[data-verify]', body); if (!b) return;
  b.onclick = async () => {
    b.disabled = true;
    try {
      const adding = b.dataset.verify === 'add';
      const r = await api('/api/verify', { method: adding ? 'POST' : 'DELETE', body: { person_id: p.id } });
      p.verified_by = r.verified_by; p.verified_at = adding ? new Date().toISOString() : null;
      toast(adding ? 'Marked as verified.' : 'Verification removed.');
      onChange();
    } catch (e) { toastError(e); b.disabled = false; }
  };
}

// ---------- voice and video memories ----------
const player = (m) => (m.kind === 'video'
  ? `<video controls preload="metadata" playsinline src="${esc(m.url)}"></video>`
  : `<audio controls preload="none" src="${esc(m.url)}"></audio>`);

const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });

function pickType(kind) {
  const list = kind === 'video' ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return list.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

export async function mountMemories(el, p) {
  if (!el) return;
  el.innerHTML = '<section class="sheet-section"><h3>Voice and video memories</h3><p class="muted small">Loading\u2026</p></section>';
  let list = [];
  try { list = (await api(`/api/media?person_id=${p.id}`, { auth: false })).media; } catch { /* shown empty */ }
  const canAdd = !!(state.me?.valid && state.me.linked_person);
  const draw = () => {
    el.innerHTML = `<section class="sheet-section memories"><h3>Voice and video memories</h3>
      ${list.length ? list.map((m) => `<div class="memory"><strong>${esc(m.title)}</strong><small class="muted">${esc(m.uploader_label || '')} \u00b7 ${esc(fmtWhen(m.created_at))}</small>${player(m)}${state.me?.valid && state.me.label && m.uploader_label === state.me.label ? `<button class="btn" type="button" data-rm="${esc(m.id)}">Remove</button>` : ''}</div>`).join('') : `<p class="muted small">No recordings yet.${canAdd ? ` Record ${esc(p.given_name)}\u2019s story, a greeting, or a memory of them.` : ''}</p>`}
      ${canAdd ? `<details class="memory-add"><summary>Add a recording</summary>
        <label class="field"><span class="label">Title</span><input class="input" id="memTitle" maxlength="120" placeholder="e.g. Grandma tells how we came to Wassa"></label>
        <div class="memory-buttons"><button class="btn" type="button" id="memRecA">\ud83c\udfa4 Record voice</button><button class="btn" type="button" id="memRecV">\ud83c\udfa5 Record video (30s)</button><label class="btn">Choose a file<input type="file" id="memFile" accept="audio/*,video/*" hidden></label></div>
        <div id="memLive" class="muted small" aria-live="polite"></div><div id="memPreview"></div>
        <div class="sheet-actions"><button class="btn primary" type="button" id="memSave" disabled>Save memory</button></div></details>` : ''}</section>`;
    $$('[data-rm]', el).forEach((b) => { b.onclick = async () => { try { await api(`/api/media?id=${b.dataset.rm}`, { method: 'DELETE' }); list = list.filter((m) => m.id !== b.dataset.rm); toast('Removed.'); draw(); } catch (e) { toastError(e); } }; });
    if (canAdd) bindAdd();
  };

  function bindAdd() {
    let blob = null; let rec = null; let stream = null; let timer = null;
    const live = $('#memLive', el); const prev = $('#memPreview', el); const save = $('#memSave', el);
    const setBlob = (b) => {
      blob = b; save.disabled = !b;
      if (!b) { prev.innerHTML = ''; return; }
      const kind = b.type.startsWith('video') ? 'video' : 'audio';
      prev.innerHTML = player({ kind, url: URL.createObjectURL(b) });
      live.textContent = `${(b.size / 1024 / 1024).toFixed(1)} MB ready`;
    };
    const stop = () => { clearInterval(timer); if (rec && rec.state !== 'inactive') rec.stop(); stream?.getTracks().forEach((t) => t.stop()); };
    const start = async (kind) => {
      if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) return toast('Recording is not supported in this browser. Please choose a file instead.', 'info');
      if (rec && rec.state !== 'inactive') return stop();
      try { stream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { audio: true, video: { facingMode: 'user', width: 640, height: 480 } } : { audio: true }); }
      catch { return toast('Please allow the microphone (and camera) to record.', 'error'); }
      const mime = pickType(kind); const chunks = [];
      rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000, ...(kind === 'video' ? { videoBitsPerSecond: 500000 } : {}) });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); const b = new Blob(chunks, { type: mime ? mime.split(';')[0] : (kind === 'video' ? 'video/webm' : 'audio/webm') }); $('#memRecA', el).textContent = '\ud83c\udfa4 Record voice'; $('#memRecV', el).textContent = '\ud83c\udfa5 Record video (30s)'; setBlob(b); };
      rec.start(1000);
      const max = kind === 'video' ? MAX_VIDEO_S : MAX_AUDIO_S; let s = 0;
      (kind === 'video' ? $('#memRecV', el) : $('#memRecA', el)).textContent = '\u25a0 Stop';
      timer = setInterval(() => { s += 1; live.textContent = `Recording\u2026 ${s}s (max ${max}s)`; if (s >= max) stop(); }, 1000);
    };
    $('#memRecA', el).onclick = () => start('audio');
    $('#memRecV', el).onclick = () => start('video');
    $('#memFile', el).onchange = (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > MAX_BYTES) { toast('That file is too large (limit about 3.5 MB). Try a shorter recording.', 'error'); return; } setBlob(f); };
    save.onclick = async () => {
      const title = $('#memTitle', el).value.trim();
      if (!title) return toast('Please give this memory a title.', 'error');
      if (!blob) return;
      if (blob.size > MAX_BYTES) return toast('That recording is too large. Please make it shorter.', 'error');
      save.disabled = true; live.textContent = 'Saving\u2026';
      try {
        const type = blob.type || 'audio/webm';
        await api('/api/media', { method: 'POST', body: { person_id: p.id, title, content_type: type, data: await toBase64(blob) } });
        toast('Memory saved. Thank you for preserving it.');
        list = (await api(`/api/media?person_id=${p.id}`, { auth: false })).media; draw();
      } catch (e) { toastError(e); save.disabled = false; live.textContent = ''; }
    };
  }
  draw();
}

export const memoryTitle = (p) => `${fullName(p)} memories`;
