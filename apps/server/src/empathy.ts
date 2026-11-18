import { arNorm } from './i18n/lang.js';
/**
 * A customer under stress: worried or frightened ("אני לחוצה", "מפחד", "לא יודע מה לעשות") or upset after waiting ("כבר שעה
 * מחכה", "אף אחד לא עונה"). Betty acknowledges the feeling, hands the inquiry to a person (the officer for the topic when
 * known) and stays with the customer until a person answers (follow-ups at 5, 15 and 30 minutes, see runComfort).
 * An emergency is handled before this (emergency.ts). Texts are written without gendered verbs about the customer or the handler.
 */
export type Distress = 'worried' | 'upset' | 'hazard';

const WORRIED = [
  'לחוץ', 'לחוצה', 'לחוצים', 'לחוצות', 'אני בלחץ', 'ממש בלחץ', 'בלחץ נוראי', 'בלחץ רציני', 'נכנסתי ללחץ', 'מלחיץ', 'מלחיצה', 'נלחצתי', 'נלחץ', 'נלחצת',
  'מפחד', 'מפחדת', 'מפחדים', 'פוחד', 'פוחדת', 'חושש', 'חוששת', 'חוששים', 'דואג', 'דואגת', 'מודאג', 'מודאגת', 'מודאגים', 'נבהלתי', 'נבהל', 'נבהלה',
  'מבוהל', 'מבוהלת', 'בפאניקה', 'פאניקה', 'בהלם', 'חרדה', 'בחרדה', 'מתוח', 'מתוחה', 'בוכה', 'אובד עצות', 'אובדת עצות', 'מבולבל', 'מבולבלת',
  'לא יודע מה לעשות', 'לא יודעת מה לעשות', 'לא יודעים מה לעשות', 'מה אני עושה עכשיו', 'מה עושים עכשיו', 'אני מבועת', 'אני מבועתת', 'רועד', 'רועדת',
];
const UPSET = [
  'כבר שעה', 'כבר שעתיים', 'כבר כמה שעות', 'כבר יום', 'כבר יומיים', 'כבר שבוע', 'מחכה כבר', 'מחכה המון', 'מחכה מלא זמן', 'מחכים כבר',
  'אף אחד לא עונה', 'אף אחד לא חוזר', 'אף אחד לא עונה לי', 'לא עונים לי', 'לא עונים', 'לא חוזרים אלי', 'לא חוזרים אליי', 'אין מענה', 'אין עם מי לדבר',
  'מתסכל', 'מתסכלת', 'מתוסכל', 'מתוסכלת', 'מעצבן', 'מעצבנת', 'עצבני', 'עצבנית', 'נמאס', 'נמאס לי', 'כועס', 'כועסת', 'לא מקובל', 'שערוריה', 'שערורייה',
  'זלזול', 'מזלזלים', 'חוצפה', 'בושה', 'לא רציני', 'לא נורמלי', 'מבזה', 'מאוכזב', 'מאוכזבת', 'התייאשתי',
];
/** "לחץ" of gases, boilers and vessels, "דואג ל..." as "takes care of", "מתח" of electricity: not feelings */
const TECHNICAL = /(גז|גזים|בלון|בלונים|כלי|כלים|מיכל|מכל|דוד|צנרת|צינור|אוויר|מדחס|קיטור) (ב)?לחץ|לחץ (גז|אוויר|מים|עבודה|גבוה|נמוך|הדוד)|מתח (חשמלי|גבוה|נמוך)|דואג(ת)? ל(כך|ה|ו|בטיחות|ציוד)/;

function norm(text: string): string {
  return ` ${text.toLowerCase().replace(/[״“”]/g, '"').replace(/[׳’]/g, "'").replace(/[!?.,:;()‎‏\u{1F300}-\u{1FAFF}☀-➿]/gu, ' ').replace(/\s+/g, ' ').trim()} `;
}
const has = (t: string, w: string) => new RegExp(`\\s[והשכ]?${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s)`).test(t);

/** The same feelings in English. */
const WORRIED_EN = /\b(stressed|stressful|scared|afraid|frightened|terrified|worried|anxious|panic(king)?|freaking out|nervous|i don'?t know what to do|what do i do now)\b/i;
const UPSET_EN = /\b(no ?one (is )?(answering|replying|answers|replies)|nobody (is )?(answering|replying|answers|replies|gets back)|(been )?waiting (for )?(hours|ages|so long|forever)|still no (answer|reply)|frustrat(ed|ing)|annoy(ed|ing)|unacceptable|ridiculous|fed up|angry|furious|disappointed)\b/i;
const WORRIED_AR = /(خايف|خايفه|خائف|خائفه|قلقان|قلقانه|قلق جدا|متوتر|متوتره|مرعوب|مرعوبه|مذعور|لا اعرف ماذا افعل|مش عارف شو اعمل|مش عارفه شو اعمل|ما بعرف شو اعمل|ماذا افعل الان)/;
const UPSET_AR = /(لا احد يرد|لا احد يجيب|ما حدا برد|ما حدا رد|ما حدا بيرد|بستني من ساعه|انتظر من ساعه|انتظر منذ ساعات|من ساعات|محبط|محبطه|مزعج|غير مقبول|زهقت|طفح الكيل|زعلان|زعلانه|غاضب|غاضبه)/;
export function detectDistress(text: string | null | undefined): Distress | null {
  if (!text || text.length > 600) return null;
  if (detectHazard(text)) return 'hazard';
  // the technical senses are taken out first; what is left decides
  const t = norm(text).replace(new RegExp(TECHNICAL.source, 'g'), ' ');
  const a = /[\u0600-\u06FF]/.test(t) ? arNorm(t) : '';
  if (WORRIED.some((w) => has(t, w)) || WORRIED_EN.test(t) || (a && WORRIED_AR.test(a))) return 'worried';
  if (UPSET.some((w) => has(t, w)) || UPSET_EN.test(t) || (a && UPSET_AR.test(a))) return 'upset';
  return null;
}

/**
 * A report of a hazard happening here ("סכנה לייזר", "יש מפגע חשמלי בחדר", "המדף לא בטוח"): not an emergency with injured
 * people (emergency.ts handles those), but it must reach the officer at once, with first safety advice for the topic.
 * Questions about hazards in general ("מה נחשב עבודה מסוכנת?", "מי הממונה על מפגעים?") are not reports.
 */
const HAZARD_EN = /\b(hazard|danger|dangerous|unsafe|not safe|leak|leaking|exposed wires?|short circuit|sparks|sparking)\b/i;
const QUESTION_EN = /^\s(what|how|who|where|when|which|is|are|do|does|can|could|should|would)\s/i;
const HAZARD = /(^|\s)(ה|ו|ש|ב)?(סכנה|סכנת|מפגע|מפגעים|בסכנה|מסוכן|מסוכנת|לא בטוח|לא בטוחה|לא בטיחותי|לא בטיחותית|דליפה|דולף|דולפת|נזילה|קצר חשמלי|חוט חשוף|חוטים חשופים)(?=\s)/;
const QUESTION = /^\s(מה|איך|האם|מי|איפה|כמה|למה|אילו|איזה|איזו|באיזה|מתי|ממתי|מהו|מהי|מהם)\s/;
const NOT_REPORT = /חומרים מסוכנים|חומ"ס|פסולת מסוכנת|עבודה מסוכנת|עבודות מסוכנות|סקר סיכונים|הערכת סיכונים|ניהול סיכונים/;
// Arabic (after arNorm): a hazard here, unless it is a general question ("ما هي المواد الخطره؟")
const HAZARD_AR = /(^|\s)(ال|و|في|ب)?(خطر|خطير|خطيره|غير امن|غير امنه|تسرب|تسريب|يسرب|بيسرب|ماس كهربائي|سلك مكشوف|اسلاك مكشوفه|شرار|شراره)(?=\s|$)/;
const QUESTION_AR = /^\s*(ما|ماذا|كيف|هل|من|اين|وين|متى|كم|لماذا|ليش|اي|شو)\s/;
export function detectHazard(text: string | null | undefined): boolean {
  if (!text || text.length > 400) return false;
  if (/[\u0600-\u06FF]/.test(text)) {
    const a = ` ${arNorm(text.replace(/[!?؟.,،:;()]/g, ' '))} `;
    if (HAZARD_AR.test(a)) {
      if (QUESTION_AR.test(a) && !/(يوجد|فيه|هنا|الان|حاليا|عندنا|بالغرفه|في الغرفه|في المختبر|بالمختبر|بالمبني)/.test(a.replace(QUESTION_AR, ' '))) return false;
      if (/مواد خطره|نفايات خطره|تقييم (ال)?مخاطر|ماده خطره/.test(a) && !/تسرب|انسكب|الان|هنا/.test(a)) return false;
      return true;
    }
  }
  const t = norm(text).replace(/([א-ת])\1+/g, '$1');   // "ססכנה" (a letter typed twice) is still "סכנה"
  const en = HAZARD_EN.test(t);
  if (!HAZARD.test(t) && !en) return false;
  if (QUESTION.test(t) && !/(יש|כאן|פה|עכשיו|כרגע|אצלנו|בחדר|במעבדה)/.test(t)) return false;
  if (en && QUESTION_EN.test(t) && !/\b(here|now|there is|there's|in (the|my|our) (lab|room|building))\b/i.test(t)) return false;
  if (en && /hazardous (materials?|waste|substances?)|hazard (assessment|survey)|risk assessment/i.test(t) && !/\b(leak|spill|now|here)\b/i.test(t)) return false;
  if (NOT_REPORT.test(t) && !/(סכנה|מפגע|דולף|נזילה|עכשיו|כרגע)/.test(t)) return false;
  return true;
}

/** First advice by topic: general, widely accepted safety steps only, always "if it is safe". */
export const ADVICE: [RegExp, string][] = [
  [/לייזר|ליזר|קרן|laser|beam/i, 'לא להסתכל לכיוון הקרן או להחזרות שלה. אם אפשר לעשות זאת בבטחה, לכבות את הלייזר או לחסום את הקרן, ולהרחיק אנשים מהאזור. אם הייתה חשיפה של העיניים, לפנות מיד לבדיקה רפואית.'],
  [/אסבסט|asbestos/i, 'לא לגעת, לא לנקות ולא לטאטא. לצאת מהחדר, לסגור אותו ולא לאפשר כניסה עד שהממונה יגיע.'],
  [/חשמל|חוט|שקע|לוח|קצר|ניצוץ|ניצוצות|electric|wire|socket|spark|short circuit/i, 'לא לגעת בציוד או בחוטים. לנתק את החשמל רק אם אפשר לעשות זאת בבטחה, ולהרחיק אנשים מהמקום.'],
  [/chemical|spill|leak|smell|כימ|חומר|נשפך|שפך|דליפ|דולף|נזיל|ריח/, 'להתרחק מהחומר ולא לגעת בו בלי ציוד מגן. לאוורר אם זה בטוח, ולהרחיק אנשים מהאזור.'],
  [/קרינה|רדיו|מקור|radiation|radioactive|source/i, 'להתרחק מהמקור, לצמצם את הזמן בקרבתו ולהרחיק אנשים מהאזור.'],
  [/height|ladder|scaffold|railing|roof|shelf|fall|collaps|גובה|סולם|פיגום|מעקה|גג|מדף|נופל|ליפול|קורס/, 'לסמן את המקום, להרחיק אנשים ולא להשתמש בציוד או במבנה עד שייבדקו.'],
  [/גז|בלון|צילינדר|\bgas\b|cylinder/i, 'לא להפעיל מתגים או אש בקרבת המקום, לאוורר אם זה בטוח ולהתרחק.'],
  [/ביולוג|דם|דגימ|bio|blood|sample/i, 'לא לגעת, לסמן את המקום ולהרחיק אנשים עד שהממונה יגיע.'],
];
/** The same advice in English, in the same order. */
export const ADVICE_EN = [
  "Do not look towards the beam or its reflections. If it is safe to do so, switch the laser off or block the beam, and keep people away from the area. If anyone's eyes were exposed, get a medical check at once.",
  'Do not touch, clean or sweep it. Leave the room, close it and keep everyone out until the officer arrives.',
  'Do not touch the equipment or the wires. Switch off the power only if it is safe to do so, and keep people away.',
  'Keep away from the substance and do not touch it without protective equipment. Ventilate if it is safe, and keep people away from the area.',
  'Keep away from the source, limit the time near it and keep people away from the area.',
  'Mark the spot, keep people away and do not use the equipment or structure until it has been checked.',
  'Do not operate switches or use any flame near the spot; ventilate if it is safe and move away.',
  'Do not touch it; mark the spot and keep people away until the officer arrives.',
];
export const ADVICE_DEFAULT = 'אם יש סכנה מיידית, להתרחק מהמקום ולהרחיק אחרים, ולא לטפל במפגע לבד.';
export const ADVICE_DEFAULT_EN = 'If there is immediate danger, move away and keep others away, and do not deal with the hazard on your own.';

export function hazardAdvice(text: string): string {
  const t = text.toLowerCase();
  return ADVICE.find(([re]) => re.test(t))?.[1] ?? ADVICE_DEFAULT;
}

export interface ComfortContext { who: string | null; topic?: string | null; closed: boolean; hours?: string; movedNow: boolean }

const SAFETY_LINE = 'בכל סכנה מיידית, התקשרו מיד למד"א 101 או לכבאות והצלה 102.';

/** The first answer: the feeling acknowledged, who handles it now, what to send meanwhile, and what to do in danger. */
export function comfortText(level: Distress, c: ComfortContext, text = ''): string {
  if (level === 'hazard') {
    const whoLine = c.who
      ? `העברתי את הדיווח בדחיפות אל ${c.who}${c.topic ? `, ${c.topic}` : ''}.`
      : 'העברתי את הדיווח בדחיפות לצוות היחידה.';
    const when = c.closed ? `כרגע אנחנו מחוץ לשעות הפעילות${c.hours ? ` (${c.hours})` : ''}, ולכן אם יש סכנה ממשית עכשיו, אל תחכו לנו.` : '';
    return ['⚠️ תודה שדיווחת, זה חשוב.', `בינתיים: ${hazardAdvice(text)}`, whoLine, when, 'כדי שנגיע מהר, כתבו כאן איפה בדיוק (בניין וחדר) ומה רואים.', SAFETY_LINE].filter(Boolean).join('\n');
  }
  const open = level === 'worried'
    ? 'מובן לגמרי שזה מלחיץ, ואני כאן איתך. 💛'
    : 'סליחה על ההמתנה, ומובן לגמרי שזה מתסכל. אני כאן איתך עד שיחזרו אליך. 🙏';
  const whoLine = c.who
    ? `${c.movedNow ? 'העברתי את הפנייה' : 'הפנייה שלך נמצאת'} ${c.movedNow ? 'אל' : 'אצל'} ${c.who}${c.topic ? `, ${c.topic}` : ''}, וסימנתי אותה לטיפול מהיר.`
    : `${c.movedNow ? 'העברתי את הפנייה לצוות היחידה' : 'הפנייה שלך אצל צוות היחידה'} וסימנתי אותה לטיפול מהיר. מי שיתפנה ראשון יחזור אליך.`;
  const when = c.closed ? `כרגע אנחנו מחוץ לשעות הפעילות${c.hours ? ` (${c.hours})` : ''}, ולכן המענה עשוי להגיע רק בתחילת שעות הפעילות. הפנייה שלך תטופל ראשונה.` : '';
  const meanwhile = 'בינתיים, אפשר לכתוב לי כאן מה קרה, איפה וממתי. כל פרט יגיע ישר למי שמטפל בפנייה.';
  return [open, whoLine, when, meanwhile, SAFETY_LINE].filter(Boolean).join('\n');
}

/** The follow-ups while nobody has answered yet (step 1: 5 minutes, 2: 15 minutes, 3: 30 minutes). */
export function followUpText(step: 1 | 2 | 3, c: { who: string | null; closed: boolean; hours?: string }): string {
  if (c.closed) return `אני עדיין כאן. כרגע אנחנו מחוץ לשעות הפעילות${c.hours ? ` (${c.hours})` : ''}, והפנייה שלך תטופל ראשונה כשנחזור. אפשר להוסיף כאן כל פרט.\n${SAFETY_LINE}`;
  if (step === 1) return `אני עדיין כאן איתך. עדכנתי שוב את ${c.who ?? 'הצוות'} שהפנייה שלך מחכה למענה. אפשר להוסיף כאן כל פרט, והוא יצורף לפנייה.`;
  if (step === 2) return `רק לעדכן שלא שכחנו אותך 🙏 הפנייה שלך בראש התור, ועדכנתי גם את מנהלי היחידה כדי שמישהו יחזור אליך בהקדם.`;
  return `תודה על הסבלנות. הפנייה עדיין פתוחה ומסומנת לטיפול מהיר, ונחזור אליך בהקדם. אם המצב משתנה או מחמיר, כתבו לי מיד.\n${SAFETY_LINE}`;
}

/** Minutes after the first comforting message at which each follow-up is due. */
export const FOLLOW_UP_AFTER = [5, 15, 30] as const;

/** A short answer when the customer writes again while Betty is already with them and nobody has answered yet. */
export function stillHereText(who: string | null): string {
  return `קיבלתי 🙏 הפנייה כבר אצל ${who ?? 'צוות היחידה'} בטיפול מהיר, ועדכנתי שוב. אפשר להוסיף כאן כל פרט.\n${SAFETY_LINE}`;
}
