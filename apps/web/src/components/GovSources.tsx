import { useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { usePoll } from '../hooks';
import { errText } from '../strings';

type Audience = 'bot' | 'staff' | 'both';
interface Report { at: string; trigger: 'manual' | 'schedule'; checked: number; created: number; updated: number; unchanged: number; removed: number; detached: number; failed: { title: string; error: string }[]; missing: string[]; durationMs: number;
  knesset?: { checked: number; repealed: string[]; reinstated: string[]; outdated: { title: string; latest: string }[]; notFound: string[]; error: string | null } }
interface Knesset { id: number; name: string; validity: string; repealed: boolean; latestPublication: string | null; finished: string | null; checkedAt: string; newerThanText: boolean }
interface Imported { id: string; title: string; pageTitle: string; url: string; enabled: boolean; status: 'pending' | 'ready' | 'error'; error: string | null; detached: boolean; audience: Audience; fetchedAt: string | null; revid: number | null; sections: number | null; chunks: number; knesset: Knesset | null }
interface State {
  settings: { enabled: boolean; audience: Audience; refreshDays: number; selection: string[]; catalog: string[] | null; catalogAt: string | null; lastRunAt: string | null; lastReport: Report | null };
  defaults: string[]; attribution: string; running: boolean; imported: Imported[];
}

const AUD: Record<Audience, string> = { staff: 'נציגים בלבד', both: 'בוט ונציגים', bot: 'בוט בלבד' };
const ERR: Record<string, string> = {
  repealed: 'בוטל לפי מאגר החקיקה של הכנסת (הושבת)',
  bad_response: 'תשובה לא תקינה מהמקור', unrecognized_format: 'מבנה הנתונים במקור השתנה; הרשימה הקיימת נשמרה',
  gone: 'הדף הוסר מהמקור (הושבת)', rate_limited: 'המקור ביקש להאט; ינוסה שוב בפעם הבאה', timeout: 'המקור לא ענה בזמן',
  dns_failed: 'אין גישה לכתובת המקור מהשרת', fetch_failed: 'אין חיבור למקור', kb_full: 'המאגר מלא',
};
const date = (s: string | null) => (s ? new Date(s).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const dayOf = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString('he-IL');

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
          {' '}חוקים ופקודות נבדקים גם מול מאגר החקיקה של הכנסת: חוק שבוטל מושבת אוטומטית, ונוסח ישן מתיקון אחרון מסומן לבדיקה.
        </p>
        <p className="hint"><strong>חשוב:</strong> זה מידע כללי ולא ייעוץ משפטי. כשהבוט עונה מתוך החקיקה הוא מציין את שם התקנה והסעיף ומוסיף הסתייגות. מומלץ להשאיר "נציגים בלבד" עד שהממונה על הבטיחות או היועץ המשפטי מאשרים.</p>

        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label className="gov-check"><input type="checkbox" role="switch" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> עדכון אוטומטי</label>
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
            {r.knesset && (
              <p>
                מאגר החקיקה של הכנסת: נבדקו {r.knesset.checked} חוקים ופקודות
                {r.knesset.error ? <span className="error"> (המאגר לא היה זמין; נשמר המצב הקודם)</span> : '.'}
                {r.knesset.repealed.length > 0 && <strong className="error"> בוטלו והושבתו: {r.knesset.repealed.join(', ')}.</strong>}
                {r.knesset.reinstated.length > 0 && <> חזרו לתוקף: {r.knesset.reinstated.join(', ')}.</>}
                {r.knesset.notFound.length > 0 && <> לא נמצאו במאגר: {r.knesset.notFound.join(', ')}.</>}
              </p>
            )}
            {r.knesset && r.knesset.outdated.length > 0 && (
              <p className="error">ייתכן שהנוסח אינו כולל תיקון אחרון: {r.knesset.outdated.map((o) => `${o.title} (פורסם ${dayOf(o.latest)})`).join(', ')}. מומלץ לבדוק מול הנוסח ברשומות.</p>
            )}
            {r.missing.length > 0 && <p className="error">לא נמצאו במקור: {r.missing.join(', ')}</p>}
            {r.failed.length > 0 && <ul className="error">{r.failed.map((f) => <li key={f.title}>{f.title === '*' ? 'המקור' : f.title}: {ERR[f.error] ?? f.error}</li>)}</ul>}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="gov-imp-h" style={{ overflowX: 'auto' }}>
        <h2 id="gov-imp-h">מה יובא ({st.imported.length})</h2>
        <table>
          <caption className="sr-only">חוקים ותקנות שיובאו למאגר</caption>
          <thead><tr><th scope="col">שם</th><th scope="col">מצב</th><th scope="col">בכנסת</th><th scope="col">סעיפים</th><th scope="col">עודכן</th><th scope="col">קהל</th></tr></thead>
          <tbody>
            {st.imported.length === 0 && <tr><td colSpan={6}>עדיין לא יובא דבר. בחרו תקנות ולחצו "שמירה וייבוא עכשיו".</td></tr>}
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
                <td>
                  {x.knesset ? (
                    <>
                      <span className={`badge ${x.knesset.repealed ? 'error' : 'connected'}`}>{x.knesset.validity || '—'}</span>
                      {x.knesset.latestPublication && <div className="hint">פרסום אחרון {dayOf(x.knesset.latestPublication)}</div>}
                      {x.knesset.newerThanText && <div className="error"><small>ייתכן שחסר תיקון בנוסח</small></div>}
                    </>
                  ) : <span className="hint">{/^(חוק|פקודת)\s/.test(x.pageTitle) ? 'טרם נבדק' : 'תקנות: לא במאגר הכנסת'}</span>}
                </td>
                <td>{x.sections ?? '—'} <span className="hint">({x.chunks} קטעים)</span></td>
                <td>{date(x.fetchedAt)}</td>
                <td>{AUD[x.audience]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <Standards />
      <Fire />
    </>
  );
}

interface StdReport { at: string; trigger: 'manual' | 'schedule'; total: number; matched: number; created: number; updated: number; unchanged: number; removed: number; detached: number; skipped: boolean; failed: { title: string; error: string }[]; durationMs: number }
interface StdState {
  settings: { enabled: boolean; audience: Audience; refreshDays: number; keywords: string[]; includeAll: boolean; lastRunAt: string | null; lastReport: StdReport | null };
  defaults: string[]; attribution: string; dataset: string; running: boolean; imported: { id: string; title: string; enabled: boolean; status: string; detached: boolean; audience: Audience }[];
}

/** Stage 2: the official standards list of the Ministry of Economy (data.gov.il). */
function Standards() {
  const [st, setSt] = useState<StdState | null>(null);
  const [form, setForm] = useState<{ enabled: boolean; audience: Audience; refreshDays: number; includeAll: boolean; keywords: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const load = async () => {
    const s = await api<StdState>('GET', '/kb/gov/standards').catch(() => null);
    if (!s) return;
    setSt(s);
    setForm((f) => f ?? { enabled: s.settings.enabled, audience: s.settings.audience, refreshDays: s.settings.refreshDays, includeAll: s.settings.includeAll, keywords: (s.settings.keywords.length ? s.settings.keywords : s.defaults).join('\n') });
  };
  usePoll(load, st?.running ? 3000 : 15000, [st?.running]);
  if (!st || !form) return null;
  const body = () => ({ enabled: form.enabled, audience: form.audience, refreshDays: form.refreshDays, includeAll: form.includeAll, keywords: form.keywords.split('\n').map((k) => k.trim()).filter(Boolean) });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null); setBusy(true);
    try { await fn(); setMsg({ ok: true, text: ok }); await load(); } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); } finally { setBusy(false); }
  };
  const r = st.settings.lastReport;
  const shown = st.imported.filter((x) => !q || x.title.includes(q.trim()));
  return (
    <section className="card" aria-labelledby="std-h">
      <h2 id="std-h">תקנים רשמיים</h2>
      <p className="hint">
        רשימת התקנים הרשמיים בתוקף בישראל, ממאגר המידע הממשלתי (data.gov.il, משרד הכלכלה והתעשייה). לכל תקן נשמרים מספר, שם, מהדורה, תוקף, גיליונות תיקון והסעיפים המחייבים.
        הנוסח המלא של התקנים נמכר על ידי מכון התקנים ואינו זמין ב־API.{' '}
        <a href={st.dataset} target="_blank" rel="noopener noreferrer">המאגר במקור<span className="sr-only"> (נפתח בחלון חדש)</span></a>
      </p>
      <label className="gov-check"><input type="checkbox" role="switch" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> עדכון אוטומטי</label>
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field">
          <label htmlFor="std-aud">מי משתמש בתוכן</label>
          <select id="std-aud" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as Audience })}>
            {(['staff', 'both', 'bot'] as const).map((a) => <option key={a} value={a}>{AUD[a]}</option>)}
          </select>
        </div>
        <div className="field" style={{ maxWidth: 160 }}>
          <label htmlFor="std-days">עדכון כל (ימים)</label>
          <input id="std-days" type="number" min={1} max={90} value={form.refreshDays} onChange={(e) => setForm({ ...form, refreshDays: Math.max(1, Math.min(90, Number(e.target.value) || 7)) })} />
        </div>
      </div>
      <label className="gov-check"><input type="checkbox" checked={form.includeAll} onChange={(e) => setForm({ ...form, includeAll: e.target.checked })} /> כל התקנים הרשמיים (גם מזון, צעצועים ומוצרי צריכה)</label>
      {!form.includeAll && (
        <div className="field">
          <label htmlFor="std-kw">מילים לבחירת תקנים בנושאי בטיחות (מילה בכל שורה)</label>
          <textarea id="std-kw" rows={6} dir="rtl" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} aria-describedby="std-kw-h" />
          <p id="std-kw-h" className="hint">מילה מתאימה למילה שלמה בשם התקן, גם אחרי אות שימוש (ב, ל, ה…). כוכבית בסוף מתאימה לתחילת מילה: "סולמ*" מוצא "סולמות". כמה מילים יחד מחפשות את הצירוף.</p>
          <button type="button" onClick={() => setForm({ ...form, keywords: st.defaults.join('\n') })}>החזרת המילים המומלצות</button>
        </div>
      )}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => act(() => api('PUT', '/kb/gov/standards', body()), 'ההגדרות נשמרו.')}>שמירה</button>
        <button disabled={busy || st.running} onClick={() => act(async () => { await api('PUT', '/kb/gov/standards', body()); await api('POST', '/kb/gov/standards/sync'); }, 'הייבוא התחיל.')}>{st.running ? 'מייבא…' : 'שמירה וייבוא עכשיו'}</button>
      </div>
      <p role="status" aria-live="polite" className={msg?.ok ? 'ok' : 'error'}>{st.running ? 'הייבוא רץ ברקע…' : msg?.text}</p>
      {r && (
        <p>
          ייבוא אחרון: {date(r.at)} ({r.trigger === 'manual' ? 'ידני' : 'אוטומטי'}): {r.skipped ? 'המאגר במקור לא השתנה מאז הייבוא הקודם.' : `${r.matched} מתוך ${r.total} תקנים נבחרו; נוספו ${r.created}, עודכנו ${r.updated}, ללא שינוי ${r.unchanged}${r.removed ? `, הוסרו ${r.removed}` : ''}${r.detached ? `, ${r.detached} נערכו אצלכם` : ''}.`}
          {r.failed.length > 0 && <span className="error"> שגיאה: {r.failed.map((f) => ERR[f.error] ?? f.error).join(', ')}</span>}
        </p>
      )}
      {st.imported.length > 0 && (
        <details>
          <summary>התקנים שיובאו ({st.imported.length})</summary>
          <div className="field" style={{ maxWidth: 320 }}>
            <label htmlFor="std-q">סינון</label>
            <input id="std-q" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <ul className="gov-list">
            {shown.map((x) => <li key={x.id}>{x.title}{x.detached && <span className="badge connecting"> נערך אצלכם</span>}{!x.enabled && <span className="badge stopped"> מושבת</span>}</li>)}
            {shown.length === 0 && <li className="hint">אין תוצאות לסינון.</li>}
          </ul>
        </details>
      )}
    </section>
  );
}

interface FireType { code: string; name: string; group: string; subtypes: number; requirements: number }
interface FireReport { at: string; trigger: 'manual' | 'schedule'; total: number; types: number; chosen: number; created: number; updated: number; unchanged: number; removed: number; detached: number; skipped: boolean; failed: { title: string; error: string }[] }
interface FireState {
  settings: { enabled: boolean; audience: Audience; refreshDays: number; selection: string[]; catalog: FireType[] | null; catalogAt: string | null; lastReport: FireReport | null };
  attribution: string; dataset: string; running: boolean; imported: { id: string; title: string; code: string; detached: boolean; enabled: boolean; chunks: number }[];
}

/** Stage 4: fire-safety requirements for a business licence, by business type. */
function Fire() {
  const [st, setSt] = useState<FireState | null>(null);
  const [form, setForm] = useState<{ enabled: boolean; audience: Audience; refreshDays: number; picked: Set<string> } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const load = async () => {
    const s = await api<FireState>('GET', '/kb/gov/fire').catch(() => null);
    if (!s) return;
    setSt(s);
    setForm((f) => f ?? { enabled: s.settings.enabled, audience: s.settings.audience, refreshDays: s.settings.refreshDays, picked: new Set(s.settings.selection) });
  };
  usePoll(load, st?.running ? 3000 : 15000, [st?.running]);
  const groups = useMemo(() => {
    const m = new Map<string, FireType[]>();
    for (const t of st?.settings.catalog ?? []) if (!q || `${t.name} ${t.code}`.includes(q.trim())) m.set(t.group, [...(m.get(t.group) ?? []), t]);
    return [...m.entries()];
  }, [st, q]);
  if (!st || !form) return null;
  const cat = st.settings.catalog;
  const chosenReq = (cat ?? []).filter((t) => form.picked.has(t.code)).reduce((a, t) => a + t.requirements, 0);
  const body = () => ({ enabled: form.enabled, audience: form.audience, refreshDays: form.refreshDays, selection: [...form.picked] });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null); setBusy(true);
    try { await fn(); setMsg({ ok: true, text: ok }); await load(); } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); } finally { setBusy(false); }
  };
  const toggle = (code: string) => setForm({ ...form, picked: new Set(form.picked.has(code) ? [...form.picked].filter((x) => x !== code) : [...form.picked, code]) });
  const r = st.settings.lastReport;
  return (
    <section className="card" aria-labelledby="fire-h">
      <h2 id="fire-h">דרישות כבאות לרישוי עסקים</h2>
      <p className="hint">
        דרישות בטיחות האש של הרשות הארצית לכבאות והצלה לקבלת רישיון עסק או חידושו (data.gov.il), לפי סוג העסק וגודלו. בחרו רק את סוגי העסקים שרלוונטיים לכם: כל הסוגים יחד הם כ־22,000 דרישות.
        על כל עסק חלות הדרישות שהיו בתוקף במועד הרישוי או חידושו.{' '}
        <a href={st.dataset} target="_blank" rel="noopener noreferrer">המאגר במקור<span className="sr-only"> (נפתח בחלון חדש)</span></a>
      </p>
      {!cat ? (
        <div>
          <p>כדי לבחור סוגי עסקים צריך קודם לטעון את הרשימה מהמקור (כחצי דקה).</p>
          <button className="primary" disabled={busy || st.running} onClick={() => act(async () => { await api('PUT', '/kb/gov/fire', body()); await api('POST', '/kb/gov/fire/sync'); }, 'טעינת הרשימה התחילה.')}>{st.running ? 'טוען…' : 'טעינת סוגי העסקים מהמקור'}</button>
        </div>
      ) : (
        <>
          <label className="gov-check"><input type="checkbox" role="switch" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> עדכון אוטומטי</label>
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field">
              <label htmlFor="fire-aud">מי משתמש בתוכן</label>
              <select id="fire-aud" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as Audience })}>
                {(['staff', 'both', 'bot'] as const).map((a) => <option key={a} value={a}>{AUD[a]}</option>)}
              </select>
            </div>
            <div className="field" style={{ maxWidth: 160 }}>
              <label htmlFor="fire-days">עדכון כל (ימים)</label>
              <input id="fire-days" type="number" min={1} max={90} value={form.refreshDays} onChange={(e) => setForm({ ...form, refreshDays: Math.max(1, Math.min(90, Number(e.target.value) || 30)) })} />
            </div>
          </div>
          <fieldset>
            <legend>סוגי עסקים ({form.picked.size} נבחרו, {chosenReq.toLocaleString('he-IL')} דרישות)</legend>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <div className="field" style={{ maxWidth: 320 }}>
                <label htmlFor="fire-q">סינון</label>
                <input id="fire-q" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <button type="button" onClick={() => setForm({ ...form, picked: new Set() })}>ניקוי הבחירה</button>
            </div>
            {chosenReq > 8000 && <p className="error">נבחרו הרבה דרישות. המאגר מוגבל ל־30,000 קטעים בסך הכול, ותשובות לשאלות אחרות עלולות להיפגע. מומלץ לצמצם.</p>}
            {groups.map(([g, list]) => (
              <details key={g} open={!!q || list.some((t) => form.picked.has(t.code))}>
                <summary>{g} ({list.filter((t) => form.picked.has(t.code)).length}/{list.length})</summary>
                <ul className="gov-list">
                  {list.map((t) => <li key={t.code}><label><input type="checkbox" checked={form.picked.has(t.code)} onChange={() => toggle(t.code)} /> {t.code} – {t.name} <span className="hint">({t.subtypes} תת־סוגים, {t.requirements} דרישות)</span></label></li>)}
                </ul>
              </details>
            ))}
            {groups.length === 0 && <p className="hint">אין תוצאות לסינון.</p>}
          </fieldset>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => act(() => api('PUT', '/kb/gov/fire', body()), 'ההגדרות נשמרו.')}>שמירה</button>
            <button disabled={busy || st.running} onClick={() => act(async () => { await api('PUT', '/kb/gov/fire', body()); await api('POST', '/kb/gov/fire/sync'); }, 'הייבוא התחיל.')}>{st.running ? 'מייבא…' : 'שמירה וייבוא עכשיו'}</button>
          </div>
        </>
      )}
      <p role="status" aria-live="polite" className={msg?.ok ? 'ok' : 'error'}>{st.running ? 'הייבוא רץ ברקע…' : msg?.text}</p>
      {r && (
        <p>
          ייבוא אחרון: {date(r.at)} ({r.trigger === 'manual' ? 'ידני' : 'אוטומטי'}): {r.skipped ? 'המאגר במקור לא השתנה.' : `${r.total.toLocaleString('he-IL')} דרישות ב־${r.types} סוגי עסקים במקור; ${r.chosen} סוגים נבחרו; נוספו ${r.created}, עודכנו ${r.updated}, ללא שינוי ${r.unchanged}${r.removed ? `, הוסרו ${r.removed}` : ''}${r.detached ? `, ${r.detached} נערכו אצלכם` : ''}.`}
          {r.failed.length > 0 && <span className="error"> שגיאה: {r.failed.map((f) => ERR[f.error] ?? f.error).join(', ')}</span>}
        </p>
      )}
      {st.imported.length > 0 && (
        <details>
          <summary>מה יובא ({st.imported.length} תת־סוגים)</summary>
          <ul className="gov-list">{st.imported.map((x) => <li key={x.id}>{x.title} <span className="hint">({x.chunks} דרישות)</span>{x.detached && <span className="badge connecting"> נערך אצלכם</span>}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
