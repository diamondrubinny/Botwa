import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { loadSession, requireAuth } from '../auth.js';
import type { ChannelManager, BusEvent } from '../channels/manager.js';
import type { Db } from '../db.js';

const idParam = z.object({ id: z.string().uuid() });

export function channelRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager) {
  const adminOnly = requireAuth(db, ['admin']);
  const view = requireAuth(db, ['admin', 'supervisor']);

  const exists = async (id: string) => (await db.query('SELECT 1 FROM channels WHERE id=$1', [id])).rowCount === 1;

  app.get('/channels', { preHandler: view }, async () => {
    const { rows } = await db.query('SELECT id, type, label, status, created_at AS "createdAt" FROM channels ORDER BY created_at');
    return rows.map((r) => ({ ...r, status: mgr.snapshot(r.id).status === 'stopped' ? r.status : mgr.snapshot(r.id).status }));
  });

  app.post('/channels', { preHandler: adminOnly }, async (req, reply) => {
    const b = z.object({ type: z.enum(['whatsapp', 'telegram']), label: z.string().min(1).max(80) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!mgr.supports(b.data.type)) return reply.code(501).send({ error: 'unsupported_channel_type' });
    const { rows } = await db.query(
      'INSERT INTO channels (type, label, created_by) VALUES ($1,$2,$3) RETURNING id, type, label, status',
      [b.data.type, b.data.label, req.user!.id],
    );
    await audit(db, { actorId: req.user!.id, action: 'channel.create', target: rows[0].id, ip: req.ip, meta: { type: b.data.type } });
    return reply.code(201).send(rows[0]);
  });

  for (const action of ['start', 'stop', 'logout'] as const) {
    app.post(`/channels/:id/${action}`, { preHandler: adminOnly }, async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: 'bad_request' });
      if (!(await exists(p.data.id))) return reply.code(404).send({ error: 'not_found' });
      try {
        await mgr[action](p.data.id);
      } catch (e) {
        req.log.error({ err: e }, `channel ${action} failed`);
        return reply.code(502).send({ error: 'channel_error' });
      }
      await audit(db, { actorId: req.user!.id, action: `channel.${action}`, target: p.data.id, ip: req.ip });
      return { ok: true };
    });
  }

  app.delete('/channels/:id', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await exists(p.data.id))) return reply.code(404).send({ error: 'not_found' });
    await mgr.remove(p.data.id);
    await audit(db, { actorId: req.user!.id, action: 'channel.delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // Server-Sent Events: live status + QR for the link screen. Admin only (QR = account takeover).
  app.get('/channels/:id/events', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const id = p.data.id;
    if (!(await exists(id))) return reply.code(404).send({ error: 'not_found' });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const snap = mgr.snapshot(id);
    send({ type: 'status', status: snap.status });
    if (snap.qr) send({ type: 'qr', qr: snap.qr });

    const onEvent = (e: BusEvent) => {
      if (e.channelId !== id || e.type === 'message') return;
      send(e);
    };
    mgr.bus.on('event', onEvent);
    const hb = setInterval(() => res.write(': hb\n\n'), 25_000);
    // Re-validate the session periodically so a revoked/expired session stops receiving QR codes.
    const recheck = setInterval(async () => {
      const t = req.cookies.botwa_sid;
      const ok = t ? await loadSession(db, t).catch(() => null) : null;
      if (!ok || ok.role !== 'admin') res.end();
    }, 60_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      clearInterval(recheck);
      mgr.bus.off('event', onEvent);
    });
  });
}
