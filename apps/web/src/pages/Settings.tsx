import { useState, type FormEvent } from 'react';
import { api, ApiError, can, type BackupFile, type BusinessHours, type Me, type SendingCfg } from '../api';
import { Branding } from '../components/Branding';
import { SecurityPanel } from '../components/SecurityPanel';
import { LegalDocs } from '../components/LegalDocs';
import { ContactsCsv } from '../components/ContactsCsv';
import { ForwardRules } from '../components/ForwardRules';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePoll } from '../hooks';
import { errText } from '../strings';

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export function Settings({ me }: { me: Me }) {
  const canView = can(me, 'settings.view');
  const canEdit = can(me, 'settings.manage');
  const canBackup = can(me, 'backups.manage');
  const [h, setH] = useState<BusinessHours | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [snd, setSnd] = useState<SendingCfg | null>(null);
  const [sndMsg, setSndMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [routing, setRouting] = useState<string>('off');
  const [routeMsg, setRouteMsg] = useState('');
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [bkMsg, setBkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [bkBusy, setBkBusy] = useState(false);
  const [delBk, setDelBk] = useState<string | null>(null);
  const loadBackups = async () => setBackups(await api<BackupFile[]>('GET', '/backups').catch(() => []));
  usePoll(async () => {
    const r = await api<{ mode: string }>('GET', '/settings/routing').catch(() => null);
    if (r) setRouting(r.mode);
    if (!snd) setSnd(await api<SendingCfg>('GET', '/settings/sending').catch(() => null));
    await loadBackups();
  }, 60000);
  const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  usePoll(async () => { if (!h) setH(await api<BusinessHours>('GET', '/settings/business-hours').catch(() => null)); }, 60000);


  const [sla, setSla] = useState<{ enabled: boolean; targetMinutes: number } | null>(null);
  const [slaMsg, setSlaMsg] = useState('');
  usePoll(async () => { if (!sla && canView) setSla(await api<{ enabled: boolean; targetMinutes: number }>('GET', '/settings/sla').catch(() => null)); }, 60000);

  if (canView && !h) return <><h1 tabIndex={-1}>הגדרות</h1><p role="status">טוען…</p></>;

  async function saveSla(e: FormEvent) {
    e.preventDefault(); setSlaMsg('');
    try { setSla(await api('PUT', '/settings/sla', sla)); setSlaMsg('יעד השירות נשמר.'); } catch { setSlaMsg('השמירה נכשלה. בדקו שהיעד בין 1 ל-10080 דקות.'); }
  }
  const setDay = (i: number, v: { open: string; close: string } | null) => h && setH({ ...h, days: h.days.map((d, k) => (k === i ? v : d)) });

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      setH(await api<BusinessHours>('PUT', '/settings/business-hours', h));
      setMsg({ ok: true, text: 'ההגדרות נשמרו.' });
    } catch (er) {
      setMsg({ ok: false, text: er instanceof ApiError && er.code === 'bad_request' ? 'הנתונים אינם תקינים (בדקו אזור זמן ושעות).' : errText('generic') });
    }
  }

  return (
    <>
      <h1 tabIndex={-1}>הגדרות</h1>
      {canView && !canEdit && <p className="banner" role="note">צפייה בלבד. אין לכם הרשאה לשנות הגדרות.</p>}
      {canView && h && (
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
      {sla && (
        <form className="card" onSubmit={saveSla} aria-labelledby="sla-h">
          <h2 id="sla-h">יעד זמן מענה (SLA)</h2>
          <p className="hint">כשלקוח ממתין לתשובת נציג יותר מהיעד, השיחה מסומנת "חריגה", נשלחת התראה (דחיפה לנציג המשויך או למנהלים, ואירוע <code dir="ltr">conversation.sla_breached</code> ל-Webhooks) והחריגה נספרת בדוח. הזמן נמדד ברציפות, גם מחוץ לשעות הפעילות. בוט ומענה אוטומטי אינם נחשבים מענה.</p>
          <div className="field"><label><input type="checkbox" role="switch" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={sla.enabled} onChange={(e) => setSla({ ...sla, enabled: e.target.checked })} />הפעלת התראות על חריגה מיעד</label></div>
          <div className="field"><label htmlFor="sla-min">יעד תגובה בדקות</label>
            <input id="sla-min" type="number" min={1} max={10080} required value={sla.targetMinutes} onChange={(e) => setSla({ ...sla, targetMinutes: Number(e.target.value) })} style={{ maxWidth: 140 }} /></div>
          <button className="primary" type="submit">שמירת יעד</button>
          <p role="status" className="hint">{slaMsg}</p>
        </form>
      )}
      <form className="card" onSubmit={save}>
        <h2>שעות פעילות ומענה אוטומטי</h2>
        <p className="hint">מחוץ לשעות הפעילות נשלחת ללקוח הודעה אוטומטית אחת (לכל היותר אחת ל-12 שעות לשיחה). ההודעה מסומנת כ"מענה אוטומטי" ואינה נחשבת תשובת נציג בדוחות.</p>
        <div className="field">
          <label><input type="checkbox" role="switch" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={h.enabled} onChange={(e) => setH({ ...h, enabled: e.target.checked })} />הפעלת מענה אוטומטי מחוץ לשעות</label>
        </div>
        <div className="field">
          <label htmlFor="tz">אזור זמן</label>
          <input id="tz" dir="ltr" value={h.timezone} onChange={(e) => setH({ ...h, timezone: e.target.value })} aria-describedby="tz-h" />
          <p id="tz-h" className="hint">למשל Asia/Jerusalem</p>
        </div>
        <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: '1rem' }}>
          <legend>ימים ושעות</legend>
          {DAYS.map((name, i) => {
            const d = h.days[i];
            return (
              <div key={name} className="row" style={{ marginBottom: '.5rem' }}>
                <span style={{ minWidth: 70 }}>{name}</span>
                <label style={{ fontWeight: 400, margin: 0 }}>
                  <input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.35rem' }} checked={d !== null}
                    onChange={(e) => setDay(i, e.target.checked ? { open: '09:00', close: '17:00' } : null)} aria-label={`${name}: פתוח`} />פתוח
                </label>
                {d && (
                  <>
                    <label htmlFor={`o${i}`} className="sr-only">פתיחה ביום {name}</label>
                    <input id={`o${i}`} type="time" style={{ width: 130 }} value={d.open} onChange={(e) => setDay(i, { ...d, open: e.target.value })} />
                    <span aria-hidden="true">–</span>
                    <label htmlFor={`c${i}`} className="sr-only">סגירה ביום {name}</label>
                    <input id={`c${i}`} type="time" style={{ width: 130 }} value={d.close} onChange={(e) => setDay(i, { ...d, close: e.target.value })} />
                  </>
                )}
              </div>
            );
          })}
        </fieldset>
        <div className="field">
          <label htmlFor="away">נוסח ההודעה האוטומטית</label>
          <textarea id="away" rows={3} maxLength={1000} required value={h.awayMessage} onChange={(e) => setH({ ...h, awayMessage: e.target.value })} />
        </div>
        <button className="primary" type="submit">שמירה</button>
        <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
      </form>

      {snd && (
        <section className="card" aria-labelledby="snd-h">
          <h2 id="snd-h">הגנה מחסימה: קצב שליחה</h2>
          <p className="hint">ווצאפ וטלגרם מגבילים חשבונות ששולחים הרבה הודעות במהירות. ההגדרות האלה גורמות למערכת להתנהג כמו אדם. הודעות שחורגות מהמכסה לא נשלחות (הנציג רואה הודעה). שליחת הודעות לפי דרישה היא בסדר; אל תשתמשו בזה לשיווק המוני.</p>
          <form onSubmit={async (e) => {
            e.preventDefault(); setSndMsg(null);
            try { setSnd(await api<SendingCfg>('PUT', '/settings/sending', snd)); setSndMsg({ ok: true, text: 'נשמר.' }); }
            catch { setSndMsg({ ok: false, text: 'השמירה נכשלה (בדקו שהמרווח המקסימלי גדול או שווה למינימלי).' }); }
          }}>
            <div className="row">
              <div className="field"><label htmlFor="s-min">מרווח מינימלי בין הודעות (מילישניות)</label><input id="s-min" type="number" min={0} max={60000} step={100} dir="ltr" value={snd.minDelayMs} onChange={(e) => setSnd({ ...snd, minDelayMs: Number(e.target.value) })} /></div>
              <div className="field"><label htmlFor="s-max">מרווח מקסימלי (מילישניות)</label><input id="s-max" type="number" min={0} max={120000} step={100} dir="ltr" value={snd.maxDelayMs} onChange={(e) => setSnd({ ...snd, maxDelayMs: Number(e.target.value) })} /></div>
              <div className="field"><label htmlFor="s-pm">מכסה לדקה</label><input id="s-pm" type="number" min={1} max={120} dir="ltr" value={snd.perMinute} onChange={(e) => setSnd({ ...snd, perMinute: Number(e.target.value) })} /></div>
              <div className="field"><label htmlFor="s-pd">מכסה ליום (לכל ערוץ)</label><input id="s-pd" type="number" min={1} max={20000} dir="ltr" value={snd.perDay} onChange={(e) => setSnd({ ...snd, perDay: Number(e.target.value) })} /></div>
            </div>
            <div className="row">
              <div className="field"><label htmlFor="s-rw">חלון מענה (שעות): לענות רק ללקוח שכתב בחלון הזה (0 = ללא הגבלה)</label><input id="s-rw" type="number" min={0} max={720} dir="ltr" value={snd.replyWindowHours} onChange={(e) => setSnd({ ...snd, replyWindowHours: Number(e.target.value) })} aria-describedby="s-rw-h" /><p id="s-rw-h" className="hint">הודעה יזומה ללקוח שלא פנה היא הסיבה העיקרית לחסימות. מומלץ להשאיר 168 (שבוע).</p></div>
              <div className="field"><label htmlFor="s-fp">עצירה אוטומטית אחרי כמה כשלי שליחה ברצף (0 = כבוי)</label><input id="s-fp" type="number" min={0} max={20} dir="ltr" value={snd.failuresBeforePause} onChange={(e) => setSnd({ ...snd, failuresBeforePause: Number(e.target.value) })} /></div>
              <div className="field"><label htmlFor="s-pm2">משך העצירה האוטומטית (דקות)</label><input id="s-pm2" type="number" min={1} max={1440} dir="ltr" value={snd.pauseMinutes} onChange={(e) => setSnd({ ...snd, pauseMinutes: Number(e.target.value) })} /></div>
            </div>
            <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={snd.readReceipts} onChange={(e) => setSnd({ ...snd, readReceipts: e.target.checked })} />לסמן הודעות לקוח כנקראו כשנציג פותח את השיחה</label></div>
            <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={snd.warmup} onChange={(e) => setSnd({ ...snd, warmup: e.target.checked })} />חימום למספר חדש (מכסה יומית מתחילה ב-20 ועולה ב-40 בכל יום)</label></div>
            <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={snd.typing} onChange={(e) => setSnd({ ...snd, typing: e.target.checked })} />להציג "מקליד…" בווצאפ לפני שליחה</label></div>
            <button className="primary" type="submit">שמירה</button>
            <p role="status" className={sndMsg?.ok ? 'ok' : 'error'}>{sndMsg?.text}</p>
          </form>
        </section>
      )}

      <section className="card" aria-labelledby="route-h">
        <h2 id="route-h">ניתוב אוטומטי של פניות חדשות</h2>
        <p className="hint">פניות חדשות (ושיחות ללא נציג שחוזרות) משויכות אוטומטית לנציגים שסימנו "זמין". מפקחים ומנהלים אינם מקבלים שיוך אוטומטי.</p>
        <div className="field" style={{ maxWidth: 360 }}>
          <label htmlFor="route">שיטת ניתוב</label>
          <select id="route" value={routing} onChange={async (e) => {
            const mode = e.target.value; setRouteMsg('');
            try { await api('PUT', '/settings/routing', { mode }); setRouting(mode); setRouteMsg('נשמר.'); } catch { setRouteMsg('השמירה נכשלה.'); }
          }}>
            <option value="off">כבוי (שיוך ידני)</option>
            <option value="round_robin">לפי תור (סבב)</option>
            <option value="least_busy">לפי העומס הנמוך ביותר</option>
          </select>
        </div>
        <p role="status" className="ok">{routeMsg}</p>
      </section>

      </fieldset>
      )}

      {canBackup && (<>
      <section className="card" aria-labelledby="bk-h">
        <h2 id="bk-h">גיבויים</h2>
        <p className="hint"><strong>גיבוי מלא</strong> כולל את מסד הנתונים (הודעות, משתמשים, הגדרות, מאגר ידע, חיבורי ערוצים) ואת כל הקבצים המצורפים, מוצפן במפתח של השרת. גיבוי אוטומטי יומי הוא גיבוי מלא. הורדת גיבוי נרשמת ביומן הביקורת. שחזור והעברה לשרת חדש מתבצעים בשרת (docs/MIGRATION.he.md).</p>
        <div className="row">
          {(['full', 'db'] as const).map((kind) => (
            <button key={kind} className={kind === 'full' ? 'primary' : undefined} disabled={bkBusy} onClick={async () => {
              setBkBusy(true); setBkMsg(null);
              try { await api('POST', '/backups', { kind }); setBkMsg({ ok: true, text: kind === 'full' ? 'הגיבוי המלא נוצר.' : 'גיבוי מסד הנתונים נוצר.' }); await loadBackups(); }
              catch { setBkMsg({ ok: false, text: 'יצירת הגיבוי נכשלה (ודאו ש-pg_dump זמין בשרת).' }); }
              finally { setBkBusy(false); }
            }}>{bkBusy ? 'מגבה…' : kind === 'full' ? 'גיבוי מלא עכשיו (מסד + קבצים)' : 'גיבוי מסד נתונים בלבד'}</button>
          ))}
        </div>
        <p role="status" className={bkMsg?.ok ? 'ok' : 'error'}>{bkMsg?.text}</p>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <caption className="sr-only">קבצי גיבוי</caption>
            <thead><tr><th scope="col">קובץ</th><th scope="col">נוצר</th><th scope="col">גודל</th><th scope="col">פעולות</th></tr></thead>
            <tbody>
              {backups.length === 0 && <tr><td colSpan={4}>אין גיבויים.</td></tr>}
              {backups.map((b) => (
                <tr key={b.name}>
                  <th scope="row"><span dir="ltr">{b.name}</span><br /><small className="hint">{b.name.startsWith('botwa-full-') ? 'מלא: מסד + קבצים' : 'מסד נתונים בלבד'}</small></th>
                  <td>{new Date(b.createdAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{fmtMB(b.size)}</td>
                  <td><div className="row">
                    <button onClick={async () => {
                      setBkMsg({ ok: true, text: 'בודק…' });
                      try { const r = await api<{ ok: boolean; tables: number; files?: number; reason?: string }>('POST', `/backups/${b.name}/verify`); setBkMsg(r.ok ? { ok: true, text: `הגיבוי תקין (${r.tables} טבלאות${r.files !== undefined ? `, ${r.files} קבצים מצורפים` : ''}).` } : { ok: false, text: `הגיבוי פגום או לא נפתח: ${r.reason ?? ''}` }); }
                      catch { setBkMsg({ ok: false, text: 'הבדיקה נכשלה.' }); }
                    }}>בדיקת תקינות<span className="sr-only"> {b.name}</span></button>
                    <a className="btn" href={`/backups/${b.name}`} download>הורדה<span className="sr-only"> {b.name}</span></a>
                    <button className="danger" onClick={() => setDelBk(b.name)}>מחיקה<span className="sr-only"> {b.name}</span></button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <ConfirmDialog open={!!delBk} danger title="מחיקת גיבוי" message={`הקובץ ${delBk ?? ''} יימחק לצמיתות.`} onCancel={() => setDelBk(null)}
        onConfirm={async () => { const n = delBk!; setDelBk(null); await api('DELETE', `/backups/${n}`).catch(() => undefined); await loadBackups(); }} />
      </>)}
      {canView && <SecurityPanel canEdit={canEdit} />}
      {can(me, 'contacts.manage') && <ContactsCsv />}
      {canEdit && <ForwardRules />}
      {canEdit && <Branding />}
      {canView && <LegalDocs canEdit={canEdit} />}
    </>
  );
}
