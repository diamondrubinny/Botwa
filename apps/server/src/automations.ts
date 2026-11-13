import { z } from 'zod';
import { renderCanned } from './canned.js';
import type { Db } from './db.js';
import { isOpen } from './business-hours.js';
import { loadBusinessHours } from './routes/settings.js';
import { sendBlock, type AccessibleConversation } from './access.js';
import { loadSending } from './channels/sender.js';

const text = z.string().trim().max(1000);
const mins = z.number().int().min(1).max(10080);   // up to a week

/** The conversation automations. Each is off until switched on. Times are minutes. */
export const automationsSchema = z.object({
  idle: z.object({
    enabled: z.boolean(),
    /** a reminder after this many minutes without an answer from the customer (0 = no reminder, close directly) */
    reminderAfter: z.number().int().min(0).max(10080),
    reminderText: text,
    /** close this many minutes after the reminder (or after our last message when there is no reminder) */
    closeAfter: mins,
    /** sent when closing; empty = close without a message */
    closeText: text,
  }),
  holding: z.object({
    enabled: z.boolean(),
    /** the customer has waited this long for a person: tell them once that we are on it */
    after: mins,
    text: text.min(1),
  }),
  closing: z.object({
    /** when a person closes a conversation, the "send a closing message" box starts ticked */
    defaultOn: z.boolean(),
    text: text,
  }),
  /** after a conversation closes, ask the customer to rate it 1-5 (a reply of a digit is stored and does not reopen it) */
  feedback: z.object({
    enabled: z.boolean(),
    question: text.min(1),
    thanks: text,
    /** also after automatic closing (no answer from the customer) */
    afterAuto: z.boolean(),
  }).default({ enabled: false, question: 'נשמח לשמוע איך היה השירות: השיבו במספר מ-1 עד 5 (5 = מצוין).', thanks: 'תודה רבה על המשוב!', afterAuto: false }),
}).strict();
export type Automations = z.infer<typeof automationsSchema>;

export const DEFAULT_AUTOMATIONS: Automations = {
  idle: {
    enabled: false, reminderAfter: 60, closeAfter: 120,
    reminderText: 'היי {שם}, רצינו לוודא שקיבלת את התשובה שלנו. יש עוד משהו שנוכל לעזור בו?',
    closeText: 'מאחר שלא קיבלנו מענה, אנחנו סוגרים את הפנייה בינתיים. אפשר לכתוב לנו כאן בכל עת והשיחה תיפתח מחדש. יום טוב!',
  },
  holding: { enabled: false, after: 10, text: 'קיבלנו את פנייתך, {שם}. נציג/ה יחזרו אליך בהקדם. תודה על הסבלנות!' },
  closing: { defaultOn: false, text: 'תודה שפנית אלינו, {שם}! אם יעלה משהו נוסף, אנחנו כאן.' },
  feedback: { enabled: false, question: 'נשמח לשמוע איך היה השירות: השיבו במספר מ-1 עד 5 (5 = מצוין).', thanks: 'תודה רבה על המשוב!', afterAuto: false },
};

export async function loadAutomations(db: Db): Promise<Automations> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'automations'`);
  const p = automationsSchema.safeParse(rows[0]?.value);
  return p.success ? p.data : DEFAULT_AUTOMATIONS;
}

export interface AutoSender {
  sendText(channelId: string, externalContactId: string, text: string, opts?: { background?: boolean }): Promise<{ externalMessageId?: string }>;
  notifyMessage(channelId: string, conversationId: string, messageId: string): void;
}

type ConvRow = AccessibleConversation & { contact_name: string | null; channel_label: string; agent_name: string | null };
const CONV = `SELECT c.id, c.channel_id, c.assigned_to, c.status, ct.external_id, ct.blocked, ct.opted_out, ch.type AS channel_type,
                     ct.display_name AS contact_name, ch.label AS channel_label, u.name AS agent_name
                FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id LEFT JOIN users u ON u.id = c.assigned_to`;
/** comment threads (public posts) never get automatic messages */
const NOT_COMMENT = `ct.external_id !~ '@(fb|ig)comment$'`;

/**
 * Send one automatic message to a conversation if the rules allow it (not blocked, not opted out, inside the platform's
 * reply window). Returns false when it was not sent; the caller decides what that means (e.g. close anyway).
 */
export async function sendAutomatic(db: Db, out: AutoSender, conv: ConvRow, body: string, kind: 'idle_reminder' | 'idle_close' | 'holding' | 'closing' | 'feedback' | 'feedback_thanks'): Promise<boolean> {
  if (!body.trim() || /@(fb|ig)comment$/.test(conv.external_id)) return false;
  if (await sendBlock(db, conv, (await loadSending(db)).replyWindowHours)) return false;
  const hours = await loadBusinessHours(db);
  const textOut = renderCanned(body, { customerName: conv.contact_name, agentName: conv.agent_name ?? 'הצוות', hours, channelLabel: conv.channel_label });
  try {
    const sent = await out.sendText(conv.channel_id, conv.external_id, textOut, { background: true });
    const ins = await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto, automation) VALUES ($1,'out',$2,$3,true,$4) RETURNING id`, [conv.id, textOut, sent.externalMessageId ?? null, kind]);
    await db.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conv.id]);
    out.notifyMessage(conv.channel_id, conv.id, ins.rows[0].id);
    return true;
  } catch { return false; }
}

async function close(db: Db, out: AutoSender, convId: string, note: string): Promise<void> {
  const r = await db.query(`UPDATE conversations SET status = 'closed', close_kind = 'auto', closed_by = NULL, bot_state = NULL, flow_state = NULL, bot_invalid = 0 WHERE id = $1 AND status = 'open' RETURNING id`, [convId]);
  await db.query('INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)', [convId, note]);
  if (r.rowCount) await askFeedback(db, out, convId, 'auto');
}

/** Rating 1-5 from a reply: a digit, or 1-5 stars. null when the reply is something else. */
export function parseRating(text: string): number | null {
  const t = text.trim();
  if (/^[1-5]$/.test(t)) return Number(t);
  const stars = t.match(/⭐|🌟|★/g)?.length ?? 0;
  return stars >= 1 && stars <= 5 && t.replace(/⭐|🌟|★|\s/g, '') === '' ? stars : null;
}

/** After a case closed: ask for a rating once (if switched on), and remember which case the answer belongs to. */
export async function askFeedback(db: Db, out: AutoSender, convId: string, how: 'staff' | 'auto'): Promise<boolean> {
  const a = (await loadAutomations(db)).feedback;
  if (!a.enabled || (how === 'auto' && !a.afterAuto)) return false;
  const kase = (await db.query(`SELECT id FROM cases WHERE conversation_id = $1 AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1`, [convId])).rows[0];
  const conv = (await db.query(`${CONV} WHERE c.id = $1`, [convId])).rows[0] as ConvRow | undefined;
  if (!kase || !conv) return false;
  if (!(await sendAutomatic(db, out, conv, a.question, 'feedback'))) return false;
  await db.query('UPDATE conversations SET feedback_case_id = $2, feedback_asked_at = now() WHERE id = $1', [convId, kase.id]);
  return true;
}

/** A rating arrived for a waiting feedback question: thank the customer (the conversation stays closed). */
export async function thankForFeedback(db: Db, out: AutoSender, convId: string): Promise<void> {
  const a = (await loadAutomations(db)).feedback;
  const conv = (await db.query(`${CONV} WHERE c.id = $1`, [convId])).rows[0] as ConvRow | undefined;
  if (conv && a.thanks) await sendAutomatic(db, out, conv, a.thanks, 'feedback_thanks');
}

/** One pass of the time-based automations. Returns what was done (for logs and tests). */
export async function runAutomations(db: Db, out: AutoSender, now = new Date()): Promise<{ reminded: number; closed: number; held: number }> {
  const a = await loadAutomations(db);
  const done = { reminded: 0, closed: 0, held: 0 };

  if (a.idle.enabled) {
    // our side (a person or the bot) wrote last and the customer has not answered since
    const { rows } = await db.query(
      `WITH t AS (
         SELECT c.id,
                (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in') AS last_in,
                (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND m.automation IS NULL) AS last_out,
                (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.automation = 'idle_reminder') AS last_reminder
           FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
          WHERE c.status = 'open' AND (c.snoozed_until IS NULL OR c.snoozed_until <= $1) AND ${NOT_COMMENT})
       SELECT id, last_out, last_reminder FROM t
        WHERE last_out IS NOT NULL AND (last_in IS NULL OR last_out > last_in)
        ORDER BY last_out LIMIT 50`,
      [now],
    );
    for (const r of rows as { id: string; last_out: Date; last_reminder: Date | null }[]) {
      const reminded = !!r.last_reminder && r.last_reminder > r.last_out;
      const since = (d: Date) => (now.getTime() - d.getTime()) / 60_000;
      const conv = (await db.query(`${CONV} WHERE c.id = $1`, [r.id])).rows[0] as ConvRow;
      if (a.idle.reminderAfter > 0 && !reminded) {
        if (since(r.last_out) >= a.idle.reminderAfter && a.idle.reminderText) {
          if (await sendAutomatic(db, out, conv, a.idle.reminderText, 'idle_reminder')) done.reminded++;
          else if (since(r.last_out) >= a.idle.reminderAfter + a.idle.closeAfter) {   // could not remind (window closed, blocked): close when the full time is up
            await close(db, out, r.id, 'השיחה נסגרה אוטומטית: הלקוח לא הגיב (לא ניתן היה לשלוח תזכורת).'); done.closed++;
          }
        }
        continue;
      }
      const from = reminded ? r.last_reminder! : r.last_out;
      if (since(from) < a.idle.closeAfter) continue;
      const sent = a.idle.closeText ? await sendAutomatic(db, out, conv, a.idle.closeText, 'idle_close') : false;
      await close(db, out, r.id, `השיחה נסגרה אוטומטית: הלקוח לא הגיב${reminded ? ' גם אחרי תזכורת' : ''}${a.idle.closeText && !sent ? ' (הודעת הסגירה לא נשלחה)' : ''}. הודעה חדשה מהלקוח תפתח אותה מחדש.`);
      done.closed++;
    }
  }

  if (a.holding.enabled) {
    const hours = await loadBusinessHours(db);
    if (!hours.enabled || isOpen(hours, now)) {
      // the customer is waiting for a person (the bot is not handling it) and nobody has answered yet
      const { rows } = await db.query(
        `WITH t AS (
           SELECT c.id,
                  (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in') AS last_in,
                  (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND NOT m.auto) AS last_staff,
                  (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.automation = 'holding') AS last_hold
             FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
            WHERE c.status = 'open' AND c.bot_state IS DISTINCT FROM 'menu' AND c.flow_state IS NULL AND (c.snoozed_until IS NULL OR c.snoozed_until <= $1) AND ${NOT_COMMENT})
         SELECT id FROM t
          WHERE last_in IS NOT NULL AND last_in <= $1 - make_interval(mins => $2)
            AND (last_staff IS NULL OR last_staff < last_in)
            AND (last_hold IS NULL OR last_hold < (SELECT min(created_at) FROM messages m WHERE m.conversation_id = t.id AND m.direction = 'in' AND m.created_at > COALESCE(t.last_staff, '-infinity')))
          LIMIT 50`,
        [now, a.holding.after],
      );
      for (const r of rows as { id: string }[]) {
        const conv = (await db.query(`${CONV} WHERE c.id = $1`, [r.id])).rows[0] as ConvRow;
        if (await sendAutomatic(db, out, conv, a.holding.text, 'holding')) done.held++;
      }
    }
  }
  return done;
}

/** The closing message when a person closes a conversation (if they chose to send it). */
export async function sendClosingMessage(db: Db, out: AutoSender, convId: string): Promise<boolean> {
  const a = await loadAutomations(db);
  const conv = (await db.query(`${CONV} WHERE c.id = $1`, [convId])).rows[0] as ConvRow | undefined;
  return !!conv && !!a.closing.text && sendAutomatic(db, out, conv, a.closing.text, 'closing');
}
