import { arNorm } from '../i18n/lang.js';
import type { Db } from '../db.js';

/**
 * "מי הממונה על בטיחות אש?", "מה הטלפון של ממונה הגזים?", "למי פונים בנושא לייזרים?": Betty answers from the officers list
 * (Safety > officers and topics): name, office phone and e-mail. Only officers marked as public; their WhatsApp (often a personal
 * mobile) only when allowed for that officer. Asked about contact but no topic recognised: the topics there are officers for.
 */
const ASK_EN = /\b(head of (the )?(safety )?unit|unit head|officer|in charge|responsible|who handles|who deals|contact (for|of)|phone (number )?(of|for)|email (of|for))\b/i;
const ASK = /((מי|מיהו|מיהי|מי זה|מי זאת)\s+(ה)?(ראש|מנהל|מנהלת)\s+(ה)?(יחידה|יחידת|היחידה)|ממונה|ממונת|ממוני|אחראי|אחראית|מי מטפל|מי מטפלת|למי (לפנות|פונים|אפשר לפנות)|טלפון|מספר (ה)?טלפון|פרטי (ה)?קשר|איך (משיגים|יוצרים קשר|מגיעים ל)|מייל|אימייל|מי (ה)?ממונה)/;
/** Customer words → words that appear in topic names (so "שריפה" finds "גילוי אש" and "מתזים"). */
const ALIASES: [RegExp, string[]][] = [
  [/^(אש|שריפ|שרפ|דליק|כיבוי|מטפ|ספרינקלר|עשן|כבאות)/, ['אש', 'מתזים', 'כיבוי', 'כבאות']],
  [/^(גז|גזים|גפמ|גפ"ם|גפ״ם|בלון|בלונים|צילינדר|חמצן|חנקן)/, ['גז', 'גפ']],
  [/^(לייזר|ליזר)/, ['לייזר', 'ליזר']],
  [/^(קרינה|רדיו|רנטגן|מייננת)/, ['קרינה']],
  [/^(כימי|כימיקל|חומס|חומ"ס|חומ״ס|מסוכנ|פסולת)/, ['כימ', 'חומ']],
  [/^(חשמל)/, ['חשמל']],
  [/^(גובה|סולם|סולמות|פיגום|פיגומים|גג|מעקה|מעקות)/, ['גובה', 'סולמ', 'פיגומ', 'מעק']],
  [/^(מעלית|מעליות|מעלון)/, ['מעלי', 'מעלו']],
  [/^(ביולוג|ביו|חיידק|נגיפ|bio)/i, ['biosafety', 'ביולוג']],
  [/^(אסבסט)/, ['אסבסט']],
  [/^(רעש)/, ['רעש']],
  [/^(הרמה|עגורן|מנוף|מלגזה)/, ['הרמה', 'עגורנ']],
  [/^(לחץ|דוד|דודים|קיטור)/, ['לחץ', 'דוד']],
  [/^(חפירה|חפירות)/, ['חפיר']],
  [/^(מכונה|מכונות|מיגון)/, ['מכונ', 'מיגון']],
  [/^(הדרכה|הדרכות|קורס)/, ['הדרכ']],
  [/^(גיהות|ניטור)/, ['גיהות', 'ניטור']],
  [/^(חלל|מוקף)/, ['חלל']],
  [/^(מפגע|מפגעים)/, ['מפגע']],
  [/^(תאורה)/, ['תאורה']],
  // the head of the unit ("מי ראש יחידת הבטיחות?"): an officer entered with the topic "ראש יחידת הבטיחות"
  [/^(ראש|head)$/i, ['ראש יחידה', 'ראש היחידה', 'ראש יחידת']],
  // English words → the Hebrew topic names
  [/^(lasers?)$/i, ['לייזר']], [/^(asbestos)$/i, ['אסבסט']], [/^(radiation|radioactive|x-?rays?)$/i, ['קרינה']],
  [/^(fire|fires|extinguishers?|sprinklers?|smoke)$/i, ['אש', 'מתזים', 'כיבוי', 'כבאות']], [/^(gas|gases|cylinders?|lpg)$/i, ['גז', 'גפ']],
  [/^(chemicals?|chemistry|hazmat|waste)$/i, ['כימ', 'חומ']], [/^(electric(al|ity)?)$/i, ['חשמל']],
  [/^(heights?|ladders?|scaffold(s|ing)?|roofs?|railings?)$/i, ['גובה', 'סולמ', 'פיגומ', 'מעק']], [/^(elevators?|lifts?)$/i, ['מעלי', 'מעלו']],
  [/^(bio(safety|logical)?)$/i, ['biosafety', 'ביולוג']], [/^(noise)$/i, ['רעש']], [/^(cranes?|forklifts?|lifting)$/i, ['הרמה', 'עגורנ']],
  [/^(pressure|boilers?)$/i, ['לחץ', 'דוד']], [/^(training|courses?)$/i, ['הדרכ']], [/^(hygiene|monitoring)$/i, ['גיהות', 'ניטור']],
  [/^(hazards?)$/i, ['מפגע']], [/^(machines?|machinery|guarding)$/i, ['מכונ', 'מיגון']], [/^(lighting)$/i, ['תאורה']],
];
const STOP = new Set(['ממונה', 'ממונת', 'ממוני', 'על', 'של', 'מי', 'מה', 'את', 'הטלפון', 'טלפון', 'מספר', 'בנושא', 'נושא', 'בטיחות', 'הבטיחות', 'למי', 'פונים', 'לפנות', 'אחראי', 'אחראית', 'איך', 'אפשר', 'שלו', 'שלה', 'המשרד', 'משרדי', 'המשרדי', 'מייל', 'אימייל', 'פרטי', 'קשר']);
/** Hebrew spelled with or without extra letters ("ליזר" / "לייזר", "כימיקלים" / "כימיקאלים"): doubled yod and vav count once. */
const plain = (s: string) => s.replace(/יי/g, 'י').replace(/וו/g, 'ו');
const stem = (w: string) => plain(w).replace(/^[והבלמשכ](?=[א-ת]{3,})/, '').replace(/(ים|ות)$/, '');
const words = (s: string) => plain(s.toLowerCase()).replace(/[?!.,:;()"״׳'/\\-]/g, ' ').split(/\s+/).filter(Boolean);

/** One letter added, missing, changed or swapped. */
function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return a === b;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
  }
  return d[a.length]![b.length]! <= 1;
}
/** Real words one letter away from "ממונה" that mean something else ("from her", "a meter", "counts"). */
const NOT_OFFICER = new Set(['ממנה', 'מונה', 'מנה', 'ממונן', 'שמונה', 'תמונה', 'אמונה', 'ממומן', 'ממונע']);
/** Typos of "ממונה" ("מומנה", "ממונא", "מימונה") read as "ממונה", so the question is still recognised. */
export function fixOfficerTypos(text: string): string {
  return text.replace(/[א-ת"״]+/g, (w) => {
    const m = /^([והלש]?)(.+)$/.exec(w)!;
    for (const core of [w, m[2]!]) {
      if (core.length < 4 || core.length > 6 || NOT_OFFICER.has(core) || NOT_OFFICER.has(w)) continue;
      if (near(core, 'ממונה') || near(core, 'ממונת') || near(core, 'ממוני')) return `${core === w ? '' : m[1]}ממונה`;
    }
    return w;
  });
}

export interface PublicOfficer { name: string; officePhone: string | null; email: string | null; phone: string | null; showWhatsapp: boolean; topics: string[] }

/** The topics a question names, from the topics officers exist for. */
export function topicsIn(text: string, topics: string[]): string[] {
  const q = words(text).filter((w) => !STOP.has(w));
  const qs = new Set(q.map(stem));
  const hints = q.flatMap((w) => ALIASES.filter(([re]) => re.test(w) || re.test(stem(w))).flatMap(([, t]) => t));
  return topics.filter((topic) => {
    const tl = plain(topic.toLowerCase());
    // a hint matches at the start of a word of the topic ("אש" is in "גילוי אש", not inside "ראש"); a two-word hint as a phrase
    const tw = words(topic);
    if (hints.some((h) => (h.includes(' ') ? tl.includes(plain(h.toLowerCase())) : tw.some((w) => w.startsWith(plain(h.toLowerCase())) || stem(w).startsWith(plain(h.toLowerCase())))))) return true;
    return words(topic).filter((w) => w.length >= 3 && !STOP.has(w)).some((w) => qs.has(stem(w)));
  });
}

export function formatOfficers(found: { topic: string; officers: PublicOfficer[] }[]): string {
  return found.map(({ topic, officers }) => [
    `👷 ${topic}:`,
    ...officers.slice(0, 3).map((o) => {
      const lines = [o.name, o.officePhone && `☎️ טלפון משרדי: ${o.officePhone}`, o.showWhatsapp && o.phone && `💬 ווצאפ: https://wa.me/${o.phone}`, o.email && `✉️ ${o.email}`].filter(Boolean);
      return lines.length > 1 ? lines.join('\n') : `${o.name} (אפשר לכתוב כאן, ונעביר את הפנייה)`;
    }),
  ].join('\n')).join('\n\n');
}

/** "מי ראש / מנהלת יחידת הבטיחות?", "who is the head of the safety unit?" (a question, not "ראש היחידה שלי הוא…") */
const HEAD = '(?:ה)?(?:ראש|ראשת|מנהל|מנהלת)\\s+(?:ה)?(?:יחידת|יחידה|היחידה)';
// the head of the unit is what is asked about: "מי ראש היחידה?", "מה הטלפון של מנהלת יחידת הבטיחות", never "ראש היחידה שלי ביקש שאדווח…"
const HEAD_HE = new RegExp(`^(?:(?:ו)?(?:מי|מיהו|מיהי|מי זה|מי זאת|מי זו)\\s+|(?:מה|מהו|מהם)\\s+(?:ה)?(?:טלפון|מייל|אימייל|מספר|פרטי\\s+(?:ה)?קשר)\\s+(?:של\\s+)?|(?:פרטי\\s+(?:ה)?קשר|טלפון|מייל)\\s+(?:של\\s+)?|(?:איך|כיצד)\\s+(?:פונים|מגיעים|יוצרים קשר)\\s+(?:ל|אל\\s+|עם\\s+))${HEAD}(?!\\s+(?:שלי|שלנו|שלו|שלה|שלהם|ביקש|ביקשה|אמר|אמרה))`);
const HEAD_EN = /^(who('?s| is)|what('?s| is) the (phone|e-?mail|contact)( number| details)? (of|for)|how (do i|can i|to) (contact|reach))\s+(the\s+)?(head of (the )?(safety )?unit|unit head|head of safety|safety (unit )?(director|manager))\b/i;
export const isHeadQuestion = (t: string) => { const x = t.trim().replace(/^[\s,.!?]+/, ''); return HEAD_HE.test(x) || HEAD_EN.test(x); };
/** a topic naming the head of the unit ("ראש יחידת הבטיחות", "מנהלת היחידה", "Head of Safety Unit") */
const isHeadTopic = (topic: string) => /(ראש|ראשת|מנהל|מנהלת|head|director)/i.test(topic) && /(יחיד|unit|safety)/i.test(topic);
export const HEAD_UNKNOWN = 'הפרטים של ראש יחידת הבטיחות לא מוגדרים אצלי כרגע. אפשר לכתוב כאן את הפנייה, והיא תועבר לצוות היחידה.';

/** Betty's answer to a question about who is responsible for a topic, or null when the message is not such a question. */
/**
 * An officer question in Arabic ("من المسؤول عن الليزر؟", "ما هاتف مسؤول السلامة؟", "من رئيس وحدة السلامة؟"), read as the Hebrew
 * question with the topic words the officers list uses; null when it is not such a question. The answer is translated on the way out.
 */
const ASK_AR = /(من|مين) (هو |هي )?(ال)?مسؤول|(ال)?مسؤول عن|مسؤول(ه)? (ال)?سلامه|(رقم )?هاتف|تلفون|بريد|ايميل|(كيف|وين|اين) (اتواصل|اتصل|احكي|اجد) (مع )?|(لمن|لمين) (اتوجه|اتصل|اكتب)/;
const ALIASES_AR: [RegExp, string][] = [
  [/ليزر/, 'לייזרים'], [/اسبست|اسبستوس/, 'אסבסט'], [/اشعاع|اشعه|مشع/, 'קרינה'], [/حريق|حرائق|نار|اطفاء|مطفا|طفايه|رشاش|دخان/, 'אש מתזים כיבוי'],
  [/غاز|اسطوان/, 'גזים'], [/كيمي|مواد خطره|ماده خطره|نفايات/, 'כימיקלים חומ"ס'], [/كهرب/, 'חשמל'], [/ارتفاع|سلم|سقالات|سطح/, 'גובה סולמות'],
  [/مصعد|مصاعد/, 'מעליות'], [/بيولوج|احياء|جراثيم|فيروس/, 'ביולוגית biosafety'], [/ضجيج|ضوضاء/, 'רעש'], [/رافع|رفع/, 'הרמה'], [/تدريب|دوره/, 'הדרכות'],
  [/صحه مهنيه|قياس|رصد/, 'גיהות ניטור'], [/خطر|مخاطر/, 'מפגעים'], [/حمل|حامل|رضاع/, 'עבודת נשים'],
];
function arabicOfficerQuestion(text: string): string | null {
  if (!/[\u0600-\u06FF]/.test(text)) return null;
  const a = arNorm(text.replace(/[؟?!.,،:;()]/g, ' '));
  if (/(من|مين|ما|شو) (هو |هي )?(رئيس|رئيسه|مدير|مديره) (ال)?وحده/.test(a) || /(هاتف|رقم|بريد) (رئيس|رئيسه|مدير|مديره) (ال)?وحده/.test(a)) return 'מי ראש יחידת הבטיחות?';
  if (!ASK_AR.test(a)) return null;
  const topics = ALIASES_AR.filter(([re]) => re.test(a)).map(([, he]) => he);
  if (topics.length) return `מי הממונה על ${topics.join(' ')}?`;
  // no topic: only an explicit question about an officer ("رقم هاتفي 050…" is the customer's own number, not a question)
  return /مسؤول|لمن|لمين/.test(a) ? 'מי הממונה?' : null;
}

export async function officerReply(db: Db, text: string | null | undefined): Promise<string | null> {
  if (!text || text.length > 160) return null;
  text = arabicOfficerQuestion(text) ?? text;
  text = fixOfficerTypos(text);
  const head = isHeadQuestion(text);
  if (!head && !ASK.test(text) && !ASK_EN.test(text)) return null;
  const rows = (await db.query(
    `SELECT o.name, o.office_phone AS "officePhone", o.email, o.phone, o.show_whatsapp AS "showWhatsapp", array_agg(t.topic ORDER BY t.topic) AS topics
       FROM officers o JOIN officer_topics t ON t.officer_id = o.id WHERE o.active AND o.public GROUP BY o.id ORDER BY o.sort, o.created_at`)).rows as PublicOfficer[];
  if (head) {   // the head of the unit: the officer entered under such a topic, else say it is not set (never a search result)
    const topic = [...new Set(rows.flatMap((r) => r.topics))].find(isHeadTopic);
    return topic ? formatOfficers([{ topic, officers: rows.filter((r) => r.topics.includes(topic)) }]) : HEAD_UNKNOWN;
  }
  if (!rows.length) return null;
  const all = [...new Set(rows.flatMap((r) => r.topics))];
  const hit = topicsIn(text, all).slice(0, 3);
  if (!hit.length) {
    // asked about a person in charge, no topic recognised: only when it is clearly about officers
    if (!/(ממונה|ממונת|ממוני|אחראי|אחראית)/.test(text) && !/\b(officer|in charge|responsible)\b/i.test(text)) return null;
    return `על איזה נושא? יש לנו ממונים בנושאים: ${all.slice(0, 25).join(', ')}.\nכתבו למשל: "מי הממונה על ${all[0]}?"`;
  }
  return formatOfficers(hit.map((topic) => ({ topic, officers: rows.filter((r) => r.topics.includes(topic)) })));
}

/** The officer with a panel account responsible for a topic the message names (for handing a stressed customer to them). */
export async function officerUserFor(db: Db, text: string | null | undefined): Promise<{ userId: string; name: string; topic: string } | null> {
  if (!text) return null;
  const rows = (await db.query(
    `SELECT u.id AS "userId", COALESCE(u.name_he, u.name) AS name, t.topic FROM officers o JOIN officer_topics t ON t.officer_id = o.id JOIN users u ON u.id = o.user_id
      WHERE o.active AND u.active ORDER BY o.sort, o.created_at`)).rows as { userId: string; name: string; topic: string }[];
  if (!rows.length) return null;
  const hit = topicsIn(fixOfficerTypos(text), [...new Set(rows.map((r) => r.topic))])[0];
  return hit ? rows.find((r) => r.topic === hit) ?? null : null;
}
