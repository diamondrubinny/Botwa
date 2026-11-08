import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, can, type Me } from '../api';
import { errText } from '../strings';

interface Cat { id: string; name: string; keywords: string[]; count: number; origin?: string }
interface TabReport { name: string; rows: number; added: number; duplicates: number; skipped: number }
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
          {cats.some((c) => c.origin === 'workbook') ? (
            <>
              <optgroup label="נושאי הלוח">{cats.filter((c) => c.origin !== 'workbook').map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}</optgroup>
              <optgroup label="קטגוריות מהקבצים שיובאו">{cats.filter((c) => c.origin === 'workbook').map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}</optgroup>
            </>
          ) : cats.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}
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
      {can(me, 'bot.view') && <Officers canEdit={can(me, 'bot.manage')} />}
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
  const [tabs, setTabs] = useState<TabReport[]>([]);
  const cur = cats.find((c) => c.id === editId);
  useEffect(() => { setKw(cur ? cur.keywords.join('\n') : ''); }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function importXlsx(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMsg(null); setBusy(true);
    const f = (e.currentTarget.elements.namedItem('xlsx') as HTMLInputElement).files?.[0];
    if (!f) { setBusy(false); return; }
    const fd = new FormData(); fd.append('audience', audience); fd.append('file', f);
    try {
      const res = await fetch('/kb/import/xlsx', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = (await res.json().catch(() => ({}))) as { error?: string; kind?: string; created?: number; updated?: number; unchanged?: number; categorized?: number; uncategorized?: number; sheets?: TabReport[]; categories?: string[] };
      if (!res.ok) throw new ApiError(res.status, j.error ?? 'error');
      setMsg({ ok: true, text: `יובא (${j.kind === 'weekly' ? 'תשובת השבוע' : 'חוק ופקודה'}): ${j.created} חדשים, ${j.updated} עודכנו, ${j.unchanged} ללא שינוי. ${j.categorized} שויכו לנושאים, ${j.uncategorized} לא שויכו לאף נושא.` });
      setTabs(j.sheets ?? []);
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
        {tabs.length > 0 && (
          <details>
            <summary>מה נקרא בכל לשונית ({tabs.length} לשוניות, {tabs.reduce((n, t) => n + t.rows, 0)} שורות)</summary>
            <table>
              <caption className="sr-only">דוח קריאה לפי לשונית</caption>
              <thead><tr><th scope="col">לשונית</th><th scope="col">שורות</th><th scope="col">נוספו</th><th scope="col">כבר נקראו בלשונית אחרת</th><th scope="col">דולגו (חסר מזהה או שאלה)</th></tr></thead>
              <tbody>{tabs.map((t) => <tr key={t.name}><th scope="row">{t.name}</th><td>{t.rows}</td><td>{t.added}</td><td>{t.duplicates}</td><td>{t.skipped}</td></tr>)}</tbody>
            </table>
            <p className="hint">כל לשונית שיש בה עמודות של סעיפים או של שאלות נקראת. שורה שמופיעה גם בלשונית הראשית וגם בלשונית נושא נשמרת פעם אחת, ושורה שיש רק בלשונית נושא נשמרת. הקטגוריה לכל שורה היא זו שבקובץ (עמודת הקטגוריה, ואם אין, שם הלשונית).</p>
          </details>
        )}
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

interface OfficerRow { id: string; name: string; email: string | null; phone: string | null; userId: string | null; userName: string | null; userActive: boolean; notes: string; active: boolean; topics: string[] }

function Officers({ canEdit }: { canEdit: boolean }) {
  const [list, setList] = useState<OfficerRow[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);   // '' = new
  const [f, setF] = useState({ name: '', email: '', phone: '', userId: '', topics: '', notes: '', active: true });
  const load = async () => {
    setList(await api<OfficerRow[]>('GET', '/safety/officers').catch(() => []));
    setUsers((await api<{ users: { id: string; name: string }[] }>('GET', '/flow/refs').catch(() => ({ users: [] }))).users);
    setTopics(await api<string[]>('GET', '/safety/officer-topics').catch(() => []));
  };
  useEffect(() => { void load(); }, []);
  const start = (o?: OfficerRow) => { setEditId(o?.id ?? ''); setF({ name: o?.name ?? '', email: o?.email ?? '', phone: o?.phone ?? '', userId: o?.userId ?? '', topics: o?.topics.join('\n') ?? '', notes: o?.notes ?? '', active: o?.active ?? true }); setMsg(null); };
  const addTopic = (t: string) => setF((x) => (x.topics.split('\n').map((v) => v.trim()).includes(t) ? x : { ...x, topics: x.topics.trim() ? `${x.topics.trim()}\n${t}` : t }));
  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    const body = { name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim(), userId: f.userId || null, topics: f.topics.split(/[\n,;]/).map((x) => x.trim()).filter(Boolean), notes: f.notes.trim(), active: f.active };
    try {
      if (editId) await api('PUT', `/safety/officers/${editId}`, body); else await api('POST', '/safety/officers', body);
      setEditId(null); setMsg({ ok: true, text: 'נשמר.' }); await load();
    } catch (er) { setMsg({ ok: false, text: er instanceof ApiError && er.code === 'bad_phone' ? 'מספר הווצאפ אינו תקין.' : errText(er instanceof ApiError ? er.code : 'generic') }); }
  }
  async function importOfficers(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMsg(null);
    const file = (e.currentTarget.elements.namedItem('offxlsx') as HTMLInputElement).files?.[0];
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    try {
      const res = await fetch('/safety/officers/import', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = (await res.json().catch(() => ({}))) as { error?: string; created?: number; updated?: number; unlinked?: number; skipped?: { row: number; reason: string }[] };
      if (!res.ok) throw new ApiError(res.status, j.error ?? 'error');
      const why: Record<string, string> = { missing_name: 'חסר שם', bad_phone: 'מספר ווצאפ לא תקין', bad_email: 'אימייל לא תקין' };
      const sk = j.skipped ?? [];
      setMsg({ ok: sk.length === 0 && !j.unlinked, text: `יובא: ${j.created} חדשים, ${j.updated} עודכנו.${j.unlinked ? ` ל-${j.unlinked} לא נמצא חשבון פעיל לפי האימייל שצוין, והם נשמרו בלי חשבון.` : ''}${sk.length ? ` דולגו ${sk.length} שורות: ${sk.slice(0, 8).map((x) => `שורה ${x.row} (${why[x.reason] ?? x.reason})`).join(', ')}.` : ''}` });
      (e.target as HTMLFormElement).reset(); await load();
    } catch (er) { setMsg({ ok: false, text: er instanceof ApiError && er.code === 'unknown_workbook' ? 'מבנה הקובץ לא מוכר. הורידו את התבנית ומלאו אותה.' : errText(er instanceof ApiError ? er.code : 'generic') }); }
  }
  return (
    <details className="card" style={{ marginTop: '1rem' }}>
      <summary><strong>ממונים ונושאים</strong> (שמות, אימיילים וווצאפ של הממונים, והנושאים שהם אחראים עליהם)</summary>
      <p className="hint">כאן מגדירים מי הממונה על כל נושא. בתרשים הבוט, בצומת "העברה לנציג", בוחרים "ממונה בתחום" והשיחה עוברת לממונה של אותו נושא. אם יש לו חשבון במערכת השיחה משויכת אליו; אם אין, הנציג שנבחר בצומת מקבל אותה, ובהערה הפנימית מופיעים הפרטים ליצירת קשר. אפשר גם להציג ללקוח את הווצאפ והאימייל של הממונה. שיוך לפי מקום (אזורי אחריות) גובר על שיוך לפי נושא.</p>
      {list.length === 0 ? <p className="empty">עוד לא הוגדרו ממונים.</p> : (
        <table>
          <caption className="sr-only">ממונים ונושאים</caption>
          <thead><tr><th scope="col">שם</th><th scope="col">אימייל</th><th scope="col">ווצאפ</th><th scope="col">חשבון במערכת</th><th scope="col">נושאים</th>{canEdit && <th scope="col">פעולות</th>}</tr></thead>
          <tbody>{list.map((o) => (
            <tr key={o.id}>
              <th scope="row">{o.name}{!o.active && <span className="badge stopped">לא פעיל</span>}</th>
              <td dir="ltr">{o.email ?? ''}</td>
              <td dir="ltr">{o.phone ? <a href={`https://wa.me/${o.phone}`} target="_blank" rel="noopener noreferrer">{o.phone}<span className="sr-only"> (נפתח בלשונית חדשה)</span></a> : ''}</td>
              <td>{o.userId ? `${o.userName ?? ''}${o.userActive ? '' : ' (לא פעיל)'}` : 'אין'}</td>
              <td>{o.topics.join(', ')}</td>
              {canEdit && <td><div className="row"><button type="button" onClick={() => start(o)}>עריכה<span className="sr-only"> {o.name}</span></button>
                <button type="button" className="danger" onClick={async () => { if (!confirm(`למחוק את הממונה "${o.name}"?`)) return; await api('DELETE', `/safety/officers/${o.id}`).catch(() => null); await load(); }}>מחיקה<span className="sr-only"> {o.name}</span></button></div></td>}
            </tr>))}</tbody>
        </table>
      )}
      {canEdit && editId === null && <button type="button" onClick={() => start()}>הוספת ממונה</button>}
      {canEdit && editId !== null && (
        <form onSubmit={submit}>
          <div className="field"><label htmlFor="of-n">שם</label><input id="of-n" required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="row">
            <div className="field"><label htmlFor="of-e">אימייל</label><input id="of-e" type="email" dir="ltr" maxLength={254} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
            <div className="field"><label htmlFor="of-p">ווצאפ</label><input id="of-p" dir="ltr" inputMode="tel" maxLength={30} placeholder="050-123-4567" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="of-u">חשבון במערכת (אופציונלי: השיחות ישויכו אליו)</label>
            <select id="of-u" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}><option value="">אין חשבון</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
          <div className="field"><label htmlFor="of-t">נושאים (אחד בכל שורה)</label>
            <textarea id="of-t" required rows={4} value={f.topics} onChange={(e) => setF({ ...f, topics: e.target.value })} aria-describedby="of-t-h" />
            <p id="of-t-h" className="hint">אפשר להקליד נושא חדש, או ללחוץ על אחד מהמוכרים כדי להוסיף אותו:</p>
            <div className="chips" role="group" aria-label="נושאים מוכרים">{topics.slice(0, 40).map((t) => <button type="button" key={t} className="chip" onClick={() => addTopic(t)}>{t}</button>)}</div></div>
          <div className="field"><label htmlFor="of-no">הערות (פנימי)</label><input id="of-no" maxLength={300} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> פעיל (ממונה לא פעיל לא מקבל שיחות ולא מוצג ללקוחות)</label></div>
          <div className="row"><button className="primary" type="submit">שמירה</button><button type="button" onClick={() => setEditId(null)}>ביטול</button></div>
        </form>
      )}
      {canEdit && (
        <form onSubmit={importOfficers} style={{ marginTop: '.75rem' }}>
          <h3>ייבוא מאקסל</h3>
          <p className="hint">עמודות: שם, אימייל, ווצאפ, נושאים (אחד בכל שורה או מופרדים בפסיק), אימייל החשבון במערכת (אם יש), הערות. שורה עם אימייל שכבר קיים מעדכנת את הממונה. <a href="/safety/officers/template.xlsx" download>הורדת תבנית</a></p>
          <div className="field"><label htmlFor="of-f">קובץ (xlsx)</label><input id="of-f" name="offxlsx" type="file" accept=".xlsx" required /></div>
          <button type="submit">ייבוא ממונים</button>
        </form>
      )}
      <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
    </details>
  );
}
