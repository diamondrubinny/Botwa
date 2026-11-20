import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { firewallSchema, ipMatches, loadFirewall, normalizeIp, type Firewall } from '../firewall.js';
import { clamVersion } from '../media/clamav.js';
import type { MediaService } from '../media/store.js';

/** Security page: the panel firewall (who may open it) and the antivirus (scanner status, re-scanning stored files). */
export function securityRoutes(app: FastifyInstance, db: Db, cfg: Config, fw: Firewall, media: MediaService) {
  const view = requireAuth(db, 'settings.view');
  const manage = requireAuth(db, 'settings.manage');

  app.get('/settings/security', { preHandler: view }, async (req) => {
    const scanner = cfg.CLAMAV_HOST ? await clamVersion({ host: cfg.CLAMAV_HOST, port: cfg.CLAMAV_PORT }) : null;
    const sigAgeDays = scanner && scanner.ok && scanner.signatureDate ? Math.floor((Date.now() - Date.parse(scanner.signatureDate)) / 86400_000) : null;
    const files = (await db.query(
      `SELECT count(*) FILTER (WHERE status = 'clean' AND storage_name IS NOT NULL)::int AS stored,
              count(*) FILTER (WHERE status = 'clean' AND last_scanned_at > now() - interval '7 days')::int AS "checkedThisWeek",
              count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'infected' AND created_at > now() - interval '30 days')::int AS "infected30d"
         FROM attachments`)).rows[0];
    const events = (await db.query(
      `SELECT action, count(*)::int AS n FROM audit_log WHERE created_at > now() - interval '7 days'
          AND action IN ('login.fail', 'login.locked', 'media.infected', 'media.infected_rescan', 'contact.auto_block', 'firewall.update') GROUP BY action`)).rows;
    return {
      firewall: await loadFirewall(db),
      yourIp: normalizeIp(req.ip),
      trustProxy: cfg.TRUST_PROXY,
      emergencyOff: cfg.FIREWALL_DISABLE,
      blockedLastHour: fw.blockedLastHour(),
      antivirus: {
        configured: !!cfg.CLAMAV_HOST,
        allowUnscanned: cfg.MEDIA_ALLOW_UNSCANNED,
        scanner: scanner ? (scanner.ok ? { online: true, engine: scanner.engine, signatures: scanner.signatures, signatureDate: scanner.signatureDate, signatureAgeDays: sigAgeDays } : { online: false, detail: scanner.detail }) : null,
        files,
      },
      events: Object.fromEntries(events.map((e) => [e.action, e.n])),
    };
  });

  app.put('/settings/firewall', { preHandler: manage }, async (req, reply) => {
    const b = firewallSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const s = { ...b.data, allow: [...new Set(b.data.allow.map((x) => x.trim()))], deny: [...new Set(b.data.deny.map((x) => x.trim()))] };
    // never lock out the person saving it
    const me = normalizeIp(req.ip);
    if (s.enabled && s.allow.length === 0) return reply.code(400).send({ error: 'allow_list_empty' });
    if (s.enabled && !ipMatches(me, s.allow)) return reply.code(409).send({ error: 'would_lock_you_out', yourIp: me });
    if (ipMatches(me, s.deny)) return reply.code(409).send({ error: 'would_lock_you_out', yourIp: me });
    await db.query(`INSERT INTO settings (key, value) VALUES ('firewall', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(s)]);
    fw.set(s);
    await audit(db, { actorId: req.user!.id, action: 'firewall.update', ip: req.ip, meta: { enabled: s.enabled, allow: s.allow.length, deny: s.deny.length, applyToApi: s.applyToApi } });
    return s;
  });

  app.post('/settings/security/rescan', { preHandler: manage, config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (!cfg.CLAMAV_HOST) return reply.code(409).send({ error: 'scanner_not_configured' });
    const r = await media.rescanClean(500, 0);
    await audit(db, { actorId: req.user!.id, action: 'media.rescan', ip: req.ip, meta: r });
    return r;
  });
}
