import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { BrowserRenderer, findChromium, type Renderer } from '../src/kb/browser.js';
import { looksClientRendered } from '../src/kb/crawler.js';
import { createSsrfProxy } from '../src/kb/ssrf-proxy.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const listen = (h: http.RequestListener) => new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
  const s = http.createServer(h);
  s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as AddressInfo).port, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) }));
});
const connectVia = (proxyPort: number, target: string) => new Promise<string>((resolve) => {
  const sock = net.connect(proxyPort, '127.0.0.1', () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let buf = '';
  sock.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0]!); } });
  sock.on('error', () => resolve('error'));
  sock.on('close', () => resolve(buf.split('\r\n')[0] || 'closed'));
});

describe('SSRF proxy for the browser', () => {
  it('refuses private addresses, loopback, metadata and odd ports, for tunnels and plain requests', async () => {
    const proxy = await createSsrfProxy();
    for (const t of ['127.0.0.1:443', '10.0.0.5:443', '169.254.169.254:80', '192.168.1.1:8080', 'localhost:443', '8.8.8.8:22', '[::1]:443']) {
      expect(await connectVia(proxy.port, t), t).toMatch(/403/);
    }
    const plain = await new Promise<number>((resolve) => { http.get({ host: '127.0.0.1', port: proxy.port, path: 'http://169.254.169.254/latest/meta-data', headers: { host: '169.254.169.254' } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }); });
    expect(plain).toBe(403);
    expect(proxy.blocked()).toBeGreaterThanOrEqual(8);
    await proxy.close();
  });
  it('lets traffic through only when private addresses are explicitly allowed (tests)', async () => {
    const target = await listen((_q, r) => { r.end('hello'); });
    const proxy = await createSsrfProxy({ allowPrivate: true });
    const body = await new Promise<string>((resolve) => { http.get({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${target.port}/x`, headers: { host: `127.0.0.1:${target.port}` } }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve(b)); }); });
    expect(body).toBe('hello');
    await proxy.close(); await target.close();
  });
});

describe('looksClientRendered', () => {
  const long = '<p>' + 'טקסט רגיל של דף רגיל עם הרבה מילים. '.repeat(30) + '</p>';
  it('spots empty shells and ignores real pages', () => {
    expect(looksClientRendered('<html><body><div id="root"></div><script src="/app.js"></script></body></html>')).toBe(true);
    expect(looksClientRendered('<html><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="app"></div><script>x()</script></body></html>')).toBe(true);
    expect(looksClientRendered(`<html><body><main>${long}</main><script>track()</script></body></html>`)).toBe(false);
    expect(looksClientRendered('<html><body><p>short static page</p></body></html>')).toBe(false);   // no scripts: nothing would change
  });
});

const chromium = findChromium();
describe.skipIf(!chromium)('headless browser rendering (real Chromium)', () => {
  let site: Awaited<ReturnType<typeof listen>>;
  let r: BrowserRenderer;
  beforeAll(async () => {
    site = await listen((q, res) => {
      if (q.url === '/data.json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ text: 'תוכן שהגיע מבקשת רשת בזמן הרצה של הדף' })); }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (q.url === '/missing') { res.statusCode = 404; return res.end('no'); }
      res.end('<html><head><title>אפליקציה</title></head><body><div id="root"></div><script>setTimeout(async()=>{const d=await (await fetch("/data.json")).json();document.getElementById("root").innerHTML="<main><h1>כותרת שנבנתה ב-JavaScript</h1><p>"+d.text+"</p></main>";},150)</script></body></html>');
    });
    r = new BrowserRenderer({ allowPrivate: true, noSandbox: true });
  });
  afterAll(async () => { await r.close(); await site.close(); });

  it('returns the page after scripts have built it', async () => {
    const st = await r.status();
    expect(st.state).toBe('ready');
    const f = await r.render(`http://127.0.0.1:${site.port}/`, { skipUrlCheck: true });
    const html = f.body.toString('utf8');
    expect(html).toContain('כותרת שנבנתה ב-JavaScript');
    expect(html).toContain('תוכן שהגיע מבקשת רשת');
    await expect(r.render(`http://127.0.0.1:${site.port}/missing`, { skipUrlCheck: true })).rejects.toThrow('http_404');
  }, 90_000);

  it('the browser cannot reach internal addresses even when the up-front check is skipped (its traffic goes through the proxy)', async () => {
    const strict = new BrowserRenderer({ noSandbox: true });
    try {
      await expect(strict.render(`http://127.0.0.1:${site.port}/`, { skipUrlCheck: true })).rejects.toThrow('blocked_address');
      await expect(strict.render('http://169.254.169.254/latest/meta-data/', { skipUrlCheck: true })).rejects.toThrow('blocked_address');
      await expect(strict.render('http://127.0.0.1/')).rejects.toThrow('blocked_address');   // and the normal path refuses it before launching anything
    } finally { await strict.close(); }
  }, 90_000);
});

// ---- knowledge base integration with a stand-in renderer ----
const ORIGIN = 'https://panel.test';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let cookie = '';
let ip = 0;
const call = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: `10.72.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie } });

describe('knowledge base with a renderer', () => {
  const shell = '<html><head><title>אפליקציה</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const full = '<html><head><title>אפליקציה</title></head><body><main><h1>שאלות נפוצות</h1><p>' + 'אפשר להחליף מוצר תוך שלושים יום מיום הקנייה בתנאי שהאריזה נשארה שלמה. '.repeat(3) + '</p></main></body></html>';
  const plain = '<html><head><title>רגיל</title></head><body><main><h1>דף רגיל</h1><p>' + 'דף שנטען בלי צורך בדפדפן, עם מספיק טקסט כדי להיקרא כהלכה. '.repeat(12) + '</p></main><script>x()</script></body></html>';
  const pages: Record<string, string> = { 'https://spa.example/': shell, 'https://spa.example/plain': plain };
  const rendered: string[] = [];
  let fail = false;
  const renderer: Renderer = {
    status: async () => ({ mode: 'local', state: 'ready' }),
    render: async (url) => { rendered.push(url); if (fail) throw new Error('browser_unavailable'); return { url, contentType: 'text/html', body: Buffer.from(full) }; },
  };
  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, () => null);
    app = await buildApp(cfg, db, mgr);
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['a@t.io', 'a', 'admin', await hashPassword('correct-horse-battery')]);
    cookie = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@t.io', password: 'correct-horse-battery' }, remoteAddress: '10.72.9.9', headers: { origin: ORIGIN } })).cookies[0]!.value}`;
    mgr.kb!.setFetcher(async (url) => { const b = pages[url]; if (b === undefined) throw new Error('http_404'); return { url, contentType: url.endsWith('robots.txt') ? 'text/plain' : 'text/html', body: Buffer.from(b) }; });
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('reports that the browser is off until one is configured', async () => {
    expect((await call('GET', '/kb/browser')).json()).toMatchObject({ mode: 'off', state: 'off' });
    mgr.kb!.setRenderer(renderer);
    expect((await call('GET', '/kb/browser')).json()).toMatchObject({ mode: 'local', state: 'ready' });
  });

  it('auto: an empty shell is rendered, a normal page is not; the preview says which', async () => {
    const a = (await call('POST', '/kb/scrape/preview', { url: 'https://spa.example/' })).json();
    expect(a).toMatchObject({ rendered: true });
    expect(a.excerpt).toContain('אפשר להחליף מוצר');
    const b = (await call('POST', '/kb/scrape/preview', { url: 'https://spa.example/plain' })).json();
    expect(b.rendered).toBe(false);
    rendered.length = 0;
    await call('POST', '/kb/sources/link', { url: 'https://spa.example/' });
    await mgr.kb!.idle();
    expect(rendered).toEqual(['https://spa.example/']);
    const t = (await db.query(`SELECT string_agg(c.body, ' ') AS t, s.status FROM kb_sources s JOIN kb_chunks c ON c.source_id = s.id WHERE s.url = 'https://spa.example/' GROUP BY s.status`)).rows[0];
    expect(t.status).toBe('ready');
    expect(t.t).toContain('אפשר להחליף מוצר תוך שלושים יום');
    // the same page read again: the text did not change, so nothing is re-indexed
    const ver = async () => (await db.query(`SELECT version FROM kb_sources WHERE url = 'https://spa.example/'`)).rows[0].version as number;
    const v1 = await ver();
    await call('POST', `/kb/sources/${(await db.query(`SELECT id FROM kb_sources WHERE url = 'https://spa.example/'`)).rows[0].id}/reindex`);
    await mgr.kb!.idle();
    expect(await ver()).toBe(v1);
  });

  it('never: the plain shell is used (and has no text); always: even a normal page goes through the browser; a failing browser falls back', async () => {
    expect((await call('POST', '/kb/scrape/preview', { url: 'https://spa.example/', crawl: { render: 'never' } })).statusCode).toBe(200);
    expect((await call('POST', '/kb/scrape/preview', { url: 'https://spa.example/', crawl: { render: 'never' } })).json().chars).toBeLessThan(50);
    rendered.length = 0;
    expect((await call('POST', '/kb/scrape/preview', { url: 'https://spa.example/plain', crawl: { render: 'always' } })).json().rendered).toBe(true);
    expect(rendered).toEqual(['https://spa.example/plain']);
    fail = true;
    const f = (await call('POST', '/kb/scrape/preview', { url: 'https://spa.example/plain', crawl: { render: 'always' } })).json();
    expect(f).toMatchObject({ rendered: false });
    fail = false;
  });
});
