import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, can, type Me } from '../api';
import { errText } from '../strings';

interface Cat { id: string; name: string; keywords: string[]; count: number }
interface Item { sourceId?: string; id?: string; title: string; reference: string | null; url: string | null; excerpt: string; related: string | null; difference: string | null; subtopic?: string | null; date?: string | null; score?: number }
interface Group { instrument: string; items: Item[] }

const fmtDate = (d: string | null | undefined) => (d ? d.slice(0, 10) : '');

function Card({ it }: { it: Item }) {
  const id = it.sourceId ?? it.id!;
  const [full, setFull] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  async function toggle() {
    if (full !== null) { setFull(null); return; }
    const r = await api<{ body: string }>('GET', `/safety/source/${id}`).catch(() => null);
    setFull(r?.body ?? it.excerpt);
  }
  const cite = [it.title, it.reference && `סימוכין: ${it.reference}`, it.url].filter(Boolean).join('\n');
  return (
    <li className="card safety-card">
      <h4 style={{ margin: 0 }}>{it.title}</h4>
      <div className="row" style={{ margin: '.25rem 0' }}>
        {it.reference && <span className="badge connected">סימוכין: {it.reference}</span>}
        {it.subtopic && <span className="hint">{it.subtopic}</span>}
        {it.date && <span className="hint">{fmtDate(it.date)}</span>}
      </div>
      <p style={{ whiteSpace: 'pre-wrap', margin: '.3rem 0' }}>{full ?? it.excerpt}</p>
      {it.related && <p className="hint">הצלבות: {it.related}</p>}
      {it.difference && <p className="hint"><strong>שוני/סתירה:</strong> {it.difference}</p>}
      <div className="row">
        <button type="button" onClick={toggle} aria-expanded={full !== null}>{full !== null ? 'הצגת תקציר' : 'הצגה מלאה'}<span className="sr-only"> {it.title}</span></button>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(cite).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? 'הועתק' : 'העתקת סימוכין'}<span className="sr-only"> {it.title}</span></button>
        {it.url && <a className="btn" href={it.url} target="_blank" rel="noopener noreferrer">למקור באתר<span className="sr-only"> {it.title}, נפתח בלשונית חדשה</span></a>}
      </div>
    </li>
  );
}

function Groups({ groups }: { groups: Group[] }) {
  return (
    <>
      {groups.map((g) => (
        <section key={g.instrument} aria-labelledby={`g-${g.instrument}`}>
          <h3 id={`g-${g.instrument}`}>{g.instrument} ({g.items.length})</h3>
          <ul style={{ listStyle: 'none', padding: 0 }}>{g.items.map((it) => <Card key={it.sourceId ?? it.id} it={it} />)}</ul>
        </section>
      ))}
    </>
  );
}

export function Safety({ me }: { me: Me }) {
  const manage = can(me, 'kb.manage');
  const [cats, setCats] = useState<Cat[]>([]);
  const [stats, setStats] = useState({ total: 0, uncategorized: 0 });
  const [cat, setCat] = useState<string>('');
  const [tab, setTab] = useState<'ask' | 'all'>('ask');
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ total: number; groups: Group[] } | null>(null);
  const [all, setAll] = useState<{ total: number; groups: Group[] } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = cats.find((c) => c.id === cat);

  const loadCats = async () => { const d = await api<{ categories: Cat[]; total: number; uncategorized: number }>('GET', '/safety/categories').catch(() => null); if (d) { setCats(d.categories); setStats({ total: d.total, uncategorized: d.uncategorized }); } };
  useEffect(() => { void loadCats(); }, []);
  useEffect(() => { setRes(null); setAll(null); setErr(''); }, [cat]);
  useEffect(() => {
    if (tab !== 'all' || !cat) return;
    void api<{ total: number; groups: Group[] }>('GET', `/safety/category/${cat}/items`).then(setAll).catch(() => setErr(errText('generic')));
  }, [tab, cat]);

  async function ask(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { setRes(await api('POST', '/safety/ask', { q, categoryId: cat || null })); } catch (er) { setErr(errText(er instanceof ApiError ? er.code : 'generic')); }
    setBusy(false);
  }

  return (
    <>
      <h1 tabIndex={-1}>לוח בטיחות</h1>
      <p className="hint" role="note">התשובות הן ציטוטים מהחוקים, התקנות והתשובות שנטענו למערכת, עם סימוכין. הלוח אינו מנסח מחדש ואינו ייעוץ משפטי: יש לוודא תמיד מול הנוסח המחייב.</p>
      <div className="field" style={{ maxWidth: 360 }}>
        <label htmlFor="sf-cat">נושא</label>
        <select id="sf-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">כל הנושאים ({stats.total})</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}
        </select>
      </div>
      <div className="chips" role="group" aria-label="תצוגה">
        <button className="chip" aria-pressed={tab === 'ask'} onClick={() => setTab('ask')}>שאלה בטקסט חופשי</button>
        <button className="chip" aria-pressed={tab === 'all'} onClick={() => setTab('all')} disabled={!cat} title={cat ? '' : 'בחרו נושא'}>כל הסעיפים בנושא</button>
      </div>
      <p role="alert" className="error">{err}</p>

      {tab === 'ask' && (
        <>
          <form className="card" onSubmit={ask}>
            <div className="field">
              <label htmlFor="sf-q">שאלה{selected ? ` בנושא ${selected.name}` : ''}</label>
              <textarea id="sf-q" required minLength={2} maxLength={400} rows={2} value={q} onChange={(e) => setQ(e.target.value)} placeholder="למשל: באיזה גובה מותר לעבוד על סולם נייד?" />
            </div>
            <button className="primary" type="submit" disabled={busy}>{busy ? 'מחפש…' : 'חיפוש בתקנים'}</button>
          </form>
          {res && (
            <div role="status">
              <p>{res.total === 0 ? 'לא נמצאו סעיפים או תשובות מתאימים. נסו ניסוח אחר, או בחרו "כל הנושאים".' : `נמצאו ${res.total} תוצאות, מקובצות לפי מקור. התוצאות הראשונות הן המתאימות ביותר.`}</p>
              <Groups groups={res.groups} />
            </div>
          )}
        </>
      )}

      {tab === 'all' && cat && (
        <section aria-live="polite">
          {!all ? <p role="status">טוען…</p> : <><p>{all.total} רשומות בנושא {selected?.name}, לפי מקור וסימוכין.</p>{all.total === 0 && <p>עוד לא נטענו מקורות לנושא הזה.</p>}<Groups groups={all.groups} /></>}
        </section>
      )}

      {manage && <Manage cats={cats} onChanged={loadCats} stats={stats} />}
      {can(me, 'bot.view') && <Areas canEdit={can(me, 'bot.manage')} />}
    </>
  );
}

function Manage({ cats, onChanged, stats }: { cats: Cat[]; onChanged: () => Promise<void>; stats: { total: number; uncategorized: number } }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editId, setEditId] = useState('');
  const [kw, setKw] = useState('');
  const [audience, setAudience] = useState<'staff' | 'both' | 'bot'>('staff');
  const [busy, setBusy] = useState(false);
  const cur = cats.find((c) => c.id === editId);
  useEffect(() => { setKw(cur ? cur.keywords.join('\n') : ''); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function importXlsx(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMsg(null); setBusy(true);
    const f = (e.currentTarget.elements.namedItem('xlsx') as HTMLInputElement).files?.[0];
    if (!f) { setBusy(false); return; }
    const fd = new FormData(); fd.append('audience', audience); fd.append('file', f);
    try {
      const res = await fetch('/kb/import/xlsx', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = (await res.json().catch(() => ({}))) as { error?: string; kind?: string; created?: number; updated?: number; unchanged?: number; categorized?: number; uncategorized?: number };
      if (!res.ok) throw new ApiError(res.status, j.error ?? 'error');
      setMsg({ ok: true, text: `יובא (${j.kind === 'weekly' ? 'תשובת השבוע' : 'חוק ופקודה'}): ${j.created} חדשים, ${j.updated} עודכנו, ${j.unchanged} ללא שינוי. ${j.categorized} שויכו לנושאים, ${j.uncategorized} לא שויכו לאף נושא.` });
      await onChanged();
    } catch (er) { setMsg({ ok: false, text: er instanceof ApiError && er.code === 'unknown_workbook' ? 'מבנה הקובץ לא מוכר. נתמכים: קובץ מיון חוק ופקודה (גיליון "כל_הסעיפים") וקובץ "תשובת השבוע" (גיליון "כל התשובות").' : errText(er instanceof ApiError ? er.code : 'generic') }); }
    setBusy(false);
  }

  return (
    <details className="card" style={{ marginTop: '1.5rem' }}>
      <summary><strong>ניהול הלוח</strong> (ייבוא מקורות ועריכת מילות מפתח)</summary>
      <section aria-labelledby="sf-imp">
        <h3 id="sf-imp">ייבוא אקסל</h3>
        <p className="hint">מעלים קובץ מיון של חוק/פקודה, או קובץ "תשובת השבוע". ייבוא חוזר של קובץ מעודכן מעדכן שורות קיימות בלי כפילויות. ברירת המחדל: המידע מיועד לצוות בלבד ולא לבוט שעונה ללקוחות.</p>
        <form onSubmit={importXlsx}>
          <div className="field"><label htmlFor="sf-file">קובץ (xlsx)</label><input id="sf-file" name="xlsx" type="file" accept=".xlsx" required /></div>
          <div className="field"><label htmlFor="sf-aud">מי משתמש</label><select id="sf-aud" value={audience} onChange={(e) => setAudience(e.target.value as 'staff')}><option value="staff">צוות בלבד</option><option value="both">צוות ובוט</option></select></div>
          <button className="primary" type="submit" disabled={busy}>{busy ? 'מייבא…' : 'ייבוא'}</button>
        </form>
        <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
        <p className="hint">{stats.total} רשומות מיובאות, מהן {stats.uncategorized} שלא שייכות לאף נושא בלוח (כמו הגדרות וסמכויות פיקוח). הן עדיין ניתנות לחיפוש ב"כל הנושאים".</p>
      </section>
      <section aria-labelledby="sf-kw">
        <h3 id="sf-kw">מילות מפתח לנושא</h3>
        <p className="hint">רשומה משויכת לנושא אם כל המילים של אחת מהמילים או הביטויים מופיעות בטקסט שלה. אחרי עריכה, "החלה מחדש" מעדכנת את כל הרשומות.</p>
        <div className="field" style={{ maxWidth: 360 }}><label htmlFor="sf-edit">נושא לעריכה</label>
          <select id="sf-edit" value={editId} onChange={(e) => setEditId(e.target.value)}><option value="">בחרו נושא</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        {cur && (
          <form onSubmit={async (e) => { e.preventDefault(); setMsg(null); try { await api('PUT', `/safety/categories/${cur.id}`, { keywords: kw.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) }); setMsg({ ok: true, text: 'נשמר. לחצו "החלה מחדש" כדי לעדכן את השיוך.' }); await onChanged(); } catch (er) { setMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); } }}>
            <div className="field"><label htmlFor="sf-kw-t">מילים וביטויים (אחד בכל שורה)</label><textarea id="sf-kw-t" rows={6} value={kw} onChange={(e) => setKw(e.target.value)} /></div>
            <button className="primary" type="submit">שמירה</button>
          </form>
        )}
        <div className="row" style={{ marginTop: '.6rem' }}>
          <button type="button" onClick={async () => { setMsg(null); try { const r = await api<{ sources: number; categorized: number }>('POST', '/safety/categories/reapply'); setMsg({ ok: true, text: `עודכן: ${r.categorized} מתוך ${r.sources} רשומות שויכו לנושא.` }); await onChanged(); } catch (er) { setMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); } }}>החלה מחדש על כל הרשומות</button>
        </div>
      </section>
    </details>
  );
}

interface Area { id: string; name: string; keywords: string[]; userId: string; userName: string; userActive: boolean }

function Areas({ canEdit }: { canEdit: boolean }) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editId, setEditId] = useState<string | null>(null); // '' = new
  const [name, setName] = useState('');
  const [kw, setKw] = useState('');
  const [userId, setUserId] = useState('');
  const load = async () => {
    setAreas(await api<Area[]>('GET', '/safety/areas').catch(() => []));
    setUsers((await api<{ users: { id: string; name: string }[] }>('GET', '/flow/refs').catch(() => ({ users: [] }))).users);
  };
  useEffect(() => { void load(); }, []);
  const start = (a?: Area) => { setEditId(a?.id ?? ''); setName(a?.name ?? ''); setKw(a?.keywords.join('\n') ?? ''); setUserId(a?.userId ?? users[0]?.id ?? ''); setMsg(null); };
  async function importAreas(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMsg(null);
    const f = (e.currentTarget.elements.namedItem('areasxlsx') as HTMLInputElement).files?.[0];
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try {
      const res = await fetch('/safety/areas/import', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = (await res.json().catch(() => ({}))) as { error?: string; created?: number; updated?: number; skipped?: { row: number; reason: string }[] };
      if (!res.ok) throw new ApiError(res.status, j.error ?? 'error');
      const why: Record<string, string> = { unknown_officer: 'אימייל שאינו של משתמש פעיל', missing_fields: 'חסר שם, מילות זיהוי או אימייל', name_too_long: 'שם ארוך מדי' };
      const sk = j.skipped ?? [];
      setMsg({ ok: sk.length === 0, text: `יובא: ${j.created} חדשים, ${j.updated} עודכנו.${sk.length ? ` דולגו ${sk.length} שורות: ${sk.slice(0, 8).map((x) => `שורה ${x.row} (${why[x.reason] ?? x.reason})`).join(', ')}.` : ''}` });
      (e.target as HTMLFormElement).reset(); await load();
    } catch (er) { setMsg({ ok: false, text: er instanceof ApiError && er.code === 'unknown_workbook' ? 'מבנה הקובץ לא מוכר. הורידו את התבנית ומלאו אותה.' : errText(er instanceof ApiError ? er.code : 'generic') }); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    const body = { name: name.trim(), keywords: kw.split(/[\n,]/).map((x) => x.trim()).filter(Boolean), userId };
    try {
      if (editId) await api('PUT', `/safety/areas/${editId}`, body); else await api('POST', '/safety/areas', body);
      setEditId(null); setMsg({ ok: true, text: 'נשמר.' }); await load();
    } catch (er) { setMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); }
  }
  return (
    <details className="card" style={{ marginTop: '1rem' }}>
      <summary><strong>אזורי אחריות</strong> (איזה ממונה מטפל באיזה בניין או מקום)</summary>
      <p className="hint">בתרשים הבוט, פנייה עם מיקום (בניין, מעבדה, חדר) מועברת לממונה שאחראי על המקום. ההתאמה לפי מילים שלמות, בסדר הרשימה: הראשון שמתאים קובע. בלי התאמה, הפנייה עוברת לנציג ברירת המחדל של אותו צומת.</p>
      {areas.length === 0 ? <p className="empty">עוד לא הוגדרו אזורים.</p> : (
        <table>
          <caption className="sr-only">אזורי אחריות</caption>
          <thead><tr><th scope="col">אזור</th><th scope="col">מילות זיהוי</th><th scope="col">ממונה</th>{canEdit && <th scope="col">פעולות</th>}</tr></thead>
          <tbody>{areas.map((a) => (
            <tr key={a.id}><th scope="row">{a.name}</th><td>{a.keywords.join(', ')}</td><td>{a.userName}{!a.userActive && ' (לא פעיל)'}</td>
              {canEdit && <td><button type="button" onClick={() => start(a)}>עריכה<span className="sr-only"> {a.name}</span></button>{' '}
                <button type="button" className="danger" onClick={async () => { if (!confirm(`למחוק את האזור "${a.name}"?`)) return; await api('DELETE', `/safety/areas/${a.id}`).catch(() => null); await load(); }}>מחיקה<span className="sr-only"> {a.name}</span></button></td>}
            </tr>))}</tbody>
        </table>
      )}
      {canEdit && editId === null && <button type="button" onClick={() => start()}>הוספת אזור</button>}
      {canEdit && (
        <form onSubmit={importAreas} style={{ marginTop: '.75rem' }}>
          <h3>ייבוא מאקסל</h3>
          <p className="hint">שלוש עמודות: שם האזור, מילות זיהוי, אימייל הממונה. הממונים צריכים להיות כבר פתוחים כמשתמשים בעמוד "צוות" (הייבוא לא פותח חשבונות). שורה עם שם אזור שכבר קיים מעדכנת אותו. <a href="/safety/areas/template.xlsx" download>הורדת תבנית</a></p>
          <div className="field"><label htmlFor="ar-f">קובץ (xlsx)</label><input id="ar-f" name="areasxlsx" type="file" accept=".xlsx" required /></div>
          <button type="submit">ייבוא אזורים</button>
        </form>
      )}
      {canEdit && editId !== null && (
        <form onSubmit={submit}>
          <div className="field"><label htmlFor="ar-n">שם האזור</label><input id="ar-n" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor="ar-k">מילות זיהוי (אחת בכל שורה, למשל "בניין 12")</label><textarea id="ar-k" required rows={4} value={kw} onChange={(e) => setKw(e.target.value)} /></div>
          <div className="field"><label htmlFor="ar-u">ממונה אחראי</label><select id="ar-u" required value={userId} onChange={(e) => setUserId(e.target.value)}>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
          <div className="row"><button className="primary" type="submit">שמירה</button><button type="button" onClick={() => setEditId(null)}>ביטול</button></div>
        </form>
      )}
      <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
    </details>
  );
}
