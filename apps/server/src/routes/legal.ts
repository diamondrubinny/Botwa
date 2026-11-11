import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';

/**
 * Public legal pages rendered on the server as plain HTML (no scripts): privacy policy, terms of use and data-deletion instructions.
 * Meta asks for these addresses before an app that uses the WhatsApp Cloud API can be published, and its reviewers (and crawlers)
 * need a page that reads without JavaScript. The organisation's details come from Settings; every value is HTML-escaped.
 * The text describes what this system actually does with data; it is a technical draft that needs legal review before relying on it.
 */
export interface LegalInfo { orgName: string; email: string; phone: string; address: string; officer: string; approved: boolean }
const EMPTY: LegalInfo = { orgName: '', email: '', phone: '', address: '', officer: '', approved: false };

export async function loadLegal(db: Db): Promise<LegalInfo & { updatedAt: string | null }> {
  const r = (await db.query(`SELECT value, updated_at FROM settings WHERE key = 'legal'`)).rows[0];
  return { ...EMPTY, ...(r?.value ?? {}), updatedAt: r?.updated_at ? new Date(r.updated_at).toISOString() : null };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const CSS = `:root{color-scheme:light dark;--fg:#1d2230;--muted:#5a6275;--bg:#faf8f4;--card:#fff;--line:#e3dfd6;--accent:#3f46a8}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe7;--muted:#b4b7c2;--bg:#16181f;--card:#1f222b;--line:#343846;--accent:#aab0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.7 system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
main{max-width:52rem;margin:0 auto;padding:1.5rem 1rem 3rem}h1{font-size:1.9rem;line-height:1.3;margin:.5rem 0 1rem}h2{font-size:1.25rem;margin:2rem 0 .5rem}
h3{font-size:1.05rem;margin:1.2rem 0 .3rem}a{color:var(--accent)}a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.meta,.note{color:var(--muted);font-size:.95rem}.note{border:1px solid var(--line);background:var(--card);padding:.6rem .9rem;border-radius:8px}
nav ul{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;margin:0 0 1rem}
section[lang=en]{border-top:1px solid var(--line);margin-top:2.5rem;padding-top:1rem}
.skip{position:absolute;inset-inline-start:-999px}.skip:focus{inset-inline-start:1rem;top:1rem;background:var(--card);padding:.4rem .8rem}`;

const CHANNEL_NAMES: Record<string, string> = { whatsapp_cloud: 'WhatsApp (WhatsApp Business Platform של Meta)', whatsapp: 'WhatsApp', telegram: 'Telegram', webchat: 'צ׳אט באתר' };

function page(title: string, body: string, info: LegalInfo & { updatedAt: string | null }): string {
  const updated = info.updatedAt ? new Date(info.updatedAt).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' }) : null;
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}${info.orgName ? ` – ${esc(info.orgName)}` : ''}</title><meta name="robots" content="index,follow"><link rel="stylesheet" href="/legal/style.css"></head>
<body><a class="skip" href="#main">דלג לתוכן</a><main id="main">
<nav aria-label="מסמכים"><ul><li><a href="/legal/privacy">מדיניות פרטיות</a></li><li><a href="/legal/terms">תנאי שימוש</a></li><li><a href="/legal/data-deletion">מחיקת מידע</a></li></ul></nav>
<h1>${esc(title)}</h1>
<p class="meta">${info.orgName ? `${esc(info.orgName)} · ` : ''}${updated ? `עדכון אחרון: ${esc(updated)}` : ''}</p>
${info.approved ? '' : '<p class="note">נוסח טכני בהליך בדיקה משפטית. הוא מתאר את אופן הטיפול במידע במערכת השירות שלנו.</p>'}
${body}
</main></body></html>`;
}

const contactHtml = (i: LegalInfo) => {
  const parts = [
    i.orgName && `<strong>${esc(i.orgName)}</strong>`,
    i.officer && `האחראי על הגנת הפרטיות: ${esc(i.officer)}`,
    i.email && `דוא"ל: <a href="mailto:${esc(i.email)}">${esc(i.email)}</a>`,
    i.phone && `טלפון: <span dir="ltr">${esc(i.phone)}</span>`,
    i.address && `כתובת: ${esc(i.address)}`,
  ].filter(Boolean);
  return parts.length ? `<p>${parts.join('<br>')}</p>` : '<p>[פרטי קשר: יש להשלים בהגדרות המערכת]</p>';
};

function privacyBody(i: LegalInfo, channels: string[], cfg: Config): string {
  const via = channels.length ? channels.map((c) => CHANNEL_NAMES[c] ?? c).join(', ') : 'WhatsApp, Telegram וצ׳אט באתר';
  const meta = channels.includes('whatsapp_cloud') || channels.includes('whatsapp') || channels.length === 0;
  const keep = cfg.MESSAGE_RETENTION_DAYS > 0
    ? `שיחות, הודעות וקבצים נמחקים אוטומטית לאחר ${cfg.MESSAGE_RETENTION_DAYS} ימים ללא פעילות בשיחה, אלא אם נדרש לשמור אותם לפי דין או לצורך טיפול בפנייה פתוחה.`
    : 'שיחות והודעות נשמרות כל עוד הן נדרשות לטיפול בפנייה ולתיעוד השירות, ונמחקות לפי בקשה או לפי מדיניות השמירה של הארגון.';
  return `
<p>מדיניות זו מסבירה איזה מידע אנו אוספים כשאתם פונים אלינו דרך ערוצי השירות שלנו (${esc(via)}), למה, כמה זמן אנו שומרים אותו, עם מי הוא משותף ומה הזכויות שלכם. השירות מופעל על ידי ${i.orgName ? esc(i.orgName) : 'הארגון'} במערכת שירות שמותקנת בשרת שבשליטתנו.</p>

<h2>1. איזה מידע נאסף</h2>
<ul>
<li><strong>פרטי זיהוי בערוץ:</strong> מספר הטלפון שלכם בווצאפ, או מזהה המשתמש בטלגרם, ושם הפרופיל שאתם מציגים שם. בצ׳אט באתר: מזהה טכני אקראי של הדפדפן ושם, אם מסרתם.</li>
<li><strong>תוכן הפנייה:</strong> ההודעות שאתם שולחים, ותמונות, מסמכים והקלטות קול שאתם מצרפים.</li>
<li><strong>פרטים שמסרתם בשיחה:</strong> למשל שם, מיקום או פרטים על הפנייה, כשהבוט או הנציג מבקשים אותם לצורך הטיפול.</li>
<li><strong>מידע טכני:</strong> מועדי שליחה וקבלה, סטטוס מסירה ותגובות (רגשונים) להודעות. בצ׳אט באתר נשמרת גם כתובת ה-IP לצורך אבטחה ומניעת שימוש לרעה.</li>
</ul>
<p>אין חובה למסור מידע, אך בלי פרטי הפנייה ייתכן שלא נוכל לטפל בה. אנו לא מבקשים מידע רגיש (כמו מידע רפואי) אלא אם הוא נדרש לטיפול בפנייה שלכם.</p>

<h2>2. למה אנו משתמשים במידע</h2>
<ul>
<li>מענה לפנייה והעברתה לגורם המטפל המתאים.</li>
<li>מענה אוטומטי על שאלות נפוצות באמצעות בוט שפועל לפי תשובות שכתבנו מראש ולפי מאגר ידע פנימי. הבוט <strong>אינו</strong> משתמש בשירות בינה מלאכותית חיצוני, ותוכן השיחה לא נשלח לשירות כזה.</li>
<li>שיפור השירות: מדדים מצטברים, ושאלות שהבוט לא ידע לענות עליהן (נשמרות בלי פרטים מזהים ונמחקות אחרי ${cfg.KB_QUERY_RETENTION_DAYS} ימים).</li>
<li>אבטחה, מניעת הצפה ושימוש לרעה, וקיום חובות לפי דין.</li>
</ul>
<p>אנו לא מוכרים מידע אישי, לא משתמשים בו לפרסום ולא בונים ממנו פרופילים שיווקיים.</p>

<h2>3. עם מי המידע משותף</h2>
<ul>
${meta ? '<li><strong>Meta (WhatsApp):</strong> הודעות בווצאפ עוברות דרך התשתית של WhatsApp, וחלים עליהן גם תנאי השימוש ומדיניות הפרטיות של WhatsApp.</li>' : ''}
${channels.includes('telegram') || channels.length === 0 ? '<li><strong>Telegram:</strong> הודעות בטלגרם עוברות דרך התשתית של Telegram, וחלה עליהן מדיניות הפרטיות שלה.</li>' : ''}
<li><strong>צוות מורשה בלבד</strong> אצלנו, לפי תפקיד והרשאות. הכניסה למערכת מאובטחת, וכל פעולה רגישה נרשמת ביומן.</li>
<li><strong>רשויות</strong>, רק כשהדין מחייב זאת.</li>
</ul>
<p>ספקי התקשורת (Meta, Telegram) עשויים לעבד את המידע גם מחוץ לישראל, לפי התנאים שלהם.</p>

<h2>4. כמה זמן נשמר המידע</h2>
<p>${keep} עותקי גיבוי מוצפנים נשמרים עד ${cfg.BACKUP_KEEP} ימים, ואחר כך נמחקים.</p>

<h2>5. אבטחת מידע</h2>
<p>המידע נשמר בשרת שבשליטתנו, והגישה אליו מוצפנת (HTTPS). פרטי חיבור לערוצים נשמרים מוצפנים, והגישה למערכת דורשת הזדהות עם אימות דו־שלבי לבעלי הרשאות ניהול. קבצים שמתקבלים נסרקים לאיתור נוזקות לפני שהם מוצגים. אין שיטה שמבטיחה אבטחה מוחלטת, אבל אנו פועלים לצמצם את הסיכון.</p>

<h2>6. הזכויות שלכם</h2>
<p>אתם יכולים לבקש לעיין במידע שלכם, לתקן אותו, לקבל עותק שלו או למחוק אותו, וכן להתנגד לשימוש מסוים. אפשר לפנות בכתב לפרטים שבסעיף 8, או לכתוב לנו באותו ערוץ שבו פניתם. נאמת את זהותכם באופן סביר לפני מסירה או מחיקה של מידע, ונשיב תוך 30 ימים. פרטים על מחיקה נמצאים בעמוד <a href="/legal/data-deletion">מחיקת מידע</a>.</p>
<p>כדי להפסיק לקבל מאיתנו הודעות יזומות, שלחו "הסר" או STOP.</p>
<p>אם לדעתכם לא טיפלנו כראוי במידע שלכם, אפשר לפנות גם לרשות להגנת הפרטיות.</p>

<h2>7. עוגיות</h2>
<p>בצ׳אט באתר נשמר בדפדפן מזהה טכני כדי שהשיחה תישמר בין דפים. מערכת הניהול של הצוות משתמשת בעוגיית התחברות חיונית בלבד. אין עוגיות של פרסום, אנליטיקה או מעקב.</p>

<h2>8. יצירת קשר ושינויים</h2>
${contactHtml(i)}
<p>אם המדיניות תשתנה באופן מהותי, נעדכן את התאריך בראש העמוד.</p>

<section lang="en" dir="ltr" aria-labelledby="en-h">
<h2 id="en-h">Privacy policy – summary in English</h2>
<p>${i.orgName ? esc(i.orgName) : 'We'} operate${i.orgName ? 's' : ''} a self-hosted customer support system. When you contact us through ${esc(channels.length ? channels.map((c) => ({ whatsapp_cloud: 'WhatsApp (Meta WhatsApp Business Platform)', whatsapp: 'WhatsApp', telegram: 'Telegram', webchat: 'our website chat' })[c] ?? c).join(', ') : 'WhatsApp, Telegram or our website chat')}, we process your phone number or channel ID, profile name, the messages and files you send, details you give us in the conversation and delivery metadata.</p>
<ul>
<li><strong>Purpose:</strong> answering and routing your request, automated answers from our own knowledge base (no external AI service), service quality, security and legal obligations. We do not sell personal data or use it for advertising.</li>
<li><strong>Sharing:</strong> messaging providers (Meta/WhatsApp, Telegram) carry the messages under their own terms; authorised staff only; authorities when required by law.</li>
<li><strong>Retention:</strong> ${cfg.MESSAGE_RETENTION_DAYS > 0 ? `conversations are deleted automatically after ${cfg.MESSAGE_RETENTION_DAYS} days of inactivity` : 'conversations are kept while needed for the service and deleted on request'}; encrypted backups are kept up to ${cfg.BACKUP_KEEP} days.</li>
<li><strong>Your rights:</strong> access, correction, a copy, deletion and objection. Contact us${i.email ? ` at <a href="mailto:${esc(i.email)}">${esc(i.email)}</a>` : ''} or write to us in the same chat. See <a href="/legal/data-deletion">data deletion instructions</a>. Reply within 30 days.</li>
</ul>
</section>`;
}

function termsBody(i: LegalInfo): string {
  return `
<p>תנאים אלה חלים על השימוש בערוצי השירות של ${i.orgName ? esc(i.orgName) : 'הארגון'}: ווצאפ, טלגרם וצ׳אט באתר.</p>
<h2>1. השירות</h2>
<p>הערוצים נועדו לפניות, שאלות ובקשות. חלק מהתשובות ניתנות אוטומטית על ידי בוט, לפי תשובות שהוכנו מראש ולפי מאגר ידע שכולל גם מידע מתוך חקיקה, תקנים ומקורות רשמיים. אפשר לבקש בכל שלב לדבר עם נציג.</p>
<h2>2. מידע כללי בלבד</h2>
<p>התשובות, ובמיוחד ציטוטים מחקיקה, תקנים ודרישות רשמיות, הן מידע כללי בלבד, ולא ייעוץ משפטי או מקצועי. הנוסח המחייב הוא הנוסח הרשמי שפורסם. לפני שמקבלים החלטה כדאי לבדוק עם הגורם המוסמך.</p>
<h2>3. לא לשעת חירום</h2>
<p>הערוצים האלה אינם קו חירום. במקרה חירום פנו מיד לגורמי החירום: <strong>משטרה 100, מד״א 101, כבאות והצלה 102</strong>.</p>
<h2>4. שימוש הוגן</h2>
<p>אין לשלוח תוכן פוגעני, מאיים או בלתי חוקי, נוזקות, או הודעות בכמות שמשבשת את השירות. שליחת הודעות רבות בפרק זמן קצר עלולה לגרום לחסימה זמנית אוטומטית.</p>
<h2>5. זמינות</h2>
<p>אנו פועלים כדי שהשירות יהיה זמין, אך הוא עלול להיות מושבת לפרקים, למשל בתחזוקה או בתקלה אצל ספק התקשורת. מענה אנושי ניתן בשעות הפעילות.</p>
<h2>6. פרטיות</h2>
<p>הטיפול במידע שלכם מתואר ב<a href="/legal/privacy">מדיניות הפרטיות</a>.</p>
<h2>7. יצירת קשר</h2>
${contactHtml(i)}

<section lang="en" dir="ltr" aria-labelledby="en-h">
<h2 id="en-h">Terms of use – summary in English</h2>
<p>Our support channels (WhatsApp, Telegram, website chat) are for requests and questions. Some answers are automated from prepared answers and a knowledge base that includes legislation and official standards; they are general information, not legal or professional advice. These channels are <strong>not</strong> an emergency line: in an emergency call 100 (police), 101 (ambulance) or 102 (fire). Do not send abusive or unlawful content or flood the service. See our <a href="/legal/privacy">privacy policy</a>.</p>
</section>`;
}

function deletionBody(i: LegalInfo, cfg: Config): string {
  return `
<p>אפשר לבקש בכל עת למחוק את המידע שלכם ממערכת השירות של ${i.orgName ? esc(i.orgName) : 'הארגון'}.</p>
<h2>איך מבקשים</h2>
<ol>
<li>כתבו לנו "בקשה למחיקת המידע שלי" באותו ערוץ שבו פניתם, כמו ווצאפ, טלגרם או צ׳אט באתר${i.email ? `, או שלחו דוא"ל ל-<a href="mailto:${esc(i.email)}">${esc(i.email)}</a> עם מספר הטלפון או שם המשתמש שממנו פניתם` : ''}.</li>
<li>נאמת שהבקשה באה מכם. למשל, נשלח אישור לאותו חשבון שממנו פניתם.</li>
<li>תוך 30 ימים נמחק את פרטי הקשר שלכם, את השיחות, את ההודעות ואת הקבצים, ונאשר לכם שהמחיקה בוצעה.</li>
</ol>
<h2>מה חשוב לדעת</h2>
<ul>
<li>עותקי גיבוי מוצפנים מתעדכנים במחזור של עד ${cfg.BACKUP_KEEP} ימים, ולכן המידע יימחק מהם סופית בתום המחזור.</li>
<li>ייתכן שנידרש לשמור מידע מסוים לפי דין או לצורך הליך משפטי. במקרה כזה נודיע לכם.</li>
<li>המחיקה חלה על המערכת שלנו. מידע שנשמר אצל ספק התקשורת (WhatsApp/Meta או Telegram) כפוף למדיניות שלו, ואפשר למחוק את השיחה גם באפליקציה שלכם.</li>
<li>כדי רק להפסיק לקבל הודעות יזומות, שלחו "הסר" או STOP.</li>
</ul>
${contactHtml(i)}

<section lang="en" dir="ltr" aria-labelledby="en-h">
<h2 id="en-h">Data deletion instructions</h2>
<ol>
<li>Send "please delete my data" in the same channel you used to contact us (WhatsApp, Telegram or website chat)${i.email ? `, or email <a href="mailto:${esc(i.email)}">${esc(i.email)}</a> with the phone number or username you contacted us from` : ''}.</li>
<li>We verify that the request comes from you (for example, by confirming through the same account).</li>
<li>Within 30 days we delete your contact details, conversations, messages and files from our system and confirm the deletion. Encrypted backups roll over within ${cfg.BACKUP_KEEP} days. Data held by WhatsApp (Meta) or Telegram is subject to their own policies.</li>
</ol>
</section>`;
}

export function legalRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  const send = (reply: FastifyReply, html: string) => reply
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'public, max-age=300')
    // plain document: no scripts at all, only our stylesheet
    .header('content-security-policy', "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    .send(html);
  const channels = async () => (await db.query(`SELECT DISTINCT type FROM channels ORDER BY type`)).rows.map((r) => r.type as string);
  const limit = { rateLimit: { max: 120, timeWindow: '1 minute' } };

  app.get('/legal/style.css', { config: limit }, async (_req, reply) => reply.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'public, max-age=86400').send(CSS));
  app.get('/legal/privacy', { config: limit }, async (_req, reply) => { const i = await loadLegal(db); return send(reply, page('מדיניות פרטיות', privacyBody(i, await channels(), cfg), i)); });
  app.get('/legal/terms', { config: limit }, async (_req, reply) => { const i = await loadLegal(db); return send(reply, page('תנאי שימוש', termsBody(i), i)); });
  app.get('/legal/data-deletion', { config: limit }, async (_req, reply) => { const i = await loadLegal(db); return send(reply, page('מחיקת מידע', deletionBody(i, cfg), i)); });

  // the organisation's details shown on the pages
  app.get('/settings/legal', { preHandler: requireAuth(db, 'settings.view') }, async () => {
    const origin = cfg.APP_ORIGIN.split(',')[0]!.trim().replace(/\/$/, '');
    return { ...(await loadLegal(db)), urls: { privacy: `${origin}/legal/privacy`, terms: `${origin}/legal/terms`, deletion: `${origin}/legal/data-deletion` } };
  });
  app.put('/settings/legal', { preHandler: requireAuth(db, 'settings.manage'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const line = (max: number) => z.string().trim().max(max).regex(/^[^<>\r\n]*$/);
    const b = z.object({
      orgName: line(120), email: z.union([z.literal(''), z.string().trim().email().max(200)]), phone: z.string().trim().max(40).regex(/^[\d+\-() ]*$/),
      address: line(200), officer: line(120), approved: z.boolean(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query(`INSERT INTO settings (key, value) VALUES ('legal', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(b.data)]);
    await audit(db, { actorId: req.user!.id, action: 'settings.legal', ip: req.ip, meta: { approved: b.data.approved } });
    return { ok: true };
  });
}
