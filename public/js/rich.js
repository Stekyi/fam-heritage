// Safe, tiny formatter for the clan history text: headings, page breaks, lists, bold/italic, hard-wrapped paragraphs.
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const inline = (s) => escHtml(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?![*\w])/g, '$1<em>$2</em>');

const CAPS = /^[A-Z0-9][A-Z0-9 ,.&()'’\/:–-]{2,90}$/;
const isCaps = (t) => CAPS.test(t) && (t.match(/[A-Z]/g) || []).length >= 3;

export function richText(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items: [] }
  let cover = false;

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flush = () => { flushPara(); flushList(); };
  const closeCover = () => { if (cover) { out.push('</div>'); cover = false; } };

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { flush(); continue; }

    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h) {
      flush(); closeCover();
      const title = h[1].trim();
      const page = /^Page\s+(\d+)\s*[-–—]\s*(.+)$/i.exec(title);
      if (/^cover(\s+page)?$/i.test(title)) { out.push('<div class="cover">'); cover = true; }
      else if (page) out.push(`<h3 class="page-title"><small>Page ${escHtml(page[1])}</small>${inline(page[2])}</h3>`);
      else out.push(`<h3 class="page-title">${inline(title)}</h3>`);
      continue;
    }

    if (cover) { out.push(isCaps(t) ? `<p class="cover-line cover-main">${inline(t)}</p>` : `<p class="cover-line">${inline(t)}</p>`); continue; }

    const ul = /^[-*•]\s+(.*)$/.exec(t);
    const ol = /^(\d+)[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(ul ? ul[1] : ol[2]);
      continue;
    }
    if (list) { list.items[list.items.length - 1] += ` ${t}`; continue; } // wrapped list item

    if (isCaps(t) && !para.length) { out.push(`<h4>${inline(t)}</h4>`); continue; }
    para.push(t);
  }
  flush(); closeCover();
  return out.join('\n');
}
