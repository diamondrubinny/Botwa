import { z } from 'zod';
import type { Db } from './db.js';

export const botSchema = z.object({
  enabled: z.boolean(),
  welcome: z.string().trim().min(1).max(1000),
  /** menu entries; numbered 1..N in order */
  items: z.array(z.object({
    title: z.string().trim().min(1).max(60),
    answer: z.string().trim().min(1).max(1500),
    /** optional referral: the answer ends with a click-to-chat WhatsApp link to a named person (e.g. the safety officer for this topic) */
    contact: z.object({
      name: z.string().trim().min(1).max(60),
      /** digits with country code; a leading 0 (Israeli local format) is converted to 972 */
      phone: z.string().trim().regex(/^\+?[\d\s-]{8,18}$/),
      /** text pre-filled in the customer's message to that person */
      message: z.string().trim().max(200).default(''),
    }).optional(),
    /** optional routing: after the answer the conversation is handed to this staff member (stays in the system); falls back to normal routing if they are inactive */
    route: z.object({ userId: z.string().uuid() }).optional(),
  })).max(9),
  /** option "0" = talk to a person */
  humanOption: z.boolean(),
  humanLabel: z.string().trim().min(1).max(40),
  /** any message containing one of these (case-insensitive) hands over to a person */
  humanKeywords: z.array(z.string().trim().min(2).max(30)).max(10),
  humanMessage: z.string().trim().min(1).max(500),
  invalidMessage: z.string().trim().min(1).max(300),
  /** how many unrecognised messages are answered with the menu before handing over (0 = hand over at once) */
  invalidRetries: z.number().int().min(0).max(3),
  footer: z.string().trim().max(300),
  /** answer free-text questions from the knowledge base (no AI: keyword search over the documents, links and FAQ staff added) */
  kb: z.object({
    enabled: z.boolean(),
    /** minimum match score (0-1); higher = fewer but safer answers */
    minScore: z.number().min(0.3).max(1),
    maxChars: z.number().int().min(200).max(1500),
    showSource: z.boolean(),
    intro: z.string().trim().max(120),
  }).default({ enabled: false, minScore: 0.6, maxChars: 700, showSource: true, intro: 'מצאתי את זה במאגר המידע שלנו:' }),
});
export type BotConfig = z.infer<typeof botSchema>;

export const DEFAULT_BOT: BotConfig = {
  enabled: false,
  welcome: 'שלום! אני הבוט של השירות. במה אפשר לעזור? השיבו במספר:',
  items: [
    { title: 'שעות פעילות', answer: 'אנחנו פעילים בימים א׳–ה׳ בין 9:00 ל-17:00.' },
    { title: 'פרטי יצירת קשר', answer: 'אפשר ליצור איתנו קשר גם בטלפון או באימייל: [להשלים].' },
  ],
  humanOption: true,
  humanLabel: 'נציג אנושי',
  humanKeywords: ['נציג', 'agent', 'human'],
  humanMessage: 'מעביר אותך לנציג. נחזור אליך בהקדם.',
  invalidMessage: 'לא הבנתי את הבחירה.',
  invalidRetries: 1,
  footer: 'לחזרה לתפריט שלחו "תפריט". לנציג שלחו "נציג".',
  kb: { enabled: false, minScore: 0.6, maxChars: 700, showSource: true, intro: 'מצאתי את זה במאגר המידע שלנו:' },
};

export async function loadBot(db: Db): Promise<BotConfig> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'bot'`);
  const p = botSchema.safeParse(rows[0]?.value);
  return p.success ? p.data : DEFAULT_BOT;
}

/** https://wa.me click-to-chat link; Israeli local numbers (05x...) become 972... */
export function waLink(phone: string, message = ''): string {
  let d = phone.replace(/\D/g, '').replace(/^00/, '');
  if (/^0\d{8,9}$/.test(d)) d = `972${d.slice(1)}`;
  return `https://wa.me/${d}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

/** The text sent for a menu item: its answer plus, when configured, the referral link. */
export function itemReply(it: BotConfig['items'][number]): string {
  return it.contact ? `${it.answer}\n\n${it.contact.name}:\n${waLink(it.contact.phone, it.contact.message)}` : it.answer;
}

export function formatMenu(bot: BotConfig): string {
  const lines = bot.items.map((it, i) => `${i + 1}. ${it.title}`);
  if (bot.humanOption) lines.push(`0. ${bot.humanLabel}`);
  return `${bot.welcome}\n\n${lines.join('\n')}`;
}

/** Lower-case, strip direction marks / punctuation / keycap emoji parts, map Arabic-Indic & Persian digits to ASCII. */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‎‏‪-‮⁦-⁩️⃣]/g, '')
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/[.!?,:;'"״׳()[\]*#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface BotState { state: 'menu' | 'human' | null; invalid: number }
export type HandoffReason = 'requested' | 'unrecognized' | 'media' | 'topic';
export interface Decision { replies: string[]; next: BotState; handoff?: HandoffReason; /** topic hand-over: the menu item chosen and the person responsible */ topic?: { title: string; userId: string } }

const MENU_WORDS = new Set(['תפריט', 'menu', 'תפריט ראשי', 'start', 'התחלה']);

/** Pure decision function: what the bot answers to one customer message, and the next state. */
/** `kbAnswer`: a confident answer from the knowledge base for this text (computed by the caller; the function itself stays pure). */
export function decide(bot: BotConfig, st: BotState, text: string | null, kbAnswer: string | null = null): Decision {
  if (!bot.enabled || st.state === 'human') return { replies: [], next: st };
  const handoff = (reason: HandoffReason): Decision => ({ replies: [], next: { state: 'human', invalid: 0 }, handoff: reason });
  if (text === null) return handoff('media'); // files, stickers, locations... need a person

  const t = normalize(text);
  if ((bot.humanOption && t === '0') || bot.humanKeywords.some((k) => t.includes(normalize(k)))) return handoff('requested');

  const menu = (invalid: number, prefix = ''): Decision => ({ replies: [`${prefix}${formatMenu(bot)}`], next: { state: 'menu', invalid } });
  if (MENU_WORDS.has(t)) return menu(0);
  // a free-text question the knowledge base can answer is answered at once, even as the very first message
  if (kbAnswer && !/^\d{1,2}$/.test(t) && !bot.items.some((it) => normalize(it.title) === t)) {
    return { replies: [bot.footer ? `${kbAnswer}\n\n${bot.footer}` : kbAnswer], next: { state: 'menu', invalid: 0 } };
  }
  if (st.state === null) return menu(0);

  let item = /^\d{1,2}$/.test(t) ? bot.items[Number(t) - 1] : undefined;
  item ??= bot.items.find((it) => normalize(it.title) === t);
  if (item?.route) {
    const body = itemReply(item);
    return { replies: [body], next: { state: 'human', invalid: 0 }, handoff: 'topic', topic: { title: item.title, userId: item.route.userId } };
  }
  if (item) { const body = itemReply(item); return { replies: [bot.footer ? `${body}\n\n${bot.footer}` : body], next: { state: 'menu', invalid: 0 } }; }

  if (st.invalid < bot.invalidRetries) return menu(st.invalid + 1, `${bot.invalidMessage}\n\n`);
  return handoff('unrecognized');
}
