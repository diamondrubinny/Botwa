import { z } from 'zod';

export const brandSchema = z.object({
  appName: z.string().trim().min(1).max(40),
  /** brand colour as #rrggbb; null = the built-in themes */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
}).strict();
export type Brand = z.infer<typeof brandSchema>;
export const DEFAULT_BRAND: Brand = { appName: 'Botwa', color: null };

/** Only raster images, recognised by their first bytes (never by the name or the type the client claims). SVG is refused: it can carry script. */
export function sniffImage(b: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
export const MAX_LOGO_BYTES = 512 * 1024;

export interface Swatch { hex: string; source: 'theme-color' | 'manifest' | 'css-var' | 'css' }

const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
function parseColor(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return `#${[...m[1]!].map((c) => c + c).join('')}`;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(s);
  if (m) return toHex(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}
function hsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
const distance = (a: string, b: string) => [1, 3, 5].reduce((t, i) => t + (parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) ** 2, 0) ** 0.5;

/**
 * Brand colour candidates found in a page: the declared theme colour, the web-app manifest colour, CSS variables named like
 * primary/brand/accent, then the most used saturated colours in the CSS. Greys, near-white and near-black are skipped.
 * Everything here is a suggestion for a person to choose from.
 */
export function extractBrandColors(html: string, css: string[], manifestColor: string | null): Swatch[] {
  const out: { hex: string; source: Swatch['source']; weight: number }[] = [];
  const meta = /<meta[^>]+name=["']theme-color["'][^>]*>/i.exec(html)?.[0];
  const mc = meta && /content=["']([^"']+)["']/i.exec(meta)?.[1];
  const themeColor = mc ? parseColor(mc) : null;
  if (themeColor) out.push({ hex: themeColor, source: 'theme-color', weight: 1000 });
  if (manifestColor) { const c = parseColor(manifestColor); if (c) out.push({ hex: c, source: 'manifest', weight: 900 }); }
  const counts = new Map<string, { n: number; v: boolean }>();
  for (const sheet of [...css, ...[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!)]) {
    for (const m of sheet.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/g)) {
      const c = parseColor(m[2]!); if (!c) continue;
      const e = counts.get(c) ?? { n: 0, v: false };
      e.n += /primary|brand|accent|main|theme/i.test(m[1]!) ? 25 : 1; e.v ||= /primary|brand|accent|main|theme/i.test(m[1]!);
      counts.set(c, e);
    }
    for (const m of sheet.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*\d{1,3}[\s,]+\d{1,3}[\s,]+\d{1,3}[^)]*\)/g)) {
      const c = parseColor(m[0]); if (!c) continue;
      const e = counts.get(c) ?? { n: 0, v: false };
      e.n++; counts.set(c, e);
    }
  }
  for (const [hex, e] of counts) {
    const { s, l } = hsl(hex);
    if (s < 0.25 || l > 0.9 || l < 0.1) continue;
    out.push({ hex, source: e.v ? 'css-var' : 'css', weight: e.n });
  }
  out.sort((a, b) => b.weight - a.weight);
  const kept: Swatch[] = [];
  for (const c of out) {
    if (kept.some((k) => distance(k.hex, c.hex) < 40)) continue;
    kept.push({ hex: c.hex, source: c.source });
    if (kept.length >= 8) break;
  }
  return kept;
}

/** Logo candidates declared by the page (icons and the share image), as absolute https URLs on any host. */
export function extractLogoCandidates(html: string, base: string): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(/<link[^>]+rel=["'][^"']*(?:apple-touch-icon|icon)[^"']*["'][^>]*>/gi)) {
    const h = /href=["']([^"']+)["']/i.exec(m[0])?.[1]; if (h) urls.push(h);
  }
  const og = /<meta[^>]+property=["']og:image["'][^>]*>/i.exec(html)?.[0];
  const ogc = og && /content=["']([^"']+)["']/i.exec(og)?.[1]; if (ogc) urls.push(ogc);
  const abs: string[] = [];
  for (const u of urls) { try { const a = new URL(u.replace(/&amp;/g, '&'), base); if (a.protocol === 'https:' && !abs.includes(a.toString())) abs.push(a.toString()); } catch { /* ignore */ } }
  return abs.slice(0, 6);
}

export function stylesheetUrls(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)) {
    const h = /href=["']([^"']+)["']/i.exec(m[0])?.[1]; if (!h) continue;
    try { const a = new URL(h.replace(/&amp;/g, '&'), base); if (/^https?:$/.test(a.protocol)) out.push(a.toString()); } catch { /* ignore */ }
  }
  return out.slice(0, 3);
}
export function manifestUrl(html: string, base: string): string | null {
  const l = /<link[^>]+rel=["']manifest["'][^>]*>/i.exec(html)?.[0];
  const h = l && /href=["']([^"']+)["']/i.exec(l)?.[1];
  if (!h) return null;
  try { return new URL(h.replace(/&amp;/g, '&'), base).toString(); } catch { return null; }
}
