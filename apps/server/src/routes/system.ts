import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import type { ChannelManager } from '../channels/manager.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { MediaService } from '../media/store.js';
import { systemHealth } from '../system/health.js';
import { offsiteStatus } from '../system/offsite.js';

/** Settings > system status: the server, channels, files, backups and the retention clean-up, checked now (admins). */
export function systemRoutes(app: FastifyInstance, db: Db, cfg: Config, mgr: ChannelManager, media: MediaService) {
  const admin = requireAuth(db, 'settings.manage');
  app.get('/system/health', { preHandler: admin, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () =>
    systemHealth(db, cfg, media, { channels: () => mgr.channelStates(), offsite: () => offsiteStatus(db, cfg) }));
}
