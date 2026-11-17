import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { errText } from '../strings';

interface Status { configured: boolean; target: string | null; lastAt: string | null; lastName: string | null; lastOk: boolean | null; lastError: string | null; lastCheckAt: string | null; lastCheckOk: boolean | null; lastCheckName: string | null; lastCheckError: string | null }
const when = (s: string | null) => (s ? new Date(s).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');

/** Settings > backups: the encrypted copy outside the server (S3-compatible storage), and its restore check. */
export function OffsiteBackup({ latest, onMsg }: { latest: string | null; onMsg: (m: { ok: boolean; text: string }) => void }) {
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => setS(await api<Status>('GET', '/backups/offsite').catch(() => null));
  useEffect(() => { void load(); }, []);
  if (!s) return null;
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try { onMsg({ ok: true, text: await fn() }); } catch (e) { onMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); } finally { setBusy(false); await load(); }
  };
  return (
    <div className="card" style={{ margin: '.6rem 0', padding: '.75rem' }} aria-labelledby="off-h">
      <h3 id="off-h" style={{ marginTop: 0 }}>עותק מחוץ לשרת</h3>
      {!s.configured ? (
        <p className="hint">לא מוגדר. כדי שהגיבוי היומי יועתק גם לאחסון חיצוני (S3, Cloudflare R2, Backblaze B2, Wasabi או MinIO), מגדירים בקובץ ההגדרות של השרת: OFFSITE_S3_ENDPOINT, OFFSITE_S3_BUCKET, OFFSITE_S3_REGION, OFFSITE_S3_ACCESS_KEY ו-OFFSITE_S3_SECRET_KEY (הוראות במדריך). הקבצים כבר מוצפנים בשרת, והמפתח לא יוצא ממנו.</p>
      ) : (
        <>
          <p className="hint">יעד: <span dir="ltr">{s.target}</span>. כל גיבוי אוטומטי שעבר בדיקה מועתק לשם. פעם בשבוע העותק האחרון שם מורד, מפוענח ונבדק כמו בשחזור. שמרו עותק של ENCRYPTION_KEY במקום בטוח נפרד: בלעדיו אי אפשר לשחזר.</p>
          <ul>
            <li>העלאה אחרונה: {s.lastAt ? <>{s.lastOk ? '✅' : '⛔'} {when(s.lastAt)} <span dir="ltr">{s.lastName}</span>{!s.lastOk && s.lastError ? ` · ${s.lastError}` : ''}</> : 'עוד לא'}</li>
            <li>בדיקת שחזור אחרונה: {s.lastCheckAt ? <>{s.lastCheckOk ? '✅ הצליחה' : '⛔ נכשלה'} · {when(s.lastCheckAt)}{s.lastCheckName ? <> · <span dir="ltr">{s.lastCheckName}</span></> : null}{!s.lastCheckOk && s.lastCheckError ? ` · ${s.lastCheckError}` : ''}</> : 'עוד לא'}</li>
          </ul>
          <div className="row">
            <button type="button" disabled={busy || !latest} onClick={() => void run(async () => { await api('POST', `/backups/${latest}/offsite`); return 'הגיבוי האחרון הועתק אל מחוץ לשרת ונבדק שהגיע בשלמותו.'; })}>העתקת הגיבוי האחרון עכשיו</button>
            <button type="button" disabled={busy || !s.lastName} onClick={() => void run(async () => { const r = await api<{ ok: boolean; name?: string; error?: string }>('POST', '/backups/offsite/check'); if (!r.ok) throw new ApiError(502, 'offsite_failed'); return `בדיקת השחזור הצליחה (${r.name}).`; })}>בדיקת שחזור עכשיו</button>
          </div>
        </>
      )}
    </div>
  );
}
