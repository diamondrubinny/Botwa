import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function walk(dir: string, base = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), `${base}${e.name}/`) : e.isFile() ? [`${base}${e.name}`] : [],
  );
}

/**
 * Serves the built admin panel from memory. Only files that exist at startup get a route (exact paths, no globbing,
 * no user-controlled filesystem access => no path traversal). Hashed assets are cached; index.html never is.
 */
export function registerStatic(app: FastifyInstance, root: string, maxFileBytes = 8 * 1024 * 1024): number {
  const files = walk(root).filter((f) => statSync(path.join(root, f)).size <= maxFileBytes);
  for (const rel of files) {
    const body = readFileSync(path.join(root, rel));
    const type = TYPES[path.extname(rel).toLowerCase()] ?? 'application/octet-stream';
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
    const hashed = rel.startsWith('assets/');
    const handler = async (req: { headers: Record<string, unknown> }, reply: { code(n: number): { send(b?: unknown): unknown }; header(k: string, v: string): unknown }) => {
      reply.header('content-type', type);
      reply.header('etag', etag);
      reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      reply.header('x-content-type-options', 'nosniff');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.code(200).send(body);
    };
    const urls = rel === 'index.html' ? ['/', '/index.html'] : [`/${rel}`];
    for (const url of urls) app.get(url, handler as never);
  }
  return files.length;
}
