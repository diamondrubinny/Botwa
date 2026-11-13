import { existsSync, readdirSync } from 'node:fs';
import { checkUrl, FetchError, type Fetched } from './fetch.js';
import { createSsrfProxy, type SsrfProxy } from './ssrf-proxy.js';

export interface RendererStatus { mode: 'off' | 'local' | 'remote'; state: 'off' | 'ready' | 'unavailable'; detail?: string }
export interface Renderer { status(): Promise<RendererStatus>; render(url: string): Promise<Fetched>; close?(): Promise<void> }

const CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

/** A Chromium executable: the configured one, a system install, or a Playwright download. */
export function findChromium(configured?: string): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  for (const c of CANDIDATES) if (existsSync(c)) return c;
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', `${process.env.HOME ?? ''}/.cache/ms-playwright`]) {
    if (!base || !existsSync(base)) continue;
    for (const d of readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const p = `${base}/${d}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export interface BrowserOpts { path?: string; allowPrivate?: boolean; noSandbox?: boolean; maxBytes?: number; navTimeoutMs?: number }

type Browser = import('playwright-core').Browser;

/**
 * Renders a page in headless Chromium so that content built by JavaScript is there when the text is read. Safety:
 * all traffic goes through the SSRF proxy (public addresses and normal ports only, checked at connect time); one fresh context per
 * page (no cookies or storage carried over); no downloads, service workers, permissions or media; images, fonts and media are not
 * fetched; one page at a time; hard time and size limits; the browser is closed after a minute without work.
 */
export class BrowserRenderer implements Renderer {
  private browser: Browser | null = null;
  private proxy: SsrfProxy | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  constructor(private readonly o: BrowserOpts = {}) {}

  async status(): Promise<RendererStatus> {
    const p = findChromium(this.o.path);
    return p ? { mode: 'local', state: 'ready', detail: p } : { mode: 'local', state: 'unavailable', detail: this.o.path ? `לא נמצא קובץ הדפדפן ${this.o.path}` : 'לא מותקן Chromium (בנו עם WITH_BROWSER=1 או הגדירו BROWSER_PATH)' };
  }

  private async launch(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    const path = findChromium(this.o.path);
    if (!path) throw new FetchError('browser_unavailable');
    const { chromium } = await import('playwright-core');
    this.proxy ??= await createSsrfProxy({ allowPrivate: this.o.allowPrivate });
    const noSandbox = this.o.noSandbox ?? process.getuid?.() === 0;
    this.browser = await chromium.launch({
      executablePath: path, headless: true,
      args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--mute-audio', '--disable-sync',
        `--proxy-server=http://127.0.0.1:${this.proxy.port}`, '--proxy-bypass-list=<-loopback>', ...(noSandbox ? ['--no-sandbox'] : [])],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' },   // none of the server's secrets reach the browser process
    });
    this.browser.on('disconnected', () => { this.browser = null; });
    return this.browser;
  }

  /** `skipUrlCheck` exists only so tests can prove the proxy refuses what the up-front check would already have refused. */
  render(rawUrl: string, opts: { skipUrlCheck?: boolean } = {}): Promise<Fetched> {
    const run = async (): Promise<Fetched> => {
      if (this.idle) clearTimeout(this.idle);
      const url = opts.skipUrlCheck ? rawUrl : checkUrl(rawUrl).toString();
      const browser = await this.launch();
      const before = this.proxy!.blocked();
      const ctx = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', permissions: [], javaScriptEnabled: true, locale: 'he-IL', viewport: { width: 1280, height: 1600 }, userAgent: 'BotwaKnowledgeBase/1.0 (rendering)' });
      const timeout = this.o.navTimeoutMs ?? 25_000;
      const guard = setTimeout(() => { void ctx.close().catch(() => undefined); }, timeout + 30_000);   // a page that hangs the browser does not hold the queue
      try {
        await ctx.route('**/*', (route) => {
          const r = route.request();
          if (['image', 'media', 'font', 'websocket', 'eventsource', 'manifest', 'texttrack'].includes(r.resourceType()) || !/^https?:/i.test(r.url())) return route.abort();
          return route.continue();
        });
        const page = await ctx.newPage();
        let resp;
        try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); } catch (e) {
          if (this.proxy!.blocked() > before) throw new FetchError('blocked_address');
          throw new FetchError(/Timeout/i.test((e as Error).message) ? 'timeout' : /ERR_NAME_NOT_RESOLVED/.test((e as Error).message) ? 'dns_failed' : 'fetch_failed');
        }
        if (this.proxy!.blocked() > before && !resp) throw new FetchError('blocked_address');
        if (resp && resp.status() >= 400) throw new FetchError(`http_${resp.status()}`);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
        // lazy content: scroll down a few screens so it is requested
        await page.evaluate(async () => { for (let i = 0; i < 6; i++) { window.scrollBy(0, window.innerHeight); await new Promise((r) => setTimeout(r, 250)); } }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
        const html = await page.content();
        if (html.length > (this.o.maxBytes ?? 5_000_000)) throw new FetchError('too_large');
        return { url: page.url(), contentType: 'text/html', body: Buffer.from(html, 'utf8') };
      } finally {
        clearTimeout(guard);
        await ctx.close().catch(() => undefined);
        this.idle = setTimeout(() => void this.close(), 60_000);
        this.idle.unref();
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    await this.proxy?.close().catch(() => undefined);
    this.proxy = null;
  }
}

/** The rendering service running in its own container (no database or keys there): same job, over HTTP with a shared token. */
export class RemoteRenderer implements Renderer {
  constructor(private readonly base: string, private readonly token: string) {}
  private headers() { return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }; }
  async status(): Promise<RendererStatus> {
    try {
      const r = await fetch(`${this.base}/status`, { headers: this.headers(), signal: AbortSignal.timeout(4000) });
      if (!r.ok) return { mode: 'remote', state: 'unavailable', detail: `השירות ענה ${r.status}` };
      const j = (await r.json()) as { state?: string; detail?: string };
      return { mode: 'remote', state: j.state === 'ready' ? 'ready' : 'unavailable', detail: j.detail };
    } catch { return { mode: 'remote', state: 'unavailable', detail: 'שירות הדפדפן לא עונה' }; }
  }
  async render(rawUrl: string): Promise<Fetched> {
    const url = checkUrl(rawUrl).toString();
    let r: Response;
    try { r = await fetch(`${this.base}/render`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ url }), signal: AbortSignal.timeout(90_000) }); } catch { throw new FetchError('browser_unavailable'); }
    const j = (await r.json().catch(() => ({}))) as { error?: string; url?: string; html?: string };
    if (!r.ok || typeof j.html !== 'string') throw new FetchError(j.error ?? 'browser_unavailable');
    return { url: j.url ?? url, contentType: 'text/html', body: Buffer.from(j.html, 'utf8') };
  }
}
