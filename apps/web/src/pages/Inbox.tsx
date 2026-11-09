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
const schedErr: Record<string, string> = { contact_blocked: 'הלקוח חסום', contact_opted_out: 'הלקוח ביקש להפסיק', outside_reply_window: 'חלון המענה נסגר', expired_channel_not_connected: 'הערוץ היה מנותק', send_failed: 'השליחה נכשלה' };
function waitLabel(since: string | null, sla: { enabled: boolean; targetMinutes: number } | null): { text: string; late: boolean } | null {
  if (!since) return null;
  const min = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60000));
  const text = min < 1 ? 'ממתין עכשיו' : min < 60 ? `ממתין ${min} דק'` : `ממתין ${Math.floor(min / 60)} שע' ${min % 60} דק'`;
  const target = sla?.enabled ? sla.targetMinutes : SLA_WARN_MIN;
  return { text: sla?.enabled && min >= target ? `${text} · חריגה מיעד השירות` : text, late: min >= target };
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
  const [filter, setFilter] = useState<'open' | 'closed' | 'mine' | 'starred' | 'snoozed' | 'blocked'>('open');
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
  const [sla, setSla] = useState<{ enabled: boolean; targetMinutes: number } | null>(null);
  usePoll(async () => setSla(await api<{ enabled: boolean; targetMinutes: number }>('GET', '/settings/sla').catch(() => null)), 120000);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagFilter, setTagFilter] = useState('');
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [msgQuery, setMsgQuery] = useState('');
  const [related, setRelated] = useState<RelatedConv[]>([]);
  const [pinned, setPinned] = useState<Conversation | null>(null);
  const [sugg, setSugg] = useState<{ sourceId: string; title: string; url: string | null; score: number; text: string }[]>([]);
  const [safety, setSafety] = useState<{ topics: string[]; hits: { topic: string; sourceId: string; title: string; reference: string | null; url: string | null; excerpt: string; instrument: string }[] }>({ topics: [], hits: [] });
  const [bump, setBump] = useState(0); // local refetch trigger after an action
  const [targets, setTargets] = useState<{ id: string; name: string; groupName: string }[]>([]);
  const [fwd, setFwd] = useState<{ rule: string; note: string; msg: string } | null>(null);
  const [tpls, setTpls] = useState<{ name: string; language: string; body: string; params: number; category: string }[]>([]);
  const [tp, setTp] = useState<{ key: string; values: string[]; msg: string } | null>(null);
  // list preferences, kept in this browser: sort order, channel, and "only unread / only waiting for an answer"
  const [lp, setLp] = useState<{ sort: 'recent' | 'waiting' | 'unread'; channel: string; unreadOnly: boolean; waitingOnly: boolean }>(() => {
    try { const v = JSON.parse(localStorage.getItem('botwa_inbox_prefs') ?? '{}') as Partial<{ sort: string; channel: string; unreadOnly: boolean; waitingOnly: boolean }>; return { sort: v.sort === 'waiting' || v.sort === 'unread' ? v.sort : 'recent', channel: v.channel ?? '', unreadOnly: !!v.unreadOnly, waitingOnly: !!v.waitingOnly }; } catch { return { sort: 'recent', channel: '', unreadOnly: false, waitingOnly: false }; }
  });
  const setPref = (p: Partial<typeof lp>) => setLp((x) => { const n = { ...x, ...p }; try { localStorage.setItem('botwa_inbox_prefs', JSON.stringify(n)); } catch { /* storage unavailable */ } return n; });

  const channels = [...new Set(convs.map((c) => c.channelLabel))];
  const view = convs
    .filter((c) => (!lp.channel || c.channelLabel === lp.channel) && (!lp.unreadOnly || c.unreadCount > 0) && (!lp.waitingOnly || !!c.waitingSince))
    .sort((a, b) => lp.sort === 'waiting' ? (a.waitingSince ? new Date(a.waitingSince).getTime() : Infinity) - (b.waitingSince ? new Date(b.waitingSince).getTime() : Infinity)
      : lp.sort === 'unread' ? (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0) || new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
      : 0);
  const advActive = lp.sort !== 'recent' || !!lp.channel || lp.unreadOnly || lp.waitingOnly;
  // approved message templates, for the official WhatsApp channel (the way to write to someone after the 24-hour window)
  useEffect(() => {
    setTpls([]); setTp(null);
    const c = convs.find((x) => x.id === selId) ?? (pinned && pinned.id === selId ? pinned : null);
    if (!selId || c?.channelType !== 'whatsapp_cloud') return;
    let live = true;
    void api<typeof tpls>('GET', `/conversations/${selId}/templates`).then((d) => { if (live) setTpls(d); }).catch(() => undefined);
    return () => { live = false; };
  }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = convs.find((c) => c.id === selId) ?? (pinned && pinned.id === selId ? pinned : null);
  // lets the shell hide floating widgets while a conversation fills the phone screen
  useEffect(() => { document.body.classList.toggle('chat-open', !!sel); return () => document.body.classList.remove('chat-open'); }, [sel]);

  usePoll(async () => {
    const q = (filter === 'mine' ? 'mine=true&status=open' : filter === 'blocked' ? 'blocked=true' : filter === 'starred' ? 'starred=true' : filter === 'snoozed' ? 'snoozed=true&status=open' : `status=${filter}`) + (search.trim() ? `&q=${encodeURIComponent(search.trim())}` : '') + (tagFilter ? `&tag=${tagFilter}` : '');
    setConvs(await api<Conversation[]>('GET', `/conversations?${q}`).catch(() => []));
  }, 5000, [filter, search, tagFilter, live, bump]);
  usePoll(async () => setTargets(await api<{ id: string; name: string; groupName: string }[]>('GET', '/forward/targets').catch(() => [])), 60000);
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

  // Suggested answers from the knowledge base for the customer's latest message.
  useEffect(() => {
    setSugg([]);
    if (!selId) return;
    let live = true;
    void api<{ hits: typeof sugg }>('GET', `/conversations/${selId}/kb-suggestions`).then((d) => { if (live) setSugg(d.hits); }).catch(() => undefined);
    return () => { live = false; };
  }, [selId, msgs.filter((m) => m.direction === 'in').length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Standards for the topic the bot tagged on this conversation (safety officers only).
  const msgCount = msgs.filter((m) => m.direction === 'in').length;
  const canSafety = can(me, 'safety.view');
  const selTags = sel?.tags.map((t) => t.id).join(',') ?? '';
  useEffect(() => {
    setSafety({ topics: [], hits: [] });
    if (!selId || !canSafety) return;
    let live = true;
    void api<typeof safety>('GET', `/conversations/${selId}/safety-suggestions`).then((d) => { if (live) setSafety(d); }).catch(() => undefined);
    return () => { live = false; };
  }, [selId, msgCount, selTags, canSafety]); // eslint-disable-line react-hooks/exhaustive-deps
  const useSuggestion = (h: (typeof sugg)[number]) => {
    edit(text ? `${text}\n${h.text}` : h.text);
    taRef.current?.focus();
    void api('POST', '/kb/feedback', { sourceId: h.sourceId, action: 'used' }).catch(() => undefined);
  };
  const rate = (h: (typeof sugg)[number], helpful: boolean) => {
    void api('POST', '/kb/feedback', { sourceId: h.sourceId, action: helpful ? 'helpful' : 'unhelpful' }).catch(() => undefined);
    if (!helpful) setSugg((l) => l.filter((x) => x.sourceId !== h.sourceId));
  };

  const resize = () => { const t = taRef.current; if (t) { t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; } };
  useEffect(resize, [text]);
  const insertCanned = async (c: Canned) => {
    let body = c.body.replace(/\{(שם|name)\}/g, sel?.contactName ?? '');
    if (selId) body = (await api<{ text: string }>('POST', `/canned-replies/${c.id}/render`, { conversationId: selId }).catch(() => null))?.text ?? body;
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

  // a link such as #/inbox?c=<id> (from a message forwarded to a group) opens that conversation
  const linkedOnce = useRef(false);
  useEffect(() => {
    if (linkedOnce.current) return;
    const id = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('c');
    if (id && /^[0-9a-f-]{36}$/i.test(id)) { linkedOnce.current = true; void openRelated(id); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function openRelated(id: string) {
    const [c] = await api<Conversation[]>('GET', `/conversations?id=${id}&status=open`).catch(() => []);
    const [c2] = c ? [c] : await api<Conversation[]>('GET', `/conversations?id=${id}&status=closed`).catch(() => []);
    if (c2) { setPinned(c2); setSelId(c2.id); setMsgQuery(''); }
  }

  const assignTo = (userId: string | null, note?: string) => act(() => api('POST', `/conversations/${selId}/assign`, { userId, note }));
  const [sched, setSched] = useState<{ id: string; body: string; sendAt: string; status: string; error: string | null }[]>([]);
  const [schedAt, setSchedAt] = useState('');
  const loadSched = async () => { if (selId) setSched(await api<typeof sched>('GET', `/conversations/${selId}/scheduled`).catch(() => [])); else setSched([]); };
  useEffect(() => { setSchedAt(''); void loadSched(); }, [selId]);  // eslint-disable-line react-hooks/exhaustive-deps
  async function schedule() {
    if (!selId || !text.trim() || !schedAt) return;
    await act(async () => {
      await api('POST', `/conversations/${selId}/scheduled`, { text: text.trim(), sendAt: new Date(schedAt).toISOString() });
      edit(''); setSchedAt(''); await loadSched();
    });
  }
  const [ho, setHo] = useState<{ to: string; note: string } | null>(null);
  const [mates, setMates] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { setHo(null); }, [selId]);
  const openHandover = async (to = '') => {
    if (mates.length === 0) setMates(await api<{ id: string; name: string }[]>('GET', '/handover-targets').catch(() => []));
    setHo({ to, note: '' });
  };
  const FILTERS: [typeof filter, string][] = [['open', 'פתוחות'], ['mine', 'שלי'], ['starred', 'מסומנות'], ['snoozed', 'נדחו'], ['closed', 'סגורות'], ...(canBlock ? [['blocked', 'חסומים'] as [typeof filter, string]] : [])];

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
          <details className="inbox-adv" open={advActive || undefined}>
            <summary>אפשרויות מתקדמות{advActive ? ' (פעילות)' : ''}</summary>
            <div className="grid2">
              <div className="field"><label htmlFor="lp-sort">מיון</label>
                <select id="lp-sort" value={lp.sort} onChange={(e) => setPref({ sort: e.target.value as typeof lp.sort })}><option value="recent">אחרונות קודם</option><option value="waiting">ממתינות הכי הרבה זמן</option><option value="unread">לא נקראו קודם</option></select></div>
              <div className="field"><label htmlFor="lp-ch">ערוץ</label>
                <select id="lp-ch" value={lp.channel} onChange={(e) => setPref({ channel: e.target.value })}><option value="">כל הערוצים</option>{channels.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            </div>
            <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={lp.unreadOnly} onChange={(e) => setPref({ unreadOnly: e.target.checked })} /> רק עם הודעות שלא נקראו</label>
            <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={lp.waitingOnly} onChange={(e) => setPref({ waitingOnly: e.target.checked })} /> רק שממתינות לתשובה שלנו</label>
            {advActive && <button type="button" onClick={() => setPref({ sort: 'recent', channel: '', unreadOnly: false, waitingOnly: false })}>ניקוי הסינון המתקדם</button>}
          </details>
          {view.length === 0 ? <p className="empty">{convs.length === 0 ? 'אין שיחות להצגה.' : 'אין שיחות שמתאימות לסינון המתקדם.'}</p> : (
            <ul className="conv-list">
              {view.map((c) => {
                const w = waitLabel(c.waitingSince, sla);
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
                    <select id="asg" value={sel.assignedTo ?? ''} onChange={(e) => { const v = e.target.value || null; if (v && sel.assignedTo && v !== sel.assignedTo) void openHandover(v); else void assignTo(v); }}>
                      <option value="">לא משויך</option>
                      {team.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </>
                ) : sel.assignedTo === me.id ? (
                  <button onClick={() => assignTo(null)}>שחרור שיחה</button>
                ) : sel.assignedTo ? null : (
                  <button onClick={() => assignTo(me.id)}>קח שיחה</button>
                )}
                {sel.assignedTo && (sel.assignedTo === me.id || canAssignOthers) && <button aria-expanded={!!ho} aria-controls="handover" onClick={() => (ho ? setHo(null) : void openHandover())}>העברה לנציג…</button>}
                <button aria-pressed={!!sel.starred} onClick={() => act(() => api('POST', `/conversations/${sel.id}/star`, { starred: !sel.starred }))}>{sel.starred ? '★ הסרת סימון' : '☆ סימון'}</button>
                <label htmlFor="snz" className="sr-only">דחיית שיחה</label>
                <select id="snz" value="" onChange={(e) => { const m = Number(e.target.value); if (Number.isNaN(m)) return; void act(async () => { await api('POST', `/conversations/${sel.id}/snooze`, { minutes: m }); if (m > 0) setSelId(null); }); }}>
                  <option value="">{sel.snoozedUntil && new Date(sel.snoozedUntil) > new Date() ? `נדחתה עד ${new Date(sel.snoozedUntil).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}` : 'דחייה…'}</option>
                  <option value="60">שעה</option>
                  <option value="180">3 שעות</option>
                  <option value="1440">מחר</option>
                  <option value="10080">שבוע</option>
                  {sel.snoozedUntil && <option value="0">ביטול דחייה</option>}
                </select>
                {tpls.length > 0 && <button type="button" aria-expanded={!!tp} onClick={() => setTp(tp ? null : { key: `${tpls[0]!.name}|${tpls[0]!.language}`, values: Array(tpls[0]!.params).fill(''), msg: '' })}>שליחת תבנית</button>}
                {targets.length > 0 && <button type="button" aria-expanded={!!fwd} onClick={() => setFwd(fwd ? null : { rule: targets[0]!.id, note: '', msg: '' })}>העברה לקבוצה</button>}
                <button onClick={() => act(async () => { await api('POST', `/conversations/${sel.id}/unread`); setSelId(null); })}>סימון כלא נקראה</button>
                <button onClick={() => act(() => api('POST', `/conversations/${sel.id}/status`, { status: sel.status === 'open' ? 'closed' : 'open' }))}>
                  {sel.status === 'open' ? 'סגירת שיחה' : 'פתיחה מחדש'}
                </button>
              </div>

              {tp && sel && (() => {
                const t = tpls.find((x) => `${x.name}|${x.language}` === tp.key) ?? tpls[0]!;
                const preview = t.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => tp.values[Number(n) - 1] || `{{${n}}}`);
                return (
                  <form className="card" style={{ margin: '.6rem .9rem 0' }} aria-labelledby="tp-h" onSubmit={async (e) => {
                    e.preventDefault(); setTp({ ...tp, msg: '' });
                    try { await api('POST', `/conversations/${sel.id}/send-template`, { name: t.name, language: t.language, params: tp.values }); setTp(null); setBump((n) => n + 1); }
                    catch (er) { setTp({ ...tp, msg: errText(er instanceof ApiError ? er.code : 'generic') }); }
                  }}>
                    <h3 id="tp-h">שליחת תבנית הודעה</h3>
                    <p className="hint">תבנית מאושרת אפשר לשלוח גם אחרי שעברו 24 שעות מהודעת הלקוח האחרונה. שיווקית עשויה להיות בתשלום.</p>
                    <div className="field"><label htmlFor="tp-s">תבנית</label>
                      <select id="tp-s" value={tp.key} onChange={(e) => { const n = tpls.find((x) => `${x.name}|${x.language}` === e.target.value)!; setTp({ key: e.target.value, values: Array(n.params).fill(''), msg: '' }); }}>{tpls.map((x) => <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`}>{x.name} ({x.language})</option>)}</select></div>
                    {tp.values.map((v, i) => <div className="field" key={i}><label htmlFor={`tp-v${i}`}>ערך עבור {`{{${i + 1}}}`}</label><input id={`tp-v${i}`} required maxLength={200} value={v} onChange={(e) => setTp({ ...tp, values: tp.values.map((x, k) => (k === i ? e.target.value : x)) })} /></div>)}
                    <p><strong>כך זה ייראה ללקוח:</strong></p><p style={{ whiteSpace: 'pre-wrap' }}>{preview}</p>
                    <div className="row"><button className="primary" type="submit">שליחה</button><button type="button" onClick={() => setTp(null)}>ביטול</button></div>
                    <p role="alert" className="error">{tp.msg}</p>
                  </form>
                );
              })()}

              {fwd && sel && (
                <form className="card" style={{ margin: '.6rem .9rem 0' }} aria-labelledby="fwd-h" onSubmit={async (e) => {
                  e.preventDefault(); setFwd({ ...fwd, msg: '' });
                  try { const r = await api<{ ok: boolean; queued: boolean }>('POST', `/conversations/${sel.id}/forward`, { ruleId: fwd.rule, note: fwd.note.trim() || undefined }); setFwd(null); setBump((n) => n + 1); setErr(r.queued ? 'ההעברה ממתינה: הערוץ מנותק, והיא תישלח כשיחזור.' : ''); }
                  catch (er) { setFwd({ ...fwd, msg: errText(er instanceof ApiError ? er.code : 'generic') }); }
                }}>
                  <h3 id="fwd-h">העברת השיחה לקבוצת ווצאפ</h3>
                  <div className="field"><label htmlFor="fwd-r">לאיזו קבוצה</label>
                    <select id="fwd-r" value={fwd.rule} onChange={(e) => setFwd({ ...fwd, rule: e.target.value })}>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.groupName && t.groupName !== t.name ? ` (${t.groupName})` : ''}</option>)}</select></div>
                  <div className="field"><label htmlFor="fwd-n">הערה לקבוצה (אופציונלי)</label><input id="fwd-n" maxLength={400} value={fwd.note} onChange={(e) => setFwd({ ...fwd, note: e.target.value })} /></div>
                  <p className="hint">נשלחת הודעה עם שם הלקוח, הנושא, ההודעות האחרונות וקישור לשיחה. כל חברי הקבוצה יראו אותה: לא להעביר מידע רגיש לקבוצה שלא צריכה לראות אותו.</p>
                  <div className="row"><button className="primary" type="submit">שליחה לקבוצה</button><button type="button" onClick={() => setFwd(null)}>ביטול</button></div>
                  <p role="alert" className="error">{fwd.msg}</p>
                </form>
              )}

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
                        {notes.map((n) => <li key={n.id}>{n.body} <small className="hint">— {n.authorName ?? 'מערכת (בוט)'}, {fmt(n.createdAt)}</small></li>)}
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

              {safety.hits.length > 0 && (
                <details className="kb-sugg safety-sugg" open={window.matchMedia('(min-width: 900px)').matches}>
                  <summary>מהתקינה: {safety.topics.join(', ')} ({safety.hits.length})</summary>
                  <ul>
                    {safety.hits.map((h) => (
                      <li key={`${h.topic}-${h.sourceId}`}>
                        <strong>{h.title}</strong>{h.reference && <> <span className="badge connected">{h.reference}</span></>}
                        <p style={{ margin: '.2rem 0', whiteSpace: 'pre-wrap' }}>{h.excerpt}</p>
                        <div className="row">
                          <button type="button" onClick={() => { const t = `${h.reference ? `לפי ${h.reference}: ` : ''}${h.excerpt}${h.url ? `\n${h.url}` : ''}`; edit(text ? `${text}\n${t}` : t); taRef.current?.focus(); }}>הוספה לתשובה<span className="sr-only"> {h.title}</span></button>
                          {h.url && <a className="btn" href={h.url} target="_blank" rel="noopener noreferrer">למקור<span className="sr-only"> {h.title}, נפתח בלשונית חדשה</span></a>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {sugg.length > 0 && (
                <details className="kb-sugg" open={window.matchMedia('(min-width: 900px)').matches}>
                  <summary>הצעות ממאגר הידע ({sugg.length})</summary>
                  <ul>
                    {sugg.map((h) => (
                      <li key={h.sourceId}>
                        <strong>{h.title}</strong> <small className="hint">{Math.round(h.score * 100)}%</small>
                        <p style={{ margin: '.2rem 0', whiteSpace: 'pre-wrap' }}>{h.text.length > 240 ? `${h.text.slice(0, 240)}…` : h.text}</p>
                        <div className="row">
                          <button type="button" onClick={() => useSuggestion(h)}>הוספה לתשובה<span className="sr-only"> {h.title}</span></button>
                          <button type="button" onClick={() => rate(h, true)} aria-label={`הצעה מועילה: ${h.title}`}>👍</button>
                          <button type="button" onClick={() => rate(h, false)} aria-label={`הצעה לא מתאימה: ${h.title}`}>👎</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {ho && (
                <form id="handover" className="card" aria-label="העברת שיחה לנציג" onSubmit={async (e) => { e.preventDefault(); await assignTo(ho.to, ho.note.trim()); setHo(null); }}>
                  <div className="field"><label htmlFor="ho-to">העברה אל</label>
                    <select id="ho-to" required value={ho.to} onChange={(e) => setHo({ ...ho, to: e.target.value })}>
                      <option value="">בחירת נציג…</option>
                      {mates.filter((u) => u.id !== sel.assignedTo).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select></div>
                  <div className="field"><label htmlFor="ho-note">הערת העברה (חובה, לא נשלחת ללקוח)</label>
                    <textarea id="ho-note" required rows={3} maxLength={1000} value={ho.note} onChange={(e) => setHo({ ...ho, note: e.target.value })} placeholder="מה כבר נעשה, מה הלקוח מחכה לו" /></div>
                  <div className="row"><button className="primary" type="submit" disabled={!ho.to || !ho.note.trim()}>העברה</button><button type="button" onClick={() => setHo(null)}>ביטול</button></div>
                </form>
              )}
              <form className="composer" onSubmit={send}>
                {text.startsWith('/') && !text.includes('\n') && (
                  <div className="slash" role="listbox" aria-label="תשובות מוכנות מתאימות">
                    {canned.filter((c) => `${c.title} ${c.folder} ${c.body}`.toLowerCase().includes(text.slice(1).trim().toLowerCase())).slice(0, 6).map((c) => (
                      <button type="button" role="option" aria-selected="false" key={c.id} onClick={() => void insertCanned(c)}>/ {c.title}{c.folder ? <small className="muted"> · {c.folder}</small> : null}</button>
                    ))}
                  </div>
                )}
                <p role="alert" className="error" style={{ margin: 0 }}>{err}</p>
                {canned.length > 0 && (
                  <div className="composer-tools">
                    <div className="quick" aria-label="תשובות מהירות" role="group">
                      {canned.slice(0, 4).map((c) => <button type="button" key={c.id} onClick={() => void insertCanned(c)}>{c.title}</button>)}
                    </div>
                    <label htmlFor="canned" className="sr-only">תשובה מוכנה</label>
                    <select id="canned" value="" onChange={(e) => { const c = canned.find((x) => x.id === e.target.value); if (c) void insertCanned(c); }} style={{ marginTop: '.4rem' }}>
                      <option value="">כל התשובות המוכנות…</option>
                      {[...new Set(canned.map((c) => c.folder))].map((f) => (
                        <optgroup key={f || '_'} label={f || 'כללי'}>
                          {canned.filter((c) => c.folder === f).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                )}
                <details className="sched">
                  <summary>תזמון שליחה{sched.some((x) => x.status === 'pending') ? ` (${sched.filter((x) => x.status === 'pending').length} ממתינות)` : ''}</summary>
                  <p className="hint">ההודעה (מהתיבה למטה) תישלח בשעה שתבחרו, בכפוף לאותם כללים כמו תשובה רגילה: לא נשלח ללקוח חסום, שביקש להפסיק או שלא פנה אליכם לאחרונה. אפשר להשתמש במשתנים כמו {'{שם}'}.</p>
                  <div className="row">
                    <label htmlFor="sched-at" className="sr-only">מועד שליחה</label>
                    <input id="sched-at" type="datetime-local" value={schedAt} min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000 + 120000).toISOString().slice(0, 16)} onChange={(e) => setSchedAt(e.target.value)} style={{ maxWidth: 230 }} />
                    <button type="button" disabled={!text.trim() || !schedAt || !!sel.blocked || !!sel.optedOut} onClick={() => void schedule()}>תזמון ההודעה</button>
                  </div>
                  {sched.length > 0 && (
                    <ul className="plain">
                      {sched.map((x) => (
                        <li key={x.id}>
                          <span dir="ltr">{new Date(x.sendAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}</span> · {x.status === 'pending' ? 'ממתינה' : x.status === 'sent' ? 'נשלחה' : x.status === 'cancelled' ? 'בוטלה' : `נכשלה${x.error ? ` (${schedErr[x.error] ?? x.error})` : ''}`}: {x.body.length > 60 ? `${x.body.slice(0, 60)}…` : x.body}
                          {x.status === 'pending' && <button type="button" style={{ minHeight: 32, marginInlineStart: '.5rem' }} onClick={() => void act(async () => { await api('DELETE', `/scheduled/${x.id}`); await loadSched(); })}>ביטול<span className="sr-only"> הודעה מתוזמנת</span></button>}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
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
