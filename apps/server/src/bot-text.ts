/**
 * Variables in the bot's own messages (welcome, flow messages, questions and menus): who the bot is and who it talks to.
 * Only these names are replaced; anything else in curly braces is sent as written.
 */
export const BOT_TEXT_VARIABLES = [
  ['{בוט}', 'שם הבוט (למשל בטי). בלי שם: "הבוט"'],
  ['{שם פרטי}', 'השם הפרטי של הלקוח, אם הוא כבר מוכר'],
  ['{שם}', 'השם המלא של הלקוח, אם הוא כבר מוכר'],
] as const;

export interface BotTextContext { botName?: string | null; fullName?: string | null }

/** A plausible person's name: letters (any script), spaces, apostrophes, hyphens and dots only, 2–60 characters. */
const NAME = /^[\p{L}][\p{L}\p{M}'’״׳.\- ]{1,59}$/u;
/** Names the system itself gives to unknown visitors, and the like: never greet someone with these. */
const PLACEHOLDER = /^(מבקר|אורח|לקוח|visitor|guest|customer|unknown)/i;

/** The name we may call the customer by, or '' (a phone number, an emoji nickname or a placeholder is not a name). */
export function cleanName(s: string | null | undefined): string {
  const v = (s ?? '').replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
  return NAME.test(v) && !PLACEHOLDER.test(v) ? v : '';
}

/** The first word of a full name ("יוסי כהן" → "יוסי"); '' when the name is not usable. */
export function firstName(full: string | null | undefined): string {
  const n = cleanName(full);
  return n ? n.split(' ')[0]!.replace(/[.\-]+$/, '') : '';
}

/** Fill the bot variables. A missing value leaves no stray punctuation behind ("שלום {שם פרטי}!" → "שלום!"). */
export function renderBotText(text: string, c: BotTextContext): string {
  if (!text.includes('{')) return text;
  const full = cleanName(c.fullName);
  const vals: Record<string, string> = {
    'בוט': (c.botName ?? '').replace(/[\r\n]+/g, ' ').trim() || 'הבוט', 'bot': (c.botName ?? '').trim() || 'הבוט',
    'שם פרטי': firstName(full), 'first name': firstName(full),
    'שם': full, 'name': full,
  };
  let empty = false;
  const out = text.replace(/\{([^{}\n]{1,20})\}/g, (m, k: string) => { if (!Object.hasOwn(vals, k)) return m; if (!vals[k]) empty = true; return vals[k]!; });
  return empty ? out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?:;])/g, '$1').replace(/,([.!?:;,])/g, '$1').replace(/^[ \t]*[,.!?:;][ \t]*/gm, '').trim() : out;
}

/**
 * "מי את?", "את בוט?", "איך קוראים לך?": the bot answers who it is, honestly (a bot, not a person) and by its persona name,
 * and how to reach a person. Only short messages that are such a question; null otherwise (the normal flow answers).
 */
const WHO = /(^|\s)(מי את|מי אתה|מה שמך|מה השם שלך|איך קוראים לך|עם מי אני (מדבר|מדברת|מתכתב|מתכתבת))(\s|$)/;
/** "את/אתה …" may ask about anything that the bot is; "זה/זאת …" only about being a machine (so "זה אמיתי ש…?" is a real question) */
const BOT_YOU = /(^|\s)(את|אתה)\s+(בוט|רובוט|מכונה|מחשב|בינה מלאכותית|ai|צ'?אטבוט|אמיתי|אמיתית|בן אדם|בת אדם|נציג אמיתי|נציגה אמיתית)(\s|$)/i;
const BOT_IT = /(^|\s)(זה|זאת|אני (מדבר|מדברת) עם|(מדבר|מדברת) עם)\s+(בוט|רובוט|מכונה|בינה מלאכותית|ai|צ'?אטבוט|בן אדם|נציג אמיתי)(\s|$)/i;
const ONLY = new Set(['מי זה', 'מי זאת', 'בוט', 'רובוט']);
export function identityReply(text: string | null | undefined, persona: { name?: string | null; role?: string | null }): string | null {
  const t = (text ?? '').toLowerCase().replace(/[?!.,״"׳:;()\u200e\u200f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 7 || !(ONLY.has(t) || WHO.test(t) || BOT_YOU.test(t) || BOT_IT.test(t))) return null;
  const name = (persona.name ?? '').trim();
  const role = (persona.role ?? '').trim();
  const me = name ? `אני ${name}${role ? `, ${role}` : ', הבוט של השירות'}` : `אני ${role || 'הבוט של השירות'}`;
  return `${me} 🤖 זה בוט, לא בן אדם: התשובות מגיעות מהמידע של היחידה, ופניות מועברות לצוות. כדי לדבר עם נציג, אפשר לכתוב "נציג" בכל רגע.`;
}
