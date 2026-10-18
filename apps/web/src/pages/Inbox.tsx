import { useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Conversation, type Me, type Message, type UserRow } from '../api';
import { usePoll } from '../hooks';
import { errText } from '../strings';

const fmt = (iso: string) => new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });

export function Inbox({ me }: { me: Me }) {
  const isManager = me.role !== 'agent';
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState<'open' | 'closed' | 'mine'>('open');
  const [selId, setSelId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [team, setTeam] = useState<UserRow[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const sel = convs.find((c) => c.id === selId) ?? null;

  usePoll(async () => {
    const q = filter === 'mine' ? 'mine=true&status=open' : `status=${filter}`;
    setConvs(await api<Conversation[]>('GET', `/conversations?${q}`).catch(() => []));
  }, 5000, [filter]);

  usePoll(async () => {
    if (isManager) setTeam(await api<UserRow[]>('GET', '/users').catch(() => []));
  }, 60000);

  usePoll(async () => {
    if (!selId) return setMsgs([]);
    try {
      const m = await api<Message[]>('GET', `/conversations/${selId}/messages?limit=100`);
      setMsgs((prev) => {
        if (prev.length !== m.length) requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
        return m;
      });
    } catch { setSelId(null); }
  }, 3000, [selId]);

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); } catch (e) { setErr(errText(e instanceof ApiError ? e.code : 'generic')); }
  };

  function open(c: Conversation) {
    setSelId(c.id);
    setErr('');
    if (c.unreadCount) void api('POST', `/conversations/${c.id}/read`).catch(() => undefined);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!selId || !text.trim() || sending) return;
    setSending(true);
    await act(async () => {
      await api('POST', `/conversations/${selId}/messages`, { text });
      setText('');
    });
    setSending(false);
  }

  const assignTo = (userId: string | null) => act(() => api('POST', `/conversations/${selId}/assign`, { userId }));

  return (
    <>
      <h1 tabIndex={-1}>שיחות</h1>
      <div className={`inbox${sel ? ' has-selection' : ''}`}>
        <section className="card list-pane" aria-label="רשימת שיחות">
          <div className="field">
            <label htmlFor="flt">סינון</label>
            <select id="flt" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="open">פתוחות</option>
              <option value="mine">שלי</option>
              <option value="closed">סגורות</option>
            </select>
          </div>
          {convs.length === 0 ? <p>אין שיחות להצגה.</p> : (
            <ul className="conv-list">
              {convs.map((c) => (
                <li key={c.id}>
                  <button aria-current={c.id === selId} onClick={() => open(c)}>
                    <span className="conv-name">
                      <span>{c.contactName ?? c.contactId.split(/[@:]/)[0]}</span>
                      {c.unreadCount > 0 && <span className="unread"><span className="sr-only">הודעות שלא נקראו: </span>{c.unreadCount}</span>}
                    </span>
                    <span className="conv-last">{c.lastMessage}</span>
                    <small>{c.channelLabel} · {c.assignedName ?? 'לא משויך'}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card chat-pane" aria-label="שיחה">
          {!sel ? <p>בחרו שיחה מהרשימה.</p> : (
            <>
              <div className="row" style={{ marginBottom: '.75rem' }}>
                <button className="back" onClick={() => setSelId(null)}>← חזרה לרשימה</button>
                <h2 style={{ margin: 0 }}>{sel.contactName ?? sel.contactId.split(/[@:]/)[0]}</h2>
                <span className="spacer" />
                {isManager ? (
                  <>
                    <label htmlFor="asg" className="sr-only">שיוך לנציג</label>
                    <select id="asg" style={{ width: 'auto' }} value={sel.assignedTo ?? ''} onChange={(e) => assignTo(e.target.value || null)}>
                      <option value="">לא משויך</option>
                      {team.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </>
                ) : sel.assignedTo === me.id ? (
                  <button onClick={() => assignTo(null)}>שחרור שיחה</button>
                ) : (
                  <button onClick={() => assignTo(me.id)}>קח שיחה</button>
                )}
                <button onClick={() => act(() => api('POST', `/conversations/${sel.id}/status`, { status: sel.status === 'open' ? 'closed' : 'open' }))}>
                  {sel.status === 'open' ? 'סגירת שיחה' : 'פתיחה מחדש'}
                </button>
              </div>

              <div className="messages" ref={logRef} role="log" aria-live="polite" aria-label="הודעות בשיחה" tabIndex={0}>
                {msgs.map((m) => (
                  <div key={m.id} className={`msg ${m.direction}`}>
                    {m.body}
                    <small>{m.direction === 'out' ? (m.senderName ?? 'צוות') : 'לקוח'} · {fmt(m.createdAt)}</small>
                  </div>
                ))}
              </div>

              <p role="alert" className="error">{err}</p>
              <form onSubmit={send}>
                <label htmlFor="reply">תשובה</label>
                <textarea id="reply" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(e); }} aria-describedby="reply-h" />
                <p id="reply-h" className="hint">Ctrl+Enter לשליחה.</p>
                <button className="primary" type="submit" disabled={sending || !text.trim()}>שליחה</button>
              </form>
            </>
          )}
        </section>
      </div>
    </>
  );
}
