import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATIONS } from '../src/automations.js';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT } from '../src/bot.js';
import { isSensitive, pickGif } from '../src/bot-gifs.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter, OutboundMedia } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { seedGifPresets } from '../src/gif-presets.js';
import { MediaService } from '../src/media/store.js';
import { migrate } from '../src/migrate.js';

describe('when a GIF is out of place', () => {
  it('sensitive topics: accidents, injuries, fire, emergencies', () => {
    for (const t of ['הייתה תאונה במעבדה', 'עובד נפגע', 'יש שריפה בבניין 3', 'דליפה של גז', 'זה דחוף!', 'מקרה חירום', 'accident in lab']) expect(isSensitive(t), t).toBe(true);
    for (const t of ['שלום', 'תודה רבה, אתם אחלה', 'אשמח לשאול על הדרכת בטיחות', 'מה שעות הפעילות?']) expect(isSensitive(t), t).toBe(false);
  });
});

describe('Betty adds a GIF at pleasant moments', () => {
  const ORIGIN = 'https://panel.test';
  let db: ReturnType<typeof createDb>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let ctxA: AdapterContext;
  const out: { text?: string; media?: OutboundMedia; to: string }[] = [];
  class Fake implements ChannelAdapter {
    constructor(c: AdapterContext) { ctxA = c; }
    async start() { ctxA.events.onStatus('connected'); }
    async stop() {}
    async logout() {}
    async sendText(to: string, text: string) { out.push({ to, text }); return { externalMessageId: `t${out.length}` }; }
    async sendMedia(to: string, media: OutboundMedia) { out.push({ to, media }); return { externalMessageId: `m${out.length}` }; }
  }
  let mid = 0;
  const say = async (who: string, text: string) => {
    out.length = 0;
    await ctxA.events.onMessage({ externalContactId: who, externalMessageId: `bg${++mid}`, text, timestamp: new Date() });
    return { texts: out.filter((o) => o.text).map((o) => o.text!), gifs: out.filter((o) => o.media).map((o) => o.media!.fileName) };
  };
  const setBot = (over: object = {}) => db.query(`INSERT INTO settings (key, value) VALUES ('bot', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ...DEFAULT_BOT, enabled: true, mode: 'menu', ...over })]);
  const cool = (who: string) => db.query(`UPDATE conversations SET last_bot_gif_at = NULL WHERE contact_id = (SELECT id FROM contacts WHERE external_id = $1)`, [who]);

  beforeAll(async () => {
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'botwa-gifs-'));
    const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', MEDIA_ALLOW_UNSCANNED: 'true', MEDIA_DIR: mediaDir });
    db = createDb(cfg.DATABASE_URL);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    // the agent introduction has its own tests; here only the bot speaks
    await db.query(`INSERT INTO settings (key, value) VALUES ('automations', $1)`, [JSON.stringify({ ...DEFAULT_AUTOMATIONS, introduce: { ...DEFAULT_AUTOMATIONS.introduce, enabled: false } })]);
    expect(await seedGifPresets(db, async () => null)).toBe(12);
    const media = new MediaService(db, cfg);
    await media.init();
    mgr = new ChannelManager(db, cfg, ((ty, c) => (ty === 'whatsapp' ? new Fake(c) : null)) as AdapterFactory, media);
    app = await buildApp(cfg, db, mgr, media);
    const ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp', 'WA') RETURNING id`)).rows[0].id;
    await mgr.start(ch);
    await new Promise((r) => setTimeout(r, 30));
    await setBot();
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('greets a new inquiry with a hello GIF after the menu, stored like any sent file', async () => {
    const r = await say('g1@s.whatsapp.net', 'שלום');
    expect(r.texts[0]).toContain('במה אפשר לעזור');
    expect(r.gifs).toEqual(['שלום!.gif']);
    const m = (await db.query(`SELECT m.auto, a.mime FROM messages m JOIN attachments a ON a.message_id = m.id JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = 'g1@s.whatsapp.net'`)).rows;
    expect(m).toEqual([{ auto: true, mime: 'image/gif' }]);
  });

  it('a thank-you gets a "glad to help" GIF, but not twice within the cool-down', async () => {
    expect((await say('g1@s.whatsapp.net', 'תודה רבה')).gifs).toEqual([]);           // the hello GIF was just sent
    await cool('g1@s.whatsapp.net');
    expect((await say('g1@s.whatsapp.net', 'תודה רבה')).gifs).toEqual(['שמחנו לעזור.gif']);
  });

  it('never on a sensitive topic', async () => {
    const r = await say('g2@s.whatsapp.net', 'שלום, הייתה תאונה במעבדה');
    expect(r.texts.length).toBeGreaterThan(0);
    expect(r.gifs).toEqual([]);
  });

  it('a hand-over to a person: "on the way" GIF after the hand-over message', async () => {
    const r = await say('g3@s.whatsapp.net', 'נציג');
    expect(r.texts.join(' ')).toContain('מעביר אותך לנציג');
    expect(r.gifs).toEqual(['נציג-ה בדרך אליך.gif']);
  });

  it('the customer closes the inquiry: a nice-day GIF', async () => {
    await cool('g3@s.whatsapp.net');
    const r = await say('g3@s.whatsapp.net', 'הסתדרתי, תסגרו את הקריאה');
    expect(r.gifs.length).toBe(1);
    expect(['יום נעים!.gif', 'שמרו על עצמכם.gif']).toContain(r.gifs[0]);
  });

  it('respects the settings and the "לא לבוט" mark; the official channel needs the MP4 copy', async () => {
    await setBot({ gifs: { ...DEFAULT_BOT.gifs, enabled: false } });
    expect((await say('g4@s.whatsapp.net', 'שלום')).gifs).toEqual([]);
    await setBot({ gifs: { ...DEFAULT_BOT.gifs, greeting: false } });
    expect((await say('g5@s.whatsapp.net', 'שלום')).gifs).toEqual([]);
    await setBot();
    await db.query(`UPDATE gif_gallery SET keywords = keywords || ' לא לבוט' WHERE title = 'שלום!'`);
    expect((await say('g6@s.whatsapp.net', 'שלום')).gifs).toEqual([]);
    expect(await pickGif(db, 'thanks', true)).toBeNull();                              // no MP4 copies in this test
    expect((await pickGif(db, 'thanks'))?.title).toBe('שמחנו לעזור');
  });

  it('the setting is saved through the API with its defaults kept for older settings', async () => {
    const v = (await db.query(`SELECT value FROM settings WHERE key = 'bot'`)).rows[0].value;
    delete v.gifs;
    await db.query(`UPDATE settings SET value = $1 WHERE key = 'bot'`, [JSON.stringify(v)]);
    const { loadBot } = await import('../src/bot.js');
    expect((await loadBot(db)).gifs).toEqual({ enabled: true, greeting: true, thanks: true, handoff: true, close: true, cooldownMinutes: 360 });
  });
});
