import type { Db } from '../db.js';
import { ADVICE, ADVICE_DEFAULT, ADVICE_DEFAULT_EN, ADVICE_EN } from '../empathy.js';
import { SAFETY_FACTS, SAFETY_FACTS_EN } from '../safety/facts.js';
import type { Lang } from './lang.js';

/**
 * Betty in English: one Hebrew → English dictionary for everything she sends. Defaults below (her fixed messages, the safety
 * flow template, the automatic messages); the unit can edit any entry or add its own in the panel (Bot > English translation).
 *
 * An entry may hold "{*}" for a part that changes (a name, a number, a topic): the part is kept, and translated by itself when the
 * dictionary has it. Variables like {שם} or {בוט} are left as they are (they are filled in after translating).
 * Lookup order for a text: the whole text, then each paragraph, then each line; a line may also be "1. …", "א. …" or start with an
 * emoji. Whatever has no translation is sent in Hebrew (never made up).
 */
const PAIRS: [string, string][] = [
  // ---- Betty's own messages ----
  ['בטי', 'Betty'],
  ['כן, אני כאן איתך 😊', "Yes, I'm here with you 😊"],
  ['תודה ששאלת, הכול טוב אצלי 😊 במה אפשר לעזור?', "Thanks for asking, I'm doing well 😊 How can I help?"],
  ['אני {*}, {*} 🤖 זה בוט, לא בן אדם: התשובות מגיעות מהמידע של היחידה, ופניות מועברות לצוות. כדי לדבר עם נציג, אפשר לכתוב "נציג" בכל רגע.', "I'm {1}, {2} 🤖 I'm a bot, not a person: my answers come from the unit's information, and requests are passed on to the team. To talk to a person, write \"agent\" at any time."],
  ['הבוט של השירות', 'the service bot'],
  ['הבוט של יחידת הבטיחות', 'the safety unit bot'],
  ['נמשיך: {*}', "Let's continue: {1}"],
  ['לתפריט הראשי כתבו "תפריט".', 'For the main menu, write "menu".'],
  ['נמשיך: אפשר לבחור מהתפריט שלמעלה, או לכתוב "תפריט".', 'Let\'s continue: you can choose from the menu above, or write "menu".'],
  ['💡 הידעת?', '💡 Did you know?'],
  ['רוצים עוד? כתבו "עוד". לשאלה על המקרה שלכם, כתבו לנו ונעזור.', 'Want another one? Write "more". For a question about your own case, write to us and we\'ll help.'],
  // emergency, stress, hazards
  ['🚨 אם יש סכנת חיים, פציעה, שריפה או דליפה: התקשרו מיד למד"א 101, לכבאות והצלה 102 או למשטרה 100, והתרחקו מהמקום אם זה בטוח.', '🚨 If there is danger to life, an injury, a fire or a leak: call Magen David Adom (ambulance) 101, Fire and Rescue 102 or the Police 100 at once, and move away from the place if it is safe.'],
  ['העברתי את הפנייה בדחיפות לצוות היחידה.', 'I have passed your request to the unit\'s team as urgent.'],
  ['בכל סכנה מיידית, התקשרו מיד למד"א 101 או לכבאות והצלה 102.', 'In any immediate danger, call Magen David Adom (ambulance) 101 or Fire and Rescue 102 at once.'],
  ['אם זה מצב חירום, התקשרו מיד למד"א 101 או לכבאות והצלה 102.', 'If this is an emergency, call Magen David Adom (ambulance) 101 or Fire and Rescue 102 at once.'],
  ['מובן לגמרי שזה מלחיץ, ואני כאן איתך. 💛', "It's completely understandable that this is stressful, and I'm here with you. 💛"],
  ['סליחה על ההמתנה, ומובן לגמרי שזה מתסכל. אני כאן איתך עד שיחזרו אליך. 🙏', "Sorry for the wait, and it's completely understandable that it's frustrating. I'm here with you until someone gets back to you. 🙏"],
  ['העברתי את הפנייה אל {*}, וסימנתי אותה לטיפול מהיר.', 'I have passed your request to {1} and marked it for quick handling.'],
  ['הפנייה שלך נמצאת אצל {*}, וסימנתי אותה לטיפול מהיר.', 'Your request is with {1}, and I have marked it for quick handling.'],
  ['העברתי את הפנייה לצוות היחידה וסימנתי אותה לטיפול מהיר. מי שיתפנה ראשון יחזור אליך.', "I have passed your request to the unit's team and marked it for quick handling. The first person free will get back to you."],
  ['הפנייה שלך אצל צוות היחידה וסימנתי אותה לטיפול מהיר. מי שיתפנה ראשון יחזור אליך.', "Your request is with the unit's team, and I have marked it for quick handling. The first person free will get back to you."],
  ['{*}, האחראי/ת על {*}', '{1}, responsible for {2}'],
  ['האחראי/ת על {*}', 'responsible for {1}'],
  ['כרגע אנחנו מחוץ לשעות הפעילות ({*}), ולכן המענה עשוי להגיע רק בתחילת שעות הפעילות. הפנייה שלך תטופל ראשונה.', "We're outside working hours right now ({1}), so the answer may only come when we open. Your request will be handled first."],
  ['כרגע אנחנו מחוץ לשעות הפעילות, ולכן המענה עשוי להגיע רק בתחילת שעות הפעילות. הפנייה שלך תטופל ראשונה.', "We're outside working hours right now, so the answer may only come when we open. Your request will be handled first."],
  ['בינתיים, אפשר לכתוב לי כאן מה קרה, איפה וממתי. כל פרט יגיע ישר למי שמטפל בפנייה.', 'Meanwhile, you can write here what happened, where and since when. Every detail goes straight to whoever is handling your request.'],
  ['⚠️ תודה שדיווחת, זה חשוב.', '⚠️ Thank you for reporting this, it matters.'],
  ['בינתיים: {*}', 'Meanwhile: {1}'],
  ['העברתי את הדיווח בדחיפות אל {*}.', 'I have passed your report to {1} as urgent.'],
  ['העברתי את הדיווח בדחיפות לצוות היחידה.', "I have passed your report to the unit's team as urgent."],
  ['כרגע אנחנו מחוץ לשעות הפעילות ({*}), ולכן אם יש סכנה ממשית עכשיו, אל תחכו לנו.', "We're outside working hours right now ({1}), so if there is real danger now, don't wait for us."],
  ['כרגע אנחנו מחוץ לשעות הפעילות, ולכן אם יש סכנה ממשית עכשיו, אל תחכו לנו.', "We're outside working hours right now, so if there is real danger now, don't wait for us."],
  ['כדי שנגיע מהר, כתבו כאן איפה בדיוק (בניין וחדר) ומה רואים.', 'So we can get there quickly, write here exactly where (building and room) and what you see.'],
  ['אני עדיין כאן איתך. עדכנתי שוב את {*} שהפנייה שלך מחכה למענה. אפשר להוסיף כאן כל פרט, והוא יצורף לפנייה.', "I'm still here with you. I've reminded {1} again that your request is waiting for an answer. You can add any detail here and it will be added to your request."],
  ['הצוות', 'the team'],
  ['צוות היחידה', "the unit's team"],
  ['רק לעדכן שלא שכחנו אותך 🙏 הפנייה שלך בראש התור, ועדכנתי גם את מנהלי היחידה כדי שמישהו יחזור אליך בהקדם.', "Just letting you know we haven't forgotten you 🙏 Your request is at the top of the queue, and I've also told the unit's managers so someone gets back to you soon."],
  ['תודה על הסבלנות. הפנייה עדיין פתוחה ומסומנת לטיפול מהיר, ונחזור אליך בהקדם. אם המצב משתנה או מחמיר, כתבו לי מיד.', "Thank you for your patience. Your request is still open and marked for quick handling, and we'll get back to you soon. If things change or get worse, write to me at once."],
  ['אני עדיין כאן. כרגע אנחנו מחוץ לשעות הפעילות ({*}), והפנייה שלך תטופל ראשונה כשנחזור. אפשר להוסיף כאן כל פרט.', "I'm still here. We're outside working hours right now ({1}), and your request will be handled first when we're back. You can add any detail here."],
  ['קיבלתי 🙏 הפנייה כבר אצל {*} בטיפול מהיר, ועדכנתי שוב. אפשר להוסיף כאן כל פרט.', "Got it 🙏 Your request is already with {1} for quick handling, and I've reminded them again. You can add any detail here."],
  // where the inquiry stands
  ['הפנייה שלך (מספר {*}) נמצאת בטיפול של {*}.', 'Your request (number {1}) is being handled by {2}.'],
  ['הפנייה שלך נמצאת בטיפול של {*}.', 'Your request is being handled by {1}.'],
  ['הפנייה שלך (מספר {*}) התקבלה ומחכה לנציג הפנוי הבא.', 'Your request (number {1}) was received and is waiting for the next available person.'],
  ['הפנייה שלך התקבלה ומחכה לנציג הפנוי הבא.', 'Your request was received and is waiting for the next available person.'],
  ['כרגע אנחנו מחוץ לשעות הפעילות ({*}), ונחזור אליך בהקדם בשעות הפעילות.', "We're outside working hours right now ({1}), and we'll get back to you as soon as we're open."],
  ['נחזור אליך בהקדם האפשרי. אפשר לכתוב כאן כל פרט נוסף, והוא יתווסף לפנייה.', "We'll get back to you as soon as possible. You can write any further detail here and it will be added to your request."],
  // who is in charge
  ['👷 {*}:', '👷 {1}:'],
  ['☎️ טלפון משרדי: {*}', '☎️ Office phone: {1}'],
  ['💬 ווצאפ: {*}', '💬 WhatsApp: {1}'],
  ['{*} (אפשר לכתוב כאן, ונעביר את הפנייה)', '{1} (you can write here and we will pass your request on)'],
  ['על איזה נושא? יש לנו ממונים בנושאים: {*}.', 'Which topic? We have officers for: {1}.'],
  ['כתבו למשל: "מי הממונה על {*}?"', 'For example, write: "who is the officer for {1}?"'],
  ['הממונה על הנושא: {*}', 'The officer for this topic: {1}'],
  ['טלפון משרדי: {*}', 'Office phone: {1}'],
  ['ווצאפ: {*}', 'WhatsApp: {1}'],
  ['אימייל: {*}', 'E-mail: {1}'],
  // knowledge base
  ['מצאתי את זה במאגר המידע שלנו:', "Here's what I found in our knowledge base (the source may be in Hebrew):"],
  ['אם צריך הבהרה או עזרה נוספת, אפשר לכתוב כאן, או לבקש נציג.', 'If you need clarification or more help, you can write here or ask for an agent.'],
  ['מקור: {*}', 'Source: {1}'],
  ['לא מצאתי תשובה מדויקת. האם התכוונתם לאחד מאלה?', "I couldn't find an exact answer. Did you mean one of these?"],
  ['כתבו את האות. לתפריט כתבו "תפריט".', 'Write the letter. For the menu, write "menu".'],
  ['כתבו את האות.', 'Write the letter.'],
  ['לא מצאתי תשובה לשאלה הזו במאגר. אפשר לנסח אחרת, או לכתוב "נציג" ונציג יחזור אליכם.', 'I couldn\'t find an answer to that in our knowledge base. You can rephrase it, or write "agent" and a person will get back to you.'],
  ['הבנתי, "{*}". נשלים קודם את הפרטים ואז נמשיך ישר לנושא.', 'Got it, "{1}". Let\'s first complete your details, then we\'ll go straight to the topic.'],
  ['הבנתי, "{*}".', 'Got it, "{1}".'],
  // flow engine and menus
  ['לחזרה לשלב הקודם כתבו "אחורה". לתפריט הראשי כתבו "תפריט".', 'To go back a step, write "back". For the main menu, write "menu".'],
  ['לשאלה נוספת פשוט כתבו אותה. לתפריט כתבו "תפריט", ולשלב הקודם "אחורה".', 'For another question, just write it. For the menu write "menu", and to go back a step "back".'],
  ['נציג אנושי', 'A person (agent)'],
  ['כן', 'Yes'],
  ['לא', 'No'],
  ['לחזרה לתפריט שלחו "תפריט". לנציג שלחו "נציג".', 'To return to the menu send "menu". For an agent send "agent".'],
  ['לא הבנתי את הבחירה.', "I didn't understand that choice."],
  ['מעביר אותך לנציג. נחזור אליך בהקדם.', "I'm passing you to an agent. We'll get back to you soon."],
  ['שלום {שם פרטי}! כאן {בוט}. במה אפשר לעזור? השיבו במספר:', 'Hello {שם פרטי}! This is {בוט}. How can I help? Reply with a number:'],
  ['שעות פעילות', 'Working hours'],
  ['פרטי יצירת קשר', 'Contact details'],
  ['אפשר לשלוח כאן תמונה, קובץ או הסבר בכתב.', 'You can send a photo, a file or a written explanation here.'],
  ['להוסיף עוד?', 'Add another?'],
  ['שלום, קיבלנו את הודעתך. אנחנו מחוץ לשעות הפעילות וניצור קשר בהקדם בשעות הפעילות.', "Hello, we got your message. We're outside working hours and will get back to you as soon as we're open."],
  // the safety flow template
  ['היי {שם פרטי}, טוב לראות אותך שוב! כאן {בוט} מיחידת הבטיחות 😊', 'Hi {שם פרטי}, good to see you again! This is {בוט} from the Safety Unit 😊'],
  ['שלום, כאן {בוט} מיחידת הבטיחות 👋 כדי שנוכל לטפל בפנייה נשאל כמה פרטים (פעם אחת בלבד).', "Hello, this is {בוט} from the Safety Unit 👋 So we can handle your request, we'll ask a few details (only once)."],
  ['הפרטים (שם, בניין, חדר, פקולטה, שם ה-PI וסטטוס) ותוכן הפנייה, כולל תמונות וקבצים, נשמרים בשרתי היחידה ונגישים לאנשי הצוות המטפלים בלבד, לצורך טיפול בפנייה.', "The details (name, building, room, faculty, PI's name and status) and the content of your request, including photos and files, are kept on the unit's servers and are available only to the staff handling it, for handling your request."],
  ['שם מלא:', 'Full name:'],
  ['נא לכתוב שם מלא.', 'Please write your full name.'],
  ['שם הבניין (אפשר לכתוב "דלג"):', 'Building name (you can write "skip"):'],
  ['נא לכתוב שם בניין, או "דלג".', 'Please write the building name, or "skip".'],
  ['מספר חדר (אפשר לכתוב "דלג"):', 'Room number (you can write "skip"):'],
  ['נא לכתוב מספר חדר, או "דלג".', 'Please write the room number, or "skip".'],
  ['פקולטה / יחידה (למשל: הנדסת חשמל, פיסיקה, רפואה):', 'Faculty / unit (for example: Electrical Engineering, Physics, Medicine):'],
  ['נא לכתוב את שם הפקולטה.', 'Please write the name of the faculty.'],
  ['שם ה-PI (מחזיק המעבדה) / ראש יחידה (אפשר לכתוב "דלג"):', 'Name of the PI (lab head) / head of unit (you can write "skip"):'],
  ['נא לכתוב את שם ה-PI או ראש היחידה, או "דלג".', 'Please write the name of the PI or head of unit, or "skip".'],
  ['שם ה-PI (מחזיק המעבדה):', "PI's name (the lab's principal investigator):"],
  ['נא לכתוב את שם ה-PI.', "Please write the PI's name."],
  ['מה הסטטוס שלך?', 'What is your status?'],
  ['מנהל / מהנדס מעבדה', 'Lab manager / engineer'],
  ['משתלם', 'Postdoc / trainee'],
  ['סטודנט להסמכה', 'Undergraduate student'],
  ['עמית מחקר', 'Research fellow'],
  ['אחראי בניין', 'Building manager'],
  ['עובד טכני', 'Technical staff'],
  ['עובד ניקיון', 'Cleaning staff'],
  ['חבר סגל מינהלי', 'Administrative staff'],
  ['מתנדב', 'Volunteer'],
  ['תודה {שם פרטי}! שמרתי את הפרטים, כך שבפעם הבאה לא נשאל אותם שוב.', "Thank you {שם פרטי}! I've saved your details, so next time we won't ask again."],
  ['ברצוני לקבל מידע / לדווח על:', "I'd like information on / to report:"],
  ['שאילתא בנושא פינוי פסולת כימית', 'Chemical waste disposal'],
  ['דיווח תאונה / אירוע "כמעט-ונפגע"', 'Report an accident / near miss'],
  ['קיום אירוע בקמפוס', 'Holding an event on campus'],
  ['ביצוע ניסוי מחוץ לקמפוס', 'An experiment off campus'],
  ['שאלה בנושא חומ"ס', 'A question about hazardous materials'],
  ['דיווח על מפגע', 'Report a hazard'],
  ['קרינה מייננת / בלתי מייננת', 'Ionising / non-ionising radiation'],
  ['לייזרים', 'Lasers'],
  ['אסבסט', 'Asbestos'],
  ['מערכות אש: גילוי / כיבוי', 'Fire systems: detection / suppression'],
  ['גיהות', 'Occupational hygiene'],
  ['הדרכות', 'Training'],
  ['עבודת נשים', "Women's work (pregnancy and nursing)"],
  ['שאלה כללית / דיווח אחר', 'General question / other report'],
  ['פינוי פסולת כימית מתבצע באמצעות הטופס של היחידה.', "Chemical waste is collected using the unit's form."],
  ['לקבלת הטופס פנו ליחידת הבטיחות.', 'To get the form, contact the Safety Unit.'],
  ['דיווח על תאונה או אירוע "כמעט-ונפגע" מתבצע בטופס של היחידה.', "Accidents and near misses are reported on the unit's form."],
  ['במקרה חירום יש להתקשר מיד לגורמי החירום.', 'In an emergency, call the emergency services at once.'],
  ['אירוע בקמפוס מדווח בטופס האירועים של היחידה.', "Events on campus are reported on the unit's events form."],
  ['ניסוי מחוץ לקמפוס מחייב מילוי טופס מנוהל.', 'An experiment off campus requires filling in a managed form.'],
  ['שם הכימיקל (אפשר לכתוב טקסט חופשי):', 'Name of the chemical (free text is fine):'],
  ['להוסיף עוד כימיקל?', 'Add another chemical?'],
  ['אפשר לשלוח קובץ SDS של היצרן. אפשר לכתוב "דלג".', 'You can send the manufacturer\'s SDS file. You can write "skip".'],
  ['אפשר לשלוח קובץ או לכתוב "דלג".', 'You can send a file or write "skip".'],
  ['כתבו את שאלתכם:', 'Write your question:'],
  ['נא לכתוב את השאלה.', 'Please write your question.'],
  ['הפנייה התקבלה והועברה לטיפול. נחזור אליך בהקדם.', "Your request was received and passed on for handling. We'll get back to you soon."],
  ['שלחו תמונה של המפגע או תארו אותו בכתב:', 'Send a photo of the hazard or describe it in writing:'],
  ['אפשר לשלוח כאן תמונה או לכתוב הסבר.', 'You can send a photo here or write an explanation.'],
  ['ציינו מיקום מדויק (בניין, קומה, חדר, ליד מה):', 'Give the exact location (building, floor, room, next to what):'],
  ['נא לכתוב את המיקום.', 'Please write the location.'],
  ['שלחו תמונה של האזור או תארו בכתב את השאלה / הדיווח:', 'Send a photo of the area or describe your question / report in writing:'],
  ['אם יש, אפשר לשלוח מסמכים של המכשור (מפרט, מדריך). אפשר לכתוב "דלג".', 'If you have them, you can send documents for the equipment (specification, manual). You can write "skip".'],
  ['שלחו תמונה של האזור או תארו בכתב את השאלה:', 'Send a photo of the area or describe your question in writing:'],
  ['שלחו תמונה או תארו בכתב את השאלה / הדיווח:', 'Send a photo or describe your question / report in writing:'],
  ['לשאלה בנושא הדרכות, כתבו אותה כאן:', 'For a question about training, write it here:'],
  // automatic messages
  ['נשמח לשמוע איך היה השירות: השיבו במספר מ-1 עד 5 (5 = מצוין).', "We'd love to hear how the service was: reply with a number from 1 to 5 (5 = excellent)."],
  ['תודה רבה על המשוב!', 'Thank you very much for your feedback!'],
  ['סגרנו את הפנייה לבקשתך. אם יעלה משהו נוסף, אפשר לכתוב לנו כאן בכל עת והיא תיפתח מחדש.', "We've closed your request as you asked. If anything else comes up, you can write to us here at any time and it will be reopened."],
  ['שלום {שם}, כאן {נציג}, {תפקיד}. אני אטפל בפנייתך מעכשיו ואחזור אליך בהקדם.', "Hello {שם}, this is {נציג}, {תפקיד}. I'll be handling your request from now on and will get back to you soon."],
  ['היי {שם}, רצינו לוודא שקיבלת את התשובה שלנו. יש עוד משהו שנוכל לעזור בו?', 'Hi {שם}, we wanted to make sure you got our answer. Is there anything else we can help with?'],
  ['מאחר שלא קיבלנו מענה, אנחנו סוגרים את הפנייה בינתיים. אפשר לכתוב לנו כאן בכל עת והשיחה תיפתח מחדש. יום טוב!', "As we haven't heard back, we're closing the request for now. You can write to us here at any time and the conversation will reopen. Have a good day!"],
  ['קיבלנו את פנייתך, {שם}. נציג/ה יחזרו אליך בהקדם. תודה על הסבלנות!', "We've received your request, {שם}. Someone will get back to you soon. Thank you for your patience!"],
  ['תודה שפנית אלינו, {שם}! אם יעלה משהו נוסף, אנחנו כאן.', "Thank you for contacting us, {שם}! If anything else comes up, we're here."],
];

/** The built-in dictionary (with the safety facts and the first advice for hazards). */
export function defaultEntries(): Map<string, string> {
  const m = new Map(PAIRS);
  SAFETY_FACTS.forEach((f, i) => { if (SAFETY_FACTS_EN[i]) m.set(f, SAFETY_FACTS_EN[i]!); });
  ADVICE.forEach(([, he], i) => { if (ADVICE_EN[i]) m.set(he, ADVICE_EN[i]!); });
  m.set(ADVICE_DEFAULT, ADVICE_DEFAULT_EN);
  return m;
}

export interface Dictionary { exact: Map<string, string>; patterns: { re: RegExp; to: string }[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function buildDictionary(entries: Map<string, string>): Dictionary {
  const exact = new Map<string, string>();
  const patterns: { re: RegExp; to: string }[] = [];
  for (const [he, en] of entries) {
    const k = he.trim(), v = en.trim();
    if (!k || !v) continue;
    if (k.includes('{*}')) {
      let n = 0;
      const to = v.replace(/\{\*\}/g, () => `{${++n}}`);
      patterns.push({ re: new RegExp(`^${k.split('{*}').map(esc).join('([^\\n]+?)')}$`), to });   // a changing part never spans lines
    } else exact.set(k, v);
  }
  // longer (more specific) patterns first
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
  return { exact, patterns };
}

const DAYS_EN: Record<string, string> = { 'א׳': 'Sun', 'ב׳': 'Mon', 'ג׳': 'Tue', 'ד׳': 'Wed', 'ה׳': 'Thu', 'ו׳': 'Fri', 'ש׳': 'Sat' };
const LETTER_EN: Record<string, string> = { 'א': 'a', 'ב': 'b', 'ג': 'c' };

/** One piece (a line or less): exact, then a pattern (its changing parts translated by themselves), then a list item or a leading emoji. */
function piece(s: string, d: Dictionary, depth = 0): string {
  const t = s.trim();
  if (!t || !/[א-ת]/.test(t)) return s;
  const hit = d.exact.get(t);
  if (hit) return s.replace(t, hit);
  if (depth < 3) {
    for (const p of d.patterns) {
      const m = p.re.exec(t);
      if (m) return s.replace(t, p.to.replace(/\{(\d+)\}/g, (_, i: string) => piece(m[Number(i)] ?? '', d, depth + 1)));
    }
    // "1. text", "0. text", "א. text"
    const item = /^(\d{1,2}|[אבג])([.)]\s+)(.+)$/.exec(t);
    if (item) return s.replace(t, `${LETTER_EN[item[1]!] ?? item[1]}${item[2]}${piece(item[3]!, d, depth + 1)}`);
    // a leading emoji or bullet
    const lead = /^([\p{Extended_Pictographic}\u{FE0F}\u{200D}•*\-–\s]+)(.+)$/u.exec(t);
    if (lead && lead[1]!.trim()) return s.replace(t, `${lead[1]}${piece(lead[2]!, d, depth + 1)}`);
  }
  // working hours ("א׳–ה׳ 09:00–17:00")
  if (/^[א-ש]׳/.test(t) && /\d{1,2}:\d{2}/.test(t)) return s.replace(t, t.replace(/[א-ש]׳/g, (x) => DAYS_EN[x] ?? x));
  return s;
}

/** A whole message in English, as far as the dictionary goes. */
export function translateWith(text: string, d: Dictionary): string {
  if (!text || !/[א-ת]/.test(text)) return text;
  const whole = piece(text, d);
  if (whole !== text) return whole;
  return text.split('\n\n').map((para) => {
    const p = piece(para, d);
    return p !== para ? p : para.split('\n').map((line) => piece(line, d)).join('\n');
  }).join('\n\n');
}

// ---- stored translations (the unit's edits) ------------------------------------------------------------------------------
let cache: { at: number; dict: Dictionary } | null = null;
export const invalidateTranslations = () => { cache = null; };

export async function loadOverrides(db: Db): Promise<Record<string, string>> {
  const v = (await db.query(`SELECT value FROM settings WHERE key = 'translations_en'`)).rows[0]?.value as { entries?: Record<string, string> } | undefined;
  return v?.entries && typeof v.entries === 'object' ? v.entries : {};
}

export async function dictionary(db: Db): Promise<Dictionary> {
  if (cache && Date.now() - cache.at < 30_000) return cache.dict;
  const entries = defaultEntries();
  for (const [he, en] of Object.entries(await loadOverrides(db).catch(() => ({})))) {
    if (typeof en === 'string' && en.trim()) entries.set(he, en); else entries.delete(he);   // an empty entry switches a default off
  }
  cache = { at: Date.now(), dict: buildDictionary(entries) };
  return cache.dict;
}

/** The text in the conversation's language (Hebrew texts are only translated when the conversation is in English). */
export async function localize(db: Db, lang: Lang | null | undefined, text: string): Promise<string> {
  if (lang !== 'en' || !text) return text;
  return translateWith(text, await dictionary(db));
}

/**
 * English words for Betty's commands and answers, read as the Hebrew ones the flow understands: "menu", "back", "agent", "skip",
 * "yes"/"no", "more". A menu option written in English (its translation) is read as the option itself.
 */
const COMMANDS: [RegExp, string][] = [
  [/^(main\s+)?menu$|^start\s*over$/i, 'תפריט'],
  [/^(go\s+)?back$|^previous$/i, 'אחורה'],
  [/^(agent|human|person|representative|talk to (a |an )?(person|human|agent)|operator)$/i, 'נציג'],
  [/^skip$/i, 'דלג'],
  [/^(yes|yeah|yep|y)$/i, 'כן'],
  [/^(no|nope|n)$/i, 'לא'],
  [/^(more|another( one)?|one more)$/i, 'עוד'],
];
export async function fromEnglish(db: Db, text: string): Promise<string> {
  const t = text.trim().replace(/[.!?]+$/, '');
  for (const [re, he] of COMMANDS) if (re.test(t)) return he;
  if (/^[a-c]$/i.test(t)) return { a: 'א', b: 'ב', c: 'ג' }[t.toLowerCase()]!;   // "did you mean" letters
  const d = await dictionary(db);
  const lower = t.toLowerCase();
  for (const [he, en] of d.exact) if (en.toLowerCase() === lower && he.length <= 80) return he;   // an option's English label
  return text;
}
