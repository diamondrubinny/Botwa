import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { ACCENTS, useTheme, type ThemeMode } from '../theme';

const MODES: [ThemeMode, string][] = [['system', 'לפי המכשיר'], ['light', 'בהיר'], ['dark', 'כהה']];
const SWATCH: Record<string, string> = { indigo: '#4338ca', teal: '#0f766e', rose: '#be123c', amber: '#a24a06', slate: '#334155' };

/** Appearance picker: light / dark / follow device, and the accent colour. Choices are kept in this browser only. */
export function ThemeMenu({ align = 'end' }: { align?: 'start' | 'end' }) {
  const { mode, accent, setMode, setAccent } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="popover-wrap" ref={ref}>
      <button className="icon-btn" aria-expanded={open} aria-controls="theme-pop" onClick={() => setOpen(!open)} aria-label="מראה המערכת">
        <Icon name="palette" />
      </button>
      {open && (
        <div id="theme-pop" className={`popover ${align}`} role="group" aria-label="מראה המערכת">
          <p className="pop-title">מצב</p>
          <div className="seg" role="radiogroup" aria-label="מצב תצוגה">
            {MODES.map(([m, label]) => (
              <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{label}</button>
            ))}
          </div>
          <p className="pop-title">צבע ראשי</p>
          <div className="swatches" role="radiogroup" aria-label="צבע ראשי">
            {ACCENTS.map((a) => (
              <button key={a.key} role="radio" aria-checked={accent === a.key} aria-label={a.label} title={a.label} className={`swatch${accent === a.key ? ' on' : ''}`} style={{ background: SWATCH[a.key] }} onClick={() => setAccent(a.key)}>
                {accent === a.key && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
