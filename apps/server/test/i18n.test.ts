import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT } from '../src/bot.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { detectLang, textDir, withDirectionMarks } from '../src/i18n/lang.js';
import { buildDictionary, defaultEntries, translateWith } from '../src/i18n/translate.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('language and direction', () => {
  it('detects Hebrew and English; a number, an emoji, "ok" or a link does not decide', () => {
    expect(detectLang('who is the laser officer?')).toBe('en');
    expect(detectLang('מי הממונה על לייזרים')).toBe('he');
    expect(detectLang('אני רוצה לשאול על SDS')).toBe('he');
    for (const t of ['ok', '305', '👍', 'https://example.com/a', 'BOTWA-12345678']) expect(detectLang(t), t).toBeNull();
  });
  it('direction marks only on lines that start the other way (WhatsApp aligns each line by its first letter)', () => {
    expect(withDirectionMarks('👷 לייזרים:\nariec@technion.ac.il\nאריה כהן\n☎️ 04-829-1111')).toBe('👷 לייזרים:\n\u200Fariec@technion.ac.il\nאריה כהן\n\u200F☎️ 04-829-1111');
    expect(withDirectionMarks('Your request (number 12)\n04-829-1111')).toBe('Your request (number 12)\n‎04-829-1111');
    expect(textDir('SDS של אצטון')).toBe('rtl');
  });
  it('translates whole texts, lines, list items and changing parts; what has no translation stays as written', () => {
    const d = buildDictionary(defaultEntries());
    expect(translateWith('ברצוני לקבל מידע / לדווח על:\n\n1. לייזרים\n0. נציג אנושי', d)).toBe("I'd like information on / to report:\n\n1. Lasers\n0. A person (agent)");
    expect(translateWith('הפנייה שלך (מספר 7) נמצאת בטיפול של דנה.', d)).toBe('Your request (number 7) is being handled by דנה.');
    expect(translateWith('משפט שאין לו תרגום', d)).toBe('משפט שאין לו תרגום');
  });
});

describe('a conversation in English', () => {
  const ORIGIN = 'https://panel.test';
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let ctxA: AdapterContext;
  const out: { to: string; text: string }[] = [];
  let n = 0, mid = 0, cookie = '';
  class Fake implements ChannelAdapter {
    constructor(c: AdapterContext) { ctxA = c; }
    async start() { ctxA.events.onStatus('connected'); }
    async stop() {} async logout() {}
    async sendText(to: string, text: string) { out.push({ to, text }); return { externalMessageId: `t${++n}` }; }
  }
  const say = async (from: string, text: string) => {
    out.length = 0;
    await ctxA.events.onMessage({ externalContactId: from, externalMessageId: `in${++mid}`, text, timestamp: new Date() });
    return out.filter((o) => o.to === from).map((o) => o.text).join('\n');
  };
  const conv = async (ext: string) => (await db.query(`SELECT c.* FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [ext])).rows[0];
  const tags = async (id: string) => (await db.query(`SELECT t.name FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = $1`, [id])).rows.map((r) => r.name);

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, ((ty, c) => (ty === 'whatsapp' ? new Fake(c) : null)) as AdapterFactory);
    app = await buildApp(cfg, db, mgr);
    await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('boss@t.io', 'boss', 'admin', $1)`, [await hashPassword('correct-horse-battery')]);
    cookie = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'boss@t.io', password: 'correct-horse-battery' }, remoteAddress: '10.88.0.1', headers: { origin: ORIGIN } })).cookies[0]!.value}`;
    const o = (await db.query(`INSERT INTO officers (name, office_phone, email) VALUES ('אריה כהן', '04-829-1111', 'arie@t.io') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO officer_topics (officer_id, topic) VALUES ($1, 'לייזרים')`, [o]);
    await db.query(`INSERT INTO settings (key, value) VALUES ('bot', $1)`, [{ ...DEFAULT_BOT, enabled: true }]);
    await db.query(`INSERT INTO settings (key, value) VALUES ('bot_persona', '{"name": "בטי", "role": "הבוט של יחידת הבטיחות"}') ON CONFLICT (key) DO NOTHING`);
    const ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp', 'WA') RETURNING id`)).rows[0].id;
    await mgr.start(ch);
    await new Promise((r) => setTimeout(r, 30));
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('Betty answers in English, the conversation gets an "English" tag; back in Hebrew, Hebrew again', async () => {
    const ext = '972500001111@s.whatsapp.net';
    const who = await say(ext, 'Hi, who is the laser officer?');
    expect(who).toContain('👷 Lasers:');
    expect(who).toContain('Office phone: 04-829-1111');
    const c = await conv(ext);
    expect(c.lang).toBe('en');
    expect(await tags(c.id)).toContain('English');
    // the stored copy is what the customer got (in English), without the invisible direction marks
    expect((await db.query(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY created_at DESC LIMIT 1`, [c.id])).rows[0].body).toContain('👷 Lasers:');
    expect(await say(ext, 'are you there?')).toContain("Yes, I'm here with you");
    expect(await say(ext, 'how are you?')).toContain("Thanks for asking, I'm doing well");
    const tip = await say(ext, 'tell me a safety tip');
    expect(tip).toContain('💡 Did you know?');
    expect(await say(ext, 'more')).toContain('💡 Did you know?');
    expect(await say(ext, 'are you a bot?')).toMatch(/^I'm Betty, the safety unit bot 🤖/);
    // in Hebrew again: Hebrew, and the tag comes off
    expect(await say(ext, 'מה שלומך?')).toContain('תודה ששאלת');
    expect((await conv(ext)).lang).toBe('he');
    expect(await tags(c.id)).not.toContain('English');
  });

  it('stress, hazards and emergencies in English get the English answers', async () => {
    const a = await say('972500002222@s.whatsapp.net', "I'm really stressed, I don't know what to do");
    expect(a).toContain("It's completely understandable that this is stressful");
    const h = await say('972500003333@s.whatsapp.net', 'there is a laser hazard in the lab');
    expect(h).toContain('⚠️ Thank you for reporting this');
    expect(h).toContain('Do not look towards the beam');
    const e = await say('972500004444@s.whatsapp.net', 'emergency! someone is injured');
    expect(e).toContain('Magen David Adom (ambulance) 101');
  });

  it('the translations screen: what is in use without English comes first; the unit\'s own wording is used', async () => {
    const get = async () => (await app.inject({ method: 'GET', url: '/settings/translations', headers: { cookie, origin: ORIGIN } })).json();
    const r = await get();
    expect(r.items.find((i: { he: string }) => i.he === 'לייזרים').en).toBe('Lasers');
    const put = await app.inject({ method: 'PUT', url: '/settings/translations', headers: { cookie, origin: ORIGIN }, payload: { entries: { 'כן, אני כאן איתך 😊': 'Yes, Betty is here 😊' } } });
    expect(put.statusCode).toBe(200);
    const ext = '972500005555@s.whatsapp.net';
    await say(ext, 'hello there, I have a question');
    expect(await say(ext, 'are you there?')).toContain('Yes, Betty is here');
  });
});
