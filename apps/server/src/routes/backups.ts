import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { BACKUP_NAME, backupPath, createBackup, listBackups } from '../backup.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { unlink } from 'node:fs/promises';

/** Admin-only. Backups are encrypted at rest; downloading one is audited. Restore is CLI-only by design. */
export function backupRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  const adminOnly = requireAuth(db, 'backups.manage');

  app.get('/backups', { preHandler: adminOnly }, async () => listBackups(cfg));

  app.post('/backups', { preHandler: adminOnly, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    try {
      const b = await createBackup(cfg);
      await audit(db, { actorId: req.user!.id, action: 'backup.create', target: b.name, ip: req.ip });
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

  app.delete('/backups/:name', { preHandler: adminOnly }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!BACKUP_NAME.test(name) || !(await listBackups(cfg)).some((b) => b.name === name)) return reply.code(404).send({ error: 'not_found' });
    await unlink(backupPath(cfg, name));
    await audit(db, { actorId: req.user!.id, action: 'backup.delete', target: name, ip: req.ip });
    return { ok: true };
  });
}
