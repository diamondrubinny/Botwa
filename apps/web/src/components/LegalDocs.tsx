import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { errText } from '../strings';

interface Legal { orgName: string; email: string; phone: string; address: string; officer: string; approved: boolean; updatedAt: string | null; urls: { privacy: string; terms: string; deletion: string } }

/** The organisation's details for the public privacy policy, terms and data-deletion pages (the addresses Meta asks for). */
export function LegalDocs({ canEdit }: { canEdit: boolean }) {
  const [d, setD] = useState<Legal | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<Legal>('GET', '/settings/legal').then(setD).catch(() => undefined); }, []);
  if (!d) return null;
  const set = (k: keyof Legal, v: string | boolean) => setD({ ...d, [k]: v });
  const save = async (e: FormEvent) => {
    e.preventDefault(); setMsg(null); setBusy(true);
    try {
      await api('PUT', '/settings/legal', { orgName: d.orgName, email: d.email, phone: d.phone, address: d.address, officer: d.officer, approved: d.approved });
      setMsg({ ok: true, text: 'נשמר. העמודים הציבוריים מתעדכנים מיד.' });
    } catch (er) { setMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); } finally { setBusy(false); }
  };
  const copy = (v: string) => void navigator.clipboard?.writeText(v).catch(() => undefined);
  const links: [string, string][] = [['מדיניות פרטיות (Privacy Policy URL)', d.urls.privacy], ['תנאי שימוש (Terms of Service URL)', d.urls.terms], ['הוראות מחיקת מידע (User data deletion)', d.urls.deletion]];
  return (
    <section className="card" aria-labelledby="legal-h">
      <h2 id="legal-h">מדיניות פרטיות ומסמכים ציבוריים</h2>
      <p className="hint">שלושה עמודים ציבוריים, בלי התחברות ובלי JavaScript, בעברית עם תקציר באנגלית. אלה הכתובות ש־Meta מבקשת לפני פרסום אפליקציה לווצאפ הרשמי. התוכן מתאר את מה שהמערכת עושה בפועל (ערוצים פעילים, תקופת שמירה, גיבויים) ומתעדכן לבד.</p>
      <dl>
        {links.map(([label, url]) => (
          <div key={url}><dt>{label}</dt><dd dir="ltr"><a href={url} target="_blank" rel="noopener noreferrer">{url}<span className="sr-only"> (נפתח בחלון חדש)</span></a> <button type="button" onClick={() => copy(url)}>העתקה<span className="sr-only"> {label}</span></button></dd></div>
        ))}
      </dl>
      {!d.approved && <p className="error">הנוסח הוא טיוטה טכנית שדורשת בדיקה של עורך דין או ממונה פרטיות. עד שמסמנים "הנוסח נבדק ואושר", מופיעה בעמודים שורה שמציינת זאת.</p>}
      {canEdit ? (
        <form onSubmit={save}>
          <div className="field"><label htmlFor="lg-org">שם הארגון</label><input id="lg-org" maxLength={120} value={d.orgName} onChange={(e) => set('orgName', e.target.value)} /></div>
          <div className="field"><label htmlFor="lg-email">דוא"ל לפניות פרטיות</label><input id="lg-email" type="email" dir="ltr" maxLength={200} value={d.email} onChange={(e) => set('email', e.target.value)} /></div>
          <div className="field"><label htmlFor="lg-phone">טלפון (אופציונלי)</label><input id="lg-phone" type="tel" dir="ltr" maxLength={40} value={d.phone} onChange={(e) => set('phone', e.target.value)} /></div>
          <div className="field"><label htmlFor="lg-addr">כתובת (אופציונלי)</label><input id="lg-addr" maxLength={200} value={d.address} onChange={(e) => set('address', e.target.value)} /></div>
          <div className="field"><label htmlFor="lg-off">האחראי על הגנת הפרטיות (אופציונלי)</label><input id="lg-off" maxLength={120} value={d.officer} onChange={(e) => set('officer', e.target.value)} /></div>
          <label className="gov-check"><input type="checkbox" checked={d.approved} onChange={(e) => set('approved', e.target.checked)} /> הנוסח נבדק ואושר משפטית</label>
          <div><button className="primary" type="submit" disabled={busy}>שמירה</button></div>
          <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
        </form>
      ) : <p className="hint">שינוי הפרטים דורש הרשאת ניהול הגדרות.</p>}
    </section>
  );
}
