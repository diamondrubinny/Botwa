import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import { incidentSchema, loadIncident, saveIncident } from '../incident.js';
import { sendAlert } from '../alerts.js';
import type { Config } from '../config.js';

/** The wide-emergency switch: everyone signed in sees whether it is on (the banner); managing the bot switches it. */
export function incidentRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  app.get('/incident', { preHandler: requireAuth(db) }, async () => {
    const i = await loadIncident(db);
    const handled = i.active && i.startedAt ? (await db.query(`SELECT count(DISTINCT conversation_id)::int AS n FROM messages WHERE automation = 'incident' AND created_at >= $1`, [i.startedAt])).rows[0].n as number : 0;
    return { ...i, answered: handled };
  });
  app.put('/incident', { preHandler: requireAuth(db, 'bot.manage'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = incidentSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const before = await loadIncident(db);
    const i = await saveIncident(db, b.data, req.user!.id);
    if (before.active !== i.active) {
      await audit(db, { actorId: req.user!.id, action: i.active ? 'incident.start' : 'incident.end', ip: req.ip });
      void sendAlert(cfg, i.active ? `🚨 הופעל מצב אירוע חירום רחב. בטי עונה לכל פונה בהודעת המצב.` : '✅ מצב אירוע החירום הרחב הסתיים.');
    } else await audit(db, { actorId: req.user!.id, action: 'incident.update', ip: req.ip });
    return i;
  });
}
