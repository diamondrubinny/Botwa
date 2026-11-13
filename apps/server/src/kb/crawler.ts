import { z } from 'zod';

/** Options of a site crawl (stored per crawled link). */
export const crawlCfgSchema = z.object({
  /** how many link-hops from the start page (1 = only pages linked from it) */
  depth: z.number().int().min(1).max(4).default(1),
  /** also take page addresses from sitemap.xml */
  sitemap: z.boolean().default(false),
  /** stay inside the folder of the start address */
  stayInPath: z.boolean().default(false),
  /** also read linked PDF, Word and Excel files */
  files: z.boolean().default(false),
  /** only addresses containing one of these (a "*" matches anything) */
  include: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  /** never addresses containing one of these */
  exclude: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  /** pages built by JavaScript: read them in a headless browser (auto = only when the plain page looks empty) */
  render: z.enum(['auto', 'always', 'never']).default('auto'),
  /** CSS selector of the page's main content (empty = automatic) */
  selector: z.string().trim().max(200).default(''),
  /** CSS selectors of parts to drop from every page (menus, banners...) */
  remove: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
}).strict();
export type CrawlCfg = z.infer<typeof crawlCfgSchema>;
export const DEFAULT_CRAWL: CrawlCfg = crawlCfgSchema.parse({});

export const MAX_CRAWL_PAGES = 300;

export interface CrawlReport {
  at: string; discovered: number; indexed: number; unchanged: number; failed: number;
  robots: number; filtered: number; duplicates: number; thin: number; gone: number; limited: boolean; sitemap: number; boilerplate: number; rendered: number;
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|msclkid|mc_cid|mc_eid|igshid|_ga|ref|source)$/i;
const SKIP_EXT = /\.(jpe?g|png|gif|svg|webp|ico|bmp|css|js|mjs|map|woff2?|ttf|eot|zip|rar|7z|gz|mp4|mp3|wav|avi|mov|webm|xml|json|rss|atom)$/i;
const DOC_EXT = /\.(pdf|docx|xlsx)$/i;

/** One canonical spelling of an address, so the same page is never fetched twice: no fragment, no tracking parameters, sorted query, no trailing slash. */
export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim().replace(/&amp;/g, '&'), base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  return u.toString();
}

export interface Robots { allow: string[]; disallow: string[]; crawlDelay: number | null; sitemaps: string[] }

/** The rules of robots.txt that apply to us: the group naming our agent, else the "*" group (longest matching rule wins; Allow wins a tie). */
export function parseRobots(text: string, agent = 'botwakb'): Robots {
  const groups: { agents: string[]; allow: string[]; disallow: string[]; delay: number | null }[] = [];
  const sitemaps: string[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase(), val = m[2]!.trim();
    if (key === 'sitemap') { if (/^https?:\/\//i.test(val)) sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [], delay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' && val) cur.allow.push(val);
    else if (key === 'disallow' && val) cur.disallow.push(val);
    else if (key === 'crawl-delay') { const n = Number(val); if (Number.isFinite(n) && n >= 0) cur.delay = n; }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && agent.includes(a))) ?? groups.find((g) => g.agents.includes('*'));
  return { allow: mine?.allow ?? [], disallow: mine?.disallow ?? [], crawlDelay: mine?.delay ?? null, sitemaps };
}

const ruleRe = (rule: string) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
export function robotsAllows(r: Robots, pathAndQuery: string): boolean {
  let best = { len: -1, allow: true };
  for (const [rules, allow] of [[r.disallow, false], [r.allow, true]] as const) {
    for (const rule of rules) {
      if (!ruleRe(rule).test(pathAndQuery)) continue;
      if (rule.length > best.len || (rule.length === best.len && allow)) best = { len: rule.length, allow };
    }
  }
  return best.allow;
}

/** Addresses listed by a sitemap, and further sitemaps when it is an index. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s][^<\]]*?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, '&'));
  return /<sitemapindex/i.test(xml) ? { urls: [], sitemaps: locs.slice(0, 5) } : { urls: locs.slice(0, 5000), sitemaps: [] };
}

/** A pattern is a plain piece of the address, or uses "*" as a wildcard. */
export function patternMatches(pattern: string, target: string): boolean {
  if (!pattern.includes('*')) return target.toLowerCase().includes(pattern.toLowerCase());
  return new RegExp(pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i').test(target);
}

export type Verdict = 'ok' | 'filtered';
export interface Scope { origin: string; prefix: string | null; include: string[]; exclude: string[]; files: boolean }

/** Whether a (normalised) address belongs to the crawl: same site, inside the folder if asked, not a media/asset file, matching the include/exclude patterns. */
export function inScope(url: string, s: Scope): Verdict {
  let u: URL;
  try { u = new URL(url); } catch { return 'filtered'; }
  if (u.origin !== s.origin) return 'filtered';
  if (SKIP_EXT.test(u.pathname)) return 'filtered';
  if (DOC_EXT.test(u.pathname) && !s.files) return 'filtered';
  if (s.prefix && !(u.pathname === s.prefix || u.pathname.startsWith(`${s.prefix}/`) || s.prefix === '/')) return 'filtered';
  const target = u.pathname + u.search;
  if (s.exclude.some((p) => patternMatches(p, target))) return 'filtered';
  if (s.include.length && !s.include.some((p) => patternMatches(p, target))) return 'filtered';
  return 'ok';
}

/** The part of the site a crawl stays in: the start address itself when it is a section ("/help"), the folder of a file address ("/help/index.html" -> "/help"). */
export const prefixOf = (startUrl: string): string => {
  const p = new URL(startUrl).pathname.replace(/\/+$/, '') || '/';
  return /\.[a-z0-9]{1,5}$/i.test(p) ? p.replace(/\/[^/]*$/, '') || '/' : p;
};

/** The canonical address a page declares for itself, if any. */
export function canonicalOf(html: string, pageUrl: string): string | null {
  const tag = /<link[^>]+rel=["']canonical["'][^>]*>/i.exec(html)?.[0];
  const href = tag && /href=["']([^"']+)["']/i.exec(tag)?.[1];
  return href ? normalizeUrl(href, pageUrl) : null;
}

const SOFT_404 = /(^|\W)(404|page not found|not found|הדף לא נמצא|העמוד לא נמצא|דף לא נמצא|שגיאה 404)(\W|$)/i;
export const isSoft404 = (title: string | null, text: string): boolean => (!!title && SOFT_404.test(title)) || (text.length < 400 && SOFT_404.test(text));
export const MIN_PAGE_CHARS = 150;

/**
 * Whether a page fetched without JavaScript is probably an empty shell that a script fills in: almost no visible text next to scripts,
 * an empty application root, or a "please enable JavaScript" notice.
 */
export function looksClientRendered(html: string): boolean {
  const visible = html.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  const hasScripts = /<script[\s>]/i.test(html);
  if (!hasScripts) return false;
  if (visible.length < 300) return true;
  if (/<div[^>]+id=["'](root|app|__next|__nuxt|app-root)["'][^>]*>\s*<\/div>/i.test(html) && visible.length < 1500) return true;
  const ns = /<noscript[^>]*>([\s\S]*?)<\/noscript>/gi;
  for (let m = ns.exec(html); m; m = ns.exec(html)) if (/javascript|ג'?אווה ?סקריפט/i.test(m[1]!) && visible.length < 1500) return true;
  return false;
}
