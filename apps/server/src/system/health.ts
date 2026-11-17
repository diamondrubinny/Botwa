import { mkdir, statfs } from 'node:fs/promises';
import { listBackups } from '../backup.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { MediaService } from '../media/store.js';

/** One line of the system status: a level (with words, never colour alone in the panel) and a short value. Counts and times only. */
export type Level = 'ok' | 'warn' | 'error' | 'off';
export interface HealthItem { key: string; group: 'server' | 'channels' | 'files' | 'backup' | 'privacy'; label: string; level: Level; value: string }
export interface ChannelState { id: string; label: string; type: string; status: string; since: number | null; autoStart: boolean }
export interface HealthDeps { channels: () => Promise<ChannelState[]>; offsite?: () => Promise<{ configured: boolean; lastAt: string | null; lastOk: boolean | null; lastError: string | null; lastCheckAt: string | null; lastCheckOk: boolean | null }> }

const ago = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? `לפני ${m} דק׳` : m < 48 * 60 ? `לפני ${Math.round(m / 60)} שע׳` : `לפני ${Math.round(m / 1440)} ימים`; };
const CH_STATUS: Record<string, string> = { connected: 'מחובר', connecting: 'מתחבר', qr: 'ממתין לסריקת QR', stopped: 'עצור', error: 'שגיאה', logged_out: 'נותק מהטלפון', restricted: 'הוגבל ע״י הפלטפורמה', password: 'ממתין לסיסמה' };

async function disk(dir: string): Promise<{ usedPct: number; freeGb: number } | null> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const s = await statfs(dir);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return total ? { usedPct: Math.round(((total - free) / total) * 100), freeGb: Math.round((free / 1024 ** 3) * 10) / 10 } : null;
  } catch { return null; }
}

/** Everything the "system status" card shows, checked now. */
export async function systemHealth(db: Db, cfg: Config, media: MediaService, deps: HealthDeps): Promise<{ checkedAt: string; items: HealthItem[] }> {
  const items: HealthItem[] = [];
  const now = Date.now();

  // the database answers, and how fast
  const t0 = performance.now();
  await db.query('SELECT 1');
  const ms = Math.round(performance.now() - t0);
  items.push({ key: 'db', group: 'server', label: 'מסד הנתונים', level: ms < 300 ? 'ok' : ms < 1500 ? 'warn' : 'error', value: `עונה תוך ${ms} מ״ש` });
  const mem = Math.round(process.memoryUsage().rss / 1024 ** 2);
  items.push({ key: 'process', group: 'server', label: 'שרת Botwa', level: 'ok', value: `פועל ${ago(process.uptime() * 1000).replace('לפני ', '')} · זיכרון ${mem}MB` });

  // channels: a channel a person stopped is "off", one that dropped by itself is an error
  for (const c of await deps.channels()) {
    const level: Level = c.status === 'connected' ? 'ok' : c.status === 'connecting' || c.status === 'qr' || c.status === 'password' ? 'warn' : !c.autoStart && c.status === 'stopped' ? 'off' : 'error';
    items.push({ key: `channel:${c.id}`, group: 'channels', label: `ערוץ: ${c.label}`, level, value: `${CH_STATUS[c.status] ?? c.status}${c.since && c.status !== 'connected' ? ` (${ago(now - c.since)})` : ''}` });
  }
  const paused = (await db.query(`SELECT count(*)::int AS n FROM channel_events WHERE kind = 'auto_paused' AND created_at > now() - interval '24 hours'`)).rows[0].n as number;
  if (paused) items.push({ key: 'auto_paused', group: 'channels', label: 'השהיות אוטומטיות של שליחה', level: 'warn', value: `${paused} ב-24 השעות האחרונות` });
  const failed = (await db.query(
    `SELECT (SELECT count(*) FROM scheduled_messages WHERE status = 'failed' AND send_at > now() - interval '24 hours')
          + (SELECT count(*) FROM forward_log WHERE status = 'failed' AND created_at > now() - interval '24 hours')
          + (SELECT count(*) FROM webhook_deliveries WHERE status = 'failed' AND created_at > now() - interval '24 hours') AS n`)).rows[0].n as string;
  items.push({ key: 'failed_sends', group: 'channels', label: 'שליחות שנכשלו (מתוזמנות, העברות לקבוצות, Webhooks)', level: Number(failed) ? 'warn' : 'ok', value: `${failed} ב-24 השעות האחרונות` });

  // files: the antivirus, files waiting for it, and disk space
  if (!cfg.CLAMAV_HOST) items.push({ key: 'scanner', group: 'files', label: 'סריקת אנטי-וירוס', level: cfg.MEDIA_ALLOW_UNSCANNED ? 'warn' : 'off', value: cfg.MEDIA_ALLOW_UNSCANNED ? 'לא מוגדרת: קבצים מתקבלים בלי סריקה' : 'לא מוגדרת: קבצים לא מתקבלים' });
  else {
    const r = await Promise.race([media.scanBuffer(Buffer.from('botwa-health-check')), new Promise<{ status: 'error'; detail: string }>((res) => setTimeout(() => res({ status: 'error', detail: 'timeout' }), 5000))]).catch(() => ({ status: 'error' as const }));
    items.push({ key: 'scanner', group: 'files', label: 'סריקת אנטי-וירוס (ClamAV)', level: r.status === 'clean' ? 'ok' : 'error', value: r.status === 'clean' ? 'זמינה' : 'לא עונה: קבצים חדשים ממתינים' });
  }
  const pend = (await db.query(`SELECT count(*)::int AS n, min(created_at) AS oldest FROM attachments WHERE status = 'pending'`)).rows[0] as { n: number; oldest: Date | null };
  items.push({ key: 'pending_scans', group: 'files', label: 'קבצים שממתינים לסריקה', level: pend.n && pend.oldest && now - new Date(pend.oldest).getTime() > 10 * 60_000 ? 'warn' : 'ok', value: pend.n ? `${pend.n} (הוותיק ${ago(now - new Date(pend.oldest!).getTime())})` : 'אין' });
  for (const [key, label, dir] of [['disk_media', 'דיסק: קבצים מצורפים', cfg.MEDIA_DIR], ['disk_backup', 'דיסק: גיבויים', cfg.BACKUP_DIR]] as const) {
    const d = await disk(dir);
    items.push(d ? { key, group: 'files', label, level: d.usedPct >= 90 ? 'error' : d.usedPct >= 80 ? 'warn' : 'ok', value: `${d.usedPct}% בשימוש · ${d.freeGb}GB פנויים` } : { key, group: 'files', label, level: 'warn', value: 'לא ניתן לבדוק' });
  }

  // backups: the newest local one, and the copy outside the server
  const list = await listBackups(cfg).catch(() => []);
  const newest = list.map((b) => new Date(b.createdAt).getTime()).sort((a, b) => b - a)[0];
  const auto = cfg.BACKUP_AUTO_HOUR !== undefined;
  items.push(newest
    ? { key: 'backup', group: 'backup', label: 'גיבוי אחרון בשרת', level: now - newest > 36 * 3600_000 ? (auto ? 'error' : 'warn') : 'ok', value: `${ago(now - newest)}${auto ? '' : ' · גיבוי אוטומטי לא מופעל'}` }
    : { key: 'backup', group: 'backup', label: 'גיבוי אחרון בשרת', level: auto ? 'error' : 'warn', value: auto ? 'אין גיבויים' : 'אין גיבויים, וגיבוי אוטומטי לא מופעל' });
  const off = await deps.offsite?.().catch(() => null);
  if (off) {
    if (!off.configured) items.push({ key: 'offsite', group: 'backup', label: 'גיבוי מחוץ לשרת', level: 'off', value: 'לא מוגדר' });
    else {
      const age = off.lastAt ? now - new Date(off.lastAt).getTime() : null;
      items.push({ key: 'offsite', group: 'backup', label: 'גיבוי מחוץ לשרת', level: off.lastOk === false ? 'error' : age === null ? 'warn' : age > 36 * 3600_000 ? 'error' : 'ok', value: off.lastOk === false ? `העלאה אחרונה נכשלה: ${off.lastError ?? ''}` : age === null ? 'עוד לא הועלה' : `הועלה ${ago(age)}` });
      if (off.lastCheckAt) items.push({ key: 'offsite_check', group: 'backup', label: 'בדיקת שחזור מהעותק החיצוני', level: off.lastCheckOk ? 'ok' : 'error', value: `${off.lastCheckOk ? 'הצליחה' : 'נכשלה'} ${ago(now - new Date(off.lastCheckAt).getTime())}` });
    }
  }

  // privacy: the daily retention clean-up ran
  const run = (await db.query(`SELECT ran_at, error FROM retention_runs ORDER BY ran_at DESC LIMIT 1`)).rows[0] as { ran_at: Date; error: string | null } | undefined;
  items.push(run
    ? { key: 'retention', group: 'privacy', label: 'ניקוי לפי מדיניות השמירה', level: run.error ? 'warn' : now - new Date(run.ran_at).getTime() > 48 * 3600_000 ? 'warn' : 'ok', value: `${run.error ? 'עם שגיאות, ' : ''}רץ ${ago(now - new Date(run.ran_at).getTime())}` }
    : { key: 'retention', group: 'privacy', label: 'ניקוי לפי מדיניות השמירה', level: 'warn', value: 'עוד לא רץ' });

  return { checkedAt: new Date().toISOString(), items };
}

/** Alerts for what needs a person: an error line (a dropped channel for 10+ minutes, a full disk, a missing backup), once until it recovers. */
export class HealthAlerts {
  private open = new Map<string, number>();
  constructor(private readonly send: (text: string) => void) {}
  check(items: HealthItem[], now = Date.now()): string[] {
    const sent: string[] = [];
    const errors = new Map(items.filter((i) => i.level === 'error').map((i) => [i.key, i]));
    for (const [key, i] of errors) {
      const first = this.open.get(key);
      if (first === undefined) { this.open.set(key, now); if (!key.startsWith('channel:')) { this.send(`⚠️ מצב המערכת: ${i.label}: ${i.value}`); sent.push(key); this.open.set(key, -1); } continue; }
      // a channel gets 10 minutes to come back by itself (the supervisor restarts it) before anybody is woken up
      if (first > 0 && now - first >= 10 * 60_000) { this.send(`⚠️ מצב המערכת: ${i.label}: ${i.value}`); sent.push(key); this.open.set(key, -1); }
    }
    for (const key of [...this.open.keys()]) if (!errors.has(key)) {
      if (this.open.get(key) === -1) { const i = items.find((x) => x.key === key); if (i) this.send(`✅ חזר לתקינות: ${i.label}: ${i.value}`); }
      this.open.delete(key);
    }
    return sent;
  }
}
