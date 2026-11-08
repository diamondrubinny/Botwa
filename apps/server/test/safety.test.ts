import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { DEFAULT_BOARD, matchCategories } from '../src/safety/categories.js';

const board = DEFAULT_BOARD.map((c, i) => ({ id: c.name, name: c.name, keywords: c.keywords, sort: i }));

describe('board categories', () => {
  it('put a text under the topics whose words it contains (with Hebrew prefixes), at most three', () => {
    expect(matchCategories('דרישות לסולם נייד בעבודה בגובה', board)).toEqual(expect.arrayContaining(['סולמות', 'עבודה בגובה']));
    expect(matchCategories('בסולמות ובפיגומים ובמעקות ובחפירות ובמעליות', board).length).toBe(3);
    expect(matchCategories('הגדרות כלליות של מפעל ומחזיק', board)).toEqual([]);
    expect(matchCategories('אחסון בלוני גז דחוס בחדר', board)).toContain('גזים דחוסים');
  });
});

async function workbook(sheets: { name: string; rows: (string | number)[][] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) { const ws = wb.addWorksheet(s.name); s.rows.forEach((r) => ws.addRow(r)); }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const REG_HEAD = ['קטגוריה', 'מקור', 'קובץ מקור', 'סימוכין', 'סעיף', 'כותרת סעיף', 'פרק', 'סימן', 'סוג הוראה', 'תקציר הוראה', 'נוסח מקוצר / תוכן מרכזי', 'הקשרים / הצלבות', 'סתירה / שוני היקף'];
const WEEK_HEAD = ['מזהה עמוד', 'תאריך', 'קטגוריה ראשית', 'תת-נושא', 'שאלה', 'תמצית התשובה', 'אזכור תחיקתי / מקור מרכזי', 'משיב/ה', 'כתובת מקור'];

describe('importing standards and the safety board', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true',
  });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  const cookies: Record<string, string> = {};
  let ip = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, who: string, payload?: object | Buffer, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload: payload as never, remoteAddress: `10.67.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]!, ...headers } });
  const upload = (buf: Buffer, name = 'standards.xlsx', who = 'admin@t.io') => {
    const b = '----xl';
    const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]);
    return call('POST', '/kb/import/xlsx', who, body, { 'content-type': `multipart/form-data; boundary=${b}` });
  };
  let catIds: Record<string, string> = {};

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r] of [['admin', 'admin'], ['officer', 'agent'], ['sup', 'supervisor']] as const) {
      await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [`${e}@t.io`, e, r, await hashPassword(PW)]);
      cookies[`${e}@t.io`] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.9.2.${++ip}`, headers: { origin: ORIGIN }, payload: { email: `${e}@t.io`, password: PW } })).cookies[0]!.value}`;
    }
    // a custom role for safety officers: only the SafetyBoard
    await db.query(`INSERT INTO roles (key, name, permissions) VALUES ('r_officer', 'ממונה בטיחות', ARRAY['safety.view'])`);
    await db.query(`UPDATE users SET role = 'r_officer' WHERE email = 'officer@t.io'`);
    cookies['officer@t.io'] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.9.2.${++ip}`, headers: { origin: ORIGIN }, payload: { email: 'officer@t.io', password: PW } })).cookies[0]!.value}`;
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('imports the two workbook layouts, categorises, and is idempotent', async () => {
    const reg = await workbook([
      { name: 'מדריך', rows: [['קובץ מיון']] },
      { name: 'כל_הסעיפים', rows: [REG_HEAD,
        ['פיגומים', 'פקודה', 'f.doc', 'פקודה ס׳ 120', '120', 'בדיקת פיגום', 'פרק', 'סימן', 'הוראה', 'פיגום ייבדק על ידי בודק מוסמך לפני כל שימוש.', 'פיגום לא יוצב אלא לאחר בדיקה.', 'חוק ס׳ 9', ''],
        ['עבודה בגובה', 'פקודה', 'f.doc', 'פקודה ס׳ 130', '130', 'סולם נייד', 'פרק', 'סימן', 'הוראה', 'סולם נייד יוצב בזווית בטוחה ויאובטח מפני החלקה.', 'במקום מוגבה יש לאבטח את העובד מפני נפילה.', '', 'שוני היקף מול התקנות'],
        ['הגדרות', 'חוק', 'g.doc', 'חוק ס׳ 1', '1', 'הגדרות', 'פרק', 'סימן', 'הגדרה', 'מפעל הוא מקום שבו מועסקים עובדים.', '', '', '']] },
      { name: 'קשרים_וסתירות', rows: [['קטגוריה', 'סוג ממצא', 'מקור א', 'מקור ב', 'הסבר הקשר', 'הערת סתירה / שוני'], ['הגדרות', 'קשר משלים', 'חוק ס׳ 9', 'פקודה ס׳ 1', 'החוק מפנה להגדרת מפעל בפקודה.', 'לא אותרה סתירה']] },
    ]);
    const weekly = await workbook([
      { name: 'מקרא', rows: [['מפתח']] },
      { name: 'כל התשובות', rows: [['כל התשובות שנאספו'], WEEK_HEAD,
        ['1700', '2026-03-01', 'עבודה בגובה', 'סולמות', 'באיזה גובה מותר לעבוד על סולם נייד?', 'עבודה על סולם נייד מותרת בהתאם לתקנות ובכפוף לאבטחה מפני נפילה.', 'תקנות הבטיחות בעבודה (עבודה בגובה)', 'דוד זיו', 'https://www.osh.org.il/heb/questionlobby/weekanswer,1700/'],
        ['1701', '2026-03-02', 'חשמל', 'לוחות', 'האם מותר לאחסן חפצים בארון חשמל?', 'אסור לאחסן חפצים בארון חשמל.', 'תקנות החשמל', 'דוד זיו', 'javascript:alert(1)']] },
    ]);
    expect((await upload(reg, 'standards.xlsx', 'officer@t.io')).statusCode).toBe(403);
    const r1 = (await upload(reg)).json();
    expect(r1).toMatchObject({ kind: 'regulations', created: 4, updated: 0, unchanged: 0 });
    const r2 = (await upload(weekly)).json();
    expect(r2).toMatchObject({ kind: 'weekly', created: 2 });
    expect((await upload(weekly)).json()).toMatchObject({ created: 0, updated: 0, unchanged: 2 }); // idempotent
    expect((await db.query(`SELECT count(*)::int AS n FROM kb_sources`)).rows[0].n).toBe(6);
    // the unsafe link was dropped, the real one kept
    const urls = (await db.query(`SELECT external_id, url FROM kb_sources WHERE origin = 'xlsx:weekly' ORDER BY external_id`)).rows;
    expect(urls).toEqual([{ external_id: 'weekly:1700', url: 'https://www.osh.org.il/heb/questionlobby/weekanswer,1700/' }, { external_id: 'weekly:1701', url: null }]);
    // an edited row is updated in place
    const edited = await workbook([{ name: 'כל התשובות', rows: [['x'], WEEK_HEAD, ['1700', '2026-03-01', 'עבודה בגובה', 'סולמות', 'באיזה גובה מותר לעבוד על סולם נייד?', 'תשובה מעודכנת: אסור מעל שני מטרים בלי אבטחה.', 'תקנות', 'דוד זיו', 'https://www.osh.org.il/heb/questionlobby/weekanswer,1700/']] }]);
    expect((await upload(edited)).json()).toMatchObject({ kind: 'weekly', created: 0, updated: 1 });
    // junk
    expect((await upload(await workbook([{ name: 'a', rows: [['x']] }]))).json()).toEqual({ error: 'unknown_workbook' });
    expect((await upload(Buffer.from('not a zip'))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await call('POST', '/kb/import/xlsx', 'admin@t.io', Buffer.from('x'), { 'content-type': 'application/json' })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('safety.view sees the board; categories carry counts and editable keywords', async () => {
    expect((await call('GET', '/safety/categories', 'sup@t.io')).statusCode).toBe(200);
    const g = (await call('GET', '/safety/categories', 'officer@t.io')).json();
    expect(g.categories).toHaveLength(21);                 // the 22 listed topics, "כלי לחץ" appears once
    catIds = Object.fromEntries(g.categories.map((c: { name: string; id: string }) => [c.name, c.id]));
    const n = (name: string) => g.categories.find((c: { name: string }) => c.name === name).count;
    expect(n('פיגומים')).toBeGreaterThanOrEqual(1);
    expect(n('סולמות')).toBeGreaterThanOrEqual(2);
    expect(g.total).toBe(6);
    expect(g.uncategorized).toBeGreaterThanOrEqual(2);
    expect((await call('PUT', `/safety/categories/${catIds['תאורה']}`, 'officer@t.io', { keywords: ['x1'] })).statusCode).toBe(403); // officers read, managers edit
    expect((await call('PUT', `/safety/categories/${catIds['תאורה']}`, 'admin@t.io', { keywords: ['חשמל', 'ארון חשמל'] })).statusCode).toBe(200);
    const re = (await call('POST', '/safety/categories/reapply', 'admin@t.io')).json();
    expect(re.sources).toBeGreaterThanOrEqual(6);
    expect((await call('GET', '/safety/categories', 'officer@t.io')).json().categories.find((c: { name: string }) => c.name === 'תאורה').count).toBeGreaterThanOrEqual(1);
  });

  it('answers a free-text question with cited, grouped results from the standards, inside a topic or across all', async () => {
    const all = (await call('POST', '/safety/ask', 'officer@t.io', { q: 'באיזה גובה מותר לעבוד על סולם' })).json();
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.instruments).toEqual(expect.arrayContaining(['תשובת השבוע']));
    const weeklyGroup = all.groups.find((g: { instrument: string }) => g.instrument === 'תשובת השבוע');
    expect(weeklyGroup.items[0]).toMatchObject({ url: 'https://www.osh.org.il/heb/questionlobby/weekanswer,1700/', reference: 'תקנות' });
    expect(weeklyGroup.items[0].excerpt).toContain('אסור מעל שני מטרים'); // the updated text
    const inTopic = (await call('POST', '/safety/ask', 'officer@t.io', { q: 'בדיקה לפני שימוש', categoryId: catIds['פיגומים'] })).json();
    expect(inTopic.groups.flatMap((g: { items: { title: string }[] }) => g.items.map((i) => i.title)).join()).toContain('בדיקת פיגום');
    expect(JSON.stringify(inTopic)).not.toContain('סולם נייד יוצב'); // other topics are not mixed in
    const none = (await call('POST', '/safety/ask', 'officer@t.io', { q: 'מזג האוויר בחיפה מחר' })).json();
    expect(none.total).toBe(0);
    expect((await call('POST', '/safety/ask', 'officer@t.io', { q: 'x' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/safety/ask', headers: { origin: ORIGIN }, payload: { q: 'סולם' } })).statusCode).toBe(401);
  });

  it('inside a conversation the officer gets standards for the topic the bot tagged', async () => {
    const ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp','WA') RETURNING id`)).rows[0].id;
    const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id, display_name) VALUES ($1,'c1','דנה') RETURNING id`, [ch])).rows[0].id;
    const conv = (await db.query(`INSERT INTO conversations (channel_id, contact_id) VALUES ($1,$2) RETURNING id`, [ch, ct])).rows[0].id;
    await db.query(`INSERT INTO messages (conversation_id, direction, body) VALUES ($1,'in','אפשר לעבוד על סולם נייד בגובה ארבעה מטר?')`, [conv]);
    const sugg = async () => (await call('GET', `/conversations/${conv}/safety-suggestions`, 'officer@t.io')).json();
    expect(await sugg()).toEqual({ topics: [], hits: [] });                 // no topic tag yet: nothing is guessed
    const tag = (await db.query(`INSERT INTO tags (name) VALUES ('סולמות') RETURNING id`)).rows[0].id;
    await db.query('INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1,$2)', [conv, tag]);
    const r = await sugg();
    expect(r.topics).toEqual(['סולמות']);
    expect(r.hits.length).toBeGreaterThanOrEqual(1);
    expect(r.hits.every((h: { topic: string }) => h.topic === 'סולמות')).toBe(true);
    expect(r.hits.some((h: { reference: string | null }) => h.reference)).toBe(true);
    expect((await call('GET', `/conversations/${conv}/safety-suggestions`, 'admin@t.io')).statusCode).toBe(200);
    expect((await app.inject({ url: `/conversations/${conv}/safety-suggestions` })).statusCode).toBe(401);
    // agents without the permission are refused
    await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ('plain@t.io','plain','agent',$1)`, [await hashPassword(PW)]);
    const c = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: '10.9.3.1', headers: { origin: ORIGIN }, payload: { email: 'plain@t.io', password: PW } })).cookies[0]!.value}`;
    expect((await app.inject({ url: `/conversations/${conv}/safety-suggestions`, headers: { cookie: c } })).statusCode).toBe(403);
  });

  it('the integration view lists everything of a topic by source, with cross references and notes', async () => {
    const v = (await call('GET', `/safety/category/${catIds['סולמות']}/items`, 'officer@t.io')).json();
    expect(v.category.name).toBe('סולמות');
    expect(v.groups.map((g: { instrument: string }) => g.instrument)).toEqual(expect.arrayContaining(['פקודה', 'תשובת השבוע']));
    const reg = v.groups.find((g: { instrument: string }) => g.instrument === 'פקודה').items[0];
    expect(reg).toMatchObject({ reference: 'פקודה ס׳ 130', difference: 'שוני היקף מול התקנות' });
    const full = (await call('GET', `/safety/source/${reg.id}`, 'officer@t.io')).json();
    expect(full.body).toContain('סולם נייד');
    expect((await call('GET', '/safety/category/00000000-0000-4000-8000-000000000000/items', 'officer@t.io')).statusCode).toBe(404);
  });
});
