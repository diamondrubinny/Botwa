/**
 * "בטי, תספרי לי עובדה מעניינת בבטיחות" / "טיפ בטיחות" / "הידעת?": a short safety fact or tip from a fixed, checked list (no
 * outside service, nothing made up). General, widely accepted safety guidance only; for anything specific the customer is
 * pointed to the safety unit. Facts already told in this conversation are not repeated until all were told.
 */
export const SAFETY_FACTS: readonly string[] = [
  'בשריפה, העשן מסוכן יותר מהאש עצמה: רוב הנפגעים בשריפות נפגעים משאיפת עשן. לכן יוצאים נמוך, קרוב לרצפה, שם האוויר נקי יותר.',
  'שמן בוער במטבח לא מכבים במים: המים הופכים לאדים בבת אחת ומפזרים את השמן הבוער. מכסים במכסה או בשמיכת כיבוי ומכבים את מקור החום.',
  'מפעילים מטף בארבעה צעדים: שולפים את הנצרה, מכוונים לבסיס הלהבה (לא לראש שלה), לוחצים על הידית וסורקים מצד לצד.',
  'דלת אש נועדה לעצור אש ועשן, ולכן היא צריכה להישאר סגורה. דלת אש שמוחזקת פתוחה בטריז מבטלת את ההגנה.',
  'נתז של חומר כימי לעיניים? שוטפים מיד במים זורמים, לפחות 15 דקות, ועיניים פקוחות. רק אחר כך פונים לטיפול רפואי, עם שם החומר.',
  'כימיקלים מאחסנים לפי התאמה ולא לפי סדר האלף-בית: חומצות בנפרד מבסיסים, וחומרים מחמצנים הרחק מחומרים דליקים.',
  'קרן לייזר מסוכנת גם כשהיא מוחזרת ממשטח מבריק. לכן בעבודה עם לייזר מורידים טבעות ושעונים, ומרכיבים משקפי מגן שמתאימים לאורך הגל של הלייזר.',
  'בלוני גז דחוס מאבטחים במצב עמידה, בשרשרת או בחבק, ומובילים אותם רק כשכובע המגן מכסה את הברז. בלון שנופל ושובר את הברז עלול להפוך לטיל.',
  'עולים ויורדים בסולם עם הפנים אל הסולם, ותמיד בשלוש נקודות מגע: שתי ידיים ורגל, או שתי רגליים ויד.',
  'החלקות, מעידות ונפילות הן מהתאונות הנפוצות במקומות עבודה. מעבר פנוי, כבלים מסודרים ורצפה יבשה מונעים הרבה מהן.',
  'חשיפה ממושכת לרעש של 85 דציבל ומעלה עלולה לפגוע בשמיעה, והנזק לרוב בלתי הפיך. אם צריך להרים את הקול כדי לדבר עם מי שעומד במרחק מטר, כנראה שהרעש גבוה מדי.',
  'שקע או תקע שמתחממים, מריחים מחריכה או מפצפצים הם סימן אזהרה. מפסיקים להשתמש בהם ומדווחים, ולא מחברים מפצלים זה לזה.',
  'מכשולים לפני דלתות יציאה ומטפים חוסמים את הדרך בשעת חירום. כדאי לדעת מראש איפה היציאה הקרובה והמטף הקרוב לעמדה שלך.',
  'גז שאינו רעיל עדיין יכול להיות מסוכן: חנקן או הליום שדולפים בחדר סגור דוחקים את החמצן, ואין לזה ריח שיתריע.',
  'כשמרימים משא כבד, מכופפים את הברכיים ולא את הגב, ומחזיקים את המשא קרוב לגוף. משא כבד מדי מרימים בעזרת מישהו נוסף או בעזרת ציוד.',
];

/** The same facts in English, in the same order (for conversations in English). */
export const SAFETY_FACTS_EN: readonly string[] = [
  "In a fire, smoke is more dangerous than the flames: most fire casualties are hurt by breathing smoke. So get out low, close to the floor, where the air is cleaner.",
  "Never put out burning cooking oil with water: the water turns to steam at once and spreads the burning oil. Cover it with a lid or a fire blanket and turn off the heat.",
  "Using a fire extinguisher takes four steps: pull the pin, aim at the base of the flame (not the top), squeeze the handle and sweep from side to side.",
  "A fire door is there to stop fire and smoke, so it must stay closed. A fire door held open with a wedge loses its protection.",
  "Chemical splash in the eyes? Rinse at once under running water for at least 15 minutes, eyes open. Only then get medical care, with the name of the chemical.",
  "Store chemicals by compatibility, not alphabetically: acids apart from bases, and oxidisers away from flammables.",
  "A laser beam is dangerous even when it is reflected off a shiny surface. That is why rings and watches come off when working with lasers, and eye protection matched to the laser's wavelength goes on.",
  "Compressed gas cylinders are secured upright with a chain or strap, and moved only with the valve cap on. A cylinder that falls and breaks its valve can become a missile.",
  "Climb up and down a ladder facing it, always with three points of contact: two hands and a foot, or two feet and a hand.",
  "Slips, trips and falls are among the most common workplace accidents. Clear walkways, tidy cables and dry floors prevent many of them.",
  "Long exposure to noise of 85 decibels or more can damage hearing, usually for good. If you have to raise your voice to talk to someone a metre away, the noise is probably too loud.",
  "A socket or plug that gets hot, smells burnt or crackles is a warning sign. Stop using it and report it, and do not plug extension leads into each other.",
  "Obstacles in front of exit doors and extinguishers block the way in an emergency. It is worth knowing in advance where the nearest exit and extinguisher are from your workstation.",
  "A gas that is not toxic can still be dangerous: nitrogen or helium leaking into a closed room pushes out the oxygen, with no smell to warn you.",
  "When lifting something heavy, bend your knees, not your back, and keep the load close to your body. Loads that are too heavy are lifted with another person or with equipment.",
];

// "עובדת" alone is also "(she) works": only as "עובדת בטיחות" / "עובדת מעניינת"
const ASK = /(עובדה|עובדות|עובדת (ב?בטיחות|מעניינת)|הידעת|טיפ|טיפים|משהו מעניין|דבר מעניין)/;
const SAFETY = /(בטיחות|בטיחותי|מעניינ|הידעת|טיפ)/;

export function isFactRequest(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t || t.length > 80) return false;
  if (/^(עוד|עוד אחת|עוד אחד|עוד עובדה|עוד טיפ|עוד בבקשה)[!?. ]*$/.test(t)) return false;   // only right after a fact (see factReply)
  return (ASK.test(t) && SAFETY.test(t)) || ASK_EN.test(t);
}
const ASK_EN = /\b(safety (tip|fact)s?|(fun|interesting|cool) (safety )?fact|did you know|tell me something (interesting|new)|teach me something)\b/i;

/** A fact for the conversation, or null when the message is not such a request. "עוד" counts only right after a fact. */
export function factReply(text: string | null | undefined, told: string[], lastWasFact: boolean, pick = Math.random): string | null {
  const t = (text ?? '').trim();
  const more = lastWasFact && /^(עוד|עוד אחת|עוד אחד|עוד עובדה|עוד טיפ|עוד בבקשה|ועוד|more|another( one)?|one more)[!?. ]*$/i.test(t);
  if (!more && !isFactRequest(t)) return null;
  const fresh = SAFETY_FACTS.filter((f, i) => !told.some((b) => b.includes(f) || (!!SAFETY_FACTS_EN[i] && b.includes(SAFETY_FACTS_EN[i]!))));
  const pool = fresh.length ? fresh : SAFETY_FACTS;
  const fact = pool[Math.floor(pick() * pool.length) % pool.length]!;
  return `💡 הידעת?\n${fact}\n\nרוצים עוד? כתבו "עוד". לשאלה על המקרה שלכם, כתבו לנו ונעזור.`;
}
