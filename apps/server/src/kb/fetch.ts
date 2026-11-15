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
    const b = ipv6Bytes(ip);
    if (!b) return false;
    const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
    // IPv4 inside IPv6, in any spelling ("::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1"): the IPv4 address decides
    if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicIp(b.slice(12).join('.'));
    if (zero(0, 12)) return false;                                               // "::", "::1" and the old IPv4-compatible form
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return false;   // 64:ff9b::/96 NAT64
    if (b[0] === 0x20 && b[1] === 0x02) return false;                             // 2002::/16 6to4 (an IPv4 inside)
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false;   // 2001::/32 Teredo
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false;   // documentation
    if ((b[0]! & 0xfe) === 0xfc) return false;                                    // fc00::/7 unique local
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return false;                   // fe80::/10 link-local
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return false;                   // fec0::/10 old site-local
    if (b[0] === 0xff) return false;                                              // multicast
    return true;
  }
  return false;
}

/** The 16 bytes of an IPv6 address (any spelling: "::" shortening, an IPv4 tail, a zone id), or null when it is not one. */
export function ipv6Bytes(ip: string): number[] | null {
  let x = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (v4) {
    const p = v4[1]!.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => n > 255)) return null;
    x = x.slice(0, -v4[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = x.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 0xff]; });
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
export async function safeGet(raw: string, opts: { maxBytes?: number; allow?: RegExp; accept?: string } = {}): Promise<Fetched> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  let url = checkUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    let res;
    try {
      res = await undiciFetch(url, { dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'BotwaKnowledgeBase/1.0', accept: opts.accept ?? 'text/html,text/plain,application/pdf;q=0.9,*/*;q=0.1' } });
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
    if (!(opts.allow ?? ALLOWED).test(contentType)) { await res.body?.cancel().catch(() => undefined); throw new FetchError('unsupported_content_type'); }
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
