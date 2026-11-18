import type { Db } from '../db.js';

/**
 * Reports > safety and urgency: what Betty flagged in the period (emergencies, hazard reports, stressed or upset customers) and
 * how fast a person answered after it (the first message a person wrote in that conversation afterwards). Counts and times only:
 * no customer names or message text.
 */
export type SafetyKind = 'emergency' | 'hazard' | 'worried' | 'upset';
export interface SafetyRow { kind: SafetyKind; events: number; answered: number; within15: number; medianMinutes: number | null; unanswered: number }
export interface SafetyReport { days: number; rows: SafetyRow[]; topics: { name: string; n: number }[]; english: number; arabic: number; waitingNow: number; /** reporters' 1-5 rating of how hazard reports were handled */ hazardRating: { avg: number | null; n: number } }

const AUTO_TAGS = ['דחוף', 'זקוק לליווי', 'English', 'العربية'];

export async function safetyReport(db: Db, days: number): Promise<SafetyReport> {
  return safetyReportRange(db, new Date(Date.now() - days * 86_400_000), new Date(), days);
}

/** The same for a period (a calendar month for the monthly report). */
export async function safetyReportRange(db: Db, from: Date, to: Date, days: number): Promise<SafetyReport> {
  const events = `
    SELECT a.target::uuid AS conv, a.created_at AS at,
           CASE WHEN a.action = 'conversation.emergency' THEN 'emergency' ELSE coalesce(a.meta->>'level', 'worried') END AS kind
      FROM audit_log a
     WHERE a.action IN ('conversation.emergency', 'conversation.comfort') AND a.created_at >= $1 AND a.created_at < $2
       AND a.target ~ '^[0-9a-f-]{36}$'`;
  const rows = (await db.query(
    `WITH e AS (${events}),
          r AS (SELECT e.kind, e.at, (SELECT min(m.created_at) FROM messages m WHERE m.conversation_id = e.conv AND m.direction = 'out' AND NOT m.auto AND m.created_at > e.at) AS reply FROM e)
     SELECT kind, count(*)::int AS events, count(reply)::int AS answered,
            count(*) FILTER (WHERE reply - at <= interval '15 minutes')::int AS within15,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM reply - at)) FILTER (WHERE reply IS NOT NULL) / 60)::numeric, 1)::float AS "medianMinutes"
       FROM r GROUP BY kind`, [from, to])).rows as Omit<SafetyRow, 'unanswered'>[];
  const order: SafetyKind[] = ['emergency', 'hazard', 'worried', 'upset'];
  const full = order.map((kind) => { const r = rows.find((x) => x.kind === kind); return { kind, events: r?.events ?? 0, answered: r?.answered ?? 0, within15: r?.within15 ?? 0, medianMinutes: r?.medianMinutes ?? null, unanswered: (r?.events ?? 0) - (r?.answered ?? 0) }; });
  const topics = (await db.query(
    `WITH e AS (${events}) SELECT t.name, count(DISTINCT e.conv)::int AS n FROM e JOIN conversation_tags x ON x.conversation_id = e.conv JOIN tags t ON t.id = x.tag_id
      WHERE NOT (lower(t.name) = ANY($3::text[])) GROUP BY t.name ORDER BY n DESC, t.name LIMIT 8`, [from, to, AUTO_TAGS.map((n) => n.toLowerCase())])).rows as { name: string; n: number }[];
  const langs = (await db.query(`SELECT count(*) FILTER (WHERE lang = 'en')::int AS en, count(*) FILTER (WHERE lang = 'ar')::int AS ar FROM conversations WHERE lang IN ('en', 'ar') AND last_message_at >= $1 AND last_message_at < $2`, [from, to])).rows[0] as { en: number; ar: number };
  const english = langs.en, arabic = langs.ar;
  // open right now, flagged, and nobody from the team has written since the flag
  const waitingNow = (await db.query(
    `SELECT count(*)::int AS n FROM conversations c WHERE c.status = 'open' AND c.comfort_since IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND NOT m.auto AND m.created_at > c.comfort_since)`)).rows[0].n as number;
  // how reporters rated the handling of hazard reports (the feedback question after "the hazard was handled")
  const hr = (await db.query(
    `SELECT count(*)::int AS n, round(avg(k.rating)::numeric, 1)::float AS avg FROM cases k
      WHERE k.rating IS NOT NULL AND k.rated_at >= $1 AND k.rated_at < $2
        AND EXISTS (SELECT 1 FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = k.conversation_id AND lower(t.name) = 'מפגע')`, [from, to])).rows[0] as { n: number; avg: number | null };
  return { days, rows: full, topics, english, arabic, waitingNow, hazardRating: { avg: hr.n ? hr.avg : null, n: hr.n } };
}

const KIND_HE: Record<SafetyKind, string> = { emergency: '🚨 מצבי חירום', hazard: '⚠️ דיווחי מפגע', worried: '💛 לקוחות לחוצים', upset: '😕 לקוחות מתוסכלים' };
/** The same report as a short text (for managers on WhatsApp). */
export function safetyReportText(r: SafetyReport): string {
  const lines = r.rows.filter((x) => x.events).map((x) => `${KIND_HE[x.kind]}: ${x.events}${x.medianMinutes !== null ? ` · מענה אנושי תוך ${x.medianMinutes} דק׳ (חציון)` : ''}${x.unanswered ? ` · ${x.unanswered} בלי מענה אנושי` : ''}`);
  if (!lines.length && !r.hazardRating?.n) return `🛡️ ב-${r.days} הימים האחרונים לא היו מצבי חירום, דיווחי מפגע או לקוחות לחוצים.`;
  return [`🛡️ בטיחות ודחיפות, ${r.days} ימים אחרונים:`, ...lines, ...(r.topics.length ? [`נושאים: ${r.topics.slice(0, 5).map((t) => `${t.name} (${t.n})`).join(', ')}`] : []), ...(r.hazardRating?.n ? [`⭐ שביעות רצון מטיפול במפגעים: ${r.hazardRating.avg} מתוך 5 (${r.hazardRating.n} דירוגים)`] : []), ...(r.waitingNow ? [`⏳ עכשיו מחכים למענה: ${r.waitingNow}`] : [])].join('\n');
}

/**
 * Reports > hazards by building: inquiries about hazards and emergencies in the period (tagged "מפגע" or "דחוף", or flagged by Betty),
 * grouped by building: the reporter's identification (building), else the place written in the conversation. How many, how many
 * still open, the median time to a person's first answer and to closing, and the topics. No names or message text.
 */
export interface BuildingRow { building: string; reports: number; open: number; medianReplyMinutes: number | null; medianCloseHours: number | null; topics: string[] }

export async function hazardsByBuilding(db: Db, days: number): Promise<BuildingRow[]> {
  return hazardsByBuildingRange(db, new Date(Date.now() - days * 86_400_000), new Date());
}

export async function hazardsByBuildingRange(db: Db, from: Date, to: Date): Promise<BuildingRow[]> {
  const rows = (await db.query(
    `WITH k AS (
       SELECT k.id, k.conversation_id AS conv, k.opened_at, k.closed_at
         FROM cases k
        WHERE k.opened_at >= $1 AND k.opened_at < $2
          AND (EXISTS (SELECT 1 FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = k.conversation_id AND lower(t.name) IN ('מפגע', 'דחוף'))
               OR EXISTS (SELECT 1 FROM audit_log a WHERE a.target = k.conversation_id::text AND a.created_at >= k.opened_at AND (a.action = 'conversation.emergency' OR (a.action = 'conversation.comfort' AND a.meta->>'level' = 'hazard'))))
     ), b AS (
       SELECT k.*, nullif(trim(regexp_replace(coalesce(
                ct.profile->>'building',
                (SELECT substring(n.body from 'בניין: ([^\\n]+)') FROM conversation_notes n WHERE n.conversation_id = k.conv AND n.body ~ 'בניין: ' ORDER BY n.created_at DESC LIMIT 1),
                (SELECT substring(n.body from 'מיקום(?: שנמסר)?: ([^\\n]+)') FROM conversation_notes n WHERE n.conversation_id = k.conv AND n.body ~ 'מיקום' ORDER BY n.created_at DESC LIMIT 1),
                ''), '^\\s*בניין\\s+', '')), '') AS building,
              (SELECT min(m.created_at) FROM messages m WHERE m.conversation_id = k.conv AND m.direction = 'out' AND NOT m.auto AND m.created_at > k.opened_at) AS reply
         FROM k JOIN conversations c ON c.id = k.conv JOIN contacts ct ON ct.id = c.contact_id
     ), g AS (SELECT b.*, coalesce(lower(left(b.building, 60)), '') AS bkey FROM b)
     SELECT g.bkey AS building, count(*)::int AS reports, count(*) FILTER (WHERE closed_at IS NULL)::int AS open,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM reply - opened_at)) FILTER (WHERE reply IS NOT NULL) / 60)::numeric, 1)::float AS "medianReplyMinutes",
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - opened_at)) FILTER (WHERE closed_at IS NOT NULL) / 3600)::numeric, 1)::float AS "medianCloseHours",
            (SELECT array_agg(DISTINCT t.name) FROM g g2 JOIN conversation_tags x ON x.conversation_id = g2.conv JOIN tags t ON t.id = x.tag_id
              WHERE g2.bkey = g.bkey AND lower(t.name) NOT IN ('מפגע', 'דחוף', 'זקוק לליווי', 'english', 'العربية', 'אירוע חירום')) AS topics
       FROM g GROUP BY g.bkey ORDER BY reports DESC, g.bkey LIMIT 50`, [from, to])).rows as (BuildingRow & { topics: string[] | null })[];
  return rows.map((r) => ({ ...r, building: r.building || '', topics: (r.topics ?? []).slice(0, 5) }));
}
