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
  const manage = requireAuth(db, 'settings.manage');
  const view = requireAuth(db, 'settings.view');
  const botView = requireAuth(db, 'bot.view');
  const botManage = requireAuth(db, 'bot.manage');

  app.get('/settings/business-hours', { preHandler: view }, async () => loadBusinessHours(db));

  app.put('/settings/business-hours', { preHandler: manage }, async (req, reply) => {
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

  app.get('/settings/routing', { preHandler: view }, async () => loadRouting(db));

  app.put('/settings/routing', { preHandler: manage }, async (req, reply) => {
    const b = routingSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('routing', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(b.data)],
    );
    await audit(db, { actorId: req.user!.id, action: 'settings.routing', ip: req.ip, meta: b.data });
    return b.data;
  });

  app.get('/settings/bot', { preHandler: botView }, async () => {
    const bot = await loadBot(db);
    return { ...bot, preview: formatMenu(bot) };
  });

  // People a menu item may hand the conversation to.
  app.get('/settings/bot/assignees', { preHandler: botView }, async () => (await db.query(`SELECT id, name FROM users WHERE active ORDER BY lower(name)`)).rows);

  app.put('/settings/bot', { preHandler: botManage }, async (req, reply) => {
    const b = botSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const routed = [...new Set(b.data.items.flatMap((i) => (i.route ? [i.route.userId] : [])))];
    if (routed.length) {
      const ok = await db.query(`SELECT count(*)::int AS n FROM users WHERE active AND id = ANY($1::uuid[])`, [routed]);
      if (ok.rows[0].n !== routed.length) return reply.code(400).send({ error: 'unknown_user' });
    }
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('bot', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(b.data)],
    );
    await audit(db, { actorId: req.user!.id, action: 'settings.bot', ip: req.ip, meta: { enabled: b.data.enabled, items: b.data.items.length } });
    return { ...b.data, preview: formatMenu(b.data) };
  });

  app.get('/settings/sending', { preHandler: view }, async () => loadSending(db));

  app.put('/settings/sending', { preHandler: manage }, async (req, reply) => {
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
