import { useState } from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';

/**
 * Reports > safety and urgency: what Betty flagged (emergencies, hazard reports, stressed or upset customers) and how fast a person
 * answered after it. A table (screen readers, no colour needed); counts and times only.
 */
type Kind = 'emergency' | 'hazard' | 'worried' | 'upset';
interface Row { kind: Kind; events: number; answered: number; within15: number; medianMinutes: number | null; unanswered: number }
interface Report { days: number; rows: Row[]; topics: { name: string; n: number }[]; english: number; arabic?: number; waitingNow: number; hazardRating?: { avg: number | null; n: number } }
const LABEL: Record<Kind, string> = { emergency: '🚨 מצבי חירום', hazard: '⚠️ דיווחי מפגע', worried: '💛 לקוחות לחוצים', upset: '😕 לקוחות מתוסכלים' };

export function SafetyReport({ days }: { days: number }) {
  const [r, setR] = useState<Report | null>(null);
  usePoll(async () => { const x = await api<Report>('GET', `/reports/safety?days=${days}`).catch(() => null); if (x) setR(x); }, 60000, [days]);
  if (!r) return null;
  const total = r.rows.reduce((a, x) => a + x.events, 0);
  return (
    <section className="card" aria-labelledby="sf-rep-h" style={{ overflowX: 'auto' }}>
      <h2 id="sf-rep-h">בטיחות ודחיפות</h2>
      <p className="hint">מה בטי סימנה בתקופה, ותוך כמה זמן אדם מהצוות ענה אחרי זה (ההודעה הראשונה של הצוות בשיחה). בלי שמות ובלי תוכן הודעות.</p>
      {r.waitingNow > 0 && <p role="status"><strong>⏳ עכשיו מחכים למענה אנושי: {r.waitingNow}</strong> (אפשר לסנן בתיבה לפי "💛 זקוק לליווי").</p>}
      {total === 0 ? <p className="ok">לא היו בתקופה הזו מצבי חירום, דיווחי מפגע או לקוחות לחוצים.</p> : (
        <table>
          <caption className="sr-only">בטיחות ודחיפות, {r.days} ימים אחרונים</caption>
          <thead><tr><th scope="col">סוג</th><th scope="col">כמה</th><th scope="col">נענו תוך 15 דק׳</th><th scope="col">זמן מענה (חציון)</th><th scope="col">בלי מענה אנושי</th></tr></thead>
          <tbody>{r.rows.filter((x) => x.events).map((x) => (
            <tr key={x.kind}>
              <th scope="row">{LABEL[x.kind]}</th>
              <td>{x.events}</td>
              <td>{x.within15} מתוך {x.events}</td>
              <td>{x.medianMinutes === null ? '—' : `${x.medianMinutes} דק׳`}</td>
              <td>{x.unanswered ? <strong>{x.unanswered}</strong> : 0}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {r.topics.length > 0 && <p><strong>נושאים:</strong> {r.topics.map((t) => `${t.name} (${t.n})`).join(', ')}</p>}
      {!!r.hazardRating?.n && <p>⭐ שביעות רצון המדווחים מטיפול במפגעים: <strong>{r.hazardRating.avg}</strong> מתוך 5 ({r.hazardRating.n} דירוגים)</p>}
      <p className="hint">שיחות באנגלית בתקופה: {r.english}. בערבית: {r.arabic ?? 0}. גם מנהלים שמחוברים לבטי בווצאפ יכולים לקבל את הסיכום הזה: כתבו לה "בטיחות" או "7".</p>
    </section>
  );
}
