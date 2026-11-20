import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { api, ApiError } from '../api';
import { errText } from '../strings';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * QR stickers for lab doors: each place gets a code; scanning opens a page that leads to Betty (website chat or WhatsApp) with the
 * place already attached, so a hazard report arrives with its exact location and goes to the officer of that building.
 */
interface Place { id: string; code: string; building: string; room: string; label: string; active: boolean; scans: number; lastScanAt: string | null }
interface Targets { whatsappNumber: string; webchatKey: string }
interface Data { places: Place[]; targets: Targets; sites: { key: string; label: string }[] }
const placeText = (p: Pick<Place, 'building' | 'room' | 'label'>) => [p.label, p.building && `בניין ${p.building}`, p.room && `חדר ${p.room}`].filter(Boolean).join(', ');
const urlOf = (code: string) => `${location.origin}/q/${code}`;

/** The A4 sheet that is printed: only it shows on paper (see .qr-print-sheet in styles.css). */
function PrintSheet({ items, onDone }: { items: { p: Place; qr: string }[]; onDone: () => void }) {
  useEffect(() => {
    document.body.classList.add('print-qr');
    const done = () => { document.body.classList.remove('print-qr'); onDone(); };
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => window.print(), 150);   // the images are in place before the print dialog opens
    return () => { clearTimeout(t); window.removeEventListener('afterprint', done); document.body.classList.remove('print-qr'); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div className="qr-print-sheet" dir="rtl" lang="he" aria-hidden="true">
      {items.map(({ p, qr }) => (
        <div className="qr-sticker" key={p.id}>
          <p className="qr-head">יחידת הבטיחות · בטי</p>
          <img src={qr} alt="" width={200} height={200} />
          <p className="qr-cta">סרקו לדיווח מפגע או לשאלת בטיחות</p>
          <p className="qr-place">📍 {placeText(p)}</p>
          <p className="qr-code">קוד מיקום: <span dir="ltr">{p.code}</span></p>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function Places({ canEdit }: { canEdit: boolean }) {
  const [d, setD] = useState<Data | null>(null);
  const [form, setForm] = useState({ building: '', room: '', label: '' });
  const [edit, setEdit] = useState<Place | null>(null);
  const [targets, setTargets] = useState<Targets>({ whatsappNumber: '', webchatKey: '' });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [del, setDel] = useState<Place | null>(null);
  const [printing, setPrinting] = useState<{ p: Place; qr: string }[] | null>(null);
  const [preview, setPreview] = useState<{ p: Place; qr: string } | null>(null);
  const load = async () => {
    const x = await api<Data>('GET', '/places').catch(() => null);
    setD(x);
    if (x) setTargets(x.targets);
  };
  useEffect(() => { void load(); }, []);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try { await fn(); await load(); if (ok) setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
  };
  const qrFor = (p: Place) => QRCode.toDataURL(urlOf(p.code), { margin: 1, width: 400, errorCorrectionLevel: 'M' });
  const print = async (list: Place[]) => {
    if (!list.length) return;
    setPrinting(await Promise.all(list.map(async (p) => ({ p, qr: await qrFor(p) }))));
  };

  if (!d) return null;
  const active = d.places.filter((p) => p.active);
  const noTarget = !d.targets.whatsappNumber && !d.targets.webchatKey;
  return (
    <section aria-labelledby="qr-h">
      <h2 id="qr-h">מדבקות QR לדלתות</h2>
      <p className="hint">מדביקים על דלת מעבדה. מי שסורק מגיע לבטי (בצ׳אט באתר או בווצאפ), והמיקום מצורף לפנייה אוטומטית: בטי לא שואלת איפה, והפנייה מגיעה לממונה של הבניין. המיקום לא נשמר בכרטיס של הפונה. נספרות רק כמות הסריקות, בלי פרטים מזהים.</p>

      <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={(e: FormEvent) => { e.preventDefault(); void act(() => api('PUT', '/places/targets', targets), 'נשמר.'); }}>
        <div className="field"><label htmlFor="qr-wa">מספר WhatsApp של היחידה (לא חובה)</label>
          <input id="qr-wa" dir="ltr" inputMode="tel" maxLength={20} placeholder="972501234567" disabled={!canEdit} value={targets.whatsappNumber} onChange={(e) => setTargets({ ...targets, whatsappNumber: e.target.value })} /></div>
        <div className="field"><label htmlFor="qr-site">צ׳אט באתר (לא חובה)</label>
          <select id="qr-site" disabled={!canEdit} value={targets.webchatKey} onChange={(e) => setTargets({ ...targets, webchatKey: e.target.value })}>
            <option value="">ללא</option>
            {d.sites.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select></div>
        {canEdit && <button type="submit">שמירת יעדים</button>}
      </form>
      {noTarget && <p className="mt-warn" role="note">עדיין לא נבחר לאן המדבקות מובילות: בחרו מספר WhatsApp או צ׳אט באתר.</p>}

      {canEdit && (
        <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '.75rem' }} onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void act(async () => { await api('POST', '/places', form); setForm({ building: '', room: '', label: '' }); }, 'המיקום נוסף.');
        }}>
          <div className="field"><label htmlFor="qr-l">תיאור</label><input id="qr-l" maxLength={120} placeholder="מעבדה לכימיה אורגנית" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></div>
          <div className="field"><label htmlFor="qr-b">בניין</label><input id="qr-b" maxLength={80} value={form.building} onChange={(e) => setForm({ ...form, building: e.target.value })} /></div>
          <div className="field"><label htmlFor="qr-r">חדר</label><input id="qr-r" maxLength={40} value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })} /></div>
          <button type="submit" className="primary" disabled={!form.building.trim() && !form.room.trim() && !form.label.trim()}>הוספת מיקום</button>
        </form>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}

      {d.places.length === 0 ? <p className="hint">עדיין אין מיקומים.</p> : (
        <>
          <div className="row" style={{ gap: '.5rem', flexWrap: 'wrap', margin: '.5rem 0' }}>
            <button type="button" onClick={() => void print(active)} disabled={!active.length}>הדפסת כל המדבקות הפעילות ({active.length})</button>
            <button type="button" onClick={() => void print(active.filter((p) => sel.has(p.id)))} disabled={!active.some((p) => sel.has(p.id))}>הדפסת המסומנות ({active.filter((p) => sel.has(p.id)).length})</button>
          </div>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">מיקומים עם מדבקת QR</caption>
              <thead><tr><th scope="col"><span className="sr-only">סימון להדפסה</span></th><th scope="col">מיקום</th><th scope="col">קוד</th><th scope="col">סריקות</th><th scope="col">מצב</th><th scope="col"><span className="sr-only">פעולות</span></th></tr></thead>
              <tbody>
                {d.places.map((p) => (
                  <tr key={p.id}>
                    <td><input type="checkbox" aria-label={`סימון להדפסה: ${placeText(p)}`} checked={sel.has(p.id)} disabled={!p.active}
                      onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(p.id); else n.delete(p.id); setSel(n); }} /></td>
                    <td>{edit?.id === p.id ? (
                      <form className="row" style={{ flexWrap: 'wrap', gap: '.3rem' }} onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('PATCH', `/places/${p.id}`, { label: edit.label, building: edit.building, room: edit.room }); setEdit(null); }, 'נשמר.'); }}>
                        <label className="sr-only" htmlFor={`qe-l-${p.id}`}>תיאור</label><input id={`qe-l-${p.id}`} maxLength={120} value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} />
                        <label className="sr-only" htmlFor={`qe-b-${p.id}`}>בניין</label><input id={`qe-b-${p.id}`} maxLength={80} value={edit.building} onChange={(e) => setEdit({ ...edit, building: e.target.value })} placeholder="בניין" />
                        <label className="sr-only" htmlFor={`qe-r-${p.id}`}>חדר</label><input id={`qe-r-${p.id}`} maxLength={40} value={edit.room} onChange={(e) => setEdit({ ...edit, room: e.target.value })} placeholder="חדר" />
                        <button type="submit" className="primary sm">שמירה</button><button type="button" className="ghost sm" onClick={() => setEdit(null)}>ביטול</button>
                      </form>
                    ) : placeText(p)}</td>
                    <td dir="ltr" style={{ fontFamily: 'monospace' }}>{p.code}</td>
                    <td>{p.scans}</td>
                    <td>{p.active ? 'פעילה' : 'מושבתת'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="sm" onClick={async () => setPreview({ p, qr: await qrFor(p) })}>תצוגה<span className="sr-only"> – {placeText(p)}</span></button>
                      {canEdit && <>
                        {' '}<button type="button" className="sm" onClick={() => setEdit(p)}>עריכה<span className="sr-only"> – {placeText(p)}</span></button>
                        {' '}<button type="button" className="sm" onClick={() => void act(() => api('PATCH', `/places/${p.id}`, { active: !p.active }), p.active ? 'המדבקה הושבתה: סריקה שלה כבר לא מצרפת מיקום.' : 'המדבקה הופעלה.')}>{p.active ? 'השבתה' : 'הפעלה'}<span className="sr-only"> – {placeText(p)}</span></button>
                        {' '}<button type="button" className="sm danger" onClick={() => setDel(p)}>מחיקה<span className="sr-only"> – {placeText(p)}</span></button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {preview && (
        <div className="qr-preview" role="group" aria-label={`מדבקה: ${placeText(preview.p)}`}>
          <img src={preview.qr} alt={`קוד QR שמוביל אל ${urlOf(preview.p.code)}`} width={180} height={180} />
          <div>
            <p><strong>{placeText(preview.p)}</strong></p>
            <p className="hint" dir="ltr" style={{ overflowWrap: 'anywhere' }}>{urlOf(preview.p.code)}</p>
            <div className="row" style={{ gap: '.4rem', flexWrap: 'wrap' }}>
              <a className="btn" href={preview.qr} download={`qr-${preview.p.code}.png`}>הורדת תמונה</a>
              <a className="btn" href={urlOf(preview.p.code)} target="_blank" rel="noopener noreferrer">פתיחת דף הסריקה<span className="sr-only"> (בחלון חדש)</span></a>
              <button type="button" onClick={() => setPreview(null)}>סגירה</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog open={!!del} danger title="מחיקת מיקום" confirmLabel="מחיקה"
        message={del ? `למחוק את "${placeText(del)}"? מדבקה שכבר הודבקה תפסיק לצרף מיקום. כדי לעצור זמנית אפשר להשבית במקום למחוק.` : ''}
        onCancel={() => setDel(null)} onConfirm={() => { const p = del!; setDel(null); void act(() => api('DELETE', `/places/${p.id}`), 'המיקום נמחק.'); }} />
      {printing && <PrintSheet items={printing} onDone={() => setPrinting(null)} />}
    </section>
  );
}
