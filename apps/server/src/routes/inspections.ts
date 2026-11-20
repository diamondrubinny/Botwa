import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import { can } from '../permissions.js';
import { inspectionLog, inspectionSchema, listInspections, markDone } from '../safety/inspections.js';

/**
 * Safety > periodic inspections. Seen by everyone with the SafetyBoard (safety.view) and by anyone responsible for one; managed by
 * whoever manages the bot (bot.manage); marked done by the person responsible or a manager.
 */
export function inspectionRoutes(app: FastifyInstance, db: Db) {
  const any = requireAuth(db);
  const manage = requireAuth(db, 'bot.manage');
  const idParam = z.object({ id: z.string().uuid() });
  const userOk = async (id: string | null) => !id || !!(await db.query('SELECT 1 FROM users WHERE id = $1 AND active', [id])).rowCount;

  app.get('/inspections', { preHandler: any }, async (req) => {
    const all = await listInspections(db);
    const u = req.user!;
    return can(u, 'safety.view') || can(u, 'bot.manage') ? all : all.filter((i) => i.assignee === u.id);
  });
  app.post('/inspections', { preHandler: manage }, async (req, reply) => {
    const b = inspectionSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await userOk(b.data.assignee))) return reply.code(400).send({ error: 'unknown_user' });
    const r = await db.query(`INSERT INTO inspections (title, place, interval_days, next_due, assignee, notes, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.data.title, b.data.place, b.data.intervalDays, b.data.nextDue, b.data.assignee, b.data.notes, b.data.active, req.user!.id]);
    await audit(db, { actorId: req.user!.id, action: 'inspection.create', target: r.rows[0].id, ip: req.ip });
    return reply.code(201).send({ id: r.rows[0].id });
  });
  app.put('/inspections/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = inspectionSchema.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await userOk(b.data.assignee))) return reply.code(400).send({ error: 'unknown_user' });
    const r = await db.query(`UPDATE inspections SET title = $2, place = $3, interval_days = $4, next_due = $5, assignee = $6, notes = $7, active = $8 WHERE id = $1`,
      [p.data.id, b.data.title, b.data.place, b.data.intervalDays, b.data.nextDue, b.data.assignee, b.data.notes, b.data.active]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'inspection.update', target: p.data.id, ip: req.ip });
    return { ok: true };
  });
  app.delete('/inspections/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM inspections WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'inspection.delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });
  app.post('/inspections/:id/done', { preHandler: any, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ note: z.string().trim().max(1000).default('') }).safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const row = (await db.query('SELECT assignee FROM inspections WHERE id = $1', [p.data.id])).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.assignee !== req.user!.id && !can(req.user!, 'bot.manage')) return reply.code(403).send({ error: 'forbidden' });
    await markDone(db, p.data.id, req.user!.id, b.data.note);
    await audit(db, { actorId: req.user!.id, action: 'inspection.done', target: p.data.id, ip: req.ip });
    return { ok: true };
  });
  app.get('/inspections/:id/log', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const row = (await db.query('SELECT assignee FROM inspections WHERE id = $1', [p.data.id])).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.assignee !== req.user!.id && !can(req.user!, 'safety.view') && !can(req.user!, 'bot.manage')) return reply.code(404).send({ error: 'not_found' });
    return inspectionLog(db, p.data.id);
  });
}
