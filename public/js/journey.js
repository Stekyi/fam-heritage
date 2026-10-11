import { esc } from './core.js';

// Only facts already recorded in the clan history on this site. No invented dates.
const STEPS = [
  ['Asankran', 'The clan\u2019s early home. Nana Kye Buadu I and his sister Anima Kyirisuo set out from Asankran.'],
  ['Akim Oda', 'The Oda Asankran Branch. Nana Kye Buadu I is listed as its first chief.'],
  ['The great migration', 'He led the people from Akim Oda towards Wassa Amenfi, as confirmed in the 1990 petition letter.'],
  ['Gyedua Kankan', 'Near the Koto stream, Nana Kye Buadu I passed away during the journey.'],
  ['Wassa Amenfi', 'The people settled here. Gyapanyin Kyimah succeeded him as leader.'],
];

export function renderJourney(root) {
  root.innerHTML = `<section class="content"><div class="card journey"><span class="eyebrow">OUR JOURNEY</span><h2>From Asankran to Wassa Amenfi</h2><p class="muted">A simple picture of the migration our clan history describes. Not a map to scale.</p>
    <ol class="journey-line">${STEPS.map(([h, t], i) => `<li><span class="journey-dot" aria-hidden="true">${i + 1}</span><div><strong>${esc(h)}</strong><p>${esc(t)}</p></div></li>`).join('')}</ol>
    <p><a class="btn" href="#/history">Read the full clan history</a> <a class="btn" href="#/tree">Open the family tree</a></p></div></section>`;
}
