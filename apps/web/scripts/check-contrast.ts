// Verifies WCAG AA contrast for every theme (light/dark) x accent combination defined in src/styles.css.
// Run: npx tsx apps/web/scripts/check-contrast.ts   (exits 1 on any failure)
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const blocks = [...css.matchAll(/:root((?:\[[^\]]+\])+)\s*\{([^}]*)\}/g)];
const vars = (sel: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [, s, body] of blocks) {
    if (s === sel) for (const m of body!.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  }
  return out;
};

function parse(c: string, over?: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    let h = hex[1]!; if (h.length === 3) h = [...h].map((x) => x + x).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(c);
  if (rgba) { const p = rgba[1]!.split(',').map((x) => parseFloat(x)); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; }
  throw new Error(`cannot parse ${c} ${over ?? ''}`);
}
const over = (fg: ReturnType<typeof parse>, bg: ReturnType<typeof parse>) => [0, 1, 2].map((i) => Math.round(fg[i]! * fg[3] + bg[i]! * (1 - fg[3])));
const lum = (rgb: number[]) => { const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

let failures = 0;
let checks = 0;
for (const theme of ['light', 'soft', 'dark']) {
  for (const accent of ['indigo', 'teal', 'rose', 'amber', 'slate']) {
    const v = { ...vars(`[data-theme='${theme}']`), ...vars(`[data-theme='${theme}'][data-accent='${accent}']`) };
    const col = (k: string, on?: number[]) => { const p = parse(v[k]!, k); return on ? over(p, [...on, 1] as never) : p.slice(0, 3); };
    const bg = col('--bg') as number[], surface = col('--surface') as number[], surface2 = col('--surface-2') as number[];
    const soft = (base: number[]) => col('--accent-soft', base);
    const pairs: [string, number[], number[], number][] = [
      ['text on bg', col('--text') as number[], bg, 4.5],
      ['text on surface', col('--text') as number[], surface, 4.5],
      ['text on surface-2', col('--text') as number[], surface2, 4.5],
      ['muted on surface', col('--muted') as number[], surface, 4.5],
      ['muted on bg', col('--muted') as number[], bg, 4.5],
      ['muted on surface-2', col('--muted') as number[], surface2, 4.5],
      ['button text on accent', col('--on-accent') as number[], col('--accent') as number[], 4.5],
      ['accent link on surface', col('--accent') as number[], surface, 4.5],
      ['accent link on bg', col('--accent') as number[], bg, 4.5],
      ['accent link on surface-2', col('--accent') as number[], surface2, 4.5],
      ['text on selected item (accent-soft over surface)', col('--text') as number[], soft(surface), 4.5],
      ['muted on selected item', col('--muted') as number[], soft(surface), 4.5],
      ['danger on surface', col('--danger') as number[], surface, 4.5],
      ['ok on surface', col('--ok') as number[], surface, 4.5],
      ['warn on surface', col('--warn') as number[], surface, 4.5],
      ['danger on bg', col('--danger') as number[], bg, 4.5],
      ['input border on surface (UI component boundary)', col('--input-border') as number[], surface, 3],
      ['accent focus ring on surface (UI)', col('--accent') as number[], surface, 3],
    ];
    for (const [name, fg, b, min] of pairs) {
      checks++;
      const r = ratio(fg, b);
      if (r < min) { failures++; console.log(`FAIL ${theme}/${accent}: ${name} = ${r.toFixed(2)} (< ${min})`); }
    }
  }
}
console.log(failures ? `${failures} FAILURES of ${checks} checks` : `ALL ${checks} contrast checks passed (WCAG AA)`);
process.exit(failures ? 1 : 0);
