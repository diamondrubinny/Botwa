import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePoll } from '../hooks';
import { errText } from '../strings';

interface Source {
  id: string; kind: 'faq' | 'text' | 'file' | 'link'; title: string; variants: string[]; url: string | null; fileName: string | null; categoryId: string | null;
  audience: 'bot' | 'staff' | 'both'; boost: number; enabled: boolean; status: 'pending' | 'ready' | 'error'; error: string | null; refreshHours: number | null;
  crawlPages: number; crawlReport?: CrawlReport | null; lastFetchedAt: string | null; parentId: string | null; version: number; uses: number; helpful: number; unhelpful: number; chunks: number; body?: string;
}
interface Category { id: string; name: string; sources: number }
interface Hit { sem?: number; cos?: number | null; sourceId: string; title: string; kind: string; url: string | null; snippet: string; score: number; matched: number; tokens: number; exact: boolean; heading: string | null }
interface Stats { botQuestions: number; botAnswered: number; staffLookups: number; staffAnswered: number; sources: number; errors: number; chunks: number; top: { id: string; title: string; uses: number; helpful: number; unhelpful: number }[] }

const KIND = { faq: 'שאלה ותשובה', text: 'טקסט', file: 'קובץ', link: 'קישור' } as const;
const AUD = { both: 'בוט ונציגים', bot: 'בוט בלבד', staff: 'נציגים בלבד' } as const;
const STATUS = { pending: 'בעיבוד…', ready: 'מוכן', error: 'שגיאה' } as const;
const ERR_SRC: Record<string, string> = {
  http_404: 'הדף לא נמצא (404)', http_403: 'הגישה נחסמה (403)', fetch_failed: 'לא ניתן להתחבר לכתובת', blocked_address: 'כתובת חסומה מטעמי אבטחה', unsupported_content_type: 'סוג תוכן לא נתמך',
  too_large: 'הקובץ גדול מדי', empty_content: 'לא נמצא טקסט בתוכן', infected: 'נמצאה תוכנה זדונית', scan_unavailable: 'סורק הווירוסים לא זמין', extract_timeout: 'הקריאה ארכה יותר מדי',
  extract_failed: 'לא ניתן לקרוא את הקובץ', gone: 'הדף כבר לא נמצא באתר (הושבת)', thin_content: 'כמעט אין בדף טקסט', soft_404: 'דף שגיאה', dns_failed: 'כתובת האתר לא נמצאה', timeout: 'האתר לא ענה בזמן', tls_error: 'בעיית תעודת אבטחה באתר', kb_full: 'המאגר מלא', too_many_redirects: 'יותר מדי הפניות', bad_url: 'כתובת לא תקינה',
};
interface CrawlReport { at: string; discovered: number; indexed: number; unchanged: number; failed: number; robots: number; filtered: number; duplicates: number; thin: number; gone: number; limited: boolean; sitemap: number; boilerplate?: number; rendered?: number }
const reportText = (r: CrawlReport) => `נסרקו ${r.indexed + r.unchanged + r.failed + r.thin + r.duplicates} דפים: ${r.indexed} חדשים או עודכנו, ${r.unchanged} ללא שינוי${r.failed ? `, ${r.failed} נכשלו` : ''}${r.thin ? `, ${r.thin} כמעט ריקים (לא נשמרו)` : ''}${r.duplicates ? `, ${r.duplicates} כפילויות` : ''}${r.robots ? `, ${r.robots} נחסמו ב-robots.txt` : ''}${r.filtered ? `, ${r.filtered} מחוץ להיקף` : ''}${r.gone ? `, ${r.gone} כבר לא באתר (הושבתו)` : ''}${r.rendered ? `, ${r.rendered} נטענו בדפדפן` : ''}${r.boilerplate ? `, הוסרו ${r.boilerplate} קטעים שחוזרים בהרבה דפים (תפריטים וכותרות)` : ''}${r.limited ? '. הסריקה נעצרה במגבלת הדפים' : ''}`;
type Tab = 'sources' | 'test' | 'gaps' | 'synonyms' | 'stats' | 'health';
const TABS: [Tab, string][] = [['sources', 'מקורות'], ['test', 'בדיקת חיפוש'], ['gaps', 'שאלות ללא מענה'], ['synonyms', 'מילים נרדפות'], ['stats', 'סטטיסטיקה'], ['health', 'בריאות וכלים']];

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
      {tab === 'health' && <Health />}
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
      <BrowserBanner />
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
                  {s.crawlReport && <div className="hint">סריקה אחרונה ({new Date(s.crawlReport.at).toLocaleDateString('he-IL')}): {reportText(s.crawlReport)}</div>}
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
  const [adv, setAdv] = useState<CrawlOpts>({ render: 'auto', depth: 1, sitemap: false, stayInPath: false, files: false, include: '', exclude: '', selector: '', remove: '' });
  const [preview, setPreview] = useState<Preview | null>(null);
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
      else if (kind === 'link') await api('POST', '/kb/sources/link', { url, crawlPages: crawl, refreshHours: refresh ? Number(refresh) : null, crawl: crawlBody(adv), ...common });
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
            <select id="kb-crawl" value={crawl} onChange={(e) => setCrawl(Number(e.target.value))}><option value={0}>לא, רק הדף הזה</option>{[5, 10, 25, 50, 100, 300].map((n) => <option key={n} value={n}>עד {n} דפים</option>)}</select>
          </div>
          <div className="field">
            <label htmlFor="kb-ref">רענון אוטומטי</label>
            <select id="kb-ref" value={refresh} onChange={(e) => setRefresh(e.target.value)}><option value="">ללא</option><option value="24">פעם ביום</option><option value="168">פעם בשבוע</option></select>
            <p className="hint">השרת ניגש לכתובת בעצמו. כתובות פנימיות וכתובות של השרת עצמו נחסמות מטעמי אבטחה.</p>
          </div>
          <ScrapeOptions adv={adv} setAdv={setAdv} url={url} onPreview={setPreview} onError={onError} crawl={crawl} />
          {preview && <PreviewPanel p={preview} />}
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

const SEM_TEXT: Record<string, string> = { off: 'כבוי (חיפוש לפי מילים בלבד)', loading: 'המודל נטען…', ready: 'פעיל', error: 'שגיאה' };
function BrowserBanner() {
  const [s, setS] = useState<{ mode: string; state: string; detail?: string } | null>(null);
  usePoll(async () => setS(await api<NonNullable<typeof s>>('GET', '/kb/browser').catch(() => null)), 30000);
  if (!s) return null;
  return (
    <p className="hint" role="status">
      דפדפן לטעינת דפים: <strong>{s.state === 'ready' ? 'פעיל' : s.state === 'off' ? 'כבוי' : 'לא זמין'}</strong>{s.mode === 'remote' ? ' (שירות נפרד)' : s.mode === 'local' ? ' (על השרת)' : ''}
      {s.state === 'unavailable' && s.detail ? ` · ${s.detail}` : ''}
      {s.state === 'off' ? ' · להפעלה: ראו "דפדפן לסריקת אתרים" בתיעוד מאגר הידע.' : ''}
    </p>
  );
}

function SemanticBanner() {
  const [s, setS] = useState<{ state: string; detail?: string; embedded: number; total: number } | null>(null);
  usePoll(async () => setS(await api<NonNullable<typeof s>>('GET', '/kb/semantic').catch(() => null)), 10000);
  if (!s) return null;
  return (
    <p className="hint" role="status">
      חיפוש לפי משמעות: <strong>{SEM_TEXT[s.state] ?? s.state}</strong>{s.state === 'error' && s.detail ? ` (${s.detail === 'not_installed' ? 'רכיב ההרצה לא מותקן: בנו עם WITH_SEMANTIC=1' : s.detail})` : ''}
      {s.state === 'ready' ? ` · ${s.embedded}/${s.total} מקורות מוכנים` : ''}
      {s.state === 'off' ? ' · להפעלה: SEMANTIC_SEARCH=local ו-WITH_SEMANTIC=1 בקובץ .env, ובנייה מחדש.' : ''}
    </p>
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
      <SemanticBanner />
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
              <strong>{h.title}</strong> · {Math.round(h.score * 100)}% · {h.matched}/{h.tokens} מילים{h.exact ? ' · התאמה מדויקת' : ''}{h.cos ? ` · משמעות ${Math.round((h.sem ?? 0) * 100)}%` : ''}
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


interface CrawlOpts { render: 'auto' | 'always' | 'never'; depth: number; sitemap: boolean; stayInPath: boolean; files: boolean; include: string; exclude: string; selector: string; remove: string }
const lines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 10);
const crawlBody = (o: CrawlOpts) => ({ render: o.render, depth: o.depth, sitemap: o.sitemap, stayInPath: o.stayInPath, files: o.files, include: lines(o.include), exclude: lines(o.exclude), selector: o.selector.trim(), remove: lines(o.remove) });
interface Preview {
  url: string; rendered?: boolean; title: string | null; canonical: string | null; robotsAllowed: boolean; chars: number; thin: boolean; soft404: boolean; headings: string[]; excerpt: string;
  links: { total: number; accepted: string[]; filtered: number; robots: number; duplicates: number }; sitemap: { found: boolean; urls: number; sample: string[] };
}

function ScrapeOptions({ adv, setAdv, url, onPreview, onError, crawl }: { adv: CrawlOpts; setAdv: (o: CrawlOpts) => void; url: string; onPreview: (p: Preview | null) => void; onError: (t: string) => void; crawl: number }) {
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<CrawlOpts>) => setAdv({ ...adv, ...p });
  async function run() {
    setBusy(true); onPreview(null);
    try { onPreview(await api<Preview>('POST', '/kb/scrape/preview', { url, crawl: crawlBody(adv) })); } catch (er) { onError(ERR_SRC[er instanceof ApiError ? er.code : ''] ?? errText(er instanceof ApiError ? er.code : 'generic')); }
    setBusy(false);
  }
  return (
    <details className="card">
      <summary><strong>אפשרויות סריקה מתקדמות</strong> (עומק, מפת אתר, דפוסים, בורר תוכן, תצוגה מקדימה)</summary>
      <div className="field"><label htmlFor="sc-render">אתרים שנבנים ב-JavaScript (דפדפן)</label>
        <select id="sc-render" value={adv.render} onChange={(e) => set({ render: e.target.value as CrawlOpts['render'] })}><option value="auto">אוטומטי: דפדפן רק כשהדף נראה ריק בקריאה רגילה</option><option value="always">תמיד בדפדפן (איטי יותר)</option><option value="never">אף פעם, קריאה רגילה בלבד</option></select>
        <p className="hint">הדפדפן זמין רק אם הופעל בשרת (ראו את השורה "דפדפן לטעינת דפים" מעל כפתורי ההוספה). אם אינו זמין, הדפים נקראים ישירות.</p></div>
      <div className="row">
        <div className="field"><label htmlFor="sc-depth">עומק (קפיצות מהדף הראשון)</label>
          <select id="sc-depth" value={adv.depth} disabled={crawl === 0} onChange={(e) => set({ depth: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
      </div>
      <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={adv.sitemap} disabled={crawl === 0} onChange={(e) => set({ sitemap: e.target.checked })} /> להוסיף כתובות ממפת האתר (sitemap.xml)</label></div>
      <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={adv.stayInPath} disabled={crawl === 0} onChange={(e) => set({ stayInPath: e.target.checked })} /> להישאר בתוך החלק של האתר שבכתובת (למשל רק /help)</label></div>
      <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={adv.files} disabled={crawl === 0} onChange={(e) => set({ files: e.target.checked })} /> לקרוא גם קבצי PDF, Word ו-Excel שמקושרים (נסרקים לוירוסים)</label></div>
      <div className="field"><label htmlFor="sc-inc">לקרוא רק כתובות שמכילות (שורה לכל דפוס, אפשר *)</label><textarea id="sc-inc" rows={2} dir="ltr" value={adv.include} disabled={crawl === 0} onChange={(e) => set({ include: e.target.value })} placeholder="/help/*" /></div>
      <div className="field"><label htmlFor="sc-exc">לא לקרוא כתובות שמכילות (שורה לכל דפוס)</label><textarea id="sc-exc" rows={2} dir="ltr" value={adv.exclude} disabled={crawl === 0} onChange={(e) => set({ exclude: e.target.value })} placeholder={'/login\nprint=1'} /></div>
      <div className="field"><label htmlFor="sc-sel">בורר CSS של תוכן הדף (ריק = זיהוי אוטומטי)</label><input id="sc-sel" dir="ltr" maxLength={200} value={adv.selector} onChange={(e) => set({ selector: e.target.value })} placeholder="main .article" /></div>
      <div className="field"><label htmlFor="sc-rem">חלקים להסיר מכל דף (בורר CSS בכל שורה)</label><textarea id="sc-rem" rows={2} dir="ltr" value={adv.remove} onChange={(e) => set({ remove: e.target.value })} placeholder=".promo&#10;#cookie-banner" /></div>
      <p className="hint">בכל מקרה: השרת מכבד robots.txt, מדלג על דפי שגיאה ודפים ריקים, מאחד כתובות כפולות (כולל canonical) ולא עוקב אחרי קישורי nofollow. אם בדף נשאר אחרי הסריקה טקסט מיותר או שחסר תוכן, התאימו בורר וראו בתצוגה המקדימה.</p>
      <button type="button" onClick={run} disabled={busy || !url.trim()}>{busy ? 'בודק…' : 'תצוגה מקדימה (לא נשמר דבר)'}</button>
    </details>
  );
}

function PreviewPanel({ p }: { p: Preview }) {
  return (
    <section className="card" aria-live="polite" aria-labelledby="sc-pv">
      <h3 id="sc-pv">תצוגה מקדימה: {p.title ?? p.url}</h3>
      <ul>
        <li>{p.rendered ? 'הדף נטען בדפדפן (התוכן נבנה ב-JavaScript).' : 'הדף נקרא ישירות, בלי דפדפן.'}</li>
        <li>{p.chars.toLocaleString('he-IL')} תווים של טקסט {p.thin && <strong className="error"> (מעט מדי: דף כזה לא יישמר)</strong>}{p.soft404 && <strong className="error"> (נראה כדף שגיאה)</strong>}</li>
        {!p.robotsAllowed && <li className="error">robots.txt של האתר אוסר קריאת הדף הזה, ולכן הסריקה תדלג עליו.</li>}
        {p.canonical && p.canonical !== p.url && <li>הדף מצהיר שהכתובת הקנונית שלו היא <span dir="ltr">{p.canonical}</span>, ולכן בסריקה יקרא רק הדף ההוא.</li>}
        <li>קישורים בדף: {p.links.total}. ייסרקו {p.links.accepted.length}{p.links.accepted.length >= 40 ? '+' : ''}, מחוץ להיקף {p.links.filtered}, נחסמו ב-robots.txt {p.links.robots}, כפולים {p.links.duplicates}.</li>
        {p.sitemap.found && <li>במפת האתר נמצאו {p.sitemap.urls} כתובות.</li>}
      </ul>
      {p.headings.length > 0 && <><strong>כותרות שזוהו</strong><pre dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{p.headings.join('\n')}</pre></>}
      <strong>הטקסט שייקלט (תחילתו)</strong>
      <pre dir="auto" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }} tabIndex={0}>{p.excerpt}</pre>
      {p.links.accepted.length > 0 && <details><summary>כתובות שייסרקו (דוגמה)</summary><ul dir="ltr">{p.links.accepted.map((u) => <li key={u} style={{ overflowWrap: 'anywhere' }}>{u}</li>)}</ul></details>}
    </section>
  );
}

interface Health {
  byStatus: { status: string; n: number }[];
  errors: { id: string; title: string; url: string | null; kind: string; error: string | null }[];
  stale: { id: string; title: string; url: string | null; lastFetchedAt: string }[];
  empty: { id: string; title: string; kind: string }[];
  crawls: { id: string; title: string; url: string | null; report: CrawlReport }[];
}
interface DupGroup { hash: string; items: { id: string; title: string; kind: string; url: string | null; enabled: boolean; parentId: string | null }[] }

function Health() {
  const [h, setH] = useState<Health | null>(null);
  const [dups, setDups] = useState<DupGroup[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [del, setDel] = useState<{ id: string; title: string } | null>(null);
  const load = async () => { setH(await api<Health>('GET', '/kb/health').catch(() => null)); setDups(await api<DupGroup[]>('GET', '/kb/duplicates').catch(() => [])); };
  useEffect(() => { void load(); }, []);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setMsg(null); try { await fn(); setMsg({ ok: true, text: ok }); await load(); } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); } };
  if (!h) return <p role="status">טוען…</p>;
  const n = (s: string) => h.byStatus.find((x) => x.status === s)?.n ?? 0;
  return (
    <>
      <section className="card" aria-labelledby="hl-h">
        <h2 id="hl-h">בריאות המאגר</h2>
        <p>{n('ready')} מקורות תקינים, {n('pending')} ממתינים, {n('error')} בשגיאה.</p>
        <div className="row"><button onClick={() => act(() => api('POST', '/kb/sources/refresh-links'), 'כל הקישורים נשלחו לרענון (דפים שלא השתנו לא יתעדכנו).')}>רענון כל הקישורים עכשיו</button></div>
        <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
      </section>

      <section className="card" aria-labelledby="hl-e">
        <h2 id="hl-e">מקורות בשגיאה ({h.errors.length})</h2>
        {h.errors.length === 0 ? <p>אין.</p> : (
          <table><caption className="sr-only">מקורות בשגיאה</caption><thead><tr><th scope="col">מקור</th><th scope="col">הסיבה</th><th scope="col">פעולות</th></tr></thead>
            <tbody>{h.errors.map((e) => (
              <tr key={e.id}><th scope="row">{e.title}{e.url && <div dir="ltr" className="hint" style={{ overflowWrap: 'anywhere' }}>{e.url}</div>}</th><td>{ERR_SRC[e.error ?? ''] ?? e.error}</td>
                <td className="row">{e.kind === 'link' && <button onClick={() => act(() => api('POST', `/kb/sources/${e.id}/reindex`), 'הרענון התחיל.')}>ניסיון חוזר<span className="sr-only"> {e.title}</span></button>}
                  <button className="danger" onClick={() => setDel({ id: e.id, title: e.title })}>מחיקה<span className="sr-only"> {e.title}</span></button></td></tr>))}</tbody></table>
        )}
      </section>

      <section className="card" aria-labelledby="hl-d">
        <h2 id="hl-d">תוכן כפול ({dups.length})</h2>
        <p className="hint">מקורות שהתוכן שלהם זהה. כדאי להשאיר אחד.</p>
        {dups.length === 0 ? <p>לא נמצאו כפילויות.</p> : dups.map((g) => (
          <ul key={g.hash}>{g.items.map((i, k) => <li key={i.id} className="row"><span>{i.title}{i.url && <span dir="ltr" className="hint"> {i.url}</span>}{k === 0 && ' (הראשון)'}</span>
            {k > 0 && <button className="danger" onClick={() => setDel({ id: i.id, title: i.title })}>מחיקה<span className="sr-only"> {i.title}</span></button>}</li>)}</ul>
        ))}
      </section>

      <section className="card" aria-labelledby="hl-s">
        <h2 id="hl-s">לא רועננו מעל 60 יום ({h.stale.length}) ומקורות בלי תוכן ({h.empty.length})</h2>
        {h.stale.length + h.empty.length === 0 ? <p>אין.</p> : (
          <ul>{h.stale.map((x) => <li key={x.id} className="row"><span>{x.title} · נקרא לאחרונה {new Date(x.lastFetchedAt).toLocaleDateString('he-IL')}</span><button onClick={() => act(() => api('POST', `/kb/sources/${x.id}/reindex`), 'הרענון התחיל.')}>רענון<span className="sr-only"> {x.title}</span></button></li>)}
            {h.empty.map((x) => <li key={x.id}>{x.title} (אין קטעי תוכן)</li>)}</ul>
        )}
      </section>

      <section className="card" aria-labelledby="hl-c">
        <h2 id="hl-c">דוחות סריקה אחרונים</h2>
        {h.crawls.length === 0 ? <p>עוד לא בוצעה סריקת אתר.</p> : <ul>{h.crawls.map((c) => <li key={c.id}><strong>{c.title}</strong> ({new Date(c.report.at).toLocaleString('he-IL')}): {reportText(c.report)}</li>)}</ul>}
      </section>

      <ConfirmDialog open={!!del} danger title="מחיקת מקור" message={`"${del?.title}" יימחק מהמאגר.`} onCancel={() => setDel(null)}
        onConfirm={() => { const d = del!; setDel(null); void act(() => api('DELETE', `/kb/sources/${d.id}`), 'נמחק.'); }} />
    </>
  );
}
