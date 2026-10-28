import { useState, type FormEvent } from 'react';
import { api, ApiError, type BusinessHours } from '../api';
import { usePoll } from '../hooks';
import { errText } from '../strings';

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export function Settings() {
  const [h, setH] = useState<BusinessHours | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  usePoll(async () => { if (!h) setH(await api<BusinessHours>('GET', '/settings/business-hours').catch(() => null)); }, 60000);

  if (!h) return <><h1 tabIndex={-1}>הגדרות</h1><p role="status">טוען…</p></>;

  const setDay = (i: number, v: { open: string; close: string } | null) => setH({ ...h, days: h.days.map((d, k) => (k === i ? v : d)) });

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
      <form className="card" onSubmit={save}>
        <h2>שעות פעילות ומענה אוטומטי</h2>
        <p className="hint">מחוץ לשעות הפעילות נשלחת ללקוח הודעה אוטומטית אחת (לכל היותר אחת ל-12 שעות לשיחה). ההודעה מסומנת כ"מענה אוטומטי" ואינה נחשבת תשובת נציג בדוחות.</p>
        <div className="field">
          <label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={h.enabled} onChange={(e) => setH({ ...h, enabled: e.target.checked })} />הפעלת מענה אוטומטי מחוץ לשעות</label>
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
    </>
  );
}
