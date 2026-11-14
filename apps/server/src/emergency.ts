/**
 * An emergency in a customer's message: danger to life, injury, fire, smoke, gas or chemical leak, explosion, electric shock.
 * Such a message gets the emergency numbers at once and goes to a person urgently, before anything else the bot does (no
 * greeting, menu, reaction of joy or GIF). Kept to clear signs of an event happening now: "דחוף" alone, "גלאי עשן" or a report
 * of a past accident are not an emergency (the flow handles those).
 */
const SIGNS = [
  'חירום', 'הצילו', 'sos', 'שריפה', 'שרפה', 'דליקה', ' בוער ', ' בוערת ', 'יש עשן', 'עשן סמיך', 'עולה עשן', 'יוצא עשן', 'מלא עשן',
  'דליפת גז', 'ריח של גז', 'ריח גז', 'מריח גז', 'פיצוץ', 'התפוצץ', 'התפוצצה', 'לא נושם', 'לא נושמת', 'קשיי נשימה', 'נחנק', 'נחנקת',
  'איבד הכרה', 'איבדה הכרה', 'מחוסר הכרה', 'מחוסרת הכרה', 'התעלף', 'התעלפה', 'התחשמל', 'התחשמלה', 'התחשמלות',
  'פצוע', 'פצועה', 'פצועים', 'נפגע קשה', 'נפגעה קשה', 'פגיעה קשה', 'דימום', 'מדמם', 'מדממת', 'אמבולנס', 'מד"א',
  'כוויה כימית', 'נכווה', 'נכוותה', 'נשפך חומר', 'שפך חומר', 'דליפת חומר', 'דליפה של חומר', 'חומר מסוכן נשפך', 'דליפה כימית',
  'קריסה', ' קרס ', ' קרסה ', ' לכוד ', ' לכודה ', 'תקוע במעלית', 'תקועה במעלית',
];
export function isEmergency(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = ` ${text.toLowerCase().replace(/[״“”]/g, '"').replace(/[׳’]/g, "'").replace(/[!?.,:;()‎‏]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (/גלאי (ה)?עשן|תרגיל|(נוהל|נוהלי|נהלי|תכנית|תוכנית|יציאת|יציאות|תאורת|ערכת|ציוד|טלפון|טלפוני|מספר|מספרי|שעת|מצב) (ה)?חירום (של|ב|במעבדה|בבניין)|(נוהל|נוהלי|נהלי|תכנית|תוכנית|יציאת|יציאות|תאורת|ערכת|ציוד|טלפוני|מספרי) (ה)?חירום/.test(t) && !/הצילו|עכשיו|כרגע|דחוף/.test(t)) return false;   // asking about procedures and equipment
  return SIGNS.some((w) => t.includes(w));
}

export const DEFAULT_EMERGENCY_TEXT = '🚨 אם יש סכנת חיים, פציעה, שריפה או דליפה: התקשרו מיד למד"א 101, לכבאות והצלה 102 או למשטרה 100, והתרחקו מהמקום אם זה בטוח.\nהעברתי את הפנייה בדחיפות לצוות היחידה.';
