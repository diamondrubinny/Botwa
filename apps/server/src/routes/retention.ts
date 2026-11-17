import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { MediaService } from '../media/store.js';
import { retentionPolicy, retentionRuns, runRetention } from '../retention.js';

/** Settings > retention policy: the rules in force (from the server configuration) and what each run deleted (counts only). */
export function retentionRoutes(app: FastifyInstance, db: Db, cfg: Config, media?: MediaService) {
  const admin = requireAuth(db, 'settings.manage');
  app.get('/privacy/retention', { preHandler: admin }, async () => ({ policy: retentionPolicy(cfg), runs: await retentionRuns(db) }));
  app.post('/privacy/retention/run', { preHandler: admin, config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const r = await runRetention(db, cfg, media, true);
    if (r.error === 'already_running') return reply.code(409).send({ error: 'already_running' });
    await audit(db, { actorId: req.user!.id, action: 'privacy.retention_run', ip: req.ip, meta: { counts: r.counts } });
    return r;
  });
}
