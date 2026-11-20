import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Channel } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { errText } from '../strings';

interface Name { username: string | null; status: 'approved' | 'reserved' | 'none' | 'deleted' }
interface Info { live: Name | null; stored: (Name & { context: string | null; updatedAt: string }) | null; error?: string; detail?: string }

const STATUS: Record<string, string> = {
  approved: 'מאושר וגלוי ללקוחות',
  reserved: 'שמור למספר (ייראה ללקוחות כשהתכונה תיפתח לכולם)',
  none: 'אין שם משתמש',
  deleted: 'נמחק',
};

/** The same rules the server applies (Meta's username format), to tell the admin before a change is spent. */
export function usernameHint(raw: string): string | null {
  const u = raw.trim().toLowerCase();
  if (!u) return null;
  if (u.length < 3 || u.length > 35) return errText('username_length');
  if (!/^[a-z0-9._]+$/.test(u)) return errText('username_chars');
  if (!/[a-z]/.test(u)) return errText('username_no_letter');
  if (u.startsWith('.') || u.endsWith('.') || u.includes('..')) return errText('username_periods');
  if (u.startsWith('www.') || /\.(com|org|net|int|edu|gov|mil|arpa|html|htm|txt|xml)$/.test(u)) return errText('username_domain');
  return null;
}

/**
 * The business username of an official WhatsApp number (Meta's Username API): customers can find the business by it and
 * chat without its phone number. Meta is the source of truth; every change is limited (2 per 14 days), so the format is
 * checked here and on the server before anything is sent.
 */
export function BusinessUsernamePanel({ channel }: { channel: Channel }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [needsTransfer, setNeedsTransfer] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const base = `/channels/${channel.id}/cloud/username`;
  const hid = `bu-${channel.id}`;

  async function load() {
    setLoading(true);
    try { setInfo(await api<Info>('GET', base)); } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
    setLoading(false);
  }
  useEffect(() => { void load(); }, [channel.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : 'generic';
    const detail = e instanceof ApiError && e.detail ? ` פרטים מ-Meta: ${e.detail}` : '';
    setNeedsTransfer(code === 'username_transfer_required');
    setMsg({ ok: false, text: `${errText(code)}${detail}` });
  };

  async function save(transfer: boolean) {
    const problem = usernameHint(name);
    if (problem || !name.trim()) { setMsg({ ok: false, text: problem ?? errText('username_length') }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await api<Name>('PUT', base, { username: name.trim().toLowerCase(), transfer });
      setNeedsTransfer(false);
      setMsg({ ok: true, text: r.status === 'reserved' ? `השם @${r.username} נשמר למספר. הוא ייראה ללקוחות כש-Meta תפתח את התכונה לכולם.` : `השם @${r.username} נשמר ואושר.` });
      setName('');
      await load();
    } catch (e) { fail(e); }
    setBusy(false);
  }

  async function remove() {
    setConfirmDelete(false); setBusy(true); setMsg(null);
    try { await api('DELETE', base); setMsg({ ok: true, text: 'שם המשתמש נמחק מהמספר.' }); await load(); } catch (e) { fail(e); }
    setBusy(false);
  }

  async function suggest() {
    setBusy(true); setMsg(null);
    try { setSuggestions((await api<{ suggestions: string[] }>('GET', `${base}/suggestions`)).suggestions); } catch (e) { fail(e); }
    setBusy(false);
  }

  const current = info?.live ?? info?.stored ?? null;
  const connected = channel.status === 'connected';
  const hint = usernameHint(name);
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void save(false); };

  return (
    <section className="card" aria-labelledby={`${hid}-h`}>
      <h3 id={`${hid}-h`}>שם משתמש עסקי בווצאפ</h3>
      <p className="hint">
        שם כמו <span dir="ltr">@technion.safety</span> שלקוחות יכולים לחפש בווצאפ ולפנות אליו בלי לדעת את מספר הטלפון. מותר: אותיות באנגלית, ספרות, נקודה וקו תחתון, 3–35 תווים, לפחות אות אחת.
        Meta מגבילה ל-2 החלפות ב-14 יום (10 כשהשם במצב &quot;שמור&quot;), ומחיקה לא מאפסת את המגבלה.
      </p>
      {loading ? <p role="status">טוען…</p> : (
        <dl className="kv">
          <dt>השם הנוכחי</dt>
          <dd>{current?.username ? <bdi dir="ltr">@{current.username}</bdi> : '—'}</dd>
          <dt>מצב</dt>
          <dd>{STATUS[current?.status ?? 'none'] ?? current?.status}{info?.stored?.context === 'revoked' ? ' (בוטל על ידי Meta)' : ''}</dd>
        </dl>
      )}
      {info?.error && <p className="error">לא ניתן לקרוא את השם מ-Meta כרגע: {errText(info.error)}{info.detail ? ` פרטים מ-Meta: ${info.detail}` : ''}{info.stored ? ' מוצג המצב האחרון שנשמר.' : ''}</p>}
      {!connected && <p className="error">הערוץ צריך להיות מחובר כדי לשנות את שם המשתמש.</p>}

      <form onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor={`${hid}-in`}>{current?.username ? 'שם משתמש חדש' : 'שם משתמש'}</label>
          <input id={`${hid}-in`} dir="ltr" autoComplete="off" spellCheck={false} maxLength={35} placeholder="technion.safety" value={name}
            aria-invalid={!!hint} aria-describedby={hint ? `${hid}-err` : undefined}
            onChange={(e) => { setName(e.target.value.replace(/^@/, '').toLowerCase()); setNeedsTransfer(false); }} />
          {hint && <p id={`${hid}-err`} className="error">{hint}</p>}
        </div>
        <div className="row">
          <button className="primary" type="submit" disabled={busy || !connected || !name.trim() || !!hint}>{busy ? 'שומר…' : 'שמירת השם'}</button>
          <button type="button" onClick={() => void suggest()} disabled={busy || !connected}>שמות ש-Meta שמרה לכם</button>
          {current?.username && <button type="button" className="danger" disabled={busy || !connected} onClick={() => setConfirmDelete(true)}>מחיקת שם המשתמש</button>}
        </div>
      </form>

      {suggestions && (suggestions.length ? (
        <div>
          <p className="hint">שמות שמורים לעסק שלכם (סיכוי גבוה יותר לאישור). לחיצה ממלאת את השדה:</p>
          <ul className="row" aria-label="הצעות לשם משתמש" style={{ listStyle: 'none', padding: 0 }}>
            {suggestions.map((s) => <li key={s}><button type="button" onClick={() => setName(s)}><bdi dir="ltr">@{s}</bdi></button></li>)}
          </ul>
        </div>
      ) : <p className="hint">אין כרגע שמות ש-Meta שמרה לעסק. אפשר לבחור שם משלכם.</p>)}

      {needsTransfer && (
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={() => void save(true)}>להעביר את השם למספר הזה</button>
          <span className="hint">השם יוסר מהמספר האחר שלכם. ההעברה נחשבת כהחלפה.</span>
        </div>
      )}
      <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>

      <ConfirmDialog open={confirmDelete} danger title="מחיקת שם המשתמש" confirmLabel="מחיקה"
        message={`למחוק את @${current?.username ?? ''} מהמספר? לקוחות לא ימצאו אותו לפי השם, והמחיקה לא מחזירה את מכסת ההחלפות.`}
        onConfirm={() => void remove()} onCancel={() => setConfirmDelete(false)} />
    </section>
  );
}
