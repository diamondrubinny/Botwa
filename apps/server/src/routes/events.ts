import type { FastifyInstance } from 'fastify';
import { loadAccessible } from '../access.js';
import { loadSession, requireAuth } from '../auth.js';
import type { BusEvent, ChannelManager } from '../channels/manager.js';
import type { Db } from '../db.js';

/**
 * Server-Sent Events for staff: "something changed in conversation X". Carries NO message content;
 * the client refetches through the normal, authorised API. Agents only get events for conversations they may access.
 */
export function eventRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager) {
  app.get('/events', { preHandler: requireAuth(db) }, async (req, reply) => {
    const user = req.user!;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': ready\n\n');

    const onEvent = async (e: BusEvent) => {
      if (e.type !== 'message') return;
      try {
        if (await loadAccessible(db, user, e.conversationId)) res.write(`data: ${JSON.stringify({ type: 'message', conversationId: e.conversationId })}\n\n`);
      } catch { /* DB hiccup: client still polls */ }
    };
    mgr.bus.on('event', onEvent);
    const hb = setInterval(() => res.write(': hb\n\n'), 25_000);
    const recheck = setInterval(async () => {
      const t = req.cookies.botwa_sid;
      if (!t || !(await loadSession(db, t).catch(() => null))) res.end();
    }, 60_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      clearInterval(recheck);
      mgr.bus.off('event', onEvent);
    });
  });
}
