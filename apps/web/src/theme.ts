import { useEffect, useState } from 'react';
import { applyBrand, setUserColor } from './brand';

export type ThemeMode = 'system' | 'soft' | 'light' | 'dark';
export const ACCENTS = [
  { key: 'grape', label: 'סגול שמח' },
  { key: 'indigo', label: 'אינדיגו' },
  { key: 'teal', label: 'טורקיז' },
  { key: 'rose', label: 'ורוד' },
  { key: 'amber', label: 'ענבר' },
  { key: 'slate', label: 'אפור-כחול' },
] as const;
export type Accent = (typeof ACCENTS)[number]['key'];

export type Density = 'comfortable' | 'compact';
export const FONTS = [['s', 'קטן'], ['m', 'רגיל'], ['l', 'גדול'], ['xl', 'גדול מאוד']] as const;
export type FontScale = (typeof FONTS)[number][0];
const DENSITY_KEY = 'botwa_theme_density';
const FONT_KEY = 'botwa_theme_font';
const MODE_KEY = 'botwa_theme_mode';
const ACCENT_KEY = 'botwa_theme_accent';

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

export const getMode = (): ThemeMode => (['system', 'soft', 'light', 'dark'] as const).find((m) => m === read(MODE_KEY)) ?? 'system';
export const getAccent = (): Accent => ACCENTS.find((a) => a.key === read(ACCENT_KEY))?.key ?? 'grape';

export const getDensity = (): Density => (read(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable');
export const getFont = (): FontScale => FONTS.find(([k]) => k === read(FONT_KEY))?.[0] ?? 'm';

export function applyTheme(mode: ThemeMode, accent: Accent): void {
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const r = document.documentElement;
  r.dataset.theme = dark ? 'dark' : mode === 'light' ? 'light' : 'soft';
  r.dataset.accent = accent;
  r.dataset.density = getDensity();
  r.dataset.font = getFont();
  applyBrand();
  // keep the browser chrome (address bar / PWA title bar) in tune with the theme
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', getComputedStyle(r).getPropertyValue('--accent').trim() || '#6a3de8');
}

/** Theme state shared through localStorage; follows the OS setting while mode = "system". */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(getMode);
  const [accent, setAccentState] = useState<Accent>(getAccent);
  const [density, setDensityState] = useState<Density>(getDensity);
  const [font, setFontState] = useState<FontScale>(getFont);
  useEffect(() => {
    applyTheme(mode, accent);
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme('system', accent);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mode, accent, density, font]);
  return {
    mode, accent, density, font,
    setMode: (m: ThemeMode) => { write(MODE_KEY, m); setModeState(m); },
    setAccent: (a: Accent) => { write(ACCENT_KEY, a); setAccentState(a); },
    setDensity: (d: Density) => { write(DENSITY_KEY, d); setDensityState(d); },
    setFont: (f: FontScale) => { write(FONT_KEY, f); setFontState(f); },
    reset: () => { for (const k of [MODE_KEY, ACCENT_KEY, DENSITY_KEY, FONT_KEY]) { try { localStorage.removeItem(k); } catch { /* ignore */ } } setUserColor(null); setModeState('system'); setAccentState('grape'); setDensityState('comfortable'); setFontState('m'); },
  };
}
