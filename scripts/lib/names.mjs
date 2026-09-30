// Name helpers shared by the importers, the merge and the validator.

/** Lower-case, accent-free, punctuation-free form used for matching only (never stored as the name). */
export const norm = (s) =>
  (s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const slug = (s) => norm(s).replace(/ /g, '-') || 'x';

export const collapse = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * "Ama Buah (Nana Mansa)"  -> { name: "Ama Buah", aka: "Nana Mansa" }
 * "Hana Obiri-Yeboah(Nana Akua)" -> { name: "Hana Obiri-Yeboah", aka: "Nana Akua" }
 * No trailing bracket -> aka is null.  The source spelling is never altered.
 */
export function splitBracket(text) {
  const t = collapse(text);
  const m = t.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (!m || !m[1]) return { name: t, aka: null };
  const aka = collapse(m[2]);
  return { name: collapse(m[1]), aka: aka || null };
}

/** Decode the few HTML entities Family Echo emits inside attribute values. */
export function unescapeHtml(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

/** "John Kwaku Buafo" -> { given: "John Kwaku", surname: "Buafo" } (the app shows given + surname). */
export function splitName(name) {
  const parts = collapse(name).split(' ').filter(Boolean);
  if (parts.length <= 1) return { given: parts[0] ?? '', surname: null };
  return { given: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] };
}

/** First plausible 4-digit year in a free-text date such as "13 AUG 1992". */
export function yearOf(text) {
  const m = String(text ?? '').match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}
