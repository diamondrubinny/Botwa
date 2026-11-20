import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

interface Result { dryRun: boolean; rows: number; created: number; named: number; unchanged: number; duplicates: number; invalidCount: number; invalid: { row: number; reason: string }[] }
const ERR: Record<string, string> = {
  missing_phone_column: 'לא נמצאה עמודת טלפון. שורת הכותרת צריכה לכלול "phone" או "טלפון" (ואפשר גם "name" או "שם").',
  unsupported_channel: 'אפשר לייבא רק לערוצי וואטסאפ.',
  too_many_rows: 'הקובץ גדול מדי (עד 5,000 שורות בכל ייבוא).',
  bad_request: 'הקובץ ריק או גדול מדי (עד 1MB).',
};

/** Import (with a preview first) and export of the contacts list. Import adds names only: it never opens a conversation or permits messaging anyone. */
export function ContactsCsv() {
  const [channels, setChannels] = useState<{ id: string; label: string; type: string }[]>([]);
  const [channelId, setChannelId] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ id: string; label: string; type: string }[]>('GET', '/channels').then((l) => {
      const wa = l.filter((c) => c.type === 'whatsapp' || c.type === 'whatsapp_cloud');
      setChannels(wa); setChannelId(wa[0]?.id ?? '');
    }).catch(() => undefined);
  }, []);
  async function run(dryRun: boolean) {
    setBusy(true); setMsg(null);
    try {
      const r = await api<Result>('POST', '/contacts/import', { channelId, csv, dryRun });
      setRes(r);
      if (!dryRun) { setMsg({ ok: true, text: `הייבוא הושלם: ${r.created} חדשים, ${r.named} שמות עודכנו.` }); setCsv(''); setFileName(''); }
    } catch (e) { setRes(null); setMsg({ ok: false, text: e instanceof ApiError ? ERR[e.code] ?? 'הייבוא נכשל.' : 'הייבוא נכשל.' }); }
    setBusy(false);
  }
  return (
    <section className="card" aria-labelledby="csv-h">
      <h2 id="csv-h">אנשי קשר: ייבוא וייצוא</h2>
      <p className="hint">הייבוא מוסיף רק שמות למספרי וואטסאפ. הוא אינו פותח שיחות ואינו מתיר לכתוב ללקוחות: אפשר לכתוב רק למי שפנה אליכם לאחרונה ולא ביקש להפסיק. ודאו שיש לכם בסיס חוקי לשמור את הרשימה. העמודות: <code dir="ltr">phone,name</code> (או טלפון, שם). מספרים מקומיים (05…) נחשבים ישראליים.</p>
      <p><a className="btn" href="/contacts/export.csv" download>ייצוא כל אנשי הקשר ל-CSV</a></p>
      {channels.length === 0 ? <p>אין ערוץ וואטסאפ לייבוא אליו.</p> : (
        <>
          <div className="field"><label htmlFor="csv-ch">ערוץ</label>
            <select id="csv-ch" value={channelId} onChange={(e) => setChannelId(e.target.value)}>{channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
          <div className="field"><label htmlFor="csv-file">קובץ CSV</label>
            <input id="csv-file" type="file" accept=".csv,text/csv,text/plain" onChange={async (e) => {
              const f = e.target.files?.[0]; setRes(null); setMsg(null);
              if (!f) { setCsv(''); setFileName(''); return; }
              if (f.size > 1_000_000) { setCsv(''); setMsg({ ok: false, text: ERR.bad_request! }); return; }
              setCsv(await f.text()); setFileName(f.name);
            }} /></div>
          <div className="row">
            <button type="button" disabled={!csv || busy} onClick={() => void run(true)}>בדיקה מקדימה</button>
            <button type="button" className="primary" disabled={!csv || busy || !res || !res.dryRun} onClick={() => void run(false)}>ייבוא</button>
          </div>
        </>
      )}
      <p role={msg?.ok === false ? 'alert' : 'status'} className={msg?.ok === false ? 'error' : 'hint'}>{msg?.text}</p>
      {res && res.dryRun && (
        <div role="status">
          <p>{fileName}: {res.rows} שורות. {res.created} אנשי קשר חדשים, {res.named} שמות יתווספו, {res.unchanged} ללא שינוי, {res.duplicates} כפולים בקובץ, {res.invalidCount} שורות לא תקינות.</p>
          {res.invalid.length > 0 && <p className="hint">שורות לא תקינות (מספר טלפון שגוי): {res.invalid.map((i) => i.row).join(', ')}{res.invalidCount > res.invalid.length ? ' …' : ''}</p>}
          <p className="hint">לחצו "ייבוא" כדי לבצע בפועל.</p>
        </div>
      )}
    </section>
  );
}
