import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { BACKUP_NAME, backupPath, createBackup, listBackups, verifyBackup } from '../backup.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { checkOffsite, offsiteConfigured, offsiteStatus, uploadBackup } from '../system/offsite.js';
import { unlink } from 'node:fs/promises';

/** Admin-only. Backups are encrypted at rest; downloading one is audited. Restore is CLI-only by design. */
export function backupRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  const adminOnly = requireAuth(db, 'backups.manage');

  app.get('/backups', { preHandler: adminOnly }, async () => listBackups(cfg));

  // the copy outside the server (S3-compatible storage): status, upload one now, and the restore check of the newest copy there
  app.get('/backups/offsite', { preHandler: adminOnly }, async () => offsiteStatus(db, cfg));
  app.post('/backups/offsite/check', { preHandler: adminOnly, config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (!offsiteConfigured(cfg)) return reply.code(409).send({ error: 'offsite_not_configured' });
    const r = await checkOffsite(db, cfg);
    await audit(db, { actorId: req.user!.id, action: 'backup.offsite_check', ip: req.ip, meta: { ok: r.ok, name: r.name } });
    return r;
  });
  app.post('/backups/:name/offsite', { preHandler: adminOnly, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!BACKUP_NAME.test(name)) return reply.code(400).send({ error: 'bad_request' });
    if (!offsiteConfigured(cfg)) return reply.code(409).send({ error: 'offsite_not_configured' });
    const r = await uploadBackup(db, cfg, name);
    await audit(db, { actorId: req.user!.id, action: 'backup.offsite_upload', target: name, ip: req.ip, meta: { ok: r.ok } });
    return r.ok ? r : reply.code(r.error === 'busy' ? 409 : 502).send({ error: r.error === 'busy' ? 'offsite_busy' : 'offsite_failed', detail: r.error });
  });

  app.post('/backups', { preHandler: adminOnly, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const kind = (req.body as { kind?: string } | null)?.kind === 'db' ? 'db' : 'full';   // full = database + attachment files
    try {
      const b = await createBackup(cfg, kind);
      await audit(db, { actorId: req.user!.id, action: 'backup.create', target: b.name, ip: req.ip, meta: { kind } });
      return reply.code(201).send(b);
    } catch (e) {
      if ((e as Error).message === 'backup_in_progress') return reply.code(409).send({ error: 'backup_in_progress' });
      req.log.error({ err: e }, 'backup failed');
      return reply.code(500).send({ error: 'backup_failed' });
    }
  });

  app.get('/backups/:name', { preHandler: adminOnly }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!BACKUP_NAME.test(name) || !(await listBackups(cfg)).some((b) => b.name === name)) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'backup.download', target: name, ip: req.ip });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .send(createReadStream(backupPath(cfg, name)));
  });

  // Restore rehearsal: proves the file decrypts with the current key and holds a complete dump, without restoring anything.
  app.post('/backups/:name/verify', { preHandler: adminOnly, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!BACKUP_NAME.test(name) || !(await listBackups(cfg)).some((b) => b.name === name)) return reply.code(404).send({ error: 'not_found' });
    const r = await verifyBackup(cfg, backupPath(cfg, name));
    await audit(db, { actorId: req.user!.id, action: 'backup.verify', target: name, ip: req.ip, meta: { ok: r.ok } });
    return r;
  });

  app.delete('/backups/:name', { preHandler: adminOnly }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!BACKUP_NAME.test(name) || !(await listBackups(cfg)).some((b) => b.name === name)) return reply.code(404).send({ error: 'not_found' });
    await unlink(backupPath(cfg, name));
    await audit(db, { actorId: req.user!.id, action: 'backup.delete', target: name, ip: req.ip });
    return { ok: true };
  });
}
