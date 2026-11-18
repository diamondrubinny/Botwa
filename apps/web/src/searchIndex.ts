import { can, type Me } from './api';

/**
 * Every screen and setting the global search can open: a label, words people may type, where it is (page, tab, the element
 * to land on) and who may see it. Kept by hand next to the screens; the element ids are the ones on those screens.
 */
export interface SearchEntry { label: string; where: string; words: string; page: string; tab?: string; s?: string; allowed: (me: Me) => boolean }

const any = () => true;
const P = (p: Parameters<typeof can>[1]) => (me: Me) => can(me, p);

export const SEARCH_INDEX: SearchEntry[] = [
  { label: 'מצב המערכת (ערוצים, אנטי-וירוס, דיסק, גיבויים)', where: 'הגדרות', words: 'מצב מערכת בריאות ניטור health דיסק ערוץ נפל תקלה שרת גיבוי', page: 'settings', s: 'sys-h', allowed: P('settings.manage') },
  { label: 'מדיניות שמירה ומחיקה (מה נמחק ומתי)', where: 'הגדרות', words: 'שמירה מחיקה retention פרטיות תיקון 13 יומן ביקורת טפסים ניקוי', page: 'settings', s: 'ret-h', allowed: P('settings.manage') },
  // bot
  { label: 'הודעת פתיחה של הבוט', where: 'בוט', words: 'פתיחה ברוכים הבאים welcome תפריט ראשי', page: 'bot', s: 'b-welcome', allowed: P('bot.view') },
  { label: 'הצהרה שבטי היא בוט ולא נציגה אנושית', where: 'בוט', words: 'הצהרה בוט שקיפות לא אנושי נציג אנושי גילוי disclosure transparency', page: 'bot', s: 'b-disc', allowed: P('bot.view') },
  { label: 'זהות הבוט (בטי): שם, תפקיד ותמונה', where: 'בוט', words: 'בטי פרסונה שם הבוט תמונה אווטאר persona', page: 'bot', s: 'persona-h', allowed: P('bot.view') },
  { label: 'מצב חירום: הודעת חירום ומספרים', where: 'בוט', words: 'חירום מד"א 101 102 100 מוקד ביטחון שריפה דחוף emergency', page: 'bot', s: 'em-t', allowed: P('bot.view') },
  { label: 'תרגומים: אנגלית, ערבית ורוסית (שיחות בשפות אחרות)', where: 'בוט', words: 'אנגלית english ערבית arabic العربية רוסית russian русский תרגום שפה translation lang', page: 'bot', s: 'tr-h', allowed: P('bot.view') },
  { label: 'הודעת חירום בערבית', where: 'בוט', words: 'ערבית arabic חירום emergency طوارئ', page: 'bot', s: 'em-ar', allowed: P('bot.view') },
  { label: 'אירוע חירום רחב (הודעת מצב לכל הפונים)', where: 'בוט', words: 'אירוע חירום רחב אזעקה שריפה פינוי הודעת מצב incident', page: 'bot', s: 'inc-h', allowed: P('bot.view') },
  { label: 'ממונה בטיחות אחראי בהעברה לאדם (שיוך)', where: 'בוט', words: 'ממונה אחראי שיוך ניתוב העברה לנציג ברירת מחדל ממונה בטיחות routing officer', page: 'bot', s: 'resp-u', allowed: P('bot.view') },
  { label: 'הסלמה אוטומטית (פנייה דחופה בלי מענה)', where: 'בוט', words: 'הסלמה ממונה חלופי מנהל דחוף בלי מענה escalation', page: 'bot', s: 'esc-h', allowed: P('bot.view') },
  { label: 'ליווי אמפתי במצבי לחץ', where: 'בוט', words: 'אמפתיה לחץ לחוץ תסכול מתוסכל ליווי רגיש מפחד', page: 'bot', s: 'emp-l', allowed: P('bot.view') },
  { label: 'GIF מהבוט ברגעים נעימים', where: 'בוט', words: 'gif גיף אנימציה', page: 'bot', s: 'gif-cd', allowed: P('bot.view') },
  { label: 'תגובות אוטומטיות (אימוג׳י, לב על תודה)', where: 'בוט', words: 'רגשון אימוגי emoji לב תודה reactions', page: 'bot', s: 'rx-thanks-l', allowed: P('bot.view') },
  { label: 'מענה ממאגר הידע: רמת ביטחון, ניסוח, מודל מקומי', where: 'בוט', words: 'מאגר ידע ביטחון מודל מקומי llm ollama ניסוח ציטוט', page: 'bot', s: 'b-kms', allowed: P('bot.view') },
  { label: 'תרגום לנציג: הודעות לקוח לעברית ותשובה לשפת הלקוח', where: 'בוט', words: 'תרגום מתרגם translate translation אנגלית ערבית רוסית שפה מודל מקומי', page: 'bot', s: 'agent-mt', allowed: P('bot.view') },
  { label: 'מענה אחרי ניתוק (כמה שעות להמשיך לענות)', where: 'בוט', words: 'ניתוק השלמה catchup', page: 'bot', s: 'b-cu', allowed: P('bot.view') },
  { label: 'תרשים זרימה ובדיקה בשיחה', where: 'תרשים זרימה', words: 'תרשים זרימה flow סימולטור הזדהות צמתים', page: 'flow', s: 'sim-h', allowed: P('bot.view') },
  // channels
  { label: 'ערוץ חדש (ווצאפ, טלגרם, צ׳אט באתר, אימייל…)', where: 'ערוצים', words: 'ערוץ חדש הוספה ווצאפ טלגרם צאט אתר מסנג׳ר אינסטגרם אימייל', page: 'channels', s: 'ch-label', allowed: P('channels.manage') },
  { label: 'בריאות ערוצים והגנה מחסימה', where: 'ערוצים', words: 'בריאות חסימה מגבלה יומית מונה חודשי 1000', page: 'channels', s: 'health-h', allowed: P('channels.view') },
  { label: 'SMS: הגדרות, שליחת בדיקה ומגבלה חודשית', where: 'ערוצים', words: 'sms הודעת טקסט twilio טוויליו מסרון', page: 'channels', s: 'sms-h', allowed: P('channels.manage') },
  { label: 'שם משתמש עסקי בווצאפ, תמונת פרופיל, הגדרות ערוץ רשמי', where: 'ערוצים', words: 'שם משתמש עסקי username תמונת פרופיל ווצאפ רשמי cloud api webhook אסימון', page: 'channels', allowed: P('channels.manage') },
  // settings
  { label: 'שעות פעילות והודעת "מחוץ לשעות"', where: 'הגדרות', words: 'שעות פעילות מחוץ לשעות חג סגור away', page: 'settings', s: 'bh-h', allowed: P('settings.view') },
  { label: 'יעד זמן מענה (SLA) והתראות', where: 'הגדרות', words: 'sla זמן מענה התראה', page: 'settings', s: 'sla-h', allowed: P('settings.view') },
  { label: 'קצב שליחה והגנה מחסימה', where: 'הגדרות', words: 'קצב שליחה חסימה מגבלה בדקה חימום', page: 'settings', s: 'snd-h', allowed: P('settings.view') },
  { label: 'ניתוב אוטומטי של פניות חדשות', where: 'הגדרות', words: 'ניתוב שיוך אוטומטי round robin חלוקה', page: 'settings', s: 'route-h', allowed: P('settings.view') },
  { label: 'אוטומציות: תזכורת, סגירה, הצגת נציג, משוב, "הסתדרתי"', where: 'הגדרות', words: 'אוטומציות תזכורת סגירה אוטומטית הצגת נציג משוב שביעות רצון הסתדרתי', page: 'settings', s: 'auto-h', allowed: P('settings.view') },
  { label: 'מיתוג: שם, לוגו וצבע', where: 'הגדרות', words: 'מיתוג לוגו צבע שם המערכת branding', page: 'settings', s: 'br-h', allowed: P('settings.view') },
  { label: 'אנשי קשר: ייבוא וייצוא CSV', where: 'הגדרות', words: 'אנשי קשר csv ייבוא ייצוא', page: 'settings', s: 'csv-h', allowed: (me) => can(me, 'settings.view') && can(me, 'contacts.manage') },
  { label: 'העברת שיחות לקבוצת ווצאפ', where: 'הגדרות', words: 'העברה קבוצה ווצאפ forward', page: 'settings', s: 'fw-h', allowed: P('settings.view') },
  { label: 'מדיניות פרטיות ומסמכים ציבוריים', where: 'הגדרות', words: 'פרטיות תנאי שימוש מסמכים משפטי הצהרת נגישות', page: 'settings', s: 'legal-h', allowed: P('settings.view') },
  { label: 'אנטי-וירוס וחומת אש לפאנל', where: 'הגדרות', words: 'אנטי וירוס clamav חומת אש firewall אבטחה ip', page: 'settings', s: 'av-sec-h', allowed: P('settings.view') },
  { label: 'גיבויים ושחזור', where: 'הגדרות', words: 'גיבוי שחזור backup העברה לשרת', page: 'settings', s: 'bk-h', allowed: P('backups.manage') },
  // knowledge base
  { label: 'מקורות מאגר הידע (מסמכים, קישורים, שאלות ותשובות)', where: 'מאגר ידע', words: 'מאגר ידע מסמך קישור faq שאלות ותשובות העלאה', page: 'kb', tab: 'sources', s: 'src-h', allowed: P('kb.manage') },
  { label: 'חקיקה ותקינה: ייבוא חוקים ותקנות', where: 'מאגר ידע', words: 'חקיקה חוקים תקנות ויקיטקסט כנסת ייבוא', page: 'kb', tab: 'gov', s: 'gov-h', allowed: P('kb.manage') },
  { label: 'תקנים רשמיים', where: 'מאגר ידע', words: 'תקנים ת"י מכון התקנים', page: 'kb', tab: 'gov', s: 'std-h', allowed: P('kb.manage') },
  { label: 'דרישות כבאות לרישוי עסקים', where: 'מאגר ידע', words: 'כבאות רישוי עסקים אש', page: 'kb', tab: 'gov', s: 'fire-h', allowed: P('kb.manage') },
  { label: 'בדיקת איכות: כפילויות וטעויות במאגר', where: 'מאגר ידע', words: 'כפילויות טעויות איכות טיוב ניקוי', page: 'kb', tab: 'health', s: 'hl-q', allowed: P('kb.manage') },
  { label: 'בדיקת חיפוש במאגר', where: 'מאגר ידע', words: 'בדיקת חיפוש playground', page: 'kb', tab: 'test', s: 'pg-h', allowed: P('kb.manage') },
  { label: 'שאלות ללא מענה', where: 'מאגר ידע', words: 'שאלות ללא מענה פערים לא נמצא', page: 'kb', tab: 'gaps', s: 'gp-h', allowed: P('kb.manage') },
  { label: 'מילים נרדפות', where: 'מאגר ידע', words: 'מילים נרדפות סינונימים', page: 'kb', tab: 'synonyms', s: 'sy-h', allowed: P('kb.manage') },
  { label: 'הבוט לומד: ניסוחים ומשוב', where: 'מאגר ידע', words: 'למידה ניסוחים משוב לייק', page: 'kb', tab: 'learn', s: 'learn-h', allowed: P('kb.manage') },
  // safety
  { label: 'ממונים ונושאים (טלפון משרדי, ייבוא מאקסל)', where: 'לוח בטיחות', words: 'ממונים ממונה טלפון משרדי נושאים אחראי', page: 'safety', s: 'officers', allowed: P('safety.view') },
  { label: 'חשבונות לממונים בקליק', where: 'לוח בטיחות', words: 'חשבונות ממונים משתמשים סיסמה ראשונית', page: 'safety', s: 'officers', allowed: P('users.manage') },
  { label: 'בדיקות תקופתיות ותזכורות', where: 'לוח בטיחות', words: 'בדיקות תקופתיות תזכורת מטפים בדיקה מועד אחראי', page: 'safety', s: 'insp-h', allowed: P('safety.view') },
  { label: 'הבדיקות שלי', where: 'החשבון שלי', words: 'בדיקות שלי בוצע תזכורת', page: 'account', s: 'my-insp', allowed: any },
  { label: 'אזורי אחריות (בניינים וממונים)', where: 'לוח בטיחות', words: 'אזורי אחריות בניין מקום', page: 'safety', s: 'areas', allowed: P('safety.view') },
  // forms
  { label: 'תבניות טפסים וחתימה דיגיטלית', where: 'טפסים', words: 'טפסים תבנית חתימה pdf word', page: 'forms', tab: 'templates', s: 'ft-h', allowed: P('forms.manage') },
  { label: 'טופס דיווח תאונה מובנה (שליחה בשיחה)', where: 'טפסים', words: 'תאונה כמעט ונפגע טופס דיווח אירוע', page: 'forms', tab: 'templates', s: 'acc-h', allowed: P('forms.manage') },
  { label: 'ייבוא טפסים מאתר', where: 'טפסים', words: 'ייבוא טפסים אתר יחידת הבטיחות', page: 'forms', tab: 'templates', s: 'fd-h', allowed: P('forms.manage') },
  { label: 'טפסים שנשלחו ושליחות לקבוצה', where: 'טפסים', words: 'טפסים שנשלחו נחתם תזכורת קבוצה', page: 'forms', tab: 'sent', s: 'fs-h', allowed: any },
  { label: 'בדיקת קובץ חתום', where: 'טפסים', words: 'אימות קובץ חתום טביעה sha', page: 'forms', tab: 'verify', s: 'fv-h', allowed: any },
  // team, canned, reports, integrations
  { label: 'צוות: משתמשים, הוספה ויצירה מאקסל', where: 'צוות', words: 'משתמשים צוות נציג הוספה אקסל ייבוא', page: 'team', s: 'ui-h', allowed: P('users.view') },
  { label: 'תפקידים והרשאות', where: 'תפקידים', words: 'תפקידים הרשאות role', page: 'roles', allowed: P('roles.manage') },
  { label: 'תשובות מוכנות', where: 'תשובות ותגיות', words: 'תשובות מוכנות canned משתנים', page: 'canned', allowed: P('canned.manage') },
  { label: 'תגיות לשיחות', where: 'תשובות ותגיות', words: 'תגיות tags', page: 'canned', s: 'tags-h', allowed: P('tags.manage') },
  { label: 'ספריית GIF', where: 'תשובות ותגיות', words: 'gif גיף ספרייה', page: 'canned', s: 'gifs-h', allowed: P('canned.manage') },
  { label: 'דוח בטיחות חודשי ב-PDF להנהלה', where: 'דוחות', words: 'דוח חודשי pdf הנהלה הורדה סיכום חודש', page: 'reports', s: 'mon-m', allowed: P('reports.view') },
  { label: 'מפת מפגעים לפי בניין', where: 'דוחות', words: 'מפת מפגעים בניין נקודות חמות מיקום זמן טיפול', page: 'reports', s: 'bld-h', allowed: P('reports.view') },
  { label: 'דוח בטיחות ודחיפות (חירום, מפגעים, לקוחות לחוצים)', where: 'דוחות', words: 'בטיחות דחיפות חירום מפגע לחוץ ליווי זמן מענה דוח', page: 'reports', s: 'sf-rep-h', allowed: P('reports.view') },
  { label: 'דוחות: סיכום, לפי נציג, שעות עומס', where: 'דוחות', words: 'דוחות סטטיסטיקה נציג עומס מגמה', page: 'reports', s: 'sum-h', allowed: P('reports.view') },
  { label: 'אינטגרציות: מפתחות API, Webhooks, Power Apps', where: 'אינטגרציות', words: 'api מפתח webhook power apps automate bi', page: 'integrations', allowed: P('api.manage') },
  { label: 'יומן ביקורת', where: 'יומן ביקורת', words: 'יומן ביקורת audit לוג', page: 'audit', allowed: P('audit.view') },
  // account
  { label: 'איך אני מוצג/ת ללקוחות (שם בעברית, תפקיד, טלפון)', where: 'החשבון שלי', words: 'הצגה שם בעברית תפקיד טלפון intro', page: 'account', s: 'intro-h', allowed: any },
  { label: 'בטי בווצאפ למנהלים (קישור הווצאפ שלי)', where: 'החשבון שלי', words: 'בטי ווצאפ מנהלים קוד קישור סטטוס קריאות', page: 'account', s: 'sw-h', allowed: any },
  { label: 'אימות דו-שלבי (MFA) ו-Passkey', where: 'החשבון שלי', words: 'אימות דו שלבי mfa totp passkey מפתח', page: 'account', s: 'mfa-h', allowed: any },
  { label: 'שינוי סיסמה', where: 'החשבון שלי', words: 'סיסמה password', page: 'account', s: 'pw-h', allowed: any },
  { label: 'התראות בטלפון ובמחשב', where: 'החשבון שלי', words: 'התראות push notifications', page: 'account', s: 'ntf-h', allowed: any },
  { label: 'מראה: ערכת נושא, תמונת פרופיל', where: 'החשבון שלי', words: 'מראה כהה בהיר נושא תמונת פרופיל theme', page: 'account', s: 'look-h', allowed: any },
  { label: 'אפליקציה בטלפון ובמחשב', where: 'החשבון שלי', words: 'אפליקציה התקנה pwa', page: 'account', s: 'inst-h', allowed: any },
];

/** Words of the query that all appear (at the start of a word) in the label, the place or the words. */
export function searchSettings(me: Me, q: string, limit = 8): SearchEntry[] {
  const norm = (s: string) => s.toLowerCase().replace(/["״׳'()\-–:,.]/g, ' ');
  const terms = norm(q).split(/\s+/).filter((t) => t.length >= 1);
  if (!terms.length) return [];
  const scored = SEARCH_INDEX.filter((e) => e.allowed(me)).map((e) => {
    const hay = ` ${norm(`${e.label} ${e.where} ${e.words}`)}`;
    const label = ` ${norm(e.label)}`;
    let score = 0;
    for (const t of terms) {
      const re = new RegExp(`\\s[והבלמש]?${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      if (!re.test(hay)) return null;
      score += re.test(label) ? 3 : 1;
    }
    return { e, score };
  }).filter((x): x is { e: SearchEntry; score: number } => !!x);
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.e);
}

export const hrefOf = (e: Pick<SearchEntry, 'page' | 'tab' | 's'>) => {
  const p = new URLSearchParams();
  if (e.tab) p.set('tab', e.tab);
  if (e.s) p.set('s', e.s);
  const qs = p.toString();
  return `#/${e.page}${qs ? `?${qs}` : ''}`;
};
