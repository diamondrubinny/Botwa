import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { errText } from '../strings';

interface Links { allowed: boolean; channels: string[]; links: { id: string; account: string; channel: string; createdAt: string; lastUsedAt: string | null }[] }

/** Managers ask Betty on WhatsApp about the inquiries: link a WhatsApp account with a one-time code, see and remove links. */
export function StaffWhatsApp() {
  const [d, setD] = useState<Links | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = async () => setD(await api<Links>('GET', '/me/whatsapp-links').catch(() => null));
  useEffect(() => { void load(); }, []);
  if (!d || (!d.allowed && !d.links.length)) return null;
  const fail = (e: unknown) => setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') });
  return (
    <section className="card" aria-labelledby="sw-h">
      <h2 id="sw-h">בטי בווצאפ למנהלים</h2>
      <p className="hint">אפשר לשאול את בטי בווצאפ מה מצב הקריאות: כמה פתוחות, מה אצל כל נציג, לפי נושא, מה פתוח הכי הרבה זמן ומה דחוף. בווצאפ נשלחים רק מספרי פנייה, נושאים, מטפלים וזמנים. שמות, טלפונים והודעות של פונים לא נשלחים. ההרשאה נבדקת בכל הודעה מחדש, וכל שאלה נרשמת ביומן.</p>
      {d.allowed && (
        <>
          <ol>
            <li>לוחצים "יצירת קוד קישור".</li>
            <li>שולחים את הקוד, מהווצאפ שלכם, למספר הווצאפ של היחידה{d.channels.length ? ` (${d.channels.join(', ')})` : ''}, תוך 10 דקות.</li>
            <li>בטי תאשר את הקישור. מעכשיו כותבים לה "מצב", "נציגים", "נושאים", "ותיקות", "דחוף" או "שלי".</li>
          </ol>
          <div className="row">
            <button type="button" className="primary" onClick={async () => { setMsg(null); try { setCode(await api('POST', '/me/whatsapp-links/code')); } catch (e) { fail(e); } }}>יצירת קוד קישור</button>
            {code && <span role="status">הקוד: <strong dir="ltr" style={{ fontSize: '1.2rem', letterSpacing: '.05em' }}>{code.code}</strong> · בתוקף עד {new Date(code.expiresAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        </>
      )}
      {d.links.length > 0 && (
        <table>
          <caption>חשבונות ווצאפ מקושרים</caption>
          <thead><tr><th scope="col">חשבון</th><th scope="col">ערוץ</th><th scope="col">שימוש אחרון</th><th scope="col">פעולות</th></tr></thead>
          <tbody>{d.links.map((l) => (
            <tr key={l.id}><th scope="row" dir="ltr">{l.account}</th><td>{l.channel}</td><td>{l.lastUsedAt ? new Date(l.lastUsedAt).toLocaleString('he-IL') : 'עוד לא'}</td>
              <td><button type="button" className="danger" onClick={() => setDel(l.id)}>ניתוק<span className="sr-only"> {l.account}</span></button></td></tr>))}</tbody>
        </table>
      )}
      {!d.allowed && <p className="hint">לחשבון שלך אין כרגע הרשאה (צריך גישה לכל השיחות ולדוחות). הקישורים הקיימים לא יענו.</p>}
      {msg && <p role="status" className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      <ConfirmDialog open={!!del} danger title="ניתוק הווצאפ" message="הודעות מהמספר הזה יטופלו מעכשיו כמו פנייה רגילה." confirmLabel="ניתוק" onCancel={() => setDel(null)}
        onConfirm={async () => { const id = del!; setDel(null); try { await api('DELETE', `/me/whatsapp-links/${id}`); setMsg({ ok: true, text: 'נותק.' }); await load(); } catch (e) { fail(e); } }} />
    </section>
  );
}
