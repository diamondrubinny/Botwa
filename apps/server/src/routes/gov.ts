import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import { type GovImporter, validTitle } from '../kb/gov/importer.js';
import { ATTRIBUTION } from '../kb/gov/notes.js';
import { DEFAULT_TITLES } from '../kb/gov/wikisource.js';

/**
 * Automatic import of laws and regulations on safety at work into the knowledge base (stage 1: the Open Law Book on Wikisource).
 * Only staff who manage the knowledge base may change it or start an import; every change is audited.
 */
export function govRoutes(app: FastifyInstance, db: Db, gov: GovImporter) {
  const manage = requireAuth(db, 'kb.manage');

  app.get('/kb/gov', { preHandler: manage }, async () => ({
    settings: await gov.settings(),
    defaults: DEFAULT_TITLES,
    attribution: ATTRIBUTION,
    running: gov.isRunning(),
    imported: await gov.imported(),
  }));

  app.put('/kb/gov', { preHandler: manage, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({
      enabled: z.boolean(),
      audience: z.enum(['bot', 'staff', 'both']),
      refreshDays: z.number().int().min(1).max(90),
      selection: z.array(z.string().trim().min(5).max(200)).max(150),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const selection = [...new Set(b.data.selection)];
    if (!selection.every(validTitle)) return reply.code(400).send({ error: 'bad_title' });
    await db.query(
      `UPDATE gov_sources SET enabled = $1, audience = $2, refresh_days = $3, selection = $4, updated_at = now() WHERE key = 'wikisource'`,
      [b.data.enabled, b.data.audience, b.data.refreshDays, selection]);
    // who may see the texts changes at once, not only at the next import
    await db.query(`UPDATE kb_sources SET audience = $1 WHERE origin = 'gov:wikisource' AND NOT detached`, [b.data.audience]);
    await audit(db, { actorId: req.user!.id, action: 'kb.gov.update', ip: req.ip, meta: { enabled: b.data.enabled, audience: b.data.audience, refreshDays: b.data.refreshDays, titles: selection.length } });
    return { ok: true };
  });

  // The list of laws and regulations available at the source (a few search requests to Wikisource).
  app.post('/kb/gov/catalog', { preHandler: manage, config: { rateLimit: { max: 4, timeWindow: '10 minutes' } } }, async (req, reply) => {
    try {
      const list = await gov.refreshCatalog();
      await audit(db, { actorId: req.user!.id, action: 'kb.gov.catalog', ip: req.ip, meta: { titles: list.length } });
      return { catalog: list };
    } catch (e) {
      req.log.warn({ err: e }, 'law catalog failed');
      return reply.code(502).send({ error: 'source_unavailable' });
    }
  });

  // Import now. Runs in the background (can take minutes: Wikimedia allows only a slow pace); the screen polls GET /kb/gov.
  app.post('/kb/gov/sync', { preHandler: manage, config: { rateLimit: { max: 4, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (gov.isRunning()) return reply.code(202).send({ started: false, running: true });
    void gov.sync('manual', req.user!.id).catch((err) => req.log.error({ err }, 'law import failed'));
    await audit(db, { actorId: req.user!.id, action: 'kb.gov.sync', ip: req.ip });
    return reply.code(202).send({ started: true, running: true });
  });
}
