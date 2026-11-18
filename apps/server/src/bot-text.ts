import { arNorm } from './i18n/lang.js';
/**
 * Variables in the bot's own messages (welcome, flow messages, questions and menus): who the bot is and who it talks to.
 * Only these names are replaced; anything else in curly braces is sent as written.
 */
export const BOT_TEXT_VARIABLES = [
  ['{בוט}', 'שם הבוט (למשל בטי). בלי שם: "הבוט"'],
  ['{שם פרטי}', 'השם הפרטי של הלקוח, אם הוא כבר מוכר'],
  ['{שם}', 'השם המלא של הלקוח, אם הוא כבר מוכר'],
  ['{ברכה}', 'ברכה לפי השעה: בוקר טוב, צהריים טובים, ערב טוב או לילה טוב'],
] as const;

export interface BotTextContext { botName?: string | null; fullName?: string | null; /** the greeting of this hour ("בוקר טוב"); default "שלום" */ greeting?: string | null;
  /** the customer called the bot by name, or it introduced itself in this conversation already: leave out "כאן {בוט}…" */ skipIntro?: boolean;
  /** the conversation's language: what to call a bot that has no name ("הבוט", "the bot", "روبوت المحادثة") */ lang?: 'he' | 'en' | 'ar' }
const NO_NAME = { he: 'הבוט', en: 'the bot', ar: 'روبوت المحادثة' } as const;

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The bot's self-introduction taken out ("…שוב! כאן {בוט} מיחידת הבטיחות 😊" → "…שוב! 😊", "{ברכה}, כאן {בוט} מיחידת הבטיחות 👋" →
 * "{ברכה} 👋", "This is {בוט} from the Safety Unit"): for a customer who already knows who they are talking to.
 */
export function withoutIntro(text: string, botName?: string | null): string {
  const who = ['\\{בוט\\}', '\\{bot\\}', ...((botName ?? '').trim().length >= 2 ? [escRe(botName!.trim())] : [])].join('|');
  // the name as a whole word ("בטי", not the start of "בטיחות"), then only "מיחידת …" / "של …" / "from …" up to the end of that phrase;
  // never across a line break (a menu may follow on the next line)
  const end = '(?=$|[ \\t,.!?…:;\\n]|\\p{Extended_Pictographic})';
  const tail = '(?:[ \\t]+(?:מיחידת|של|from)(?:[ \\t]+[^\\s.,!?:;\\p{Extended_Pictographic}]+){1,4})?[ \\t]*[.!]?';
  return text
    .replace(new RegExp(`[,،]?[ \\t]*(?:כאן|זאת|זו|זה)[ \\t]+(?:${who})${end}${tail}`, 'gu'), ' ')
    .replace(new RegExp(`[,]?[ \\t]*(?:this is|it's|i'm|i am)[ \\t]+(?:${who})${end}${tail}`, 'giu'), ' ')
    .replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?:;])/g, '$1').replace(/^[ \t]+|[ \t]+$/gm, '');
}

/** Part of the day at the business's time zone: morning 05–12, noon 12–17, evening 17–22, night 22–05. */
export type DayPart = 'morning' | 'noon' | 'evening' | 'night';
export function dayPart(now: Date = new Date(), timeZone = 'Asia/Jerusalem'): DayPart {
  let h: number;
  try { h = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now)); } catch { h = now.getHours(); }
  return h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'noon' : h >= 17 && h < 22 ? 'evening' : 'night';
}
const GREETING = {
  he: { morning: 'בוקר טוב', noon: 'צהריים טובים', evening: 'ערב טוב', night: 'לילה טוב' },
  en: { morning: 'Good morning', noon: 'Good afternoon', evening: 'Good evening', night: 'Hello' },
  ar: { morning: 'صباح الخير', noon: 'نهارك سعيد', evening: 'مساء الخير', night: 'مساء الخير' },
} as const;
/** "בוקר טוב" / "Good evening"…: what to say at this hour. */
export const greetingFor = (part: DayPart, lang: 'he' | 'en' | 'ar' = 'he'): string => GREETING[lang][part];

/** "לילה טוב", "יום טוב", "תודה ולילה טוב", "good night": the customer is saying goodbye (not a new request, nothing to choose). */
const BYE = /^((תודה|תודה רבה|thanks|thank you)\s*,?\s*(ו|and )?\s*)?(לילה טוב|ליל מנוחה|יום טוב|המשך יום טוב|יום נעים|המשך יום נעים|ערב טוב ונעים|ערב נעים|המשך ערב נעים|סוף שבוע נעים|שבת שלום|good ?night|nighty night|have a (good|nice|great) (day|night|evening|weekend))(\s+(לך|לכם|גם לך|גם לכם|ותודה|תודה|ותודה רבה|תודה רבה|and thanks|thanks|to you|too|bye|ביי))*$/;
/** the same in Arabic (after arNorm): "تصبح على خير", "مع السلامه", "يوم سعيد", "شكرا ومع السلامه" */
const BYE_AR = /^((شكرا|شكرا جزيلا)\s*(و)?\s*)?(تصبح علي خير|تصبحي علي خير|تصبحين علي خير|تصبحوا علي خير|تصبحون علي خير|ليله سعيده|مع السلامه|يوم سعيد|يومك سعيد|نهارك سعيد|مساء سعيد|نهايه اسبوع سعيده|عطله سعيده|الى اللقاء|باي)(\s+(وشكرا|شكرا|لك|لكم|كمان|ايضا|باي))*$/;
export function isFarewell(text: string | null | undefined): boolean {
  const t = (text ?? '').toLowerCase().replace(/[!.,״"׳:;()\u200e\u200f\u{1F300}-\u{1FAFF}\u2600-\u27BF\u{FE0F}،]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60 || /[?؟]/.test(text ?? '')) return false;
  return BYE.test(t) || (/[\u0600-\u06FF]/.test(t) && BYE_AR.test(arNorm(t)));
}
/** Betty's goodbye, fitting the hour (a "לילה טוב" at noon gets "המשך יום נעים"; "שבת שלום" is answered in kind). */
export function farewellReply(text: string, part: DayPart): string {
  if (/שבת שלום/.test(text)) return 'שבת שלום 🕯️ אם יעלה משהו, אני כאן.';
  if (/סוף שבוע/.test(text) || /weekend/i.test(text) || /اسبوع|عطله|عطلة/.test(text)) return 'סוף שבוע נעים ☀️ אם יעלה משהו, אני כאן.';
  return part === 'night' ? 'לילה טוב 🌙 אם יעלה משהו, אני כאן.' : part === 'evening' ? 'ערב נעים 🌆 אם יעלה משהו, אני כאן.' : 'המשך יום נעים ☀️ אם יעלה משהו, אני כאן.';
}

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
export function renderBotText(text0: string, c: BotTextContext): string {
  const text = c.skipIntro ? withoutIntro(text0, c.botName) : text0;
  if (!text.includes('{')) return text;
  const full = cleanName(c.fullName);
  const vals: Record<string, string> = {
    'בוט': (c.botName ?? '').replace(/[\r\n]+/g, ' ').trim() || NO_NAME[c.lang ?? 'he'], 'bot': (c.botName ?? '').trim() || NO_NAME[c.lang ?? 'he'],
    'שם פרטי': firstName(full), 'first name': firstName(full),
    'שם': full, 'name': full,
    'ברכה': (c.greeting ?? '').trim() || 'שלום', 'greeting': (c.greeting ?? '').trim() || 'Hello',
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
/** The same questions in English. */
const WHO_EN = /^(who are you|who is this|what('?s| is) your name|who am i (talking|speaking|chatting|writing) (to|with)|are you (a |an )?(bot|robot|machine|ai|human|real( person)?|person|chatbot)|is this (a )?(bot|robot|real person|human))$/;
const ONLY = new Set(['מי זה', 'מי זאת', 'בוט', 'bot', 'רובוט']);
/** The same questions in Arabic (after arNorm): "من انت؟", "هل انت روبوت؟", "هل انا اتحدث مع انسان؟" */
const WHO_AR = /^(من (انت|انتي|حضرتك|معي|معاي|هذا|هذه)|ما (اسمك|هو اسمك)|شو اسمك|(هل )?(انت|انتي) (روبوت|بوت|انسان|انسانه|حقيقي|حقيقيه|اله|ذكاء اصطناعي)|(هل )?(انا )?(اتحدث|احكي|اتكلم) مع (روبوت|بوت|انسان|شخص|موظف حقيقي))$/;
export function identityReply(text: string | null | undefined, persona: { name?: string | null; role?: string | null }): string | null {
  const t = (text ?? '').toLowerCase().replace(/[?!.,״"׳:;()\u200e\u200f؟،]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 7 || !(ONLY.has(t) || WHO.test(t) || BOT_YOU.test(t) || BOT_IT.test(t) || WHO_EN.test(t) || WHO_AR.test(arNorm(t)))) return null;
  const name = (persona.name ?? '').trim();
  const role = (persona.role ?? '').trim();
  const me = name ? `אני ${name}${role ? `, ${role}` : ', הבוט של השירות'}` : `אני ${role || 'הבוט של השירות'}`;
  return `${me} 🤖 זה בוט, לא בן אדם: התשובות מגיעות מהמידע של היחידה, ופניות מועברות לצוות. כדי לדבר עם נציג, אפשר לכתוב "נציג" בכל רגע.`;
}

/**
 * The bot's own name in a message ("היי בטי", "בטי, מה זה…", "תודה בטי") is not part of what is asked: it is taken out before the
 * greeting check and the knowledge-base search. Whole words only ("בטיחות" stays); nothing changes when only the name was written.
 */
export function withoutBotName(text: string | null, name: string | null | undefined): string | null {
  const n = (name ?? '').trim();
  if (!text || n.length < 2) return text;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = text.replace(new RegExp(`(^|[\\s,.!?:;״"'׳()])(?:ו|ה)?${esc}(?=$|[\\s,.!?:;״"'׳()])`, 'g'), '$1').replace(/^[\s,.:;]+/, '').replace(/\s{2,}/g, ' ').trim();
  return out.length ? out : text;
}

/** Does the message call the bot by its name ("היי בטי", "בטי?", "תודה בטי")? Whole words only ("בטיחות" is not her name). */
export function mentionsName(text: string | null | undefined, name: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  if (!text || n.length < 2) return false;
  return new RegExp(`(^|[\\s,.!?:;״"'׳()])(?:ו|ה)?${escRe(n)}(?=$|[\\s,.!?:;״"'׳()])`, 'i').test(text);
}

/** Small talk ("מה שלומך?", "מה נשמע?", "מה קורה?"): a short friendly answer; null for anything else. */
const HOW = /^(ו?מה שלומך|מה שלומכם|מה נשמע|מה נשמע איתך|מה קורה|מה קורה איתך|מה העניינים|מה איתך|איך את|איך אתה|איך הולך|איך היום שלך|מה המצב|מה מצבך|הכל טוב|הכול טוב|הכל בסדר|הכול בסדר)( איתך| אצלך| היום)?$/;
/** "את כאן?", "יש מישהו?", "הלו?", or just the bot's name: Betty is here (never taken as an answer to the question she asked). */
const HERE = /^(את|אתה|עדיין|את עדיין|אתה עדיין) (כאן|פה|שם|איתי|איתנו|זמינה|זמין|ערה|ער|מחוברת|מחובר|שומעת|שומע|קוראת|קורא)$|^(יש|יש פה|יש כאן|יש שם)? ?מישהו( כאן| פה| שם)?$|^(הלו+|הללו|הי+|היי+)$|^(את|אתה) עונה( לי)?$/;
const HOW_EN = /^(hi |hello |hey )?(how are you( doing| today)?|how('?s| is) it going|how are things|what'?s up|how do you do)$/;
const HERE_EN = /^(hi |hello |hey )?(are you (there|here|still there|still here|online|with me|awake|listening)|(is )?(any ?one|any ?body|someone|somebody) (there|here)|you there|still there)$/;
export function smallTalkReply(text: string | null | undefined, botName?: string | null): string | null {
  const t = (text ?? '').toLowerCase().replace(/[?!.,״"׳:;()\u200e\u200f\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, ' ').replace(/^(היי|הי|שלום|אהלן|בוקר טוב|ערב טוב|צהריים טובים|לילה טוב|hi|hello|hey|good (morning|afternoon|evening))\s+/, '').replace(/\s+/g, ' ').trim();
  if (!t) return /^\s*[?？]+\s*$/.test(text ?? '') ? 'כן, אני כאן איתך 😊' : null;   // a lone "?" (or "בטי?"): are you there?
  if (HOW.test(t) || HOW_EN.test(t)) return 'תודה ששאלת, הכול טוב אצלי 😊 במה אפשר לעזור?';
  if (HERE_EN.test(t)) return 'כן, אני כאן איתך 😊';
  if (/[\u0600-\u06FF]/.test(t)) {   // Arabic: "كيف حالك؟", "شو الاخبار", "هل انت هنا؟", "في حدا؟"
    const a = arNorm(t.replace(/[؟،]/g, ' ')).replace(/^(مرحبا|اهلا|السلام عليكم|صباح الخير|مساء الخير|هاي)\s+/, '');
    if (/^(كيف (حالك|الحال|حالكم|الاحوال)|شو (الاخبار|اخبارك|الوضع)|كيفك|كيفك اليوم|ازيك)$/.test(a)) return 'תודה ששאלת, הכול טוב אצלי 😊 במה אפשר לעזור?';
    if (/^((هل )?(انت|انتي) (هنا|موجوده|موجود|معي|معاي)|(في|فيه|هل يوجد) (حدا|احد)( هنا)?|حدا هون)$/.test(a)) return 'כן, אני כאן איתך 😊';
  }
  const name = (botName ?? '').trim().toLowerCase();
  if ((HERE.test(t) && !/^(הי+|היי+)$/.test(t)) || (name && t.replace(/^(ו|ה)/, '') === name)) return 'כן, אני כאן איתך 😊';
  return null;
}
