import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runComfort } from '../src/automations.js';
import { smallTalkReply, withoutBotName } from '../src/bot-text.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { comfortText, detectDistress, detectHazard, followUpText, hazardAdvice } from '../src/empathy.js';
import { migrate } from '../src/migrate.js';
import { isWaitingQuestion } from '../src/waiting.js';
import { safetyReport, safetyReportText } from '../src/safety/report.js';

describe('recognising stress', () => {
  it('worried, upset, or neither; the technical "לחץ" is not a feeling', () => {
    for (const t of ['אני ממש לחוצה', 'אני מפחד שמשהו לא בסדר', 'לא יודעת מה לעשות', 'נבהלתי מהרעש במעבדה', 'זה מלחיץ אותי']) expect(detectDistress(t), t).toBe('worried');
    for (const t of ['כבר שעה אני מחכה!!', 'אף אחד לא עונה לי', 'זה ממש מתסכל', 'נמאס לי, זה לא מקובל']) expect(detectDistress(t), t).toBe('upset');
    for (const t of ['איך מאחסנים בלון גז בלחץ?', 'מה לחץ העבודה של הדוד', 'מי דואג לציוד המגן?', 'מתח גבוה בלוח החשמל', 'מספר חדר 305', 'תודה רבה']) expect(detectDistress(t), t).toBeNull();
    expect(detectDistress('גז בלחץ דולף ואני ממש לחוץ')).toBe('hazard');          // a leak reported: the hazard answer
    expect(detectDistress('בלון גז בלחץ ואני ממש לחוץ')).toBe('worried');
  });
  it('a hazard report, not a question about hazards', () => {
    for (const t of ['סכנה לייזר', 'ססכנה לייזר ', 'יש מפגע חשמלי בחדר 305', 'המדף במעבדה לא בטוח', 'חוט חשוף ליד הכיור', 'יש נזילה של חומר מתחת לשולחן']) expect(detectHazard(t), t).toBe(true);
    for (const t of ['מה נחשב עבודה מסוכנת?', 'מי הממונה על מפגעים?', 'איך מאחסנים חומרים מסוכנים', 'אני צריך סקר סיכונים', 'מספר חדר 305']) expect(detectHazard(t), t).toBe(false);
    expect(detectDistress('סכנה לייזר')).toBe('hazard');
    expect(hazardAdvice('סכנה לייזר')).toContain('לא להסתכל לכיוון הקרן');
    expect(hazardAdvice('יש אסבסט בחדר')).toContain('לא לטאטא');
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

  it('"סכנה לייזר": first advice for lasers, urgent to the laser officer; writing again is never met with silence', async () => {
    const o = (await db.query(`INSERT INTO officers (name, user_id) VALUES ('אריה כהן', $1) RETURNING id`, [officer])).rows[0].id;
    await db.query(`INSERT INTO officer_topics (officer_id, topic) VALUES ($1, 'לייזרים')`, [o]);
    const ext = '972500000779@s.whatsapp.net';
    const a = await say(ext, 'סכנה לייזר');
    expect(a).toContain('⚠️ תודה שדיווחת');
    expect(a).toContain('לא להסתכל לכיוון הקרן');
    expect(a).toContain('בניין וחדר');
    const c = await conv(ext);
    expect(c).toMatchObject({ assigned_to: officer, bot_state: 'human' });
    expect(await say(ext, 'סכנה לייזר')).toBe('');                                   // the answer just went out: not again at once
    await db.query(`UPDATE messages SET created_at = created_at - interval '6 minutes' WHERE conversation_id = $1 AND direction = 'out'`, [c.id]);
    expect(await say(ext, 'סכנה לייזר')).toContain('קיבלתי 🙏 הפנייה כבר אצל אריה');
  });

  it('the same calm message three times with nobody answering: treated as feeling unheard', async () => {
    const ext = '972500000780@s.whatsapp.net';
    await say(ext, 'שלום');
    const c = await conv(ext);
    await db.query(`UPDATE conversations SET assigned_to = $2, bot_state = 'human' WHERE id = $1`, [c.id, officer]);
    await say(ext, 'רציתי לברר על הדרכה');
    await say(ext, 'רציתי לברר על הדרכה');
    expect(await say(ext, 'רציתי לברר על הדרכה')).toContain('סליחה על ההמתנה');
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

  it('the safety report: what was flagged and how fast a person answered; no names or message text', async () => {
    const r = await safetyReport(db, 7);
    const by = Object.fromEntries(r.rows.map((x) => [x.kind, x]));
    expect(by.worried!.events).toBeGreaterThanOrEqual(1);
    expect(by.worried!.answered).toBeGreaterThanOrEqual(1);          // the officer wrote after the first comforting message
    expect(by.worried!.medianMinutes).not.toBeNull();
    expect(by.hazard!.events).toBeGreaterThanOrEqual(1);
    expect(r.topics.map((t) => t.name)).not.toContain('זקוק לליווי');   // the automatic tags are not topics
    const text = safetyReportText(r);
    expect(text).toContain('🛡️ בטיחות ודחיפות, 7 ימים אחרונים:');
    expect(text).toContain('⚠️ דיווחי מפגע');
    expect(text).not.toContain('972500000');
  });

  it('escalation: an urgent conversation with no answer from a person goes to an available manager after the set minutes, once', async () => {
    const boss = (await db.query(`INSERT INTO users (email, name, name_he, role, password_hash) VALUES ('boss-esc@t.io', 'boss', 'מנהלת', 'admin', 'x') RETURNING id`)).rows[0].id;
    const ext = '972500009999@s.whatsapp.net';
    await say(ext, 'סכנה לייזר בחדר 12');
    const c = await conv(ext);
    expect(c.urgent_since).not.toBeNull();
    expect(c.assigned_to).toBe(officer);
    await db.query(`UPDATE conversations SET urgent_since = NULL WHERE id <> $1`, [c.id]);   // only this one (earlier tests left theirs)
    const at = (min: number) => new Date(new Date(c.urgent_since).getTime() + min * 60_000);
    expect(await mgr.runEscalations(at(10))).toBe(0);                                  // not yet (15 minutes by default)
    expect(await mgr.runEscalations(at(16))).toBe(1);
    const after = await conv(ext);
    expect(after.assigned_to).toBe(boss);                                              // the officer did not answer: to a manager
    expect(after.escalated_at).not.toBeNull();
    expect((await db.query(`SELECT body FROM conversation_notes WHERE conversation_id = $1 AND body LIKE '⏫%'`, [c.id])).rows[0].body).toContain('הועברה אל מנהלת');
    expect(await mgr.runEscalations(at(30))).toBe(0);                                  // once per mark
    // a person answers: the mark is done
    await db.query(`INSERT INTO messages (conversation_id, direction, body, auto) VALUES ($1, 'out', 'בדרך אליך', false)`, [c.id]);
    await mgr.runEscalations(at(31));
    expect((await conv(ext)).urgent_since).toBeNull();
  });
});
