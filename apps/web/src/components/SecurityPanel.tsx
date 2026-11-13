import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

interface Sec {
  firewall: { enabled: boolean; allow: string[]; applyToApi: boolean; deny: string[] };
  yourIp: string; trustProxy: boolean; emergencyOff: boolean; blockedLastHour: number;
  antivirus: {
    configured: boolean; allowUnscanned: boolean;
    scanner: null | { online: true; engine: string; signatures: string; signatureDate: string | null; signatureAgeDays: number | null } | { online: false; detail: string };
    files: { stored: number; checkedThisWeek: number; pending: number; infected30d: number };
  };
  events: Record<string, number>;
}
const lines = (t: string) => t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const privateIp = (ip: string) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/.test(ip);

/** Settings > Security: the antivirus status and re-scan, the panel firewall (who may open the panel) and recent security events. */
export function SecurityPanel({ canEdit }: { canEdit: boolean }) {
  const [s, setS] = useState<Sec | null>(null);
  const [allow, setAllow] = useState('');
  const [deny, setDeny] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [applyToApi, setApplyToApi] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const r = await api<Sec>('GET', '/settings/security').catch(() => null);
    if (!r) return;
    setS(r); setAllow(r.firewall.allow.join('\n')); setDeny(r.firewall.deny.join('\n')); setEnabled(r.firewall.enabled); setApplyToApi(r.firewall.applyToApi);
  };
  useEffect(() => { void load(); }, []);
  if (!s) return null;
  const av = s.antivirus, sc = av.scanner;

  async function saveFw() {
    setMsg(null);
    try { await api('PUT', '/settings/firewall', { enabled, allow: lines(allow), deny: lines(deny), applyToApi }); setMsg({ ok: true, text: 'הגדרות חומת האש נשמרו.' }); await load(); }
    catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setMsg({ ok: false, text: code === 'would_lock_you_out' ? `השמירה נעצרה כי היא הייתה חוסמת אתכם (הכתובת שלכם: ${s!.yourIp}). הוסיפו אותה לרשימת המותרים.` : code === 'allow_list_empty' ? 'כדי להפעיל צריך לפחות כתובת או טווח מותר אחד.' : 'השמירה נכשלה. בדקו שכל שורה היא כתובת IP או טווח (למשל 203.0.113.0/24).' });
    }
  }
  return (
    <>
      <section className="card" aria-labelledby="av-sec-h">
        <h2 id="av-sec-h">אנטי-וירוס</h2>
        {!av.configured ? (
          <p className="error">סורק ClamAV לא מוגדר (CLAMAV_HOST). {av.allowUnscanned ? 'קבצים מתקבלים בלי סריקה: לא מומלץ בייצור.' : 'קבצים מלקוחות יישארו בהסגר עד שהסורק יוגדר.'}</p>
        ) : sc && sc.online ? (
          <p className={sc.signatureAgeDays !== null && sc.signatureAgeDays > 3 ? 'error' : 'ok'}>
            הסורק פעיל: {sc.engine}, חתימות {sc.signatures}{sc.signatureDate ? ` (${sc.signatureDate})` : ''}.
            {sc.signatureAgeDays !== null && sc.signatureAgeDays > 3 ? ` החתימות בנות ${sc.signatureAgeDays} ימים: בדקו שהשירות clamav מתעדכן (חיבור לאינטרנט).` : ''}
          </p>
        ) : <p className="error">הסורק לא עונה ({sc && !sc.online ? sc.detail : '?'}). קבצים חדשים ממתינים בהסגר עד שיחזור. בדקו: docker compose ps clamav</p>}
        <ul>
          <li>כל קובץ מלקוח נכנס להסגר, נסרק, ורק אז זמין. קובץ נגוע נמחק.</li>
          <li>קבצים שמורים נסרקים שוב כל שבוע עם החתימות העדכניות (ברקע, כל שעה). השבוע נבדקו {av.files.checkedThisWeek} מתוך {av.files.stored}.</li>
          <li>ממתינים לסריקה: {av.files.pending}. נמצאו נגועים ב-30 הימים האחרונים: {av.files.infected30d}.</li>
          <li>גם תמונות פרופיל, לוגו, קבצי מאגר הידע וייבוא אקסל נסרקים לפני שמירה.</li>
        </ul>
        {canEdit && av.configured && <button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setMsg(null);
          try { const r = await api<{ scanned: number; infected: number; errors: number }>('POST', '/settings/security/rescan', {}); setMsg({ ok: r.infected === 0 && r.errors === 0, text: `נסרקו ${r.scanned} קבצים${r.infected ? `, ${r.infected} נגועים נמחקו` : ', לא נמצא דבר'}${r.errors ? `, ${r.errors} שגיאות` : ''}.` }); await load(); }
          catch { setMsg({ ok: false, text: 'הסריקה נכשלה.' }); }
          setBusy(false);
        }}>{busy ? 'סורק…' : 'סריקה חוזרת של כל הקבצים עכשיו'}</button>}
      </section>

      <section className="card" aria-labelledby="fw-sec-h">
        <h2 id="fw-sec-h">חומת אש לפאנל</h2>
        <p className="hint">רק כתובות ורשתות שברשימה יוכלו לפתוח את הפאנל ולהתחבר. הצ'אט באתר, ה-Webhooks של הערוצים ובדיקת התקינות נשארים פתוחים לכולם. כתובות ברשימת החסומות לא מקבלות שום דבר.</p>
        <p>הכתובת שלכם כרגע: <bdi dir="ltr"><strong>{s.yourIp}</strong></bdi>. נחסמו בשעה האחרונה: {s.blockedLastHour}.</p>
        {privateIp(s.yourIp) && !s.trustProxy && <p className="error">הכתובת נראית פנימית: כנראה יש לפני המערכת proxy (nginx / HestiaCP / Caddy), וכל הגולשים נראים מאותה כתובת. לפני הפעלה, הגדירו TRUST_PROXY=true בקובץ ‎.env והפעילו מחדש.</p>}
        {s.emergencyOff && <p className="error">חומת האש מושבתת כרגע במצב חירום (FIREWALL_DISABLE=true ב-‎.env).</p>}
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="field"><label><input type="checkbox" role="switch" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />להגביל את הפאנל לכתובות המותרות בלבד</label></div>
          <div className="field">
            <label htmlFor="fw-allow">כתובות ורשתות מותרות (אחת בכל שורה, למשל 203.0.113.7 או 203.0.113.0/24)</label>
            <textarea id="fw-allow" dir="ltr" rows={4} value={allow} onChange={(e) => setAllow(e.target.value)} />
            <button type="button" style={{ marginTop: '.4rem' }} onClick={() => setAllow((a) => (lines(a).includes(s.yourIp) ? a : `${a.trim() ? `${a.trim()}\n` : ''}${s.yourIp}`))}>הוספת הכתובת שלי</button>
          </div>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={applyToApi} onChange={(e) => setApplyToApi(e.target.checked)} />להחיל גם על ה-API (Power Apps ואינטגרציות). שימו לב: שירותי ענן יוצאים מכתובות משתנות</label></div>
          <div className="field">
            <label htmlFor="fw-deny">כתובות ורשתות חסומות לגמרי</label>
            <textarea id="fw-deny" dir="ltr" rows={3} value={deny} onChange={(e) => setDeny(e.target.value)} />
          </div>
          <button type="button" className="primary" onClick={() => void saveFw()}>שמירת חומת האש</button>
        </fieldset>
        <p className="hint">ננעלתם בחוץ? בשרת: הוסיפו FIREWALL_DISABLE=true לקובץ ‎/opt/botwa/.env והריצו docker compose up -d, תקנו את הרשימה, והסירו את השורה. להגנת השרת עצמו (פורטים, SSH) הריצו scripts/harden.sh (ראו docs/SECURITY_HARDENING.he.md).</p>
      </section>
      <p role={msg?.ok === false ? 'alert' : 'status'} className={msg?.ok === false ? 'error' : 'ok'}>{msg?.text}</p>

      <section className="card" aria-labelledby="ev-sec-h">
        <h2 id="ev-sec-h">אירועי אבטחה (7 ימים)</h2>
        <ul>
          <li>ניסיונות כניסה שנכשלו: {s.events['login.fail'] ?? 0}. חשבונות שננעלו זמנית: {s.events['login.locked'] ?? 0}.</li>
          <li>קבצים נגועים שנחסמו: {(s.events['media.infected'] ?? 0) + (s.events['media.infected_rescan'] ?? 0)}.</li>
          <li>לקוחות שנחסמו אוטומטית בגלל הצפה: {s.events['contact.auto_block'] ?? 0}.</li>
          <li>שינויים בחומת האש: {s.events['firewall.update'] ?? 0}.</li>
        </ul>
        <p className="hint">פירוט מלא ביומן הביקורת.</p>
      </section>
    </>
  );
}
