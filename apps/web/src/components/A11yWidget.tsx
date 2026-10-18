import { useEffect, useState } from 'react';

interface Prefs { size: number; contrast: boolean; underline: boolean; motionOff: boolean }
const KEY = 'botwa_a11y';
const DEFAULT: Prefs = { size: 100, contrast: false, underline: false, motionOff: false };

function load(): Prefs {
  try {
    return { ...DEFAULT, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return DEFAULT;
  }
}

/** Convenience toolbar only – real accessibility is in the markup and styles. */
export function A11yWidget() {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState<Prefs>(load);
  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty('--fs', `${p.size}%`);
    r.dataset.contrast = p.contrast ? 'high' : '';
    r.dataset.links = p.underline ? 'underline' : '';
    r.dataset.motion = p.motionOff ? 'off' : '';
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable: ignore */ }
  }, [p]);
  return (
    <div className="a11y-widget">
      {open && (
        <div className="a11y-panel" id="a11y-panel" role="group" aria-label="התאמות נגישות">
          <div className="row">
            <button onClick={() => setP({ ...p, size: Math.min(200, p.size + 10) })}>הגדלת טקסט</button>
            <button onClick={() => setP({ ...p, size: Math.max(80, p.size - 10) })}>הקטנת טקסט</button>
          </div>
          <button aria-pressed={p.contrast} onClick={() => setP({ ...p, contrast: !p.contrast })}>ניגודיות גבוהה</button>
          <button aria-pressed={p.underline} onClick={() => setP({ ...p, underline: !p.underline })}>הדגשת קישורים</button>
          <button aria-pressed={p.motionOff} onClick={() => setP({ ...p, motionOff: !p.motionOff })}>עצירת אנימציות</button>
          <button onClick={() => setP(DEFAULT)}>איפוס</button>
        </div>
      )}
      <button className="primary" aria-expanded={open} aria-controls="a11y-panel" onClick={() => setOpen(!open)}>
        <span aria-hidden="true">♿ </span>נגישות
      </button>
    </div>
  );
}
