import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../api';
import { ALL_EMOJI, EMOJI_GROUPS, type Emoji } from './emoji-data';

const RECENT_KEY = 'botwa_recent_emoji';
const COLS = 8;

/** Reduced motion: the system setting or the accessibility toolbar's "stop animations". */
export function motionOff(): boolean {
  return document.documentElement.dataset.motion === 'off' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** A small panel above the composer: labelled, closes on Escape or a click outside, and gives focus back to the button that opened it. */
export function Popover({ id, label, onClose, children, returnTo }: { id: string; label: string; onClose: () => void; children: ReactNode; returnTo: React.RefObject<HTMLButtonElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();   // once, on open
    const out = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !returnTo.current?.contains(e.target as Node)) closeRef.current(); };
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, [returnTo]);
  const close = () => { onClose(); returnTo.current?.focus(); };
  return (
    <div ref={ref} id={id} className="picker" role="dialog" aria-label={label}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      {children}
    </div>
  );
}

/** Arrow keys move between the buttons of a grid (one tab stop for the whole grid); the direction follows the page (RTL). */
function gridKeys(e: KeyboardEvent<HTMLElement>, cols: number) {
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-cell]')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
  const step: Record<string, number> = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: cols, ArrowUp: -cols, Home: -i, End: items.length - 1 - i };
  const d = step[e.key];
  if (d === undefined) return;
  e.preventDefault();
  const next = items[Math.max(0, Math.min(items.length - 1, i + d))];
  items.forEach((b) => (b.tabIndex = b === next ? 0 : -1));
  next?.focus();
}

function loadRecent(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, COLS * 2) : []; } catch { return []; }
}

export function EmojiPicker({ onPick, onClose, returnTo }: { onPick: (emoji: string) => void; onClose: () => void; returnTo: React.RefObject<HTMLButtonElement | null> }) {
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<string>(() => (loadRecent().length ? 'recent' : EMOJI_GROUPS[0]!.id));
  const recent = useMemo(loadRecent, []);
  const byChar = useMemo(() => new Map(ALL_EMOJI.map((x) => [x.e, x])), []);
  const shown: Emoji[] = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t) {
      const seen = new Set<string>();
      return ALL_EMOJI.filter((x) => `${x.n} ${x.k ?? ''}`.toLowerCase().includes(t) && !seen.has(x.e) && seen.add(x.e));
    }
    if (group === 'recent') return recent.map((e) => byChar.get(e) ?? { e, n: e });
    return EMOJI_GROUPS.find((g) => g.id === group)?.items ?? [];
  }, [q, group, recent, byChar]);

  const pick = (x: Emoji) => {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([x.e, ...loadRecent().filter((e) => e !== x.e)].slice(0, COLS * 2))); } catch { /* storage unavailable */ }
    onPick(x.e);
  };
  const groupLabel = q.trim() ? 'תוצאות חיפוש' : group === 'recent' ? 'אחרונים' : EMOJI_GROUPS.find((g) => g.id === group)?.label;

  return (
    <Popover id="emoji-picker" label="בחירת אימוג׳י" onClose={onClose} returnTo={returnTo}>
      <label htmlFor="emoji-q" className="sr-only">חיפוש אימוג׳י</label>
      <input id="emoji-q" type="search" placeholder="חיפוש: תודה, בטיחות, לב…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {!q.trim() && (
        <div className="picker-tabs" role="group" aria-label="קטגוריות">
          {recent.length > 0 && <button type="button" aria-pressed={group === 'recent'} onClick={() => setGroup('recent')} title="אחרונים"><span aria-hidden="true">🕘</span><span className="sr-only">אחרונים</span></button>}
          {EMOJI_GROUPS.map((g) => (
            <button type="button" key={g.id} aria-pressed={group === g.id} onClick={() => setGroup(g.id)} title={g.label}><span aria-hidden="true">{g.icon}</span><span className="sr-only">{g.label}</span></button>
          ))}
        </div>
      )}
      <p className="picker-h" id="emoji-grid-h">{groupLabel}</p>
      {shown.length === 0 ? <p className="hint" role="status">לא נמצא אימוג׳י מתאים.</p> : (
        <div className="emoji-grid" role="group" aria-labelledby="emoji-grid-h" onKeyDown={(e) => gridKeys(e, COLS)}>
          {shown.map((x, i) => (
            <button type="button" key={x.e} data-cell tabIndex={i === 0 ? 0 : -1} aria-label={x.n} title={x.n} onClick={() => pick(x)}><span aria-hidden="true">{x.e}</span></button>
          ))}
        </div>
      )}
      <p className="hint picker-foot">חצים למעבר, Enter להוספה, Esc לסגירה.</p>
    </Popover>
  );
}

export interface GifItem { id: string; title: string; keywords: string; width: number; height: number; hasVideo: boolean }

/**
 * A GIF preview that stands still: the first frame drawn on a canvas (works in every browser, no video codec needed).
 * With `moving` (hover or focus, never with reduced motion) the animated GIF itself is shown.
 */
export function GifThumb({ id, moving }: { id: string; moving: boolean }) {
  const c = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const el = c.current;
      if (!el) return;
      el.width = img.naturalWidth; el.height = img.naturalHeight;
      el.getContext('2d')?.drawImage(img, 0, 0);
    };
    img.src = `/gifs/${id}/file`;
  }, [id]);
  return (
    <span className="gif-thumb" aria-hidden="true">
      <canvas ref={c} />
      {moving && <img src={`/gifs/${id}/file`} alt="" />}
    </span>
  );
}

/** One tile: moves only while hovered or focused (and never with reduced motion), so the panel is not a wall of moving pictures. */
function GifTile({ g, onPick, first }: { g: GifItem; onPick: (g: GifItem) => void; first: boolean }) {
  const [on, setOn] = useState(false);
  const moving = on && !motionOff();
  return (
    <button type="button" data-cell className="gif-tile" tabIndex={first ? 0 : -1} aria-label={`שליחת GIF: ${g.title}`}
      onMouseEnter={() => setOn(true)} onMouseLeave={() => setOn(false)} onFocus={() => setOn(true)} onBlur={() => setOn(false)} onClick={() => onPick(g)}>
      <GifThumb id={g.id} moving={moving} />
      <span className="gif-title">{g.title}</span>
    </button>
  );
}

export function GifPicker({ onPick, onClose, returnTo, busy }: { onPick: (g: GifItem) => void; onClose: () => void; returnTo: React.RefObject<HTMLButtonElement | null>; busy: boolean }) {
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ gifs: GifItem[]; enabled: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      void api<{ gifs: GifItem[]; enabled: boolean }>('GET', `/gifs?q=${encodeURIComponent(q.trim())}`).then((d) => { setData(d); setFailed(false); }).catch(() => setFailed(true));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Popover id="gif-picker" label="שליחת GIF מהספרייה" onClose={onClose} returnTo={returnTo}>
      <label htmlFor="gif-q" className="sr-only">חיפוש GIF</label>
      <input id="gif-q" type="search" placeholder="חיפוש בספריית ה-GIF…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {failed ? <p className="error" role="alert">לא ניתן לטעון את ספריית ה-GIF.</p>
        : !data ? <p className="hint" role="status">טוען…</p>
        : !data.enabled ? <p className="hint" role="status">שליחת קבצים כבויה בשרת (אין סורק אנטי-וירוס), ולכן אי אפשר לשלוח GIF.</p>
        : data.gifs.length === 0 ? <p className="hint" role="status">{q.trim() ? 'לא נמצא GIF מתאים.' : 'הספרייה ריקה. מנהלים מוסיפים GIF במסך "תשובות ותגיות".'}</p>
        : (
          <div className="gif-grid" role="group" aria-label={`${data.gifs.length} GIF בספרייה`} aria-busy={busy} onKeyDown={(e) => gridKeys(e, 3)}>
            {data.gifs.map((g, i) => <GifTile key={g.id} g={g} first={i === 0} onPick={(x) => { if (!busy) onPick(x); }} />)}
          </div>
        )}
      <p className="hint picker-foot">בחירה שולחת את ה-GIF מיד ללקוח. הטקסט שבתיבה נשאר בה.</p>
    </Popover>
  );
}
