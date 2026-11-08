import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { BrowserRenderer } from './kb/browser.js';
import { FetchError } from './kb/fetch.js';

/**
 * Entry point of the separate rendering container (docker compose --profile browser). It holds no database access, session keys or
 * other secrets: only a token shared with the main server. It opens only public web addresses (see ssrf-proxy.ts).
 */
const token = process.env.BROWSER_TOKEN ?? '';
if (token.length < 24) { console.error('BROWSER_TOKEN (at least 24 characters) is required'); process.exit(1); }
const renderer = new BrowserRenderer({ path: process.env.BROWSER_PATH, noSandbox: process.env.BROWSER_NO_SANDBOX === 'true' ? true : undefined });
const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization'] }, bodyLimit: 4096 });

const ok = (header: string | undefined) => {
  const a = Buffer.from(header ?? ''), b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
};
app.get('/healthz', async () => ({ ok: true }));
app.get('/status', async (req, reply) => { if (!ok(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' }); const s = await renderer.status(); return { state: s.state, detail: s.detail }; });
app.post('/render', { config: {} }, async (req, reply) => {
  if (!ok(req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
  const url = (req.body as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || url.length > 1000) return reply.code(400).send({ error: 'bad_request' });
  try { const f = await renderer.render(url); return { url: f.url, html: f.body.toString('utf8') }; } catch (e) {
    return reply.code(422).send({ error: e instanceof FetchError ? e.message : 'fetch_failed' });
  }
});
await app.listen({ port: Number(process.env.PORT ?? 3100), host: process.env.HOST ?? '0.0.0.0' });
const stop = () => void renderer.close().finally(() => process.exit(0));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
