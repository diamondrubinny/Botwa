import { z } from 'zod';
import { flowSchema, type Flow, type FlowNode } from './schema.js';

/** Tag names the template puts on conversations. The first group equals the SafetyBoard topics, so the officer sees matching standards. */
export const TEMPLATE_TAGS = [
  'גזים דחוסים', 'גפ״ם', 'סולמות', 'מעקות', 'עבודה בגובה', 'פיגומים', 'חפירה', 'כימיקלים המחייבים ניטור', 'כלי לחץ / דוודים', 'גילוי אש', 'מתזים', 'לייזרים',
  'קרינה מייננת', 'אביזרי הרמה', 'מעליות/מעלונים', 'חלל מוקף', 'מעבדות', 'מיגון מכונות', 'הדרכות', 'רעש מזיק', 'תאורה',
  'חומ״ס', 'מפגע', 'אסבסט', 'Biosafety', 'גיהות', 'עבודת נשים', 'שאלה כללית',
] as const;

export const STATUSES = ['מנהל / מהנדס מעבדה', 'משתלם', 'סטודנט להסמכה', 'עמית מחקר', 'אחראי בניין', 'עובד טכני', 'עובד ניקיון', 'חבר סגל מינהלי', 'מתנדב'];

/**
 * The WhatsApp flow of the safety unit: identification (asked once per customer), then fifteen topics. Forms are links, other
 * topics collect details and files, tag the conversation with its topic and hand it to the responsible officer (by area where
 * the spec says so). Links and officers are left for the unit to fill in; unfinished links block switching the bot to this flow.
 */
/** Optional links the unit has: its forms, the training registration and its privacy policy. A topic without a link tells the customer to ask the unit. */
export interface TemplateLinks { waste?: string; accident?: string; event?: string; offsite?: string; training?: string; privacy?: string }
export const templateLinksSchema = z.object(Object.fromEntries(['waste', 'accident', 'event', 'offsite', 'training', 'privacy'].map((k) => [k, z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(500).regex(/^https:\/\/[^\s]+$/, 'https only').optional())]))).strict();

export function buildSafetyFlow(tag: (name: string) => string, links: TemplateLinks = {}): Flow {
  const nodes: FlowNode[] = [];
  const add = (n: FlowNode) => { nodes.push(n); return n.id; };
  const HANDOFF_TEXT = 'הפנייה התקבלה והועברה לטיפול. נחזור אליך בהקדם.';

  // ---- identification (skipped when we already know the customer) ----
  add({ id: 'start', type: 'condition', label: 'מוכר מפעם קודמת?', check: { kind: 'has', name: 'fullName' }, yes: 'topics', no: 'id_intro' });
  add({ id: 'id_intro', type: 'message', label: 'הזדהות', text: 'שלום, כאן הבוט של יחידת הבטיחות. כדי שנוכל לטפל בפנייה נשאל כמה פרטים (פעם אחת בלבד).\nהפרטים (שם, בניין, חדר, פקולטה, שם ה-PI וסטטוס) ותוכן הפנייה, כולל תמונות וקבצים, נשמרים בשרתי היחידה ונגישים לאנשי הצוות המטפלים בלבד, לצורך טיפול בפנייה.' + (links.privacy ? ` מדיניות הפרטיות: ${links.privacy}` : ''), next: 'q_name' });
  add({ id: 'q_name', type: 'question', kbAside: true, label: 'שם מלא', text: 'שם מלא:', save: 'fullName', kind: 'name', optional: false, retryText: 'נא לכתוב שם מלא.', next: 'q_building' });
  add({ id: 'q_building', type: 'question', kbAside: true, label: 'שם בניין', text: 'שם הבניין (אפשר לכתוב "דלג"):', save: 'building', optional: true, retryText: 'נא לכתוב שם בניין, או "דלג".', next: 'q_room' });
  add({ id: 'q_room', type: 'question', kbAside: true, label: 'מספר חדר', text: 'מספר חדר (אפשר לכתוב "דלג"):', save: 'room', optional: true, retryText: 'נא לכתוב מספר חדר, או "דלג".', next: 'q_faculty' });
  add({ id: 'q_faculty', type: 'question', kbAside: true, label: 'פקולטה', text: 'פקולטה / יחידה (למשל: הנדסת חשמל, פיסיקה, רפואה):', save: 'faculty', optional: false, retryText: 'נא לכתוב את שם הפקולטה.', next: 'q_pi' });
  add({ id: 'q_pi', type: 'question', kbAside: true, label: 'שם ה-PI', text: 'שם ה-PI (מחזיק המעבדה):', save: 'pi', optional: false, retryText: 'נא לכתוב את שם ה-PI.', next: 'm_status' });
  add({ id: 'm_status', type: 'menu', label: 'סטטוס', text: 'מה הסטטוס שלך?', save: 'status', kbOnFreeText: false, options: STATUSES.map((label) => ({ label, next: 'remember', examples: [] as string[] })) });
  add({ id: 'remember', type: 'remember', label: 'שמירת פרטי הזדהות', vars: ['fullName', 'building', 'room', 'faculty', 'pi', 'status'], next: 'topics' });

  // ---- topics ----
  const T = {
    waste: 'שאילתא בנושא פינוי פסולת כימית', accident: 'דיווח תאונה / אירוע "כמעט-ונפגע"', event: 'קיום אירוע בקמפוס', offsite: 'ביצוע ניסוי מחוץ לקמפוס',
    chem: 'שאלה בנושא חומ"ס', hazard: 'דיווח על מפגע', radiation: 'קרינה מייננת / בלתי מייננת', laser: 'לייזרים', asbestos: 'אסבסט', bio: 'Biosafety',
    fire: 'מערכות אש: גילוי / כיבוי', hygiene: 'גיהות', training: 'הדרכות', women: 'עבודת נשים', general: 'שאלה כללית / דיווח אחר',
  };
  add({
    id: 'topics', type: 'menu', label: 'תפריט נושאים', text: 'ברצוני לקבל מידע / לדווח על:', kbOnFreeText: true,
    options: [
      { label: T.waste, next: 'waste', examples: ['פינוי פסולת', 'פסולת כימית', 'איסוף פסולת מסוכנת'] },
      { label: T.accident, next: 'accident', examples: ['תאונה', 'כמעט נפגעתי', 'נפצעתי', 'אירוע בטיחותי'] },
      { label: T.event, next: 'event', examples: ['אירוע בקמפוס', 'כנס', 'אירוע'] },
      { label: T.offsite, next: 'offsite', examples: ['ניסוי מחוץ לקמפוס', 'ניסוי בשטח'] },
      { label: T.chem, next: 'chem_list', examples: ['כימיקלים', 'חומרים מסוכנים', 'SDS', 'חומר כימי'] },
      { label: T.hazard, next: 'hz_media', examples: ['מפגע', 'סכנה', 'מצאתי מפגע'] },
      { label: T.radiation, next: 'rad_media', examples: ['קרינה', 'רנטגן', 'מקור קרינה'] },
      { label: T.laser, next: 'las_media', examples: ['לייזר'] },
      { label: T.asbestos, next: 'asb_media', examples: ['אסבסט', 'אזבסט'] },
      { label: T.bio, next: 'bio_media', examples: ['ביולוגי', 'ביוסייפטי', 'מעבדה ביולוגית'] },
      { label: T.fire, next: 'fire_media', examples: ['גלאי עשן', 'מתזים', 'כיבוי אש', 'אש'] },
      { label: T.hygiene, next: 'hyg_media', examples: ['גיהות', 'חשיפה', 'איכות אוויר'] },
      { label: T.training, next: 'trn_q', examples: ['הדרכה', 'הכשרה', 'קורס בטיחות'] },
      { label: T.women, next: 'wom_q', examples: ['הריון', 'עובדת בהריון', 'הנקה'] },
      { label: T.general, next: 'gen_media', examples: ['שאלה כללית', 'משהו אחר'] },
    ],
  });

  // ---- information only: links to the unit's forms ----
  const linkTopic = (id: string, text: string) => add({ id, type: 'message', label: id, text, next: 'topics' });
  const where = (url?: string) => (url ? `\n${url}` : '\nלקבלת הטופס פנו ליחידת הבטיחות.');
  linkTopic('waste', `פינוי פסולת כימית מתבצע באמצעות הטופס של היחידה.${where(links.waste)}`);
  linkTopic('accident', `דיווח על תאונה או אירוע "כמעט-ונפגע" מתבצע בטופס של היחידה.${where(links.accident)}\nבמקרה חירום יש להתקשר מיד לגורמי החירום.`);
  linkTopic('event', `אירוע בקמפוס מדווח בטופס האירועים של היחידה.${where(links.event)}`);
  linkTopic('offsite', `ניסוי מחוץ לקמפוס מחייב מילוי טופס מנוהל.${where(links.offsite)}`);

  // ---- a report that needs details: description or photo, exact place, then the officer ----
  const report = (p: string, opts: { tags: string[]; to: string; areas: boolean; mediaText: string; docs?: boolean; question?: boolean; place?: boolean; label: string }) => {
    const chain: string[] = [];
    const head = opts.question ? `${p}_q` : `${p}_media`;
    const parts: FlowNode[] = [];
    if (opts.question) parts.push({ id: head, type: 'question', label: `${opts.label}: שאלה`, text: opts.mediaText, save: 'question', optional: false, retryText: 'נא לכתוב את השאלה.', next: undefined });
    else parts.push({ id: head, type: 'media', label: `${opts.label}: תמונה או תיאור`, text: opts.mediaText, save: 'description', allowText: true, optional: false, retryText: 'אפשר לשלוח כאן תמונה או לכתוב הסבר.', next: undefined });
    if (opts.place !== false) parts.push({ id: `${p}_where`, type: 'question', label: `${opts.label}: מיקום`, text: 'ציינו מיקום מדויק (בניין, קומה, חדר, ליד מה):', save: 'where', optional: false, retryText: 'נא לכתוב את המיקום.', next: undefined });
    if (opts.docs) parts.push({ id: `${p}_docs`, type: 'media', label: `${opts.label}: מסמכי מכשור`, text: 'אם יש, אפשר לשלוח מסמכים של המכשור (מפרט, מדריך). אפשר לכתוב "דלג".', allowText: false, optional: true, retryText: 'אפשר לשלוח קובץ או לכתוב "דלג".', next: undefined });
    for (const t of opts.tags) parts.push({ id: `${p}_tag${parts.length}`, type: 'tag', label: `תגית: ${t}`, tagId: tag(t), next: undefined });
    parts.push({ id: `${p}_ho`, type: 'handoff', label: `העברה: ${opts.to}`, text: HANDOFF_TEXT, ...(opts.areas ? { areaVars: ['where', 'building'] } : {}), officerTopic: opts.tags[0] } as FlowNode);
    parts.forEach((n, i) => { if (i < parts.length - 1 && 'next' in n) (n as { next?: string }).next = parts[i + 1]!.id; chain.push(n.id); nodes.push(n); });
    return chain;
  };
  // chemicals: a list of up to ten, an optional SDS, then the question, to the chemicals officer
  add({ id: 'chem_list', type: 'list', label: 'חומ"ס: רשימת כימיקלים', text: 'שם הכימיקל (אפשר לכתוב טקסט חופשי):', save: 'chemicals', max: 10, moreText: 'להוסיף עוד כימיקל?', optional: false, next: 'chem_sds' });
  add({ id: 'chem_sds', type: 'media', label: 'חומ"ס: קובץ SDS', text: 'אפשר לשלוח קובץ SDS של היצרן. אפשר לכתוב "דלג".', allowText: false, optional: true, retryText: 'אפשר לשלוח קובץ או לכתוב "דלג".', next: 'chem_q' });
  add({ id: 'chem_q', type: 'question', label: 'חומ"ס: השאלה', text: 'כתבו את שאלתכם:', save: 'question', optional: false, retryText: 'נא לכתוב את השאלה.', next: 'chem_tag' });
  add({ id: 'chem_tag', type: 'tag', label: 'תגית: חומ"ס', tagId: tag('חומ״ס'), next: 'chem_tag2' });
  add({ id: 'chem_tag2', type: 'tag', label: 'תגית: כימיקלים', tagId: tag('כימיקלים המחייבים ניטור'), next: 'chem_ho' });
  add({ id: 'chem_ho', type: 'handoff', label: 'העברה: רוברט (חומ"ס)', text: HANDOFF_TEXT, officerTopic: 'חומ״ס' });

  report('hz', { label: 'מפגע', mediaText: 'שלחו תמונה של המפגע או תארו אותו בכתב:', tags: ['מפגע'], to: 'הממונה לפי אזור', areas: true });
  report('rad', { label: 'קרינה', mediaText: 'שלחו תמונה של האזור או תארו בכתב את השאלה / הדיווח:', tags: ['קרינה מייננת'], to: 'מהנדס קרינה', areas: false, docs: true });
  report('las', { label: 'לייזרים', mediaText: 'שלחו תמונה של האזור או תארו בכתב את השאלה / הדיווח:', tags: ['לייזרים'], to: 'רמ"ד לייזרים', areas: false, docs: true });
  report('asb', { label: 'אסבסט', mediaText: 'שלחו תמונה של האזור או תארו בכתב את השאלה:', tags: ['אסבסט'], to: 'רמ"ד אסבסט', areas: false });
  report('bio', { label: 'Biosafety', mediaText: 'שלחו תמונה של האזור או תארו בכתב את השאלה / הדיווח:', tags: ['Biosafety'], to: 'Biosafety Officer', areas: false, docs: true });
  report('fire', { label: 'מערכות אש', mediaText: 'שלחו תמונה של האזור או תארו בכתב את השאלה / הדיווח:', tags: ['גילוי אש', 'מתזים'], to: 'רמ"ד בטיחות אש', areas: false });
  report('hyg', { label: 'גיהות', mediaText: 'שלחו תמונה או תארו בכתב את השאלה / הדיווח:', tags: ['גיהות'], to: 'ממונה גיהות (להגדיר)', areas: true, place: true });
  report('gen', { label: 'שאלה כללית', mediaText: 'שלחו תמונה של האזור או תארו בכתב את השאלה / הדיווח:', tags: ['שאלה כללית'], to: 'הממונה לפי אזור', areas: true, docs: true });
  report('trn', { label: 'הדרכות', mediaText: `${links.training ? `להרשמה להדרכות בטיחות: ${links.training}\n` : ''}לשאלה בנושא הדרכות, כתבו אותה כאן:`, tags: ['הדרכות'], to: 'רכז הדרכות', areas: false, question: true, place: false });
  report('wom', { label: 'עבודת נשים', mediaText: 'כתבו את שאלתכם:', tags: ['עבודת נשים'], to: 'Biosafety Officer', areas: false, question: true, place: false });

  return flowSchema.parse({
    start: 'start', nodes, kbFirst: true,
    labels: { fullName: 'שם מלא', building: 'בניין', room: 'חדר', faculty: 'פקולטה', pi: 'שם ה-PI', status: 'סטטוס', chemicals: 'כימיקלים', description: 'תיאור', where: 'מיקום', question: 'שאלה' },
  });
}
