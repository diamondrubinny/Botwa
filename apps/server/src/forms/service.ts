import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import type { Db } from '../db.js';
import { detectFields } from './detect.js';
import { buildSignedPdf, type SignatureMark } from './pdf.js';
import { checkValue, fieldsSchema, type Field } from './schema.js';

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const tokenHash = (t: string) => sha256(`form:${t}`);

/** Binary AES-256-GCM with the system key: 'B1' | iv(12) | tag(16) | ciphertext. */
export function encryptBytes(buf: Buffer, keyB64: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('B1'), iv, c.getAuthTag(), ct]);
}
export function decryptBytes(buf: Buffer, keyB64: string): Buffer {
  if (buf.subarray(0, 2).toString() !== 'B1') throw new Error('bad_ciphertext');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), buf.subarray(2, 14));
  d.setAuthTag(buf.subarray(14, 30));
  return Buffer.concat([d.update(buf.subarray(30)), d.final()]);
}

export interface TemplateRow { id: string; title: string; description: string; audience: string[]; sourceName: string; sourceUrl: string | null; sha256: string; pages: { w: number; h: number }[]; fields: Field[]; active: boolean; createdAt: string; updatedAt: string; requests?: number; signed?: number }
const TPL = `t.id, t.title, t.description, t.audience, t.source_name AS "sourceName", t.source_url AS "sourceUrl", t.sha256, t.pages, t.fields, t.active,
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`;

/** A new template from a (clean, checked) PDF: its pages, and fields suggested from the labels printed on it. */
export async function createTemplate(db: Db, a: { title: string; description?: string; audience?: string[]; pdf: Buffer; sourceName: string; sourceUrl?: string | null; userId: string }): Promise<TemplateRow> {
  const d = await detectFields(a.pdf);
  if (!d.pages.length) throw new Error('pdf_unreadable');
  const fields: Field[] = d.suggestions.map((s, i) => ({ id: `f${i + 1}`, type: s.type as Field['type'], label: s.label, page: s.page, x: s.x, y: s.y, w: s.w, h: s.h, required: s.type === 'signature', prefill: null, locked: false, hint: '' }));
  const r = await db.query(
    `INSERT INTO form_templates (title, description, audience, source_pdf, source_name, source_url, sha256, pages, fields, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${TPL.replace(/t\./g, '')}`,
    [a.title, a.description ?? '', a.audience ?? [], a.pdf, a.sourceName.slice(0, 200), a.sourceUrl ?? null, sha256(a.pdf), JSON.stringify(d.pages), JSON.stringify(fieldsSchema.parse(fields)), a.userId]);
  return r.rows[0];
}

export async function listTemplates(db: Db): Promise<TemplateRow[]> {
  return (await db.query(`SELECT ${TPL}, (SELECT count(*)::int FROM form_requests r WHERE r.template_id = t.id) AS requests,
    (SELECT count(*)::int FROM form_requests r WHERE r.template_id = t.id AND r.status = 'signed') AS signed FROM form_templates t ORDER BY t.active DESC, t.title`)).rows;
}
export async function getTemplate(db: Db, id: string): Promise<TemplateRow | null> {
  return (await db.query(`SELECT ${TPL} FROM form_templates t WHERE t.id = $1`, [id])).rows[0] ?? null;
}

// ---- sending -------------------------------------------------------------------------------------------------------
export interface Sender { sendText(channelId: string, ext: string, text: string, opts?: { background?: boolean }): Promise<{ externalMessageId?: string }>; notifyMessage(channelId: string, conversationId: string, messageId: string): void }
interface ConvInfo { id: string; channel_id: string; external_id: string; display_name: string | null; case_number: number | null }

export function publicUrl(cfg: Config, token: string): string {
  return `${cfg.APP_ORIGIN.split(',')[0]!.trim().replace(/\/$/, '')}/f/${token}`;
}
const dateHe = (d: Date) => d.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: 'numeric' });

/** Values the system fills when sending: the customer's name and phone, today, the sender, the inquiry number. */
async function prefillValues(db: Db, fields: Field[], conv: ConvInfo, userId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const me = (await db.query('SELECT COALESCE(name_he, name) AS n FROM users WHERE id = $1', [userId])).rows[0]?.n as string | undefined;
  const phone = /^\d{8,15}(@s\.whatsapp\.net)?$/.test(conv.external_id) ? conv.external_id.split('@')[0]! : '';
  for (const f of fields) {
    const v = f.prefill === 'contact_name' ? conv.display_name ?? '' : f.prefill === 'contact_phone' ? phone : f.prefill === 'today' ? new Date().toISOString().slice(0, 10)
      : f.prefill === 'agent_name' ? me ?? '' : f.prefill === 'case_number' ? (conv.case_number ? String(conv.case_number) : '') : '';
    if (v) out[f.id] = v;
  }
  return out;
}

/** The message that carries a personal link. */
export function linkMessage(name: string | null, title: string, url: string, expires: Date, note?: string): string {
  return [`${name ? `שלום ${name}, ` : 'שלום, '}נשלח אליך הטופס "${title}" למילוי וחתימה דיגיטלית:`, url,
    `הקישור אישי ובתוקף עד ${dateHe(expires)}. לפני החתימה יישלח לכאן קוד אימות.`, note?.trim() ?? ''].filter(Boolean).join('\n');
}

/** A request for one conversation, without sending anything (group sending decides how each one is delivered). */
export async function createRequest(db: Db, cfg: Config, a: { templateId: string; conversationId: string; userId: string; days: number; values?: Record<string, string>; batchId?: string | null; keepLink?: boolean }): Promise<{ id: string; number: number; url: string; expires: Date; title: string; conv: ConvInfo }> {
  const t = await getTemplate(db, a.templateId);
  if (!t || !t.active) throw new Error('template_not_found');
  if (!t.fields.length) throw new Error('template_has_no_fields');
  const conv = (await db.query(
    `SELECT c.id, c.channel_id, ct.external_id, ct.display_name, (SELECT number FROM cases k WHERE k.conversation_id = c.id ORDER BY opened_at DESC LIMIT 1) AS case_number
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`, [a.conversationId])).rows[0] as ConvInfo | undefined;
  if (!conv) throw new Error('not_found');
  const pre = { ...(await prefillValues(db, t.fields, conv, a.userId)), ...Object.fromEntries(Object.entries(a.values ?? {}).filter(([k, v]) => t.fields.some((f) => f.id === k) && typeof v === 'string' && v.length <= 300)) };
  const token = `f_${randomBytes(24).toString('base64url')}`;
  const expires = new Date(Date.now() + a.days * 86_400_000);
  const url = publicUrl(cfg, token);
  const r = (await db.query(
    `INSERT INTO form_requests (template_id, template_sha256, fields, conversation_id, signer_name, signer_phone, token_hash, prefill, expires_at, sent_by, batch_id, link_enc, delivery)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, number`,
    [t.id, t.sha256, JSON.stringify(t.fields), conv.id, conv.display_name, conv.external_id.split('@')[0], tokenHash(token), JSON.stringify(pre), expires, a.userId, a.batchId ?? null,
      a.keepLink ? encrypt(url, cfg.ENCRYPTION_KEY) : null, a.batchId ? 'queued' : null])).rows[0];
  return { id: r.id, number: Number(r.number), url, expires, title: t.title, conv };
}

/** Creates a request for one conversation and sends its personal link there. Returns the request (and the link, for the panel). */
export async function sendRequest(db: Db, cfg: Config, out: Sender, a: { templateId: string; conversationId: string; userId: string; days: number; values?: Record<string, string>; batchId?: string | null; note?: string }): Promise<{ id: string; number: number; url: string; messageId: string }> {
  const r = await createRequest(db, cfg, a);
  const text = linkMessage(r.conv.display_name, r.title, r.url, r.expires, a.note);
  let sent: { externalMessageId?: string };
  try { sent = await out.sendText(r.conv.channel_id, r.conv.external_id, text); } catch (e) {
    await db.query('DELETE FROM form_requests WHERE id = $1', [r.id]);
    throw e;
  }
  const m = await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, sender_user_id) VALUES ($1,'out',$2,$3,$4) RETURNING id`, [r.conv.id, text, sent.externalMessageId ?? null, a.userId]);
  await db.query(`UPDATE conversations SET last_message_at = now(), assigned_to = COALESCE(assigned_to, $2), bot_state = 'human' WHERE id = $1`, [r.conv.id, a.userId]);
  await event(db, r.id, 'sent', `נשלח ע"י משתמש, בתוקף עד ${dateHe(r.expires)}`);
  out.notifyMessage(r.conv.channel_id, r.conv.id, m.rows[0].id);
  return { id: r.id, number: r.number, url: r.url, messageId: m.rows[0].id };
}

export async function event(db: Db, requestId: string, kind: string, detail?: string): Promise<void> {
  await db.query('INSERT INTO form_events (request_id, kind, detail) VALUES ($1,$2,$3)', [requestId, kind, detail ?? null]);
}

// ---- the signer's side (public, by token) ------------------------------------------------------------------------
export interface PublicReq { id: string; number: number; status: string; expires_at: Date; title: string; description: string; fields: Field[]; prefill: Record<string, string>; template_id: string; template_sha256: string;
  conversation_id: string | null; channel_id: string | null; external_id: string | null; signer_name: string | null; signer_phone: string | null; otp_hash: string | null; otp_expires_at: Date | null; otp_tries: number; otp_sent: number;
  fill_key_hash: string | null; verified_at: Date | null; last_otp_at: Date | null }

export async function byToken(db: Db, token: string): Promise<PublicReq | null> {
  if (!/^f_[\w-]{20,60}$/.test(token)) return null;
  const r = (await db.query(
    `SELECT r.id, r.number, r.status, r.expires_at, t.title, t.description, r.fields, r.prefill, r.template_id, r.template_sha256, r.conversation_id, c.channel_id, ct.external_id,
            r.signer_name, r.signer_phone, r.otp_hash, r.otp_expires_at, r.otp_tries, r.otp_sent, r.fill_key_hash, r.verified_at,
            (SELECT max(at) FROM form_events e WHERE e.request_id = r.id AND e.kind = 'otp_sent') AS last_otp_at
       FROM form_requests r JOIN form_templates t ON t.id = r.template_id
       LEFT JOIN conversations c ON c.id = r.conversation_id LEFT JOIN contacts ct ON ct.id = c.contact_id
      WHERE r.token_hash = $1`, [tokenHash(token)])).rows[0] as PublicReq | undefined;
  if (!r) return null;
  r.number = Number(r.number);
  if (r.status !== 'signed' && r.status !== 'cancelled' && r.expires_at.getTime() < Date.now()) {
    if (r.status !== 'expired') { await db.query(`UPDATE form_requests SET status = 'expired' WHERE id = $1`, [r.id]); await event(db, r.id, 'expired'); }
    r.status = 'expired';
  }
  return r;
}

export async function markOpened(db: Db, r: PublicReq): Promise<void> {
  if (r.status === 'sent') { await db.query(`UPDATE form_requests SET status = 'opened' WHERE id = $1 AND status = 'sent'`, [r.id]); await event(db, r.id, 'opened'); }
}

export const OTP_MASK = (title: string) => `קוד אימות לחתימה על "${title}" נשלח (הקוד מוסתר).`;

/** A six-digit code to the same chat the link was sent to (proof that the person holds that phone / account). */
export async function sendOtp(db: Db, out: Sender, r: PublicReq): Promise<'sent' | 'too_soon' | 'too_many' | 'no_channel'> {
  if (!r.channel_id || !r.external_id || !r.conversation_id) return 'no_channel';
  if (r.otp_sent >= 6) return 'too_many';
  if (r.last_otp_at && Date.now() - new Date(r.last_otp_at).getTime() < 45_000) return 'too_soon';
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(`UPDATE form_requests SET otp_hash = $2, otp_expires_at = now() + interval '10 minutes', otp_tries = 0, otp_sent = otp_sent + 1 WHERE id = $1`, [r.id, sha256(`otp:${r.id}:${code}`)]);
  const text = `קוד האימות לחתימה על "${r.title}": ${code}\nהקוד בתוקף 10 דקות. אם לא ביקשת אותו, אפשר להתעלם מההודעה.`;
  const sent = await out.sendText(r.channel_id, r.external_id, text);
  // staff must never see the code (they could sign in the customer's name): the inbox masks this kind of message. Only the website
  // chat keeps the text itself, because its visitor reads the stored messages; elsewhere the platform delivered it already.
  const webchat = (await db.query('SELECT type FROM channels WHERE id = $1', [r.channel_id])).rows[0]?.type === 'webchat';
  const m = await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto, automation) VALUES ($1,'out',$2,$3,true,'form_otp') ON CONFLICT DO NOTHING RETURNING id`,
    [r.conversation_id, webchat ? text : OTP_MASK(r.title), sent.externalMessageId ?? null]);
  if (m.rows[0]) out.notifyMessage(r.channel_id, r.conversation_id, m.rows[0].id);
  await event(db, r.id, 'otp_sent');
  return 'sent';
}

/** Checks the code (5 tries per code); on success returns a fill key that the browser keeps for submitting. */
export async function verifyOtp(db: Db, r: PublicReq, code: string): Promise<{ ok: true; key: string } | { ok: false; reason: 'expired' | 'wrong' | 'too_many' }> {
  if (!r.otp_hash || !r.otp_expires_at || r.otp_expires_at.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (r.otp_tries >= 5) return { ok: false, reason: 'too_many' };
  const want = Buffer.from(r.otp_hash, 'hex'), got = Buffer.from(sha256(`otp:${r.id}:${code.replace(/\D/g, '')}`), 'hex');
  if (!timingSafeEqual(want, got)) {
    await db.query('UPDATE form_requests SET otp_tries = otp_tries + 1 WHERE id = $1', [r.id]);
    await event(db, r.id, 'otp_wrong');
    return { ok: false, reason: r.otp_tries + 1 >= 5 ? 'too_many' : 'wrong' };
  }
  const key = randomBytes(24).toString('base64url');
  await db.query(`UPDATE form_requests SET otp_hash = NULL, fill_key_hash = $2, verified_at = now(), status = CASE WHEN status IN ('sent','opened') THEN 'verified' ELSE status END WHERE id = $1`, [r.id, sha256(`key:${key}`)]);
  await event(db, r.id, 'verified');
  return { ok: true, key };
}

export function keyOk(r: PublicReq, key: unknown): boolean {
  if (typeof key !== 'string' || !r.fill_key_hash || !r.verified_at) return false;
  if (Date.now() - r.verified_at.getTime() > 2 * 3600_000) return false;   // a verified session lasts two hours
  return timingSafeEqual(Buffer.from(r.fill_key_hash, 'hex'), Buffer.from(sha256(`key:${key}`), 'hex'));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Checks every value against its field, builds the locked PDF with its signature record, stores it encrypted. */
export async function submit(db: Db, cfg: Config, r: PublicReq, input: { values: Record<string, unknown>; marks: Record<string, { png?: string; typed?: string }>; ip: string | null; ua: string | null; org: string }):
  Promise<{ ok: true; pdf: Buffer; sha256: string } | { ok: false; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  const values: Record<string, string | boolean | null> = {};
  const marks: Record<string, SignatureMark> = {};
  for (const f of r.fields) {
    if (f.type === 'signature' || f.type === 'initials') {
      const m = input.marks[f.id];
      if (m?.png) {
        const b64 = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(m.png)?.[1];
        const buf = b64 ? Buffer.from(b64, 'base64') : null;
        if (!buf || buf.length < 200 || buf.length > 300_000 || !buf.subarray(0, 8).equals(PNG)) { errors[f.id] = 'signature'; continue; }
        marks[f.id] = { png: buf };
      } else if (typeof m?.typed === 'string' && m.typed.trim().length >= 2 && m.typed.trim().length <= 80) marks[f.id] = { typed: m.typed.trim() };
      else if (f.required) errors[f.id] = 'required';
      continue;
    }
    const raw = f.locked && r.prefill[f.id] !== undefined ? r.prefill[f.id] : input.values[f.id];
    const c = checkValue(f, raw);
    if (!c.ok) errors[f.id] = c.reason; else values[f.id] = c.value;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const source = (await db.query('SELECT source_pdf FROM form_templates WHERE id = $1', [r.template_id])).rows[0]?.source_pdf as Buffer | undefined;
  if (!source || sha256(source) !== r.template_sha256) throw new Error('template_changed');
  const valuesJson = JSON.stringify({ values, marks: Object.fromEntries(Object.entries(marks).map(([k, m]) => [k, m.png ? { pngSha256: sha256(m.png) } : { typed: m.typed }])) });
  const now = new Date();
  const pdf = await buildSignedPdf(source, r.fields, values, marks, {
    formTitle: r.title, requestNumber: r.number, signerName: r.signer_name, signerPhone: r.signer_phone, verifiedAt: r.verified_at ?? now, signedAt: now,
    ip: input.ip, userAgent: input.ua, templateSha256: r.template_sha256, valuesSha256: sha256(valuesJson), org: input.org,
  });
  const hash = sha256(pdf);
  const claimed = await db.query(`UPDATE form_requests SET status = 'signed', signed_at = $2, fill_key_hash = NULL WHERE id = $1 AND status IN ('verified','opened','sent') RETURNING id`, [r.id, now]);
  if (!claimed.rowCount) return { ok: false, errors: { _: 'already_signed' } };
  await db.query(`INSERT INTO form_submissions (request_id, values_enc, signed_pdf, sha256, signer_ip, signer_ua, signed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [r.id, encrypt(valuesJson, cfg.ENCRYPTION_KEY), encryptBytes(pdf, cfg.ENCRYPTION_KEY), hash, input.ip, (input.ua ?? '').slice(0, 300), now]);
  await event(db, r.id, 'signed', `SHA-256 ${hash}`);
  return { ok: true, pdf, sha256: hash };
}

export async function signedPdf(db: Db, cfg: Config, requestId: string): Promise<{ pdf: Buffer; title: string; number: number } | null> {
  const row = (await db.query(`SELECT s.signed_pdf, t.title, r.number FROM form_submissions s JOIN form_requests r ON r.id = s.request_id JOIN form_templates t ON t.id = r.template_id WHERE s.request_id = $1`, [requestId])).rows[0];
  if (!row) return null;
  return { pdf: decryptBytes(row.signed_pdf, cfg.ENCRYPTION_KEY), title: row.title, number: Number(row.number) };
}

export function decryptValues(enc: string, cfg: Config): unknown { return JSON.parse(decrypt(enc, cfg.ENCRYPTION_KEY)); }
