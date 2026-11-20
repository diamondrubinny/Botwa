import { sendBlock, type AccessibleConversation } from '../access.js';
import type { ChannelManager } from '../channels/manager.js';
import { loadSending } from '../channels/sender.js';
import type { Config } from '../config.js';
import { decrypt } from '../crypto.js';
import type { Db } from '../db.js';
import { createRequest, event, getTemplate, linkMessage } from './service.js';
import { sendSms, SmsError } from '../sms/service.js';

/** An Israeli or international mobile number as digits with the country code (05x... -> 9725x...); null when it is not one. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = `972${d.slice(1)}`;
  return /^\d{9,15}$/.test(d) ? d : null;
}

export interface Person { name: string; phone: string }
export interface WaTemplate { name: string; language: string }

/**
 * One form to a group. Every person gets a personal request at once (the links exist even if a message cannot be sent); the
 * messages then go out in the background through the channel's normal pacing: a plain message to whoever is inside the reply window,
 * an approved template (official WhatsApp) to the others when one is chosen, otherwise the link stays for the staff to pass on.
 */
export async function startBatch(db: Db, cfg: Config, mgr: ChannelManager, a: { templateId: string; channelId: string; userId: string; days: number; note?: string; people: Person[]; waTemplate?: WaTemplate | null }):
  Promise<{ batchId: string; total: number; invalid: { row: number; value: string }[] }> {
  const t = await getTemplate(db, a.templateId);
  if (!t || !t.active) throw new Error('template_not_found');
  if (!t.fields.length) throw new Error('template_has_no_fields');
  const ch = (await db.query('SELECT id, type FROM channels WHERE id = $1', [a.channelId])).rows[0] as { id: string; type: string } | undefined;
  if (!ch) throw new Error('channel_not_found');
  if (ch.type !== 'whatsapp' && ch.type !== 'whatsapp_cloud') throw new Error('channel_type_unsupported');
  if (a.waTemplate && ch.type !== 'whatsapp_cloud') throw new Error('template_needs_official');
  const invalid: { row: number; value: string }[] = [];
  const people: Person[] = []; const seen = new Set<string>();
  a.people.forEach((p, i) => {
    const phone = normalizePhone(p.phone);
    if (!phone) { invalid.push({ row: i + 1, value: p.phone }); return; }
    if (seen.has(phone)) return;
    seen.add(phone); people.push({ name: p.name.trim().slice(0, 100), phone });
  });
  if (!people.length) throw new Error('no_valid_people');
  const batch = (await db.query(`INSERT INTO form_batches (template_id, channel_id, title, total, wa_template, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [t.id, ch.id, t.title, people.length, a.waTemplate ? JSON.stringify(a.waTemplate) : null, a.userId])).rows[0].id as string;
  for (const p of people) {
    // an existing contact is found by the number whatever its stored form (with or without the WhatsApp suffix)
    const known = (await db.query(`SELECT external_id FROM contacts WHERE channel_id = $1 AND split_part(external_id, '@', 1) = $2 ORDER BY created_at LIMIT 1`, [ch.id, p.phone])).rows[0]?.external_id as string | undefined;
    const ext = known ?? (ch.type === 'whatsapp' ? `${p.phone}@s.whatsapp.net` : p.phone);
    const contact = (await db.query(
      `INSERT INTO contacts (channel_id, external_id, display_name) VALUES ($1,$2,$3)
       ON CONFLICT (channel_id, external_id) DO UPDATE SET display_name = COALESCE(contacts.display_name, EXCLUDED.display_name) RETURNING id`, [ch.id, ext, p.name || null])).rows[0].id;
    // a person who never wrote gets a conversation that stays out of the open list until they answer
    let conv = (await db.query('SELECT id FROM conversations WHERE contact_id = $1 ORDER BY last_message_at DESC NULLS LAST LIMIT 1', [contact])).rows[0]?.id as string | undefined;
    if (!conv) conv = (await db.query(`INSERT INTO conversations (channel_id, contact_id, status, close_kind) VALUES ($1,$2,'closed','other') RETURNING id`, [ch.id, contact])).rows[0].id as string;
    await createRequest(db, cfg, { templateId: t.id, conversationId: conv, userId: a.userId, days: a.days, batchId: batch, keepLink: true });
  }
  void deliverBatch(db, cfg, mgr, batch, a.userId, a.note).catch(() => undefined);
  return { batchId: batch, total: people.length, invalid };
}

interface Pending { id: string; conversation_id: string; link_enc: string; signer_name: string | null; expires_at: Date; title: string }

async function convFor(db: Db, id: string): Promise<AccessibleConversation | undefined> {
  return (await db.query(`SELECT c.id, c.channel_id, c.assigned_to, c.status, ct.external_id, ct.blocked, ct.opted_out, ch.type AS channel_type
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1`, [id])).rows[0];
}

/** Sends one request's link by the allowed way; returns how it went. */
async function deliverOne(db: Db, cfg: Config, mgr: ChannelManager, r: Pending, wa: WaTemplate | null, userId: string, text: string): Promise<{ delivery: 'sent' | 'template' | 'link_only' | 'failed'; detail: string | null }> {
  const conv = await convFor(db, r.conversation_id);
  if (!conv) return { delivery: 'failed', detail: 'no_conversation' };
  const url = decrypt(r.link_enc, cfg.ENCRYPTION_KEY);
  const blockedBy = await sendBlock(db, conv, (await loadSending(db)).replyWindowHours);
  try {
    if (!blockedBy) {
      const sent = await mgr.sendText(conv.channel_id, conv.external_id, text, { background: true });
      await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, sender_user_id) VALUES ($1,'out',$2,$3,$4) ON CONFLICT DO NOTHING`, [conv.id, text, sent.externalMessageId ?? null, userId]);
      return { delivery: 'sent', detail: null };
    }
    if (blockedBy === 'outside_reply_window' && wa && conv.channel_type === 'whatsapp_cloud') {
      const tpl = (await mgr.cloudTemplates(conv.channel_id).catch(() => [])).find((x) => x.name === wa.name && x.language === wa.language && x.status === 'APPROVED');
      if (!tpl) return { delivery: 'link_only', detail: 'template_not_approved' };
      if (tpl.params < 1) return { delivery: 'link_only', detail: 'template_has_no_param' };
      const params = tpl.params >= 2 ? [r.signer_name || 'שלום', url, ...Array(tpl.params - 2).fill('-')] : [url];
      const sent = await mgr.sendTemplate(conv.channel_id, conv.external_id, { name: tpl.name, language: tpl.language, params });
      await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, sender_user_id) VALUES ($1,'out',$2,$3,$4) ON CONFLICT DO NOTHING`, [conv.id, `[תבנית ${tpl.name}] ${url}`, sent.externalMessageId ?? null, userId]);
      return { delivery: 'template', detail: null };
    }
    return { delivery: 'link_only', detail: blockedBy };
  } catch (e) { return { delivery: 'failed', detail: (e as Error).message.slice(0, 120) }; }
}

export async function deliverBatch(db: Db, cfg: Config, mgr: ChannelManager, batchId: string, userId: string, note?: string): Promise<void> {
  const b = (await db.query('SELECT wa_template FROM form_batches WHERE id = $1', [batchId])).rows[0];
  const wa = (b?.wa_template ?? null) as WaTemplate | null;
  const rows = (await db.query(`SELECT r.id, r.conversation_id, r.link_enc, r.signer_name, r.expires_at, t.title FROM form_requests r JOIN form_templates t ON t.id = r.template_id
    WHERE r.batch_id = $1 AND r.delivery = 'queued' ORDER BY r.number`, [batchId])).rows as Pending[];
  for (const r of rows) {
    const text = linkMessage(r.signer_name, r.title, decrypt(r.link_enc, cfg.ENCRYPTION_KEY), r.expires_at, note);
    const res = await deliverOne(db, cfg, mgr, r, wa, userId, text);
    await db.query('UPDATE form_requests SET delivery = $2, delivery_detail = $3 WHERE id = $1', [r.id, res.delivery, res.detail]);
    await event(db, r.id, res.delivery === 'link_only' ? 'link_only' : res.delivery === 'failed' ? 'send_failed' : 'sent', res.detail ?? undefined);
  }
  await db.query('UPDATE form_batches SET done = true WHERE id = $1', [batchId]);
}

/** A reminder to those who have not signed yet (at most once a day each), the same way the link was delivered. */
export async function remindBatch(db: Db, cfg: Config, mgr: ChannelManager, batchId: string, userId: string, opts: { sms?: boolean } = {}): Promise<{ reminded: number; skipped: number; bySms: number; smsFailed: number }> {
  const b = (await db.query('SELECT wa_template FROM form_batches WHERE id = $1', [batchId])).rows[0];
  if (!b) throw new Error('not_found');
  // with SMS: also the people WhatsApp could not reach (their link was given to pass on, or sending failed)
  const rows = (await db.query(`SELECT r.id, r.conversation_id, r.link_enc, r.signer_name, r.signer_phone, r.expires_at, r.delivery, t.title FROM form_requests r JOIN form_templates t ON t.id = r.template_id
    WHERE r.batch_id = $1 AND r.status IN ('sent','opened','verified') AND r.expires_at > now() AND r.link_enc IS NOT NULL
      AND (r.delivery IN ('sent','template') OR ($2::boolean AND r.delivery IN ('link_only','failed')))
      AND (r.reminded_at IS NULL OR r.reminded_at < now() - interval '20 hours') ORDER BY r.number`, [batchId, !!opts.sms])).rows as (Pending & { signer_phone: string | null; delivery: string })[];
  let reminded = 0, skipped = 0, bySms = 0, smsFailed = 0;
  for (const r of rows) {
    const url = decrypt(r.link_enc, cfg.ENCRYPTION_KEY);
    const text = `${r.signer_name ? `שלום ${r.signer_name}, ` : ''}תזכורת: הטופס "${r.title}" עדיין מחכה לחתימתך.\n${url}`;
    const done = async (how: string) => { reminded++; await db.query('UPDATE form_requests SET reminded_at = now() WHERE id = $1', [r.id]); await event(db, r.id, 'reminded', how); };
    if (r.delivery === 'sent' || r.delivery === 'template') {
      const res = await deliverOne(db, cfg, mgr, r, (b.wa_template ?? null) as WaTemplate | null, userId, text);
      if (res.delivery === 'sent' || res.delivery === 'template') { await done('whatsapp'); continue; }
      if (!opts.sms) { skipped++; continue; }
    }
    // by SMS to the number on the list (short text: the link and the form's name)
    try {
      await sendSms(db, cfg, { to: r.signer_phone ?? '', text: `תזכורת: "${r.title.slice(0, 40)}" מחכה לחתימתך: ${url}`, purpose: 'reminder', requestId: r.id, userId });
      bySms++; await done('sms');
    } catch (e) {
      smsFailed++; skipped++;
      await event(db, r.id, 'sms_failed', e instanceof SmsError ? e.key : 'error');
      if (e instanceof SmsError && (e.key === 'sms_monthly_limit' || e.key === 'sms_not_configured' || e.key === 'sms_auth_failed')) break;   // no point trying the rest
    }
  }
  return { reminded, skipped, bySms, smsFailed };
}
