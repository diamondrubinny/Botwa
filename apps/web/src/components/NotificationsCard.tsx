import { useEffect, useState } from 'react';
import { api } from '../api';
import { isInstalled, isIos } from '../install';
import { notifyEnabled, pushSupported, setNotifyEnabled } from '../live';

interface Prefs { messages: boolean; assigned: boolean; sla: boolean }
const PREFS: [keyof Prefs, string][] = [['messages', 'הודעה חדשה מלקוח (בשיחות שלי או שעוד לא שויכו)'], ['assigned', 'שיחה שויכה או הועברה אליי'], ['sla', 'לקוח ממתין מעבר ליעד זמן המענה']];

/** Phone / desktop alerts for this device and this person: switch on, choose what to hear about, send a test. */
export function NotificationsCard() {
  const [on, setOn] = useState(notifyEnabled);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [devices, setDevices] = useState(0);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const load = async () => { const s = await api<{ prefs: Prefs; devices: number }>('GET', '/push/status').catch(() => null); if (s) { setPrefs(s.prefs); setDevices(s.devices); } };
  useEffect(() => { void load(); }, []);

  async function toggle(v: boolean) {
    setMsg(null);
    const r = await setNotifyEnabled(v);
    setOn(r);
    if (v && !r) setMsg({ ok: false, text: 'ההרשאה להתראות נחסמה. אפשר לאשר אותה בהגדרות האתר בדפדפן (סמל המנעול ליד הכתובת) או בהגדרות האפליקציה בטלפון.' });
    await load();
  }
  return (
    <section className="card" aria-labelledby="ntf-h">
      <h2 id="ntf-h">התראות בטלפון ובמחשב</h2>
      {!pushSupported() ? (
        <p>{isIos() && !isInstalled() ? 'באייפון התראות עובדות רק אחרי התקנת האפליקציה למסך הבית (ראו למעלה), ואז פותחים אותה מהאייקון.' : 'הדפדפן הזה לא תומך בהתראות. נסו Chrome או Edge, או את האפליקציה המותקנת.'}</p>
      ) : (
        <>
          <p className="hint">התראות מגיעות גם כשהאפליקציה סגורה. ההתראה לא מציגה את שם הלקוח או את תוכן ההודעה, ולחיצה עליה פותחת את השיחה.</p>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={on && perm === 'granted'} onChange={(e) => void toggle(e.target.checked)} />התראות במכשיר הזה</label></div>
          <p className="hint">{devices === 0 ? 'אין עדיין מכשיר רשום להתראות.' : devices === 1 ? 'מכשיר אחד רשום להתראות.' : `${devices} מכשירים רשומים להתראות.`}{perm === 'denied' ? ' ההרשאה להתראות חסומה בדפדפן הזה.' : ''}</p>
          {prefs && (
            <fieldset style={{ border: 0, padding: 0, margin: '0 0 1rem' }}>
              <legend style={{ fontWeight: 700, marginBottom: '.3rem' }}>על מה להתריע (בכל המכשירים שלי)</legend>
              {PREFS.map(([k, label]) => (
                <label key={k} style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={prefs[k]}
                  onChange={async (e) => { const next = { ...prefs, [k]: e.target.checked }; setPrefs(next); await api('PUT', '/push/prefs', next).catch(() => setMsg({ ok: false, text: 'השמירה נכשלה.' })); }} />{label}</label>
              ))}
            </fieldset>
          )}
          <button type="button" disabled={devices === 0} onClick={async () => {
            setMsg(null);
            const r = await api<{ delivered: number }>('POST', '/push/test', {}).catch(() => null);
            setMsg(r && r.delivered > 0 ? { ok: true, text: `נשלחה התראת בדיקה ל-${r.delivered} ${r.delivered === 1 ? 'מכשיר' : 'מכשירים'}. אם לא הופיעה, בדקו שההתראות של הדפדפן או האפליקציה מותרות בהגדרות הטלפון.` } : { ok: false, text: 'ההתראה לא נשלחה. הפעילו התראות במכשיר הזה ונסו שוב.' });
          }}>שליחת התראת בדיקה</button>
        </>
      )}
      <p role={msg?.ok === false ? 'alert' : 'status'} className={msg?.ok === false ? 'error' : 'ok'}>{msg?.text}</p>
    </section>
  );
}
