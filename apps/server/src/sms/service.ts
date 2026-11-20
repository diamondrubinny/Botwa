import { z } from 'zod';
import type { Config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import type { Db } from '../db.js';
import { normalizePhone } from '../contacts/identity.js';

/**
 * SMS, outbound only (no inbound webhook, so nothing new to attack): a form's one-time code when it does not reach the chat,
 * and reminders to people WhatsApp cannot reach. Provider: Twilio (Messages API, per its documentation; verify against the
 * official reference). Every send passes the monthly cap and the opt-out list, and is logged with the number masked.
 */
export const smsSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.literal('twilio'),
  accountSid: z.string().trim().regex(/^AC[0-9a-f]{32}$/i).or(z.literal('')),
  /** a phone number in +E.164, an alphanumeric sender id (1-11 letters/digits, with a letter), or a Messaging Service SID */
  from: z.string().trim().regex(/^(\+\d{8,15}|(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11}|MG[0-9a-f]{32})$/i).or(z.literal('')),
  monthlyLimit: z.number().int().min(0).max(100_000),
});
export type SmsSettings = z.infer<typeof smsSettingsSchema>;
export const DEFAULT_SMS: SmsSettings = { enabled: false, provider: 'twilio', accountSid: '', from: '', monthlyLimit: 300 };

export async function loadSms(db: Db): Promise<SmsSettings> {
  const v = (await db.query(`SELECT value FROM settings WHERE key = 'sms'`)).rows[0]?.value;
  const p = smsSettingsSchema.safeParse(v);
  return p.success ? p.data : DEFAULT_SMS;
}
export async function hasSmsSecret(db: Db): Promise<boolean> {
  return !!(await db.query(`SELECT 1 FROM settings WHERE key = 'sms_secret'`)).rowCount;
}
export async function saveSms(db: Db, cfg: Config, s: SmsSettings, secret?: string): Promise<void> {
  await db.query(`INSERT INTO settings (key, value) VALUES ('sms', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(s)]);
  if (secret) await db.query(`INSERT INTO settings (key, value) VALUES ('sms_secret', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(encrypt(secret, cfg.ENCRYPTION_KEY))]);
}
async function secretOf(db: Db, cfg: Config): Promise<string | null> {
  const v = (await db.query(`SELECT value FROM settings WHERE key = 'sms_secret'`)).rows[0]?.value;
  try { return typeof v === 'string' ? decrypt(v, cfg.ENCRYPTION_KEY) : null; } catch { return null; }
}

/** Ready to send: switched on, the account, the sender and the secret are all there. */
export async function smsReady(db: Db): Promise<boolean> {
  const s = await loadSms(db);
  return s.enabled && !!s.accountSid && !!s.from && await hasSmsSecret(db);
}

/** "+972501234567" from what we know of a contact (a WhatsApp id, a phone in any local form); null when it is not a phone. */
export function smsNumber(raw: string | null | undefined): string | null {
  if (!raw || /@(?!s\.whatsapp\.net$)/.test(raw)) return null;   // ids of other platforms, BSUIDs, e-mails
  const d = normalizePhone(raw.split('@')[0]);
  return d ? `+${d}` : null;
}
export const maskNumber = (e164: string) => (e164.length > 8 ? `${e164.slice(0, 6)}•••${e164.slice(-4)}` : '•••');

/** GSM-7 text: 160 characters in one part, 153 per part when split; anything else (Hebrew) is UCS-2: 70, then 67. */
const GSM = /^[\n\r @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
export function smsSegments(text: string): { encoding: 'GSM-7' | 'UCS-2'; chars: number; segments: number } {
  const gsm = GSM.test(text);
  const chars = gsm ? text.length + (text.match(/[\^{}\\[~\]|€]/g)?.length ?? 0) : [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  const [one, many] = gsm ? [160, 153] : [70, 67];
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', chars, segments: chars <= one ? 1 : Math.ceil(chars / many) };
}

export async function monthUsage(db: Db): Promise<number> {
  return (await db.query(`SELECT COALESCE(sum(segments), 0)::int AS n FROM sms_log WHERE status <> 'failed' AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'`)).rows[0].n;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export class SmsError extends Error { constructor(readonly key: string, readonly detail?: string) { super(key); } }

/**
 * Send one SMS. Refused when SMS is off or not set up, the number is not a phone, the person asked to stop (opted out on any
 * channel with this number), or the month's parts would pass the cap. The text must not exceed 4 parts.
 */
export async function sendSms(db: Db, cfg: Config, a: { to: string; text: string; purpose: 'otp' | 'reminder' | 'test'; requestId?: string | null; userId?: string | null }, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<{ id: string | null; segments: number }> {
  const s = await loadSms(db);
  const secret = await secretOf(db, cfg);
  if (!s.enabled || !s.accountSid || !s.from || !secret) throw new SmsError('sms_not_configured');
  const to = smsNumber(a.to);
  if (!to) throw new SmsError('sms_bad_number');
  const seg = smsSegments(a.text);
  if (seg.segments > 4) throw new SmsError('sms_too_long');
  if (a.purpose !== 'otp' && (await db.query(`SELECT 1 FROM contacts WHERE opted_out AND (external_id = $1 OR claimed_phone = $2) LIMIT 1`, [`${to.slice(1)}@s.whatsapp.net`, to.slice(1)])).rowCount) throw new SmsError('sms_opted_out');
  if (s.monthlyLimit > 0 && (await monthUsage(db)) + seg.segments > s.monthlyLimit) throw new SmsError('sms_monthly_limit');
  const log = async (status: string, providerId: string | null, error: string | null) => db.query(
    'INSERT INTO sms_log (to_masked, purpose, request_id, segments, provider_id, status, error, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [maskNumber(to), a.purpose, a.requestId ?? null, seg.segments, providerId, status, error, a.userId ?? null]);
  const sender: Record<string, string> = s.from.startsWith('MG') ? { MessagingServiceSid: s.from } : { From: s.from };
  let res: Response;
  try {
    res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${s.accountSid}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, Body: a.text, ...sender }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { await log('failed', null, 'unreachable'); throw new SmsError('sms_unreachable'); }
  const j = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; code?: number; message?: string };
  if (!res.ok) {
    const detail = `${j.code ?? res.status}${j.message ? `: ${String(j.message).slice(0, 160)}` : ''}`;
    await log('failed', null, detail);
    throw new SmsError(res.status === 401 ? 'sms_auth_failed' : 'sms_rejected', detail);
  }
  await log(j.status === 'failed' || j.status === 'undelivered' ? 'failed' : 'sent', typeof j.sid === 'string' ? j.sid.slice(0, 40) : null, null);
  return { id: j.sid ?? null, segments: seg.segments };
}

/** Old send logs go after 180 days (they hold no full numbers or texts, only what the cap and the audit need). */
export async function purgeSmsLog(db: Db): Promise<number> {
  return (await db.query(`DELETE FROM sms_log WHERE created_at < now() - interval '180 days'`)).rowCount ?? 0;
}
