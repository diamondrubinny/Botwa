import { PageTitle } from '../components/Illustration';
import { useEffect, useState } from 'react';
import { api, type AuditRow } from '../api';

const LABELS: Record<string, string> = {
  'login.success': 'כניסה למערכת', 'login.fail': 'ניסיון כניסה כושל', 'login.lockout': 'נעילת חשבון', 'login.locked': 'ניסיון כניסה לחשבון נעול', logout: 'התנתקות',
  'password.change': 'שינוי סיסמה', 'mfa.enable': 'הפעלת אימות דו-שלבי', 'user.create': 'יצירת משתמש', 'user.update': 'עדכון משתמש', 'user.mfa_reset': 'איפוס אימות דו-שלבי',
  'channel.create': 'יצירת ערוץ', 'channel.start': 'הפעלת ערוץ', 'channel.stop': 'עצירת ערוץ', 'channel.logout': 'ניתוק חשבון ערוץ', 'channel.delete': 'מחיקת ערוץ',
  'channel.password_submitted': 'הזנת סיסמת טלגרם', 'conversation.assign': 'שיוך שיחה', 'contact.export': 'ייצוא נתוני איש קשר', 'contact.erase': 'מחיקת איש קשר',
  'media.infected': 'קובץ נגוע נחסם', 'media.upload_infected': 'ניסיון העלאת קובץ נגוע', 'media.sent': 'שליחת קובץ', 'settings.business_hours': 'עדכון שעות פעילות', 'tag.delete': 'מחיקת תגית',
};
const FILTERS: [string, string][] = [['', 'הכול'], ['login', 'כניסות'], ['user.', 'משתמשים'], ['channel.', 'ערוצים'], ['contact.', 'פרטיות (ייצוא/מחיקה)'], ['media.', 'קבצים'], ['settings', 'הגדרות']];
const PAGE = 50;

export function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [filter, setFilter] = useState('');
  const [more, setMore] = useState(false);
  const [err, setErr] = useState(false);

  async function load(reset: boolean) {
    setErr(false);
    try {
      const before = !reset && rows.length ? `&before=${rows[rows.length - 1]!.id}` : '';
      const data = await api<AuditRow[]>('GET', `/audit?limit=${PAGE}${before}${filter ? `&action=${encodeURIComponent(filter)}` : ''}`);
      setRows(reset ? data : [...rows, ...data]);
      setMore(data.length === PAGE);
    } catch { setErr(true); }
  }
  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  return (
    <>
      <PageTitle art="search" title="יומן ביקורת" />
      <div className="field" style={{ maxWidth: 280 }}>
        <label htmlFor="af">סוג פעולה</label>
        <select id="af" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {err && <p role="alert" className="error">טעינת היומן נכשלה.</p>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <caption className="sr-only">יומן פעולות אבטחה וניהול, מהחדש לישן</caption>
          <thead><tr><th scope="col">זמן</th><th scope="col">משתמש</th><th scope="col">פעולה</th><th scope="col">יעד</th><th scope="col">כתובת IP</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5}>אין רשומות.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.createdAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'medium' })}</td>
                <td>{r.actorName ?? '—'}</td>
                <td>{LABELS[r.action] ?? r.action}</td>
                <td dir="ltr" style={{ overflowWrap: 'anywhere' }}>{r.target ?? ''}</td>
                <td dir="ltr">{r.ip ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {more && <button style={{ marginTop: '.75rem' }} onClick={() => load(false)}>טעינת רשומות נוספות</button>}
      </div>
      <p className="hint">היומן אינו כולל תוכן הודעות.</p>
    </>
  );
}
