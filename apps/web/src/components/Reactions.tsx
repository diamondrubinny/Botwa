import { useRef, useState } from 'react';
import { EmojiPicker, Popover } from './Pickers';

/** The reactions people use most in customer service; any other emoji is one click away ("עוד…"). */
export const QUICK_REACTIONS = ['❤️', '👍', '🙏', '😊', '👏', '🎉', '✅', '😂'];

/**
 * Our emoji on one customer message: a badge when there is one, and a small button that opens a short list to choose from
 * (the full emoji picker behind "עוד…"), or to remove it. The platform shows it to the customer where it supports reactions.
 */
export function ReactionControl({ msgId, current, by, onSet }: { msgId: string; current: string | null | undefined; by: string | null | undefined; onSet: (emoji: string) => Promise<void> }) {
  const [open, setOpen] = useState<'quick' | 'all' | null>(null);
  const [busy, setBusy] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const choose = async (e: string) => {
    setOpen(null); setBusy(true);
    try { await onSet(e); } finally { setBusy(false); btn.current?.focus(); }
  };
  const label = current ? `התגובה שלנו להודעה: ${current}${by ? ` (${by})` : ''}. לשינוי או הסרה` : 'תגובה ברגשון להודעה';
  return (
    <span className="msg-react">
      <button type="button" ref={btn} className={current ? 'rx-badge' : 'rx-add'} aria-label={label} title={label} disabled={busy}
        aria-expanded={!!open} aria-controls={open ? `rx-${msgId}` : undefined} onClick={() => setOpen(open ? null : 'quick')}>
        {current ? <span aria-hidden="true">{current}</span> : <span aria-hidden="true">☺︎+</span>}
      </button>
      {open === 'quick' && (
        <Popover id={`rx-${msgId}`} label="בחירת רגשון לתגובה" onClose={() => setOpen(null)} returnTo={btn}>
          <div className="rx-quick" role="group" aria-label="רגשונים נפוצים">
            {QUICK_REACTIONS.map((e) => (
              <button type="button" key={e} aria-pressed={current === e} aria-label={e} onClick={() => void choose(e)}><span aria-hidden="true">{e}</span></button>
            ))}
            <button type="button" className="rx-more" onClick={() => setOpen('all')}>עוד…</button>
          </div>
          {current && <button type="button" className="secondary rx-remove" onClick={() => void choose('')}>הסרת התגובה</button>}
        </Popover>
      )}
      {open === 'all' && <EmojiPicker returnTo={btn} onClose={() => setOpen(null)} onPick={(e) => void choose(e)} />}
    </span>
  );
}
