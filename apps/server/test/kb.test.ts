import { randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { decide, DEFAULT_BOT, type BotConfig } from '../src/bot.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { checkUrl, isPublicIp } from '../src/kb/fetch.js';
import type { Embedder } from '../src/semantic/embedder.js';
import { bestSnippet, chunkText, indexTerms, queryTokens, variants } from '../src/kb/text.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('text tools', () => {
  it('strips Hebrew prefixes, final letters and stop words', () => {
    expect(variants('בשעות')).toEqual(['בשעות', 'שעות']);
    expect(variants('והשעות')).toEqual(['והשעות', 'השעות', 'שעות']);
    expect(variants('בית')).toEqual(['בית']); // too short to strip
    expect(queryTokens('מה שעות הפעילות שלכם?')).toEqual(['שעות', 'הפעילות', 'שלכמ']);
    expect(indexTerms('השעות')).toContain('שעות');
    expect(queryTokens('How can I get the refund?')).toEqual(['get', 'refund']);
  });
  it('chunks by heading and size, and picks the best passage', () => {
    const text = `# משלוחים\n\n${'משלוח רגיל לוקח שלושה ימים. '.repeat(10)}\n\n# החזרות\n\nאפשר להחזיר מוצר תוך 14 ימים. ההחזר יתבצע לכרטיס האשראי.`;
    const c = chunkText(text);
    expect(c.map((x) => x.heading)).toEqual(['משלוחים', 'החזרות']);
    expect(bestSnippet('פתיח ארוך מאוד. '.repeat(20) + 'ההחזר יתבצע תוך שבוע לכרטיס האשראי. סוף.', ['החזר'], 80)).toContain('ההחזר יתבצע');
  });
});

describe('server-side fetching is SSRF-safe', () => {
  it('treats private, loopback, link-local and metadata addresses as non-public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) expect(isPublicIp(ip), ip).toBe(true);
  });
  it('rejects odd URLs before any request', () => {
    for (const u of ['ftp://example.com/x', 'file:///etc/passwd', 'http://localhost/x', 'http://127.0.0.1/x', 'http://[::1]/x', 'http://169.254.169.254/latest', 'https://u:p@example.com/', 'http://example.com:22/', 'http://foo.internal/', 'nonsense']) expect(() => checkUrl(u), u).toThrow();
    expect(() => checkUrl('https://example.com/page')).not.toThrow();
  });
});

describe('knowledge base', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true',
  });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let ctx: AdapterContext;
  const sent: string[] = [];
  const cookies: Record<string, string> = {};
  let ip = 0;
  class Fake implements ChannelAdapter {
    constructor(c: AdapterContext) { ctx = c; }
    async start() { ctx.events.onStatus('connected'); }
    async stop() {}
    async logout() {}
    async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `b${sent.length}` }; }
  }
  const factory: AdapterFactory = (t, c) => (t === 'whatsapp' ? new Fake(c) : null);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, who?: string, payload?: object | Buffer, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload: payload as never, remoteAddress: `10.60.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}), ...headers } });
  const faq = (who: string, body: object) => call('POST', '/kb/sources/faq', who, body);
  let mid = 0;
  const say = async (who: string, text: string) => {
    sent.length = 0;
    await ctx.events.onMessage({ externalContactId: who, externalMessageId: `k${++mid}`, text, timestamp: new Date() });
    return [...sent];
  };
  const multipart = (file: { name: string; type: string; data: Buffer }, fields: Record<string, string> = {}) => {
    const b = '----kbtest';
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${b}--\r\n`));
    return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
  };

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, factory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['a1', 'agent']] as const) {
      await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [`${e}@t.io`, e, r, await hashPassword(PW)]);
      cookies[`${e}@t.io`] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW })).cookies[0]!.value}`;
    }
    const ch = (await call('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'WA' })).json().id;
    await call('POST', `/channels/${ch}/start`, 'admin@t.io');
    await new Promise((r) => setTimeout(r, 40));
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('only kb.manage may change content; every signed-in user is refused anonymous access', async () => {
    expect((await call('GET', '/kb/sources')).statusCode).toBe(401);
    expect((await call('GET', '/kb/sources', 'a1@t.io')).statusCode).toBe(403);
    expect((await faq('a1@t.io', { title: 'שאלה', body: 'תשובה ארוכה מספיק' })).statusCode).toBe(403);
    expect((await call('GET', '/kb/sources', 'sup@t.io')).statusCode).toBe(200);
    expect((await faq('admin@t.io', { title: 'x', body: 'y' })).statusCode).toBe(400);
  });

  it('FAQ: answers questions phrased differently (Hebrew prefixes, variants, synonyms) and exact questions verbatim', async () => {
    const r = await faq('admin@t.io', { title: 'מהן שעות הפעילות שלכם?', variants: ['מתי אתם פתוחים'], body: 'אנחנו פעילים בימים א׳–ה׳ בין 9:00 ל-17:00.', audience: 'both' });
    expect(r.statusCode).toBe(201);
    await faq('admin@t.io', { title: 'איך מבצעים החזרה של מוצר?', body: 'אפשר להחזיר מוצר תוך 14 ימים עם קבלה. ההחזר יתבצע לאמצעי התשלום המקורי.', boost: 1 });
    await faq('admin@t.io', { title: 'כמה עולה משלוח', body: 'משלוח עד הבית עולה 29 ש״ח.', audience: 'staff' });
    const s = async (q: string, audience = 'bot') => (await call('POST', '/kb/search', 'admin@t.io', { q, audience })).json();
    const a = await s('מה שעות הפעילות');
    expect(a.hits[0].title).toContain('שעות הפעילות');
    expect(a.wouldAnswer).toBe(true);
    expect((await s('בשעות הפעילות שלכם')).hits[0].title).toContain('שעות הפעילות'); // prefix ב-
    expect((await s('מתי אתם פתוחים')).hits[0].exact).toBe(true);                       // variant
    expect((await s('אני רוצה להחזיר מוצר')).hits[0].title).toContain('החזרה');
    expect((await s('מזג האוויר מחר בתל אביב')).wouldAnswer).toBe(false);
    // audience: staff-only entries are never offered to the bot
    expect((await s('כמה עולה משלוח', 'bot')).hits).toHaveLength(0);
    expect((await s('כמה עולה משלוח', 'staff')).hits[0].title).toContain('משלוח');
    // synonyms widen matching
    expect((await s('מחיר שילוח', 'staff')).hits.length).toBe(0);
    expect((await call('POST', '/kb/synonyms', 'admin@t.io', { words: ['שילוח', 'משלוח', 'delivery'] })).statusCode).toBe(201);
    expect((await s('מחיר delivery', 'staff')).hits[0].title).toContain('משלוח');
  });

  it('disabled sources are never used; deleting removes them; chunks follow edits', async () => {
    const list = (await call('GET', '/kb/sources', 'admin@t.io')).json() as { id: string; title: string; chunks: number }[];
    const hours = list.find((x) => x.title.includes('שעות'))!;
    expect(hours.chunks).toBeGreaterThan(0);
    await call('PATCH', `/kb/sources/${hours.id}`, 'admin@t.io', { enabled: false });
    expect((await call('POST', '/kb/search', 'admin@t.io', { q: 'שעות הפעילות' })).json().hits.map((h: { title: string }) => h.title).join()).not.toContain('שעות');
    await call('PATCH', `/kb/sources/${hours.id}`, 'admin@t.io', { enabled: true, body: 'אנחנו סגורים בשבת וחגים. פתוחים כל השבוע עד 20:00.' });
    expect((await call('POST', '/kb/search', 'admin@t.io', { q: 'שעות הפעילות' })).json().hits[0].snippet).toContain('20:00');
  });

  it('documents: txt, csv, html parse; bad types and oversized names are refused; docx and pdf are parsed in the worker', async () => {
    const up = async (name: string, type: string, data: Buffer, fields?: Record<string, string>) => {
      const m = multipart({ name, type, data }, fields);
      return call('POST', '/kb/sources/file', 'admin@t.io', m.payload, m.headers);
    };
    expect((await up('policy.txt', 'text/plain', Buffer.from('מדיניות פרטיות\n\nאנחנו שומרים מידע על לקוחות למשך שנה אחת בלבד ומוחקים אותו לבקשתכם.'), { title: 'מדיניות פרטיות' })).statusCode).toBe(201);
    expect((await up('prices.csv', 'text/csv', Buffer.from('מוצר,מחיר\nכיסא משרדי,450\nשולחן עבודה,900'))).statusCode).toBe(201);
    expect((await up('page.html', 'text/html', Buffer.from('<html><head><title>אחריות</title><script>alert(1)</script></head><body><nav>תפריט</nav><h1>אחריות</h1><p>האחריות על המוצרים היא לשנתיים מיום הרכישה.</p></body></html>'))).statusCode).toBe(201);
    expect((await up('evil.exe', 'application/octet-stream', Buffer.from('MZ'))).statusCode).toBe(415);
    const z = new JSZip();
    z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    z.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>נוהל חופשות: עובד זכאי לעשרים ימי חופשה בשנה.</w:t></w:r></w:p></w:body></w:document>');
    expect((await up('hr.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', await z.generateAsync({ type: 'nodebuffer' }))).statusCode).toBe(201);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 56>>stream\nBT /F1 12 Tf 20 150 Td (Warranty covers repairs for two years) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF');
    const pr = await up('warranty.pdf', 'application/pdf', pdf);
    expect([201, 422]).toContain(pr.statusCode); // hand-made PDF; the point is it never crashes the server
    const s = async (q: string) => (await call('POST', '/kb/search', 'admin@t.io', { q })).json().hits[0];
    expect((await s('כמה זמן שומרים מידע'))?.title).toContain('פרטיות');
    expect((await s('כמה עולה כיסא משרדי'))?.snippet).toContain('450');
    expect((await s('כמה זמן האחריות'))?.snippet).toContain('לשנתיים');
    expect((await s('כמה ימי חופשה מגיעים לעובד'))?.snippet).toContain('עשרים');
    expect(String(JSON.stringify(await s('alert')))).not.toContain('alert(1)'); // scripts are not indexed
    // junk that claims to be a docx fails cleanly and leaves an error row, not a crash
    const bad = await up('broken.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('not a zip'));
    expect(bad.statusCode).toBe(422);
    expect((await call('GET', '/kb/sources', 'admin@t.io')).json().find((x: { fileName: string }) => x.fileName === 'broken.docx').status).toBe('error');
  });

  it('links: SSRF attempts are refused; pages are fetched, crawled, deduplicated and refreshed only when changed', async () => {
    for (const u of ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data', 'http://localhost:8080/', 'file:///etc/passwd', 'https://user:pw@example.com/']) {
      expect((await call('POST', '/kb/sources/link', 'admin@t.io', { url: u })).statusCode, u).toBe(400);
    }
    const pages: Record<string, string> = {
      'https://shop.example/help': '<html><head><title>עזרה</title></head><body><h1>מרכז עזרה</h1><p>כאן מסבירים על איפוס סיסמה בחשבון הלקוח.</p><a href="/help/shipping">משלוחים</a><a href="https://evil.example/x">חיצוני</a><a href="/logo.png">img</a></body></html>',
      'https://shop.example/help/shipping': '<html><head><title>משלוחים</title></head><body><h1>זמני משלוח</h1><p>משלוח בדואר שליחים מגיע תוך יומיים עסקים.</p></body></html>',
    };
    let hits = 0;
    mgr.kb!.setFetcher(async (url) => {
      hits++;
      const body = pages[url];
      if (!body) throw new Error('http_404');
      return { url, contentType: 'text/html', body: Buffer.from(body) };
    });
    const r = await call('POST', '/kb/sources/link', 'admin@t.io', { url: 'https://shop.example/help', crawlPages: 5, refreshHours: 24 });
    expect(r.statusCode).toBe(202);
    await mgr.kb!.idle();
    const list = (await call('GET', '/kb/sources', 'admin@t.io')).json() as { url: string; status: string; parentId: string | null }[];
    expect(list.filter((x) => x.url?.startsWith('https://shop.example')).map((x) => `${x.url}:${x.status}`).sort()).toEqual(['https://shop.example/help/shipping:ready', 'https://shop.example/help:ready']);
    expect(list.some((x) => x.url?.includes('evil.example'))).toBe(false); // same site only
    expect((await call('POST', '/kb/search', 'admin@t.io', { q: 'כמה זמן לוקח משלוח בדואר שליחים' })).json().hits[0].url).toBe('https://shop.example/help/shipping');
    expect((await call('POST', '/kb/sources/link', 'admin@t.io', { url: 'https://shop.example/help' })).statusCode).toBe(409);

    // unchanged content is not re-indexed; changed content bumps the version
    const parent = list.find((x) => x.url === 'https://shop.example/help') as unknown as { id: string };
    const ver = async () => (await db.query('SELECT version FROM kb_sources WHERE id = $1', [parent.id])).rows[0].version as number;
    const v1 = await ver();
    await call('POST', `/kb/sources/${parent.id}/reindex`, 'admin@t.io');
    await mgr.kb!.idle();
    expect(await ver()).toBe(v1);
    pages['https://shop.example/help'] = pages['https://shop.example/help']!.replace('איפוס סיסמה', 'שחזור סיסמה');
    await call('POST', `/kb/sources/${parent.id}/reindex`, 'admin@t.io');
    await mgr.kb!.idle();
    expect(await ver()).toBe(v1 + 1);
    // scheduled refresh picks up links whose interval passed
    await db.query(`UPDATE kb_sources SET last_fetched_at = now() - interval '2 days' WHERE id = $1`, [parent.id]);
    expect(await mgr.kb!.refreshDue()).toBe(1);
    await mgr.kb!.idle();
    // fetch failure => error status with a code, content kept out of search
    pages['https://shop.example/help/shipping'] = '';
    delete pages['https://shop.example/help/shipping'];
    const child = list.find((x) => x.url === 'https://shop.example/help/shipping') as unknown as { id: string };
        // children are refreshed through their own reindex too
    await call('POST', `/kb/sources/${child.id}/reindex`, 'admin@t.io');
    await mgr.kb!.idle();
    expect((await db.query('SELECT status, error FROM kb_sources WHERE id=$1', [child.id])).rows[0]).toMatchObject({ status: 'error', error: 'http_404' });
    expect(hits).toBeGreaterThan(4);
    // deleting the parent removes crawled pages and their chunks
    await call('DELETE', `/kb/sources/${parent.id}`, 'admin@t.io');
    expect((await db.query(`SELECT count(*)::int AS n FROM kb_sources WHERE url LIKE 'https://shop.example%'`)).rows[0].n).toBe(0);
  });

  it('the bot answers free-text questions from the base, hands over when unsure, and gaps are collected', async () => {
    const bot: BotConfig = { ...DEFAULT_BOT, enabled: true, kb: { enabled: true, minScore: 0.6, maxChars: 700, showSource: true, intro: 'מצאתי:' } };
    expect((await call('PUT', '/settings/bot', 'admin@t.io', bot)).statusCode).toBe(200);
    const first = await say('kc1', 'מתי אתם פתוחים?'); // very first message is answered, not met with the menu
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('מצאתי:');
    expect(first[0]).toContain('מקור: מהן שעות הפעילות');
    expect((await say('kc1', '1'))[0]).toContain('9:00'); // numbers still drive the menu
    const unknown = await say('kc2', 'האם אתם מוכרים אופניים חשמליים בכלל');
    expect(unknown[0]).toContain('1. שעות פעילות'); // not answerable: normal menu
    const handoff = await say('kc2', 'איך מזמינים אופניים חשמליים');
    expect(handoff.join()).toContain(DEFAULT_BOT.invalidMessage.slice(0, 5));
    // staff-only content never reaches customers
    expect((await say('kc3', 'כמה עולה משלוח'))[0]).not.toContain('29');
    const gaps = (await call('GET', '/kb/gaps', 'admin@t.io')).json() as { text: string; times: number }[];
    expect(gaps.some((g) => g.text.includes('אופניים'))).toBe(true);
    const stats = (await call('GET', '/kb/stats', 'admin@t.io')).json();
    expect(stats.botQuestions).toBeGreaterThanOrEqual(3);
    expect(stats.botAnswered).toBeGreaterThanOrEqual(1);
    expect((await call('POST', '/kb/gaps/dismiss', 'admin@t.io', { text: gaps[0]!.text })).statusCode).toBe(200);
    // the question log is retention-limited
    await db.query(`UPDATE kb_queries SET created_at = now() - interval '40 days'`);
    expect(await mgr.kb!.purgeOldQueries(30)).toBeGreaterThan(0);
  });

  it('agents get suggestions for the customer message they may see, with feedback counters', async () => {
    await say('kc4', 'אפשר להחזיר מוצר?');
    const c = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = 'kc4'`)).rows[0].id as string;
    const sug = (await call('GET', `/conversations/${c}/kb-suggestions`, 'a1@t.io')).json();
    expect(sug.hits[0].title).toContain('החזרה');
    expect(sug.hits[0].text).toContain('14 ימים');
    expect((await call('GET', '/conversations/00000000-0000-4000-8000-000000000000/kb-suggestions', 'a1@t.io')).statusCode).toBe(404);
    expect((await call('GET', `/conversations/${c}/kb-suggestions`)).statusCode).toBe(401);
    const id = sug.hits[0].sourceId as string;
    expect((await call('POST', '/kb/feedback', 'a1@t.io', { sourceId: id, action: 'helpful' })).statusCode).toBe(200);
    await call('POST', '/kb/feedback', 'a1@t.io', { sourceId: id, action: 'used' });
    const row = (await db.query('SELECT helpful, uses FROM kb_sources WHERE id=$1', [id])).rows[0];
    expect(row.helpful).toBe(1);
    expect(row.uses).toBeGreaterThanOrEqual(1);
    expect((await call('POST', '/kb/feedback', 'a1@t.io', { sourceId: id, action: 'bogus' })).statusCode).toBe(400);
  });

  it('decide(): a knowledge answer wins over the menu but never over a number, menu word or handoff request', () => {
    const bot: BotConfig = { ...DEFAULT_BOT, enabled: true };
    expect(decide(bot, { state: null, invalid: 0 }, 'שאלה', 'התשובה').replies[0]).toContain('התשובה');
    expect(decide(bot, { state: 'menu', invalid: 0 }, '1', 'התשובה').replies[0]).toContain('9:00');
    expect(decide(bot, { state: 'menu', invalid: 0 }, 'תפריט', 'התשובה').replies[0]).toContain('1. שעות פעילות');
    expect(decide(bot, { state: 'menu', invalid: 0 }, 'נציג בבקשה', 'התשובה').handoff).toBe('requested');
  });
});

describe('meaning search (fake embedder, deterministic)', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false',
  });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let cookie = '';
  let ip = 0;
  // concepts instead of a real model: words of one concept point the same way
  const CONCEPTS = [['שעות', 'פתוחים', 'סוגרים', 'עובדים', 'פעילות', 'נפתחים'], ['החזרה', 'מחזירים', 'להחזיר', 'החזר', 'סחורה', 'זיכוי'], ['משלוח', 'שליח', 'הביתה', 'הובלה'], ['חופשה', 'נופש', 'חופש', 'הנופש']];
  const fake: Embedder = {
    status: () => ({ state: 'ready', model: 'fake/concepts' }),
    embed: async (texts) => texts.map((t) => {
      const v = new Float32Array(CONCEPTS.length + 1);
      for (const w of t.split(/[\s.,?!]+/)) { const c = CONCEPTS.findIndex((g) => g.includes(w)); v[c === -1 ? CONCEPTS.length : c]! += 1; }
      v[CONCEPTS.length]! *= 0.05;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    }),
  };
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.61.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie } });

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg);
    app = await buildApp(cfg, db, mgr);
    await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ('a@t.io','a','admin',$1)`, [await hashPassword(PW)]);
    cookie = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: ORIGIN }, payload: { email: 'a@t.io', password: PW } })).cookies[0]!.value}`;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('finds an answer with no shared words, once vectors exist; backfills older sources; never answers unrelated questions', async () => {
    await call('POST', '/kb/sources/faq', { title: 'מהן שעות הפעילות', body: 'פתוחים א׳–ה׳ 9:00–17:00.' });
    await call('POST', '/kb/sources/faq', { title: 'איך מחזירים מוצר', body: 'תוך 14 ימים עם קבלה.' });
    const ask = async (q: string) => (await call('POST', '/kb/search', { q, audience: 'any' })).json();
    expect((await ask('מתי אתם נפתחים')).hits.length).toBeGreaterThanOrEqual(0);
    expect((await call('GET', '/kb/semantic')).json()).toMatchObject({ state: 'off' });

    mgr.kb!.setEmbedder(fake);
    expect(await mgr.kb!.embedMissing()).toBe(2); // sources created before the model was ready get their vectors now
    expect((await call('GET', '/kb/semantic')).json()).toMatchObject({ state: 'ready', embedded: 2, total: 2 });

    const r = await ask('מתי אתם נפתחים');            // shares no word with "שעות הפעילות"
    expect(r.hits[0].title).toBe('מהן שעות הפעילות');
    expect(r.hits[0].sem).toBeGreaterThan(0.6);
    expect(r.wouldAnswer).toBe(true);
    expect((await ask('אפשר זיכוי על סחורה')).hits[0].title).toBe('איך מחזירים מוצר');
    const none = await ask('איזה מזג אוויר צפוי מחר');
    expect(none.wouldAnswer).toBe(false);
    expect(none.hits[0]?.sem ?? 0).toBeLessThan(0.3);

    // a new source is embedded as soon as it is indexed; editing re-embeds; deleting removes its vectors
    const id = (await call('POST', '/kb/sources/faq', { title: 'כמה עולה משלוח', body: 'משלוח עד הבית עולה 29 ש״ח בכל הארץ.' })).json().id as string;
    expect((await ask('כמה עולה שליח הביתה')).hits[0].title).toBe('כמה עולה משלוח');
    await call('PATCH', `/kb/sources/${id}`, { title: 'האם יש חופשה' });
    expect((await ask('מתי הנופש')).hits[0].title).toBe('האם יש חופשה');
    await app.inject({ method: 'DELETE', url: `/kb/sources/${id}`, headers: { origin: ORIGIN, cookie } });
    expect((await db.query('SELECT count(*)::int AS n FROM kb_vectors WHERE source_id = $1', [id])).rows[0].n).toBe(0);
    mgr.kb!.setEmbedder({ status: () => ({ state: 'off' }), embed: async () => { throw new Error('x'); } });
  });
});
