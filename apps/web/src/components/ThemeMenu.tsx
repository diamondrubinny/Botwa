import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { adapt, contrast, getUserColor, onColor, setUserColor } from '../brand';
import { ACCENTS, FONTS, useTheme, type ThemeMode } from '../theme';
import { notifyEnabled, setNotifyEnabled } from '../live';

const MODES: [ThemeMode, string][] = [['system', 'לפי המכשיר'], ['soft', 'רך'], ['light', 'בהיר'], ['dark', 'כהה']];
const SWATCH: Record<string, string> = { grape: '#6a3de8', indigo: '#4a4a9e', teal: '#1b6860', rose: '#a02548', amber: '#8a4107', slate: '#3a4659' };

/** Appearance picker: light / dark / follow device, and the accent colour. Choices are kept in this browser only. */
export function ThemeMenu({ align = 'end' }: { align?: 'start' | 'end' }) {
  const { mode, accent, density, font, setMode, setAccent, setDensity, setFont, reset } = useTheme();
  const [custom, setCustom] = useState<string | null>(getUserColor);
  const [pos, setPos] = useState<CSSProperties>({});
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [notify, setNotify] = useState(notifyEnabled);
  const [notifyMsg, setNotifyMsg] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  // Place the menu inside the screen: below the button when there is room, above it otherwise, scrolling if it is still too tall
  // (the side menu clips anything that opens downward from its bottom edge).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = Math.min(320, vw - 16);
      const below = vh - r.bottom - 12, above = r.top - 12;
      const up = below < 420 && above > below;
      const left = Math.max(8, Math.min(vw - w - 8, align === 'end' ? r.right - w : r.left));
      setPos({ width: w, left, right: 'auto', insetInlineStart: 'auto', insetInlineEnd: 'auto', ...(up ? { bottom: vh - r.top + 6, top: 'auto', maxHeight: Math.max(160, above) } : { top: r.bottom + 6, bottom: 'auto', maxHeight: Math.max(160, below) }) });
    };
    place();
    // the menu is attached to the end of the page (so nothing can clip or cover it): move the keyboard focus into it
    requestAnimationFrame(() => pop.current?.querySelector<HTMLElement>('button[role=radio][aria-checked=true], button, input')?.focus());
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { const t = e.target as Node; if (ref.current && !ref.current.contains(t) && !pop.current?.contains(t)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="popover-wrap" ref={ref}>
      <button ref={btn} className="icon-btn" aria-expanded={open} aria-controls="theme-pop" onClick={() => setOpen(!open)} aria-label="מראה המערכת">
        <Icon name="palette" />
      </button>
      {open && createPortal(
        <div id="theme-pop" ref={pop} className={`popover ${align} placed`} style={pos} role="group" aria-label="מראה המערכת">
          <p className="pop-title">מצב</p>
          <div className="seg" role="radiogroup" aria-label="מצב תצוגה">
            {MODES.map(([m, label]) => (
              <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{label}</button>
            ))}
          </div>
          <p className="pop-title">צבע ראשי</p>
          <div className="swatches" role="radiogroup" aria-label="צבע ראשי">
            {ACCENTS.map((a) => (
              <button key={a.key} role="radio" aria-checked={!custom && accent === a.key} aria-label={a.label} title={a.label} className={`swatch${!custom && accent === a.key ? ' on' : ''}`} style={{ background: SWATCH[a.key] }} onClick={() => { setUserColor(null); setCustom(null); setAccent(a.key); }}>
                {!custom && accent === a.key && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
          <details className="adv">
            <summary>אפשרויות מתקדמות</summary>
            <p className="pop-title">צבע מותאם אישית</p>
            <div className="row">
              <label htmlFor="th-color" className="sr-only">בחירת צבע</label>
              <input id="th-color" type="color" value={custom ?? '#6a3de8'} style={{ width: 52, minHeight: 40, padding: 2 }} onChange={(e) => { setCustom(e.target.value); setUserColor(e.target.value); }} />
              <label htmlFor="th-hex" className="sr-only">קוד צבע</label>
              <input id="th-hex" dir="ltr" maxLength={7} placeholder="#0f766e" value={custom ?? ''} style={{ width: 110 }} aria-invalid={!!custom && !/^#[0-9a-f]{6}$/i.test(custom)}
                onChange={(e) => { const v = e.target.value.trim(); setCustom(v || null); if (/^#[0-9a-f]{6}$/i.test(v)) setUserColor(v); else if (!v) setUserColor(null); }} />
              {custom && <button type="button" onClick={() => { setCustom(null); setUserColor(null); }}>איפוס</button>}
            </div>
            {custom && /^#[0-9a-f]{6}$/i.test(custom) && (() => {
              const cs = (n: string, f: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
              const a = adapt(custom, cs('--bg', '#fff'), cs('--surface', '#fff'), document.documentElement.dataset.theme === 'dark');
              return <p className="hint" role="status">ניגודיות הכפתורים {contrast(a.hex, onColor(a.hex)).toFixed(1)}:1{a.changed ? '. הצבע הותאם מעט כדי שיישאר קריא בערכת הנושא הזו.' : '.'}</p>;
            })()}
            <p className="pop-title">גודל טקסט</p>
            <div className="seg wrap" role="radiogroup" aria-label="גודל טקסט">
              {FONTS.map(([k, label]) => <button key={k} role="radio" aria-checked={font === k} className={font === k ? 'on' : ''} onClick={() => setFont(k)}>{label}</button>)}
            </div>
            <p className="pop-title">צפיפות</p>
            <div className="seg" role="radiogroup" aria-label="צפיפות תצוגה">
              <button role="radio" aria-checked={density === 'comfortable'} className={density === 'comfortable' ? 'on' : ''} onClick={() => setDensity('comfortable')}>מרווחת</button>
              <button role="radio" aria-checked={density === 'compact'} className={density === 'compact' ? 'on' : ''} onClick={() => setDensity('compact')}>צפופה</button>
            </div>
            <p className="hint">ההגדרות נשמרות בדפדפן הזה בלבד. הצבע שבחרתם גובר על צבע המותג של המערכת (ובמצב ניגודיות גבוהה לא פועל).</p>
            <button type="button" onClick={() => { reset(); setCustom(null); }}>איפוס כל ההגדרות</button>
          </details>
          {'Notification' in window && (
            <>
              <p className="pop-title">התראות</p>
              <label className="row" style={{ fontWeight: 400, marginBottom: 0 }}>
                <input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={notify} onChange={async (e) => {
                  const on = await setNotifyEnabled(e.target.checked);
                  setNotify(on);
                  setNotifyMsg(e.target.checked && !on ? 'הדפדפן חסם התראות' : '');
                }} />
                התראה על הודעה חדשה (גם כשהאפליקציה סגורה)
              </label>
              <p className="hint" role="status">{notifyMsg || 'ההתראה כללית בלבד, בלי תוכן ההודעה. בנייד כדאי להתקין את האפליקציה (הוספה למסך הבית).'}</p>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
