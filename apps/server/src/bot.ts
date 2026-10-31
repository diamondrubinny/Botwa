import { z } from 'zod';
import type { Db } from './db.js';

export const botSchema = z.object({
  enabled: z.boolean(),
  welcome: z.string().trim().min(1).max(1000),
  /** menu entries; numbered 1..N in order */
  items: z.array(z.object({ title: z.string().trim().min(1).max(60), answer: z.string().trim().min(1).max(1500) })).max(9),
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
};

export async function loadBot(db: Db): Promise<BotConfig> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'bot'`);
  const p = botSchema.safeParse(rows[0]?.value);
  return p.success ? p.data : DEFAULT_BOT;
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
export type HandoffReason = 'requested' | 'unrecognized' | 'media';
export interface Decision { replies: string[]; next: BotState; handoff?: HandoffReason }

const MENU_WORDS = new Set(['תפריט', 'menu', 'תפריט ראשי', 'start', 'התחלה']);

/** Pure decision function: what the bot answers to one customer message, and the next state. */
export function decide(bot: BotConfig, st: BotState, text: string | null): Decision {
  if (!bot.enabled || st.state === 'human') return { replies: [], next: st };
  const handoff = (reason: HandoffReason): Decision => ({ replies: [], next: { state: 'human', invalid: 0 }, handoff: reason });
  if (text === null) return handoff('media'); // files, stickers, locations... need a person

  const t = normalize(text);
  if ((bot.humanOption && t === '0') || bot.humanKeywords.some((k) => t.includes(normalize(k)))) return handoff('requested');

  const menu = (invalid: number, prefix = ''): Decision => ({ replies: [`${prefix}${formatMenu(bot)}`], next: { state: 'menu', invalid } });
  if (st.state === null || MENU_WORDS.has(t)) return menu(0);

  let item = /^\d{1,2}$/.test(t) ? bot.items[Number(t) - 1] : undefined;
  item ??= bot.items.find((it) => normalize(it.title) === t);
  if (item) return { replies: [bot.footer ? `${item.answer}\n\n${bot.footer}` : item.answer], next: { state: 'menu', invalid: 0 } };

  if (st.invalid < bot.invalidRetries) return menu(st.invalid + 1, `${bot.invalidMessage}\n\n`);
  return handoff('unrecognized');
}
