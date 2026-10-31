import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import { isAllowedPushEndpoint, type PushService } from '../push.js';

const sub = z.object({
  endpoint: z.string().url().max(1000).refine(isAllowedPushEndpoint, 'endpoint_not_allowed'),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});

export function pushRoutes(app: FastifyInstance, db: Db, push: PushService) {
  const any = requireAuth(db);
  const limit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  app.get('/push/key', { preHandler: any }, async () => ({ publicKey: push.getPublicKey() }));

  app.post('/push/subscribe', { preHandler: any, config: limit }, async (req, reply) => {
    const b = sub.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    // an endpoint belongs to one person: re-subscribing on a shared device moves it to the current user
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user!.id, b.data.endpoint, b.data.keys.p256dh, b.data.keys.auth],
    );
    return { ok: true };
  });

  app.post('/push/unsubscribe', { preHandler: any, config: limit }, async (req, reply) => {
    const b = z.object({ endpoint: z.string().max(1000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [b.data.endpoint, req.user!.id]);
    return { ok: true };
  });
}
