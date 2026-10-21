import { buildApp } from './app.js';
import { ChannelManager } from './channels/manager.js';
import { purgeOldMessages } from './inbox.js';
import { MediaService } from './media/store.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
await migrate(db);
const media = new MediaService(db, cfg);
await media.init();
const mgr = new ChannelManager(db, cfg, undefined, media);
const app = await buildApp(cfg, db, mgr, media);
await mgr.startAll();

const purge = () => purgeOldMessages(db, cfg.MESSAGE_RETENTION_DAYS, media).catch((err) => app.log.error({ err }, 'retention purge failed'));
void purge();
setInterval(purge, 24 * 3600 * 1000).unref();
// Retry attachments whose antivirus scan could not complete (scanner down/updating).
setInterval(() => void media.scanPending().catch((err) => app.log.error({ err }, 'scan retry failed')), 60_000).unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await mgr.stopAll();
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ port: cfg.PORT, host: cfg.HOST });
