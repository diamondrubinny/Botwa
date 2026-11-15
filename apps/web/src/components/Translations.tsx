import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { errText } from '../strings';

/**
 * Bot > English translation: Betty answers customers who write in English in English. Every Hebrew text she may send is listed
 * with its English wording (built in, the unit's own, or none yet: those are sent in Hebrew). "{*}" stands for a part that
 * changes (a name, a number); variables like {שם} stay as they are.
 */
interface Item { he: string; en: string; builtIn: string | null; custom: boolean; where: string; used: boolean; suggest?: string | null }

export function Translations({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'missing' | 'used' | 'all'>('missing');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(40);

  const load = async () => { const r = await api<{ items: Item[]; missing: number }>('GET', '/settings/translations').catch(() => null); if (r) { setItems(r.items); setEdits({}); } };
  useEffect(() => { void load(); }, []);

  const value = (i: Item) => (Object.hasOwn(edits, i.he) ? edits[i.he]! : i.en);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (items ?? []).filter((i) => (show === 'all' || (show === 'used' ? i.used : i.used && !value(i).trim())) && (!t || i.he.toLowerCase().includes(t) || value(i).toLowerCase().includes(t) || i.where.includes(t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, edits, q, show]);
  const missing = (items ?? []).filter((i) => i.used && !value(i).trim()).length;
  const dirty = Object.keys(edits).length;

  const save = async () => {
    if (!items || busy) return;
    setBusy(true); setMsg(null);
    try {
      const entries: Record<string, string> = {};
      for (const i of items) { const v = value(i).trim(); if (v || i.builtIn) entries[i.he] = v; }
      await api('PUT', '/settings/translations', { entries });
      setMsg({ ok: true, text: 'התרגומים נשמרו. הם חלים מהשיחה הבאה באנגלית.' });
      await load();
    } catch (err) { setMsg({ ok: false, text: errText(err instanceof ApiError ? err.code : 'generic') }); } finally { setBusy(false); }
  };

  return (
    <section className="card" aria-labelledby="tr-h">
      <h2 id="tr-h">תרגום לאנגלית</h2>
      <p className="hint">
        לקוח שכותב באנגלית מקבל מבטי תשובות באנגלית, ובשיחה שלו בפאנל מופיעה תגית "English". אם הלקוח עובר לכתוב בעברית, בטי עוברת איתו לעברית.
        לכל ההודעות הקבועות של בטי ושל תבנית הבטיחות כבר יש תרגום, ואפשר לשנות כל אחד מהם.
        טקסט שאין לו תרגום יישלח בעברית, וכאן אפשר להשלים לו תרגום.
        <code dir="ltr">{'{*}'}</code> מסמן חלק שמשתנה, כמו שם או מספר. משתנים כמו <code>{'{שם}'}</code> נשארים כמו שהם.
      </p>
      {!items ? <p className="hint">טוען…</p> : (
        <>
          <p role="status" className={missing ? 'hint' : 'ok'}>{missing ? `${missing} טקסטים שבשימוש עדיין בלי תרגום.` : 'לכל הטקסטים שבשימוש יש תרגום.'}</p>
          <div className="toolbar" style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'end' }}>
            <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="tr-q">חיפוש</label><input id="tr-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="field"><label htmlFor="tr-show">להציג</label>
              <select id="tr-show" value={show} onChange={(e) => { setShow(e.target.value as typeof show); setLimit(40); }}>
                <option value="missing">חסר תרגום</option><option value="used">בשימוש</option><option value="all">הכול (כולל הודעות מובנות)</option>
              </select>
            </div>
          </div>
          {list.length === 0 ? <p className="hint">{show === 'missing' ? 'אין טקסטים שחסר להם תרגום 🎉' : 'לא נמצאו טקסטים.'}</p> : (
            <ul className="tr-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {list.slice(0, limit).map((i, n) => (
                <li key={i.he} className="tr-item" style={{ borderTop: '1px solid var(--border)', padding: '.6rem 0' }}>
                  <small className="hint">{i.where}{i.custom ? ' · תרגום שלכם' : i.builtIn ? ' · תרגום מובנה' : ''}</small>
                  <p id={`tr-he-${n}`} dir="rtl" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '.2rem 0' }}>{i.he}</p>
                  <label className="sr-only" htmlFor={`tr-en-${n}`}>התרגום לאנגלית של: {i.he.slice(0, 60)}</label>
                  <textarea id={`tr-en-${n}`} dir="ltr" lang="en" style={{ overflowWrap: "anywhere" }} rows={Math.min(6, Math.max(1, Math.ceil(i.he.length / 70)))} maxLength={2000} disabled={!canEdit}
                    value={value(i)} placeholder="English…" aria-describedby={`tr-he-${n}`}
                    onChange={(e) => setEdits((x) => ({ ...x, [i.he]: e.target.value }))} />
                  {canEdit && i.suggest && !value(i).trim() && <button type="button" className="ghost sm" onClick={() => setEdits((x) => ({ ...x, [i.he]: i.suggest! }))}>הצעת תרגום חלקית (להשלמה)<span className="sr-only"> – {i.he.slice(0, 40)}</span></button>}
                  {canEdit && i.builtIn && value(i) !== i.builtIn && <button type="button" className="ghost sm" onClick={() => setEdits((x) => ({ ...x, [i.he]: i.builtIn! }))}>חזרה לתרגום המובנה</button>}
                </li>
              ))}
            </ul>
          )}
          {list.length > limit && <button type="button" onClick={() => setLimit((l) => l + 40)}>להציג עוד ({list.length - limit})</button>}
          {canEdit && <p><button type="button" className="primary" onClick={() => void save()} disabled={busy || !dirty}>{busy ? 'שומר…' : `שמירת התרגומים${dirty ? ` (${dirty})` : ''}`}</button></p>}
          <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
        </>
      )}
    </section>
  );
}
