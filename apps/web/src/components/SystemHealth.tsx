import { useState } from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';

type Level = 'ok' | 'warn' | 'error' | 'off';
interface Item { key: string; group: 'server' | 'channels' | 'files' | 'backup' | 'privacy'; label: string; level: Level; value: string }
const GROUPS: [Item['group'], string][] = [['server', 'שרת'], ['channels', 'ערוצים ושליחה'], ['files', 'קבצים ודיסק'], ['backup', 'גיבויים'], ['privacy', 'פרטיות']];
// the level is said in words and an icon, never by colour alone
const LEVEL: Record<Level, { icon: string; text: string; cls: string }> = {
  ok: { icon: '✅', text: 'תקין', cls: 'ok' }, warn: { icon: '⚠️', text: 'לבדיקה', cls: 'warn' }, error: { icon: '⛔', text: 'תקלה', cls: 'error' }, off: { icon: '⏸️', text: 'כבוי', cls: 'hint' },
};

/** Settings > system status, refreshed every 30 seconds. */
export function SystemHealth() {
  const [d, setD] = useState<{ checkedAt: string; items: Item[] } | null>(null);
  const [failed, setFailed] = useState(false);
  usePoll(async () => {
    try { setD(await api('GET', '/system/health')); setFailed(false); } catch { setFailed(true); }
  }, 30000, []);
  const bad = d?.items.filter((i) => i.level === 'error').length ?? 0;
  const warn = d?.items.filter((i) => i.level === 'warn').length ?? 0;
  return (
    <section className="card" aria-labelledby="sys-h">
      <h2 id="sys-h">מצב המערכת</h2>
      {failed && <p className="error" role="alert">לא ניתן לקרוא את מצב המערכת כרגע.</p>}
      {!d ? <p className="hint">בודק…</p> : (
        <>
          <p role="status">{bad ? `⛔ ${bad} תקלות` : warn ? `⚠️ ${warn} נקודות לבדיקה` : '✅ הכול תקין'} · נבדק ב-{new Date(d.checkedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
          <p className="hint">כשמוגדרת כתובת התראות (ALERT_WEBHOOK_URL), נשלחת התראה על ערוץ שנפל ולא חזר תוך 10 דקות, דיסק מלא מעל 90% או גיבוי שחסר, ועוד אחת כשהמצב חוזר לתקינות.</p>
          {GROUPS.map(([g, title]) => {
            const rows = d.items.filter((i) => i.group === g);
            if (!rows.length) return null;
            return (
              <div key={g} style={{ overflowX: 'auto' }}>
                <table>
                  <caption style={{ textAlign: 'start', fontWeight: 600 }}>{title}</caption>
                  <thead className="sr-only"><tr><th scope="col">רכיב</th><th scope="col">מצב</th><th scope="col">פרטים</th></tr></thead>
                  <tbody>{rows.map((i) => (
                    <tr key={i.key}>
                      <th scope="row" style={{ fontWeight: 400 }}>{i.label}</th>
                      <td className={LEVEL[i.level].cls} style={{ whiteSpace: 'nowrap' }}><span aria-hidden="true">{LEVEL[i.level].icon} </span>{LEVEL[i.level].text}</td>
                      <td style={{ overflowWrap: 'anywhere' }}>{i.value}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
