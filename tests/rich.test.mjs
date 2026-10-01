import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { richText } from '../public/js/rich.js';

test('headings, page markers, lists and wrapped paragraphs', () => {
  const h = richText('### Page 3 - Settlement and Chiefs\n\nORIGIN\n\nThe family came from\nAkyim Oda.\n\n- Anim Berimah\n- King Kofuo (born with\n  a closed fist)\n\n1. That the area exists\n2. That it has borders');
  assert.match(h, /<h3 class="page-title"><small>Page 3<\/small>Settlement and Chiefs<\/h3>/);
  assert.match(h, /<h4>ORIGIN<\/h4>/);
  assert.match(h, /<p>The family came from Akyim Oda\.<\/p>/);
  assert.match(h, /<ul><li>Anim Berimah<\/li><li>King Kofuo \(born with a closed fist\)<\/li><\/ul>/);
  assert.match(h, /<ol><li>That the area exists<\/li><li>That it has borders<\/li><\/ol>/);
});
test('bold and italic render; HTML is escaped', () => {
  const h = richText('A **bold** and *soft* word <script>alert(1)</script>');
  assert.match(h, /<strong>bold<\/strong>/); assert.match(h, /<em>soft<\/em>/);
  assert.ok(!h.includes('<script>'));
});
test('the real history text leaves no raw markdown markers', () => {
  const html = richText(fs.readFileSync(new URL('../data/history.txt', import.meta.url), 'utf8'));
  const text = html.replace(/<[^>]+>/g, '');
  assert.ok(!/^\s*#{1,6}\s/m.test(text) && !text.includes('###') && !text.includes('**'));
  assert.ok((html.match(/page-title/g) || []).length >= 8);
  assert.match(html, /class="cover"/);
});
