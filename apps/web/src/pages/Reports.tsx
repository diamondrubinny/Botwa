import { useState } from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';

type Bucket = 'day' | 'week' | 'month';
interface Summary {
  days: number; timezone: string; bucket: Bucket;
  sla: { enabled: boolean; targetMinutes: number; withinTarget: number; breached: number; compliancePercent: number | null };
  previous: { newConversations: number; inbound: number; outbound: number };
  totals: { newConversations: number; inbound: number; outbound: number; openNow: number; unassignedNow: number };
  responseTime: { answered: number; unanswered: number; avgSeconds: number | null; medianSeconds: number | null };
  agents: { userId: string; name: string; messagesSent: number; conversations: number; avgFirstResponseSeconds: number | null; medianFirstResponseSeconds: number | null }[];
  daily: { day: string; inbound: number; outbound: number }[];
  byHour: { hour: number; inbound: number }[];
  topTags: { name: string; conversations: number }[];
}

export function fmtDuration(s: number | null): string {
  if (s == null) return '—';
  if (s < 60) return `${s} שנ'`;
  if (s < 3600) return `${Math.floor(s / 60)} דק' ${s % 60} שנ'`;
  return `${Math.floor(s / 3600)} שע' ${Math.floor((s % 3600) / 60)} דק'`;
}

/** "+12% לעומת התקופה הקודמת" in words (never colour alone). */
export function deltaText(now: number, before: number): string {
  if (before === 0) return now === 0 ? 'ללא שינוי' : 'חדש לעומת התקופה הקודמת';
  const p = Math.round(((now - before) / before) * 100);
  return p === 0 ? 'ללא שינוי' : `${p > 0 ? 'עלייה' : 'ירידה'} של ${Math.abs(p)}% לעומת התקופה הקודמת`;
}

/** Grouped bars (inbound/outbound) as inline SVG. Decorative for screen readers: the table below carries the data. */
function TrendChart({ rows }: { rows: { day: string; inbound: number; outbound: number }[] }) {
  const W = 640, H = 200, pad = 28;
  const max = Math.max(1, ...rows.flatMap((r) => [r.inbound, r.outbound]));
  const slot = (W - pad) / Math.max(1, rows.length);
  const bw = Math.max(2, Math.min(18, slot / 2 - 1));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="גרף עמודות של הודעות נכנסות ויוצאות לפי תקופה. הנתונים זמינים בטבלה שמתחת." className="trend-chart" style={{ width: '100%', height: 'auto', maxHeight: 260 }}>
      <line x1={pad} y1={H - 24} x2={W} y2={H - 24} stroke="currentColor" opacity=".35" />
      <text x={pad - 4} y={14} fontSize="11" textAnchor="end" fill="currentColor">{max}</text>
      <text x={pad - 4} y={H - 26} fontSize="11" textAnchor="end" fill="currentColor">0</text>
      {rows.map((r, i) => {
        const x = pad + i * slot + slot / 2;
        const hi = ((H - 44) * r.inbound) / max, ho = ((H - 44) * r.outbound) / max;
        return (
          <g key={r.day}>
            <rect x={x - bw - 0.5} y={H - 24 - hi} width={bw} height={hi} fill="var(--accent)" rx="2"><title>{`${r.day}: נכנסות ${r.inbound}`}</title></rect>
            <rect x={x + 0.5} y={H - 24 - ho} width={bw} height={ho} fill="currentColor" opacity=".55" rx="2"><title>{`${r.day}: יוצאות ${r.outbound}`}</title></rect>
          </g>
        );
      })}
      {rows.length > 0 && <>
        <text x={pad} y={H - 8} fontSize="11" fill="currentColor" direction="ltr">{rows[0]!.day}</text>
        <text x={W} y={H - 8} fontSize="11" textAnchor="end" fill="currentColor" direction="ltr">{rows[rows.length - 1]!.day}</text>
      </>}
    </svg>
  );
}

export function Reports() {
  const [bucket, setBucket] = useState<Bucket>('day');
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  usePoll(async () => {
    try { setData(await api<Summary>('GET', `/reports/summary?days=${days}&bucket=${bucket}`)); setFailed(false); } catch { setFailed(true); }
  }, 60000, [days, bucket]);

  const trend: Record<string, string> = data ? {
    'שיחות חדשות': deltaText(data.totals.newConversations, data.previous.newConversations),
    'הודעות נכנסות': deltaText(data.totals.inbound, data.previous.inbound),
    'הודעות יוצאות': deltaText(data.totals.outbound, data.previous.outbound),
  } : {};
  const unit = bucket === 'day' ? 'יום' : bucket === 'week' ? 'שבוע (תחילת שבוע)' : 'חודש (תחילת חודש)';
  return (
    <>
      <h1 tabIndex={-1}>דוחות</h1>
      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor="days">תקופה</label>
        <select id="days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 ימים אחרונים</option>
          <option value={30}>30 ימים אחרונים</option>
          <option value={90}>90 ימים אחרונים</option>
          <option value={180}>180 ימים אחרונים</option>
          <option value={365}>שנה אחרונה</option>
        </select>
      </div>
      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor="bucket">קיבוץ המגמה לפי</label>
        <select id="bucket" value={bucket} onChange={(e) => setBucket(e.target.value as Bucket)}>
          <option value="day">ימים</option><option value="week">שבועות</option><option value="month">חודשים</option>
        </select>
      </div>
      <p className="row">
        <a className="btn" href={`/reports/export.csv?kind=agents&days=${days}`} download>ייצוא נציגים ל-CSV</a>
        <a className="btn" href={`/reports/export.csv?kind=daily&days=${days}&bucket=${bucket}`} download>ייצוא נפח לפי תקופה ל-CSV</a>
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
                ...(data.sla.enabled ? [[`עמידה ביעד (${data.sla.targetMinutes} דק')`, data.sla.compliancePercent == null ? '—' : `${data.sla.compliancePercent}%`], ['חריגות מהיעד', data.sla.breached]] as [string, string | number][] : []),
              ] as [string, string | number][]).map(([k, v]) => (
                <div key={k}><dt className="hint">{k}</dt><dd style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>{v}</dd>
                  {trend[k] && <dd className="hint" style={{ margin: 0 }}>{trend[k]}</dd>}</div>
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

          <section className="card" aria-labelledby="hr-h">
            <h2 id="hr-h">שעות עומס</h2>
            <p className="hint">הודעות נכנסות לפי שעה ביום ({data.timezone}). הטבלה היא המקור, העמודות לנוחות בלבד.</p>
            {(() => {
              const max = Math.max(1, ...data.byHour.map((h) => h.inbound));
              return (
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <caption className="sr-only">הודעות נכנסות לפי שעה</caption>
                    <thead><tr><th scope="col">שעה</th><th scope="col">נכנסות</th><th scope="col"><span className="sr-only">גרף</span></th></tr></thead>
                    <tbody>
                      {data.byHour.filter((h) => h.inbound > 0).length === 0 && <tr><td colSpan={3}>אין נתונים.</td></tr>}
                      {data.byHour.filter((h) => h.inbound > 0).map((h) => (
                        <tr key={h.hour}>
                          <th scope="row" dir="ltr">{String(h.hour).padStart(2, '0')}:00</th><td>{h.inbound}</td>
                          <td aria-hidden="true" style={{ width: '50%' }}><div style={{ height: 10, borderRadius: 5, background: 'var(--accent)', width: `${Math.round((h.inbound / max) * 100)}%`, minWidth: 4 }} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </section>

          <section className="card" aria-labelledby="tg-h" style={{ overflowX: 'auto' }}>
            <h2 id="tg-h">תגיות נפוצות</h2>
            <table>
              <caption className="sr-only">התגיות הנפוצות בשיחות בתקופה</caption>
              <thead><tr><th scope="col">תגית</th><th scope="col">שיחות</th></tr></thead>
              <tbody>
                {data.topTags.length === 0 && <tr><td colSpan={2}>אין נתונים.</td></tr>}
                {data.topTags.map((t) => <tr key={t.name}><th scope="row">{t.name}</th><td>{t.conversations}</td></tr>)}
              </tbody>
            </table>
          </section>

          <section className="card" aria-labelledby="dy-h" style={{ overflowX: 'auto' }}>
            <h2 id="dy-h">מגמת נפח הודעות</h2>
            <p className="hint">עמודה מלאה = נכנסות, עמודה חצי-שקופה = יוצאות.</p>
            <TrendChart rows={data.daily} />
            <table>
              <caption className="sr-only">הודעות נכנסות ויוצאות לפי {unit}</caption>
              <thead><tr><th scope="col">{unit}</th><th scope="col">נכנסות</th><th scope="col">יוצאות</th></tr></thead>
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
