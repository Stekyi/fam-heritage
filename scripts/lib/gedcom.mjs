// Parses the GEDCOM that Family Echo embeds in its HTML export
// (<INPUT TYPE="hidden" ID="gedcom" VALUE="...">).
import { collapse, unescapeHtml } from './names.mjs';

export function extractGedcomFromHtml(html) {
  const m = html.match(/<INPUT\s+TYPE="hidden"\s+ID="gedcom"\s+VALUE="([\s\S]*?)">/i);
  if (!m) throw new Error('No embedded GEDCOM (hidden input #gedcom) found in the Family Echo HTML export.');
  return unescapeHtml(m[1]);
}

function parseLines(text) {
  const records = [];
  let stack = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = raw.match(/^(\d+) (?:(@[^@]+@) )?(\S+)(?: (.*))?$/);
    if (!m) throw new Error(`Unparseable GEDCOM line: ${raw}`);
    const level = Number(m[1]);
    const node = { tag: m[3], val: m[4] ?? '', xref: m[2] ?? null, kids: [] };
    if (level === 0) {
      records.push(node);
      stack = [node];
    } else {
      while (stack.length > level) stack.pop();
      stack[stack.length - 1].kids.push(node);
      stack.push(node);
    }
  }
  return records;
}

const kids = (n, tag) => n.kids.filter((k) => k.tag === tag);
const first = (n, tag) => kids(n, tag)[0]?.val ?? null;
// GEDCOM continuation lines (CONC/CONT) are folded back into their parent value.
const textOf = (n) =>
  n.val + n.kids.filter((k) => k.tag === 'CONC').map((k) => k.val).join('') +
  n.kids.filter((k) => k.tag === 'CONT').map((k) => '\n' + k.val).join('');

const stripId = (x) => (x ? x.replace(/@/g, '') : null);

/** Family Echo writes surnames inside slashes; "Nyantah /(Kokoo)/" is the person "Nyantah (Kokoo)". */
export const displayNameFromGedcom = (raw) => collapse((raw ?? '').replace(/\//g, ' '));

export function parseFamilyEchoHtml(html) {
  const records = parseLines(extractGedcomFromHtml(html));
  const people = [];
  const families = [];
  for (const r of records) {
    if (r.tag === 'INDI') {
      const nameNode = kids(r, 'NAME')[0];
      const birt = kids(r, 'BIRT')[0];
      const deat = kids(r, 'DEAT')[0];
      const note = kids(r, 'NOTE')[0];
      const bio = note ? textOf(note).replace(/^Bio notes:\s*/i, '') : null;
      people.push({
        htmlId: stripId(r.xref), // e.g. "I61"
        rawName: nameNode?.val ?? '',
        name: displayNameFromGedcom(nameNode?.val ?? ''),
        given: nameNode ? first(nameNode, 'GIVN') : null,
        surname: nameNode ? first(nameNode, 'SURN') : null,
        sex: first(r, 'SEX'),
        birthDate: birt ? first(birt, 'DATE') : null,
        deathDate: deat ? first(deat, 'DATE') : null,
        occupation: first(r, 'OCCU'),
        bio,
        famc: kids(r, 'FAMC').map((k) => stripId(k.val)),
        fams: kids(r, 'FAMS').map((k) => stripId(k.val)),
      });
    } else if (r.tag === 'FAM') {
      families.push({
        htmlId: stripId(r.xref),
        husband: stripId(first(r, 'HUSB')),
        wife: stripId(first(r, 'WIFE')),
        children: kids(r, 'CHIL').map((k) => stripId(k.val)),
      });
    }
  }
  return { people, families };
}
