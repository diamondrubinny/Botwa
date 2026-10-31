import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, upload, type RelatedConv, type Attachment, type Canned, type Tag, type Conversation, type Me, type Message, type Note, type UserRow } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePoll } from '../hooks';
import { blockedReason, errText } from '../strings';

const fmtSize = (n: number | null) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const SLA_WARN_MIN = 15;
function waitLabel(since: string | null): { text: string; late: boolean } | null {
  if (!since) return null;
  const min = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60000));
  const text = min < 1 ? 'ממתין עכשיו' : min < 60 ? `ממתין ${min} דק'` : `ממתין ${Math.floor(min / 60)} שע' ${min % 60} דק'`;
  return { text, late: min >= SLA_WARN_MIN };
}

function AttachmentView({ a }: { a: Attachment }) {
  const name = a.fileName ?? 'קובץ';
  if (a.status === 'pending') return <p className="hint" role="status">הקובץ "{name}" בסריקת אבטחה…</p>;
  if (a.status === 'infected') return <p className="error">הקובץ "{name}" נחסם: זוהתה בו תוכנה זדונית.</p>;
  if (a.status === 'blocked') return <p className="error">הקובץ "{name}" לא זמין: {blockedReason[a.detail ?? ''] ?? 'נחסם'}.</p>;
  if (a.kind === 'image') {
    return <a href={`/attachments/${a.id}`} target="_blank" rel="noopener noreferrer"><img src={`/attachments/${a.id}`} alt={`תמונה מצורפת: ${name}`} loading="lazy" style={{ maxWidth: '100%', maxHeight: 280, display: 'block' }} /></a>;
  }
  return <a href={`/attachments/${a.id}`} download={name}>הורדת קובץ: {name} ({fmtSize(a.size)})</a>;
}

const fmt = (iso: string) => new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });

export function Inbox({ me }: { me: Me }) {
  const isManager = me.role !== 'agent';
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState<'open' | 'closed' | 'mine'>('open');
  const [selId, setSelId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [team, setTeam] = useState<UserRow[]>([]);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteText, setNoteText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [canned, setCanned] = useState<Canned[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagFilter, setTagFilter] = useState('');
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [msgQuery, setMsgQuery] = useState('');
  const [related, setRelated] = useState<RelatedConv[]>([]);
  const [pinned, setPinned] = useState<Conversation | null>(null);
  const [live, setLive] = useState(0); // bumped by server events to refetch immediately
  const [announce, setAnnounce] = useState('');

  // Live updates: events carry no content, they only tell us to refetch via the normal API (polling remains as fallback).
  useEffect(() => {
    const es = new EventSource('/events');
    es.onmessage = () => { setLive((n) => n + 1); setAnnounce('התקבלה הודעה חדשה'); setTimeout(() => setAnnounce(''), 1500); };
    return () => es.close();
  }, []);

  // Unread count in the tab title so staff notice new work in other tabs.
  const unreadTotal = convs.reduce((n, c) => n + c.unreadCount, 0);
  useEffect(() => {
    const base = 'Botwa – מערכת תמיכה';
    document.title = unreadTotal > 0 ? `(${unreadTotal}) ${base}` : base;
    return () => { document.title = base; };
  }, [unreadTotal]);

  const sel = convs.find((c) => c.id === selId) ?? (pinned && pinned.id === selId ? pinned : null);

  usePoll(async () => {
    const q = (filter === 'mine' ? 'mine=true&status=open' : `status=${filter}`) + (search.trim() ? `&q=${encodeURIComponent(search.trim())}` : '') + (tagFilter ? `&tag=${tagFilter}` : '');
    setConvs(await api<Conversation[]>('GET', `/conversations?${q}`).catch(() => []));
  }, 5000, [filter, search, tagFilter, live]);

  usePoll(async () => setAllTags(await api<Tag[]>('GET', '/tags').catch(() => [])), 60000);

  usePoll(async () => setCanned(await api<Canned[]>('GET', '/canned-replies').catch(() => [])), 60000);

  usePoll(async () => {
    if (isManager) setTeam(await api<UserRow[]>('GET', '/users').catch(() => []));
  }, 60000);

  usePoll(async () => {
    if (!selId) return setMsgs([]);
    api<Note[]>('GET', `/conversations/${selId}/notes`).then(setNotes).catch(() => undefined);
    try {
      const m = await api<Message[]>('GET', `/conversations/${selId}/messages?limit=100${msgQuery.trim() ? `&q=${encodeURIComponent(msgQuery.trim())}` : ''}`);
      setMsgs((prev) => {
        if (prev.length !== m.length) requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
        return m;
      });
    } catch { setSelId(null); }
  }, 3000, [selId, live, msgQuery]);

  usePoll(async () => {
    if (!selId) return setRelated([]);
    setRelated(await api<RelatedConv[]>('GET', `/conversations/${selId}/related`).catch(() => []));
  }, 30000, [selId, live]);

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); } catch (e) { setErr(errText(e instanceof ApiError ? e.code : 'generic')); }
  };

  function open(c: Conversation) {
    setSelId(c.id);
    setMsgQuery('');
    setErr('');
    if (c.unreadCount) void api('POST', `/conversations/${c.id}/read`).catch(() => undefined);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!selId || (!text.trim() && !file) || sending) return;
    setSending(true);
    await act(async () => {
      if (file) {
        await upload(`/conversations/${selId}/attachments`, file, text);
        setFile(null);
        if (fileRef.current) fileRef.current.value = '';
      } else {
        await api('POST', `/conversations/${selId}/messages`, { text });
      }
      setText('');
    });
    setSending(false);
  }

  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!selId || !noteText.trim()) return;
    await act(async () => {
      await api('POST', `/conversations/${selId}/notes`, { body: noteText });
      setNoteText('');
      setNotes(await api<Note[]>('GET', `/conversations/${selId}/notes`));
    });
  }

  async function exportContact(c: Conversation) {
    await act(async () => {
      const data = await api('GET', `/contacts/${c.contactRowId}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = `contact-${c.contactRowId}.json`; a.click();
      URL.revokeObjectURL(url);
    });
  }

  async function openRelated(id: string) {
    const [c] = await api<Conversation[]>('GET', `/conversations?id=${id}&status=open`).catch(() => []);
    const [c2] = c ? [c] : await api<Conversation[]>('GET', `/conversations?id=${id}&status=closed`).catch(() => []);
    if (c2) { setPinned(c2); setSelId(c2.id); setMsgQuery(''); }
  }

  const assignTo = (userId: string | null) => act(() => api('POST', `/conversations/${selId}/assign`, { userId }));

  return (
    <>
      <h1 tabIndex={-1}>שיחות</h1>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      <div className={`inbox${sel ? ' has-selection' : ''}`}>
        <section className="card list-pane" aria-label="רשימת שיחות">
          <div className="field">
            <label htmlFor="srch">חיפוש</label>
            <input id="srch" type="search" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} aria-describedby="srch-h" />
            <p id="srch-h" className="hint">לפי שם, מספר או תוכן הודעה.</p>
          </div>
          <div className="field">
            <label htmlFor="flt">סינון</label>
            <select id="flt" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="open">פתוחות</option>
              <option value="mine">שלי</option>
              <option value="closed">סגורות</option>
            </select>
          </div>
          {allTags.length > 0 && (
            <div className="field">
              <label htmlFor="tgf">תגית</label>
              <select id="tgf" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                <option value="">כל התגיות</option>
                {allTags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
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
                    {c.botState === 'menu' && <small className="hint"> · 🤖 הבוט מטפל</small>}
                    {c.tags.length > 0 && <small className="hint"> · {c.tags.map((t) => t.name).join(', ')}</small>}
                    {(() => { const w = waitLabel(c.waitingSince); return w && <small className={w.late ? 'error' : 'hint'} style={{ display: 'block' }}>{w.late ? '⚠ ' : ''}{w.text}</small>; })()}
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

              <div className="row" style={{ marginBottom: '.5rem' }} aria-label="תגיות השיחה" role="group">
                {sel.tags.map((t) => (
                  <span key={t.id} className="badge" style={{ display: 'inline-flex', gap: '.35rem', alignItems: 'center' }}>
                    {t.name}
                    <button style={{ minHeight: 28, padding: '0 .4rem' }} aria-label={`הסרת התגית ${t.name}`}
                      onClick={() => act(async () => { await api('DELETE', `/conversations/${sel.id}/tags/${t.id}`); setLive((n) => n + 1); })}>✕</button>
                  </span>
                ))}
                {allTags.some((t) => !sel.tags.some((x) => x.id === t.id)) && (
                  <>
                    <label htmlFor="addtag" className="sr-only">הוספת תגית לשיחה</label>
                    <select id="addtag" style={{ width: 'auto' }} value="" onChange={(e) => {
                      const id = e.target.value;
                      if (id) void act(async () => { await api('POST', `/conversations/${sel.id}/tags`, { tagId: id }); setLive((n) => n + 1); });
                    }}>
                      <option value="">+ הוספת תגית</option>
                      {allTags.filter((t) => !sel.tags.some((x) => x.id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </>
                )}
              </div>
              <div className="field">
                <label htmlFor="msgq">חיפוש בשיחה</label>
                <input id="msgq" type="search" maxLength={100} value={msgQuery} onChange={(e) => setMsgQuery(e.target.value)} />
                {msgQuery.trim() && <p className="hint" role="status">מוצגות רק הודעות שמתאימות לחיפוש ({msgs.length}).</p>}
              </div>
              <div className="messages" ref={logRef} role="log" aria-live="polite" aria-label="הודעות בשיחה" tabIndex={0}>
                {msgs.map((m) => (
                  <div key={m.id} className={`msg ${m.direction}`}>
                    {m.attachment && <AttachmentView a={m.attachment} />}
                    {m.body}
                    <small>{m.direction === 'out' ? (m.auto ? 'בוט / מענה אוטומטי' : (m.senderName ?? 'צוות')) : 'לקוח'} · {fmt(m.createdAt)}</small>
                  </div>
                ))}
              </div>

              <p role="alert" className="error">{err}</p>
              <form onSubmit={send}>
                {canned.length > 0 && (
                  <div className="field">
                    <label htmlFor="canned">תשובה מוכנה</label>
                    <select id="canned" value="" onChange={(e) => {
                      const c = canned.find((x) => x.id === e.target.value);
                      if (c) setText((prev) => (prev ? `${prev}\n${c.body}` : c.body));
                    }}>
                      <option value="">בחרו להוספה לתשובה…</option>
                      {canned.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                    </select>
                  </div>
                )}
                <label htmlFor="reply">תשובה</label>
                <textarea id="reply" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(e); }} aria-describedby="reply-h" />
                <p id="reply-h" className="hint">Ctrl+Enter לשליחה. אם נבחר קובץ, הטקסט נשלח ככיתוב.</p>
                <div className="field">
                  <label htmlFor="attach">קובץ מצורף (אופציונלי)</label>
                  <input id="attach" ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,.docx,.xlsx,audio/*,video/mp4"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-describedby="attach-h" />
                  <p id="attach-h" className="hint">עד 16MB. הקובץ נסרק באנטי-וירוס לפני השליחה.</p>
                </div>
                <button className="primary" type="submit" disabled={sending || (!text.trim() && !file)}>{sending ? 'שולח…' : 'שליחה'}</button>
              </form>

              {related.length > 0 && (
                <section aria-labelledby="rel-h" style={{ marginTop: '1rem' }}>
                  <h3 id="rel-h" style={{ fontSize: '1rem' }}>שיחות נוספות של אותו לקוח (אותו מספר בערוצים אחרים)</h3>
                  <ul style={{ paddingInlineStart: '1.2rem' }}>
                    {related.map((r) => (
                      <li key={r.id}>
                        <button style={{ minHeight: 36 }} onClick={() => openRelated(r.id)}>{r.channelLabel}{r.contactName ? ` · ${r.contactName}` : ''}</button>{' '}
                        <small className="hint">{r.status === 'open' ? 'פתוחה' : 'סגורה'} · {r.lastMessage ?? ''}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {me.role === 'admin' && (
                <div className="row" style={{ marginTop: '1rem' }}>
                  <button onClick={() => exportContact(sel)}>ייצוא נתוני איש הקשר (JSON)</button>
                  <button className="danger" onClick={() => setEraseOpen(true)}>מחיקת איש הקשר וכל הנתונים</button>
                </div>
              )}
              <section aria-labelledby="notes-h" style={{ marginTop: '1rem' }}>
                <h3 id="notes-h" style={{ fontSize: '1rem' }}>הערות פנימיות (לא נשלחות ללקוח)</h3>
                {notes.length === 0 ? <p className="hint">אין הערות.</p> : (
                  <ul style={{ paddingInlineStart: '1.2rem' }}>
                    {notes.map((n) => <li key={n.id}>{n.body} <small className="hint">— {n.authorName ?? 'צוות'}, {fmt(n.createdAt)}</small></li>)}
                  </ul>
                )}
                <form onSubmit={addNote}>
                  <label htmlFor="note">הערה חדשה</label>
                  <textarea id="note" rows={2} maxLength={2000} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
                  <button type="submit" disabled={!noteText.trim()}>הוספת הערה</button>
                </form>
              </section>
            </>
          )}
        </section>
      </div>
      <ConfirmDialog open={eraseOpen} danger title="מחיקת איש קשר"
        message="איש הקשר, כל ההודעות, ההערות והקבצים שלו יימחקו לצמיתות מהמערכת (גיבויים קיימים יישארו עד תום מחזור הגיבוי). לא ניתן לשחזר."
        confirmLabel="מחיקה לצמיתות" onCancel={() => setEraseOpen(false)}
        onConfirm={() => {
          const c = sel; setEraseOpen(false);
          if (c) void act(async () => { await api('DELETE', `/contacts/${c.contactRowId}`); setSelId(null); });
        }} />
    </>
  );
}
