import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { isPublicIp } from './fetch.js';

/**
 * A small forward proxy for the headless browser. A browser resolves names and follows redirects and sub-requests by itself, so
 * checking the first address is not enough (a page can load http://169.254.169.254/ or an internal service from a script, or a name can
 * be re-pointed after the check). Every connection of the browser goes through this proxy, which resolves the name itself and refuses
 * non-public addresses and unusual ports at connect time, for HTTPS tunnels (CONNECT) and plain HTTP alike.
 */
const PORTS = new Set([80, 443, 8080, 8443]);

export interface SsrfProxy { port: number; blocked: () => number; close: () => Promise<void> }

async function resolveHost(host: string, allowPrivate: boolean): Promise<string> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) { if (!allowPrivate && !isPublicIp(bare)) throw new Error('blocked_address'); return bare; }
  if (!allowPrivate && (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.internal') || bare.endsWith('.local'))) throw new Error('blocked_address');
  const addrs = await dns.promises.lookup(bare, { all: true });
  if (!addrs.length || (!allowPrivate && addrs.some((a) => !isPublicIp(a.address)))) throw new Error('blocked_address');
  return addrs[0]!.address;
}

export function createSsrfProxy(opts: { allowPrivate?: boolean } = {}): Promise<SsrfProxy> {
  const allowPrivate = !!opts.allowPrivate;
  let blocked = 0;
  const deny = (sock: net.Socket) => { blocked++; sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); };
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '');
      if (u.protocol !== 'http:') throw new Error('blocked_address');
      const port = Number(u.port || 80);
      if (!allowPrivate && !PORTS.has(port)) throw new Error('blocked_address');
      const ip = await resolveHost(u.hostname, allowPrivate);
      const up = http.request({ host: ip, port, method: req.method, path: u.pathname + u.search, headers: { ...req.headers, host: u.host }, timeout: 20_000 }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      up.on('timeout', () => up.destroy());
      req.pipe(up);
    } catch { blocked++; res.writeHead(403); res.end(); }
  });
  server.on('connect', async (req, client: net.Socket, head) => {
    client.on('error', () => undefined);
    try {
      const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
      if (!m) throw new Error('bad');
      const port = Number(m[2]);
      if (!allowPrivate && !PORTS.has(port)) throw new Error('blocked_address');
      const ip = await resolveHost(m[1]!, allowPrivate);
      const up = net.connect({ host: ip, port });
      up.setTimeout(30_000, () => up.destroy());
      up.on('error', () => client.destroy());
      up.on('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) up.write(head); up.pipe(client); client.pipe(up); });
      client.on('close', () => up.destroy());
    } catch { deny(client); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, blocked: () => blocked, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}
