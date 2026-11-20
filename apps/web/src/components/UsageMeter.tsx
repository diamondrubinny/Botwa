import { useState } from 'react';
import { api, ApiError } from '../api';
import { usePoll } from '../hooks';
import { errText } from '../strings';

type Kind = 'text' | 'media' | 'template' | 'interactive' | 'reaction';
interface Limit { limit: number; action: 'warn' | 'block_auto' | 'block_all'; warnAt: number }
interface Usage { month: string; resetsAt: string; total: number; byKind: Record<Kind, number>; seeded: number; blocked: number; limit: Limit; percent: number | null; numberKnown?: boolean }

const KIND: Record<Kind, string> = { text: 'טקסט', media: 'קבצים ותמונות', template: 'תבניות', interactive: 'תפריטים וכפתורים', reaction: 'רגשונים' };
const ACTION: Record<Limit['action'], string> = {
  warn: 'התראה בלבד: להמשיך לשלוח',
  block_auto: 'לעצור הודעות אוטומטיות (בוט, מענה מחוץ לשעות, אוטומציות); נציגים ממשיכים לענות',
  block_all: 'לעצור את כל השליחה עד תחילת החודש הבא',
};
const dateHe = (iso: string) => new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });

/** Official WhatsApp: outgoing messages this month for the business number, against the limit set for it (admins change it). */
export function UsageMeter({ channelId, canEdit }: { channelId: string; canEdit: boolean }) {
  const [u, setU] = useState<Usage | null>(null);
  const [form, setForm] = useState<Limit | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  usePoll(async () => { const r = await api<Usage>('GET', `/channels/${channelId}/usage`).catch(() => null); setU(r); }, 30000, [channelId]);
  if (!u) return null;

  const lim = u.limit.limit;
  const pct = u.percent ?? 0;
  const level = lim === 0 ? 'none' : pct >= 100 ? 'full' : pct >= u.limit.warnAt ? 'warn' : 'ok';
  const save = async () => {
    if (!form) return;
    setBusy(true); setMsg('');
    try { setU(await api<Usage>('PUT', `/channels/${channelId}/usage-limit`, form)); setForm(null); setMsg('נשמר.'); }
    catch (e) { setMsg(errText(e instanceof ApiError ? e.code : 'generic')); }
    finally { setBusy(false); }
  };

  return (
    <section className={`usage usage-${level}`} aria-labelledby={`us-h-${channelId}`}>
      <h3 id={`us-h-${channelId}`} className="usage-h">הודעות יוצאות החודש</h3>
      {lim > 0 ? (
        <>
          <meter id={`us-m-${channelId}`} min={0} max={lim} low={Math.ceil((lim * u.limit.warnAt) / 100)} high={lim} optimum={0} value={Math.min(u.total, lim)} aria-describedby={`us-t-${channelId}`} />
          <p id={`us-t-${channelId}`} className="usage-num">
            <strong>{u.total.toLocaleString('he-IL')}</strong> מתוך {lim.toLocaleString('he-IL')} ({pct}%)
            {level === 'full' && <span className="mchip warn">הגיע למגבלה</span>}
            {level === 'warn' && <span className="mchip warn">מתקרב למגבלה</span>}
          </p>
        </>
      ) : (
        <p className="usage-num"><strong>{u.total.toLocaleString('he-IL')}</strong> הודעות (ספירה בלבד, בלי מגבלה)</p>
      )}
      <p className="hint">
        הספירה מתאפסת ב-{dateHe(u.resetsAt)} (תחילת חודש לפי UTC). {lim > 0 && <>במגבלה: {ACTION[u.limit.action]}.</>}
        {u.blocked > 0 && <> החודש נעצרו {u.blocked} הודעות בגלל המגבלה.</>}
      </p>
      <details>
        <summary>פירוט</summary>
        <ul className="usage-kinds">
          {(Object.keys(KIND) as Kind[]).map((k) => <li key={k}>{KIND[k]}: {u.byKind[k].toLocaleString('he-IL')}</li>)}
          {u.seeded > 0 && <li>נשלחו החודש לפני שהספירה התחילה: {u.seeded.toLocaleString('he-IL')}</li>}
        </ul>
        {u.numberKnown === false && <p className="hint">מזהה המספר עוד לא נטען (הערוץ לא פעיל), ולכן הספירה נשמרת לפי הערוץ.</p>}
      </details>
      {canEdit && !form && <button type="button" onClick={() => { setForm({ ...u.limit }); setMsg(''); }}>שינוי המגבלה</button>}
      {canEdit && form && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="field">
            <label htmlFor={`us-l-${channelId}`}>מגבלת הודעות יוצאות בחודש למספר הזה (0 = ספירה בלי מגבלה)</label>
            <input id={`us-l-${channelId}`} type="number" min={0} max={10000000} inputMode="numeric" style={{ maxWidth: 160 }} value={form.limit}
              onChange={(e) => setForm({ ...form, limit: Math.max(0, Math.min(10_000_000, Math.round(Number(e.target.value) || 0))) })} />
          </div>
          <div className="field">
            <label htmlFor={`us-w-${channelId}`}>התראה מוקדמת באחוז</label>
            <input id={`us-w-${channelId}`} type="number" min={50} max={99} style={{ maxWidth: 100 }} value={form.warnAt}
              onChange={(e) => setForm({ ...form, warnAt: Math.max(50, Math.min(99, Math.round(Number(e.target.value) || 80))) })} />
          </div>
          <fieldset>
            <legend>מה קורה כשמגיעים למגבלה</legend>
            {(Object.keys(ACTION) as Limit['action'][]).map((a) => (
              <label key={a} className="row" style={{ fontWeight: 400 }}>
                <input type="radio" name={`us-a-${channelId}`} style={{ width: 'auto', minHeight: 'auto' }} checked={form.action === a} onChange={() => setForm({ ...form, action: a })} /> {ACTION[a]}
              </label>
            ))}
          </fieldset>
          <p className="hint">הנתונים של Meta על הודעות חינם ומחירים משתנים מעת לעת. בדקו את המספר הנכון לחשבון שלכם בדף התמחור הרשמי של Meta.</p>
          <div className="row">
            <button className="primary" type="submit" disabled={busy}>שמירה</button>
            <button type="button" className="secondary" onClick={() => setForm(null)}>ביטול</button>
          </div>
        </form>
      )}
      {msg && <p role="status">{msg}</p>}
    </section>
  );
}
