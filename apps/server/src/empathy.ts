/**
 * A customer under stress: worried or frightened ("אני לחוצה", "מפחד", "לא יודע מה לעשות") or upset after waiting ("כבר שעה
 * מחכה", "אף אחד לא עונה"). Betty acknowledges the feeling, hands the inquiry to a person (the officer for the topic when
 * known) and stays with the customer until a person answers (follow-ups at 5, 15 and 30 minutes, see runComfort).
 * An emergency is handled before this (emergency.ts). Texts are written without gendered verbs about the customer or the handler.
 */
export type Distress = 'worried' | 'upset';

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

export function detectDistress(text: string | null | undefined): Distress | null {
  if (!text || text.length > 600) return null;
  // the technical senses are taken out first; what is left decides
  const t = norm(text).replace(new RegExp(TECHNICAL.source, 'g'), ' ');
  if (WORRIED.some((w) => has(t, w))) return 'worried';
  if (UPSET.some((w) => has(t, w))) return 'upset';
  return null;
}

export interface ComfortContext { who: string | null; topic?: string | null; closed: boolean; hours?: string; movedNow: boolean }

const SAFETY_LINE = 'בכל סכנה מיידית, התקשרו מיד למד"א 101 או לכבאות והצלה 102.';

/** The first answer: the feeling acknowledged, who handles it now, what to send meanwhile, and what to do in danger. */
export function comfortText(level: Distress, c: ComfortContext): string {
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
