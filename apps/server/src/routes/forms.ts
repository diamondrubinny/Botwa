import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isManager, loadAccessible, sendBlock } from '../access.js';
import { audit } from '../audit.js';
import { requireAuth, type AuthUser } from '../auth.js';
import type { ChannelManager } from '../channels/manager.js';
import { loadSending, PolicyRejected, SendError } from '../channels/sender.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { checkUrl, safeGet } from '../kb/fetch.js';
import type { MediaService } from '../media/store.js';
import { detect, sanitizeFileName } from '../media/validate.js';
import { can } from '../permissions.js';
import { loadBrand } from './branding.js';
import { AUDIENCES, fieldsSchema } from '../forms/schema.js';
import { remindBatch, startBatch } from '../forms/batch.js';
import { decrypt } from '../crypto.js';
import { byToken, createTemplate, decryptValues, event, getTemplate, keyOk, listTemplates, markOpened, sendOtp, sendRequest, sha256, signedPdf, submit, verifyOtp, type PublicReq } from '../forms/service.js';

const MAX_PDF = 10 * 1024 * 1024;
const idParam = z.object({ id: z.string().uuid() });
const asset = (name: string) => readFileSync(new URL(`../forms/assets/${name}`, import.meta.url));
const pdfHeaders = (reply: FastifyReply, name: string, inline = false) => reply
  .header('content-type', 'application/pdf').header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store')
  .header('content-security-policy', "default-src 'none'; sandbox")
  .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(sanitizeFileName(name, 'form.pdf'))}`);

/**
 * Digital forms. Staff: templates (forms.manage), sending a form from a conversation, the status of what was sent, the signed PDF.
 * Public (by the personal link only): the fill page, a one-time code to the same chat, submitting the values and the signature.
 */
export function formRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager, cfg: Config, media: MediaService) {
  const any = requireAuth(db);
  const manage = requireAuth(db, 'forms.manage');
  const canSeeAll = (u: AuthUser) => can(u, 'forms.manage') || isManager(u);

  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const converter = cfg.OFFICE_CONVERTER_URL.replace(/\/$/, '');
  /**
   * A form file from an upload or a link: checked by content and by the antivirus; a Word document is turned into a PDF by the
   * isolated converter (when it is installed). Returns the PDF to make the template from.
   */
  async function intake(buf: Buffer, name: string): Promise<{ ok: true; pdf: Buffer; name: string } | { ok: false; code: number; error: string }> {
    if (buf.length > MAX_PDF) return { ok: false, code: 413, error: 'file_too_large' };
    const d = await detect(buf);
    const word = d?.mime === DOCX;
    if (d?.mime !== 'application/pdf' && !word) return { ok: false, code: 415, error: /\.docx?$/i.test(name) ? 'word_old_format' : 'pdf_only' };
    if (word && !converter) return { ok: false, code: 415, error: 'word_needs_converter' };
    const scan = await media.scanBuffer(buf);
    if (scan.status === 'infected') return { ok: false, code: 422, error: 'file_infected' };
    if (scan.status !== 'clean') return { ok: false, code: 503, error: 'scanner_unavailable' };
    if (!word) return { ok: true, pdf: buf, name };
    try {
      const res = await fetch(`${converter}/convert`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(buf), signal: AbortSignal.timeout(120_000) });
      const pdf = Buffer.from(await res.arrayBuffer());
      if (!res.ok || pdf.subarray(0, 4).toString() !== '%PDF' || pdf.length > 4 * MAX_PDF) return { ok: false, code: 422, error: 'convert_failed' };
      return { ok: true, pdf, name: name.replace(/\.docx?$/i, '') + '.pdf' };
    } catch { return { ok: false, code: 503, error: 'converter_unavailable' }; }
  }
  const tplMeta = z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).default(''), audience: z.array(z.enum(AUDIENCES)).max(5).default([]) });

  // ---- templates ----
  /** Can Word files be used (the converter is installed and answering)? */
  app.get('/forms/converter', { preHandler: any }, async () => {
    if (!converter) return { word: false, installed: false };
    const ok = await fetch(`${converter}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
    return { word: ok, installed: true };
  });

  app.get('/forms/templates', { preHandler: any }, async () => (await listTemplates(db)).map((t) => ({ ...t, pages: t.pages.length })));
  app.get('/forms/templates/:id', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const t = p.success ? await getTemplate(db, p.data.id) : null;
    return t ?? reply.code(404).send({ error: 'not_found' });
  });
  app.get('/forms/templates/:id/source.pdf', { preHandler: any, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const r = p.success ? (await db.query('SELECT source_pdf, title FROM form_templates WHERE id = $1', [p.data.id])).rows[0] : null;
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return pdfHeaders(reply, `${r.title}.pdf`, true).send(r.source_pdf);
  });

  app.post('/forms/templates', { preHandler: manage, bodyLimit: MAX_PDF + 64 * 1024, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const part = await req.file({ limits: { fileSize: MAX_PDF, files: 1, fields: 6 } });
    if (!part) return reply.code(400).send({ error: 'bad_request' });
    let buf: Buffer;
    try { buf = await part.toBuffer(); } catch { return reply.code(413).send({ error: 'file_too_large' }); }
    if (part.file.truncated) return reply.code(413).send({ error: 'file_too_large' });
    const f = (k: string) => (part.fields[k] as { value?: unknown } | undefined)?.value;
    const meta = tplMeta.safeParse({ title: f('title') || sanitizeFileName(part.filename, 'טופס').replace(/\.pdf$/i, ''), description: f('description') ?? '', audience: typeof f('audience') === 'string' && f('audience') ? String(f('audience')).split(',') : [] });
    if (!meta.success) return reply.code(400).send({ error: 'bad_request' });
    const ok = await intake(buf, part.filename);
    if (!ok.ok) return reply.code(ok.code).send({ error: ok.error });
    try {
      const t = await createTemplate(db, { ...meta.data, title: meta.data.title.replace(/\.docx?$/i, ''), pdf: ok.pdf, sourceName: sanitizeFileName(ok.name, 'form.pdf'), userId: req.user!.id });
      await audit(db, { actorId: req.user!.id, action: 'forms.template_create', target: t.id, ip: req.ip, meta: { title: t.title, fields: t.fields.length } });
      return reply.code(201).send(t);
    } catch (e) { return reply.code(422).send({ error: (e as Error).message === 'too_many_pages' ? 'too_many_pages' : 'pdf_unreadable' }); }
  });

  /** The forms (PDF, and Word for later) linked from a page, e.g. a safety unit's "forms" page, to pick from. */
  app.get('/forms/discover', { preHandler: manage, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const q = z.object({ url: z.string().url().max(2000) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      const page = await safeGet(q.data.url, { maxBytes: 3 * 1024 * 1024, accept: 'text/html' });
      const html = page.body.toString('utf8');
      const out: { url: string; title: string; kind: 'pdf' | 'word' }[] = [];
      const seen = new Set<string>();
      for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        let u: URL;
        try { u = new URL(m[1]!.replace(/&amp;/g, '&'), page.url); } catch { continue; }
        const kind = /\.pdf$/i.test(u.pathname) ? 'pdf' : /\.docx?$/i.test(u.pathname) ? 'word' : null;
        if (!kind || seen.has(u.href)) continue;
        seen.add(u.href);
        const text = m[2]!.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
        const title = (text && !/^(קישור לטופס|לחצו כאן|כאן|link|download)$/i.test(text) ? text : decodeURIComponent(u.pathname.split('/').pop() ?? '').replace(/\.(pdf|docx?)$/i, '').replace(/[-_]+/g, ' ')).slice(0, 120);
        out.push({ url: u.href, title, kind });
        if (out.length >= 100) break;
      }
      const existing = new Set((await db.query('SELECT source_url FROM form_templates WHERE source_url IS NOT NULL')).rows.map((r) => r.source_url as string));
      return { page: page.url, forms: out.map((f) => ({ ...f, imported: existing.has(f.url) })) };
    } catch { return reply.code(422).send({ error: 'fetch_failed' }); }
  });

  app.post('/forms/templates/import', { preHandler: manage, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = z.object({ url: z.string().url().max(2000) }).merge(tplMeta).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    let got;
    try { checkUrl(b.data.url); got = await safeGet(b.data.url, { maxBytes: MAX_PDF, accept: 'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.1' }); } catch { return reply.code(422).send({ error: 'fetch_failed' }); }
    const ok = await intake(got.body, new URL(got.url).pathname);
    if (!ok.ok) return reply.code(ok.code).send({ error: ok.error });
    try {
      const t = await createTemplate(db, { title: b.data.title, description: b.data.description, audience: b.data.audience, pdf: ok.pdf, sourceName: decodeURIComponent(ok.name.split('/').pop() ?? 'form.pdf'), sourceUrl: b.data.url, userId: req.user!.id });
      await audit(db, { actorId: req.user!.id, action: 'forms.template_create', target: t.id, ip: req.ip, meta: { title: t.title, from: b.data.url } });
      return reply.code(201).send(t);
    } catch (e) { return reply.code(422).send({ error: (e as Error).message === 'too_many_pages' ? 'too_many_pages' : 'pdf_unreadable' }); }
  });

  app.patch('/forms/templates/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = tplMeta.partial().extend({ fields: fieldsSchema.optional(), active: z.boolean().optional() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request', detail: b.success ? undefined : b.error.issues[0]?.message });
    const t = await getTemplate(db, p.data.id);
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (b.data.fields && b.data.fields.some((f) => f.page >= t.pages.length)) return reply.code(400).send({ error: 'bad_request', detail: 'page' });
    await db.query(`UPDATE form_templates SET title = COALESCE($2, title), description = COALESCE($3, description), audience = COALESCE($4, audience), fields = COALESCE($5, fields), active = COALESCE($6, active), updated_at = now() WHERE id = $1`,
      [t.id, b.data.title ?? null, b.data.description ?? null, b.data.audience ?? null, b.data.fields ? JSON.stringify(b.data.fields) : null, b.data.active ?? null]);
    await audit(db, { actorId: req.user!.id, action: 'forms.template_update', target: t.id, ip: req.ip, meta: { fields: b.data.fields?.length, active: b.data.active } });
    return getTemplate(db, t.id);
  });

  app.delete('/forms/templates/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    // a template that was sent stays (the signed forms point to it); it can be switched off instead
    const used = (await db.query('SELECT 1 FROM form_requests WHERE template_id = $1 LIMIT 1', [p.data.id])).rowCount;
    if (used) return reply.code(409).send({ error: 'template_in_use' });
    const r = await db.query('DELETE FROM form_templates WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'forms.template_delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // ---- one form to a group (employees, contractors) ----
  app.post('/forms/templates/:id/batch', { preHandler: manage, bodyLimit: 256 * 1024, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({
      channelId: z.string().uuid(), days: z.number().int().min(1).max(60).default(14), note: z.string().max(300).optional(),
      people: z.array(z.object({ name: z.string().trim().max(100).default(''), phone: z.string().trim().min(6).max(30) })).min(1).max(500),
      waTemplate: z.object({ name: z.string().min(1).max(512), language: z.string().min(2).max(15) }).nullish(),
    }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      const r = await startBatch(db, cfg, mgr, { templateId: p.data.id, channelId: b.data.channelId, userId: req.user!.id, days: b.data.days, note: b.data.note, people: b.data.people, waTemplate: b.data.waTemplate ?? null });
      await audit(db, { actorId: req.user!.id, action: 'forms.batch', target: r.batchId, ip: req.ip, meta: { template: p.data.id, total: r.total, invalid: r.invalid.length } });
      return reply.code(201).send(r);
    } catch (e) {
      const m = (e as Error).message;
      if (['template_not_found', 'template_has_no_fields', 'channel_not_found', 'channel_type_unsupported', 'template_needs_official', 'no_valid_people'].includes(m)) return reply.code(409).send({ error: m });
      throw e;
    }
  });

  app.get('/forms/batches', { preHandler: manage }, async () => (await db.query(
    `SELECT b.id, b.title, b.total, b.done, b.created_at AS "createdAt", ch.label AS "channelLabel", COALESCE(u.name_he, u.name) AS "createdBy",
            count(r.id) FILTER (WHERE r.status = 'signed')::int AS signed,
            count(r.id) FILTER (WHERE r.delivery IN ('sent','template'))::int AS delivered,
            count(r.id) FILTER (WHERE r.delivery = 'link_only')::int AS "linkOnly",
            count(r.id) FILTER (WHERE r.delivery = 'failed')::int AS failed,
            count(r.id) FILTER (WHERE r.delivery = 'queued')::int AS queued
       FROM form_batches b LEFT JOIN form_requests r ON r.batch_id = b.id LEFT JOIN channels ch ON ch.id = b.channel_id LEFT JOIN users u ON u.id = b.created_by
      GROUP BY b.id, ch.label, u.name_he, u.name ORDER BY b.created_at DESC LIMIT 100`)).rows);

  app.get('/forms/batches/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const rows = (await db.query(`SELECT r.id, r.number, r.signer_name AS "signerName", r.signer_phone AS "signerPhone", r.status, r.delivery, r.delivery_detail AS "deliveryDetail",
        r.signed_at AS "signedAt", r.expires_at AS "expiresAt", r.reminded_at AS "remindedAt", r.link_enc FROM form_requests r WHERE r.batch_id = $1 ORDER BY r.number`, [p.data.id])).rows;
    if (!rows.length) return reply.code(404).send({ error: 'not_found' });
    // the personal links, so the staff can pass on those that could not be sent (forms managers only)
    return rows.map(({ link_enc, ...r }) => ({ ...r, number: Number(r.number), link: link_enc && ['sent', 'opened', 'verified'].includes(r.status) ? decrypt(link_enc, cfg.ENCRYPTION_KEY) : null }));
  });

  app.post('/forms/batches/:id/remind', { preHandler: manage, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      const r = await remindBatch(db, cfg, mgr, p.data.id, req.user!.id);
      await audit(db, { actorId: req.user!.id, action: 'forms.remind', target: p.data.id, ip: req.ip, meta: r });
      return r;
    } catch (e) { if ((e as Error).message === 'not_found') return reply.code(404).send({ error: 'not_found' }); throw e; }
  });

  // ---- sending from a conversation ----
  app.post('/conversations/:id/forms', { preHandler: any, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ templateId: z.string().uuid(), days: z.number().int().min(1).max(60).default(7), values: z.record(z.string(), z.string().max(300)).default({}), note: z.string().max(300).optional() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    if (/@(fb|ig)comment$/.test(conv.external_id)) return reply.code(409).send({ error: 'comment_thread' });   // never a personal link in public
    const blockedBy = await sendBlock(db, conv, (await loadSending(db)).replyWindowHours);
    if (blockedBy) return reply.code(409).send({ error: blockedBy });
    try {
      const r = await sendRequest(db, cfg, mgr, { templateId: b.data.templateId, conversationId: conv.id, userId: req.user!.id, days: b.data.days, values: b.data.values, note: b.data.note });
      await audit(db, { actorId: req.user!.id, action: 'forms.send', target: r.id, ip: req.ip, meta: { conversation: conv.id, template: b.data.templateId } });
      return reply.code(201).send({ id: r.id, number: r.number });
    } catch (e) {
      const m = (e as Error).message;
      if (m === 'template_not_found' || m === 'template_has_no_fields' || m === 'not_found') return reply.code(409).send({ error: m });
      if (m === 'channel_not_connected') return reply.code(409).send({ error: m });
      if (e instanceof SendError) return reply.code(429).send({ error: e.code });
      if (e instanceof PolicyRejected) return reply.code(409).send({ error: e.code });
      req.log.error({ err: e }, 'form send failed');
      return reply.code(502).send({ error: 'send_failed' });
    }
  });

  const REQ = `r.id, r.number, r.status, r.created_at AS "createdAt", r.expires_at AS "expiresAt", r.signed_at AS "signedAt", r.signer_name AS "signerName", r.signer_phone AS "signerPhone",
    r.conversation_id AS "conversationId", t.title, t.id AS "templateId", COALESCE(u.name_he, u.name) AS "sentBy", s.sha256`;
  const REQ_FROM = `FROM form_requests r JOIN form_templates t ON t.id = r.template_id LEFT JOIN users u ON u.id = r.sent_by LEFT JOIN form_submissions s ON s.request_id = r.id
    LEFT JOIN conversations c ON c.id = r.conversation_id`;
  // who may see a request: forms managers and inbox managers all; others those of conversations they hold or that are unassigned, or that they sent
  const VISIBLE = `($2::boolean OR r.sent_by = $3 OR c.assigned_to = $3 OR (c.id IS NOT NULL AND c.assigned_to IS NULL))`;

  app.get('/conversations/:id/forms', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    return (await db.query(`SELECT ${REQ} ${REQ_FROM} WHERE r.conversation_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [p.data.id])).rows.map((r) => ({ ...r, number: Number(r.number) }));
  });

  app.get('/forms/requests', { preHandler: any }, async (req, reply) => {
    const q = z.object({ batchId: z.string().uuid().optional(), templateId: z.string().uuid().optional(), status: z.enum(['sent', 'opened', 'verified', 'signed', 'expired', 'cancelled']).optional(), q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const like = q.data.q ? `%${q.data.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = (await db.query(
      `SELECT ${REQ} ${REQ_FROM} WHERE ${VISIBLE} AND ($1::uuid IS NULL OR r.template_id = $1) AND ($4::text IS NULL OR r.status = $4)
         AND ($5::text IS NULL OR r.signer_name ILIKE $5 OR r.signer_phone ILIKE $5 OR t.title ILIKE $5 OR r.number::text = $6)
         AND ($9::uuid IS NULL OR r.batch_id = $9)
       ORDER BY r.created_at DESC LIMIT $7 OFFSET $8`,
      [q.data.templateId ?? null, canSeeAll(req.user!), req.user!.id, q.data.status ?? null, like, q.data.q ?? '', q.data.limit, q.data.offset, q.data.batchId ?? null])).rows;
    return rows.map((r) => ({ ...r, number: Number(r.number) }));
  });

  async function visibleRequest(req: FastifyRequest, id: string): Promise<boolean> {
    return !!(await db.query(`SELECT 1 ${REQ_FROM} WHERE r.id = $1 AND ${VISIBLE}`, [id, canSeeAll(req.user!), req.user!.id])).rowCount;
  }

  app.get('/forms/requests/:id', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || !(await visibleRequest(req, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const r = (await db.query(`SELECT ${REQ}, s.values_enc, r.fields ${REQ_FROM} WHERE r.id = $1`, [p.data.id])).rows[0];
    const events = (await db.query('SELECT kind, detail, at FROM form_events WHERE request_id = $1 ORDER BY id', [p.data.id])).rows;
    const values = r.values_enc ? (decryptValues(r.values_enc, cfg) as { values: Record<string, unknown> }).values : null;
    return { ...r, values_enc: undefined, number: Number(r.number), values, events };
  });

  app.get('/forms/requests/:id/signed.pdf', { preHandler: any, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || !(await visibleRequest(req, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const s = await signedPdf(db, cfg, p.data.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'forms.download', target: p.data.id, ip: req.ip });
    return pdfHeaders(reply, `${s.title} - ${s.number}.pdf`).send(s.pdf);
  });

  app.post('/forms/requests/:id/cancel', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || !(await visibleRequest(req, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const r = await db.query(`UPDATE form_requests SET status = 'cancelled', fill_key_hash = NULL, otp_hash = NULL WHERE id = $1 AND status IN ('sent','opened','verified') RETURNING id`, [p.data.id]);
    if (!r.rowCount) return reply.code(409).send({ error: 'not_cancellable' });
    await event(db, p.data.id, 'cancelled');
    await audit(db, { actorId: req.user!.id, action: 'forms.cancel', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  /** Is this file the very PDF we produced? (compares its SHA-256 with the stored ones) */
  app.post('/forms/verify', { preHandler: any, bodyLimit: 30 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const part = await req.file({ limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
    if (!part) return reply.code(400).send({ error: 'bad_request' });
    let buf: Buffer;
    try { buf = await part.toBuffer(); } catch { return reply.code(413).send({ error: 'file_too_large' }); }
    const hash = sha256(buf);
    const r = (await db.query(`SELECT r.id, r.number, t.title, r.signer_name AS "signerName", s.signed_at AS "signedAt" FROM form_submissions s JOIN form_requests r ON r.id = s.request_id JOIN form_templates t ON t.id = r.template_id WHERE s.sha256 = $1`, [hash])).rows[0];
    return r ? { match: true, sha256: hash, ...r, number: Number(r.number) } : { match: false, sha256: hash };
  });

  // ---- the public side: only the personal link ----
  const files = { html: asset('fill.html'), js: asset('fill.js'), css: asset('fill.css') };
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  app.get('/f/assets/fill.js', async (_req, reply) => reply.header('content-type', 'text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(files.js));
  app.get('/f/assets/fill.css', async (_req, reply) => reply.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'no-cache').send(files.css));
  const pub = (max: number) => ({ config: { rateLimit: { max, timeWindow: '10 minutes' } } });
  const tokenOf = (req: FastifyRequest) => (req.params as { token?: string }).token ?? '';
  const live = (r: PublicReq | null): r is PublicReq => !!r;

  app.get('/f/:token', pub(120), async (req, reply) => {
    reply.header('content-security-policy', csp).header('referrer-policy', 'no-referrer').header('x-robots-tag', 'noindex, nofollow')
      .header('cache-control', 'no-store').header('content-type', 'text/html; charset=utf-8');
    return reply.send(files.html);
  });

  app.get('/f/:token/info', pub(120), async (req, reply) => {
    const r = await byToken(db, tokenOf(req));
    if (!live(r)) return reply.code(404).send({ error: 'not_found' });
    reply.header('cache-control', 'no-store');
    if (r.status === 'sent') { await markOpened(db, r); r.status = 'opened'; }
    const brand = await loadBrand(db).catch(() => ({ appName: '' }));
    const phone = r.external_id && /^\d{8,15}/.test(r.external_id) ? `${'•'.repeat(Math.max(0, r.external_id.split('@')[0]!.length - 3))}${r.external_id.split('@')[0]!.slice(-3)}` : null;
    return {
      title: r.title, description: r.description, status: r.status, number: r.number, expiresAt: r.expires_at, org: brand.appName,
      pages: (await db.query('SELECT jsonb_array_length(pages) AS n FROM form_templates WHERE id = $1', [r.template_id])).rows[0]?.n ?? 0,
      // the fields as the signer sees them (no positions on the page are needed for filling)
      fields: r.fields.map((f) => ({ id: f.id, type: f.type, label: f.label, required: f.required, locked: f.locked && r.prefill[f.id] !== undefined, hint: f.hint, page: f.page })),
      prefill: r.prefill, signerName: r.signer_name, phoneHint: phone, verified: !!r.verified_at && r.status === 'verified',
    };
  });

  app.get('/f/:token/document.pdf', pub(60), async (req, reply) => {
    const r = await byToken(db, tokenOf(req));
    if (!live(r) || r.status === 'cancelled') return reply.code(404).send({ error: 'not_found' });
    const src = (await db.query('SELECT source_pdf FROM form_templates WHERE id = $1', [r.template_id])).rows[0]?.source_pdf;
    if (!src) return reply.code(404).send({ error: 'not_found' });
    return pdfHeaders(reply, `${r.title}.pdf`, true).send(src);
  });

  app.post('/f/:token/otp', pub(10), async (req, reply) => {
    const r = await byToken(db, tokenOf(req));
    if (!live(r)) return reply.code(404).send({ error: 'not_found' });
    if (!['sent', 'opened', 'verified'].includes(r.status)) return reply.code(409).send({ error: r.status });
    try {
      const out = await sendOtp(db, mgr, r);
      if (out !== 'sent') return reply.code(out === 'no_channel' ? 409 : 429).send({ error: out });
      return { ok: true };
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'form otp send failed');
      return reply.code(502).send({ error: 'otp_send_failed' });
    }
  });

  app.post('/f/:token/verify', pub(20), async (req, reply) => {
    const b = z.object({ code: z.string().max(12) }).safeParse(req.body);
    const r = await byToken(db, tokenOf(req));
    if (!live(r)) return reply.code(404).send({ error: 'not_found' });
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!['sent', 'opened', 'verified'].includes(r.status)) return reply.code(409).send({ error: r.status });
    const v = await verifyOtp(db, r, b.data.code);
    return v.ok ? { ok: true, key: v.key } : reply.code(v.reason === 'too_many' ? 429 : 400).send({ error: `otp_${v.reason}` });
  });

  app.post('/f/:token/submit', { bodyLimit: 1024 * 1024, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = z.object({ key: z.string().max(64), consent: z.literal(true), values: z.record(z.string(), z.union([z.string().max(2100), z.boolean(), z.null()])), marks: z.record(z.string(), z.object({ png: z.string().max(420_000).optional(), typed: z.string().max(100).optional() })).default({}) }).safeParse(req.body);
    const r = await byToken(db, tokenOf(req));
    if (!live(r)) return reply.code(404).send({ error: 'not_found' });
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (r.status === 'signed') return reply.code(409).send({ error: 'signed' });
    if (!['opened', 'verified', 'sent'].includes(r.status)) return reply.code(409).send({ error: r.status });
    if (!keyOk(r, b.data.key)) return reply.code(401).send({ error: 'not_verified' });
    const brand = await loadBrand(db).catch(() => ({ appName: '' }));
    const res = await submit(db, cfg, r, { values: b.data.values, marks: b.data.marks, ip: req.ip ?? null, ua: (req.headers['user-agent'] as string | undefined) ?? null, org: brand.appName || 'Botwa' });
    if (!res.ok) return reply.code(422).send({ error: 'invalid', fields: res.errors });
    // a copy back to the same chat, and a note for the team
    if (r.conversation_id && r.channel_id && r.external_id) {
      const name = `${r.title} - חתום.pdf`;
      void (async () => {
        try {
          // the website chat has no file sending: the copy is kept in the conversation (the visitor downloaded it on the page)
          const webchat = (await db.query('SELECT type FROM channels WHERE id = $1', [r.channel_id])).rows[0]?.type === 'webchat';
          const sent = webchat ? {} as { externalMessageId?: string } : await mgr.sendMedia(r.channel_id!, r.external_id!, { buffer: res.pdf, mime: 'application/pdf', fileName: name, caption: `עותק חתום של "${r.title}". תודה!` });
          const m = await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto) VALUES ($1,'out',$2,$3,true) RETURNING id`, [r.conversation_id, `עותק חתום של "${r.title}". תודה!`, sent.externalMessageId ?? null]);
          await media.storeSent(m.rows[0].id, res.pdf, { mime: 'application/pdf', ext: 'pdf', kind: 'document', inline: false }, name);
          mgr.notifyMessage(r.channel_id!, r.conversation_id!, m.rows[0].id);
          await event(db, r.id, 'copy_sent');
        } catch (e) { await event(db, r.id, 'copy_failed', (e as Error).message.slice(0, 120)); }
      })();
      await db.query('INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)', [r.conversation_id, `✍️ הטופס "${r.title}" (בקשה ${r.number}) נחתם. אפשר להוריד אותו מ"טפסים" או מפרטי השיחה.`]).catch(() => undefined);
    }
    return { ok: true, sha256: res.sha256 };
  });

  app.post('/f/:token/signed.pdf', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    // right after signing, the signer downloads their copy with the token (the fill key is gone by then): only within 30 minutes
    const r = await byToken(db, tokenOf(req));
    if (!live(r) || r.status !== 'signed') return reply.code(404).send({ error: 'not_found' });
    const at = (await db.query('SELECT signed_at FROM form_submissions WHERE request_id = $1', [r.id])).rows[0]?.signed_at as Date | undefined;
    if (!at || Date.now() - at.getTime() > 30 * 60_000) return reply.code(410).send({ error: 'download_window_closed' });
    const s = await signedPdf(db, cfg, r.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    return pdfHeaders(reply, `${s.title} - חתום.pdf`).send(s.pdf);
  });
}
