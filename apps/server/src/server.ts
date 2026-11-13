import { runAutomations } from './automations.js';
import { sendAlert } from './alerts.js';
import { sendDueScheduled } from './scheduled.js';
import { buildApp } from './app.js';
import { ChannelManager } from './channels/manager.js';
import { purgeOldMessages } from './inbox.js';
import { createBackup, verifyBackup, backupPath } from './backup.js';
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
// Knowledge base: resume unfinished link imports, re-read links whose refresh time has come, drop old question logs.
void mgr.kb?.resumePending().catch((err) => app.log.error({ err }, 'kb resume failed'));
setInterval(() => void mgr.supervise().catch((err) => app.log.error({ err }, 'channel supervision failed')), 60_000).unref();
setInterval(() => void sendDueScheduled(db, mgr).catch((err) => app.log.error({ err }, 'scheduled send failed')), 60_000).unref();
setInterval(() => void mgr.checkSla().catch((err) => app.log.error({ err }, 'sla check failed')), 60_000).unref();
setInterval(() => void runAutomations(db, mgr).catch((err) => app.log.error({ err }, 'automations failed')), 60_000).unref();
setInterval(() => void mgr.retryForwards().catch((err) => app.log.error({ err }, 'group forward retry failed')), 60_000).unref();
setInterval(() => void mgr.catchUp().catch((err) => app.log.error({ err }, 'bot catch-up failed')), 60_000).unref();
setInterval(() => void mgr.kb?.embedMissing().catch((err) => app.log.error({ err }, 'kb embed failed')), 600_000).unref();
setInterval(() => void mgr.gov?.runDue().then((r) => { if (r?.failed.length) void sendAlert(cfg, `ייבוא החקיקה למאגר הידע: ${r.failed.length} כשלים (${r.failed.map((f) => f.error).slice(0, 3).join(', ')})`); if (r?.knesset?.repealed.length) void sendAlert(cfg, `לפי מאגר החקיקה של הכנסת בוטלו: ${r.knesset.repealed.join(', ')}. הם הושבתו במאגר הידע.`); }).catch((err) => app.log.error({ err }, 'law import failed')), 3600_000).unref();
setInterval(() => void mgr.standards?.runDue().then((r) => { if (r?.failed.length) void sendAlert(cfg, `ייבוא התקנים הרשמיים למאגר הידע נכשל (${r.failed.map((f) => f.error).slice(0, 3).join(', ')})`); }).catch((err) => app.log.error({ err }, 'standards import failed')), 3600_000).unref();
setInterval(() => void mgr.fire?.runDue().then((r) => { if (r?.failed.length) void sendAlert(cfg, `ייבוא דרישות הכבאות למאגר הידע נכשל (${r.failed.map((f) => f.error).slice(0, 3).join(', ')})`); }).catch((err) => app.log.error({ err }, 'fire requirements import failed')), 3600_000).unref();
setInterval(() => void mgr.kb?.refreshDue().catch((err) => app.log.error({ err }, 'kb refresh failed')), 3600_000).unref();
// learning suggestions nobody approved: kept 90 days at most (they may hold customers' wording)
setInterval(() => void db.query(`DELETE FROM kb_learn WHERE status <> 'approved' AND updated_at < now() - interval '90 days'`).catch((err) => app.log.error({ err }, 'learning purge failed')), 24 * 3600_000).unref();
setInterval(() => void db.query(`DELETE FROM webchat_visitors WHERE last_seen_at < now() - interval '90 days'`).catch((err) => app.log.error({ err }, 'webchat purge failed')), 24 * 3600_000).unref();
setInterval(() => void mgr.kb?.purgeOldQueries(cfg.KB_QUERY_RETENTION_DAYS).catch((err) => app.log.error({ err }, 'kb purge failed')), 24 * 3600_000).unref();

const purge = () => purgeOldMessages(db, cfg.MESSAGE_RETENTION_DAYS, media).catch((err) => app.log.error({ err }, 'retention purge failed'));
void purge();
setInterval(purge, 24 * 3600 * 1000).unref();
// Optional automatic daily encrypted backup.
if (cfg.BACKUP_AUTO_HOUR !== undefined) {
  let lastDay = '';
  setInterval(() => {
    const now = new Date();
    const day = now.toDateString();
    if (now.getHours() === cfg.BACKUP_AUTO_HOUR && day !== lastDay) {
      lastDay = day;
      createBackup(cfg).then(async (b) => { const v = await verifyBackup(cfg, backupPath(cfg, b.name)); (v.ok ? app.log.info : app.log.error).call(app.log, { backup: b.name, verified: v.ok, reason: v.reason }, 'automatic backup done'); }).catch((err) => app.log.error({ err }, 'automatic backup failed'));
    }
  }, 60_000).unref();
}
// Retry attachments whose antivirus scan could not complete (scanner down/updating).
// antivirus: every hour, files stored a week ago or more are checked again with the current signatures
setInterval(() => void media.rescanClean(200).then((r) => { if (r.infected) void sendAlert(cfg, `🛡️ סריקה חוזרת מצאה ${r.infected} קבצים נגועים; הם נמחקו וסומנו.`); }).catch((err) => app.log.error({ err }, 'rescan failed')), 3600_000).unref();
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
