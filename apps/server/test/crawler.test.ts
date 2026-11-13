import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { canonicalOf, inScope, isSoft404, normalizeUrl, parseRobots, parseSitemap, patternMatches, prefixOf, robotsAllows } from '../src/kb/crawler.js';
import { chunkText } from '../src/kb/text.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('crawler helpers (pure)', () => {
  it('normalises addresses: no fragment, tracking or default port, sorted query, no trailing slash', () => {
    expect(normalizeUrl('HTTPS://Shop.Example:443/a/b/?utm_source=x&b=2&a=1#frag')).toBe('https://shop.example/a/b?a=1&b=2');
    expect(normalizeUrl('/x//y/', 'https://s.example/base')).toBe('https://s.example/x/y');
    expect(normalizeUrl('https://s.example/')).toBe('https://s.example/');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('https://u:p@s.example/')).toBeNull();
    expect(normalizeUrl('mailto:a@b.c')).toBeNull();
  });
  it('robots.txt: our group beats *, longest rule wins, Allow wins a tie, wildcards and $ work', () => {
    const r = parseRobots('User-agent: *\nDisallow: /private\nDisallow: /*.pdf$\nAllow: /private/open\nCrawl-delay: 2\nSitemap: https://s.example/sm.xml\n\nUser-agent: otherbot\nDisallow: /');
    expect(r.sitemaps).toEqual(['https://s.example/sm.xml']);
    expect(r.crawlDelay).toBe(2);
    expect(robotsAllows(r, '/private/x')).toBe(false);
    expect(robotsAllows(r, '/private/open/page')).toBe(true);
    expect(robotsAllows(r, '/doc.pdf')).toBe(false);
    expect(robotsAllows(r, '/doc.pdf?x=1')).toBe(true);
    expect(robotsAllows(r, '/public')).toBe(true);
    const mine = parseRobots('User-agent: botwakb\nDisallow: /secret\n\nUser-agent: *\nDisallow: /');
    expect(robotsAllows(mine, '/open')).toBe(true);
    expect(robotsAllows(mine, '/secret/a')).toBe(false);
    expect(robotsAllows(parseRobots(''), '/anything')).toBe(true);
  });
  it('sitemaps: pages, and an index pointing at more sitemaps', () => {
    expect(parseSitemap('<urlset><url><loc>https://s.example/a</loc></url><url><loc> https://s.example/b?x=1&amp;y=2 </loc></url></urlset>').urls).toEqual(['https://s.example/a', 'https://s.example/b?x=1&y=2']);
    const idx = parseSitemap('<sitemapindex><sitemap><loc>https://s.example/s1.xml</loc></sitemap></sitemapindex>');
    expect(idx).toEqual({ urls: [], sitemaps: ['https://s.example/s1.xml'] });
  });
  it('scope: same site, folder, patterns, assets and documents', () => {
    const s = { origin: 'https://s.example', prefix: '/help', include: [], exclude: ['/help/old*', 'print=1'], files: false };
    expect(inScope('https://s.example/help/a', s)).toBe('ok');
    expect(inScope('https://s.example/helpdesk', s)).toBe('filtered');
    expect(inScope('https://s.example/about', s)).toBe('filtered');
    expect(inScope('https://other.example/help/a', s)).toBe('filtered');
    expect(inScope('https://s.example/help/old/a', s)).toBe('filtered');
    expect(inScope('https://s.example/help/a?print=1', s)).toBe('filtered');
    expect(inScope('https://s.example/help/pic.png', s)).toBe('filtered');
    expect(inScope('https://s.example/help/f.pdf', s)).toBe('filtered');
    expect(inScope('https://s.example/help/f.pdf', { ...s, files: true })).toBe('ok');
    expect(inScope('https://s.example/help/a', { ...s, include: ['/help/b*'] })).toBe('filtered');
    expect(prefixOf('https://s.example/help/start')).toBe('/help/start');
    expect(prefixOf('https://s.example/help/index.html')).toBe('/help');
    expect(prefixOf('https://s.example/help/')).toBe('/help');
    expect(patternMatches('/a*/c', '/ab/c')).toBe(true);
    expect(patternMatches('FAQ', '/x/faq/y')).toBe(true);
  });
  it('canonical address and soft 404', () => {
    expect(canonicalOf('<link rel="canonical" href="/p/1?utm_x=1">', 'https://s.example/p/1?ref=a')).toBe('https://s.example/p/1');
    expect(canonicalOf('<html></html>', 'https://s.example/')).toBeNull();
    expect(isSoft404('הדף לא נמצא', 'x')).toBe(true);
    expect(isSoft404('Page not found', 'x')).toBe(true);
    expect(isSoft404('מדריך', 'טקסט רגיל ארוך '.repeat(40))).toBe(false);
  });
  it('chunks keep the heading path of their section', () => {
    const c = chunkText('# מדריך\n\n## משלוחים\n\nמשלוח בדואר שליחים מגיע תוך יומיים עסקים לכל הארץ.\n\n## החזרות\n\nאפשר להחזיר מוצר תוך ארבעה עשר ימים מיום הקבלה.');
    expect(c.map((x) => x.heading)).toEqual(['מדריך › משלוחים', 'מדריך › החזרות']);
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
const cookies: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, who?: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.71.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });

const page = (title: string, body: string, head = '') => `<html><head><title>${title}</title>${head}</head><body><nav><a href="/skip-me">תפריט</a></nav><main><h1>${title}</h1>${body}</main><footer>זכויות יוצרים</footer></body></html>`;
const long = (s: string) => `<p>${s} ${'פירוט נוסף שעוזר לעמוד להיות ארוך מספיק כדי לא להיחשב ריק. '.repeat(4)}</p>`;
const site: Record<string, string> = {};
const fetched: string[] = [];

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, () => null);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['admin', 'admin'], ['agent', 'agent']] as const) {
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [`${e}@t.io`, e, r, await hashPassword(PW)]);
    cookies[e] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW })).cookies[0]!.value}`;
  }
  mgr.kb!.setFetcher(async (url) => {
    fetched.push(url);
    const body = site[url];
    if (body === undefined) throw new Error('http_404');
    const ct = url.endsWith('robots.txt') ? 'text/plain' : url.endsWith('.xml') ? 'application/xml' : 'text/html';
    return { url, contentType: ct, body: Buffer.from(body) };
  });
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('site crawl', () => {
  it('follows depth 2, honours robots, nofollow, patterns and canonical, keeps index pages out, reports, and switches off vanished pages', async () => {
    Object.assign(site, {
      'https://docs.example/robots.txt': 'User-agent: *\nDisallow: /docs/private\nSitemap: https://docs.example/sitemap.xml',
      'https://docs.example/sitemap.xml': '<urlset><url><loc>https://docs.example/docs/from-sitemap</loc></url></urlset>',
      'https://docs.example/docs': page('מרכז התיעוד', `${long('ברוכים הבאים')}<a href="/docs/index2">אינדקס</a><a href="/docs/private/secret">סודי</a><a href="/docs/skip/x">לדלג</a><a href="/docs/a?utm_source=news">א</a><a href="/docs/nofollow" rel="nofollow">nf</a><a href="/docs/gone">gone</a>`),
      'https://docs.example/docs/index2': page('אינדקס', '<p>קצר</p><a href="/docs/deep">עמוק</a>'),              // thin: not kept, but followed
      'https://docs.example/docs/deep': page('עמוד עמוק', long('תוכן שנמצא בעומק שני')),
      'https://docs.example/docs/a': page('עמוד א', `${long('משלוחים לכל הארץ')}<link rel="canonical" href="/docs/a-canonical">`),
      'https://docs.example/docs/a-canonical': page('עמוד א', long('משלוחים לכל הארץ בגרסה הקנונית')),
      'https://docs.example/docs/from-sitemap': page('מהמפה', long('עמוד שנמצא רק במפת האתר')),
      'https://docs.example/docs/nofollow': page('לא לעקוב', long('לא אמור להיקרא')),
      'https://docs.example/docs/private/secret': page('סודי', long('לא אמור להיקרא')),
      'https://docs.example/docs/skip/x': page('דילוג', long('לא אמור להיקרא')),
      'https://docs.example/docs/gone': page('יעלם', long('עמוד שיימחק מהאתר')),
    });
    const r = await call('POST', '/kb/sources/link', 'admin', { url: 'https://docs.example/docs', crawlPages: 50, crawl: { depth: 2, sitemap: true, stayInPath: true, exclude: ['/docs/skip*'] } });
    expect(r.statusCode).toBe(202);
    await mgr.kb!.idle();
    const parent = (await db.query(`SELECT id, status, crawl_report AS rep FROM kb_sources WHERE url = 'https://docs.example/docs'`)).rows[0];
    expect(parent.status).toBe('ready');
    const kids = (await db.query(`SELECT url, status, enabled FROM kb_sources WHERE parent_id = $1 ORDER BY url`, [parent.id])).rows;
    expect(kids.map((k) => k.url)).toEqual(['https://docs.example/docs/a-canonical', 'https://docs.example/docs/deep', 'https://docs.example/docs/from-sitemap', 'https://docs.example/docs/gone']);
    expect(fetched).not.toContain('https://docs.example/docs/private/secret');   // robots
    expect(fetched).not.toContain('https://docs.example/docs/skip/x');          // exclude pattern
    expect(fetched).not.toContain('https://docs.example/docs/nofollow');         // rel=nofollow
    expect(fetched).not.toContain('https://docs.example/skip-me');               // menu is not content, and out of scope
    expect(fetched.filter((u) => u === 'https://docs.example/docs/a').length).toBe(1);   // tracking parameter did not make a second page
    expect(parent.rep).toMatchObject({ thin: 1, duplicates: 1, limited: false, sitemap: 1, gone: 0 });
    expect(parent.rep.robots).toBeGreaterThanOrEqual(1);
    expect(parent.rep.filtered).toBeGreaterThanOrEqual(1);
    // the footer text is not in the index; the main text is
    expect((await db.query(`SELECT count(*)::int AS n FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id WHERE s.parent_id = $1 AND c.body LIKE '%זכויות יוצרים%'`, [parent.id])).rows[0].n).toBe(0);

    // a second crawl: nothing changed, nothing re-indexed; one page is removed from the site, so it is switched off
    delete site['https://docs.example/docs/gone'];
    site['https://docs.example/docs'] = site['https://docs.example/docs']!.replace('<a href="/docs/gone">gone</a>', '');
    await call('POST', `/kb/sources/${parent.id}/reindex`, 'admin');
    await mgr.kb!.idle();
    const rep2 = (await db.query(`SELECT crawl_report AS rep FROM kb_sources WHERE id = $1`, [parent.id])).rows[0].rep;
    expect(rep2.gone).toBe(1);
    expect(rep2.unchanged).toBeGreaterThanOrEqual(2);
    expect((await db.query(`SELECT enabled, error FROM kb_sources WHERE url = 'https://docs.example/docs/gone'`)).rows[0]).toEqual({ enabled: false, error: 'gone' });
    const list = (await call('GET', '/kb/sources', 'admin')).json() as { url: string; crawlReport: unknown; crawlCfg: { depth: number } }[];
    expect(list.find((x) => x.url === 'https://docs.example/docs')).toMatchObject({ crawlCfg: { depth: 2, stayInPath: true, sitemap: true } });
  });

  it('goes down to depth 3 through ordinary pages, and not further than asked', async () => {
    Object.assign(site, {
      'https://deep.example/s': page('התחלה', `${long('עמוד ההתחלה')}<a href="/s/l1">1</a>`),
      'https://deep.example/s/l1': page('רמה ראשונה', `${long('תוכן ברמה הראשונה')}<a href="/s/l2">2</a>`),
      'https://deep.example/s/l2': page('רמה שנייה', `${long('תוכן ברמה השנייה')}<a href="/s/l3">3</a>`),
      'https://deep.example/s/l3': page('רמה שלישית', `${long('תוכן ברמה השלישית')}<a href="/s/l4">4</a>`),
      'https://deep.example/s/l4': page('רמה רביעית', long('מעבר למבוקש')),
    });
    await call('POST', '/kb/sources/link', 'admin', { url: 'https://deep.example/s', crawlPages: 20, crawl: { depth: 3 } });
    await mgr.kb!.idle();
    const urls = (await db.query(`SELECT url FROM kb_sources WHERE url = 'https://deep.example/s' OR url LIKE 'https://deep.example/s/%' ORDER BY url`)).rows.map((r) => r.url);
    expect(urls).toEqual(['https://deep.example/s', 'https://deep.example/s/l1', 'https://deep.example/s/l2', 'https://deep.example/s/l3']);
  });

  it('a ready-made site wrapped in one form still yields text, and a menu repeated on every page is not kept', async () => {
    const menu = '<div class="mega"><p>' + 'תפריט האתר: אודות, צור קשר, מדורים מקצועיים, בטיחות חשמל, ארגונומיה, גיהות, תנאי שימוש. '.repeat(5) + '</p></div>';
    const wrap = (title: string, body: string, links = '') => `<html><head><title>${title}</title></head><body><form id="form1" method="post">${menu}<div class="content"><h1>${title}</h1>${body}${links}</div></form></body></html>`;
    const links = ['a', 'b', 'c', 'd'].map((x) => `<a href="/w/${x}">${x}</a>`).join('');
    Object.assign(site, { 'https://asp.example/w': wrap('בית', long('עמוד הבית של האתר'), links) });
    for (const x of ['a', 'b', 'c', 'd']) site[`https://asp.example/w/${x}`] = wrap(`נושא ${x}`, long(`תוכן ייחודי לדף ${x}`));
    await call('POST', '/kb/sources/link', 'admin', { url: 'https://asp.example/w', crawlPages: 10 });
    await mgr.kb!.idle();
    const rows = (await db.query(`SELECT string_agg(c.body, ' ') AS t, s.url FROM kb_sources s LEFT JOIN kb_chunks c ON c.source_id = s.id WHERE s.url LIKE 'https://asp.example/w%' GROUP BY s.url ORDER BY s.url`)).rows;
    expect(rows.map((r) => r.url)).toEqual(['https://asp.example/w', 'https://asp.example/w/a', 'https://asp.example/w/b', 'https://asp.example/w/c', 'https://asp.example/w/d']);
    for (const r of rows) { expect(String(r.t).length).toBeGreaterThan(30); expect(r.t).not.toContain('תפריט האתר'); }
    expect(rows[1].t).toContain('תוכן ייחודי לדף a');
    const rep = (await db.query(`SELECT crawl_report AS rep FROM kb_sources WHERE url = 'https://asp.example/w'`)).rows[0].rep;
    expect(rep.boilerplate).toBeGreaterThan(0);
  });

  it('a content selector and removed parts decide what is indexed', async () => {
    site['https://docs.example/sel'] = '<html><head><title>עם בורר</title></head><body><div class="cookie-banner">אשרו עוגיות</div><div id="wrap"><div class="article">' + long('התוכן האמיתי של המאמר') + '</div><div class="promo">פרסומת מציקה</div></div></body></html>';
    const r = await call('POST', '/kb/sources/link', 'admin', { url: 'https://docs.example/sel', crawl: { selector: '.article', remove: ['.promo'] } });
    expect(r.statusCode).toBe(202);
    await mgr.kb!.idle();
    const text = (await db.query(`SELECT string_agg(c.body, ' ') AS t FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id WHERE s.url = 'https://docs.example/sel'`)).rows[0].t as string;
    expect(text).toContain('התוכן האמיתי של המאמר');
    expect(text).not.toContain('אשרו עוגיות');
    expect(text).not.toContain('פרסומת');
  });

  it('preview shows the text, the headings and what a crawl would follow, and stores nothing', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM kb_sources')).rows[0].n;
    expect((await call('POST', '/kb/scrape/preview', 'agent', { url: 'https://docs.example/docs' })).statusCode).toBe(403);
    const r = await call('POST', '/kb/scrape/preview', 'admin', { url: 'https://docs.example/docs', crawl: { stayInPath: true, exclude: ['/docs/skip*'], sitemap: true } });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ title: 'מרכז התיעוד', robotsAllowed: true, thin: false, soft404: false, sitemap: { found: true, urls: 1 } });
    expect(j.headings[0]).toBe('מרכז התיעוד');
    expect(j.excerpt).toContain('ברוכים הבאים');
    expect(j.excerpt).not.toContain('זכויות יוצרים');
    expect(j.links.accepted).toContain('https://docs.example/docs/index2');
    expect(j.links.accepted).not.toContain('https://docs.example/docs/private/secret');
    expect(j.links.robots).toBe(1);
    expect(j.links.filtered).toBeGreaterThanOrEqual(1);
    expect((await db.query('SELECT count(*)::int AS n FROM kb_sources')).rows[0].n).toBe(before);
    expect((await call('POST', '/kb/scrape/preview', 'admin', { url: 'http://127.0.0.1/' })).json().error).toBe('blocked_address');
  });

  it('health lists errors and crawl reports; duplicates finds identical content', async () => {
    const h = (await call('GET', '/kb/health', 'admin')).json();
    expect(h.errors.some((e: { error: string }) => e.error === 'gone')).toBe(true);
    expect(h.crawls.length).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/kb/health', 'agent')).statusCode).toBe(403);
    site['https://docs.example/twin1'] = page('תאום', long('תוכן זהה בדיוק בשני מקומות'));
    site['https://docs.example/twin2'] = site['https://docs.example/twin1']!;
    await call('POST', '/kb/sources/link', 'admin', { url: 'https://docs.example/twin1' });
    await call('POST', '/kb/sources/link', 'admin', { url: 'https://docs.example/twin2' });
    await mgr.kb!.idle();
    const d = (await call('GET', '/kb/duplicates', 'admin')).json() as { items: { url: string }[] }[];
    expect(d.some((g) => g.items.map((i) => i.url).sort().join() === 'https://docs.example/twin1,https://docs.example/twin2')).toBe(true);
    expect((await call('POST', '/kb/sources/refresh-links', 'admin')).json().queued).toBeGreaterThanOrEqual(3);
    await mgr.kb!.idle();
  });
});
