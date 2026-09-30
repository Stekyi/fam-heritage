// Reads the family tree that is drawn (as shapes / text boxes / photos) on the
// "Buafo Family Lineage" sheet of the Vertex42 template.  No cell data is used:
// the tree only exists in xl/drawings/drawingN.xml.
//
// Layout facts the importer relies on (all verified against a rendered copy of the sheet):
//   * generation 1 = the two boxes on the top row (the founding couple)
//   * generation 2 = the row directly beneath (their children)
//   * generation 3 = the vertical stacks under each generation-2 person; a stack shares
//     its parent's x-position exactly
//   * "linked names" = the small text boxes beside a generation-3 person.  The sheet does
//     not say whether they are spouses or children, so they are extracted but NEVER given a
//     relationship.
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { collapse, splitBracket, slug } from './names.mjs';

const YEAR_LINE = /^(\d{4})\s*-\s*(\d{4})?$/;

const els = (n) => Array.from(n.childNodes).filter((c) => c.nodeType === 1);
const child = (n, name) => els(n).find((c) => c.nodeName === name) ?? null;
const attrInt = (n, a) => (n ? Number(n.getAttribute(a)) : null);
const parse = (xml) => new DOMParser().parseFromString(xml, 'text/xml');

function xfrmOf(node) {
  const holder = node.nodeName === 'xdr:grpSp' ? child(node, 'xdr:grpSpPr') : child(node, 'xdr:spPr');
  const x = holder && child(holder, 'a:xfrm');
  if (!x) return null;
  const off = child(x, 'a:off'), ext = child(x, 'a:ext');
  const choff = child(x, 'a:chOff'), chext = child(x, 'a:chExt');
  return {
    off: [attrInt(off, 'x'), attrInt(off, 'y')],
    ext: [attrInt(ext, 'cx'), attrInt(ext, 'cy')],
    choff: choff ? [attrInt(choff, 'x'), attrInt(choff, 'y')] : null,
    chext: chext ? [attrInt(chext, 'cx'), attrInt(chext, 'cy')] : null,
  };
}

function paragraphs(node) {
  const out = [];
  const walk = (n) => {
    for (const c of els(n)) {
      if (c.nodeName === 'a:p') {
        const t = collapse(
          Array.from(c.getElementsByTagName('a:t')).map((x) => x.textContent ?? '').join('')
        );
        if (t) out.push(t);
      } else walk(c);
    }
  };
  walk(node);
  return out;
}

/** Map a rectangle from a shape's own coordinate space up to absolute sheet EMUs. */
function toAbsolute(box, chain) {
  let [x0, y0, x1, y1] = box;
  for (const g of [...chain].reverse()) {
    if (!g || !g.chext || !g.chext[0] || !g.chext[1]) continue;
    const sx = g.ext[0] / g.chext[0], sy = g.ext[1] / g.chext[1];
    x0 = g.off[0] + (x0 - g.choff[0]) * sx; x1 = g.off[0] + (x1 - g.choff[0]) * sx;
    y0 = g.off[1] + (y0 - g.choff[1]) * sy; y1 = g.off[1] + (y1 - g.choff[1]) * sy;
  }
  return [x0, y0, x1, y1];
}

function collectShapes(drawingXml) {
  const doc = parse(drawingXml);
  const shapes = [];
  const anchors = els(doc.documentElement).filter((n) => /Anchor$/.test(n.nodeName));
  anchors.forEach((anchor, anchorIndex) => {
    const walk = (node, chain, groupId) => {
      const leaves = [];
      for (const c of els(node)) {
        if (c.nodeName === 'xdr:grpSp') {
          walk(c, [...chain, xfrmOf(c)], `${groupId}/${leaves.length}:${c.getElementsByTagName('xdr:cNvPr')[0]?.getAttribute('id')}`);
        } else if (c.nodeName === 'xdr:sp' || c.nodeName === 'xdr:pic') {
          const t = xfrmOf(c);
          if (!t) continue;
          const box = toAbsolute([t.off[0], t.off[1], t.off[0] + t.ext[0], t.off[1] + t.ext[1]], chain);
          const nv = c.getElementsByTagName('xdr:cNvPr')[0];
          leaves.push({
            kind: c.nodeName === 'xdr:pic' ? 'pic' : 'sp',
            name: nv?.getAttribute('name') ?? '',
            paras: c.nodeName === 'xdr:sp' ? paragraphs(c) : [],
            box,
            groupId,
            anchorIndex,
          });
        }
      }
      shapes.push(...leaves);
    };
    walk(anchor, [], `a${anchorIndex}`);
  });
  return shapes;
}

async function findDrawingXml(zip, sheetName) {
  const wb = parse(await zip.file('xl/workbook.xml').async('string'));
  const sheet = Array.from(wb.getElementsByTagName('sheet')).find((s) => s.getAttribute('name') === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found in workbook.`);
  const rid = sheet.getAttribute('r:id');
  const rels = parse(await zip.file('xl/_rels/workbook.xml.rels').async('string'));
  const rel = Array.from(rels.getElementsByTagName('Relationship')).find((r) => r.getAttribute('Id') === rid);
  const sheetPath = 'xl/' + rel.getAttribute('Target').replace(/^\/?(xl\/)?/, '');
  const sheetRels = sheetPath.replace('worksheets/', 'worksheets/_rels/') + '.rels';
  const rr = parse(await zip.file(sheetRels).async('string'));
  const d = Array.from(rr.getElementsByTagName('Relationship')).find((r) => /\/drawing$/.test(r.getAttribute('Type')));
  if (!d) throw new Error(`Sheet "${sheetName}" has no drawing.`);
  const target = d.getAttribute('Target').replace(/^\.\.\//, 'xl/');
  return zip.file(target).async('string');
}

/**
 * @param {string} xlsxPath
 * @param {{sheetName:string, gen1MaxY:number, gen2MaxY:number, linkedMaxDistance:number, stackTolerance:number}} cfg
 */
export async function importExcelTree(xlsxPath, cfg) {
  const zip = await JSZip.loadAsync(await readFile(xlsxPath));
  const shapes = collectShapes(await findDrawingXml(zip, cfg.sheetName));
  const warnings = [];

  // ---- persons (rectangles with a "1954 -" style line) and their photo cards ----
  const persons = [];
  const linked = [];
  for (const s of shapes.filter((x) => x.kind === 'sp' && x.paras.length)) {
    const yi = s.paras.findIndex((p) => YEAR_LINE.test(p));
    if (yi >= 0) {
      const ym = s.paras[yi].match(YEAR_LINE);
      const nameLines = s.paras.filter((_, i) => i !== yi);
      const sourceName = collapse(nameLines.join(' '));
      const { name, aka } = splitBracket(sourceName);
      const pic = shapes.find((x) => x.kind === 'pic' && x.groupId === s.groupId);
      const card = pic
        ? [Math.min(s.box[0], pic.box[0]), Math.min(s.box[1], pic.box[1]), Math.max(s.box[2], pic.box[2]), Math.max(s.box[3], pic.box[3])]
        : s.box;
      persons.push({
        sourceName, name, aka,
        birthYear: Number(ym[1]), deathYear: ym[2] ? Number(ym[2]) : null,
        sourceLines: s.paras, anchorIndex: s.anchorIndex,
        cx: (card[0] + card[2]) / 2, cy: (card[1] + card[3]) / 2,
      });
    } else if (/^TextBox/i.test(s.name)) {
      const sourceName = collapse(s.paras.join(' '));
      const { name, aka } = splitBracket(sourceName);
      linked.push({
        sourceName, name, aka, sourceLines: s.paras, anchorIndex: s.anchorIndex,
        cx: (s.box[0] + s.box[2]) / 2, cy: (s.box[1] + s.box[3]) / 2,
      });
    }
  }

  // ---- generations ----
  for (const p of persons) p.tier = p.cy < cfg.gen1MaxY ? 1 : p.cy < cfg.gen2MaxY ? 2 : 3;
  const tier2 = persons.filter((p) => p.tier === 2);

  // generation 3 -> generation 2 by shared x-position of the stack
  for (const p of persons.filter((x) => x.tier === 3)) {
    const best = [...tier2].sort((a, b) => Math.abs(a.cx - p.cx) - Math.abs(b.cx - p.cx))[0];
    if (!best || Math.abs(best.cx - p.cx) > cfg.stackTolerance) {
      throw new Error(`Cannot place "${p.sourceName}" under a generation-2 person (x offset too large).`);
    }
    p.parentSourceName = best.sourceName;
  }
  for (const p of persons.filter((x) => x.tier <= 2)) p.parentSourceName = null;

  // ---- linked names -> the generation-3 person they sit beside (never a relationship) ----
  // 1. Structural: a text box drawn inside the same drawing group as exactly one person belongs to that person.
  // 2. Otherwise geometric: every stand-alone group of boxes is matched as a whole to the generation-3
  //    card whose vertical centre is nearest, among cards immediately to its right.
  const gen3 = persons.filter((p) => p.tier === 3);
  const personsByAnchor = new Map();
  for (const p of gen3) personsByAnchor.set(p.anchorIndex, [...(personsByAnchor.get(p.anchorIndex) ?? []), p]);
  const loose = new Map();
  for (const l of linked) {
    const same = personsByAnchor.get(l.anchorIndex);
    if (same?.length === 1) {
      l.besidePerson = same[0].sourceName;
    } else {
      loose.set(l.anchorIndex, [...(loose.get(l.anchorIndex) ?? []), l]);
    }
  }
  for (const group of loose.values()) {
    const cx = Math.max(...group.map((g) => g.cx));
    const cy = (Math.min(...group.map((g) => g.cy)) + Math.max(...group.map((g) => g.cy))) / 2;
    const cands = gen3
      .filter((p) => p.cx > cx && p.cx - cx < cfg.linkedMaxDistance)
      .map((p) => ({ p, d: Math.abs(p.cy - cy) }))
      .sort((a, b) => a.d - b.d);
    if (!cands.length) throw new Error(`Linked name "${group[0].sourceName}" has no person beside it.`);
    for (const g of group) g.besidePerson = cands[0].p.sourceName;
    if (cands[1] && cands[0].d * 1.35 > cands[1].d) {
      warnings.push(`Linked box "${group[0].sourceName}" sits close to both "${cands[0].p.sourceName}" and "${cands[1].p.sourceName}"; check excelExpectations in data/merge-map.json.`);
    }
  }

  // ---- stable keys ----
  const seen = new Map();
  const keyFor = (x) => {
    const base = slug(x.sourceName);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `xl_${base}${n > 1 ? '_' + n : ''}`;
  };
  const ordered = [
    ...persons.sort((a, b) => a.tier - b.tier || a.anchorIndex - b.anchorIndex || a.cy - b.cy),
    ...linked.sort((a, b) => a.anchorIndex - b.anchorIndex || a.cy - b.cy),
  ];
  ordered.forEach((x) => (x.key = keyFor(x)));
  const keyBySource = new Map(persons.map((p) => [p.sourceName, p.key]));
  for (const p of persons) p.parentKey = p.parentSourceName ? keyBySource.get(p.parentSourceName) : null;
  for (const l of linked) l.besideKey = keyBySource.get(l.besidePerson);

  return { persons, linked, warnings };
}
