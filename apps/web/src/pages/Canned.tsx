import { EmptyState } from '../components/Illustration';
import { useState, type FormEvent } from 'react';
import { api, ApiError, can, type Canned as CannedT, type CannedVar, type Me, type Tag } from '../api';
import { usePoll } from '../hooks';
import { errText } from '../strings';

export function CannedReplies({ me }: { me: Me }) {
  const canCanned = can(me, 'canned.manage');
  const canTags = can(me, 'tags.manage');
  const [list, setList] = useState<CannedT[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [folder, setFolder] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [vars, setVars] = useState<CannedVar[]>([]);
  const [msg, setMsg] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagName, setTagName] = useState('');
  const reload = async () => setList(await api<CannedT[]>('GET', '/canned-replies').catch(() => []));
  const reloadTags = async () => setTags(await api<Tag[]>('GET', '/tags').catch(() => []));
  usePoll(async () => { await reload(); await reloadTags(); if (vars.length === 0) setVars(await api<CannedVar[]>('GET', '/canned-replies/variables').catch(() => [])); }, 30000);
  const folders = [...new Set(list.map((c) => c.folder).filter(Boolean))];
  const shown = list.filter((c) => `${c.title} ${c.folder} ${c.body}`.toLowerCase().includes(q.trim().toLowerCase()));
  const startEdit = (c: CannedT) => { setEditId(c.id); setTitle(c.title); setBody(c.body); setFolder(c.folder); document.getElementById('c-title')?.focus(); };
  const cancelEdit = () => { setEditId(null); setTitle(''); setBody(''); setFolder(''); };
  const run = async (fn: () => Promise<unknown>) => {
    setMsg('');
    try { await fn(); await reload(); } catch (e) { setMsg(errText(e instanceof ApiError ? e.code : 'generic')); }
  };
  async function add(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await api<{ unknownVariables?: string[] }>(editId ? 'PUT' : 'POST', editId ? `/canned-replies/${editId}` : '/canned-replies', { title, body, folder });
      if (r?.unknownVariables?.length) setMsg(`שימו לב: משתנים לא מוכרים יישלחו כפי שהם: ${r.unknownVariables.map((v) => `{${v}}`).join(' ')}`);
    });
    cancelEdit();
  }
  return (
    <>
      <h1 tabIndex={-1}>תשובות מוכנות ותגיות</h1>
      <p role="alert" className="error">{msg}</p>
      {canTags && <section className="card" aria-labelledby="tags-h">
        <h2 id="tags-h">תגיות לשיחות</h2>
        <ul className="row" style={{ listStyle: 'none', padding: 0 }}>
          {tags.map((t) => (
            <li key={t.id} className="badge" style={{ display: 'inline-flex', gap: '.4rem', alignItems: 'center' }}>
              {t.name}
              <button style={{ minHeight: 32, padding: '0 .5rem' }} aria-label={`מחיקת התגית ${t.name}`}
                onClick={() => run(async () => { await api('DELETE', `/tags/${t.id}`); await reloadTags(); })}>✕</button>
            </li>
          ))}
          {tags.length === 0 && <li>אין תגיות.</li>}
        </ul>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); await run(async () => { await api('POST', '/tags', { name: tagName }); setTagName(''); await reloadTags(); }); }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="tag-name" className="sr-only">שם תגית חדשה</label>
            <input id="tag-name" required maxLength={40} placeholder="שם תגית חדשה" value={tagName} onChange={(e) => setTagName(e.target.value)} />
          </div>
          <button className="primary" type="submit">הוספת תגית</button>
        </form>
      </section>}
      {canCanned && <><h2>תשובות מוכנות</h2>
      <div className="field"><label htmlFor="c-search">חיפוש בתשובות מוכנות</label><input id="c-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {shown.map((c) => (
          <li key={c.id} className="card">
            <strong>{c.title}</strong>{c.folder && <span className="badge" style={{ marginInlineStart: '.5rem' }}>{c.folder}</span>}
            <p style={{ whiteSpace: 'pre-wrap' }}>{c.body}</p>
            <div className="row">
              <button onClick={() => startEdit(c)}>עריכה<span className="sr-only"> {c.title}</span></button>
              <button className="danger" onClick={() => { if (window.confirm(`למחוק את "${c.title}"?`)) void run(() => api('DELETE', `/canned-replies/${c.id}`)); }}>מחיקה<span className="sr-only"> {c.title}</span></button>
            </div>
          </li>
        ))}
        {shown.length === 0 && <li>{list.length === 0
          ? <EmptyState art="canned" title="אין תשובות מוכנות">תשובה שכותבים פעם אחת ושולחים בלחיצה (או בהקלדת / בשיחה).</EmptyState>
          : <EmptyState art="search" title="לא נמצאו תשובות" size={150}>נסו מילה אחרת.</EmptyState>}</li>}
      </ul>
      <form className="card" onSubmit={add}>
        <h2>{editId ? 'עריכת תשובה' : 'תשובה חדשה'}</h2>
        <div className="field"><label htmlFor="c-folder">תיקייה (אופציונלי)</label><input id="c-folder" list="c-folders" maxLength={40} value={folder} onChange={(e) => setFolder(e.target.value)} /><datalist id="c-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist></div>
        <div className="field"><label htmlFor="c-title">כותרת</label><input id="c-title" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="field"><label htmlFor="c-body">תוכן</label><textarea id="c-body" required rows={4} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} /></div>
        {vars.length > 0 && <details><summary>משתנים זמינים</summary><ul>{vars.map((v) => <li key={v.name}><code dir="ltr">{v.name}</code> — {v.meaning}</li>)}</ul></details>}
        <div className="row"><button className="primary" type="submit">{editId ? 'שמירה' : 'הוספה'}</button>{editId && <button type="button" onClick={cancelEdit}>ביטול</button>}</div>
      </form>
      </>}
    </>
  );
}
