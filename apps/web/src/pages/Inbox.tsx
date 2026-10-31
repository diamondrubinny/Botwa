import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, can, upload, type Attachment, type Canned, type Conversation, type Me, type Message, type Note, type RelatedConv, type Tag, type UserRow } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { usePoll } from '../hooks';
import { useLive } from '../live';
import { blockedReason, errText } from '../strings';

const fmtSize = (n: number | null) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fmt = (iso: string) => new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
const shortTime = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
};
const nameOf = (c: Pick<Conversation, 'contactName' | 'contactId'>) => c.contactName ?? c.contactId.split(/[@:]/)[0]!;

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
    return <a href={`/attachments/${a.id}`} target="_blank" rel="noopener noreferrer"><img src={`/attachments/${a.id}`} alt={`תמונה מצורפת: ${name}`} loading="lazy" /></a>;
  }
  return <a href={`/attachments/${a.id}`} download={name}>הורדת קובץ: {name} ({fmtSize(a.size)})</a>;
}

export function Inbox({ me }: { me: Me }) {
  const isManager = can(me, 'inbox.view_all');
  const canAssignOthers = can(me, 'conversations.assign_others');
  const canBlock = can(me, 'contacts.block');
  const canPrivacy = can(me, 'privacy.manage');
  const { tick: live } = useLive();

  const [convs, setConvs] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState<'open' | 'closed' | 'mine' | 'blocked'>('open');
  const [blockPanel, setBlockPanel] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [team, setTeam] = useState<UserRow[]>([]);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteText, setNoteText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
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
  const [bump, setBump] = useState(0); // local refetch trigger after an action

  const sel = convs.find((c) => c.id === selId) ?? (pinned && pinned.id === selId ? pinned : null);
  // lets the shell hide floating widgets while a conversation fills the phone screen
  useEffect(() => { document.body.classList.toggle('chat-open', !!sel); return () => document.body.classList.remove('chat-open'); }, [sel]);

  usePoll(async () => {
    const q = (filter === 'mine' ? 'mine=true&status=open' : filter === 'blocked' ? 'blocked=true' : `status=${filter}`) + (search.trim() ? `&q=${encodeURIComponent(search.trim())}` : '') + (tagFilter ? `&tag=${tagFilter}` : '');
    setConvs(await api<Conversation[]>('GET', `/conversations?${q}`).catch(() => []));
  }, 5000, [filter, search, tagFilter, live, bump]);
  usePoll(async () => setAllTags(await api<Tag[]>('GET', '/tags').catch(() => [])), 60000);
  usePoll(async () => setCanned(await api<Canned[]>('GET', '/canned-replies').catch(() => [])), 60000);
  usePoll(async () => { if (canAssignOthers && can(me, 'users.view')) setTeam(await api<UserRow[]>('GET', '/users').catch(() => [])); }, 60000);

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
  }, 3000, [selId, live, msgQuery, bump]);

  usePoll(async () => {
    if (!selId) return setRelated([]);
    setRelated(await api<RelatedConv[]>('GET', `/conversations/${selId}/related`).catch(() => []));
  }, 30000, [selId, live]);

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); setBump((n) => n + 1); } catch (e) { setErr(errText(e instanceof ApiError ? e.code : 'generic')); }
  };

  function open(c: Conversation) {
    setSelId(c.id);
    setMsgQuery('');
    setErr('');
    setBlockPanel(false);
    if (c.unreadCount) void api('POST', `/conversations/${c.id}/read`).catch(() => undefined);
  }

  // Drafts live in sessionStorage (this tab only, gone when it closes) so switching chats never loses or leaks a half-written reply.
  const draftKey = (id: string | null) => `botwa_draft_${id}`;
  const readDraft = (id: string | null) => { try { return (id && sessionStorage.getItem(draftKey(id))) || ''; } catch { return ''; } };
  const saveDraft = (id: string | null, v: string) => { try { if (id) { if (v) sessionStorage.setItem(draftKey(id), v); else sessionStorage.removeItem(draftKey(id)); } } catch { /* storage unavailable */ } };
  useEffect(() => { setText(readDraft(selId)); }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (v: string) => { setText(v); saveDraft(selId, v); };

  const resize = () => { const t = taRef.current; if (t) { t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; } };
  useEffect(resize, [text]);
  const insertCanned = (c: Canned) => {
    const body = c.body.replace(/\{(שם|name)\}/g, sel?.contactName ?? '');
    edit(text.startsWith('/') ? body : text ? `${text}\n${body}` : body);
    taRef.current?.focus();
  };

  async function send(e?: FormEvent) {
    e?.preventDefault();
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
      edit('');
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
  const FILTERS: [typeof filter, string][] = [['open', 'פתוחות'], ['mine', 'שלי'], ['closed', 'סגורות'], ...(canBlock ? [['blocked', 'חסומים'] as [typeof filter, string]] : [])];

  return (
    <>
      <h1 tabIndex={-1} className="sr-only-mobile">שיחות</h1>
      <div className={`inbox${sel ? ' has-selection' : ''}`}>
        <section className="card list-pane" aria-label="רשימת שיחות">
          <div className="list-head">
            <div className="search-box">
              <label htmlFor="srch" className="sr-only">חיפוש לפי שם, מספר או תוכן הודעה</label>
              <Icon name="search" size={18} />
              <input id="srch" type="search" value={search} maxLength={100} placeholder="חיפוש לפי שם, מספר או תוכן" onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="chips" role="group" aria-label="סינון שיחות">
              {FILTERS.map(([k, label]) => <button key={k} className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>)}
            </div>
          </div>
          {allTags.length > 0 && (
            <div className="filters-more">
              <label htmlFor="tgf" className="sr-only">סינון לפי תגית</label>
              <select id="tgf" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                <option value="">כל התגיות</option>
                {allTags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {convs.length === 0 ? <p className="empty">אין שיחות להצגה.</p> : (
            <ul className="conv-list">
              {convs.map((c) => {
                const w = waitLabel(c.waitingSince);
                return (
                  <li key={c.id}>
                    <button className="conv-item" aria-current={c.id === selId} onClick={() => open(c)}>
                      <span className="avatar" aria-hidden="true">{nameOf(c).slice(0, 1)}</span>
                      <span className="conv-body">
                        <span className="conv-top"><span className="conv-name">{nameOf(c)}</span><span className="conv-time">{shortTime(c.lastMessageAt)}</span></span>
                        <span className="conv-top">
                          <span className="conv-last">{c.lastMessage}</span>
                          {c.unreadCount > 0 && <span className="unread"><span className="sr-only">הודעות שלא נקראו: </span>{c.unreadCount}</span>}
                        </span>
                        <span className="conv-meta">
                          <span>{c.channelLabel} · {c.assignedName ?? 'לא משויך'}</span>
                          {c.botState === 'menu' && <span>🤖 הבוט מטפל</span>}
                          {c.tags.length > 0 && <span>{c.tags.map((t) => t.name).join(', ')}</span>}
                          {w && <span className={w.late ? 'late' : ''}>{w.late ? '⚠ ' : ''}{w.text}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card chat-pane" aria-label="שיחה">
          {!sel ? <p className="empty">בחרו שיחה מהרשימה.</p> : (
            <>
              <div className="chat-head">
                <button className="icon-btn back" onClick={() => setSelId(null)} aria-label="חזרה לרשימה"><Icon name="back" /></button>
                <span className="avatar" aria-hidden="true">{nameOf(sel).slice(0, 1)}</span>
                <div style={{ minWidth: 0 }}>
                  <h2>{nameOf(sel)}</h2>
                  <small>{sel.channelLabel} · {sel.assignedName ?? 'לא משויך'}{sel.status === 'closed' ? ' · סגורה' : ''}</small>
                </div>
              </div>

              <div className="chat-tools">
                {canAssignOthers && team.length > 0 ? (
                  <>
                    <label htmlFor="asg" className="sr-only">שיוך לנציג</label>
                    <select id="asg" value={sel.assignedTo ?? ''} onChange={(e) => assignTo(e.target.value || null)}>
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

              {sel.blocked && (
                <p className="banner" role="status" style={{ margin: '.6rem .9rem 0' }}>
                  הלקוח חסום{sel.blockedReason ? ` (${sel.blockedReason})` : ''}. הודעות ממנו נשמרות בשקט ואינן מפעילות בוט, התראות או שיוך.
                  {canBlock && <> <button onClick={() => act(async () => { await api('POST', `/contacts/${sel.contactRowId}/unblock`); })}>ביטול חסימה</button></>}
                </p>
              )}
              {sel.optedOut && (
                <p className="banner" role="status" style={{ margin: '.6rem .9rem 0' }}>
                  הלקוח ביקש להפסיק לקבל הודעות. לא יישלחו אליו הודעות עד שיכתוב שוב.
                  {canBlock && <> <button onClick={() => act(async () => { await api('POST', `/contacts/${sel.contactRowId}/opt-in`); })}>החזרת הסכמה</button></>}
                </p>
              )}

              <details className="more">
                <summary>פרטים, תגיות והערות</summary>
                <div className="more-body">
                  <div className="row" aria-label="תגיות השיחה" role="group">
                    {sel.tags.map((t) => (
                      <span key={t.id} className="badge" style={{ display: 'inline-flex', gap: '.35rem', alignItems: 'center' }}>
                        {t.name}
                        <button style={{ minHeight: 28, padding: '0 .4rem' }} aria-label={`הסרת התגית ${t.name}`} onClick={() => act(async () => { await api('DELETE', `/conversations/${sel.id}/tags/${t.id}`); })}>✕</button>
                      </span>
                    ))}
                    {allTags.some((t) => !sel.tags.some((x) => x.id === t.id)) && (
                      <>
                        <label htmlFor="addtag" className="sr-only">הוספת תגית לשיחה</label>
                        <select id="addtag" style={{ width: 'auto' }} value="" onChange={(e) => {
                          const id = e.target.value;
                          if (id) void act(async () => { await api('POST', `/conversations/${sel.id}/tags`, { tagId: id }); });
                        }}>
                          <option value="">+ הוספת תגית</option>
                          {allTags.filter((t) => !sel.tags.some((x) => x.id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </>
                    )}
                  </div>

                  <div>
                    <label htmlFor="msgq">חיפוש בשיחה</label>
                    <input id="msgq" type="search" maxLength={100} value={msgQuery} onChange={(e) => setMsgQuery(e.target.value)} />
                    {msgQuery.trim() && <p className="hint" role="status">מוצגות רק הודעות שמתאימות לחיפוש ({msgs.length}).</p>}
                  </div>

                  <section aria-labelledby="notes-h">
                    <h3 id="notes-h">הערות פנימיות (לא נשלחות ללקוח)</h3>
                    {notes.length === 0 ? <p className="hint">אין הערות.</p> : (
                      <ul style={{ paddingInlineStart: '1.2rem' }}>
                        {notes.map((n) => <li key={n.id}>{n.body} <small className="hint">— {n.authorName ?? 'צוות'}, {fmt(n.createdAt)}</small></li>)}
                      </ul>
                    )}
                    <form onSubmit={addNote}>
                      <label htmlFor="note">הערה חדשה</label>
                      <textarea id="note" rows={2} maxLength={2000} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
                      <button type="submit" disabled={!noteText.trim()} style={{ marginTop: '.4rem' }}>הוספת הערה</button>
                    </form>
                  </section>

                  {related.length > 0 && (
                    <section aria-labelledby="rel-h">
                      <h3 id="rel-h">שיחות נוספות של אותו לקוח (אותו מספר בערוצים אחרים)</h3>
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

                  {(canBlock || canPrivacy) && (
                    <div className="row">
                      {canBlock && !sel.blocked && <button className="danger" onClick={() => setBlockPanel(!blockPanel)} aria-expanded={blockPanel}>חסימת לקוח</button>}
                      {canPrivacy && <button onClick={() => exportContact(sel)}>ייצוא נתוני איש הקשר (JSON)</button>}
                      {canPrivacy && <button className="danger" onClick={() => setEraseOpen(true)}>מחיקת איש הקשר וכל הנתונים</button>}
                    </div>
                  )}
                  {canBlock && !sel.blocked && blockPanel && (
                    <form className="card" style={{ margin: 0 }} onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => { await api('POST', `/contacts/${sel.contactRowId}/block`, { reason: blockReason }); setBlockPanel(false); setBlockReason(''); });
                    }}>
                      <p className="hint">השיחה תיסגר ותוסתר. הודעות חדשות ממנו יישמרו בשקט (כראיה) בלי לעורר בוט, התראה או שיוך. אפשר לבטל בכל עת.</p>
                      <div className="field"><label htmlFor="blk-r">סיבה (אופציונלי)</label><input id="blk-r" maxLength={200} value={blockReason} onChange={(e) => setBlockReason(e.target.value)} /></div>
                      <button className="danger" type="submit">אישור חסימה</button>
                    </form>
                  )}
                </div>
              </details>

              <div className="messages" ref={logRef} role="log" aria-live="polite" aria-label="הודעות בשיחה" tabIndex={0}>
                {msgs.map((m) => (
                  <div key={m.id} className={`msg ${m.direction}${m.auto ? ' auto' : ''}`}>
                    {m.attachment && <AttachmentView a={m.attachment} />}
                    {m.body}
                    <small>{m.direction === 'out' ? (m.auto ? 'בוט / מענה אוטומטי' : (m.senderName ?? 'צוות')) : 'לקוח'} · {fmt(m.createdAt)}</small>
                  </div>
                ))}
              </div>

              <form className="composer" onSubmit={send}>
                {text.startsWith('/') && !text.includes('\n') && (
                  <div className="slash" role="listbox" aria-label="תשובות מוכנות מתאימות">
                    {canned.filter((c) => c.title.toLowerCase().includes(text.slice(1).trim().toLowerCase())).slice(0, 5).map((c) => (
                      <button type="button" role="option" aria-selected="false" key={c.id} onClick={() => insertCanned(c)}>/ {c.title}</button>
                    ))}
                  </div>
                )}
                <p role="alert" className="error" style={{ margin: 0 }}>{err}</p>
                {canned.length > 0 && (
                  <div className="composer-tools">
                    <div className="quick" aria-label="תשובות מהירות" role="group">
                      {canned.slice(0, 4).map((c) => <button type="button" key={c.id} onClick={() => insertCanned(c)}>{c.title}</button>)}
                    </div>
                    <label htmlFor="canned" className="sr-only">תשובה מוכנה</label>
                    <select id="canned" value="" onChange={(e) => { const c = canned.find((x) => x.id === e.target.value); if (c) insertCanned(c); }} style={{ marginTop: '.4rem' }}>
                      <option value="">כל התשובות המוכנות…</option>
                      {canned.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                    </select>
                  </div>
                )}
                {file && <p className="picked-file"><Icon name="clip" size={16} />{file.name} <button type="button" style={{ minHeight: 32 }} onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}>הסרה</button></p>}
                <div className="composer-row">
                  <button type="button" className="attach" onClick={() => fileRef.current?.click()} aria-label="צירוף קובץ"><Icon name="clip" /></button>
                  <input id="attach" ref={fileRef} type="file" tabIndex={-1} aria-hidden="true" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,.docx,.xlsx,audio/*,video/mp4" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  <label htmlFor="reply" className="sr-only">תשובה</label>
                  <textarea id="reply" ref={taRef} rows={1} maxLength={4000} value={text} placeholder="כתבו תשובה… (/ לתשובות מוכנות)" onChange={(e) => edit(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }} />
                  <button className="primary send" type="submit" disabled={sending || !!sel.blocked || !!sel.optedOut || (!text.trim() && !file)}><Icon name="send" /><span className="sr-only">שליחה</span></button>
                </div>
              </form>
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
