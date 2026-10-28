import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';

/** Aggregate support metrics (no message content). Supervisors/admins only. */
/** Spreadsheet formula injection guard: cells starting with = + - @ (or tab/CR) are prefixed with an apostrophe. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (rows: unknown[][]) => '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function reportRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  const managers = requireAuth(db, ['admin', 'supervisor']);

  app.get('/reports/export.csv', { preHandler: managers }, async (req, reply) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), kind: z.enum(['agents', 'daily']).default('agents') }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await computeSummary(db, cfg, q.data.days);
    const rows: unknown[][] = q.data.kind === 'agents'
      ? [['agent', 'messages_sent', 'conversations', 'avg_first_response_seconds', 'median_first_response_seconds'],
         ...r.agents.map((a: Agent) => [a.name, a.messagesSent, a.conversations, a.avgFirstResponseSeconds, a.medianFirstResponseSeconds])]
      : [['day', 'inbound', 'outbound'], ...r.daily.map((d: { day: string; inbound: number; outbound: number }) => [d.day, d.inbound, d.outbound])];
    await audit(db, { actorId: req.user!.id, action: 'report.export', ip: req.ip, meta: { kind: q.data.kind, days: q.data.days } });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="botwa-${q.data.kind}-${q.data.days}d.csv"`)
      .header('cache-control', 'private, no-store')
      .send(toCsv(rows));
  });

  app.get('/reports/summary', { preHandler: managers }, async (req, reply) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    return computeSummary(db, cfg, q.data.days);
  });
}

interface Agent { name: string; messagesSent: number; conversations: number; avgFirstResponseSeconds: number | null; medianFirstResponseSeconds: number | null }

async function computeSummary(db: Db, cfg: Config, days: number) {
  {

    const [totals, waits, perAgent, daily] = await Promise.all([
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
        `SELECT to_char(date_trunc('day', created_at AT TIME ZONE $2), 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE direction = 'in')::int AS inbound,
                count(*) FILTER (WHERE direction = 'out')::int AS outbound
           FROM messages WHERE created_at >= now() - make_interval(days => $1)
          GROUP BY 1 ORDER BY 1`,
        [days, cfg.REPORT_TZ],
      ),
    ]);

    const overall = waits.rows.find((r) => r.isTotal === 1);
    const respByUser = new Map(waits.rows.filter((r) => r.isTotal === 0 && r.userId).map((r) => [r.userId, r]));
    return {
      days,
      timezone: cfg.REPORT_TZ,
      totals: totals.rows[0],
      responseTime: overall
        ? { answered: overall.answered, unanswered: overall.unanswered, avgSeconds: overall.avgSeconds, medianSeconds: overall.medianSeconds }
        : { answered: 0, unanswered: 0, avgSeconds: null, medianSeconds: null },
      agents: perAgent.rows.map((a) => ({ ...a, avgFirstResponseSeconds: respByUser.get(a.userId)?.avgSeconds ?? null, medianFirstResponseSeconds: respByUser.get(a.userId)?.medianSeconds ?? null })),
      daily: daily.rows,
    };
  }
}
