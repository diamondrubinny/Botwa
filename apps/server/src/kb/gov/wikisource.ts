import { Agent, fetch as undiciFetch } from 'undici';
import { classifyNetworkError, FetchError, lookup } from '../fetch.js';

/**
 * Read-only access to the Open Law Book texts on Hebrew Wikisource (MediaWiki API). The address is fixed here: nothing the user types
 * becomes a URL (no SSRF), and the connection may only reach public addresses (the knowledge base's DNS check).
 * Wikimedia limits automated clients: one request at a time, a descriptive User-Agent, and waiting when asked (429 + Retry-After).
 */
export const WS_HOST = 'he.wikisource.org';
const API = `https://${WS_HOST}/w/api.php`;
export const pageUrl = (title: string) => `https://${WS_HOST}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

export interface HttpResult { status: number; retryAfter: number | null; body: string }
/** The network layer (tests replace it). */
export type GovHttp = (url: string) => Promise<HttpResult>;

const agent = new Agent({ connect: { lookup, timeout: 10_000 }, headersTimeout: 20_000, bodyTimeout: 30_000 });
const MAX_BYTES = 8 * 1024 * 1024;

/** HTTPS GET to one fixed host only (each public source gets its own instance). */
export function makeHttp(userAgent: string, host: string = WS_HOST): GovHttp {
  return async (url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== host) throw new FetchError('blocked_address');
    let res;
    try {
      res = await undiciFetch(u, { dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(45_000), headers: { 'user-agent': userAgent, accept: 'application/json', 'accept-encoding': 'gzip' } });
    } catch (e) { throw new FetchError(classifyNetworkError(e)); }
    const ra = Number(res.headers.get('retry-after'));
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return { status: res.status, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null, body: '' }; }
    if (!/^application\/json/i.test(res.headers.get('content-type') ?? '')) { await res.body?.cancel().catch(() => undefined); throw new FetchError('unsupported_content_type'); }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += c.length;
      if (total > MAX_BYTES) throw new FetchError('too_large');
      chunks.push(Buffer.from(c));
    }
    return { status: res.status, retryAfter: null, body: Buffer.concat(chunks).toString('utf8') };
  };
}

export interface WsOptions { http: GovHttp; sleep: (ms: number) => Promise<void>; /** pause between requests */ gapMs: number }

/** GET the API with polite retries: waits as long as the server asks (up to 2 minutes), at most 5 tries. */
async function api(o: WsOptions, params: Record<string, string>): Promise<unknown> {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params })}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await o.http(url);
    if (r.status === 200) {
      let j: { error?: { code?: string } };
      try { j = JSON.parse(r.body); } catch { throw new FetchError('bad_response'); }
      if (j.error?.code === 'maxlag') { await o.sleep(5000); continue; }   // the wiki's servers are busy: try again shortly
      if (j.error) throw new FetchError(`api_${String(j.error.code ?? 'error').slice(0, 40)}`);
      return j;
    }
    if (r.status === 429 || r.status === 503) { await o.sleep(Math.min(120, r.retryAfter ?? 20 * (attempt + 1)) * 1000 + 500); continue; }
    throw new FetchError(`http_${r.status}`);
  }
  throw new FetchError('rate_limited');
}

/** Current revision ids of up to 50 pages in one light request (to skip pages that did not change). Missing pages map to null. */
export async function revisions(o: WsOptions, titles: string[]): Promise<Map<string, { title: string; revid: number } | null>> {
  const out = new Map<string, { title: string; revid: number } | null>();
  for (let i = 0; i < titles.length; i += 50) {
    const part = titles.slice(i, i + 50);
    if (i) await o.sleep(o.gapMs);
    const j = (await api(o, { action: 'query', prop: 'info', redirects: '1', titles: part.join('|') })) as {
      query?: { pages?: { title: string; missing?: boolean; lastrevid?: number }[]; redirects?: { from: string; to: string }[]; normalized?: { from: string; to: string }[] };
    };
    const alias = new Map<string, string>();
    for (const n of j.query?.normalized ?? []) alias.set(n.from, n.to);
    for (const r of j.query?.redirects ?? []) alias.set(r.from, r.to);
    const pages = new Map((j.query?.pages ?? []).map((p) => [p.title, p]));
    for (const t of part) {
      let cur = t;
      for (let k = 0; k < 3 && alias.has(cur); k++) cur = alias.get(cur)!;
      const p = pages.get(cur);
      out.set(t, p && !p.missing && p.lastrevid ? { title: p.title, revid: p.lastrevid } : null);
    }
  }
  return out;
}

export interface WsPage { title: string; revid: number; timestamp: string; content: string }

/** The wikitext of one page (following a redirect); null when the page does not exist. */
export async function fetchPage(o: WsOptions, title: string): Promise<WsPage | null> {
  const j = (await api(o, { action: 'query', prop: 'revisions', rvprop: 'content|timestamp|ids', rvslots: 'main', redirects: '1', titles: title })) as {
    query?: { pages?: { title: string; missing?: boolean; revisions?: { revid: number; timestamp: string; slots?: { main?: { content?: string } } }[] }[] };
  };
  const p = j.query?.pages?.[0];
  const rev = p?.revisions?.[0];
  if (!p || p.missing || !rev?.slots?.main?.content) return null;
  return { title: p.title, revid: rev.revid, timestamp: rev.timestamp, content: rev.slots.main.content };
}

/** The laws and regulations on work safety that the Open Law Book holds (titles only), for choosing what to import. */
export const CATALOG_QUERIES = [
  'intitle:"תקנות הבטיחות בעבודה"',
  'intitle:"תקנות ארגון הפיקוח על העבודה"',
  'intitle:"כללי הבטיחות בעבודה"',
  'intitle:"צו הבטיחות בעבודה"',
  'intitle:"פקודת הבטיחות בעבודה"',
  'intitle:"חוק ארגון הפיקוח על העבודה"',
  'intitle:"בטיחות" intitle:תקנות',
];
/** Only law texts: a law, ordinance, regulations, rules or order, not their sub-pages (drafts, explanatory notes). */
export const isLawTitle = (t: string) => /^(חוק|פקודת|תקנות|כללי|צו)\s/.test(t) && !t.includes('/') && t.length <= 200;

export async function catalog(o: WsOptions): Promise<string[]> {
  const found = new Set<string>();
  for (const [i, q] of CATALOG_QUERIES.entries()) {
    if (i) await o.sleep(o.gapMs);
    const j = (await api(o, { action: 'query', list: 'search', srnamespace: '0', srlimit: '200', srwhat: 'text', srprop: '', srsearch: q })) as { query?: { search?: { title: string }[] } };
    for (const s of j.query?.search ?? []) if (isLawTitle(s.title)) found.add(s.title);
  }
  return [...found].sort((a, b) => a.localeCompare(b, 'he'));
}

/** The main texts on safety at work, imported when nothing else was chosen. */
export const DEFAULT_TITLES = [
  'פקודת הבטיחות בעבודה',
  'חוק ארגון הפיקוח על העבודה',
  'תקנות ארגון הפיקוח על העבודה (ממונים על הבטיחות)',
  'תקנות ארגון הפיקוח על העבודה (תכנית לניהול הבטיחות)',
  'תקנות ארגון הפיקוח על העבודה (ועדות בטיחות ונאמני בטיחות)',
  'תקנות ארגון הפיקוח על העבודה (מסירת מידע והדרכת עובדים)',
  'תקנות הבטיחות בעבודה (עבודה בגובה)',
  'תקנות הבטיחות בעבודה (עבודות בניה)',
  'תקנות הבטיחות בעבודה (ציוד מגן אישי)',
  'תקנות הבטיחות בעבודה (עזרה ראשונה במקומות עבודה)',
  'תקנות הבטיחות בעבודה (חשמל)',
  'תקנות הבטיחות בעבודה (נוחויות)',
  'תקנות הבטיחות בעבודה (עבודה על גגות שבירים או תלולים)',
  'תקנות הבטיחות בעבודה (עגורנאים, מפעילי מכונות הרמה אחרות ואתתים)',
  'תקנות הבטיחות בעבודה (עגורני-צריח)',
  'תקנות הבטיחות בעבודה (הרמת בני אדם במלגזות)',
  'תקנות הבטיחות בעבודה (בדיקת מיתקני לחץ)',
  'תקנות הבטיחות בעבודה (גיהות תעסוקתית ובריאות העובדים ברעש)',
  'תקנות הבטיחות בעבודה (גיהות תעסוקתית ובריאות הציבור והעובדים באבק מזיק)',
  'תקנות הבטיחות בעבודה (ניטור סביבתי וניטור ביולוגי של עובדים בגורמים מזיקים)',
  'תקנות הבטיחות בעבודה (גיליון בטיחות, סיווג, אריזה, תיווי וסימון של אריזות)',
  'תקנות העבירות המינהליות (קנס מינהלי – בטיחות בעבודה)',
];
