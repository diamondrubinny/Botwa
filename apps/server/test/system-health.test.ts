import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { MediaService } from '../src/media/store.js';
import { migrate } from '../src/migrate.js';
import { HealthAlerts, systemHealth, type HealthItem } from '../src/system/health.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: 'https://p.test', MEDIA_DIR: '/tmp/botwa-health-test/media', BACKUP_DIR: '/tmp/botwa-health-test/backups' });

describe('system status', () => {
  beforeAll(async () => { await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate(db); });
  afterAll(async () => { await db.end(); });

  it('lists the server, channels, files, backups and retention with a level and a value; a channel a person stopped is "off"', async () => {
    const h = await systemHealth(db, cfg, new MediaService(db, cfg), {
      channels: async () => [
        { id: 'a', label: 'ווצאפ', type: 'whatsapp_cloud', status: 'connected', since: null, autoStart: true },
        { id: 'b', label: 'טלגרם', type: 'telegram', status: 'error', since: Date.now() - 20 * 60_000, autoStart: true },
        { id: 'c', label: 'ישן', type: 'whatsapp', status: 'stopped', since: null, autoStart: false },
      ],
      offsite: async () => ({ configured: false, lastAt: null, lastOk: null, lastError: null, lastCheckAt: null, lastCheckOk: null }),
    });
    const by = Object.fromEntries(h.items.map((i) => [i.key, i]));
    expect(by.db!.level).toBe('ok');
    expect(by['channel:a']).toMatchObject({ level: 'ok', value: 'מחובר' });
    expect(by['channel:b']).toMatchObject({ level: 'error', value: 'שגיאה (לפני 20 דק׳)' });
    expect(by['channel:c']!.level).toBe('off');
    expect(by.scanner).toMatchObject({ level: 'off' });                                   // no ClamAV and files not accepted unscanned
    expect(by.backup!.level).toBe('warn');                                                // no backups, automatic backup off
    expect(by.offsite).toMatchObject({ level: 'off', value: 'לא מוגדר' });
    expect(by.retention).toMatchObject({ level: 'warn', value: 'עוד לא רץ' });
    expect(by.disk_media!.value).toMatch(/% בשימוש/);
  });

  it('alerts: a dropped channel after 10 minutes, a disk at once; once each, and a note when it recovers', () => {
    const sent: string[] = [];
    const a = new HealthAlerts((t) => sent.push(t));
    const ch: HealthItem = { key: 'channel:b', group: 'channels', label: 'ערוץ: טלגרם', level: 'error', value: 'שגיאה' };
    const disk: HealthItem = { key: 'disk_media', group: 'files', label: 'דיסק', level: 'error', value: '95%' };
    const t = Date.now();
    a.check([ch, disk], t);
    expect(sent).toEqual(['⚠️ מצב המערכת: דיסק: 95%']);
    a.check([ch, disk], t + 5 * 60_000);
    expect(sent).toHaveLength(1);                                                          // the channel has 10 minutes to come back
    a.check([ch, disk], t + 11 * 60_000);
    expect(sent[1]).toBe('⚠️ מצב המערכת: ערוץ: טלגרם: שגיאה');
    a.check([ch, disk], t + 20 * 60_000);
    expect(sent).toHaveLength(2);                                                          // once
    a.check([{ ...ch, level: 'ok', value: 'מחובר' }, { ...disk, level: 'ok', value: '50%' }], t + 30 * 60_000);
    expect(sent.slice(2).sort()).toEqual(['✅ חזר לתקינות: דיסק: 50%', '✅ חזר לתקינות: ערוץ: טלגרם: מחובר']);
    // a channel that came back by itself within 10 minutes: no alert at all
    const b = new HealthAlerts((x) => sent.push(x)); sent.length = 0;
    b.check([ch], t); b.check([{ ...ch, level: 'ok' }], t + 3 * 60_000);
    expect(sent).toEqual([]);
  });
});
