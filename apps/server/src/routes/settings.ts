import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { businessHoursSchema, DEFAULT_HOURS, type BusinessHours } from '../business-hours.js';
import type { Db } from '../db.js';
import { botSchema, formatMenu, loadBot } from '../bot.js';
import { loadSending, sendingSchema } from '../channels/sender.js';
import { loadRouting, routingSchema } from '../routing.js';

export async function loadBusinessHours(db: Db): Promise<BusinessHours> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'business_hours'`);
  const parsed = businessHoursSchema.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data : DEFAULT_HOURS;
}

export function settingsRoutes(app: FastifyInstance, db: Db) {
  const adminOnly = requireAuth(db, ['admin']);

  app.get('/settings/business-hours', { preHandler: requireAuth(db, ['admin', 'supervisor']) }, async () => loadBusinessHours(db));

  app.put('/settings/business-hours', { preHandler: adminOnly }, async (req, reply) => {
    const b = businessHoursSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('business_hours', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(b.data)],
    );
    await audit(db, { actorId: req.user!.id, action: 'settings.business_hours', ip: req.ip, meta: { enabled: b.data.enabled } });
    return b.data;
  });

  app.get('/settings/routing', { preHandler: requireAuth(db, ['admin', 'supervisor']) }, async () => loadRouting(db));

  app.put('/settings/routing', { preHandler: adminOnly }, async (req, reply) => {
    const b = routingSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('routing', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(b.data)],
    );
    await audit(db, { actorId: req.user!.id, action: 'settings.routing', ip: req.ip, meta: b.data });
    return b.data;
  });

  app.get('/settings/bot', { preHandler: requireAuth(db, ['admin', 'supervisor']) }, async () => {
    const bot = await loadBot(db);
    return { ...bot, preview: formatMenu(bot) };
  });

  app.put('/settings/bot', { preHandler: adminOnly }, async (req, reply) => {
    const b = botSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('bot', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(b.data)],
    );
    await audit(db, { actorId: req.user!.id, action: 'settings.bot', ip: req.ip, meta: { enabled: b.data.enabled, items: b.data.items.length } });
    return { ...b.data, preview: formatMenu(b.data) };
  });

  app.get('/settings/sending', { preHandler: requireAuth(db, ['admin', 'supervisor']) }, async () => loadSending(db));

  app.put('/settings/sending', { preHandler: adminOnly }, async (req, reply) => {
    const b = sendingSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('sending', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(b.data)],
    );
    await audit(db, { actorId: req.user!.id, action: 'settings.sending', ip: req.ip, meta: b.data });
    return b.data;
  });
}
