import { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { usePoll } from '../hooks';
import { errText } from '../strings';

type Audience = 'bot' | 'staff' | 'both';
interface Report { at: string; trigger: 'manual' | 'schedule'; checked: number; created: number; updated: number; unchanged: number; removed: number; detached: number; failed: { title: string; error: string }[]; missing: string[]; durationMs: number }
interface Imported { id: string; title: string; pageTitle: string; url: string; enabled: boolean; status: 'pending' | 'ready' | 'error'; error: string | null; detached: boolean; audience: Audience; fetchedAt: string | null; revid: number | null; sections: number | null; chunks: number }
interface State {
  settings: { enabled: boolean; audience: Audience; refreshDays: number; selection: string[]; catalog: string[] | null; catalogAt: string | null; lastRunAt: string | null; lastReport: Report | null };
  defaults: string[]; attribution: string; running: boolean; imported: Imported[];
}

const AUD: Record<Audience, string> = { staff: 'נציגים בלבד', both: 'בוט ונציגים', bot: 'בוט בלבד' };
const ERR: Record<string, string> = {
  gone: 'הדף הוסר מהמקור (הושבת)', unrecognized_format: 'מבנה הדף לא זוהה', rate_limited: 'המקור ביקש להאט; ינוסה שוב בפעם הבאה', timeout: 'המקור לא ענה בזמן',
  dns_failed: 'אין גישה לכתובת המקור מהשרת', fetch_failed: 'אין חיבור למקור', kb_full: 'המאגר מלא',
};
const date = (s: string | null) => (s ? new Date(s).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Laws and regulations on safety at work, imported from the Open Law Book and kept up to date automatically. */
export function GovSources() {
  const [st, setSt] = useState<State | null>(null);
  const [form, setForm] = useState<{ enabled: boolean; audience: Audience; refreshDays: number; picked: Set<string> } | null>(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const s = await api<State>('GET', '/kb/gov').catch(() => null);
    if (!s) return;
    setSt(s);
    setForm((f) => f ?? { enabled: s.settings.enabled, audience: s.settings.audience, refreshDays: s.settings.refreshDays, picked: new Set(s.settings.selection.length ? s.settings.selection : s.defaults) });
  };
  usePoll(load, st?.running ? 3000 : 15000, [st?.running]);

  const titles = useMemo(() => {
    if (!st || !form) return [];
    const all = new Set([...(st.settings.catalog ?? []), ...st.defaults, ...form.picked]);
    return [...all].sort((a, b) => a.localeCompare(b, 'he')).filter((t) => !q || t.includes(q.trim()));
  }, [st, form, q]);

  if (!st || !form) return <p role="status">טוען…</p>;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null); setBusy(true);
    try { await fn(); setMsg({ ok: true, text: ok }); await load(); } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); } finally { setBusy(false); }
  };
  const save = () => act(() => api('PUT', '/kb/gov', { enabled: form.enabled, audience: form.audience, refreshDays: form.refreshDays, selection: [...form.picked] }), 'ההגדרות נשמרו.');
  const toggle = (t: string) => setForm({ ...form, picked: new Set(form.picked.has(t) ? [...form.picked].filter((x) => x !== t) : [...form.picked, t]) });
  const r = st.settings.lastReport;

  return (
    <>
      <section className="card" aria-labelledby="gov-h">
        <h2 id="gov-h">חקיקה ותקינה בבטיחות</h2>
        <p className="hint">
          הנוסח המלא של חוקים ותקנות הבטיחות בעבודה נמשך מ"ספר החוקים הפתוח" ונשמר במאגר, מחולק לפי תקנות וסעיפים. העדכון אוטומטי: נמשך מחדש רק מה שהשתנה במקור.
          המקור: {st.attribution}
        </p>
        <p className="hint"><strong>חשוב:</strong> זה מידע כללי ולא ייעוץ משפטי. כשהבוט עונה מתוך החקיקה הוא מציין את שם התקנה והסעיף ומוסיף הסתייגות. מומלץ להשאיר "נציגים בלבד" עד שהממונה על הבטיחות או היועץ המשפטי מאשרים.</p>

        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label className="gov-check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> עדכון אוטומטי</label>
          <div className="field">
            <label htmlFor="gov-aud">מי משתמש בתוכן</label>
            <select id="gov-aud" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as Audience })} aria-describedby={form.audience !== 'staff' ? 'gov-aud-w' : undefined}>
              {(['staff', 'both', 'bot'] as const).map((a) => <option key={a} value={a}>{AUD[a]}</option>)}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label htmlFor="gov-days">עדכון כל (ימים)</label>
            <input id="gov-days" type="number" min={1} max={90} value={form.refreshDays} onChange={(e) => setForm({ ...form, refreshDays: Math.max(1, Math.min(90, Number(e.target.value) || 7)) })} />
          </div>
        </div>
        {form.audience !== 'staff' && <p id="gov-aud-w" className="error">הבוט יצטט חקיקה ללקוחות. ודאו שזה מאושר אצלכם.</p>}

        <fieldset>
          <legend>חוקים ותקנות לייבוא ({form.picked.size} נבחרו)</legend>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="field" style={{ maxWidth: 320 }}>
              <label htmlFor="gov-q">סינון</label>
              <input id="gov-q" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button type="button" disabled={busy} onClick={() => act(() => api('POST', '/kb/gov/catalog'), 'הרשימה המלאה נטענה מהמקור.')}>טעינת כל התקנות מהמקור</button>
            <button type="button" onClick={() => setForm({ ...form, picked: new Set(st.defaults) })}>בחירת הרשימה המומלצת</button>
            <button type="button" onClick={() => setForm({ ...form, picked: new Set() })}>ניקוי הבחירה</button>
          </div>
          {st.settings.catalogAt && <p className="hint">הרשימה נטענה מהמקור ב־{date(st.settings.catalogAt)} ({st.settings.catalog?.length ?? 0} חוקים ותקנות).</p>}
          {form.picked.size === 0 && <p className="hint">בלי בחירה ייובאו {st.defaults.length} התקנות שברשימה המומלצת.</p>}
          <ul className="gov-list">
            {titles.map((t) => (
              <li key={t}><label><input type="checkbox" checked={form.picked.has(t)} onChange={() => toggle(t)} /> {t}</label></li>
            ))}
            {titles.length === 0 && <li className="hint">אין תוצאות לסינון.</li>}
          </ul>
        </fieldset>

        <div className="row">
          <button className="primary" disabled={busy} onClick={save}>שמירה</button>
          <button disabled={busy || st.running} onClick={() => act(async () => { await api('PUT', '/kb/gov', { enabled: form.enabled, audience: form.audience, refreshDays: form.refreshDays, selection: [...form.picked] }); await api('POST', '/kb/gov/sync'); }, 'הייבוא התחיל. הוא נמשך כמה דקות כי המקור מתיר קצב איטי.')}>
            {st.running ? 'מייבא…' : 'שמירה וייבוא עכשיו'}
          </button>
        </div>
        <p role="status" aria-live="polite" className={msg?.ok ? 'ok' : 'error'}>{st.running ? 'הייבוא רץ ברקע…' : msg?.text}</p>

        {r && (
          <div>
            <h3>ייבוא אחרון</h3>
            <p>
              {date(r.at)} ({r.trigger === 'manual' ? 'ידני' : 'אוטומטי'}, {Math.round(r.durationMs / 1000)} שניות): נבדקו {r.checked}, נוספו {r.created}, עודכנו {r.updated}, ללא שינוי {r.unchanged}
              {r.removed ? `, הוסרו ${r.removed}` : ''}{r.detached ? `, ${r.detached} נערכו אצלכם ולא עודכנו` : ''}.
            </p>
            {r.missing.length > 0 && <p className="error">לא נמצאו במקור: {r.missing.join(', ')}</p>}
            {r.failed.length > 0 && <ul className="error">{r.failed.map((f) => <li key={f.title}>{f.title === '*' ? 'המקור' : f.title}: {ERR[f.error] ?? f.error}</li>)}</ul>}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="gov-imp-h" style={{ overflowX: 'auto' }}>
        <h2 id="gov-imp-h">מה יובא ({st.imported.length})</h2>
        <table>
          <caption className="sr-only">חוקים ותקנות שיובאו למאגר</caption>
          <thead><tr><th scope="col">שם</th><th scope="col">מצב</th><th scope="col">סעיפים</th><th scope="col">עודכן</th><th scope="col">קהל</th></tr></thead>
          <tbody>
            {st.imported.length === 0 && <tr><td colSpan={5}>עדיין לא יובא דבר. בחרו תקנות ולחצו "שמירה וייבוא עכשיו".</td></tr>}
            {st.imported.map((x) => (
              <tr key={x.id}>
                <th scope="row">
                  {x.title}
                  <div><a href={x.url} target="_blank" rel="noopener noreferrer">הנוסח במקור<span className="sr-only"> של {x.pageTitle} (נפתח בחלון חדש)</span></a></div>
                  {x.detached && <span className="badge connecting">נערך אצלכם, לא מתעדכן</span>}
                  {!x.enabled && <span className="badge stopped">מושבת</span>}
                </th>
                <td>
                  <span className={`badge ${x.status === 'ready' ? 'connected' : x.status === 'error' ? 'error' : 'connecting'}`}>{x.status === 'ready' ? 'מוכן' : x.status === 'error' ? 'שגיאה' : 'בעיבוד…'}</span>
                  {x.error && <div className="error"><small>{ERR[x.error] ?? x.error}</small></div>}
                </td>
                <td>{x.sections ?? '—'} <span className="hint">({x.chunks} קטעים)</span></td>
                <td>{date(x.fetchedAt)}</td>
                <td>{AUD[x.audience]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
