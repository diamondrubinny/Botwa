import { useState } from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';

interface Summary {
  days: number; timezone: string;
  totals: { newConversations: number; inbound: number; outbound: number; openNow: number; unassignedNow: number };
  responseTime: { answered: number; unanswered: number; avgSeconds: number | null; medianSeconds: number | null };
  agents: { userId: string; name: string; messagesSent: number; conversations: number; avgFirstResponseSeconds: number | null; medianFirstResponseSeconds: number | null }[];
  daily: { day: string; inbound: number; outbound: number }[];
}

export function fmtDuration(s: number | null): string {
  if (s == null) return '—';
  if (s < 60) return `${s} שנ'`;
  if (s < 3600) return `${Math.floor(s / 60)} דק' ${s % 60} שנ'`;
  return `${Math.floor(s / 3600)} שע' ${Math.floor((s % 3600) / 60)} דק'`;
}

export function Reports() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  usePoll(async () => {
    try { setData(await api<Summary>('GET', `/reports/summary?days=${days}`)); setFailed(false); } catch { setFailed(true); }
  }, 60000, [days]);

  return (
    <>
      <h1 tabIndex={-1}>דוחות</h1>
      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor="days">תקופה</label>
        <select id="days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 ימים אחרונים</option>
          <option value={30}>30 ימים אחרונים</option>
          <option value={90}>90 ימים אחרונים</option>
        </select>
      </div>
      <p className="row">
        <a className="btn" href={`/reports/export.csv?kind=agents&days=${days}`} download>ייצוא נציגים ל-CSV</a>
        <a className="btn" href={`/reports/export.csv?kind=daily&days=${days}`} download>ייצוא נפח יומי ל-CSV</a>
      </p>
      {failed && <p role="alert" className="error">טעינת הדוח נכשלה.</p>}
      {!data ? <p role="status">טוען…</p> : (
        <>
          <section className="card" aria-labelledby="sum-h">
            <h2 id="sum-h">סיכום</h2>
            <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '.75rem', margin: 0 }}>
              {([
                ['שיחות חדשות', data.totals.newConversations], ['הודעות נכנסות', data.totals.inbound], ['הודעות יוצאות', data.totals.outbound],
                ['שיחות פתוחות כרגע', data.totals.openNow], ['פתוחות ולא משויכות', data.totals.unassignedNow],
                ['זמן תגובה ממוצע', fmtDuration(data.responseTime.avgSeconds)], ['זמן תגובה חציוני', fmtDuration(data.responseTime.medianSeconds)],
                ['פניות שלא נענו', data.responseTime.unanswered],
              ] as [string, string | number][]).map(([k, v]) => (
                <div key={k}><dt className="hint">{k}</dt><dd style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>{v}</dd></div>
              ))}
            </dl>
            <p className="hint">זמן תגובה = מהודעת לקוח (שלא קדמה לה הודעה שלא נענתה) ועד התשובה הראשונה של הצוות. אזור זמן: {data.timezone}.</p>
          </section>

          <section className="card" aria-labelledby="ag-h" style={{ overflowX: 'auto' }}>
            <h2 id="ag-h">לפי נציג</h2>
            <table>
              <caption className="sr-only">ביצועי נציגים בתקופה שנבחרה</caption>
              <thead><tr><th scope="col">נציג</th><th scope="col">הודעות שנשלחו</th><th scope="col">שיחות</th><th scope="col">זמן תגובה ממוצע</th><th scope="col">זמן תגובה חציוני</th></tr></thead>
              <tbody>
                {data.agents.length === 0 && <tr><td colSpan={5}>אין נתונים.</td></tr>}
                {data.agents.map((a) => (
                  <tr key={a.userId}><th scope="row">{a.name}</th><td>{a.messagesSent}</td><td>{a.conversations}</td><td>{fmtDuration(a.avgFirstResponseSeconds)}</td><td>{fmtDuration(a.medianFirstResponseSeconds)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card" aria-labelledby="dy-h" style={{ overflowX: 'auto' }}>
            <h2 id="dy-h">נפח יומי</h2>
            <table>
              <caption className="sr-only">הודעות נכנסות ויוצאות לפי יום</caption>
              <thead><tr><th scope="col">יום</th><th scope="col">נכנסות</th><th scope="col">יוצאות</th></tr></thead>
              <tbody>
                {data.daily.length === 0 && <tr><td colSpan={3}>אין נתונים.</td></tr>}
                {[...data.daily].reverse().map((d) => <tr key={d.day}><th scope="row" dir="ltr">{d.day}</th><td>{d.inbound}</td><td>{d.outbound}</td></tr>)}
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  );
}
