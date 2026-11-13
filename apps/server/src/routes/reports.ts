import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { loadSla } from '../sla.js';

/** Aggregate support metrics (no message content). Supervisors/admins only. */
/** Spreadsheet formula injection guard: cells starting with = + - @ (or tab/CR) are prefixed with an apostrophe. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (rows: unknown[][]) => '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function reportRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  const managers = requireAuth(db, 'reports.view');

  app.get('/reports/export.csv', { preHandler: managers }, async (req, reply) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), kind: z.enum(['agents', 'daily']).default('agents'), bucket: z.enum(['day', 'week', 'month']).default('day') }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await computeSummary(db, cfg, q.data.days, q.data.bucket);
    const rows: unknown[][] = q.data.kind === 'agents'
      ? [['agent', 'messages_sent', 'conversations', 'avg_first_response_seconds', 'median_first_response_seconds'],
         ...r.agents.map((a: Agent) => [a.name, a.messagesSent, a.conversations, a.avgFirstResponseSeconds, a.medianFirstResponseSeconds])]
      : [[q.data.bucket === 'day' ? 'day' : `${q.data.bucket}_start`, 'inbound', 'outbound'], ...r.daily.map((d: { day: string; inbound: number; outbound: number }) => [d.day, d.inbound, d.outbound])];
    await audit(db, { actorId: req.user!.id, action: 'report.export', ip: req.ip, meta: { kind: q.data.kind, days: q.data.days } });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="botwa-${q.data.kind}-${q.data.days}d.csv"`)
      .header('cache-control', 'private, no-store')
      .send(toCsv(rows));
  });

  app.get('/reports/summary', { preHandler: managers }, async (req, reply) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), bucket: z.enum(['day', 'week', 'month']).default('day') }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    return computeSummary(db, cfg, q.data.days, q.data.bucket);
  });
}

interface Agent { name: string; messagesSent: number; conversations: number; avgFirstResponseSeconds: number | null; medianFirstResponseSeconds: number | null }

export async function computeSummary(db: Db, cfg: Config, days: number, bucket: 'day' | 'week' | 'month' = 'day') {
  {

    const [totals, waits, perAgent, daily, byHour, topTags] = await Promise.all([
      db.query(
        `SELECT
           (SELECT count(*) FROM conversations WHERE created_at >= now() - make_interval(days => $1))::int AS "newConversations",
           (SELECT count(*) FROM messages WHERE direction='in'  AND created_at >= now() - make_interval(days => $1))::int AS "inbound",
           (SELECT count(*) FROM messages WHERE direction='out' AND created_at >= now() - make_interval(days => $1))::int AS "outbound",
           (SELECT count(*) FROM conversations WHERE status='open')::int AS "openNow",
           (SELECT count(*) FROM conversations WHERE status='open' AND assigned_to IS NULL)::int AS "unassignedNow"`,
        [days],
      ),
      // A "wait" starts at a customer message that follows nothing or a staff message, and ends at the next staff reply.
      db.query(
        `WITH m AS (
           SELECT conversation_id, direction, created_at,
                  LAG(direction) OVER (PARTITION BY conversation_id ORDER BY created_at) AS prev_dir
             FROM messages WHERE NOT auto AND created_at >= now() - make_interval(days => $1)
         ), w AS (
           SELECT conversation_id, created_at AS asked_at FROM m WHERE direction = 'in' AND (prev_dir IS NULL OR prev_dir = 'out')
         ), r AS (
           SELECT w.asked_at, o.created_at AS answered_at, o.sender_user_id
             FROM w LEFT JOIN LATERAL (
               SELECT created_at, sender_user_id FROM messages o
                WHERE o.conversation_id = w.conversation_id AND o.direction = 'out' AND NOT o.auto AND o.created_at > w.asked_at
                ORDER BY o.created_at LIMIT 1) o ON true
         )
         SELECT sender_user_id AS "userId", GROUPING(sender_user_id)::int AS "isTotal",
                count(*) FILTER (WHERE answered_at IS NOT NULL)::int AS answered,
                count(*) FILTER (WHERE answered_at IS NULL)::int AS unanswered,
                round(avg(extract(epoch FROM answered_at - asked_at)))::int AS "avgSeconds",
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - asked_at)))::int AS "medianSeconds"
           FROM r GROUP BY GROUPING SETS ((sender_user_id), ())`,
        [days],
      ),
      db.query(
        `SELECT u.id AS "userId", u.name, count(*)::int AS "messagesSent", count(DISTINCT m.conversation_id)::int AS "conversations"
           FROM messages m JOIN users u ON u.id = m.sender_user_id
          WHERE m.direction = 'out' AND m.created_at >= now() - make_interval(days => $1)
          GROUP BY u.id, u.name ORDER BY "messagesSent" DESC`,
        [days],
      ),
      db.query(
        `SELECT to_char(date_trunc('${bucket}', created_at AT TIME ZONE $2), 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE direction = 'in')::int AS inbound,
                count(*) FILTER (WHERE direction = 'out')::int AS outbound
           FROM messages WHERE created_at >= now() - make_interval(days => $1)
          GROUP BY 1 ORDER BY 1`,
        [days, cfg.REPORT_TZ],
      ),
      // busiest hours of the day (customer messages, in the report time zone)
      db.query(
        `SELECT extract(hour FROM created_at AT TIME ZONE $2)::int AS hour, count(*)::int AS inbound
           FROM messages WHERE direction = 'in' AND created_at >= now() - make_interval(days => $1)
          GROUP BY 1 ORDER BY 1`,
        [days, cfg.REPORT_TZ],
      ),
      // most used conversation tags among conversations active in the period (aggregate only)
      db.query(
        `SELECT t.name, count(*)::int AS conversations
           FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id JOIN conversations c ON c.id = ct.conversation_id
          WHERE c.last_message_at >= now() - make_interval(days => $1)
          GROUP BY t.id, t.name ORDER BY conversations DESC, lower(t.name) LIMIT 8`,
        [days],
      ),
    ]);
    // the same-length period just before this one, for the "vs previous period" comparison
    const prev = (await db.query(
      `SELECT (SELECT count(*) FROM conversations WHERE created_at >= now() - make_interval(days => $1 * 2) AND created_at < now() - make_interval(days => $1))::int AS "newConversations",
              (SELECT count(*) FROM messages WHERE direction='in' AND created_at >= now() - make_interval(days => $1 * 2) AND created_at < now() - make_interval(days => $1))::int AS inbound,
              (SELECT count(*) FROM messages WHERE direction='out' AND created_at >= now() - make_interval(days => $1 * 2) AND created_at < now() - make_interval(days => $1))::int AS outbound`,
      [days])).rows[0];
    // SLA: customer waits (same definition as response time) that took longer than the target, or are still unanswered past it
    const sla = await loadSla(db);
    const slaRow = (await db.query(
      `WITH m AS (
         SELECT conversation_id, direction, created_at, LAG(direction) OVER (PARTITION BY conversation_id ORDER BY created_at) AS prev_dir
           FROM messages WHERE NOT auto AND created_at >= now() - make_interval(days => $1)
       ), w AS (SELECT conversation_id, created_at AS asked_at FROM m WHERE direction = 'in' AND (prev_dir IS NULL OR prev_dir = 'out')),
       r AS (SELECT w.asked_at, o.created_at AS answered_at FROM w LEFT JOIN LATERAL (
               SELECT created_at FROM messages o WHERE o.conversation_id = w.conversation_id AND o.direction = 'out' AND NOT o.auto AND o.created_at > w.asked_at ORDER BY o.created_at LIMIT 1) o ON true)
       SELECT count(*) FILTER (WHERE extract(epoch FROM coalesce(answered_at, now()) - asked_at) <= $2 * 60)::int AS "withinTarget",
              count(*) FILTER (WHERE extract(epoch FROM coalesce(answered_at, now()) - asked_at) > $2 * 60)::int AS breached FROM r`,
      [days, sla.targetMinutes])).rows[0] as { withinTarget: number; breached: number };
    const slaTotal = slaRow.withinTarget + slaRow.breached;
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, inbound: byHour.rows.find((r) => r.hour === h)?.inbound ?? 0 }));

    const overall = waits.rows.find((r) => r.isTotal === 1);
    const respByUser = new Map(waits.rows.filter((r) => r.isTotal === 0 && r.userId).map((r) => [r.userId, r]));
    // inquiries closed in the period and the customers' ratings of them
    const casesRow = (await db.query(
      `SELECT count(*)::int AS closed, count(rating)::int AS rated, round(avg(rating)::numeric, 2)::float AS "avgRating",
              count(*) FILTER (WHERE close_kind = 'auto')::int AS "closedAuto", count(*) FILTER (WHERE close_kind = 'customer')::int AS "closedByCustomer",
              array[count(*) FILTER (WHERE rating = 1), count(*) FILTER (WHERE rating = 2), count(*) FILTER (WHERE rating = 3), count(*) FILTER (WHERE rating = 4), count(*) FILTER (WHERE rating = 5)]::int[] AS distribution
         FROM cases WHERE closed_at >= now() - make_interval(days => $1)`, [days])).rows[0];
    return {
      cases: casesRow,
      days,
      bucket,
      previous: prev,
      sla: { enabled: sla.enabled, targetMinutes: sla.targetMinutes, ...slaRow, compliancePercent: slaTotal ? Math.round((slaRow.withinTarget / slaTotal) * 100) : null },
      timezone: cfg.REPORT_TZ,
      totals: totals.rows[0],
      responseTime: overall
        ? { answered: overall.answered, unanswered: overall.unanswered, avgSeconds: overall.avgSeconds, medianSeconds: overall.medianSeconds }
        : { answered: 0, unanswered: 0, avgSeconds: null, medianSeconds: null },
      agents: perAgent.rows.map((a) => ({ ...a, avgFirstResponseSeconds: respByUser.get(a.userId)?.avgSeconds ?? null, medianFirstResponseSeconds: respByUser.get(a.userId)?.medianSeconds ?? null })),
      daily: daily.rows,
      byHour: hours,
      topTags: topTags.rows,
    };
  }
}
