import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadAccessible, sendBlock, type AccessibleConversation } from '../access.js';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { ChannelManager } from '../channels/manager.js';
import { loadSending, PolicyRejected, SendError } from '../channels/sender.js';
import type { Db } from '../db.js';
import type { Config } from '../config.js';
import { gifSize, gifToMp4 } from '../media/animation.js';
import type { MediaService } from '../media/store.js';
import { detect, sanitizeFileName, type Detected } from '../media/validate.js';

const idParam = z.object({ id: z.string().uuid() });
export const MAX_GIF_BYTES = 5 * 1024 * 1024;
export const MAX_GIFS = 300;
const gifMeta = z.object({ title: z.string().trim().min(1).max(80), keywords: z.string().trim().max(300).default('') });
const sendGifBody = z.object({ gifId: z.string().uuid(), caption: z.string().trim().max(1000).optional() });

export function mediaRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager, media: MediaService, cfg: Config) {
  const any = requireAuth(db);
  const manageGifs = requireAuth(db, 'canned.manage');
  const images = { rateLimit: { max: 600, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => `gif:${r.ip}` } };
  const toMp4 = (gif: Buffer) => gifToMp4(gif, { ffmpegPath: cfg.FFMPEG_PATH, tmpDir: path.join(cfg.MEDIA_DIR, 'tmp') });

  /** Send an already validated and scanned file into a conversation, store it, and mark the conversation as handled by a person. */
  async function deliver(req: FastifyRequest, reply: FastifyReply, conv: AccessibleConversation,
    buf: Buffer, d: Detected, fileName: string, caption: string, animation?: Buffer | null, auditMeta: Record<string, unknown> = {}) {
    const blockedBy = await sendBlock(db, conv, (await loadSending(db)).replyWindowHours);
    if (blockedBy) return reply.code(409).send({ error: blockedBy });
    let sent: { externalMessageId?: string };
    try {
      sent = await mgr.sendMedia(conv.channel_id, conv.external_id, { buffer: buf, mime: d.mime, fileName, caption: caption || undefined, ...(animation ? { animation } : {}) });
    } catch (e) {
      const m = (e as Error).message;
      if (m === 'channel_not_connected' || m === 'media_unsupported' || m === 'gif_unsupported') return reply.code(409).send({ error: m });
      if (e instanceof SendError) return reply.code(429).send({ error: e.code });
      if (e instanceof PolicyRejected) return reply.code(409).send({ error: e.code });
      req.log.error({ err: e }, 'send media failed');
      return reply.code(502).send({ error: 'send_failed' });
    }
    const m = await db.query(
      `INSERT INTO messages (conversation_id, direction, body, external_id, sender_user_id) VALUES ($1,'out',$2,$3,$4) RETURNING id`,
      [conv.id, caption, sent.externalMessageId ?? null, req.user!.id],
    );
    await media.storeSent(m.rows[0].id, buf, d, fileName);
    await db.query(`UPDATE conversations SET last_message_at = now(), assigned_to = COALESCE(assigned_to, $2), bot_state = 'human' WHERE id = $1`, [conv.id, req.user!.id]);
    await audit(db, { actorId: req.user!.id, action: 'media.sent', target: conv.id, ip: req.ip, meta: { mime: d.mime, size: buf.length, ...auditMeta } });
    return reply.code(201).send({ id: m.rows[0].id });
  }

  // Download/preview. Only files that passed antivirus; same access rules as the conversation.
  app.get('/attachments/:id', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query(
      `SELECT a.mime, a.file_name, a.storage_name, a.status, m.conversation_id
         FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = $1`,
      [p.data.id],
    );
    const a = rows[0];
    if (!a || a.status !== 'clean' || !a.storage_name || !(await loadAccessible(db, req.user!, a.conversation_id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const inline = typeof a.mime === 'string' && a.mime.startsWith('image/');
    const name = encodeURIComponent(sanitizeFileName(a.file_name, 'file'));
    return reply
      .header('content-type', a.mime)
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, no-store')
      .send(createReadStream(media.cleanPath(a.storage_name)));
  });

  // Staff upload -> validate by content -> synchronous antivirus scan -> send -> store.
  app.post(
    '/conversations/:id/attachments',
    { preHandler: any, bodyLimit: media.maxBytes + 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: 'bad_request' });
      if (!media.enabled) return reply.code(503).send({ error: 'media_disabled' });
      const conv = await loadAccessible(db, req.user!, p.data.id);
      if (!conv) return reply.code(404).send({ error: 'not_found' });

      const part = await req.file({ limits: { fileSize: media.maxBytes, files: 1, fields: 4 } });
      if (!part) return reply.code(400).send({ error: 'bad_request' });
      let buf: Buffer;
      try {
        buf = await part.toBuffer();
      } catch {
        return reply.code(413).send({ error: 'file_too_large' });
      }
      if (part.file.truncated) return reply.code(413).send({ error: 'file_too_large' });
      const captionField = part.fields.caption as { value?: unknown } | undefined;
      const caption = typeof captionField?.value === 'string' ? captionField.value.trim().slice(0, 1000) : '';

      const d = await detect(buf);
      if (!d) return reply.code(415).send({ error: 'file_type_not_allowed' });
      const fileName = sanitizeFileName(part.filename, `file.${d.ext}`);

      const scan = await media.scanBuffer(buf);
      if (scan.status === 'infected') {
        await audit(db, { actorId: req.user!.id, action: 'media.upload_infected', target: conv.id, ip: req.ip, meta: { signature: scan.detail } });
        return reply.code(422).send({ error: 'file_infected' });
      }
      if (scan.status !== 'clean') return reply.code(503).send({ error: 'scanner_unavailable' });

      // a GIF also goes as a short video where the channel needs one to play it (WhatsApp)
      const animation = d.mime === 'image/gif' ? await toMp4(buf) : null;
      return deliver(req, reply, conv, buf, d, fileName, caption, animation);
    },
  );

  // ---- the GIF gallery: approved animations agents send in one click ----
  app.get('/gifs', { preHandler: any }, async (req) => {
    const q = typeof (req.query as { q?: unknown }).q === 'string' ? ((req.query as { q: string }).q).trim().slice(0, 60) : '';
    const { rows } = await db.query(
      `SELECT id, title, keywords, width, height, size, (mp4 IS NOT NULL) AS "hasVideo", created_at AS "createdAt"
         FROM gif_gallery
        WHERE $1 = '' OR title ILIKE '%' || $2 || '%' OR keywords ILIKE '%' || $2 || '%'
        ORDER BY created_at DESC LIMIT ${MAX_GIFS}`,
      [q, q.replace(/[\\%_]/g, (c) => `\\${c}`)],
    );
    return { gifs: rows, enabled: media.enabled, max: MAX_GIFS, maxBytes: MAX_GIF_BYTES };
  });

  app.get('/gifs/:id/file', { preHandler: any, config: images }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = (await db.query('SELECT gif AS data FROM gif_gallery WHERE id = $1', [p.data.id])).rows[0];
    if (!r?.data) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', 'image/gif').header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox").header('cache-control', 'private, max-age=86400').send(r.data);
  });

  app.post('/gifs', { preHandler: manageGifs, bodyLimit: MAX_GIF_BYTES + 64 * 1024, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const part = await req.file({ limits: { fileSize: MAX_GIF_BYTES, files: 1, fields: 4 } });
    if (!part) return reply.code(400).send({ error: 'bad_request' });
    let buf: Buffer;
    try { buf = await part.toBuffer(); } catch { return reply.code(413).send({ error: 'file_too_large' }); }
    if (part.file.truncated || buf.length > MAX_GIF_BYTES) return reply.code(413).send({ error: 'file_too_large' });
    const field = (n: string) => { const f = part.fields[n] as { value?: unknown } | undefined; return typeof f?.value === 'string' ? f.value : undefined; };
    const meta = gifMeta.safeParse({ title: field('title'), keywords: field('keywords') ?? '' });
    if (!meta.success) return reply.code(400).send({ error: 'gif_title_required' });
    const d = await detect(buf);
    const size = gifSize(buf);
    if (d?.mime !== 'image/gif' || !size || size.width < 1 || size.height < 1 || size.width > 2000 || size.height > 2000) return reply.code(415).send({ error: 'gif_only' });
    if ((await db.query('SELECT count(*)::int AS n FROM gif_gallery')).rows[0].n >= MAX_GIFS) return reply.code(409).send({ error: 'gallery_full' });
    const scan = await media.scanBuffer(buf);
    if (scan.status === 'infected') {
      await audit(db, { actorId: req.user!.id, action: 'gif.upload_infected', ip: req.ip, meta: { signature: scan.detail } });
      return reply.code(422).send({ error: 'file_infected' });
    }
    if (scan.status !== 'clean') return reply.code(503).send({ error: 'scanner_unavailable' });
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const mp4 = await toMp4(buf);
    const ins = await db.query(
      `INSERT INTO gif_gallery (title, keywords, gif, mp4, width, height, size, sha256, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (sha256) DO NOTHING RETURNING id`,
      [meta.data.title, meta.data.keywords, buf, mp4, size.width, size.height, buf.length, sha256, req.user!.id],
    );
    if (!ins.rows[0]) return reply.code(409).send({ error: 'gif_exists' });
    await audit(db, { actorId: req.user!.id, action: 'gif.add', target: ins.rows[0].id, ip: req.ip, meta: { bytes: buf.length, video: !!mp4 } });
    return reply.code(201).send({ id: ins.rows[0].id, hasVideo: !!mp4 });
  });

  app.patch('/gifs/:id', { preHandler: manageGifs }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = gifMeta.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!b.success) return reply.code(400).send({ error: 'gif_title_required' });
    const r = await db.query('UPDATE gif_gallery SET title = $2, keywords = $3 WHERE id = $1', [p.data.id, b.data.title, b.data.keywords]);
    if (r.rowCount !== 1) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'gif.edit', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.delete('/gifs/:id', { preHandler: manageGifs }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM gif_gallery WHERE id = $1', [p.data.id]);
    if (r.rowCount !== 1) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'gif.delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // Send a gallery GIF to the customer: same checks as any file (access, window, blocks, pause), nothing uploaded by the agent.
  app.post('/conversations/:id/gif', { preHandler: any, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = sendGifBody.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!media.enabled) return reply.code(503).send({ error: 'media_disabled' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    const g = (await db.query('SELECT id, title, gif, mp4 FROM gif_gallery WHERE id = $1', [b.data.gifId])).rows[0];
    if (!g) return reply.code(404).send({ error: 'gif_not_found' });
    const d = await detect(g.gif);
    if (d?.mime !== 'image/gif') return reply.code(404).send({ error: 'gif_not_found' });
    const fileName = sanitizeFileName(`${String(g.title).replace(/[\\/]+/g, '-')}.gif`, 'animation.gif');   // "נציג/ה" is a title, not a path
    return deliver(req, reply, conv, g.gif, d, fileName, b.data.caption ?? '', g.mp4, { gif: g.id });
  });
}
