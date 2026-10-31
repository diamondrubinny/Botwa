import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadAccessible } from '../access.js';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { ChannelManager } from '../channels/manager.js';
import type { Db } from '../db.js';
import type { MediaService } from '../media/store.js';
import { detect, sanitizeFileName } from '../media/validate.js';

const idParam = z.object({ id: z.string().uuid() });

export function mediaRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager, media: MediaService) {
  const any = requireAuth(db);

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

      let sent: { externalMessageId?: string };
      try {
        sent = await mgr.sendMedia(conv.channel_id, conv.external_id, { buffer: buf, mime: d.mime, fileName, caption: caption || undefined });
      } catch (e) {
        if ((e as Error).message === 'channel_not_connected') return reply.code(409).send({ error: 'channel_not_connected' });
        req.log.error({ err: e }, 'send media failed');
        return reply.code(502).send({ error: 'send_failed' });
      }
      const m = await db.query(
        `INSERT INTO messages (conversation_id, direction, body, external_id, sender_user_id) VALUES ($1,'out',$2,$3,$4) RETURNING id`,
        [conv.id, caption, sent.externalMessageId ?? null, req.user!.id],
      );
      await media.storeSent(m.rows[0].id, buf, d, fileName);
      await db.query(`UPDATE conversations SET last_message_at = now(), assigned_to = COALESCE(assigned_to, $2), bot_state = 'human' WHERE id = $1`, [conv.id, req.user!.id]);
      await audit(db, { actorId: req.user!.id, action: 'media.sent', target: conv.id, ip: req.ip, meta: { mime: d.mime, size: buf.length } });
      return reply.code(201).send({ id: m.rows[0].id });
    },
  );
}
