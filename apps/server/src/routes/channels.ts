import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { loadSession, requireAuth } from '../auth.js';
import type { ChannelManager, BusEvent } from '../channels/manager.js';
import type { Db } from '../db.js';
import { warmupCap } from '../channels/sender.js';

const idParam = z.object({ id: z.string().uuid() });

/** Heuristic "ban risk" from signals the platforms are known to care about (volume, unsolicited-looking ratio, failures). Advisory only. */
export function assessRisk(x: { status: string; day: number; cap: number; inbound24h: number; ageDays: number; recentAutoPauses: number }): { level: 'low' | 'medium' | 'high'; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (x.status === 'restricted') { score += 5; reasons.push('restricted'); }
  if (x.recentAutoPauses > 0) { score += 2; reasons.push('auto_paused_recently'); }
  const use = x.cap > 0 ? x.day / x.cap : 0;
  if (use >= 0.8) { score += 2; reasons.push('cap_near'); } else if (use >= 0.5) { score += 1; reasons.push('cap_half'); }
  if (x.day >= 30 && x.day > 3 * Math.max(1, x.inbound24h)) { score += 1; reasons.push('outbound_heavy'); }
  if (x.ageDays < 3 && x.day >= 15) { score += 1; reasons.push('new_number_busy'); }
  return { level: score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low', reasons };
}

export function channelRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager) {
  const adminOnly = requireAuth(db, ['admin']);
  const view = requireAuth(db, ['admin', 'supervisor']);

  const exists = async (id: string) => (await db.query('SELECT 1 FROM channels WHERE id=$1', [id])).rowCount === 1;

  app.get('/channels', { preHandler: view }, async () => {
    const { rows } = await db.query('SELECT id, type, label, status, created_at AS "createdAt" FROM channels ORDER BY created_at');
    return rows.map((r) => ({ ...r, status: mgr.snapshot(r.id).status === 'stopped' ? r.status : mgr.snapshot(r.id).status }));
  });

  // Health: current status, send usage vs. cap (anti-ban pacing) and the last status changes.
  app.get('/channels/health', { preHandler: view }, async () => {
    const { rows } = await db.query('SELECT id, type, label, status FROM channels ORDER BY created_at');
    const out = [];
    for (const ch of rows) {
      const u = await mgr.sendUsage(ch.id);
      const cap = warmupCap(u.settings, u.ageDays);
      const events = (await db.query('SELECT kind, created_at AS "at" FROM channel_events WHERE channel_id = $1 ORDER BY id DESC LIMIT 6', [ch.id])).rows;
      const status = mgr.snapshot(ch.id).status === 'stopped' ? ch.status : mgr.snapshot(ch.id).status;
      const warnings: string[] = [];
      if (status === 'restricted') warnings.push('restricted');
      if (status === 'logged_out') warnings.push('logged_out');
      if (u.day >= cap * 0.8) warnings.push(u.day >= cap ? 'daily_cap_reached' : 'daily_cap_near');
      if (u.settings.warmup && cap < u.settings.perDay) warnings.push('warming_up');
      const inb = (await db.query(`SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel_id = $1 AND m.direction = 'in' AND m.created_at > now() - interval '24 hours'`, [ch.id])).rows[0].n as number;
      const pausedRow = (await db.query('SELECT paused FROM channels WHERE id = $1', [ch.id])).rows[0];
      const autoPausedUntil = mgr.isAutoPausedUntil(ch.id);
      const recentAutoPauses = (await db.query(`SELECT count(*)::int AS n FROM channel_events WHERE channel_id = $1 AND kind = 'auto_paused' AND created_at > now() - interval '24 hours'`, [ch.id])).rows[0].n as number;
      const risk = assessRisk({ status, day: u.day, cap, inbound24h: inb, ageDays: u.ageDays, recentAutoPauses });
      out.push({
        id: ch.id, label: ch.label, type: ch.type, status, sentLast24h: u.day, inboundLast24h: inb, sentLastMinute: u.minute, dailyCap: cap, ageDays: Math.floor(u.ageDays),
        paused: !!pausedRow?.paused, autoPausedUntil: autoPausedUntil > Date.now() ? new Date(autoPausedUntil).toISOString() : null,
        risk, warnings, events,
      });
    }
    return out;
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
      // Optional WhatsApp phone-number pairing: POST /channels/:id/start {"phone":"9725XXXXXXXX"}
      const body = action === 'start' ? z.object({ phone: z.string().regex(/^\d{8,15}$/).optional() }).safeParse(req.body ?? {}) : null;
      if (body && !body.success) return reply.code(400).send({ error: 'bad_request' });
      try {
        if (action === 'start') await mgr.start(p.data.id, { pairingPhone: body?.success ? body.data.phone : undefined });
        else await mgr[action](p.data.id);
      } catch (e) {
        req.log.error({ err: e }, `channel ${action} failed`);
        return reply.code(502).send({ error: 'channel_error' });
      }
      await audit(db, { actorId: req.user!.id, action: `channel.${action}`, target: p.data.id, ip: req.ip });
      return { ok: true };
    });
  }

  // Telegram two-step verification password during QR login. Not persisted, not logged.
  app.post('/channels/:id/password', { preHandler: adminOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ password: z.string().min(1).max(256) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      mgr.submitPassword(p.data.id, b.data.password);
    } catch {
      return reply.code(409).send({ error: 'password_not_requested' });
    }
    await audit(db, { actorId: req.user!.id, action: 'channel.password_submitted', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // Emergency brake: stops ALL outgoing messages of the channel (incoming keep arriving). Supervisors can use it too.
  for (const action of ['pause', 'resume'] as const) {
    app.post(`/channels/:id/${action}`, { preHandler: view }, async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: 'bad_request' });
      if (!(await exists(p.data.id))) return reply.code(404).send({ error: 'not_found' });
      await mgr.setPaused(p.data.id, action === 'pause');
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
    if (snap.code) send({ type: 'pairing_code', code: snap.code });

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
