import { useState } from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';

/**
 * Reports > hazards by building: where hazards and emergencies are reported, how many are still open and how fast they were
 * answered and closed. A table (the bar is decoration: the number is always written next to it).
 */
interface Row { building: string; reports: number; open: number; medianReplyMinutes: number | null; medianCloseHours: number | null; topics: string[] }

export function HazardsByBuilding({ days }: { days: number }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  usePoll(async () => { const r = await api<Row[]>('GET', `/reports/buildings?days=${days}`).catch(() => null); if (r) setRows(r); }, 60000, [days]);
  if (!rows) return null;
  const max = Math.max(1, ...rows.map((r) => r.reports));
  return (
    <section className="card" aria-labelledby="bld-h" style={{ overflowX: 'auto' }}>
      <h2 id="bld-h">מפת מפגעים לפי בניין</h2>
      <p className="hint">דיווחי מפגע וחירום לפי בניין. הבניין נלקח מפרטי ההזדהות של המדווח, או מהמיקום שנכתב בשיחה. הטבלה עוזרת לזהות נקודות חמות בקמפוס.</p>
      {rows.length === 0 ? <p className="ok">לא היו דיווחי מפגע או חירום בתקופה הזו.</p> : (
        <table className="bld-table">
          <caption className="sr-only">דיווחי מפגע וחירום לפי בניין</caption>
          <thead><tr><th scope="col">בניין</th><th scope="col">דיווחים</th><th scope="col">פתוחים</th><th scope="col">מענה אנושי (חציון)</th><th scope="col">סגירה (חציון)</th><th scope="col">נושאים</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.building || '-'}>
              <th scope="row">{r.building || <span className="hint">לא צוין בניין</span>}</th>
              <td>
                <span className="bld-bar" aria-hidden="true" style={{ inlineSize: `${Math.max(4, Math.round((r.reports / max) * 100))}px` }} />
                <span>{r.reports}</span>
              </td>
              <td>{r.open ? <strong>{r.open}</strong> : 0}</td>
              <td>{r.medianReplyMinutes === null ? '—' : `${r.medianReplyMinutes} דק׳`}</td>
              <td>{r.medianCloseHours === null ? '—' : r.medianCloseHours < 24 ? `${r.medianCloseHours} שע׳` : `${Math.round(r.medianCloseHours / 24)} ימים`}</td>
              <td>{r.topics.join(', ') || '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
