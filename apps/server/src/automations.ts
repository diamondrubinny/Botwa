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
  /** the customer writes that it is solved or asks to close ("הסתדרתי", "תסגרו את הקריאה"): close the inquiry and confirm */
  customerClose: z.object({
    enabled: z.boolean(),
    text: text,
  }).default({ enabled: true, text: 'סגרנו את הפנייה לבקשתך. אם יעלה משהו נוסף, אפשר לכתוב לנו כאן בכל עת והיא תיפתח מחדש.' }),
  /** when a person (an officer or an agent) takes the inquiry, they introduce themselves to the customer once */
  introduce: z.object({
    enabled: z.boolean(),
    text: text.min(1),
  }).default({ enabled: true, text: 'שלום {שם}, כאן {נציג}, {תפקיד}. אני אטפל בפנייתך מעכשיו ואחזור אליך בהקדם.' }),
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
  customerClose: { enabled: true, text: 'סגרנו את הפנייה לבקשתך. אם יעלה משהו נוסף, אפשר לכתוב לנו כאן בכל עת והיא תיפתח מחדש.' },
  introduce: { enabled: true, text: 'שלום {שם}, כאן {נציג}, {תפקיד}. אני אטפל בפנייתך מעכשיו ואחזור אליך בהקדם.' },
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

type ConvRow = AccessibleConversation & { contact_name: string | null; channel_label: string; agent_name: string | null; agent_title: string | null; agent_phone: string | null };
const CONV = `SELECT c.id, c.channel_id, c.assigned_to, c.status, ct.external_id, ct.blocked, ct.opted_out, ch.type AS channel_type,
                     ct.display_name AS contact_name, ch.label AS channel_label, u.name AS agent_name, u.job_title AS agent_title, u.intro_phone AS agent_phone
                FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id LEFT JOIN users u ON u.id = c.assigned_to`;
/** comment threads (public posts) never get automatic messages */
const NOT_COMMENT = `ct.external_id !~ '@(fb|ig)comment$'`;

/**
 * Send one automatic message to a conversation if the rules allow it (not blocked, not opted out, inside the platform's
 * reply window). Returns false when it was not sent; the caller decides what that means (e.g. close anyway).
 */
export async function sendAutomatic(db: Db, out: AutoSender, conv: ConvRow, body: string, kind: 'idle_reminder' | 'idle_close' | 'holding' | 'closing' | 'feedback' | 'feedback_thanks' | 'customer_close' | 'introduce'): Promise<boolean> {
  if (!body.trim() || /@(fb|ig)comment$/.test(conv.external_id)) return false;
  if (await sendBlock(db, conv, (await loadSending(db)).replyWindowHours)) return false;
  const hours = await loadBusinessHours(db);
  const textOut = renderCanned(body, { customerName: conv.contact_name, agentName: conv.agent_name ?? 'הצוות', agentTitle: conv.agent_title, agentPhone: conv.agent_phone, hours, channelLabel: conv.channel_label });
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

// "it is solved" / "close it": words that settle it on their own, and close verbs that need an object or "אפשר" with them
const SOLVED = ['הסתדרתי', 'הסתדרנו', 'הסתדר', 'הסתדרה', 'הסתדרו', 'סודר', 'סודרה', 'נפתר', 'נפתרה', 'נפתרו', 'טופל', 'טופלה', 'resolved', 'solved', 'sorted'];
const CLOSE_VERB = ['תסגרו', 'סגרו', 'תסגור', 'תסגרי', 'לסגור', 'close'];
const CLOSE_OBJ = ['הקריאה', 'קריאה', 'הפנייה', 'הפניה', 'פנייה', 'פניה', 'השיחה', 'שיחה', 'הטיקט', 'טיקט', 'אותה', 'אותו', 'ticket', 'it', 'chat'];
const CLOSE_MAY = ['אפשר', 'ניתן', 'אפשרי', 'can', 'may', 'please', 'בבקשה'];
/** a question, a "not yet", a "but", or a "don't close" means it is not a request to close */
const NOT_CLOSE = new Set(['לא', 'אל', 'עדיין', 'אבל', 'עוד', 'למה', 'מתי', 'איך', 'מה', 'האם', 'איפה', 'כמה', 'לפני', 'not', "don't", 'dont', 'still', 'but', 'yet', 'why', 'how', 'when']);

/**
 * The customer says the matter is settled or asks to close it ("הסתדרתי", "הסתדר, תודה", "תסגרו את הקריאה", "אפשר לסגור"):
 * short, and with no question, "not yet", "but" or "don't close" in it.
 */
export function isCloseRequest(textIn: string | null): boolean {
  if (!textIn) return false;
  const t = textIn.trim();
  if (!t || t.length > 140 || /[?؟]/.test(t)) return false;
  const words = t.toLowerCase().replace(/[!.,׳"״:;()\-–—~*]/g, ' ').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, ' ')
    .split(/\s+/).filter(Boolean)
    .map((w) => (w.length > 3 && /^[וש][\u0590-\u05FF]/.test(w) && [...SOLVED, ...CLOSE_VERB, ...NOT_CLOSE].includes(w.slice(1)) ? w.slice(1) : w));   // "ותסגרו" -> "תסגרו"
  if (!words.length || words.length > 12 || words.some((w) => NOT_CLOSE.has(w))) return false;
  if (words.some((w) => SOLVED.includes(w))) return true;
  const verb = words.findIndex((w) => CLOSE_VERB.includes(w));
  if (verb < 0) return false;
  return words.some((w) => CLOSE_OBJ.includes(w)) || words.slice(0, verb).some((w) => CLOSE_MAY.includes(w)) || words.length <= 2;
}

/**
 * The customer asked to close (see isCloseRequest): close the inquiry as closed by the customer, confirm it to them,
 * and ask for a rating when that is switched on. Returns false when the conversation was not open or the option is off.
 */
export async function closeByCustomer(db: Db, out: AutoSender, convId: string, said: string): Promise<boolean> {
  const a = (await loadAutomations(db)).customerClose;
  if (!a.enabled) return false;
  const conv = (await db.query(`${CONV} WHERE c.id = $1 AND c.status = 'open' AND ${NOT_COMMENT}`, [convId])).rows[0] as ConvRow | undefined;
  if (!conv) return false;
  if (a.text) await sendAutomatic(db, out, conv, a.text, 'customer_close');   // before the status changes, like a person's closing message
  const r = await db.query(`UPDATE conversations SET status = 'closed', close_kind = 'customer', closed_by = NULL, bot_state = NULL, flow_state = NULL, bot_invalid = 0 WHERE id = $1 AND status = 'open' RETURNING id`, [convId]);
  if (!r.rowCount) return false;
  await db.query('INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)', [convId, `הפנייה נסגרה לבקשת הלקוח ("${said.trim().slice(0, 80)}"). הודעה חדשה ממנו תפתח אותה מחדש.`]);
  await askFeedback(db, out, convId, 'customer').catch(() => false);
  return true;
}

/**
 * The person who now holds the inquiry introduces themselves to the customer ("שלום, כאן דנה, ממונת בטיחות. אני אטפל בפנייתך"):
 * once per person per inquiry, so a hand-over to someone else or a new inquiry introduces again, re-assigning the same person does not.
 * Not for closed conversations, public comment threads, blocked or opted-out customers, or outside the platform's reply window.
 */
export async function introduceAgent(db: Db, out: AutoSender, convId: string): Promise<boolean> {
  const a = (await loadAutomations(db)).introduce;
  if (!a.enabled) return false;
  const conv = (await db.query(`${CONV} WHERE c.id = $1 AND c.status = 'open' AND c.assigned_to IS NOT NULL AND ${NOT_COMMENT}`, [convId])).rows[0] as ConvRow | undefined;
  if (!conv || !conv.assigned_to) return false;
  const kase = (await db.query(`SELECT id FROM cases WHERE conversation_id = $1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`, [convId])).rows[0]?.id as string | undefined;
  // claim it first, so two quick assignments (routing + a person) cannot both send it
  const claim = await db.query(
    `UPDATE conversations SET introduced_to = $2, introduced_case = $3 WHERE id = $1 AND (introduced_to IS DISTINCT FROM $2 OR introduced_case IS DISTINCT FROM $3) RETURNING id`,
    [convId, conv.assigned_to, kase ?? null]);
  if (!claim.rowCount) return false;
  const sent = await sendAutomatic(db, out, conv, a.text, 'introduce');
  if (!sent) await db.query('UPDATE conversations SET introduced_to = NULL, introduced_case = NULL WHERE id = $1 AND introduced_to = $2', [convId, conv.assigned_to]);
  return sent;
}

/** Rating 1-5 from a reply: a digit, or 1-5 stars. null when the reply is something else. */
export function parseRating(text: string): number | null {
  const t = text.trim();
  if (/^[1-5]$/.test(t)) return Number(t);
  const stars = t.match(/⭐|🌟|★/g)?.length ?? 0;
  return stars >= 1 && stars <= 5 && t.replace(/⭐|🌟|★|\s/g, '') === '' ? stars : null;
}

/** After a case closed: ask for a rating once (if switched on), and remember which case the answer belongs to. */
export async function askFeedback(db: Db, out: AutoSender, convId: string, how: 'staff' | 'auto' | 'customer'): Promise<boolean> {
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
