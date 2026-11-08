import { useEffect, useState } from 'react';

export interface Brand { appName: string; color: string | null; hasLogo: boolean; v: number }
const DEFAULT: Brand = { appName: 'Botwa', color: null, hasLogo: false, v: 0 };

let current: Brand = DEFAULT;
const listeners = new Set<(b: Brand) => void>();

// ---- WCAG contrast (same formula as the server) ----
const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (c: number[]) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const lum = (hex: string) => { const [r, g, b] = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const mix = (hex: string, target: number, t: number) => toHex(rgb(hex).map((v) => v + (target - v) * t));

/**
 * The brand colour as used on a page background: darkened on light themes, lightened on dark ones, until it reads at 4.5:1
 * (WCAG AA) against the theme's background and surfaces. Returns the colour and whether it had to change.
 */
export function adapt(color: string, bg: string, surface: string, dark: boolean): { hex: string; changed: boolean } {
  let hex = color;
  for (let i = 0; i < 20 && Math.min(contrast(hex, bg), contrast(hex, surface)) < 4.5; i++) hex = mix(hex, dark ? 255 : 0, 0.1);
  return { hex, changed: hex !== color };
}
export const onColor = (hex: string) => (contrast(hex, '#ffffff') >= contrast(hex, '#111111') ? '#ffffff' : '#111111');

const cssColor = (name: string, fallback: string) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
};

/** Put the brand colour on the page through the same variables the built-in themes use (inline, so it beats them). */
export function applyBrand(): void {
  const r = document.documentElement;
  const props = ['--accent', '--on-accent', '--accent-soft'];
  if (!current.color || r.dataset.contrast === 'high') { props.forEach((p) => r.style.removeProperty(p)); return; }
  const dark = r.dataset.theme === 'dark';
  r.style.removeProperty('--accent'); // read the theme's own background without our override influencing anything
  const a = adapt(current.color, cssColor('--bg', dark ? '#0f1220' : '#ffffff'), cssColor('--surface', dark ? '#171a2b' : '#ffffff'), dark);
  const [x, y, z] = rgb(a.hex);
  r.style.setProperty('--accent', a.hex);
  r.style.setProperty('--on-accent', onColor(a.hex));
  r.style.setProperty('--accent-soft', `rgba(${x}, ${y}, ${z}, ${dark ? 0.16 : 0.1})`);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', a.hex);
}

export function setBrand(b: Brand): void {
  current = b;
  applyBrand();
  listeners.forEach((l) => l(b));
}

export async function loadBrand(): Promise<void> {
  try {
    const res = await fetch('/branding', { credentials: 'same-origin' });
    if (res.ok) setBrand((await res.json()) as Brand);
  } catch { /* keep the defaults when the server cannot be reached */ }
}

export function useBrand(): Brand {
  const [b, setB] = useState(current);
  useEffect(() => { listeners.add(setB); setB(current); return () => { listeners.delete(setB); }; }, []);
  return b;
}
export const logoSrc = (b: Brand) => `/branding/logo?v=${b.v}`;
