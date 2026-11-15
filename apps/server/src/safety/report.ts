import type { Db } from '../db.js';

/**
 * Reports > safety and urgency: what Betty flagged in the period (emergencies, hazard reports, stressed or upset customers) and
 * how fast a person answered after it (the first message a person wrote in that conversation afterwards). Counts and times only:
 * no customer names or message text.
 */
export type SafetyKind = 'emergency' | 'hazard' | 'worried' | 'upset';
export interface SafetyRow { kind: SafetyKind; events: number; answered: number; within15: number; medianMinutes: number | null; unanswered: number }
export interface SafetyReport { days: number; rows: SafetyRow[]; topics: { name: string; n: number }[]; english: number; waitingNow: number }

const AUTO_TAGS = ['דחוף', 'זקוק לליווי', 'English'];

export async function safetyReport(db: Db, days: number): Promise<SafetyReport> {
  const events = `
    SELECT a.target::uuid AS conv, a.created_at AS at,
           CASE WHEN a.action = 'conversation.emergency' THEN 'emergency' ELSE coalesce(a.meta->>'level', 'worried') END AS kind
      FROM audit_log a
     WHERE a.action IN ('conversation.emergency', 'conversation.comfort') AND a.created_at > now() - make_interval(days => $1)
       AND a.target ~ '^[0-9a-f-]{36}$'`;
  const rows = (await db.query(
    `WITH e AS (${events}),
          r AS (SELECT e.kind, e.at, (SELECT min(m.created_at) FROM messages m WHERE m.conversation_id = e.conv AND m.direction = 'out' AND NOT m.auto AND m.created_at > e.at) AS reply FROM e)
     SELECT kind, count(*)::int AS events, count(reply)::int AS answered,
            count(*) FILTER (WHERE reply - at <= interval '15 minutes')::int AS within15,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM reply - at)) FILTER (WHERE reply IS NOT NULL) / 60)::numeric, 1)::float AS "medianMinutes"
       FROM r GROUP BY kind`, [days])).rows as Omit<SafetyRow, 'unanswered'>[];
  const order: SafetyKind[] = ['emergency', 'hazard', 'worried', 'upset'];
  const full = order.map((kind) => { const r = rows.find((x) => x.kind === kind); return { kind, events: r?.events ?? 0, answered: r?.answered ?? 0, within15: r?.within15 ?? 0, medianMinutes: r?.medianMinutes ?? null, unanswered: (r?.events ?? 0) - (r?.answered ?? 0) }; });
  const topics = (await db.query(
    `WITH e AS (${events}) SELECT t.name, count(DISTINCT e.conv)::int AS n FROM e JOIN conversation_tags x ON x.conversation_id = e.conv JOIN tags t ON t.id = x.tag_id
      WHERE NOT (lower(t.name) = ANY($2::text[])) GROUP BY t.name ORDER BY n DESC, t.name LIMIT 8`, [days, AUTO_TAGS.map((n) => n.toLowerCase())])).rows as { name: string; n: number }[];
  const english = (await db.query(`SELECT count(*)::int AS n FROM conversations WHERE lang = 'en' AND last_message_at > now() - make_interval(days => $1)`, [days])).rows[0].n as number;
  // open right now, flagged, and nobody from the team has written since the flag
  const waitingNow = (await db.query(
    `SELECT count(*)::int AS n FROM conversations c WHERE c.status = 'open' AND c.comfort_since IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND NOT m.auto AND m.created_at > c.comfort_since)`)).rows[0].n as number;
  return { days, rows: full, topics, english, waitingNow };
}

const KIND_HE: Record<SafetyKind, string> = { emergency: '🚨 מצבי חירום', hazard: '⚠️ דיווחי מפגע', worried: '💛 לקוחות לחוצים', upset: '😕 לקוחות מתוסכלים' };
/** The same report as a short text (for managers on WhatsApp). */
export function safetyReportText(r: SafetyReport): string {
  const lines = r.rows.filter((x) => x.events).map((x) => `${KIND_HE[x.kind]}: ${x.events}${x.medianMinutes !== null ? ` · מענה אנושי תוך ${x.medianMinutes} דק׳ (חציון)` : ''}${x.unanswered ? ` · ${x.unanswered} בלי מענה אנושי` : ''}`);
  if (!lines.length) return `🛡️ ב-${r.days} הימים האחרונים לא היו מצבי חירום, דיווחי מפגע או לקוחות לחוצים.`;
  return [`🛡️ בטיחות ודחיפות, ${r.days} ימים אחרונים:`, ...lines, ...(r.topics.length ? [`נושאים: ${r.topics.slice(0, 5).map((t) => `${t.name} (${t.n})`).join(', ')}`] : []), ...(r.waitingNow ? [`⏳ עכשיו מחכים למענה: ${r.waitingNow}`] : [])].join('\n');
}
