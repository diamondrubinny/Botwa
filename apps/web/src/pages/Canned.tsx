import { useState, type FormEvent } from 'react';
import { api, ApiError, type Canned as CannedT } from '../api';
import { usePoll } from '../hooks';
import { errText } from '../strings';

export function CannedReplies() {
  const [list, setList] = useState<CannedT[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState('');
  const reload = async () => setList(await api<CannedT[]>('GET', '/canned-replies').catch(() => []));
  usePoll(reload, 30000);
  const run = async (fn: () => Promise<unknown>) => {
    setMsg('');
    try { await fn(); await reload(); } catch (e) { setMsg(errText(e instanceof ApiError ? e.code : 'generic')); }
  };
  async function add(e: FormEvent) {
    e.preventDefault();
    await run(() => api('POST', '/canned-replies', { title, body }));
    setTitle(''); setBody('');
  }
  return (
    <>
      <h1 tabIndex={-1}>תשובות מוכנות</h1>
      <p role="alert" className="error">{msg}</p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {list.map((c) => (
          <li key={c.id} className="card">
            <strong>{c.title}</strong>
            <p style={{ whiteSpace: 'pre-wrap' }}>{c.body}</p>
            <button className="danger" onClick={() => run(() => api('DELETE', `/canned-replies/${c.id}`))}>מחיקה<span className="sr-only"> {c.title}</span></button>
          </li>
        ))}
        {list.length === 0 && <li>אין תשובות מוכנות.</li>}
      </ul>
      <form className="card" onSubmit={add}>
        <h2>תשובה חדשה</h2>
        <div className="field"><label htmlFor="c-title">כותרת</label><input id="c-title" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="field"><label htmlFor="c-body">תוכן</label><textarea id="c-body" required rows={4} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} /></div>
        <button className="primary" type="submit">הוספה</button>
      </form>
    </>
  );
}
