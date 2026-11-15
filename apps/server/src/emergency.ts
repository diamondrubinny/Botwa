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
/** The same signs in English (an event happening now). */
const SIGNS_EN = [
  ' emergency ', ' help me ', ' help! ', ' sos ', ' on fire ', 'there is a fire', "there's a fire", ' fire in ', 'smoke is', 'full of smoke', 'lots of smoke', 'smoke coming',
  'gas leak', 'smell gas', 'smell of gas', 'smells like gas', ' explosion', ' exploded', ' injured', ' bleeding', ' unconscious', 'passed out', 'fainted',
  'not breathing', "can't breathe", 'cannot breathe', 'electric shock', 'electrocuted', ' ambulance', 'chemical spill', 'chemical burn', ' spilled ', ' trapped ',
  'stuck in the elevator', 'stuck in the lift', ' collapsed',
];
export function isEmergency(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = ` ${text.toLowerCase().replace(/[״“”]/g, '"').replace(/[׳’]/g, "'").replace(/[!?.,:;()‎‏]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (/גלאי (ה)?עשן|תרגיל|(נוהל|נוהלי|נהלי|תכנית|תוכנית|יציאת|יציאות|תאורת|ערכת|ציוד|טלפון|טלפוני|מספר|מספרי|שעת|מצב) (ה)?חירום (של|ב|במעבדה|בבניין)|(נוהל|נוהלי|נהלי|תכנית|תוכנית|יציאת|יציאות|תאורת|ערכת|ציוד|טלפוני|מספרי) (ה)?חירום/.test(t) && !/הצילו|עכשיו|כרגע|דחוף/.test(t)) return false;   // asking about procedures and equipment
  if (/emergency (exit|exits|procedure|procedures|number|numbers|plan|lighting|kit|equipment)|fire (drill|safety|door|doors|extinguisher|extinguishers|alarm test|training|exit)|smoke (detector|detectors|alarm)/.test(t) && !/help|now|right now|urgent/.test(t)) return false;
  return SIGNS.some((w) => t.includes(w)) || SIGNS_EN.some((w) => t.includes(w));
}

export const DEFAULT_EMERGENCY_TEXT = '🚨 אם יש סכנת חיים, פציעה, שריפה או דליפה: התקשרו מיד למד"א 101, לכבאות והצלה 102 או למשטרה 100, והתרחקו מהמקום אם זה בטוח.\nהעברתי את הפנייה בדחיפות לצוות היחידה.';
