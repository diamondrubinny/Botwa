import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, can, FORM_AUDIENCES, FORM_FIELD_TYPES, FORM_STATUS, type FormRequestRow, type FormTemplate, type Me } from '../api';
import { FormEditor } from '../components/FormEditor';
import { BatchPanel, Batches } from '../components/FormBatch';
import { PageTitle } from '../components/Illustration';
import { errText } from '../strings';

const SAFETY_FORMS_PAGE = 'https://safety.net.technion.ac.il/%d7%98%d7%a4%d7%a1%d7%99%d7%9d-%d7%95%d7%93%d7%99%d7%95%d7%95%d7%97%d7%99%d7%9d-2/';
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Digital forms: what was sent and signed (everyone, by what they may see), templates (forms managers), checking a signed file. */
export function Forms({ me }: { me: Me }) {
  const manager = can(me, 'forms.manage');
  const [tab, setTab] = useState<'sent' | 'templates' | 'verify'>('sent');
  const [editing, setEditing] = useState<string | null>(null);
  const [batchFor, setBatchFor] = useState<FormTemplate | null>(null);
  const [focusBatch, setFocusBatch] = useState<string | null>(null);
  const tabs: [typeof tab, string][] = [['sent', 'טפסים שנשלחו'], ...(manager ? [['templates', 'תבניות'] as [typeof tab, string]] : []), ['verify', 'בדיקת קובץ חתום']];
  return (
    <>
      <PageTitle title="טפסים וחתימה דיגיטלית" art="done" />
      <div className="chips" role="group" aria-label="אזורים">
        {tabs.map(([k, l]) => <button key={k} className="chip" aria-pressed={tab === k} onClick={() => { setTab(k); setEditing(null); }}>{l}</button>)}
      </div>
      {editing ? <FormEditor templateId={editing} onClose={() => setEditing(null)} />
        : batchFor ? <BatchPanel tpl={batchFor} onClose={() => setBatchFor(null)} onDone={(id) => { setFocusBatch(id); setBatchFor(null); setTab('sent'); }} />
        : tab === 'templates' ? <Templates onEdit={setEditing} onBatch={setBatchFor} />
        : tab === 'verify' ? <VerifyFile />
        : <>{manager && <Batches focus={focusBatch} />}<Sent /></>}
    </>
  );
}

function Templates({ onEdit, onBatch }: { onEdit: (id: string) => void; onBatch: (t: FormTemplate) => void }) {
  const [list, setList] = useState<FormTemplate[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [aud, setAud] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [pageUrl, setPageUrl] = useState(SAFETY_FORMS_PAGE);
  const [found, setFound] = useState<{ url: string; title: string; kind: 'pdf' | 'word'; imported: boolean }[] | null>(null);
  const [word, setWord] = useState<{ word: boolean; installed: boolean } | null>(null);
  const load = async () => setList(await api<FormTemplate[]>('GET', '/forms/templates').catch(() => []));
  useEffect(() => { void load(); void api<{ word: boolean; installed: boolean }>('GET', '/forms/converter').then(setWord).catch(() => setWord(null)); }, []);
  const fail = (e: unknown) => setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') });

  async function upload(e: FormEvent) {
    e.preventDefault(); if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData(); fd.append('title', title.trim()); fd.append('audience', aud.join(',')); fd.append('file', file);
      const res = await fetch('/forms/templates', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, (j as { error?: string }).error ?? 'error');
      setMsg({ ok: true, text: `התבנית נוצרה עם ${(j as FormTemplate).fields.length} שדות מוצעים. בדקו אותם בעורך.` });
      setTitle(''); setFile(null); setAud([]); await load(); onEdit((j as FormTemplate).id);
    } catch (er) { fail(er); } finally { setBusy(false); }
  }
  async function discover(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null); setFound(null);
    try { setFound((await api<{ forms: NonNullable<typeof found> }>('GET', `/forms/discover?url=${encodeURIComponent(pageUrl)}`)).forms); }
    catch (er) { fail(er); } finally { setBusy(false); }
  }
  async function importOne(f: { url: string; title: string }, i: number) {
    setBusy(true); setMsg(null);
    try {
      const t = await api<FormTemplate>('POST', '/forms/templates/import', { url: f.url, title: f.title, audience: [] });
      setFound((l) => l?.map((x, k) => (k === i ? { ...x, imported: true } : x)) ?? null);
      setMsg({ ok: true, text: `"${t.title}" יובא עם ${t.fields.length} שדות מוצעים.` }); await load();
    } catch (er) { fail(er); } finally { setBusy(false); }
  }
  async function toggle(t: FormTemplate) { try { await api('PATCH', `/forms/templates/${t.id}`, { active: !t.active }); await load(); } catch (er) { fail(er); } }
  async function del(t: FormTemplate) {
    if (!window.confirm(`למחוק את התבנית "${t.title}"?`)) return;
    try { await api('DELETE', `/forms/templates/${t.id}`); await load(); } catch (er) { fail(er); }
  }

  return (
    <>
      {msg && <p role="status" className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      <section className="card" aria-labelledby="ft-h">
        <h2 id="ft-h">תבניות ({list.length})</h2>
        {!list.length ? <p className="hint">אין עדיין תבניות. העלו קובץ PDF או ייבאו מאתר יחידת הבטיחות.</p> : (
          <ul className="form-tpls">
            {list.map((t) => (
              <li key={t.id} className={t.active ? '' : 'off'}>
                <div><strong>{t.title}</strong> {!t.active && <span className="mchip muted">כבויה</span>}
                  <div className="hint">{t.fields.length} שדות · {typeof t.pages === 'number' ? t.pages : t.pages.length} עמודים · נשלח {t.requests ?? 0} · נחתם {t.signed ?? 0}{t.audience.length ? ` · ${t.audience.map((a) => FORM_AUDIENCES[a] ?? a).join(', ')}` : ''}</div>
                  {!t.fields.some((f) => f.type === 'signature' || f.type === 'initials') && <div className="hint warn-text">אין בתבנית שדה חתימה.</div>}</div>
                <div className="row">
                  <button type="button" onClick={() => onEdit(t.id)}>עריכת שדות<span className="sr-only"> {t.title}</span></button>
                  {t.active && t.fields.length > 0 && <button type="button" onClick={() => onBatch(t)}>שליחה לקבוצה<span className="sr-only"> {t.title}</span></button>}
                  <a className="btn-link" href={`/forms/templates/${t.id}/source.pdf`} target="_blank" rel="noopener">המקור<span className="sr-only"> של {t.title}</span></a>
                  <button type="button" onClick={() => void toggle(t)}>{t.active ? 'כיבוי' : 'הפעלה'}<span className="sr-only"> {t.title}</span></button>
                  {!t.requests && <button type="button" className="danger" onClick={() => void del(t)}>מחיקה<span className="sr-only"> {t.title}</span></button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form className="card" onSubmit={upload} aria-labelledby="fu-h">
        <h2 id="fu-h">תבנית חדשה מקובץ {word?.word ? 'PDF או Word' : 'PDF'}</h2>
        <p className="hint">המערכת מזהה לבד שדות לפי הכיתוב בטופס (שם, ת.ז., תאריך, טלפון, חתימה, קווים ריקים), ואחר כך מתקנים בעורך.{' '}
          {word?.word ? 'קובץ Word (docx) מומר ל-PDF בממיר המבודד בשרת לפני היצירה.'
            : word?.installed ? 'ממיר ה-Word מותקן אבל לא עונה כרגע. בינתיים אפשר להעלות PDF.'
            : 'קבצי Word: המירו ל-PDF (שמירה בשם ← PDF), או התקינו בשרת את ממיר ה-Word: sudo bash scripts/enable-office.sh'}</p>
        <div className="field"><label htmlFor="fu-file">קובץ {word?.word ? 'PDF או Word (docx)' : 'PDF'} (עד 10MB)</label><input id="fu-file" type="file" accept={word?.word ? 'application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf,.pdf'} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        <div className="field"><label htmlFor="fu-title">שם הטופס</label><input id="fu-title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ריק = לפי שם הקובץ" /></div>
        <fieldset><legend>למי הטופס מיועד (לא חובה)</legend>
          <div className="row">{Object.entries(FORM_AUDIENCES).map(([k, v]) => <label key={k} style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={aud.includes(k)} onChange={(e) => setAud((l) => (e.target.checked ? [...l, k] : l.filter((x) => x !== k)))} /> {v}</label>)}</div></fieldset>
        <button className="primary" type="submit" disabled={busy || !file}>{busy ? 'קורא את הטופס…' : 'יצירת תבנית'}</button>
      </form>

      <section className="card" aria-labelledby="fd-h">
        <h2 id="fd-h">ייבוא מאתר</h2>
        <p className="hint">מוצאת את הטפסים שמקושרים מדף באתר (כברירת מחדל דף "טפסים ודיווחים" של יחידת הבטיחות), ומייבאת את מי שתבחרו. כל קובץ נסרק לפני השמירה.</p>
        <form className="row" onSubmit={discover}>
          <label htmlFor="fd-url" className="sr-only">כתובת הדף</label>
          <input id="fd-url" type="url" dir="ltr" required value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} style={{ flex: '1 1 320px' }} />
          <button type="submit" disabled={busy}>חיפוש טפסים בדף</button>
        </form>
        {found && (found.length === 0 ? <p>לא נמצאו קישורים לקובצי PDF או Word בדף.</p> : (
          <ul className="plain form-found">
            {found.map((f, i) => (
              <li key={f.url}>
                <span>{f.title} <span className="mchip">{f.kind === 'pdf' ? 'PDF' : 'Word'}</span></span>
                {f.imported ? <span className="mchip ok-chip">יובא</span>
                  : f.kind === 'pdf' || word?.word ? <button type="button" disabled={busy} onClick={() => void importOne(f, i)}>ייבוא<span className="sr-only"> {f.title}</span></button>
                  : <span className="hint">Word: צריך את ממיר ה-Word בשרת, או להמיר ל-PDF ולהעלות למעלה</span>}
              </li>
            ))}
          </ul>
        ))}
      </section>
    </>
  );
}

interface ReqDetail extends FormRequestRow { values: Record<string, unknown> | null; fields: { id: string; label: string; type: string }[]; events: { kind: string; detail: string | null; at: string }[] }
const EVENT: Record<string, string> = { sent: 'נשלח', opened: 'נפתח', otp_sent: 'נשלח קוד אימות', otp_wrong: 'קוד שגוי', verified: 'אומת', signed: 'נחתם', copy_sent: 'עותק נשלח לצ׳אט', copy_failed: 'שליחת העותק נכשלה', expired: 'פג תוקף', cancelled: 'בוטל' };

function Sent() {
  const [rows, setRows] = useState<FormRequestRow[]>([]);
  const [tpls, setTpls] = useState<FormTemplate[]>([]);
  const [f, setF] = useState({ templateId: '', status: '', q: '' });
  const [open, setOpen] = useState<ReqDetail | null>(null);
  const [msg, setMsg] = useState('');
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
    setRows(await api<FormRequestRow[]>('GET', `/forms/requests${qs ? `?${qs}` : ''}`).catch(() => []));
  };
  useEffect(() => { void load(); }, [f.templateId, f.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void api<FormTemplate[]>('GET', '/forms/templates').then(setTpls).catch(() => undefined); }, []);
  async function details(id: string) { try { setOpen(await api<ReqDetail>('GET', `/forms/requests/${id}`)); } catch (e) { setMsg(errText(e instanceof ApiError ? e.code : 'generic')); } }
  async function cancel(id: string) { if (!window.confirm('לבטל את הבקשה? הקישור יפסיק לעבוד.')) return; try { await api('POST', `/forms/requests/${id}/cancel`); await load(); setOpen(null); } catch (e) { setMsg(errText(e instanceof ApiError ? e.code : 'generic')); } }
  const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});

  return (
    <>
      <section className="card" aria-labelledby="fs-h">
        <h2 id="fs-h">טפסים שנשלחו</h2>
        <p className="hint">שולחים טופס מתוך שיחה (כפתור "שליחת טופס לחתימה"). כאן רואים מי חתם ומי עוד לא, ומורידים את הקובץ החתום.</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <div className="field"><label htmlFor="fs-t">תבנית</label><select id="fs-t" value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}><option value="">כולן</option>{tpls.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></div>
          <div className="field"><label htmlFor="fs-s">מצב</label><select id="fs-s" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">הכול</option>{Object.entries(FORM_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field"><label htmlFor="fs-q">חיפוש (שם, טלפון, מספר)</label><input id="fs-q" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></div>
          <button type="submit">חיפוש</button>
        </form>
        <p role="status" className="hint">{rows.length} בקשות{rows.length ? ` · ${Object.entries(counts).map(([k, n]) => `${FORM_STATUS[k as FormRequestRow['status']]} ${n}`).join(' · ')}` : ''}</p>
        {msg && <p role="alert" className="error">{msg}</p>}
        {rows.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <caption className="sr-only">הטפסים שנשלחו</caption>
              <thead><tr><th scope="col">מס׳</th><th scope="col">טופס</th><th scope="col">חותם</th><th scope="col">מצב</th><th scope="col">נשלח</th><th scope="col">נחתם</th><th scope="col">פעולות</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.number}</td><th scope="row">{r.title}</th>
                    <td>{r.signerName ?? '—'}<div className="hint" dir="ltr">{r.signerPhone}</div></td>
                    <td><span className={`mchip fs-${r.status}`}>{FORM_STATUS[r.status]}</span></td>
                    <td>{when(r.createdAt)}<div className="hint">{r.sentBy}</div></td>
                    <td>{when(r.signedAt)}</td>
                    <td className="row">
                      {r.status === 'signed' && <a className="btn-link" href={`/forms/requests/${r.id}/signed.pdf`}>הורדה<span className="sr-only"> של {r.title} {r.number}</span></a>}
                      <button type="button" onClick={() => void details(r.id)}>פרטים<span className="sr-only"> {r.number}</span></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open && (
        <section className="card" aria-labelledby="fr-h">
          <h2 id="fr-h">{open.title} · בקשה {open.number}</h2>
          <p>מצב: <strong>{FORM_STATUS[open.status]}</strong> · חותם: {open.signerName ?? '—'} · בתוקף עד {when(open.expiresAt)}</p>
          {open.values && (
            <>
              <h3>מה מולא</h3>
              <dl className="form-values">{open.fields.filter((x) => x.type !== 'signature' && x.type !== 'initials').map((x) => <div key={x.id}><dt>{x.label}</dt><dd dir="auto">{open.values![x.id] === true ? '✓' : open.values![x.id] === false ? '✗' : String(open.values![x.id] ?? '—')}</dd></div>)}</dl>
            </>
          )}
          {open.sha256 && <p className="hint">טביעת הקובץ (SHA-256): <code dir="ltr">{open.sha256}</code></p>}
          <h3>מה קרה</h3>
          <ol className="plain">{open.events.map((e, i) => <li key={i}>{when(e.at)} · {EVENT[e.kind] ?? e.kind}</li>)}</ol>
          <div className="row">
            {['sent', 'opened', 'verified'].includes(open.status) && <button type="button" className="danger" onClick={() => void cancel(open.id)}>ביטול הבקשה</button>}
            <button type="button" onClick={() => setOpen(null)}>סגירה</button>
          </div>
        </section>
      )}
    </>
  );
}

function VerifyFile() {
  const [res, setRes] = useState<{ match: boolean; sha256: string; title?: string; number?: number; signerName?: string; signedAt?: string } | null>(null);
  const [err, setErr] = useState('');
  async function check(f: File) {
    setErr(''); setRes(null);
    const fd = new FormData(); fd.append('file', f);
    const r = await fetch('/forms/verify', { method: 'POST', credentials: 'same-origin', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setErr(errText((j as { error?: string }).error ?? 'generic')); else setRes(j as typeof res);
  }
  return (
    <section className="card" aria-labelledby="fv-h">
      <h2 id="fv-h">בדיקת קובץ חתום</h2>
      <p className="hint">העלו עותק של טופס חתום כדי לבדוק שהוא בדיוק הקובץ שהמערכת הפיקה, בלי שום שינוי (השוואת טביעת SHA-256). הקובץ לא נשמר.</p>
      <div className="field"><label htmlFor="fv-f">קובץ PDF</label><input id="fv-f" type="file" accept="application/pdf,.pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) void check(f); }} /></div>
      {err && <p role="alert" className="error">{err}</p>}
      {res && (res.match
        ? <p role="status" className="ok">✓ הקובץ מקורי: "{res.title}", בקשה {res.number}, נחתם ע״י {res.signerName ?? '—'} ב-{when(res.signedAt ?? null)}.</p>
        : <p role="status" className="error">✗ הקובץ לא תואם לאף טופס חתום במערכת. ייתכן שהוא שונה, או שזה לא הקובץ המקורי.</p>)}
      {res && <p className="hint">טביעה: <code dir="ltr">{res.sha256}</code></p>}
      <p className="hint">סוגי שדות שהעורך מכיר: {Object.values(FORM_FIELD_TYPES).join(', ')}.</p>
    </section>
  );
}
