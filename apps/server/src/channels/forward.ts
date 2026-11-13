import type { Db } from '../db.js';

export const GROUP_JID = /^[0-9]{5,25}(-[0-9]+)?@g\.us$/;

export interface ForwardRule { id: string; name: string; enabled: boolean; channel_id: string; group_jid: string; group_name: string; on_handoff: boolean; tag_ids: string[]; include_messages: number; include_phone: boolean }

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The message posted into the group: who, what topic, what the bot collected, the last messages, and the link that opens the conversation
 * in the panel (staff only, behind sign-in). The customer's phone number is included only when the rule says so.
 */
export async function forwardText(db: Db, convId: string, rule: Pick<ForwardRule, 'include_messages' | 'include_phone'>, origin: string, opts: { note?: string; by?: string } = {}): Promise<string | null> {
  const c = (await db.query(
    `SELECT c.id, ct.display_name AS name, ct.external_id AS ext, ch.label AS channel, ch.type, au.name AS assigned,
            COALESCE((SELECT string_agg(t.name, ', ' ORDER BY lower(t.name)) FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = c.id), '') AS tags,
            (SELECT body FROM conversation_notes n WHERE n.conversation_id = c.id AND n.body LIKE 'פרטים שנאספו%' ORDER BY n.id DESC LIMIT 1) AS collected
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id LEFT JOIN users au ON au.id = c.assigned_to WHERE c.id = $1`, [convId])).rows[0];
  if (!c) return null;
  const phone = rule.include_phone && c.type !== 'webchat' ? String(c.ext).split('@')[0] : null;
  const lines = [`📥 שיחה להעברה${opts.by ? ` (מאת ${opts.by})` : ''}`, `לקוח: ${c.name ?? 'ללא שם'}${phone ? ` (${phone})` : ''}`, c.tags && `נושא: ${c.tags}`, c.assigned && `מטפל/ת: ${c.assigned}`];
  if (opts.note) lines.push(`הערה: ${clip(opts.note, 400)}`);
  if (c.collected) lines.push('', clip(String(c.collected).replace(/^פרטים שנאספו:?\s*/, ''), 700));
  if (rule.include_messages > 0) {
    const msgs = (await db.query(`SELECT direction, body, auto FROM messages WHERE conversation_id = $1 AND body <> '' AND automation IS DISTINCT FROM 'form_otp' ORDER BY created_at DESC LIMIT $2`, [convId, rule.include_messages])).rows.reverse();
    if (msgs.length) lines.push('', 'הודעות אחרונות:', ...msgs.map((m) => `${m.direction === 'in' ? 'לקוח' : m.auto ? 'בוט' : 'צוות'}: ${clip(String(m.body), 220)}`));
  }
  lines.push('', `לפתיחה בפאנל: ${origin.replace(/\/$/, '')}/#/inbox?c=${convId}`);
  return lines.filter((l) => l !== null && l !== undefined && l !== false).join('\n');
}
