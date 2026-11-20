import { z } from 'zod';
import { renderCanned } from './canned.js';
import type { Db } from './db.js';
import { isOpen } from './business-hours.js';
import { loadBusinessHours } from './routes/settings.js';
import { sendBlock, type AccessibleConversation } from './access.js';
import { loadSending } from './channels/sender.js';
import { FOLLOW_UP_AFTER, followUpText } from './empathy.js';
import { localize } from './i18n/translate.js';
import { arNorm, ruNorm } from './i18n/lang.js';
import { hoursSummary } from './canned.js';
import { autoAssign } from './routing.js';

const text = z.string().trim().max(1000);
const mins = z.number().int().min(1).max(10080);   // up to a week

/** The conversation automations. Each is off until switched on. Times are minutes. */
export const HAZARD_DONE_TEXT = 'המפגע שדיווחת עליו טופל ✅ תודה שדיווחת, זה עוזר לשמור על כולם בטוחים. אם המפגע עדיין קיים, כתבו כאן ונחזור לטפל בו.';

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
  /** when a person closes a hazard report (tag "מפגע"), the reporter hears that it was handled, once per inquiry */
  hazardDone: z.object({
    enabled: z.boolean(),
    text: text.min(1),
  }).default({ enabled: true, text: HAZARD_DONE_TEXT }),
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
    reminderText: 'היי {שם}, רצינו לוודא: קיבלת מענה לפנייה? אפשר לענות "כן" או "לא".',
    closeText: 'מאחר שלא קיבלנו מענה, אנחנו סוגרים את הפנייה בינתיים. אפשר לכתוב לנו כאן בכל עת והשיחה תיפתח מחדש. יום טוב!',
  },
  holding: { enabled: false, after: 10, text: 'קיבלנו את פנייתך, {שם}. נציג/ה יחזרו אליך בהקדם. תודה על הסבלנות!' },
  closing: { defaultOn: false, text: 'תודה שפנית אלינו, {שם}! אם יעלה משהו נוסף, אנחנו כאן.' },
  feedback: { enabled: false, question: 'נשמח לשמוע איך היה השירות: השיבו במספר מ-1 עד 5 (5 = מצוין).', thanks: 'תודה רבה על המשוב!', afterAuto: false },
  customerClose: { enabled: true, text: 'סגרנו את הפנייה לבקשתך. אם יעלה משהו נוסף, אפשר לכתוב לנו כאן בכל עת והיא תיפתח מחדש.' },
  hazardDone: { enabled: true, text: HAZARD_DONE_TEXT },
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
  /** an alert to the team (webhook / e-mail as configured); optional */
  alertTeam?(text: string, extra?: Record<string, unknown>): void;
  /** a conversation was assigned (push to that person); optional */
  onAssigned?: ((conversationId: string, userId: string) => void) | null;
}

type ConvRow = AccessibleConversation & { contact_name: string | null; channel_label: string; agent_name: string | null; agent_name_plain?: string | null; agent_title: string | null; agent_title_en?: string | null; agent_title_ar?: string | null; agent_title_ru?: string | null; agent_phone: string | null };
const CONV = `SELECT c.id, c.channel_id, c.assigned_to, c.status, ct.external_id, ct.blocked, ct.opted_out, ch.type AS channel_type,
                     ct.display_name AS contact_name, ch.label AS channel_label, COALESCE(u.name_he, u.name) AS agent_name, u.name AS agent_name_plain, u.job_title AS agent_title, u.job_title_en AS agent_title_en, u.job_title_ar AS agent_title_ar, u.job_title_ru AS agent_title_ru, u.intro_phone AS agent_phone
                FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id LEFT JOIN users u ON u.id = c.assigned_to`;
/** comment threads (public posts) never get automatic messages */
const NOT_COMMENT = `ct.external_id !~ '@(fb|ig)comment$'`;

/**
 * Send one automatic message to a conversation if the rules allow it (not blocked, not opted out, inside the platform's
 * reply window). Returns false when it was not sent; the caller decides what that means (e.g. close anyway).
 */
export async function sendAutomatic(db: Db, out: AutoSender, conv: ConvRow, body: string, kind: 'idle_reminder' | 'idle_close' | 'holding' | 'closing' | 'feedback' | 'feedback_thanks' | 'customer_close' | 'introduce' | 'comfort_follow' | 'hazard_done'): Promise<boolean> {
  if (!body.trim() || /@(fb|ig)comment$/.test(conv.external_id)) return false;
  if (await sendBlock(db, conv, (await loadSending(db)).replyWindowHours)) return false;
  const hours = await loadBusinessHours(db);
  // in the conversation's language (an English conversation gets the English wording; variables are filled in after)
  const lang = (await db.query('SELECT lang FROM conversations WHERE id = $1', [conv.id])).rows[0]?.lang;
  // in English or Arabic, the person's name as written in Latin letters (their account name) and no Hebrew-only job title: never a
  // Hebrew name and role inside an English sentence ("Hello Dana, this is דיימונד, אחראי…")
  const foreign = lang === 'en' || lang === 'ar' || lang === 'ru';
  const hasHe = (v: string | null | undefined) => !!v && /[\u05D0-\u05EA]/.test(v);
  const plain = conv.agent_name_plain && !hasHe(conv.agent_name_plain) && !conv.agent_name_plain.includes('@') ? conv.agent_name_plain : null;
  const agentName = foreign ? (plain ?? conv.agent_name ?? await localize(db, lang, 'הצוות')) : (conv.agent_name ?? 'הצוות');
  // the role in the conversation's language when the person wrote one; a Hebrew-only role is left out
  const own = lang === 'en' ? conv.agent_title_en : lang === 'ar' ? conv.agent_title_ar : lang === 'ru' ? conv.agent_title_ru : null;
  const agentTitle = foreign ? (own || (hasHe(conv.agent_title) ? null : conv.agent_title)) : conv.agent_title;
  const rendered = renderCanned(await localize(db, lang, body), { customerName: conv.contact_name, agentName, agentTitle, agentPhone: conv.agent_phone, hours, channelLabel: conv.channel_label });
  // what the variables brought in Hebrew (the working hours) is translated as far as the dictionary goes
  const textOut = foreign ? await localize(db, lang, rendered) : rendered;
  try {
    const sent = await out.sendText(conv.channel_id, conv.external_id, textOut, { background: true });
    const ins = await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto, automation) VALUES ($1,'out',$2,$3,true,$4) RETURNING id`, [conv.id, textOut, sent.externalMessageId ?? null, kind]);
    await db.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conv.id]);
    out.notifyMessage(conv.channel_id, conv.id, ins.rows[0].id);
    return true;
  } catch { return false; }
}

/**
 * A person closed a hazard report: the reporter hears it was handled (once per inquiry, before the feedback question).
 * Not for conversations without the "מפגע" tag, comment threads, blocked or opted-out customers, or outside the reply window.
 */
export async function hazardDone(db: Db, out: AutoSender, convId: string): Promise<boolean> {
  const a = (await loadAutomations(db)).hazardDone;
  if (!a.enabled) return false;
  const hz = await db.query(`SELECT 1 FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = $1 AND lower(t.name) = 'מפגע'`, [convId]);
  if (!hz.rowCount) return false;
  const told = await db.query(`SELECT 1 FROM messages WHERE conversation_id = $1 AND automation = 'hazard_done'
                                AND created_at >= coalesce((SELECT max(opened_at) FROM cases WHERE conversation_id = $1), '-infinity')`, [convId]);
  if (told.rowCount) return false;
  const conv = (await db.query(`${CONV} WHERE c.id = $1 AND ${NOT_COMMENT}`, [convId])).rows[0] as ConvRow | undefined;
  return !!conv && sendAutomatic(db, out, conv, a.text, 'hazard_done');
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
/** "проблема решена", "все решилось", "можно закрыть заявку" (after ruNorm); not with "не" / "еще" / "но" */
const SOLVED_RU = /(^|\s)(решено|проблема решена|все решилось|вопрос решен|разобрались|разобрался|разобралась|можно закрыть|закройте (обращение|заявку|чат)|закрывайте)(\s|$)/;
/** "انحلت المشكله", "تم الحل", "اغلقوا الطلب" (after arNorm); not with "لا" / "لسا" / "لكن" */
const SOLVED_AR = /(^|\s)(انحلت|اتحلت|انحل|اتحل|تم الحل|تم حلها|حليتها|زبطت|ضبطت|اغلقوا (الطلب|المحادثه|الطلبيه)|ممكن (تغلقوا|اغلاق) (الطلب|المحادثه)|سكروا (الطلب|المحادثه))(\s|$)/;
export function isCloseRequest(textIn: string | null): boolean {
  if (!textIn) return false;
  const t = textIn.trim();
  if (!t || t.length > 140 || /[?؟]/.test(t)) return false;
  if (/[\u0400-\u04FF]/.test(t)) { const r = ruNorm(t.replace(/[!.,:;()«»]/g, ' ')); return SOLVED_RU.test(r) && !/(^|\s)(не|нет|еще не|но|пока)(\s|$)/.test(r); }
  if (/[\u0600-\u06FF]/.test(t)) { const a = arNorm(t.replace(/[!.,،:;()]/g, ' ')); return SOLVED_AR.test(a) && !/(^|\s)(لا|لم|لسا|لسه|لكن|بس|مش|ما زال)(\s|$)/.test(a); }
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

/**
 * The customer's answer to "did you get our answer? anything else?": 'missing' (they did not get one: a person must look),
 * 'done' (got it / nothing else: close kindly), 'more' (yes, something else: they will write it), or null (anything else: a new
 * question or request, handled as usual).
 */
/** the same answers in Russian (after ruNorm): "нет" / "не получил" → missing, "да" / "получила" → done, "есть еще вопрос" → more */
const REMINDER_RU: [RegExp, 'missing' | 'done' | 'more'][] = [
  [/^(нет|еще нет|пока нет|не получил(а)?|не получил(а)? ответ(а)?|никто не ответил|мне не ответили|не ответили|все еще жду|до сих пор жду|жду)( ответа)?$/, 'missing'],
  [/^(да|да,? спасибо|получил(а)?|да,? получил(а)?|нет,? спасибо|спасибо|все хорошо|все в порядке|все ок|ок)( спасибо| большое спасибо)?$/, 'done'],
  [/^((у меня )?(есть )?еще (один )?вопрос|да,? есть вопрос)$/, 'more'],
];
/** the same answers in Arabic (after arNorm): "لا" / "لم يصلني رد" → missing, "نعم" / "وصلني" → done, "عندي سؤال اخر" → more */
const REMINDER_AR: [RegExp, 'missing' | 'done' | 'more'][] = [
  [/^(لا|كلا|ليس بعد|مش بعد|لسا|لسه|لم (احصل|يصلني|يردوا|يرد)|ما (وصلني|اجاني|حدا رد|رد علي حدا|ردوا)|لا لم|ما زلت انتظر|لسا بستني|لسه مستني|لم يصلني رد|ما وصلني رد)( (شي|شيء|رد|بعد|ابدا))?$/, 'missing'],
  [/^(نعم|اه|ايوه|اجل|وصلني|وصلني الرد|حصلت|تم|نعم شكرا|نعم وصلني|لا شكرا|شكرا|كل شي تمام|تمام)( شكرا| شكرا جزيلا)?$/, 'done'],
  [/^(عندي سؤال (اخر|ثاني)|سؤال (اخر|ثاني)|نعم عندي سؤال|في عندي سؤال)$/, 'more'],
];
export function reminderAnswer(textIn: string | null | undefined): 'missing' | 'done' | 'more' | null {
  const t = (textIn ?? '').toLowerCase().replace(/[!.,?״"׳'():;\-–—\u{1F300}-\u{1FAFF}\u2600-\u27BF\u{FE0F}؟،]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 120) return null;
  if (/[\u0600-\u06FF]/.test(t)) { const a = arNorm(t); return REMINDER_AR.find(([re]) => re.test(a))?.[1] ?? null; }
  if (/[\u0400-\u04FF]/.test(t)) { const r = ruNorm(t.replace(/[«»]/g, ' ')).replace(/\s*,\s*/g, ', ').replace(/, /g, ' '); return REMINDER_RU.find(([re]) => re.test(r))?.[1] ?? null; }
  if (/(^|\s)(לא|עוד לא|עדיין לא)\s+(קיבלתי|קבלתי|קיבלנו|קיבלו|ענו|ענית|ענה|חזרו|חזר|חזרת|התקבלה|הגיעה|הגיע)|(^|\s)(אף אחד|איש) לא (ענה|חזר|התקשר)|לא קיבלתי (שום )?(תשובה|מענה)|עדיין מחכ|(^|\s)(עוד|עדיין) לא$|^לא ממש$|^(לא|no|nope)$|didn ?t (get|receive)|did not (get|receive)|(no|not) (an )?(answer|reply|response)( yet)?|not yet|still waiting|nobody (answered|replied|got back)/.test(t)) return 'missing';
  if (/^(כן|yes|yep|לא תודה|לא צריך|אין צורך|זהו|זה הכל|זה הכול|הכל טוב|הכול טוב|הכל בסדר|הכול בסדר|קיבלתי|קבלתי|כן קיבלתי|כן קיבלתי תודה|קיבלתי תודה|כן תודה|כן תודה רבה|קיבלתי תודה רבה|no|no thanks|nope|nothing else|got it|yes thanks|yes thank you|all good)( תודה| תודה רבה| thanks| thank you)?$/.test(t)) return 'done';
  if (/^(כן יש|יש|יש לי עוד שאלה|יש עוד שאלה|עוד שאלה|yes there is|i have another question)$/.test(t)) return 'more';
  return null;
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
                (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND m.automation IS NULL AND NOT m.auto) AS last_person,
                (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.automation = 'idle_reminder') AS last_reminder,
                c.bot_state
           FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
          WHERE c.status = 'open' AND (c.snoozed_until IS NULL OR c.snoozed_until <= $1) AND ${NOT_COMMENT})
       SELECT id, last_out, last_person, last_reminder, last_in, bot_state FROM t
        WHERE last_out IS NOT NULL AND (last_in IS NULL OR last_out > last_in)
        ORDER BY last_out LIMIT 50`,
      [now],
    );
    for (const r of rows as { id: string; last_out: Date; last_person: Date | null; last_reminder: Date | null; last_in: Date | null; bot_state: string | null }[]) {
      // handed to the team and no person has answered the customer's last message yet: the team owes the answer. Betty's own
      // "passed to the team" line is not "our side answered", so the customer is never told they did not reply, nor closed on.
      if (r.bot_state === 'human' && r.last_in && (!r.last_person || r.last_person.getTime() < r.last_in.getTime())) continue;
      const reminded = !!r.last_reminder && r.last_reminder > r.last_out;
      const since = (d: Date) => (now.getTime() - d.getTime()) / 60_000;
      const conv = (await db.query(`${CONV} WHERE c.id = $1`, [r.id])).rows[0] as ConvRow;
      // "did you get our answer?" only after an answer from a person: never after the bot's own menu or question (the customer
      // has nothing to "get" there, and answering it would bring the menu and, later, the same question again), and at most once a day
      const askable = !!r.last_person && r.last_person.getTime() >= r.last_out.getTime() && !(r.last_reminder && since(r.last_reminder) < 24 * 60);
      if (!askable && !reminded) {
        if (since(r.last_out) >= a.idle.reminderAfter + a.idle.closeAfter) {
          const sent = a.idle.closeText ? await sendAutomatic(db, out, conv, a.idle.closeText, 'idle_close') : false;
          await close(db, out, r.id, `השיחה נסגרה אוטומטית: הלקוח לא הגיב${a.idle.closeText && !sent ? ' (הודעת הסגירה לא נשלחה)' : ''}. הודעה חדשה מהלקוח תפתח אותה מחדש.`);
          done.closed++;
        }
        continue;
      }
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
  await runComfort(db, out, now).catch(() => undefined);
  return done;
}

/**
 * Betty stays with a stressed customer (empathy.ts) until a person answers: follow-ups 5, 15 and 30 minutes after her first
 * comforting message, as long as nobody from the team has written since and the conversation is open. At 15 minutes the team is
 * alerted again and an unassigned conversation is routed again. Outside working hours one follow-up only. A person's message,
 * or closing the conversation, ends it.
 */
export async function runComfort(db: Db, out: AutoSender, now = new Date()): Promise<{ sent: number; ended: number }> {
  const done = { sent: 0, ended: 0 };
  const { rows } = await db.query(
    `SELECT c.id, c.status, c.comfort_since, c.comfort_steps, c.assigned_to,
            EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND NOT m.auto AND m.created_at > c.comfort_since) AS answered
       FROM conversations c WHERE c.comfort_since IS NOT NULL ORDER BY c.comfort_since LIMIT 100`);
  const hours = await loadBusinessHours(db);
  const closed = hours.enabled && !isOpen(hours, now);
  for (const r of rows as { id: string; status: string; comfort_since: Date; comfort_steps: number; assigned_to: string | null; answered: boolean }[]) {
    if (r.status !== 'open' || r.answered || r.comfort_steps >= FOLLOW_UP_AFTER.length) {
      await db.query('UPDATE conversations SET comfort_since = NULL WHERE id = $1', [r.id]); done.ended++; continue;
    }
    const due = FOLLOW_UP_AFTER[r.comfort_steps]!;
    if ((now.getTime() - new Date(r.comfort_since).getTime()) / 60_000 < due) continue;
    const step = (r.comfort_steps + 1) as 1 | 2 | 3;
    if (step === 2) {
      let to = r.assigned_to;
      if (!to) { to = await autoAssign(db, r.id).catch(() => null); if (to) out.onAssigned?.(r.id, to); }
      out.alertTeam?.(`💛 לקוח לחוץ מחכה כבר ${due} דקות בלי מענה מהצוות${to ? '' : ' ועדיין לא שויך'}. נא לחזור אליו עכשיו.`, { conversationId: r.id });
      await db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)`, [r.id, `💛 עברו ${due} דקות בלי מענה מהצוות ללקוח לחוץ. נשלחה התראה נוספת.`]);
    }
    const conv = (await db.query(`${CONV} WHERE c.id = $1`, [r.id])).rows[0] as ConvRow | undefined;
    if (!conv) continue;
    const body = followUpText(step, { who: conv.agent_name, closed, hours: closed ? hoursSummary(hours) : undefined });
    if (await sendAutomatic(db, out, conv, body, 'comfort_follow')) done.sent++;
    // outside working hours one follow-up is enough; otherwise the next step
    await db.query('UPDATE conversations SET comfort_steps = $2 WHERE id = $1', [r.id, closed ? FOLLOW_UP_AFTER.length : step]);
  }
  return done;
}

/** The closing message when a person closes a conversation (if they chose to send it). */
export async function sendClosingMessage(db: Db, out: AutoSender, convId: string): Promise<boolean> {
  const a = await loadAutomations(db);
  const conv = (await db.query(`${CONV} WHERE c.id = $1`, [convId])).rows[0] as ConvRow | undefined;
  return !!conv && !!a.closing.text && sendAutomatic(db, out, conv, a.closing.text, 'closing');
}
