// Draws the built-in GIFs frame by frame (SVG rendered by Chromium, so Hebrew is shaped and set right to left in Heebo).
// Each loop starts on a complete picture ("shift"): the first frame is what chat apps show as the still preview.
// Usage: NODE_PATH=$(npm root -g) node scripts/gifs/frames.cjs <out-dir>   then: python3 scripts/gifs/assemble.py <out-dir> <dest-dir>
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const W = 320, H = 320, N = 24;
const font = fs.readFileSync(path.join(__dirname, '../../apps/web/public/fonts/heebo-hebrew.woff2')).toString('base64');
const fontL = fs.readFileSync(path.join(__dirname, '../../apps/web/public/fonts/heebo-latin.woff2')).toString('base64');
const C = { purple: '#6a3de8', navy: '#1f2433', yellow: '#ffc21a', orange: '#ff7a1a', green: '#16a34a', red: '#e11d48', white: '#ffffff', sky: '#38bdf8' };
const ease = (x) => 0.5 - Math.cos(Math.PI * x) / 2;          // smooth 0..1
const wave = (t, k = 1) => Math.sin(2 * Math.PI * k * t);       // -1..1, loops
const clamp = (x) => Math.max(0, Math.min(1, x));
const title = (txt, y = 282, size = 40, fill = C.navy) => `<text x="160" y="${y}" text-anchor="middle" direction="rtl" font-family="Heebo" font-weight="800" font-size="${size}" fill="${fill}">${txt}</text>`;
const sparkle = (x, y, s, fill, op = 1) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0-10L2.5-2.5 10 0 2.5 2.5 0 10-2.5 2.5-10 0-2.5-2.5z" fill="${fill}" opacity="${op}"/>`;
const heart = (x, y, s, fill, op = 1) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0 18C-22 2-30-8-30-18c0-10 8-17 16-17 6 0 11 3 14 8 3-5 8-8 14-8 8 0 16 7 16 17 0 10-8 20-30 36z" fill="${fill}" opacity="${op}"/>`;
const helmet = (x, y, s, fill = C.yellow) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-46 6c0-30 20-52 46-52s46 22 46 52z" fill="${fill}"/><rect x="-56" y="2" width="112" height="14" rx="7" fill="${fill}"/><path d="M-8-46h16v40h-16z" fill="#000" opacity=".12"/><path d="M-30-20c6-12 14-18 22-20" stroke="#fff" stroke-width="6" stroke-linecap="round" fill="none" opacity=".55"/></g>`;
const face = (x, y, s, skin = '#e8b48f') => `<g transform="translate(${x} ${y}) scale(${s})"><circle r="44" fill="${skin}"/><circle cx="-15" cy="-2" r="5.5" fill="${C.navy}"/><circle cx="15" cy="-2" r="5.5" fill="${C.navy}"/><path d="M-15 16q15 13 30 0" stroke="${C.navy}" stroke-width="5" stroke-linecap="round" fill="none"/><circle cx="-26" cy="12" r="7" fill="#ff8f8f" opacity=".4"/><circle cx="26" cy="12" r="7" fill="#ff8f8f" opacity=".4"/></g>`;
const gear = (x, y, r, teeth, rot, fill) => {
  let d = ''; for (let i = 0; i < teeth; i++) { const a = (i / teeth) * 360; d += `<rect x="${-r * 0.16}" y="${-r - r * 0.24}" width="${r * 0.32}" height="${r * 0.4}" rx="${r * 0.06}" transform="rotate(${a})"/>`; }
  return `<g transform="translate(${x} ${y}) rotate(${rot})" fill="${fill}">${d}<circle r="${r}"/><circle r="${r * 0.38}" fill="#fff" opacity=".9"/></g>`;
};

const GIFS = {
  thanks: { title: 'תודה!', keywords: 'תודה לב תודה רבה הערכה thanks love', bg: '#ffe1ec', draw(t) {
    const beat = 1 + 0.12 * Math.max(0, Math.sin(2 * Math.PI * 2 * t)) ;
    let s = '';
    for (let i = 0; i < 5; i++) { const p = (t + i / 5) % 1; s += heart(60 + i * 50, 230 - p * 190, 0.35 + 0.1 * (i % 2), '#fb7185', 1 - p); }
    s += heart(160, 130, 2.3 * beat, C.red);
    s += `<path d="M130 100c6-10 14-14 22-14" stroke="#fff" stroke-width="7" stroke-linecap="round" fill="none" opacity=".5" transform="translate(160 130) scale(${beat}) translate(-160 -130)"/>`;
    return s + title('תודה!', 288, 46, '#9f1239');
  } },
  hello: { title: 'שלום!', keywords: 'שלום היי ברוכים הבאים נפנוף hello hi welcome', bg: '#dbf1ff', draw(t) {
    const r = 22 * wave(t, 2);
    let s = `<path d="M70 250c4-40 40-62 80-62s76 22 80 62z" fill="${C.orange}"/><path d="M96 250h24M190 250h24" stroke="#f5f7fb" stroke-width="8"/>`;
    s += face(150, 140, 1) + helmet(150, 104, 1.02);
    s += `<g transform="translate(236 168) rotate(${r})"><rect x="-13" y="-62" width="26" height="62" rx="13" fill="${C.orange}"/><circle cx="0" cy="-74" r="20" fill="#e8b48f"/><path d="M-12-92v-14M-4-95v-18M4-95v-18M12-92v-14" stroke="#e8b48f" stroke-width="8" stroke-linecap="round"/></g>`;
    s += `<g opacity="${0.4 + 0.6 * Math.abs(wave(t, 2))}"><path d="M268 70q10 10 0 22M282 62q16 18 0 38" stroke="${C.purple}" stroke-width="5" fill="none" stroke-linecap="round"/></g>`;
    return s + title('שלום!', 300, 42);
  } },
  working: { title: 'בטיפול', keywords: 'בטיפול מטפלים עובדים על זה בבדיקה working on it', bg: '#ede9fe', draw(t) {
    let s = gear(130, 130, 52, 10, t * 72, C.purple) + gear(214, 184, 34, 8, -t * 110 + 12, C.orange);
    // the word is centred a little to the right; the dots follow it on its left (Hebrew reads right to left)
    const dots = [0, 1, 2].map((i) => `<circle cx="${88 - i * 17}" cy="282" r="6" fill="${C.navy}" opacity="${0.25 + 0.75 * clamp(Math.sin(Math.PI * ((t * 3 - i / 3 + 3) % 1)))}"/>`).join('');
    return s + title('בטיפול', 294, 42, C.navy).replace('x="160"', 'x="168"') + dots;
  } },
  moment: { title: 'רגע אחד…', keywords: 'רגע אחד המתנה סבלנות שעון חול wait moment', bg: '#fff4cc', draw(t) {
    const flip = t > 0.8 ? ease((t - 0.8) / 0.2) * 180 : 0;
    const p = clamp(t / 0.8);
    const top = 40 * (1 - p), bot = 40 * p;
    let g = `<path d="M-50-80h100M-50 80h100" stroke="${C.navy}" stroke-width="12" stroke-linecap="round"/>`;
    g += `<path d="M-40-74c0 34 30 46 30 74s-30 40-30 74h80c0-34-30-46-30-74s30-40 30-74z" fill="#fff" stroke="${C.navy}" stroke-width="7" stroke-linejoin="round"/>`;
    g += `<path d="M${-40 + (40 - top) * 0.5}${-74 + (40 - top)}h${80 - (40 - top)}l${-(40 - (40 - top) * 0.5) + 10} ${top + 10}h-20z" fill="${C.orange}" opacity="${top > 1 ? 1 : 0}"/>`;
    g += `<path d="M-36 74c6-${bot * 0.9} 28-${bot} 36-${bot}s30 ${bot * 0.1} 36 ${bot}z" fill="${C.orange}"/>`;
    if (t < 0.8) g += `<path d="M0 0v${66 - bot * 0.8}" stroke="${C.orange}" stroke-width="4" stroke-dasharray="4 6" stroke-dashoffset="${-t * 60}"/>`;
    return `<g transform="translate(160 132) rotate(${flip})">${g}</g>` + title('רגע אחד…', 290, 40);
  } },
  done: { title: 'בוצע!', keywords: 'בוצע טופל הושלם וי סיימנו done check', bg: '#dcfce7', shift: 0.62, draw(t) {
    const pop = t < 0.25 ? ease(t / 0.25) : 1;
    const draw = clamp((t - 0.2) / 0.35);
    let s = '';
    for (let i = 0; i < 8; i++) { const a = (i / 8) * 2 * Math.PI; const r1 = 78 + 30 * clamp((t - 0.45) / 0.3), r2 = r1 + 16; const op = t > 0.45 ? 1 - clamp((t - 0.6) / 0.35) : 0;
      s += `<path d="M${160 + r1 * Math.cos(a)} ${130 + r1 * Math.sin(a)}L${160 + r2 * Math.cos(a)} ${130 + r2 * Math.sin(a)}" stroke="${C.green}" stroke-width="7" stroke-linecap="round" opacity="${op}"/>`; }
    s += `<circle cx="160" cy="130" r="${70 * pop}" fill="${C.green}"/>`;
    s += `<path d="M126 132l24 24 46-50" stroke="#fff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-dasharray="110" stroke-dashoffset="${110 * (1 - draw)}"/>`;
    return s + title('בוצע!', 284, 46, '#14532d');
  } },
  glad: { title: 'שמחנו לעזור', keywords: 'שמחנו לעזור בשמחה לייק אגודל מעולה glad to help thumbs up', bg: '#ffe8d6', draw(t) {
    const b = -14 * Math.abs(Math.sin(Math.PI * 2 * t)), r = -8 * Math.sin(Math.PI * 2 * t);
    let s = `<g transform="translate(160 ${132 + b}) rotate(${r})"><rect x="-58" y="-6" width="34" height="78" rx="10" fill="${C.purple}"/><path d="M-22 70h62c12 0 20-8 22-18l10-44c2-12-6-22-18-22h-30l6-30c3-14-6-26-18-26-6 0-10 4-12 10L-22 0z" fill="#f2b98d"/><path d="M14-6h30M18 14h28M18 34h26" stroke="#c98e64" stroke-width="5" stroke-linecap="round"/></g>`;
    [[64, 70, 0], [258, 92, 0.33], [240, 196, 0.66], [76, 182, 0.5]].forEach(([x, y, o]) => { const p = (t + o) % 1; s += sparkle(x, y, 1 + 0.9 * Math.sin(Math.PI * p), C.yellow, Math.sin(Math.PI * p)); });
    return s + title('שמחנו לעזור', 286, 38, '#7c2d12');
  } },
  safety: { title: 'בטיחות קודם!', keywords: 'בטיחות קודם קסדה זהירות הגנה safety first helmet', bg: C.navy, shift: 0.6, draw(t) {
    const fall = t < 0.35 ? -150 * (1 - ease(t / 0.35)) : 0;
    const bounce = t >= 0.35 && t < 0.55 ? -18 * Math.sin(Math.PI * (t - 0.35) / 0.2) : 0;
    const squash = t >= 0.33 && t < 0.42 ? 1 - 0.12 * Math.sin(Math.PI * (t - 0.33) / 0.09) : 1;
    let s = `<g transform="translate(160 ${150 + fall + bounce}) scale(${2 - squash + 0.05} ${squash * 1.95})">${helmet(0, 0, 1)}</g>`;
    let st = ''; for (let i = -2; i < 12; i++) st += `<path d="M${i * 40 + t * 80} 236l20 0-34 34h-20z" fill="${C.yellow}"/>`;
    s += `<clipPath id="cp"><rect x="0" y="236" width="320" height="34"/></clipPath><rect x="0" y="236" width="320" height="34" fill="#111827"/><g clip-path="url(#cp)">${st}</g>`;
    return s + title('בטיחות קודם!', 310, 34, C.yellow);
  } },
  received: { title: 'קיבלנו!', keywords: 'קיבלנו התקבל הפנייה נקלטה מכתב received got it', bg: '#dbf1ff', shift: 0.8, draw(t) {
    const p = ease(clamp(t / 0.5));
    const x = 300 - 140 * p, y = 40 + 120 * p - 60 * Math.sin(Math.PI * p);
    const land = t > 0.5 ? Math.sin(Math.PI * clamp((t - 0.5) / 0.2)) : 0;
    let s = `<path d="M84 170h152l-14 64H98z" fill="${C.purple}" transform="translate(0 ${4 * land})"/><path d="M70 170h180" stroke="${C.navy}" stroke-width="10" stroke-linecap="round"/>`;
    const op = t < 0.62 ? 1 : 1 - clamp((t - 0.62) / 0.12);
    s += `<g transform="translate(${x} ${y}) rotate(${-25 * (1 - p)})" opacity="${op}"><rect x="-40" y="-27" width="80" height="54" rx="7" fill="#fff" stroke="${C.navy}" stroke-width="5"/><path d="M-36-22l36 26 36-26" stroke="${C.navy}" stroke-width="5" fill="none" stroke-linejoin="round"/></g>`;
    if (t > 0.65) s += `<g opacity="${1 - clamp((t - 0.85) / 0.15)}"><circle cx="160" cy="140" r="${18 + 10 * clamp((t - 0.65) / 0.2)}" fill="${C.green}"/><path d="M151 141l7 7 13-14" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    return s + title('קיבלנו!', 288, 44);
  } },
  niceday: { title: 'יום נעים!', keywords: 'יום נעים יום טוב שמש ברכה have a nice day', bg: '#e0f2fe', draw(t) {
    const rise = 6 * wave(t);
    let rays = ''; for (let i = 0; i < 12; i++) rays += `<rect x="-5" y="-92" width="10" height="24" rx="5" transform="rotate(${i * 30 + t * 30})"/>`;
    let s = `<g transform="translate(160 ${150 + rise})" fill="${C.yellow}">${rays}<circle r="56"/><circle cx="-18" cy="-8" r="6" fill="${C.navy}"/><circle cx="18" cy="-8" r="6" fill="${C.navy}"/><path d="M-20 14q20 18 40 0" stroke="${C.navy}" stroke-width="6" stroke-linecap="round" fill="none"/></g>`;
    s += `<path d="M0 236q80-46 160-8t160-14V320H0z" fill="#86efac"/><path d="M0 252q100-30 200 0t120-6V320H0z" fill="${C.green}"/>`;
    return s + title('יום נעים!', 298, 40, '#f8fafc');
  } },
  bravo: { title: 'כל הכבוד!', keywords: 'כל הכבוד הצלחה גביע מעולה אלופים bravo well done', bg: '#ede9fe', draw(t) {
    let s = '';
    const cols = [C.yellow, C.orange, C.purple, C.green, C.red, C.sky];
    for (let i = 0; i < 14; i++) { const p = (t + (i * 0.37) % 1) % 1; const x = 20 + ((i * 61) % 280); s += `<rect x="${x + 10 * wave(p)}" y="${-10 + p * 250}" width="9" height="15" rx="2" fill="${cols[i % 6]}" transform="rotate(${p * 360 + i * 40} ${x} ${-10 + p * 250})"/>`; }
    const r = 4 * wave(t, 2);
    s += `<g transform="translate(160 136) rotate(${r})"><path d="M-46-62h92v30c0 32-20 54-46 54s-46-22-46-54z" fill="${C.yellow}"/><path d="M-46-50h-20c0 26 12 38 26 40M46-50h20c0 26-12 38-26 40" stroke="${C.yellow}" stroke-width="9" fill="none"/><rect x="-10" y="20" width="20" height="26" fill="#e5a50a"/><rect x="-36" y="44" width="72" height="16" rx="5" fill="${C.navy}"/><path d="M-24-48c0 22 8 36 18 42" stroke="#fff" stroke-width="7" stroke-linecap="round" fill="none" opacity=".5"/></g>`;
    s += sparkle(96, 84, 1.2 + 0.6 * wave(t, 2), '#fff') + sparkle(228, 96, 1.2 - 0.6 * wave(t, 2), '#fff');
    return s + title('כל הכבוד!', 286, 42, C.purple);
  } },
  agent: { title: 'נציג/ה בדרך אליך', keywords: 'נציג בדרך מיד חוזרים אליך נציגה ממתינים agent coming', bg: '#e0f2fe', draw(t) {
    let s = `<path d="M44 260c4-44 34-66 72-66s68 22 72 66z" fill="${C.purple}"/>` + face(116, 140, 0.9, '#c98e64');
    s += `<path d="M70 132c0-30 20-52 46-52s46 22 46 52" stroke="${C.navy}" stroke-width="9" fill="none"/><rect x="60" y="124" width="18" height="32" rx="8" fill="${C.navy}"/><rect x="154" y="124" width="18" height="32" rx="8" fill="${C.navy}"/><path d="M164 156c0 18-12 26-30 26" stroke="${C.navy}" stroke-width="5" fill="none"/><circle cx="132" cy="182" r="6" fill="${C.navy}"/>`;
    const bob = 4 * wave(t);
    s += `<g transform="translate(0 ${bob})"><path d="M196 62h88a18 18 0 0 1 18 18v40a18 18 0 0 1-18 18h-58l-22 18v-18h-8a18 18 0 0 1-18-18V80a18 18 0 0 1 18-18z" fill="#fff" stroke="${C.navy}" stroke-width="4"/>`;
    s += [0, 1, 2].map((i) => `<circle cx="${218 + i * 22}" cy="${100 - 8 * Math.max(0, Math.sin(2 * Math.PI * (t * 2 - i / 6)))}" r="7" fill="${C.purple}"/>`).join('') + '</g>';
    return s + title('נציג/ה בדרך אליך', 296, 30);
  } },
  takecare: { title: 'שמרו על עצמכם', keywords: 'שמרו על עצמכם בריאות בטיחות מגן דאגה take care', bg: '#dcfce7', draw(t) {
    const glow = 0.5 + 0.5 * wave(t);
    let s = `<circle cx="160" cy="130" r="${84 + 8 * glow}" fill="${C.green}" opacity="${0.12 + 0.12 * glow}"/>`;
    s += `<path d="M160 44l72 26v52c0 46-30 78-72 94-42-16-72-48-72-94V70z" fill="${C.green}"/><path d="M160 58l58 21v43c0 38-24 64-58 78z" fill="#fff" opacity=".18"/>`;
    s += heart(160, 122, 1.05 + 0.08 * Math.max(0, wave(t, 2)), '#fff');
    return s + title('שמרו על עצמכם', 288, 36, '#14532d');
  } },
};

(async () => {
  const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(Object.fromEntries(Object.entries(GIFS).map(([k, g]) => [k, { title: g.title, keywords: g.keywords }])), null, 2));
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const css = `@font-face{font-family:Heebo;src:url(data:font/woff2;base64,${font}) format('woff2');unicode-range:U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F}@font-face{font-family:Heebo;src:url(data:font/woff2;base64,${fontL}) format('woff2')}body{margin:0}`;
  await p.setContent(`<html><head><style>${css}</style></head><body><div id="s"></div></body></html>`);
  await p.evaluate(() => document.fonts.load('800 40px Heebo', 'שלום abc'));
  for (const [k, g] of Object.entries(GIFS)) {
    fs.mkdirSync(path.join(out, k), { recursive: true });
    for (let i = 0; i < N; i++) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${g.bg}"/>${g.draw((i / N + (g.shift ?? 0)) % 1)}</svg>`;
      await p.evaluate((h) => { document.getElementById('s').innerHTML = h; }, svg);
      await p.locator('#s svg').screenshot({ path: path.join(out, k, `${String(i).padStart(2, '0')}.png`) });
    }
  }
  await b.close();
})();
