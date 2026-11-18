import { ruNorm } from './i18n/lang.js';
import { arNorm } from './i18n/lang.js';
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
/** The same signs in Arabic, as normalised by arNorm (ه for ة, one alef). */
const SIGNS_AR = [
  'طوارئ', 'النجده', 'الحقوني', 'ساعدوني', 'حريق', 'في نار', 'اشتعلت', 'دخان كثيف', 'يطلع دخان', 'يخرج دخان', 'في دخان', 'مليان دخان',
  'تسرب غاز', 'تسريب غاز', 'ريحه غاز', 'رائحه غاز', 'انفجار', 'انفجر', 'لا يتنفس', 'لا تتنفس', 'ما بيتنفس', 'ما بتتنفس', 'صعوبه في التنفس', 'يختنق', 'تختنق',
  'فاقد الوعي', 'فاقده الوعي', 'فقد الوعي', 'فقدت الوعي', 'اغمي عليه', 'اغمي عليها', 'صعقه كهربائيه', 'انصعق', 'انصعقت', 'مكهرب',
  'مصاب', 'مصابه', 'مصابين', 'اصابه بالغه', 'جريح', 'جرحي', 'نزيف', 'ينزف', 'تنزف', 'اسعاف', 'حرق كيميائي', 'انسكاب ماده', 'انسكبت ماده', 'تسرب ماده', 'تسرب كيميائي',
  'انهيار', 'انهار', ' عالق ', ' عالقه ', 'عالق في المصعد', 'عالقه في المصعد', ' محصور ',
];
/** The same signs in Russian, as normalised by ruNorm (lower case, е for ё). */
const SIGNS_RU = [
  'помогите', 'спасите', ' sos ', 'чрезвычайн', 'пожар', ' горит ', ' горят ', 'загорел', 'задымлен', 'сильный дым', 'идет дым', 'валит дым', 'полно дыма',
  'утечка газа', 'утечка газ', 'пахнет газом', 'запах газа', 'взрыв', 'взорвал', 'не дышит', 'трудно дышать', 'не может дышать', 'задыхает',
  'без сознания', 'потерял сознание', 'потеряла сознание', 'упал в обморок', 'упала в обморок', 'ударило током', 'удар током', 'поражение током',
  ' ранен ', ' ранена ', ' ранены ', 'тяжело пострада', 'кровотечен', 'истекает кровью', 'сильно кровит', 'скорую', 'скорая', 'химический ожог', 'обжегся', 'обожглась',
  'разлив', 'пролилось вещество', 'пролил вещество', 'утечка химик', 'утечка вещества', 'обрушен', 'обрушил', 'застрял в лифте', 'застряла в лифте', ' заперт ', ' заперта ',
];
export function isEmergency(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = ` ${text.toLowerCase().replace(/[״“”]/g, '"').replace(/[׳’]/g, "'").replace(/[!?.,:;()‎‏]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (/גלאי (ה)?עשן|תרגיל|(נוהל|נוהלי|נהלי|תכנית|תוכנית|יציאת|יציאות|תאורת|ערכת|ציוד|טלפון|טלפוני|מספר|מספרי|שעת|מצב) (ה)?חירום (של|ב|במעבדה|בבניין)|(נוהל|נוהלי|נהלי|תכנית|תוכנית|יציאת|יציאות|תאורת|ערכת|ציוד|טלפוני|מספרי) (ה)?חירום/.test(t) && !/הצילו|עכשיו|כרגע|דחוף/.test(t)) return false;   // asking about procedures and equipment
  if (/emergency (exit|exits|procedure|procedures|number|numbers|plan|lighting|kit|equipment)|fire (drill|safety|door|doors|extinguisher|extinguishers|alarm test|training|exit)|smoke (detector|detectors|alarm)/.test(t) && !/help|now|right now|urgent/.test(t)) return false;
  if (SIGNS.some((w) => t.includes(w)) || SIGNS_EN.some((w) => t.includes(w))) return true;
  if (/[\u0400-\u04FF]/.test(t)) {   // Russian (after ruNorm)
    const r = ` ${ruNorm(t)} `;
    if (/(запасн|аварийн|эвакуац|план эвакуации|номер|телефон|учени|тренировк|огнетушител|датчик дыма|инструкци)/.test(r) && !/(сейчас|помогите|спасите|срочно|горит)/.test(r)) return false;
    return SIGNS_RU.some((w) => r.includes(w));
  }
  if (!/[\u0600-\u06FF]/.test(t)) return false;
  const a = ` ${arNorm(t)} `;
  // asking about exits, plans, numbers or drills is not an emergency happening now
  if (/(مخرج|مخارج|خطه|خطط|رقم|ارقام|هاتف|انوار|معدات|حقيبه|تمرين|تدريب|اجراءات|نظام) (ال)?طوارئ|طفايه|مطفاه|كاشف (ال)?دخان|تمرين|تدريب/.test(a) && !/الان|حالا|هلا|ساعدوني|النجده|بسرعه/.test(a)) return false;
  return SIGNS_AR.some((w) => a.includes(w));
}

export const DEFAULT_EMERGENCY_TEXT = '🚨 אם יש סכנת חיים, פציעה, שריפה או דליפה: התקשרו מיד למד"א 101, לכבאות והצלה 102 או למשטרה 100, והתרחקו מהמקום אם זה בטוח.\nהעברתי את הפנייה בדחיפות לצוות היחידה.';
