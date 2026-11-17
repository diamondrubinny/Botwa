import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { errText } from '../strings';

interface Policy { key: string; label: string; days: number }
interface Run { ranAt: string; manual: boolean; counts: Record<string, number>; error: string | null }

/** Settings > retention policy: the rules in force and what each daily run deleted (counts only). Admins may run it now. */
export function RetentionCard({ canEdit }: { canEdit: boolean }) {
  const [d, setD] = useState<{ policy: Policy[]; runs: Run[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = async () => setD(await api<{ policy: Policy[]; runs: Run[] }>('GET', '/privacy/retention').catch(() => null));
  useEffect(() => { void load(); }, []);
  if (!d) return null;
  const label = (k: string) => d.policy.find((p) => p.key === k)?.label ?? k;
  const total = (r: Run) => Object.values(r.counts).reduce((a, b) => a + b, 0);
  return (
    <section className="card" aria-labelledby="ret-h">
      <h2 id="ret-h">מדיניות שמירה ומחיקה</h2>
      <p className="hint">המערכת מוחקת מידע ישן פעם ביום לפי הכללים האלה, ורושמת כמה נמחק מכל סוג (מספרים בלבד, בלי תוכן). את מספר הימים קובעים בקובץ ההגדרות של השרת (.env). "נשמר" = לא נמחק אוטומטית. טפסים חתומים עשויים להידרש לפי דין: דורש בדיקה משפטית לפני הגדרת מחיקה.</p>
      <table>
        <caption className="sr-only">כללי השמירה</caption>
        <thead><tr><th scope="col">סוג מידע</th><th scope="col">נמחק אחרי</th></tr></thead>
        <tbody>{d.policy.map((p) => <tr key={p.key}><th scope="row">{p.label}</th><td>{p.days > 0 ? `${p.days} ימים` : 'נשמר'}</td></tr>)}</tbody>
      </table>
      {canEdit && (
        <div className="row" style={{ marginTop: '.6rem' }}>
          <button type="button" disabled={busy} onClick={async () => {
            setBusy(true); setMsg(null);
            try { const r = await api<{ counts: Record<string, number>; error?: string }>('POST', '/privacy/retention/run'); setMsg(r.error ? { ok: false, text: `הניקוי הסתיים עם שגיאות: ${r.error}` } : { ok: true, text: `הניקוי הסתיים. נמחקו ${Object.values(r.counts).reduce((a, b) => a + b, 0)} רשומות.` }); await load(); }
            catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
            finally { setBusy(false); }
          }}>{busy ? 'מנקה…' : 'הרצת ניקוי עכשיו'}</button>
        </div>
      )}
      <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>
      <h3>מה נמחק (30 ההרצות האחרונות)</h3>
      {d.runs.length === 0 ? <p className="hint">עוד לא היו הרצות.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <caption className="sr-only">היסטוריית הניקוי</caption>
            <thead><tr><th scope="col">מתי</th><th scope="col">סה״כ</th><th scope="col">פירוט</th></tr></thead>
            <tbody>{d.runs.map((r) => (
              <tr key={r.ranAt}>
                <th scope="row">{new Date(r.ranAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}{r.manual ? ' (ידני)' : ''}</th>
                <td>{total(r)}</td>
                <td>{Object.entries(r.counts).filter(([, v]) => v > 0).map(([k, v]) => `${label(k)}: ${v}`).join(' · ') || 'לא נמחק דבר'}{r.error ? <><br /><span className="error">שגיאה: {r.error}</span></> : null}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
