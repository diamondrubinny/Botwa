import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import type { KnowledgeBase } from '../kb/service.js';
import { approveLearn, LearnError, learningSchema, loadLearning } from '../learn.js';

const idParam = z.object({ id: z.string().uuid() });

/** "The bot learns": suggestions from real conversations, applied only when someone with kb.manage approves them. */
export function learningRoutes(app: FastifyInstance, db: Db, kb: KnowledgeBase) {
  const manage = requireAuth(db, 'kb.manage');

  app.get('/kb/learning', { preHandler: manage }, async (req, reply) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query(
      `SELECT l.id, l.kind, l.status, l.text, l.answer, l.hits, l.target, l.source_id AS "sourceId", s.title AS "sourceTitle",
              l.created_at AS "createdAt", l.updated_at AS "updatedAt", u.name AS "decidedBy", l.decided_at AS "decidedAt"
         FROM kb_learn l LEFT JOIN kb_sources s ON s.id = l.source_id LEFT JOIN users u ON u.id = l.decided_by
        WHERE l.status = $1 ORDER BY l.hits DESC, l.updated_at DESC LIMIT 200`, [q.data.status]);
    return rows.map((r) => {
      const [node, option] = r.kind === 'option_example' ? (r.target as string).split('\n') : [];
      return { ...r, target: undefined, node, option };
    });
  });

  app.post('/kb/learning/:id/approve', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ text: z.string().trim().min(2).max(500).optional(), answer: z.string().trim().min(2).max(4000).optional() }).safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      const r = await approveLearn(db, kb, p.data.id, req.user!.id, b.data);
      await audit(db, { actorId: req.user!.id, action: 'kb.learn_approve', target: p.data.id, ip: req.ip, meta: { sourceId: r.sourceId ?? null } });
      return { ok: true, ...r };
    } catch (e) {
      if (e instanceof LearnError) return reply.code(e.code === 'not_found' ? 404 : 409).send({ error: e.code });
      throw e;
    }
  });

  app.post('/kb/learning/:id/reject', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query(`UPDATE kb_learn SET status = 'rejected', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1 AND status = 'pending'`, [p.data.id, req.user!.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'kb.learn_reject', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // answers customers reacted to: the unhelpful ones are held back from direct answers until reviewed
  app.get('/kb/learning/feedback', { preHandler: manage }, async () => {
    const { rows } = await db.query(
      `SELECT s.id, s.title, count(*) FILTER (WHERE a.positive)::int AS up, count(*) FILTER (WHERE NOT a.positive)::int AS down, max(a.created_at) AS "lastAt"
         FROM kb_answer_reactions a JOIN kb_sources s ON s.id = a.source_id
        WHERE s.feedback_reviewed_at IS NULL OR a.created_at > s.feedback_reviewed_at
        GROUP BY s.id, s.title ORDER BY count(*) FILTER (WHERE NOT a.positive) DESC, count(*) DESC LIMIT 100`);
    return rows.map((r) => ({ ...r, flagged: r.down >= 3 && r.down > r.up * 2 }));
  });
  app.post('/kb/learning/feedback/:id/reviewed', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('UPDATE kb_sources SET feedback_reviewed_at = now() WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'kb.feedback_reviewed', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.get('/kb/learning/settings', { preHandler: manage }, async () => loadLearning(db));
  app.put('/kb/learning/settings', { preHandler: manage }, async (req, reply) => {
    const b = learningSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query(`INSERT INTO settings (key, value) VALUES ('learning', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(b.data)]);
    await audit(db, { actorId: req.user!.id, action: 'settings.learning', ip: req.ip, meta: b.data });
    return b.data;
  });

  // how well the bot does: share of customers' free-text questions it answered, this week against last week
  app.get('/kb/learning/stats', { preHandler: manage }, async () => {
    const r = (await db.query(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS "thisWeek",
              count(*) FILTER (WHERE created_at > now() - interval '7 days' AND answered)::int AS "thisWeekAnswered",
              count(*) FILTER (WHERE created_at <= now() - interval '7 days')::int AS "lastWeek",
              count(*) FILTER (WHERE created_at <= now() - interval '7 days' AND answered)::int AS "lastWeekAnswered"
         FROM kb_queries WHERE via = 'bot' AND created_at > now() - interval '14 days'`)).rows[0];
    const pending = (await db.query(`SELECT kind, count(*)::int AS n FROM kb_learn WHERE status = 'pending' GROUP BY kind`)).rows;
    const pct = (a: number, n: number) => (n ? Math.round((a / n) * 100) : null);
    return { ...r, thisWeekRate: pct(r.thisWeekAnswered, r.thisWeek), lastWeekRate: pct(r.lastWeekAnswered, r.lastWeek), pending: Object.fromEntries(pending.map((x) => [x.kind, x.n])) };
  });
}
