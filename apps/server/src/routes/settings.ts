import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { businessHoursSchema, DEFAULT_HOURS, type BusinessHours } from '../business-hours.js';
import type { Db } from '../db.js';

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
}
