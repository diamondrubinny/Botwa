import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePoll } from '../hooks';
import { errText } from '../strings';

interface Source {
  id: string; kind: 'faq' | 'text' | 'file' | 'link'; title: string; variants: string[]; url: string | null; fileName: string | null; categoryId: string | null;
  audience: 'bot' | 'staff' | 'both'; boost: number; enabled: boolean; status: 'pending' | 'ready' | 'error'; error: string | null; refreshHours: number | null;
  crawlPages: number; lastFetchedAt: string | null; parentId: string | null; version: number; uses: number; helpful: number; unhelpful: number; chunks: number; body?: string;
}
interface Category { id: string; name: string; sources: number }
interface Hit { sourceId: string; title: string; kind: string; url: string | null; snippet: string; score: number; matched: number; tokens: number; exact: boolean; heading: string | null }
interface Stats { botQuestions: number; botAnswered: number; staffLookups: number; staffAnswered: number; sources: number; errors: number; chunks: number; top: { id: string; title: string; uses: number; helpful: number; unhelpful: number }[] }

const KIND = { faq: 'שאלה ותשובה', text: 'טקסט', file: 'קובץ', link: 'קישור' } as const;
const AUD = { both: 'בוט ונציגים', bot: 'בוט בלבד', staff: 'נציגים בלבד' } as const;
const STATUS = { pending: 'בעיבוד…', ready: 'מוכן', error: 'שגיאה' } as const;
const ERR_SRC: Record<string, string> = {
  http_404: 'הדף לא נמצא (404)', http_403: 'הגישה נחסמה (403)', fetch_failed: 'לא ניתן להתחבר לכתובת', blocked_address: 'כתובת חסומה מטעמי אבטחה', unsupported_content_type: 'סוג תוכן לא נתמך',
  too_large: 'הקובץ גדול מדי', empty_content: 'לא נמצא טקסט בתוכן', infected: 'נמצאה תוכנה זדונית', scan_unavailable: 'סורק הווירוסים לא זמין', extract_timeout: 'הקריאה ארכה יותר מדי',
  extract_failed: 'לא ניתן לקרוא את הקובץ', kb_full: 'המאגר מלא', too_many_redirects: 'יותר מדי הפניות', bad_url: 'כתובת לא תקינה',
};
type Tab = 'sources' | 'test' | 'gaps' | 'synonyms' | 'stats';
const TABS: [Tab, string][] = [['sources', 'מקורות'], ['test', 'בדיקת חיפוש'], ['gaps', 'שאלות ללא מענה'], ['synonyms', 'מילים נרדפות'], ['stats', 'סטטיסטיקה']];

export function KnowledgeBase() {
  const [tab, setTab] = useState<Tab>('sources');
  return (
    <>
      <h1 tabIndex={-1}>מאגר ידע</h1>
      <p className="hint">מסמכים, קישורים ושאלות ותשובות שהבוט והנציגים משתמשים בהם. החיפוש מתבצע בשרת שלכם בלבד, בלי בינה מלאכותית ובלי שליחת מידע החוצה.</p>
      <div className="chips" role="group" aria-label="חלקי המאגר">
        {TABS.map(([k, l]) => <button key={k} className="chip" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'sources' && <Sources />}
      {tab === 'test' && <Playground />}
      {tab === 'gaps' && <Gaps onAnswer={() => setTab('sources')} />}
      {tab === 'synonyms' && <Synonyms />}
      {tab === 'stats' && <StatsView />}
    </>
  );
}

function Sources() {
  const [list, setList] = useState<Source[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [add, setAdd] = useState<'faq' | 'text' | 'file' | 'link' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [del, setDel] = useState<Source | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const load = async () => { setList(await api<Source[]>('GET', '/kb/sources').catch(() => [])); setCats(await api<Category[]>('GET', '/kb/categories').catch(() => [])); };
  usePoll(load, 5000);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try { await fn(); await load(); if (ok) setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
  };
  const shown = list.filter((s) => !filter || `${s.title} ${s.url ?? ''} ${s.fileName ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <div className="row" role="group" aria-label="הוספת מקור">
        <button className="primary" onClick={() => setAdd(add === 'faq' ? null : 'faq')} aria-expanded={add === 'faq'}>שאלה ותשובה</button>
        <button onClick={() => setAdd(add === 'file' ? null : 'file')} aria-expanded={add === 'file'}>העלאת מסמך</button>
        <button onClick={() => setAdd(add === 'link' ? null : 'link')} aria-expanded={add === 'link'}>הוספת קישור</button>
        <button onClick={() => setAdd(add === 'text' ? null : 'text')} aria-expanded={add === 'text'}>הדבקת טקסט</button>
      </div>
      <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
      {add && <AddForm kind={add} cats={cats} onDone={(t) => { setAdd(null); setMsg({ ok: true, text: t }); void load(); }} onError={(t) => setMsg({ ok: false, text: t })} />}

      <Categories cats={cats} reload={load} />

      <section className="card" aria-labelledby="src-h" style={{ overflowX: 'auto' }}>
        <h2 id="src-h">מקורות ({list.length})</h2>
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="kb-f">סינון לפי שם</label>
          <input id="kb-f" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <table>
          <caption className="sr-only">מקורות המידע במאגר</caption>
          <thead><tr><th scope="col">שם</th><th scope="col">סוג</th><th scope="col">מצב</th><th scope="col">קהל</th><th scope="col">שימושים</th><th scope="col">פעולות</th></tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={6}>אין עדיין מקורות. התחילו בשאלה ותשובה או בהעלאת מסמך.</td></tr>}
            {shown.map((s) => (
              <tr key={s.id}>
                <th scope="row">
                  {s.parentId && <span className="hint">↳ </span>}{s.title}
                  {s.url && <div dir="ltr" className="hint" style={{ wordBreak: 'break-all' }}>{s.url}</div>}
                  {s.fileName && <div className="hint">{s.fileName}</div>}
                  {s.boost > 0 && <span className="badge connected">מועדף</span>}
                  {!s.enabled && <span className="badge stopped">מושבת</span>}
                </th>
                <td>{KIND[s.kind]}{s.crawlPages > 0 && ` (+${s.crawlPages} דפים)`}</td>
                <td>
                  <span className={`badge ${s.status === 'ready' ? 'connected' : s.status === 'error' ? 'error' : 'connecting'}`}>{STATUS[s.status]}</span>
                  {s.error && <div className="error"><small>{ERR_SRC[s.error] ?? s.error}</small></div>}
                  <div className="hint">{s.chunks} קטעים · גרסה {s.version}{s.refreshHours ? ` · רענון כל ${s.refreshHours} שע׳` : ''}</div>
                </td>
                <td>{AUD[s.audience]}</td>
                <td>{s.uses}{(s.helpful || s.unhelpful) ? ` (👍${s.helpful} 👎${s.unhelpful})` : ''}</td>
                <td>
                  <div className="row">
                    {(s.kind === 'faq' || s.kind === 'text') && <button onClick={() => setEdit(edit === s.id ? null : s.id)} aria-expanded={edit === s.id}>עריכה<span className="sr-only"> {s.title}</span></button>}
                    <button onClick={() => run(() => api('PATCH', `/kb/sources/${s.id}`, { enabled: !s.enabled }))}>{s.enabled ? 'השבתה' : 'הפעלה'}<span className="sr-only"> {s.title}</span></button>
                    <button onClick={() => run(() => api('PATCH', `/kb/sources/${s.id}`, { boost: s.boost > 0 ? 0 : 1 }))} aria-pressed={s.boost > 0}>{s.boost > 0 ? 'ביטול העדפה' : 'העדפה'}<span className="sr-only"> {s.title}</span></button>
                    {s.kind === 'link' && <button onClick={() => run(() => api('POST', `/kb/sources/${s.id}/reindex`), 'הרענון התחיל.')}>רענון עכשיו<span className="sr-only"> {s.title}</span></button>}
                    <button className="danger" onClick={() => setDel(s)}>מחיקה<span className="sr-only"> {s.title}</span></button>
                  </div>
                  {edit === s.id && <EditForm id={s.id} onDone={() => { setEdit(null); void load(); }} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <ConfirmDialog open={!!del} danger title="מחיקת מקור" message={`"${del?.title}" ${del?.crawlPages ? 'והדפים שנקלטו ממנו ' : ''}יימחקו מהמאגר.`} onCancel={() => setDel(null)}
        onConfirm={() => { const d = del!; setDel(null); void run(() => api('DELETE', `/kb/sources/${d.id}`), 'נמחק.'); }} />
    </>
  );
}

function AudienceFields({ cats, audience, setAudience, categoryId, setCategoryId, boost, setBoost }: {
  cats: Category[]; audience: string; setAudience: (v: 'bot' | 'staff' | 'both') => void; categoryId: string; setCategoryId: (v: string) => void; boost: boolean; setBoost: (v: boolean) => void;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor="kb-aud">מי משתמש בזה</label>
        <select id="kb-aud" value={audience} onChange={(e) => setAudience(e.target.value as 'both')}>
          <option value="both">בוט ונציגים</option><option value="bot">בוט בלבד (מוצג ללקוחות)</option><option value="staff">נציגים בלבד (פנימי, לא יוצג ללקוחות)</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="kb-cat">קטגוריה</label>
        <select id="kb-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">ללא</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={boost} onChange={(e) => setBoost(e.target.checked)} /> מקור מועדף (מקבל עדיפות קלה בחיפוש)</label></div>
    </>
  );
}

function AddForm({ kind, cats, onDone, onError }: { kind: 'faq' | 'text' | 'file' | 'link'; cats: Category[]; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [title, setTitle] = useState('');
  const [variants, setVariants] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [crawl, setCrawl] = useState(0);
  const [refresh, setRefresh] = useState('');
  const [audience, setAudience] = useState<'bot' | 'staff' | 'both'>('both');
  const [categoryId, setCategoryId] = useState('');
  const [boost, setBoost] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, [kind]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const common = { audience, boost: boost ? 1 : 0, categoryId: categoryId || null };
    try {
      if (kind === 'faq') await api('POST', '/kb/sources/faq', { title, variants: variants.split('\n').map((v) => v.trim()).filter(Boolean), body, ...common });
      else if (kind === 'text') await api('POST', '/kb/sources/text', { title, body, ...common });
      else if (kind === 'link') await api('POST', '/kb/sources/link', { url, crawlPages: crawl, refreshHours: refresh ? Number(refresh) : null, ...common });
      else {
        const f = file.current?.files?.[0];
        if (!f) { onError('בחרו קובץ.'); setBusy(false); return; }
        const fd = new FormData();
        if (title.trim()) fd.append('title', title.trim());
        if (categoryId) fd.append('categoryId', categoryId);
        fd.append('audience', audience); fd.append('boost', boost ? '1' : '0');
        fd.append('file', f);
        const res = await fetch('/kb/sources/file', { method: 'POST', credentials: 'same-origin', body: fd });
        if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'error');
      }
      onDone(kind === 'link' ? 'הקישור נוסף ונקרא ברקע.' : 'נוסף למאגר.');
    } catch (er) { onError(errText(er instanceof ApiError ? er.code : 'generic')); }
    setBusy(false);
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{{ faq: 'שאלה ותשובה', text: 'הדבקת טקסט', file: 'העלאת מסמך', link: 'הוספת קישור' }[kind]}</h2>
      {kind === 'link' ? (
        <>
          <div className="field"><label htmlFor="kb-url">כתובת (http/https)</label><input id="kb-url" ref={first} required dir="ltr" inputMode="url" placeholder="https://example.com/help" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
          <div className="field">
            <label htmlFor="kb-crawl">לקרוא גם דפים מאותו אתר שמקושרים מהדף</label>
            <select id="kb-crawl" value={crawl} onChange={(e) => setCrawl(Number(e.target.value))}><option value={0}>לא, רק הדף הזה</option><option value={5}>עד 5 דפים</option><option value={10}>עד 10 דפים</option><option value={25}>עד 25 דפים</option></select>
          </div>
          <div className="field">
            <label htmlFor="kb-ref">רענון אוטומטי</label>
            <select id="kb-ref" value={refresh} onChange={(e) => setRefresh(e.target.value)}><option value="">ללא</option><option value="24">פעם ביום</option><option value="168">פעם בשבוע</option></select>
            <p className="hint">השרת ניגש לכתובת בעצמו. כתובות פנימיות וכתובות של השרת עצמו נחסמות מטעמי אבטחה.</p>
          </div>
        </>
      ) : kind === 'file' ? (
        <>
          <div className="field"><label htmlFor="kb-file">קובץ (PDF, DOCX, TXT, MD, CSV, HTML)</label><input id="kb-file" ref={file} required type="file" accept=".pdf,.docx,.txt,.md,.csv,.html,.htm" /></div>
          <div className="field"><label htmlFor="kb-t">שם (אופציונלי)</label><input id="kb-t" maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <p className="hint">קבצי PDF ו-DOCX נסרקים בנגד וירוסים ונקראים בסביבה מבודדת. הקובץ המקורי אינו נשמר, רק הטקסט שלו.</p>
        </>
      ) : (
        <>
          <div className="field"><label htmlFor="kb-t">{kind === 'faq' ? 'השאלה' : 'כותרת'}</label><input id="kb-t" ref={first} required minLength={2} maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          {kind === 'faq' && <div className="field"><label htmlFor="kb-v">ניסוחים נוספים לאותה שאלה (שורה לכל ניסוח, אופציונלי)</label><textarea id="kb-v" rows={3} value={variants} onChange={(e) => setVariants(e.target.value)} /></div>}
          <div className="field"><label htmlFor="kb-b">{kind === 'faq' ? 'התשובה (תישלח כמות שהיא)' : 'התוכן'}</label><textarea id="kb-b" required minLength={kind === 'faq' ? 2 : 10} rows={kind === 'faq' ? 5 : 10} maxLength={kind === 'faq' ? 6000 : 200000} value={body} onChange={(e) => setBody(e.target.value)} /></div>
        </>
      )}
      <AudienceFields cats={cats} audience={audience} setAudience={setAudience} categoryId={categoryId} setCategoryId={setCategoryId} boost={boost} setBoost={setBoost} />
      <button className="primary" type="submit" disabled={busy}>{busy ? 'מוסיף…' : 'הוספה'}</button>
    </form>
  );
}

function EditForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [s, setS] = useState<Source | null>(null);
  const [variants, setVariants] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { void api<Source>('GET', `/kb/sources/${id}`).then((d) => { setS(d); setVariants(d.variants.join('\n')); }).catch(() => undefined); }, [id]);
  if (!s) return <p role="status">טוען…</p>;
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      try { await api('PATCH', `/kb/sources/${id}`, { title: s.title, body: s.body, ...(s.kind === 'faq' ? { variants: variants.split('\n').map((v) => v.trim()).filter(Boolean) } : {}) }); onDone(); } catch (er) { setMsg(errText(er instanceof ApiError ? er.code : 'generic')); }
    }}>
      <div className="field"><label htmlFor={`e-t-${id}`}>{s.kind === 'faq' ? 'שאלה' : 'כותרת'}</label><input id={`e-t-${id}`} required value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} /></div>
      {s.kind === 'faq' && <div className="field"><label htmlFor={`e-v-${id}`}>ניסוחים נוספים</label><textarea id={`e-v-${id}`} rows={3} value={variants} onChange={(e) => setVariants(e.target.value)} /></div>}
      <div className="field"><label htmlFor={`e-b-${id}`}>תוכן</label><textarea id={`e-b-${id}`} required rows={6} value={s.body ?? ''} onChange={(e) => setS({ ...s, body: e.target.value })} /></div>
      <button className="primary" type="submit">שמירה</button>
      <p role="alert" className="error">{msg}</p>
    </form>
  );
}

function Categories({ cats, reload }: { cats: Category[]; reload: () => Promise<void> }) {
  const [name, setName] = useState('');
  return (
    <details className="card">
      <summary>קטגוריות ({cats.length})</summary>
      <ul>{cats.map((c) => <li key={c.id}>{c.name} ({c.sources}) <button className="danger" onClick={async () => { await api('DELETE', `/kb/categories/${c.id}`).catch(() => undefined); await reload(); }}>מחיקה<span className="sr-only"> {c.name}</span></button></li>)}</ul>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); await api('POST', '/kb/categories', { name }).catch(() => undefined); setName(''); await reload(); }}>
        <label htmlFor="kb-cn" className="sr-only">שם קטגוריה חדשה</label>
        <input id="kb-cn" required maxLength={60} placeholder="קטגוריה חדשה" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 260 }} />
        <button type="submit">הוספה</button>
      </form>
    </details>
  );
}

function Playground() {
  const [q, setQ] = useState('');
  const [aud, setAud] = useState<'bot' | 'staff' | 'any'>('bot');
  const [res, setRes] = useState<{ minScore: number; wouldAnswer: boolean; hits: Hit[] } | null>(null);
  const [err, setErr] = useState('');
  return (
    <section className="card" aria-labelledby="pg-h">
      <h2 id="pg-h">בדיקת חיפוש</h2>
      <p className="hint">כתבו שאלה כמו שלקוח היה כותב, וראו מה הבוט היה עונה ולמה. הבדיקה לא נספרת בסטטיסטיקה.</p>
      <form onSubmit={async (e) => { e.preventDefault(); setErr(''); try { setRes(await api('POST', '/kb/search', { q, audience: aud })); } catch (er) { setErr(errText(er instanceof ApiError ? er.code : 'generic')); } }}>
        <div className="field"><label htmlFor="pg-q">שאלה</label><input id="pg-q" required minLength={2} maxLength={300} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="field"><label htmlFor="pg-a">מנקודת מבט של</label>
          <select id="pg-a" value={aud} onChange={(e) => setAud(e.target.value as 'bot')}><option value="bot">לקוח (בוט)</option><option value="staff">נציג</option><option value="any">הכול</option></select></div>
        <button className="primary" type="submit">בדיקה</button>
      </form>
      <p role="alert" className="error">{err}</p>
      {res && (
        <div role="status">
          <p><strong className={res.wouldAnswer ? 'ok' : 'error'}>{res.wouldAnswer ? 'הבוט היה עונה.' : 'הבוט לא היה עונה (אין התאמה מספיק טובה).'}</strong> סף נוכחי: {Math.round(res.minScore * 100)}%.</p>
          {res.hits.length === 0 && <p>לא נמצאו תוצאות.</p>}
          <ol>{res.hits.map((h) => (
            <li key={h.sourceId}>
              <strong>{h.title}</strong> · {Math.round(h.score * 100)}% · {h.matched}/{h.tokens} מילים{h.exact ? ' · התאמה מדויקת' : ''}
              {h.heading && <div className="hint">{h.heading}</div>}
              <div style={{ whiteSpace: 'pre-wrap' }}>{h.snippet}</div>
            </li>
          ))}</ol>
        </div>
      )}
    </section>
  );
}

function Gaps({ onAnswer }: { onAnswer: () => void }) {
  const [rows, setRows] = useState<{ text: string; times: number; lastAt: string; bestScore: string | null }[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [msg, setMsg] = useState('');
  const load = async () => setRows(await api<typeof rows>('GET', '/kb/gaps').catch(() => []));
  usePoll(load, 15000);
  return (
    <section className="card" aria-labelledby="gp-h" style={{ overflowX: 'auto' }}>
      <h2 id="gp-h">שאלות שהבוט והנציגים לא מצאו להן תשובה</h2>
      <p className="hint">30 הימים האחרונים. כתבו תשובה לשאלות שחוזרות כדי לשפר את המאגר. הטקסט נשמר זמן קצר ונמחק אוטומטית.</p>
      <p role="status" className={msg === 'נוסף למאגר.' ? 'ok' : 'error'}>{msg}</p>
      <table>
        <caption className="sr-only">שאלות ללא מענה</caption>
        <thead><tr><th scope="col">שאלה</th><th scope="col">פעמים</th><th scope="col">התאמה הכי טובה</th><th scope="col">פעולות</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={4}>אין שאלות ללא מענה.</td></tr>}
          {rows.map((r) => (
            <tr key={r.text}>
              <th scope="row">{r.text}</th><td>{r.times}</td><td>{r.bestScore ? `${Math.round(Number(r.bestScore) * 100)}%` : '—'}</td>
              <td>
                <div className="row">
                  <button onClick={() => { setAdding(adding === r.text ? null : r.text); setAnswer(''); }} aria-expanded={adding === r.text}>כתיבת תשובה<span className="sr-only"> {r.text}</span></button>
                  <button onClick={async () => { await api('POST', '/kb/gaps/dismiss', { text: r.text }).catch(() => undefined); await load(); }}>התעלמות<span className="sr-only"> {r.text}</span></button>
                </div>
                {adding === r.text && (
                  <form onSubmit={async (e) => {
                    e.preventDefault();
                    try { await api('POST', '/kb/sources/faq', { title: r.text, body: answer, audience: 'both', boost: 0 }); await api('POST', '/kb/gaps/dismiss', { text: r.text }); setMsg('נוסף למאגר.'); setAdding(null); await load(); onAnswer(); } catch (er) { setMsg(errText(er instanceof ApiError ? er.code : 'generic')); }
                  }}>
                    <div className="field"><label htmlFor="gp-a">התשובה</label><textarea id="gp-a" required minLength={2} rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} /></div>
                    <button className="primary" type="submit">שמירה כשאלה ותשובה</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Synonyms() {
  const [rows, setRows] = useState<{ id: string; words: string[] }[]>([]);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const load = async () => setRows(await api<typeof rows>('GET', '/kb/synonyms').catch(() => []));
  usePoll(load, 30000);
  return (
    <section className="card" aria-labelledby="sy-h">
      <h2 id="sy-h">מילים נרדפות</h2>
      <p className="hint">מילים שהלקוחות משתמשים בהן לאותו דבר, כדי שהחיפוש ימצא תשובה בכל ניסוח. לדוגמה: משלוח, שילוח, delivery.</p>
      <ul>{rows.map((r) => <li key={r.id}>{r.words.join(' = ')} <button className="danger" onClick={async () => { await api('DELETE', `/kb/synonyms/${r.id}`).catch(() => undefined); await load(); }}>מחיקה<span className="sr-only"> {r.words.join(' ')}</span></button></li>)}</ul>
      {rows.length === 0 && <p>אין עדיין.</p>}
      <form onSubmit={async (e) => { e.preventDefault(); setMsg(''); try { await api('POST', '/kb/synonyms', { words: text.split(/[,\n،]/).map((w) => w.trim()).filter(Boolean) }); setText(''); await load(); } catch (er) { setMsg(errText(er instanceof ApiError ? er.code : 'generic')); } }}>
        <div className="field"><label htmlFor="sy-t">קבוצה חדשה (מילים מופרדות בפסיק)</label><input id="sy-t" required value={text} onChange={(e) => setText(e.target.value)} placeholder="משלוח, שילוח, delivery" /></div>
        <button className="primary" type="submit">הוספה</button>
        <p role="alert" className="error">{msg}</p>
      </form>
    </section>
  );
}

function StatsView() {
  const [s, setS] = useState<Stats | null>(null);
  usePoll(async () => setS(await api<Stats>('GET', '/kb/stats').catch(() => null)), 30000);
  if (!s) return <p role="status">טוען…</p>;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return (
    <section className="card" aria-labelledby="st-h">
      <h2 id="st-h">סטטיסטיקה (30 ימים)</h2>
      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '.75rem', margin: 0 }}>
        {([['מקורות', s.sources], ['קטעים', s.chunks], ['מקורות עם שגיאה', s.errors], ['שאלות לבוט', s.botQuestions], ['נענו ע״י הבוט', `${s.botAnswered} (${pct(s.botAnswered, s.botQuestions)})`], ['חיפושי נציגים', s.staffLookups], ['נמצאה הצעה לנציג', `${s.staffAnswered} (${pct(s.staffAnswered, s.staffLookups)})`]] as [string, string | number][]).map(([k, v]) => (
          <div key={k}><dt className="hint">{k}</dt><dd style={{ margin: 0, fontSize: '1.3rem', fontWeight: 700 }}>{v}</dd></div>
        ))}
      </dl>
      <h3 style={{ marginTop: '1rem' }}>המקורות הנפוצים</h3>
      <ol>{s.top.length === 0 ? <li>אין עדיין.</li> : s.top.map((t) => <li key={t.id}>{t.title}: {t.uses} שימושים (👍{t.helpful} 👎{t.unhelpful})</li>)}</ol>
    </section>
  );
}
