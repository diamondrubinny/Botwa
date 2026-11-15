import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runComfort } from '../src/automations.js';
import { smallTalkReply, withoutBotName } from '../src/bot-text.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { comfortText, detectDistress, followUpText } from '../src/empathy.js';
import { migrate } from '../src/migrate.js';
import { isWaitingQuestion } from '../src/waiting.js';

describe('recognising stress', () => {
  it('worried, upset, or neither; the technical "לחץ" is not a feeling', () => {
    for (const t of ['אני ממש לחוצה', 'אני מפחד שמשהו לא בסדר', 'לא יודעת מה לעשות', 'נבהלתי מהרעש במעבדה', 'זה מלחיץ אותי']) expect(detectDistress(t), t).toBe('worried');
    for (const t of ['כבר שעה אני מחכה!!', 'אף אחד לא עונה לי', 'זה ממש מתסכל', 'נמאס לי, זה לא מקובל']) expect(detectDistress(t), t).toBe('upset');
    for (const t of ['איך מאחסנים בלון גז בלחץ?', 'מה לחץ העבודה של הדוד', 'מי דואג לציוד המגן?', 'מתח גבוה בלוח החשמל', 'מספר חדר 305', 'תודה רבה']) expect(detectDistress(t), t).toBeNull();
    expect(detectDistress('גז בלחץ דולף ואני ממש לחוץ')).toBe('worried');
  });
  it('texts: the feeling, who handles it, what to send, danger numbers; working hours told honestly', () => {
    const a = comfortText('worried', { who: 'אריה', topic: 'האחראי/ת על אסבסט', closed: false, movedNow: true });
    expect(a).toContain('מלחיץ'); expect(a).toContain('העברתי את הפנייה אל אריה, האחראי/ת על אסבסט'); expect(a).toContain('101');
    expect(comfortText('upset', { who: null, closed: true, hours: 'א׳-ה׳ 08:00-16:00', movedNow: false })).toContain('מחוץ לשעות הפעילות (א׳-ה׳ 08:00-16:00)');
    expect(followUpText(2, { who: 'דנה', closed: false })).toContain('מנהלי היחידה');
  });
  it('"בטי את כאן?", "בטי?", a lone "?" are "are you there", never an answer to her question', () => {
    for (const t of ['בטי את כאן?', 'בטי?', '?', 'יש מישהו?', 'את עדיין כאן?']) expect(smallTalkReply(withoutBotName(t, 'בטי'), 'בטי'), t).toBe('כן, אני כאן איתך 😊');
    for (const t of ['305', 'כאן', 'הנדסת חשמל']) expect(smallTalkReply(withoutBotName(t, 'בטי'), 'בטי'), t).toBeNull();
    expect(isWaitingQuestion('?')).toBe(true);
  });
});

describe('Betty stays with a stressed customer until a person answers', () => {
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: 'https://panel.test', COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
  const db = createDb(cfg.DATABASE_URL);
  let mgr: ChannelManager;
  let ctxA: AdapterContext;
  const out: { to: string; text: string }[] = [];
  let n = 0, mid = 0;
  class Fake implements ChannelAdapter {
    constructor(c: AdapterContext) { ctxA = c; }
    async start() { ctxA.events.onStatus('connected'); }
    async stop() {} async logout() {}
    async sendText(to: string, text: string) { out.push({ to, text }); return { externalMessageId: `e${++n}` }; }
  }
  const say = async (from: string, text: string) => {
    out.length = 0;
    await ctxA.events.onMessage({ externalContactId: from, externalMessageId: `em${++mid}`, text, timestamp: new Date() });
    return out.filter((o) => o.to === from).map((o) => o.text).join('\n');
  };
  const conv = async (ext: string) => (await db.query(`SELECT c.* FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [ext])).rows[0];
  let officer = '';

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    officer = (await db.query(`INSERT INTO users (email, name, name_he, role, password_hash) VALUES ('arie@t.io', 'arie', 'אריה', 'agent', 'x') RETURNING id`)).rows[0].id;
    const o = (await db.query(`INSERT INTO officers (name, email, user_id) VALUES ('אריה כהן', 'arie@t.io', $1) RETURNING id`, [officer])).rows[0].id;
    await db.query(`INSERT INTO officer_topics (officer_id, topic) VALUES ($1, 'אסבסט')`, [o]);
    await db.query(`INSERT INTO settings (key, value) VALUES ('bot', '{"enabled": true}') ON CONFLICT (key) DO UPDATE SET value = jsonb_set(settings.value, '{enabled}', 'true')`);
    mgr = new ChannelManager(db, cfg, ((ty, c) => (ty === 'whatsapp' ? new Fake(c) : null)) as AdapterFactory);
    const ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp', 'WA') RETURNING id`)).rows[0].id;
    await mgr.start(ch);
    await new Promise((r) => setTimeout(r, 30));
  });
  afterAll(async () => { await mgr.stopAll(); await db.end(); });

  it('acknowledges, hands the inquiry to the officer for the topic, tags it and starts the follow-ups', async () => {
    const ext = '972500000777@s.whatsapp.net';
    const a = await say(ext, 'אני ממש לחוצה, מצאנו משהו שנראה כמו אסבסט בחדר ולא יודעת מה לעשות');
    expect(a).toContain('מובן לגמרי שזה מלחיץ');
    expect(a).toContain('אריה');
    const c = await conv(ext);
    expect(c).toMatchObject({ assigned_to: officer, bot_state: 'human', comfort_steps: 0 });
    expect(c.comfort_since).not.toBeNull();
    expect((await db.query(`SELECT count(*)::int AS n FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.conversation_id = $1 AND t.name = 'זקוק לליווי'`, [c.id])).rows[0].n).toBe(1);
    // not again within 15 minutes
    expect(await say(ext, 'אני ממש לחוצה')).not.toContain('מובן לגמרי');

    const at = (min: number) => new Date(new Date(c.comfort_since).getTime() + min * 60_000);
    out.length = 0;
    expect((await runComfort(db, mgr, at(3))).sent).toBe(0);                 // not yet
    expect((await runComfort(db, mgr, at(6))).sent).toBe(1);
    expect(out.at(-1)!.text).toContain('אני עדיין כאן איתך');
    expect((await runComfort(db, mgr, at(7))).sent).toBe(0);                 // the next one at 15 minutes
    // a person answers: the follow-ups stop
    await db.query(`INSERT INTO messages (conversation_id, direction, body, auto) VALUES ($1, 'out', 'שלום, אני מטפל בזה עכשיו', false)`, [c.id]);
    expect(await runComfort(db, mgr, at(16))).toEqual({ sent: 0, ended: 1 });
    expect((await conv(ext)).comfort_since).toBeNull();
  });

  it('a person answering right now: no automatic message, a note for them', async () => {
    const ext = '972500000778@s.whatsapp.net';
    await say(ext, 'שלום');
    const c = await conv(ext);
    await db.query(`UPDATE conversations SET assigned_to = $2, bot_state = 'human' WHERE id = $1`, [c.id, officer]);
    await db.query(`INSERT INTO messages (conversation_id, direction, body, auto) VALUES ($1, 'out', 'בודק', false)`, [c.id]);
    expect(await say(ext, 'כבר שעה אני מחכה, זה מתסכל')).not.toContain('מובן לגמרי');
    expect((await db.query(`SELECT count(*)::int AS n FROM conversation_notes WHERE conversation_id = $1 AND body LIKE '💛%'`, [c.id])).rows[0].n).toBe(1);
  });
});
