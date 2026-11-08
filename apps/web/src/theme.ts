import { useEffect, useState } from 'react';
import { applyBrand } from './brand';

export type ThemeMode = 'system' | 'soft' | 'light' | 'dark';
export const ACCENTS = [
  { key: 'indigo', label: 'אינדיגו' },
  { key: 'teal', label: 'טורקיז' },
  { key: 'rose', label: 'ורוד' },
  { key: 'amber', label: 'ענבר' },
  { key: 'slate', label: 'אפור-כחול' },
] as const;
export type Accent = (typeof ACCENTS)[number]['key'];

const MODE_KEY = 'botwa_theme_mode';
const ACCENT_KEY = 'botwa_theme_accent';

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

export const getMode = (): ThemeMode => (['system', 'soft', 'light', 'dark'] as const).find((m) => m === read(MODE_KEY)) ?? 'system';
export const getAccent = (): Accent => ACCENTS.find((a) => a.key === read(ACCENT_KEY))?.key ?? 'indigo';

export function applyTheme(mode: ThemeMode, accent: Accent): void {
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const r = document.documentElement;
  r.dataset.theme = dark ? 'dark' : mode === 'light' ? 'light' : 'soft';
  r.dataset.accent = accent;
  applyBrand();
  // keep the browser chrome (address bar / PWA title bar) in tune with the theme
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', getComputedStyle(r).getPropertyValue('--accent').trim() || '#4338ca');
}

/** Theme state shared through localStorage; follows the OS setting while mode = "system". */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(getMode);
  const [accent, setAccentState] = useState<Accent>(getAccent);
  useEffect(() => {
    applyTheme(mode, accent);
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme('system', accent);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mode, accent]);
  return {
    mode, accent,
    setMode: (m: ThemeMode) => { write(MODE_KEY, m); setModeState(m); },
    setAccent: (a: Accent) => { write(ACCENT_KEY, a); setAccentState(a); },
  };
}
