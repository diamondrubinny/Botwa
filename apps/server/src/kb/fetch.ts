import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Server-side fetching of customer-facing documents by URL. The URL is typed by staff but must still be treated as hostile:
 * it could point at the server itself, the cloud metadata service or the internal network (SSRF). The address check happens
 * at connect time (inside the DNS lookup used for the connection), so DNS rebinding cannot swap in an internal address.
 */
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;           // this-net, private, loopback, multicast/reserved
    if (a === 100 && b >= 64 && b <= 127) return false;                         // CGNAT
    if (a === 169 && b === 254) return false;                                   // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.startsWith('192.0.0.')))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPublicIp(mapped[1]!);
    if (x === '::' || x === '::1') return false;
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff')) return false; // ULA, link-local, multicast
    if (x.startsWith('64:ff9b:') || x.startsWith('2001:db8')) return false;
    return true;
  }
  return false;
}

export const lookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { ...(options as object), all: true }, (err, addrs) => {
    if (err) return (cb as (e: Error) => void)(err);
    const list = addrs as dns.LookupAddress[];
    if (!list.length || list.some((a) => !isPublicIp(a.address))) return (cb as (e: Error) => void)(new Error('blocked_address'));
    if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    return (cb as unknown as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
  });
};

const agent = new Agent({ connect: { lookup, timeout: 10_000 }, headersTimeout: 15_000, bodyTimeout: 20_000 });

/** Outgoing POST for webhooks: same SSRF protection as fetching documents (connect-time address check), no redirects, small response read. */
export async function safePost(raw: string, body: string, headers: Record<string, string>, opts: { timeoutMs?: number; allowHttp?: boolean } = {}): Promise<{ status: number }> {
  const url = checkUrl(raw);
  if (url.protocol !== 'https:' && !opts.allowHttp) throw new FetchError('https_required');
  let res;
  try {
    res = await undiciFetch(url, { method: 'POST', dispatcher: agent, redirect: 'manual', body, headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
  } catch (e) {
    throw new FetchError(classifyNetworkError(e));
  }
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status };
}

export interface Fetched { url: string; contentType: string; body: Buffer }
export class FetchError extends Error {}

/** Why a request failed, in a form the operator can act on (the raw undici message is just "fetch failed"). */
export function classifyNetworkError(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string; name?: string } }).cause;
  const code = cause?.code ?? '';
  if (cause?.message === 'blocked_address') return 'blocked_address';
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA'].includes(code)) return 'dns_failed';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code) || (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') return 'timeout';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'connection_reset';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_SSL/i.test(code)) return 'tls_error';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'unreachable';
  return 'fetch_failed';
}

export function checkUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchError('bad_url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FetchError('bad_url');
  if (u.username || u.password) throw new FetchError('bad_url');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && !isPublicIp(u.hostname.replace(/^\[|\]$/g, ''))) throw new FetchError('blocked_address');
  if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.internal') || u.hostname.endsWith('.local')) throw new FetchError('blocked_address');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new FetchError('bad_url');
  return u;
}

const ALLOWED = /^(text\/(html|plain|markdown|csv)|application\/(xhtml\+xml|pdf|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))/i;

/** GET with manual redirects (max 3, each re-validated), a size cap and content-type allow-list. */
export async function safeGet(raw: string, opts: { maxBytes?: number } = {}): Promise<Fetched> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  let url = checkUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    let res;
    try {
      res = await undiciFetch(url, { dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'BotwaKnowledgeBase/1.0', accept: 'text/html,text/plain,application/pdf;q=0.9,*/*;q=0.1' } });
    } catch (e) {
      throw new FetchError(classifyNetworkError(e));
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined);
      url = checkUrl(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new FetchError(`http_${res.status}`); }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED.test(contentType)) { await res.body?.cancel().catch(() => undefined); throw new FetchError('unsupported_content_type'); }
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) { await res.body?.cancel().catch(() => undefined); throw new FetchError('too_large'); }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += c.length;
      if (total > maxBytes) throw new FetchError('too_large');
      chunks.push(Buffer.from(c));
    }
    return { url: url.toString(), contentType, body: Buffer.concat(chunks) };
  }
  throw new FetchError('too_many_redirects');
}
