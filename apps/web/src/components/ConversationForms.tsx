import { useEffect, useState } from 'react';
import { api, ApiError, FORM_STATUS, type FormRequestRow, type FormTemplate } from '../api';
import { errText } from '../strings';

/** Send a form to sign from this conversation: choose the template, how long the link lasts, an optional line. */
export function SendFormPanel({ convId, channelId, channelType, onDone, onClose }: { convId: string; channelId?: string; channelType?: string; onDone: () => void; onClose: () => void }) {
  const [tpls, setTpls] = useState<FormTemplate[] | null>(null);
  const [tid, setTid] = useState('');
  const [days, setDays] = useState(7);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [via, setVia] = useState<'link' | 'flow'>('link');
  /** filling inside WhatsApp: only on the official channel, for a template whose Flow is published there and up to date */
  const [flowReady, setFlowReady] = useState(false);
  useEffect(() => {
    setFlowReady(false); setVia('link');
    if (!tid || channelType !== 'whatsapp_cloud' || !channelId) return;
    void api<{ enabled: boolean; channels: { id: string; ready: boolean }[] }>('GET', `/forms/templates/${tid}/flow`)
      .then((i) => { const ok = i.enabled && i.channels.some((c) => c.id === channelId && c.ready); setFlowReady(ok); if (ok) setVia('flow'); }).catch(() => undefined);
  }, [tid, channelId, channelType]);
  useEffect(() => { void api<FormTemplate[]>('GET', '/forms/templates').then((l) => { const a = l.filter((t) => t.active && t.fields.length); setTpls(a); setTid(a[0]?.id ?? ''); }).catch(() => setTpls([])); }, []);
  async function send() {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ number: number }>('POST', `/conversations/${convId}/forms`, { templateId: tid, days, via, ...(note.trim() ? { note: note.trim() } : {}) });
      setMsg({ ok: true, text: via === 'flow' ? `נשלח (בקשה ${r.number}). הלקוח ימלא ויחתום בתוך ווצאפ, ואחרי החתימה יקבל עותק חתום.` : `נשלח (בקשה ${r.number}). הלקוח יקבל קישור אישי, קוד אימות לצ׳אט, ואחרי החתימה עותק חתום.` }); onDone();
    } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
    finally { setBusy(false); }
  }
  return (
    <form className="card" id="send-form" style={{ margin: '.6rem .9rem 0' }} aria-labelledby="sf-h" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <h3 id="sf-h">שליחת טופס לחתימה</h3>
      {tpls === null ? <p role="status">טוען תבניות…</p> : !tpls.length ? <p>אין תבניות פעילות עם שדות. מנהל טפסים יוצר אותן במסך "טפסים".</p> : (
        <>
          <div className="field"><label htmlFor="sf-t">טופס</label><select id="sf-t" value={tid} onChange={(e) => setTid(e.target.value)}>{tpls.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></div>
          {flowReady && (
            <fieldset><legend>איך ימלאו</legend>
              <label style={{ fontWeight: 400 }}><input type="radio" name="sf-via" style={{ width: 'auto', minHeight: 'auto' }} checked={via === 'flow'} onChange={() => setVia('flow')} /> בתוך ווצאפ (בלי קישור; חתימה = אישור ושם מוקלד)</label>
              <label style={{ fontWeight: 400 }}><input type="radio" name="sf-via" style={{ width: 'auto', minHeight: 'auto' }} checked={via === 'link'} onChange={() => setVia('link')} /> קישור לדף מילוי (חתימה ביד, קוד אימות)</label>
            </fieldset>
          )}
          <div className="field"><label htmlFor="sf-d">{via === 'flow' ? 'הבקשה בתוקף (ימים)' : 'הקישור בתוקף (ימים)'}</label><input id="sf-d" type="number" min={1} max={60} style={{ maxWidth: 110 }} value={days} onChange={(e) => setDays(Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 7))))} /></div>
          <div className="field"><label htmlFor="sf-n">שורה נוספת בהודעה (לא חובה)</label><input id="sf-n" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="למשל: נא למלא עד יום ה׳" /></div>
          <div className="row"><button className="primary" type="submit" disabled={busy || !tid}>{busy ? 'שולח…' : 'שליחה'}</button><button type="button" onClick={onClose}>סגירה</button></div>
        </>
      )}
      {msg && <p role="status" className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
    </form>
  );
}

/** The forms sent in this conversation and where each one stands. */
export function ConversationFormsList({ convId, refresh }: { convId: string; refresh: string | number }) {
  const [rows, setRows] = useState<FormRequestRow[]>([]);
  useEffect(() => { void api<FormRequestRow[]>('GET', `/conversations/${convId}/forms`).then(setRows).catch(() => setRows([])); }, [convId, refresh]);
  // while a form waits for its signer, look again every 15 seconds (signing happens on the signer's phone, not here)
  const waiting = rows.some((r) => ['sent', 'opened', 'verified'].includes(r.status));
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { void api<FormRequestRow[]>('GET', `/conversations/${convId}/forms`).then(setRows).catch(() => undefined); }, 15000);
    return () => clearInterval(t);
  }, [convId, waiting]);
  if (!rows.length) return null;
  return (
    <section className="conv-forms" aria-labelledby={`cf-h-${convId}`}>
      <h3 id={`cf-h-${convId}`}>טפסים ({rows.length})</h3>
      <ul className="plain">
        {rows.map((r) => (
          <li key={r.id}>
            <span>{r.title} · בקשה {r.number}</span> <span className={`mchip fs-${r.status}`}>{FORM_STATUS[r.status]}</span>
            {r.status === 'signed' && <> <a className="linklike" href={`/forms/requests/${r.id}/signed.pdf`}>הורדת הטופס החתום<span className="sr-only"> {r.title}</span></a></>}
          </li>
        ))}
      </ul>
    </section>
  );
}
