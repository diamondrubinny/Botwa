import { useEffect, useState } from 'react';
import { api, ApiError, FORM_STATUS, type Channel, type FormRequestRow, type FormTemplate } from '../api';
import { errText } from '../strings';

/** "name, phone" per line, as typed or pasted from a spreadsheet (tab, comma or semicolon between them, in either order). */
export function parsePeople(text: string): { name: string; phone: string }[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split(/\t|;|,/).map((x) => x.trim()).filter(Boolean);
    const phoneAt = parts.findIndex((x) => /^[+\d][\d\s()-]{5,}$/.test(x));
    const phone = phoneAt >= 0 ? parts[phoneAt]! : '';
    const name = parts.filter((_, i) => i !== phoneAt).join(' ');
    return { name, phone };
  }).filter((p) => p.phone);
}

/** One form to a group: choose the WhatsApp channel, paste the people, optionally an approved template for those outside the window. */
export function BatchPanel({ tpl, onDone, onClose }: { tpl: FormTemplate; onDone: (batchId: string) => void; onClose: () => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [ch, setCh] = useState('');
  const [text, setText] = useState('');
  const [days, setDays] = useState(14);
  const [note, setNote] = useState('');
  const [templates, setTemplates] = useState<{ name: string; language: string; status: string; params: number; body: string }[] | null>(null);
  const [wa, setWa] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { void api<Channel[]>('GET', '/channels').then((l) => { const w = l.filter((c) => c.type === 'whatsapp' || c.type === 'whatsapp_cloud'); setChannels(w); setCh(w[0]?.id ?? ''); }).catch(() => setChannels([])); }, []);
  const cloud = channels.find((c) => c.id === ch)?.type === 'whatsapp_cloud';
  useEffect(() => {
    setTemplates(null); setWa('');
    if (!cloud) return;
    void api<NonNullable<typeof templates>>('GET', `/channels/${ch}/templates`).then((l) => setTemplates(l.filter((t) => t.status === 'APPROVED' && t.params >= 1))).catch(() => setTemplates([]));
  }, [ch, cloud]);
  const people = parsePeople(text);

  async function send() {
    setBusy(true); setMsg(null);
    try {
      const [name, language] = wa ? wa.split('|') : [];
      const r = await api<{ batchId: string; total: number; invalid: { row: number; value: string }[] }>('POST', `/forms/templates/${tpl.id}/batch`, {
        channelId: ch, days, people, ...(note.trim() ? { note: note.trim() } : {}), ...(name ? { waTemplate: { name, language } } : {}),
      });
      setMsg({ ok: true, text: `נוצרו ${r.total} בקשות אישיות.${r.invalid.length ? ` ${r.invalid.length} מספרים לא תקינים דולגו (שורות ${r.invalid.map((x) => x.row).join(', ')}).` : ''} ההודעות יוצאות ברקע; המצב של כל אחד מופיע בדוח הקבוצה.` });
      onDone(r.batchId);
    } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
    finally { setBusy(false); }
  }

  return (
    <section className="card" aria-labelledby="fb-h">
      <h2 id="fb-h">שליחה לקבוצה: {tpl.title}</h2>
      <p className="hint">כל אחד מקבל קישור אישי. מי שכתב אלינו לאחרונה מקבל הודעה רגילה. בווצאפ הרשמי, למי שלא כתב, הקישור נשלח בתבנית מאושרת אם בחרתם אחת. לכל השאר המערכת לא שולחת הודעה יזומה (כדי לא לסכן את המספר), והקישור מחכה בדוח הקבוצה להעברה בדרך אחרת.</p>
      {!channels.length ? <p>אין ערוץ ווצאפ. חברו ערוץ במסך "ערוצים".</p> : (
        <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <div className="field"><label htmlFor="fb-ch">ערוץ</label><select id="fb-ch" value={ch} onChange={(e) => setCh(e.target.value)}>{channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
          <div className="field"><label htmlFor="fb-p">אנשים: שם וטלפון בכל שורה</label>
            <textarea id="fb-p" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'דנה כהן, 050-1234567\nאבי לוי, 052-7654321'} aria-describedby="fb-p-h" />
            <p id="fb-p-h" className="hint">אפשר להעתיק שתי עמודות (שם וטלפון) מאקסל ולהדביק כאן. עד 500 אנשים. {people.length ? `זוהו ${people.length}.` : ''}</p></div>
          {cloud && (
            <div className="field"><label htmlFor="fb-wa">תבנית מאושרת למי שלא כתב ב-24 השעות האחרונות (לא חובה)</label>
              <select id="fb-wa" value={wa} onChange={(e) => setWa(e.target.value)}>
                <option value="">בלי: הקישור יישאר להעברה ידנית</option>
                {(templates ?? []).map((t) => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language}): {t.body.slice(0, 60)}</option>)}
              </select>
              <p className="hint">התבנית צריכה מקום לקישור: עם ערך אחד ({'{{1}}'}) הוא יקבל את הקישור; עם שניים, {'{{1}}'} יקבל את השם ו-{'{{2}}'} את הקישור.</p></div>
          )}
          <div className="row">
            <div className="field"><label htmlFor="fb-d">תוקף (ימים)</label><input id="fb-d" type="number" min={1} max={60} style={{ maxWidth: 110 }} value={days} onChange={(e) => setDays(Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 14))))} /></div>
            <div className="field" style={{ flex: '1 1 260px' }}><label htmlFor="fb-n">שורה נוספת בהודעה (לא חובה)</label><input id="fb-n" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </div>
          <div className="row"><button className="primary" type="submit" disabled={busy || !people.length || !ch}>{busy ? 'יוצר…' : `שליחה ל-${people.length} אנשים`}</button><button type="button" onClick={onClose}>סגירה</button></div>
        </form>
      )}
      {msg && <p role="status" className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
    </section>
  );
}

interface BatchRow { id: string; title: string; total: number; done: boolean; createdAt: string; channelLabel: string | null; createdBy: string | null; signed: number; delivered: number; linkOnly: number; failed: number; queued: number }
interface BatchPerson { id: string; number: number; signerName: string | null; signerPhone: string | null; status: FormRequestRow['status']; delivery: string | null; deliveryDetail: string | null; signedAt: string | null; link: string | null }
const DELIVERY: Record<string, string> = { queued: 'בתור', sent: 'נשלח', template: 'נשלח בתבנית', link_only: 'קישור להעברה', failed: 'נכשל' };
const WHY: Record<string, string> = { outside_reply_window: 'לא כתב/ה לאחרונה', contact_blocked: 'חסום', contact_opted_out: 'ביקש/ה לא לקבל הודעות', template_not_approved: 'התבנית לא מאושרת', template_has_no_param: 'אין בתבנית מקום לקישור' };

/** The groups that were sent: who got it, who signed, the links to pass on, a reminder to those who have not signed. */
export function Batches({ focus }: { focus: string | null }) {
  const [list, setList] = useState<BatchRow[]>([]);
  const [open, setOpen] = useState<string | null>(focus);
  const [rows, setRows] = useState<BatchPerson[]>([]);
  const [msg, setMsg] = useState('');
  const [smsReady, setSmsReady] = useState(false);
  const [bySms, setBySms] = useState(false);
  useEffect(() => { void api<{ ready: boolean }>('GET', '/forms/sms').then((r) => setSmsReady(r.ready)).catch(() => undefined); }, []);
  const load = async () => setList(await api<BatchRow[]>('GET', '/forms/batches').catch(() => []));
  useEffect(() => { void load(); }, [focus]);
  useEffect(() => { setOpen(focus); }, [focus]);
  useEffect(() => { if (open) void api<BatchPerson[]>('GET', `/forms/batches/${open}`).then(setRows).catch(() => setRows([])); }, [open]);
  useEffect(() => { if (!list.some((b) => !b.done)) return; const t = setInterval(() => { void load(); if (open) void api<BatchPerson[]>('GET', `/forms/batches/${open}`).then(setRows).catch(() => undefined); }, 5000); return () => clearInterval(t); }, [list, open]);
  if (!list.length) return null;
  const csv = () => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [['שם', 'טלפון', 'מצב', 'משלוח', 'קישור'].map(esc).join(','), ...rows.map((r) => [r.signerName ?? '', r.signerPhone ?? '', FORM_STATUS[r.status], DELIVERY[r.delivery ?? ''] ?? '', r.link ?? ''].map(esc).join(','))];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })); a.download = 'form-links.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  async function remind(id: string) {
    setMsg('');
    try {
      const r = await api<{ reminded: number; skipped: number; bySms?: number; smsFailed?: number }>('POST', `/forms/batches/${id}/remind`, { sms: smsReady && bySms });
      setMsg(`נשלחו ${r.reminded} תזכורות${r.bySms ? ` (מהן ${r.bySms} ב-SMS)` : ''}${r.skipped ? `, ${r.skipped} לא נשלחו${r.smsFailed ? ' (חלקן: SMS נכשל, ביקשו להפסיק לקבל הודעות, או שהגעתם למגבלה החודשית)' : ' (מחוץ לחלון התגובה)'}` : ''}. תזכורת נשלחת לכל אחד לכל היותר פעם ביום.`);
    }
    catch (e) { setMsg(errText(e instanceof ApiError ? e.code : 'generic')); }
  }
  return (
    <section className="card" aria-labelledby="fbl-h">
      <h2 id="fbl-h">שליחות לקבוצה</h2>
      {smsReady && <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={bySms} onChange={(e) => setBySms(e.target.checked)} /> בתזכורות: גם ב-SMS למי שלא ניתן להגיע אליו בווצאפ</label>}
      <ul className="form-tpls">
        {list.map((b) => (
          <li key={b.id}>
            <div><strong>{b.title}</strong> <span className="hint">· {new Date(b.createdAt).toLocaleDateString('he-IL')} · {b.channelLabel ?? ''}</span>
              <div className="batch-bar" role="img" aria-label={`נחתמו ${b.signed} מתוך ${b.total}`}><span style={{ width: `${b.total ? (b.signed / b.total) * 100 : 0}%` }} /></div>
              <div className="hint">נחתמו {b.signed} מתוך {b.total} · נשלחו {b.delivered}{b.linkOnly ? ` · קישורים להעברה ${b.linkOnly}` : ''}{b.failed ? ` · נכשלו ${b.failed}` : ''}{b.queued ? ` · בתור ${b.queued}` : ''}</div></div>
            <div className="row"><button type="button" aria-expanded={open === b.id} onClick={() => setOpen(open === b.id ? null : b.id)}>{open === b.id ? 'הסתרה' : 'מי חתם ומי לא'}<span className="sr-only"> {b.title}</span></button>
              <button type="button" disabled={b.signed >= b.total} onClick={() => void remind(b.id)}>תזכורת למי שלא חתם<span className="sr-only"> {b.title}</span></button></div>
          </li>
        ))}
      </ul>
      {msg && <p role="status">{msg}</p>}
      {open && rows.length > 0 && (
        <>
          <div className="row"><button type="button" onClick={csv}>הורדת הרשימה עם הקישורים (CSV)</button></div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <caption className="sr-only">האנשים בקבוצה ומצבם</caption>
              <thead><tr><th scope="col">שם</th><th scope="col">טלפון</th><th scope="col">משלוח</th><th scope="col">מצב</th><th scope="col">קישור</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">{r.signerName ?? '—'}</th><td dir="ltr">{r.signerPhone}</td>
                    <td>{DELIVERY[r.delivery ?? ''] ?? '—'}{r.deliveryDetail ? <div className="hint">{WHY[r.deliveryDetail] ?? r.deliveryDetail}</div> : null}</td>
                    <td><span className={`mchip fs-${r.status}`}>{FORM_STATUS[r.status]}</span></td>
                    <td>{r.status === 'signed' ? <a className="linklike" href={`/forms/requests/${r.id}/signed.pdf`}>הורדה<span className="sr-only"> של {r.signerName}</span></a>
                      : r.link ? <button type="button" onClick={() => void navigator.clipboard?.writeText(r.link!).then(() => setMsg(`הקישור של ${r.signerName ?? r.signerPhone} הועתק.`))}>העתקת קישור<span className="sr-only"> של {r.signerName}</span></button> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
