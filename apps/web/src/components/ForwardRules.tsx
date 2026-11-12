import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { errText } from '../strings';

interface Rule { id: string; name: string; enabled: boolean; channelId: string; channelLabel: string; groupJid: string; groupName: string; onHandoff: boolean; tagIds: string[]; tagNames: string[]; includeMessages: number; includePhone: boolean }
interface LogRow { id: number; status: string; trigger: string; tries: number; createdAt: string; ruleName: string | null; byName: string | null }
const TRIGGER: Record<string, string> = { handoff: 'אוטומטי (העברה מהבוט)', manual: 'ידני', test: 'בדיקה' };
const STATUS: Record<string, string> = { sent: 'נשלח', pending: 'ממתין', failed: 'נכשל' };
const blank = { name: '', channelId: '', groupJid: '', groupName: '', onHandoff: true, tagIds: [] as string[], includeMessages: 3, includePhone: false, enabled: true };

/** Rules that post a conversation into a WhatsApp group: automatically on a hand-over from the bot (optionally only for some tags), or by hand from a conversation. */
export function ForwardRules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [channels, setChannels] = useState<{ id: string; label: string; type: string; status: string }[]>([]);
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string; size: number }[] | null>(null);
  const [editId, setEditId] = useState<string | null>(null);   // '' = new
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = async () => {
    setRules(await api<Rule[]>('GET', '/forward/rules').catch(() => []));
    setLog(await api<LogRow[]>('GET', '/forward/log').catch(() => []));
    setChannels((await api<{ id: string; label: string; type: string; status: string }[]>('GET', '/channels').catch(() => [])).filter((c) => c.type === 'whatsapp'));
    setTags(await api<{ id: string; name: string }[]>('GET', '/tags').catch(() => []));
  };
  useEffect(() => { void load(); }, []);
  const fail = (e: unknown) => setMsg({ ok: false, text: e instanceof ApiError && e.code === 'channel_not_connected' ? 'הערוץ אינו מחובר, ולכן אי אפשר לטעון את הקבוצות.' : e instanceof ApiError && e.code === 'send_failed' ? 'השליחה לקבוצה נכשלה. ודאו שהערוץ מחובר ושהמספר חבר בקבוצה.' : errText(e instanceof ApiError ? e.code : 'generic') });
  const start = (r?: Rule) => { setEditId(r?.id ?? ''); setGroups(null); setMsg(null); setF(r ? { name: r.name, channelId: r.channelId, groupJid: r.groupJid, groupName: r.groupName, onHandoff: r.onHandoff, tagIds: r.tagIds, includeMessages: r.includeMessages, includePhone: r.includePhone, enabled: r.enabled } : { ...blank, channelId: channels[0]?.id ?? '' }); };
  async function loadGroups(refresh = false) {
    setMsg(null);
    try { setGroups(await api('GET', `/channels/${f.channelId}/groups${refresh ? '?refresh=1' : ''}`)); } catch (e) { fail(e); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    try {
      if (editId) await api('PUT', `/forward/rules/${editId}`, f); else await api('POST', '/forward/rules', f);
      setEditId(null); setMsg({ ok: true, text: 'נשמר.' }); await load();
    } catch (er) { fail(er); }
  }
  return (
    <section className="card" aria-labelledby="fw-h">
      <h2 id="fw-h">העברת שיחות לקבוצת ווצאפ</h2>
      <p className="hint">מעבירים שיחה לקבוצת ווצאפ של הצוות (למשל קבוצת הממונים): אוטומטית כשהבוט מעביר שיחה לאנשים (אפשר להגביל לנושאים מסוימים), או ידנית מתוך שיחה בכפתור "העברה לקבוצה". ההודעה נשלחת מהמספר המקושר (ערוץ ווצאפ רגיל, לא הרשמי), והוא חייב להיות חבר בקבוצה. תשובות שנכתבות בקבוצה לא נקראות במערכת: את הטיפול ממשיכים בפאנל, דרך הקישור שבהודעה. <strong>כל חברי הקבוצה רואים את ההודעה:</strong> ברירת המחדל לא כוללת את מספר הטלפון של הלקוח.</p>
      {rules.length === 0 ? <p className="empty">עוד לא הוגדרו כללים.</p> : (
        <table>
          <caption className="sr-only">כללי העברה לקבוצות</caption>
          <thead><tr><th scope="col">שם</th><th scope="col">ערוץ וקבוצה</th><th scope="col">מתי</th><th scope="col">פעולות</th></tr></thead>
          <tbody>{rules.map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.name}{!r.enabled && <span className="badge stopped">כבוי</span>}</th>
              <td>{r.channelLabel} · {r.groupName || r.groupJid}</td>
              <td>{r.onHandoff ? `אוטומטי בהעברה מהבוט${r.tagNames.length ? ` (רק בנושאים: ${r.tagNames.join(', ')})` : ''}` : 'ידני בלבד'}</td>
              <td><div className="row">
                <button type="button" onClick={() => start(r)}>עריכה<span className="sr-only"> {r.name}</span></button>
                <button type="button" onClick={async () => { setMsg(null); try { await api('POST', `/forward/rules/${r.id}/test`); setMsg({ ok: true, text: `הודעת בדיקה נשלחה לקבוצה "${r.groupName || r.name}".` }); await load(); } catch (e) { fail(e); } }}>שליחת בדיקה<span className="sr-only"> {r.name}</span></button>
                <button type="button" className="danger" onClick={async () => { if (!confirm(`למחוק את הכלל "${r.name}"?`)) return; await api('DELETE', `/forward/rules/${r.id}`).catch(() => null); await load(); }}>מחיקה<span className="sr-only"> {r.name}</span></button>
              </div></td>
            </tr>))}</tbody>
        </table>
      )}
      {editId === null && <button type="button" onClick={() => start()} disabled={channels.length === 0}>הוספת כלל</button>}
      {channels.length === 0 && <p className="hint">אין ערוץ ווצאפ (QR). קישרו אחד בעמוד "ערוצים".</p>}
      {editId !== null && (
        <form onSubmit={submit}>
          <div className="field"><label htmlFor="fw-n">שם הכלל</label><input id="fw-n" required maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="fw-c">ערוץ (המספר ששולח)</label>
            <select id="fw-c" required value={f.channelId} onChange={(e) => { setF({ ...f, channelId: e.target.value, groupJid: '', groupName: '' }); setGroups(null); }}>{channels.map((c) => <option key={c.id} value={c.id}>{c.label}{c.status === 'connected' ? '' : ' (לא מחובר)'}</option>)}</select></div>
          <div className="field"><label htmlFor="fw-g">הקבוצה</label>
            <div className="row">
              <select id="fw-g" required value={f.groupJid} onChange={(e) => { const g = groups?.find((x) => x.id === e.target.value); setF({ ...f, groupJid: e.target.value, groupName: g?.name ?? f.groupName }); }}>
                <option value="">בחרו קבוצה</option>
                {f.groupJid && !groups?.some((g) => g.id === f.groupJid) && <option value={f.groupJid}>{f.groupName || f.groupJid}</option>}
                {(groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name || g.id} ({g.size} חברים)</option>)}
              </select>
              <button type="button" onClick={() => void loadGroups(groups !== null)}>{groups ? 'רענון הרשימה' : 'טעינת הקבוצות'}</button>
            </div>
            <p className="hint">הרשימה נטענת מהמספר המקושר (הערוץ צריך להיות מחובר).</p></div>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={f.onHandoff} onChange={(e) => setF({ ...f, onHandoff: e.target.checked })} /> להעביר אוטומטית כשהבוט מעביר שיחה לאנשים</label></div>
          {f.onHandoff && (
            <fieldset><legend>רק בשיחות עם התגיות האלה (בלי בחירה = כל השיחות)</legend>
              <div className="chips">{tags.map((t) => <button type="button" key={t.id} className="chip" aria-pressed={f.tagIds.includes(t.id)} onClick={() => setF({ ...f, tagIds: f.tagIds.includes(t.id) ? f.tagIds.filter((x) => x !== t.id) : [...f.tagIds, t.id] })}>{t.name}</button>)}</div></fieldset>
          )}
          <div className="field"><label htmlFor="fw-m">כמה מההודעות האחרונות לצרף (0 עד 10)</label><input id="fw-m" type="number" min={0} max={10} style={{ maxWidth: 100 }} value={f.includeMessages} onChange={(e) => setF({ ...f, includeMessages: Math.min(10, Math.max(0, Math.round(Number(e.target.value) || 0))) })} /></div>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={f.includePhone} onChange={(e) => setF({ ...f, includePhone: e.target.checked })} /> לצרף את מספר הטלפון של הלקוח (מידע אישי שיראו כל חברי הקבוצה)</label></div>
          <div className="field"><label><input type="checkbox" role="switch" style={{ width: 'auto', minHeight: 'auto' }} checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> הכלל פעיל</label></div>
          <div className="row"><button className="primary" type="submit">שמירה</button><button type="button" onClick={() => setEditId(null)}>ביטול</button></div>
        </form>
      )}
      <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
      {log.length > 0 && (
        <details>
          <summary>העברות אחרונות ({log.length})</summary>
          <table>
            <caption className="sr-only">יומן העברות לקבוצות</caption>
            <thead><tr><th scope="col">מתי</th><th scope="col">כלל</th><th scope="col">סוג</th><th scope="col">מצב</th><th scope="col">על ידי</th></tr></thead>
            <tbody>{log.map((l) => <tr key={l.id}><td>{new Date(l.createdAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}</td><td>{l.ruleName ?? 'נמחק'}</td><td>{TRIGGER[l.trigger] ?? l.trigger}</td><td>{STATUS[l.status] ?? l.status}{l.status === 'pending' && l.tries ? ` (ניסיון ${l.tries})` : ''}</td><td>{l.byName ?? ''}</td></tr>)}</tbody>
          </table>
        </details>
      )}
    </section>
  );
}
