import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import { type GovImporter, validTitle } from '../kb/gov/importer.js';
import { ATTRIBUTION, STANDARDS_ATTRIBUTION } from '../kb/gov/notes.js';
import { DEFAULT_KEYWORDS, STANDARDS_DATASET_URL, type StandardsImporter } from '../kb/gov/standards.js';
import { FIRE_DATASET_URL, type FireImporter } from '../kb/gov/fire.js';
import { FIRE_ATTRIBUTION } from '../kb/gov/notes.js';
import { DEFAULT_TITLES } from '../kb/gov/wikisource.js';

/**
 * Automatic import of laws and regulations on safety at work into the knowledge base (stage 1: the Open Law Book on Wikisource).
 * Only staff who manage the knowledge base may change it or start an import; every change is audited.
 */
export function govRoutes(app: FastifyInstance, db: Db, gov: GovImporter, std: StandardsImporter, fire: FireImporter) {
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

  // ---- stage 2: the official standards list (data.gov.il) ----
  app.get('/kb/gov/standards', { preHandler: manage }, async () => ({
    settings: await std.settings(), defaults: DEFAULT_KEYWORDS, attribution: STANDARDS_ATTRIBUTION, dataset: STANDARDS_DATASET_URL, running: std.isRunning(), imported: await std.imported(),
  }));

  app.put('/kb/gov/standards', { preHandler: manage, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({
      enabled: z.boolean(),
      audience: z.enum(['bot', 'staff', 'both']),
      refreshDays: z.number().int().min(1).max(90),
      includeAll: z.boolean(),
      // plain words (Hebrew/English letters, digits, quote marks of abbreviations, spaces, a final *)
      keywords: z.array(z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N}"״' -]+\*?$/u)).max(200),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const keywords = [...new Set(b.data.keywords)];
    await db.query(`UPDATE gov_sources SET enabled = $1, audience = $2, refresh_days = $3, include_all = $4, keywords = $5, updated_at = now() WHERE key = 'standards'`,
      [b.data.enabled, b.data.audience, b.data.refreshDays, b.data.includeAll, keywords]);
    await db.query(`UPDATE kb_sources SET audience = $1 WHERE origin = 'gov:standards' AND NOT detached`, [b.data.audience]);
    await audit(db, { actorId: req.user!.id, action: 'kb.gov.standards.update', ip: req.ip, meta: { enabled: b.data.enabled, audience: b.data.audience, includeAll: b.data.includeAll, keywords: keywords.length } });
    return { ok: true };
  });

  app.post('/kb/gov/standards/sync', { preHandler: manage, config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (std.isRunning()) return reply.code(202).send({ started: false, running: true });
    void std.sync('manual', req.user!.id).catch((err) => req.log.error({ err }, 'standards import failed'));
    await audit(db, { actorId: req.user!.id, action: 'kb.gov.standards.sync', ip: req.ip });
    return reply.code(202).send({ started: true, running: true });
  });

  // ---- stage 4: fire-safety requirements for business licensing (data.gov.il) ----
  app.get('/kb/gov/fire', { preHandler: manage }, async () => ({
    settings: await fire.settings(), attribution: FIRE_ATTRIBUTION, dataset: FIRE_DATASET_URL, running: fire.isRunning(), imported: await fire.imported(),
  }));

  app.put('/kb/gov/fire', { preHandler: manage, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({
      enabled: z.boolean(),
      audience: z.enum(['bot', 'staff', 'both']),
      refreshDays: z.number().int().min(1).max(90),
      selection: z.array(z.string().regex(/^\d{1,2}\.\d{2}$/)).max(150),   // business type numbers of the licensing order ("1.01")
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const selection = [...new Set(b.data.selection)];
    await db.query(`UPDATE gov_sources SET enabled = $1, audience = $2, refresh_days = $3, selection = $4, updated_at = now() WHERE key = 'fire'`, [b.data.enabled, b.data.audience, b.data.refreshDays, selection]);
    await db.query(`UPDATE kb_sources SET audience = $1 WHERE origin = 'gov:fire' AND NOT detached`, [b.data.audience]);
    await audit(db, { actorId: req.user!.id, action: 'kb.gov.fire.update', ip: req.ip, meta: { enabled: b.data.enabled, audience: b.data.audience, types: selection.length } });
    return { ok: true };
  });

  // Import now (also loads the list of business types the first time). A few seconds to a minute: about 22,000 rows in pages.
  app.post('/kb/gov/fire/sync', { preHandler: manage, config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (fire.isRunning()) return reply.code(202).send({ started: false, running: true });
    void fire.sync('manual', req.user!.id).catch((err) => req.log.error({ err }, 'fire requirements import failed'));
    await audit(db, { actorId: req.user!.id, action: 'kb.gov.fire.sync', ip: req.ip });
    return reply.code(202).send({ started: true, running: true });
  });
}
