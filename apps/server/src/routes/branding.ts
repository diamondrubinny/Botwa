import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { brandSchema, DEFAULT_BRAND, extractBrandColors, extractLogoCandidates, manifestUrl, MAX_LOGO_BYTES, sniffImage, stylesheetUrls, type Brand } from '../branding.js';
import type { Db } from '../db.js';
import { checkUrl, FetchError, safeGet } from '../kb/fetch.js';
import type { KnowledgeBase } from '../kb/service.js';

async function loadBrand(db: Db): Promise<Brand> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'branding'`);
  const p = brandSchema.safeParse(rows[0]?.value);
  return p.success ? p.data : DEFAULT_BRAND;
}

const IMAGE = /^image\/(png|jpeg|webp)/i;
const PAGE = /^text\/html|^application\/xhtml\+xml/i;
const CSS = /^text\/css/i;
const JSONT = /^application\/(manifest\+)?json|^text\/plain/i;

/**
 * Branding: the product name, one logo and one brand colour. Reading it is public (the login page shows it); changing it needs
 * `settings.manage`. The logo is a validated raster image, scanned for malware, served with a fixed type and a locked-down policy.
 */
export function brandingRoutes(app: FastifyInstance, db: Db, kb: KnowledgeBase) {
  const manage = requireAuth(db, 'settings.manage');

  const publicBrand = async () => {
    const b = await loadBrand(db);
    const logo = await db.query(`SELECT extract(epoch FROM updated_at)::bigint AS v FROM branding_logo WHERE id = 1`);
    return { appName: b.appName, color: b.color, hasLogo: !!logo.rows[0], v: Number(logo.rows[0]?.v ?? 0) };
  };

  app.get('/branding', async (_req, reply) => reply.header('cache-control', 'no-cache').send(await publicBrand()));

  app.get('/branding/logo', async (_req, reply) => {
    const r = await db.query(`SELECT mime, data FROM branding_logo WHERE id = 1`);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', r.rows[0].mime).header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox").header('cache-control', 'public, max-age=300').send(r.rows[0].data);
  });

  app.put('/branding', { preHandler: manage }, async (req, reply) => {
    const b = brandSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query(`INSERT INTO settings (key, value) VALUES ('branding', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ ...b.data, color: b.data.color?.toLowerCase() ?? null })]);
    await audit(db, { actorId: req.user!.id, action: 'settings.branding', ip: req.ip, meta: { name: b.data.appName, color: b.data.color } });
    return publicBrand();
  });

  /** Validate, scan and store a logo from raw bytes. Returns an error code or null. */
  async function storeLogo(buf: Buffer, actorId: string, ip: string): Promise<{ status: number; error: string } | null> {
    if (buf.length > MAX_LOGO_BYTES) return { status: 413, error: 'too_large' };
    const mime = sniffImage(buf);
    if (!mime) return { status: 415, error: 'unsupported_logo_type' };
    const scan = await kb.scanBinary(buf);
    if (scan === 'infected') return { status: 422, error: 'file_infected' };
    if (scan === 'unavailable') return { status: 503, error: 'scan_unavailable' };
    await db.query(`INSERT INTO branding_logo (id, mime, data) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`, [mime, buf]);
    await audit(db, { actorId, action: 'settings.branding_logo', ip, meta: { mime, bytes: buf.length } });
    return null;
  }

  app.post('/branding/logo', { preHandler: manage, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_LOGO_BYTES + 1 } });
    if (!file) return reply.code(400).send({ error: 'bad_request' });
    let buf: Buffer;
    try { buf = await file.toBuffer(); } catch { return reply.code(413).send({ error: 'too_large' }); }
    if (file.file.truncated) return reply.code(413).send({ error: 'too_large' });
    const err = await storeLogo(buf, req.user!.id, req.ip);
    return err ? reply.code(err.status).send({ error: err.error }) : publicBrand();
  });

  app.delete('/branding/logo', { preHandler: manage }, async (req) => {
    await db.query(`DELETE FROM branding_logo WHERE id = 1`);
    await audit(db, { actorId: req.user!.id, action: 'settings.branding_logo_remove', ip: req.ip });
    return publicBrand();
  });

  const urlBody = z.object({ url: z.string().trim().min(4).max(500) });
  const failCode = (e: unknown) => (e instanceof FetchError ? e.message : 'fetch_failed');

  /** Colours (and possible logos) declared by a website or brand page, fetched with the same SSRF protection as the knowledge base. */
  app.post('/branding/extract', { preHandler: manage, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = urlBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const raw = /^https?:\/\//i.test(b.data.url) ? b.data.url : `https://${b.data.url}`;
    try {
      checkUrl(raw);
      const page = await safeGet(raw, { maxBytes: 1_500_000, allow: PAGE, accept: 'text/html,application/xhtml+xml' });
      const html = page.body.toString('utf8');
      const css: string[] = [];
      for (const u of stylesheetUrls(html, page.url)) {
        try { css.push((await safeGet(u, { maxBytes: 400_000, allow: CSS, accept: 'text/css' })).body.toString('utf8')); } catch { /* a stylesheet we cannot read is skipped */ }
      }
      let manifestColor: string | null = null;
      const mu = manifestUrl(html, page.url);
      if (mu) {
        try {
          const m = JSON.parse((await safeGet(mu, { maxBytes: 100_000, allow: JSONT, accept: 'application/manifest+json,application/json' })).body.toString('utf8')) as { theme_color?: unknown };
          if (typeof m.theme_color === 'string') manifestColor = m.theme_color;
        } catch { /* optional */ }
      }
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? null;
      await audit(db, { actorId: req.user!.id, action: 'settings.branding_extract', ip: req.ip, meta: { host: new URL(page.url).hostname } });
      return { url: page.url, title, colors: extractBrandColors(html, css, manifestColor), logos: extractLogoCandidates(html, page.url) };
    } catch (e) {
      return reply.code(422).send({ error: failCode(e) });
    }
  });

  /** Use an image found on a website as the logo (only PNG, JPEG or WebP; checked and scanned like an upload). */
  app.post('/branding/logo-from-url', { preHandler: manage, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = urlBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      const img = await safeGet(b.data.url, { maxBytes: MAX_LOGO_BYTES, allow: IMAGE, accept: 'image/png,image/jpeg,image/webp' });
      const err = await storeLogo(img.body, req.user!.id, req.ip);
      return err ? reply.code(err.status).send({ error: err.error }) : publicBrand();
    } catch (e) {
      return reply.code(422).send({ error: failCode(e) });
    }
  });
}
