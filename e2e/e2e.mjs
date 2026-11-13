import { chromium } from 'playwright-core';
import { authenticator } from 'otplib';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const BASE = 'http://localhost:3077';
const axeSrc = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const psql = (sql) => execSync(`psql -h localhost -U postgres -d botwa_e2e -tAc "${sql}"`, { env: { ...process.env, PGPASSWORD: 'pw' } }).toString().trim();
let failures = 0;
const openMore = async () => { await page.evaluate(() => { const d = document.querySelector('details.more'); if (d) d.open = true; }); };
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'he-IL' });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

async function axe(label) {
  await page.evaluate(axeSrc);
  const r = await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }));
  check(`axe: ${label}`, r.violations.length === 0, r.violations.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes.slice(0, 3).map((x) => `${x.html.slice(0, 90)} @ ${x.target.join(' ')} :: ${(x.any[0]?.message ?? '').slice(0, 140)}`).join(' || ')}`).join(' | '));
}

await page.goto(BASE);
check('RTL + lang', (await page.getAttribute('html', 'dir')) === 'rtl' && (await page.getAttribute('html', 'lang')) === 'he');
await axe('login');

// wrong password -> generic error
await page.fill('#email', 'admin@e2e.io'); await page.fill('#pw', 'wrong-wrong-wrong');
await page.click('button[type=submit]');
await page.waitForSelector('[role=alert]:has-text("שגויים")');
check('login error shown', true);

// good login -> forced MFA enrolment
await page.fill('#pw', 'e2e-password-123'); await page.click('button[type=submit]');
await page.waitForSelector('text=מחייב אימות דו-שלבי');
check('forced MFA banner', true);
await page.click('text=הגדרת אימות דו-שלבי');
const secret = (await page.textContent('code')).trim();
await page.fill('#mfa-code', authenticator.generate(secret)); await page.click('button:has-text("הפעלה")');
await page.click('aside.sidebar nav >> text=החשבון שלי');
await page.waitForSelector('text=אימות דו-שלבי פעיל');
check('MFA enabled', true);
await axe('account');
// sign-out is always reachable: on screen at the bottom of the side menu (even a short window), and on the account page
await page.setViewportSize({ width: 1200, height: 560 });
const outBox = await page.locator('aside.sidebar .side-foot button:has-text("התנתקות")').boundingBox();
check('sign-out button is inside the visible window', !!outBox && outBox.y >= 0 && outBox.y + outBox.height <= 560, JSON.stringify(outBox));
await page.setViewportSize({ width: 1280, height: 720 });
check('account page offers sign-out and sign-out everywhere', await page.isVisible('main button:text-is("התנתקות")') && await page.isVisible('main button:has-text("התנתקות מכל המכשירים")'));
// how I am introduced to customers when I take an inquiry: role and an optional work phone, with a live preview
await page.fill('#intro-he', 'Admin');
check('intro: a Hebrew name must contain Hebrew letters', (await page.getAttribute('#intro-he', 'aria-invalid')) === 'true');
await page.fill('#intro-he', 'מנהלת המערכת');
await page.fill('#intro-title', 'ממונת בטיחות, הפקולטה לכימיה');
await page.fill('#intro-phone', 'not a phone');
check('intro: a wrong phone is flagged and cannot be saved', await page.isDisabled('section[aria-labelledby="intro-h"] button[type=submit]') && (await page.getAttribute('#intro-phone', 'aria-invalid')) === 'true');
await page.fill('#intro-phone', '04-8291234');
check('intro: the preview shows the Hebrew name and the role', (await page.textContent('.intro-preview')).includes('כאן מנהלת המערכת, ממונת בטיחות, הפקולטה לכימיה. אני אטפל בפנייתך'));
await axe('account: how I am introduced');
await page.click('section[aria-labelledby="intro-h"] button[type=submit]');
await page.waitForSelector('section[aria-labelledby="intro-h"] [role=status].ok');
check('intro: role and phone saved', (await page.evaluate(() => fetch('/auth/me').then((r) => r.json()))).jobTitle === 'ממונת בטיחות, הפקולטה לכימיה');

// channels
await page.click('aside.sidebar nav >> text=ערוצים');
await page.fill('#ch-label', 'תמיכה ראשית'); await page.click('button:has-text("יצירה")');
await page.waitForSelector('text=תמיכה ראשית');
await page.waitForSelector('#health-h');
await page.waitForSelector('th:has-text("נשלחו (ב-24 שעות")');
check('channel health panel present', true);
await page.waitForSelector('th:has-text("סיכון חסימה")');
await page.click('button:has-text("עצירת חירום של שליחה")');
await page.waitForSelector('text=השליחה מושהית ידנית.');
await axe('channels: paused');
await page.click('button:has-text("חידוש שליחה")');
await page.waitForSelector('button:has-text("עצירת חירום של שליחה")');
// official WhatsApp (Cloud API) channel: create, configure panel is accessible, credentials never shown back, then remove
await page.fill('#ch-label', 'רשמי'); await page.selectOption('#ch-type', 'whatsapp_cloud'); await page.click('button:has-text("יצירה")');
await page.waitForSelector('li.card:has-text("רשמי")');
await page.click('li.card:has-text("רשמי") >> button:has-text("הגדרת הערוץ הרשמי")');
await page.waitForSelector('text=כתובת Webhook (Callback URL)');
check('official channel shows webhook URL and verify token', (await page.textContent('li.card:has-text("רשמי")'))?.includes('/webhooks/whatsapp/') && (await page.textContent('li.card:has-text("רשמי")'))?.includes('Verify token'));
await axe('channels: official WhatsApp setup');
// the health table shows the official number by its monthly count, not the daily cap and ban risk of QR channels
{ const row = 'section[aria-labelledby="health-h"] tbody tr:has(th:text-is("רשמי"))';
  await page.waitForSelector(`${row} td:has-text("החודש:")`);
  const txt = await page.textContent(row);
  check('health: the official number shows its monthly count out of 1,000 and no ban risk', /מתוך 1,000/.test(txt) && txt.includes('אין סיכון חסימה'), txt); }
// monthly outgoing count of the official number: shown on the card, the limit (1000 by default) can be changed
await page.waitForSelector('li.card:has-text("רשמי") .usage meter');
check('official channel: monthly outgoing count against 1000 by default', /0\s*מתוך\s*1,000/.test(await page.textContent('li.card:has-text("רשמי") .usage-num')), await page.textContent('li.card:has-text("רשמי") .usage-num'));
await page.click('li.card:has-text("רשמי") >> button:has-text("שינוי המגבלה")');
await page.fill('li.card:has-text("רשמי") input[id^="us-l-"]', '500');
await page.check('li.card:has-text("רשמי") input[type=radio][name^="us-a-"] >> nth=1');
await axe('channels: monthly limit form');
await page.click('li.card:has-text("רשמי") .usage button:has-text("שמירה")');
await page.waitForSelector('li.card:has-text("רשמי") .usage-num:has-text("500")');
check('official channel: monthly limit saved', (await page.textContent('li.card:has-text("רשמי") .usage')).includes('לעצור הודעות אוטומטיות'));
await page.click('li.card:has-text("רשמי") >> button:has-text("מחיקת ערוץ")');
await page.click('dialog[open] button:has-text("אישור")');
await page.waitForFunction(() => !document.body.textContent?.includes('ווצאפ רשמי (Cloud API)'));
check('official channel can be removed', true);
// Messenger / Instagram channels: setup panel with webhook details, accessible; Instagram asks for its account id
await page.fill('#ch-label', 'אינסטה'); await page.selectOption('#ch-type', 'instagram'); await page.click('button:has-text("יצירה")');
await page.waitForSelector('li.card:has-text("אינסטה")');
await page.click('li.card:has-text("אינסטה") >> button:has-text("הגדרת Instagram")');
await page.waitForSelector('li.card:has-text("אינסטה") >> text=כתובת Webhook (Callback URL)');
check('Instagram channel shows its webhook URL and asks for the account id', (await page.textContent('li.card:has-text("אינסטה")'))?.includes('/webhooks/meta/') && await page.isVisible('li.card:has-text("אינסטה") >> label:has-text("Instagram account ID")'));
await axe('channels: Instagram setup');
await page.click('li.card:has-text("אינסטה") >> button:has-text("מחיקת ערוץ")');
await page.click('dialog[open] button:has-text("אישור")');
await page.waitForFunction(() => ![...document.querySelectorAll('li.card strong')].some((e) => e.textContent === 'אינסטה'));
check('Instagram channel can be removed', true);
// e-mail channel: settings form is accessible; a wrong host is explained; nothing secret comes back
await page.fill('#ch-label', 'תיבת שירות'); await page.selectOption('#ch-type', 'email'); await page.click('button:has-text("יצירה")');
await page.waitForSelector('li.card:has-text("תיבת שירות")');
await page.click('li.card:has-text("תיבת שירות") >> button:has-text("הגדרת תיבת הדואר")');
await page.waitForSelector('input[id^="em-"][id$="-ih"]');
await axe('channels: e-mail settings');
await page.fill('input[id^="em-"][id$="-ih"]', 'https://mail.example.com');
await page.fill('input[id^="em-"][id$="-sh"]', 'mail.example.com');
await page.fill('input[id^="em-"][id$="-u"]', 'support@example.com');
await page.fill('input[id^="em-"][id$="-pw"]', 'not-a-real-password');
await page.fill('input[id^="em-"][id$="-fa"]', 'support@example.com');
await page.click('li.card:has-text("תיבת שירות") >> button:has-text("שמירה וחיבור")');
await page.waitForSelector('li.card:has-text("תיבת שירות") >> text=שם השרת לא תקין', { timeout: 8000 }).catch(() => undefined);
check('e-mail: an invalid server name is explained', await page.isVisible('li.card:has-text("תיבת שירות") >> text=שם השרת לא תקין'));
await page.click('li.card:has-text("תיבת שירות") >> button:has-text("מחיקת ערוץ")');
await page.click('dialog[open] button:has-text("אישור")');
await page.waitForFunction(() => ![...document.querySelectorAll('li.card strong')].some((e) => e.textContent === 'תיבת שירות'));

check('emergency pause and resume work from the panel', true);
await axe('channels');
await page.click('text=קישור עם מספר טלפון (בלי QR)');
await page.waitForSelector('input[placeholder="972501234567"]');
await axe('phone-number pairing form');
await page.click('button:has-text("תמונת פרופיל")');
await page.waitForSelector('section:has(h3:has-text("תמונת הפרופיל בווצאפ"))');
check('WhatsApp profile picture panel: explains the rules and waits for a connected channel', await page.isVisible('text=לפחות 192×192 פיקסלים') && await page.isDisabled('button:has-text("בחירת תמונה")'));
await axe('channels: WhatsApp profile picture');
await page.click('button:has-text("תמונת פרופיל")');
await page.click('text=קישור עם מספר טלפון (בלי QR)');
await page.click('text=קישור / הפעלה');
// no phone: expect connecting/qr status, never a crash. Real WhatsApp servers unreachable in sandbox.
await page.waitForSelector('[role=status] .badge', { timeout: 10000 });
check('link panel shows status', true, await page.textContent('[role=status] .badge'));
await page.click('button:has-text("סגירה")');
await page.click('text=ניתוק החשבון');
check('confirm dialog open', await page.isVisible('dialog[open]'));
await page.keyboard.press('Escape');
check('dialog closed by Esc', !(await page.isVisible('dialog[open]')));

// team
await page.click('aside.sidebar nav >> text=צוות');
await page.fill('#u-name', 'דנה נציגה'); await page.fill('#u-email', 'dana@e2e.io'); await page.fill('#u-pw', 'agent-password-123');
await page.click('button:has-text("יצירת משתמש")');
await page.waitForSelector('td:has-text("dana@e2e.io")');
check('team: the new person got a username from the e-mail', await page.isVisible('td:has-text("@dana")'));
await axe('team');
// many users from a workbook: the template's two people, one first password, created in one click
{ const tpl = await page.evaluate(async () => { const r = await fetch('/users/import/template.xlsx'); return Array.from(new Uint8Array(await r.arrayBuffer())); });
  await page.setInputFiles('#ui-file', { name: 'people.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(tpl) });
  await page.waitForSelector('section[aria-labelledby="ui-h"] tbody tr', { timeout: 20000 });
  check('users import: the people in the workbook are shown before anything is created', (await page.locator('section[aria-labelledby="ui-h"] tbody tr').count()) === 2 && (await page.textContent('section[aria-labelledby="ui-h"] tbody')).includes('ממונת בטיחות'));
  await page.click('section[aria-labelledby="ui-h"] button:has-text("סיסמה חזקה")');
  await axe('team: users import preview');
  await page.click('section[aria-labelledby="ui-h"] button:has-text("יצירת 2 משתמשים")');
  await page.waitForSelector('section[aria-labelledby="ui-h"] [role=status].ok', { timeout: 20000 });
  await page.waitForSelector('td:has-text("avi@example.org")');
  check('users import: created in one click, each must change the first password', (await page.textContent('section[aria-labelledby="ui-h"] [role=status].ok')).includes('נוצרו 2 משתמשים')); }

// reports page
await page.click('aside.sidebar nav >> text=דוחות');
await page.waitForSelector('text=זמן תגובה ממוצע');
const csvHref = await page.getAttribute('a[href*="export.csv?kind=agents"]', 'href');
const csvRes = await page.request.get(BASE + csvHref);
check('reports CSV export downloads', csvRes.ok() && (csvRes.headers()['content-type'] ?? '').includes('text/csv') && (await csvRes.text()).includes('messages_sent'));
await axe('reports');

// settings + audit pages (admin)
await page.click('aside.sidebar nav >> text=הגדרות');
await page.waitForSelector('#away');
await page.check('text=הפעלת מענה אוטומטי מחוץ לשעות');
await page.click('button:has-text("שמירה")');
await page.waitForSelector('text=ההגדרות נשמרו');
await axe('settings');
// conversation automations: a ready phrasing fills the text box; switching on and saving works
await page.waitForSelector('#auto-h');
await page.selectOption('select[aria-label^="ניסוח מוכן: סגירה"]', { index: 2 });
check('automations: a ready phrasing fills the closing text', (await page.inputValue('#au-ct')).startsWith('הפנייה נסגרה עקב היעדר מענה'));
await page.check('#auto-h ~ fieldset >> nth=0 >> input[role="switch"]');
await page.click('button:has-text("שמירת האוטומציות")');
await page.waitForSelector('text=האוטומציות נשמרו.', { timeout: 8000 }).catch(() => undefined);
check('automations: saved', await page.isVisible('text=האוטומציות נשמרו.'));
await axe('settings: automations');
await page.selectOption('#route', 'round_robin');
await page.waitForSelector('text=נשמר.');
await page.waitForSelector('#s-min');
await page.waitForSelector('#s-rw');
await axe('settings: sending protection');
await page.click('button:has-text("גיבוי מלא עכשיו")');
await page.waitForSelector('text=הגיבוי המלא נוצר.', { timeout: 60000 });
await page.waitForSelector('a:has-text("הורדה")');
await page.click('button:has-text("בדיקת תקינות")');
await page.waitForSelector('text=קבצים מצורפים', { timeout: 60000 });
check('full backup verifies with its attachment files', true);
await axe('settings with routing + backups');
const bkHref = await page.getAttribute('a:has-text("הורדה")', 'href');
const bk = await page.request.get(BASE + bkHref);
check('backup download is encrypted (full backup)', bk.ok() && (await bk.body()).subarray(0, 8).toString() === 'BOTWAFU1');
await page.click('button:has-text("מחיקה")');
await page.click('dialog[open] button:has-text("אישור")');
await page.waitForSelector('text=אין גיבויים.');
await page.selectOption('#route', 'off');
await page.waitForSelector('text=נשמר.');
await page.uncheck('text=הפעלת מענה אוטומטי מחוץ לשעות');
await page.click('button:has-text("שמירה")');
await page.waitForSelector('text=ההגדרות נשמרו');
await page.click('aside.sidebar nav >> text=בוט');
await page.waitForSelector('#b-welcome');
await page.check('text=הפעלת הבוט');
await page.click('button:has-text("הוספת פריט")');
await page.fill('#bt2', 'משלוחים');
await page.fill('#ba2', 'משלוח תוך 3 ימי עסקים.');
await page.waitForSelector('pre:has-text("3. משלוחים")');
await page.click('button:has-text("שמירה")');
await page.waitForSelector('text=הבוט נשמר.');
await axe('bot settings');
// the bot's identity: Betty in one click; her picture and name are shown, always marked as a bot
await page.click('button:has-text("בטי, הבוט של יחידת הבטיחות")');
await page.waitForSelector('.persona-face img', { timeout: 15000 }).catch(() => undefined);
check('bot identity: Betty is set with her picture and the word "בוט"', await page.isVisible('.persona-face img') && (await page.textContent('.persona-preview strong')) === 'בטי (בוט)');
await axe('bot settings: identity');
check('bot answers: choice between a quote and a local model, with the model status', await page.isVisible('text=אופן הניסוח של התשובה') && await page.isVisible('text=מודל מקומי לא הותקן בשרת'));
await page.reload();
await page.waitForSelector('#bt2');
check('bot settings persisted (3 items, enabled)', (await page.inputValue('#bt2')) === 'משלוחים' && (await page.isChecked('text=הפעלת הבוט')));
await page.uncheck('text=הפעלת הבוט');
await page.click('button:has-text("שמירה")');
await page.waitForSelector('text=הבוט נשמר.');
await page.click('aside.sidebar nav >> text=יומן ביקורת');
await page.waitForSelector('td:has-text("כניסה למערכת")');
await page.selectOption('#af', { label: 'ערוצים' });
await page.waitForSelector('td:has-text("יצירת ערוץ")');
await axe('audit log');
await page.selectOption('#af', { label: 'הכול' });
await page.waitForSelector('td:has-text("הפעלת אימות דו-שלבי")');

// knowledge base: add a Q&A, test the search, check every tab for accessibility
await page.click('aside.sidebar nav >> text=מאגר ידע');
await page.waitForSelector('h1:has-text("מאגר ידע")');
await page.click('button.chip:has-text("הבוט לומד")');
await page.waitForSelector('#learn-h');
await page.waitForSelector('#learn-fb');
check('kb: the "bot learns" screen shows stats and the three suggestion lists', (await page.locator('section[aria-labelledby^="learn-"] h3').count()) >= 4);
await page.waitForTimeout(400);
await axe('kb: bot learns');
// laws and regulations: settings screen (no network in the test: only the screen, the choice list and saving)
await page.click('button.chip:has-text("חקיקה ותקינה")');
await page.waitForSelector('#gov-h');
check('kb: the law import offers the recommended list of regulations', (await page.locator('.gov-list input[type=checkbox]:checked').count()) >= 20);
check('kb: law import is staff-only by default', (await page.inputValue('#gov-aud')) === 'staff');
await page.selectOption('#gov-aud', 'both');
check('kb: choosing the bot warns that it will quote laws', await page.isVisible('#gov-aud-w'));
await page.selectOption('#gov-aud', 'staff');
await page.fill('#gov-q', 'גובה');
check('kb: the regulations list can be filtered', (await page.locator('.gov-list li').count()) === 1);
await page.click('#gov-h ~ div.row button.primary, section[aria-labelledby="gov-h"] button.primary');
await page.waitForSelector('section[aria-labelledby="gov-h"] p.ok:has-text("ההגדרות נשמרו")');
await page.waitForTimeout(300);
await page.waitForSelector('#std-h');
check('kb: official standards offer the recommended safety words', (await page.inputValue('#std-kw')).includes('סולמ*'));
check('kb: official standards are staff-only by default', (await page.inputValue('#std-aud')) === 'staff');
await page.click('section[aria-labelledby="std-h"] button.primary');
await page.waitForSelector('section[aria-labelledby="std-h"] p.ok:has-text("ההגדרות נשמרו")');
await page.waitForSelector('#fire-h');
check('kb: fire licensing requirements start with loading the business types (nothing imported by default)', await page.isVisible('section[aria-labelledby="fire-h"] button:has-text("טעינת סוגי העסקים מהמקור")'));
await axe('kb: laws and regulations');
await page.click('button.chip:has-text("מקורות")');
await page.click('button:has-text("שאלה ותשובה")');
await page.fill('#kb-t', 'מהן שעות הפעילות שלכם?');
await page.fill('#kb-b', 'פתוחים בימים א׳–ה׳ בין 9:00 ל-17:00.');
await axe('knowledge base: add form');
await page.click('form button[type=submit]:has-text("הוספה")');
await page.waitForSelector('th:has-text("מהן שעות הפעילות שלכם?")');
await page.waitForSelector('.badge:has-text("מוכן")');
check('knowledge base: FAQ added and indexed', true);
await axe('knowledge base: sources');
await page.click('.chips >> text=מקורות');
await page.click('button:has-text("הוספת קישור")');
await page.selectOption('#kb-crawl', '25');
await page.click('summary:has-text("אפשרויות סריקה מתקדמות")');
await page.fill('#sc-exc', '/login'); await page.fill('#sc-sel', 'main');
check('knowledge base: advanced scrape options are available', (await page.locator('#sc-depth').count()) === 1 && (await page.locator('button:has-text("תצוגה מקדימה")').count()) === 1);
await axe('knowledge base: advanced scrape options');
await page.fill('#kb-url', 'http://127.0.0.1/'); await page.click('button:has-text("תצוגה מקדימה")');
await page.waitForSelector('text=כתובת חסומה מטעמי אבטחה');
check('knowledge base: preview refuses an internal address', true);
await page.click('.chips >> text=בדיקת חיפוש');
await page.fill('#pg-q', 'בשעות הפעילות');
await page.click('button:has-text("בדיקה")');
await page.waitForSelector('text=הבוט היה עונה.');
check('knowledge base: playground finds the answer despite a Hebrew prefix', true);
await axe('knowledge base: playground');
for (const tab of ['שאלות ללא מענה', 'מילים נרדפות', 'סטטיסטיקה', 'בריאות וכלים']) { await page.click(`.chips >> text=${tab}`); await page.waitForTimeout(400); await axe(`knowledge base: ${tab}`); }
await page.click('aside.sidebar nav >> text=בוט');
await page.waitForSelector('legend:has-text("מענה ממאגר הידע")');
await axe('bot page with knowledge base settings');
// flow chart editor: create from the menu, edit, save, simulate, accessibility
await page.click('aside.sidebar nav >> text=תרשים זרימה');
await page.waitForSelector('h1:has-text("תרשים זרימה של הבוט")');
page.once('dialog', (d) => d.accept());
await page.click('button:has-text("יצירה מהתפריט הממוספר הקיים")');
await page.waitForSelector('svg.flow-svg');
check('flow editor: flow created from the numbered menu', (await page.locator('svg.flow-svg g.flow-node').count()) >= 3);
await axe('flow editor: diagram');
await page.focus('svg.flow-svg g.flow-node');
await page.keyboard.press('Enter');
await page.waitForSelector('.flow-side fieldset');
check('flow editor: a node opens from the keyboard in the side panel', true);
await axe('flow editor: node form');
// drag a node with the mouse: it moves (snapped to the grid) and keeps its place
const nodeA2 = page.locator('svg.flow-svg g[data-node-id="a2"] rect.flow-box');
await nodeA2.scrollIntoViewIfNeeded();
const xBefore = Number(await nodeA2.getAttribute('x'));
const bb = await nodeA2.boundingBox();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
await page.mouse.down();
await page.mouse.move(bb.x + bb.width / 2 + 120, bb.y + bb.height / 2 + 80, { steps: 8 });
await page.mouse.up();
const xAfter = Number(await nodeA2.getAttribute('x'));
check('flow editor: a node is dragged to a new place', xAfter !== xBefore && xAfter % 10 === 0, `${xBefore} -> ${xAfter}`);
// the keyboard alternative: arrow keys move the focused node
await page.focus('svg.flow-svg g[data-node-id="a2"]');
const yBefore = Number(await nodeA2.getAttribute('y'));
await page.keyboard.press('ArrowDown');
check('flow editor: arrow keys move the focused node', Number(await nodeA2.getAttribute('y')) === yBefore + 10);
await page.keyboard.press('Control+z');
check('flow editor: undo (Ctrl+Z) restores the previous position', Number(await nodeA2.getAttribute('y')) === yBefore);
await page.selectOption('#fl-add', 'question'); await page.click('.flow-add button:has-text("הוספה")');
await page.waitForSelector('.flow-side input[id^="sv-"]');
// connect by dragging from the new node's handle to the first node
const edgesBefore = await page.locator('svg.flow-svg .flow-edge-g').count();
const newId = await page.locator('svg.flow-svg g.flow-node.sel').getAttribute('data-node-id');
const port = page.locator(`svg.flow-svg g[data-node-id="${newId}"] circle.flow-port`).first();
await port.scrollIntoViewIfNeeded();
const pb = await port.boundingBox();
const tb = await page.locator('svg.flow-svg g[data-node-id="a2"] rect.flow-box').boundingBox();
await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
await page.mouse.down();
await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 10 });
await page.mouse.up();
check('flow editor: dragging from a handle to a node connects them', (await page.locator('svg.flow-svg .flow-edge-g').count()) === edgesBefore + 1);
await axe('flow editor: canvas after editing');
await page.click('svg.flow-svg g[data-node-id="a2"] rect.flow-box'); await page.fill('#tx-a2', 'אפשר ליצור איתנו קשר בטלפון 03-0000000.');
await page.click('button:has-text("שמירה")');
await page.waitForSelector('text=התרשים נשמר.');
check('flow editor: saved', true);
await page.click('.chips >> text=בדיקה בשיחה');
await page.fill('#sim-in', 'שלום'); await page.click('button:has-text("שליחה")');
await page.waitForSelector('.sim-msg.bot:has-text("1.")');
check('flow editor: simulator shows the menu', true);
await axe('flow editor: simulator');
await page.click('.chips >> text=תרשים ועריכה');
await page.click('button:has-text("הפעלת התרשים כמצב הבוט")');
await page.waitForSelector('text=הבוט עובד כעת לפי התרשים.');
await page.click('button:has-text("חזרה לתפריט הממוספר")');
await page.waitForSelector('text=הבוט עובד כעת לפי התפריט הממוספר.');

// safety unit: the template, unfinished placeholders block activation, the simulator accepts a photo, areas and the board
page.removeAllListeners('dialog'); page.once('dialog', (d) => d.accept());
await page.click('button:has-text("יצירת תרשים בטיחות לפי האפיון")');
check('safety template: nothing is left to fill in', (await page.locator('[role="note"]').count()) === 0);
await page.click('button:has-text("שמירה")');
await page.waitForSelector('text=התרשים נשמר.');
check('safety template: activation is enabled', await page.isEnabled('button:has-text("הפעלת התרשים כמצב הבוט")'));
await axe('flow editor: safety template');
await page.click('.chips >> text=בדיקה בשיחה');
await page.fill('#sim-in', 'שלום'); await page.click('button:has-text("שליחה")');
await page.waitForSelector('.sim-msg.bot:has-text("שם מלא")');
await page.fill('#sim-in', 'דנה לוי'); await page.click('button:has-text("שליחה")');
await page.waitForSelector('.sim-msg.bot:has-text("בניין")');
check('safety template: identification starts in the simulator', true);
await page.click('button:has-text("שליחת תמונה")');
await axe('flow editor: simulator with identification');
await page.click('aside.sidebar nav >> text=לוח בטיחות');
await page.waitForSelector('h1:has-text("לוח בטיחות")');
await axe('safety board');
await page.evaluate(() => document.querySelectorAll('details.card').forEach((d) => { d.open = true; }));
await page.waitForSelector('summary:has-text("אזורי אחריות")');
await page.click('button:has-text("הוספת אזור")');
await page.fill('#ar-n', 'מדעי החיים'); await page.fill('#ar-k', 'בניין 12\nבניין 13');
await page.click('form:has(#ar-n) button:has-text("שמירה")');
await page.waitForSelector('td:has-text("בניין 12, בניין 13")');
check('safety board: a responsibility area is added', true);
await axe('safety board: management');
await page.evaluate(() => document.querySelectorAll('details.card').forEach((d) => { d.open = true; }));
await page.click('button:has-text("הוספת ממונה")');
await page.fill('#of-n', 'ממונה לדוגמה'); await page.fill('#of-e', 'officer@example.org'); await page.fill('#of-p', '050-123-4567');
await page.click('#of-t ~ .chips >> text=לייזרים');
await axe('safety board: officers form');
await page.click('form:has(#of-n) button:has-text("שמירה")');
await page.waitForSelector('th:has-text("ממונה לדוגמה")');
check('safety board: an officer with topics is added', (await page.textContent('tr:has(th:has-text("ממונה לדוגמה"))')).includes('לייזרים') && (await page.getAttribute('tr:has(th:has-text("ממונה לדוגמה")) a[href^="https://wa.me/"]', 'href')) === 'https://wa.me/972501234567');
await axe('safety board: officers');

// branding: name, logo, colour (adapted for contrast), colours pulled from a site (internal addresses are refused)
await page.click('aside.sidebar nav >> text=הגדרות');
await page.waitForSelector('#br-name');
await page.waitForSelector('#fw-h');
check('settings: group forwarding card is there', true);
if (await page.locator('button:has-text("הוספת כלל")').isEnabled()) await page.click('button:has-text("הוספת כלל")');
await axe('settings: group forwarding');
await page.waitForSelector('#fw-sec-h');
check('settings: security page shows the antivirus status and the panel firewall', (await page.textContent('#av-sec-h ~ p, section[aria-labelledby="av-sec-h"]')).includes('הסורק'));
await page.click('button:has-text("הוספת הכתובת שלי")');
check('settings: "add my address" fills the allow list', (await page.inputValue('#fw-allow')).trim().length > 0);
await axe('settings: security');
await page.waitForSelector('#csv-h');
await page.waitForSelector('#csv-file');
await page.setInputFiles('#csv-file', { name: 'c.csv', mimeType: 'text/csv', buffer: Buffer.from('phone,name\n0501112222,דנה\nbad,x\n') });
await page.click('button:has-text("בדיקה מקדימה")');
await page.waitForSelector('text=1 אנשי קשר חדשים');
check('settings: contacts CSV preview works and counts invalid rows', (await page.textContent('#csv-h ~ div[role=status]')).includes('1 שורות לא תקינות'));
await axe('settings: contacts import preview');
await page.fill('#br-name', 'בטיחון'); await page.fill('#br-color', '#0f766e');
await page.click('button:has-text("שמירת שם וצבע")');
await page.waitForSelector('text=המיתוג נשמר.');
check('branding: the brand colour reaches the page', (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().length)) > 0 && (await page.textContent('aside.sidebar .brand strong')) === 'בטיחון');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
writeFileSync('/tmp/e2e-logo.png', png);
await page.setInputFiles('#br-logo', '/tmp/e2e-logo.png'); await page.click('button:has-text("העלאה")');
await page.waitForSelector('text=הלוגו הוחלף.');
check('branding: the logo shows in the menu', (await page.locator('aside.sidebar img.brand-logo').count()) === 1);
await page.fill('#br-site', 'http://127.0.0.1'); await page.click('button:has-text("משיכת צבעים ולוגו")');
await page.waitForSelector('text=הכתובת חסומה');
check('branding: an internal address is refused', true);
await axe('settings: branding');
await page.fill('#br-color', ''); await page.click('button:has-text("שמירת שם וצבע")'); await page.waitForSelector('text=המיתוג נשמר.');
await page.click('button:has-text("הסרת הלוגו")'); await page.waitForSelector('text=הלוגו הוסר.');
await page.fill('#br-name', 'Botwa'); await page.click('button:has-text("שמירת שם וצבע")'); await page.waitForSelector('text=המיתוג נשמר.');

// side menu: resize with the keyboard, collapse to icons, hide and show again
const sbw = () => page.evaluate(() => Math.round(document.querySelector('aside.sidebar').getBoundingClientRect().width));
const w0 = await sbw();
await page.focus('.sb-handle'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
check('side menu: the keyboard widens it', (await sbw()) === w0 + 32, `${w0} -> ${await sbw()}`);
await page.keyboard.press('ArrowRight');
check('side menu: the keyboard narrows it', (await sbw()) === w0 + 16);
await page.click('button[aria-label="כיווץ התפריט לסמלים"]');
check('side menu: collapses to icons', (await sbw()) < 100 && (await page.locator('aside.sidebar .nav-link').first().getAttribute('title')) !== null);
await axe('side menu: icons only');
await page.click('button[aria-label="הרחבת התפריט"]');
await page.click('button[aria-label="הסתרת התפריט"]');
check('side menu: hides', !(await page.locator('aside.sidebar').isVisible()));
await axe('side menu: hidden');
await page.click('button[aria-label="הצגת התפריט"]');
check('side menu: shows again', await page.locator('aside.sidebar').isVisible());
await page.focus('.sb-handle'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
await page.dblclick('.sb-handle', { force: true });
check('side menu: double click restores the width', (await sbw()) === 264);

// ============ appearance menu stays on screen; advanced options; inbox filters do not get cut off ============
await page.click('aside.sidebar nav >> text=שיחות');
await page.waitForSelector('.list-pane');
const inside = (sel, box) => page.evaluate(([q, b]) => { const els = [...document.querySelectorAll(q)]; const r0 = document.querySelector(b).getBoundingClientRect(); return els.length > 0 && els.every((e) => { const r = e.getBoundingClientRect(); return r.left >= r0.left - 1 && r.right <= r0.right + 1; }); }, [sel, box]);
check('inbox: every filter chip is fully inside the list', await inside('.list-pane .chips .chip', '.list-pane'));
await page.click('.inbox-adv summary');
await page.selectOption('#lp-sort', 'waiting'); await page.check('text=רק עם הודעות שלא נקראו');
check('inbox: advanced filter is applied and marked active', (await page.textContent('.inbox-adv summary')).includes('פעילות'));
await axe('inbox: advanced options');
await page.click('button:has-text("ניקוי הסינון המתקדם")');
await page.click('aside.sidebar button[aria-label="מראה המערכת"]');
await page.waitForSelector('#theme-pop');
check('appearance menu: fully inside the window', await page.evaluate(() => { const r = document.querySelector('#theme-pop').getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth; }));
await page.click('#theme-pop summary:has-text("אפשרויות מתקדמות")');
await page.waitForTimeout(150);
check('appearance menu: still inside the window with the advanced part open', await page.evaluate(() => { const r = document.querySelector('#theme-pop').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight + 1; }));
await page.click('#theme-pop button[role=radio]:has-text("גדול מאוד")');
await page.click('#theme-pop button[role=radio]:has-text("צפופה")');
await page.fill('#th-hex', '#0f766e');
check('appearance: text size, density and own colour are applied', await page.evaluate(() => document.documentElement.dataset.font === 'xl' && document.documentElement.dataset.density === 'compact' && document.documentElement.style.getPropertyValue('--accent') !== ''));
await page.waitForTimeout(700);   // colour transitions finish before the contrast check
await axe('appearance menu with advanced options');
await page.click('#theme-pop button:has-text("איפוס כל ההגדרות")');
check('appearance: reset restores the defaults', await page.evaluate(() => document.documentElement.dataset.font === 'm' && document.documentElement.dataset.density === 'comfortable' && document.documentElement.style.getPropertyValue('--accent') === ''));
await page.keyboard.press('Escape');


// website chat widget: configure, embed on a "customer site", chat both ways, blocked on an unlisted site
await page.click('aside.sidebar nav >> text=ערוצים');
await page.fill('#ch-label', 'האתר שלנו'); await page.selectOption('#ch-type', 'webchat'); await page.click('button:has-text("יצירה")');
await page.waitForSelector('li.card:has-text("צ׳אט באתר")');
await page.click('li.card:has-text("האתר שלנו") >> button:has-text("הגדרת הוויגיט וקוד ההטמעה")');
await page.waitForSelector('textarea[id^="wc-code-"]');
const embed = await page.inputValue('textarea[id^="wc-code-"]');
check('widget: embed code shown', /<script src="http:\/\/localhost:3077\/widget\.js" data-key="wc_[\w-]+" async><\/script>/.test(embed), embed);
await page.selectOption('select[id^="wc-askName-"]', 'required');
await page.fill('input[id^="wc-cons-"]', 'אני מאשר את מדיניות הפרטיות');
await page.click('button:has-text("הוספת כפתור")');
await page.fill('input[id^="wc-soc-"][id$="-sh-0"]', '972501234567');
await page.click('button:has-text("הוספת כפתור")');
await page.fill('input[id^="wc-soc-"][id$="-sh-1"]', 'my.shop');
await axe('widget settings panel');
await page.fill('textarea[id^="wc-org-"]', 'http://localhost:4010');
{ const v = await page.inputValue('textarea[id^="wc-org-"]'); const n = await page.locator('textarea[id^="wc-org-"]').count(); check('widget: allowed site is still in the field before saving', v === 'http://localhost:4010', JSON.stringify({ v, n, panels: await page.locator('textarea[id^="wc-code-"]').count() })); }
await page.click('button:has-text("שמירה והפעלה")');
await page.waitForSelector('text=נשמר, והערוץ פעיל.');
check('widget: settings saved and channel started', true);
await page.waitForSelector('a:has-text("הורדת תוסף וורדפרס")');
const zipRes = await page.evaluate(async () => { const r = await fetch(document.querySelector('a[href$="wordpress-plugin.zip"]').getAttribute('href'), { credentials: 'same-origin' }); return { status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength }; });
check('widget: WordPress plugin package downloads from the panel', zipRes.status === 200 && zipRes.type === 'application/zip' && zipRes.size > 5000, JSON.stringify(zipRes));
await page.waitForSelector('iframe[title^="תצוגה מקדימה"]');
const frameBox = await (await page.$('iframe[title^="תצוגה מקדימה"]')).contentFrame();
await frameBox.waitForSelector('form.pre');
check('widget: admin preview renders inside the panel', true);

const visitorCtx = await browser.newContext({ locale: 'he-IL' });
const wcKey = /data-key="(wc_[\w-]+)"/.exec(embed)[1];
const hostPage = (title, extra = '') => `<!doctype html><html lang="he"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1></main>${embed}${extra}</body></html>`;
const hosts = await Promise.all([[4010, 'האתר של הלקוח'], [4011, 'אתר אחר']].map(([port, title]) => new Promise((resolve) => { const srv = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(hostPage(title, port === 4011 ? `<iframe id="direct" title="direct" src="http://localhost:3077/w/${wcKey}"></iframe>` : '')); }); srv.listen(port, '127.0.0.1', () => resolve(srv)); })));
const vp = await visitorCtx.newPage();
vp.on('pageerror', (e) => { console.log('VISITOR PAGEERROR', e.message); failures++; });
await vp.goto('http://localhost:4010/');
await vp.waitForSelector('[data-botwa-widget] button[aria-label]');
check('widget: launcher appears on the allowed site', true);
await vp.click('[data-botwa-widget] button[aria-label]');
await page.evaluate(() => fetch('/kb/sources/faq', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'כמה זמן לוקח משלוח', body: 'משלוח עד 3 ימי עסקים.', variants: [], audience: 'both' }) }));
const chat = vp.frameLocator('iframe[title="צ׳אט עם הצוות"]');
check('widget: "continue on" links to WhatsApp and Messenger', (await chat.locator('.social a.net-whatsapp').getAttribute('href')) === 'https://wa.me/972501234567' && (await chat.locator('.social a.net-messenger').getAttribute('href')) === 'https://m.me/my.shop');
await chat.locator('input#f-name').fill('דנה מהאתר');
await chat.locator('button.primary').click();
check('widget: consent is required before chatting', (await chat.locator('#consent-e').textContent()).length > 0);
await chat.locator('input#consent').check();
await chat.locator('button.primary').click();
await chat.locator('textarea').fill('שלום, יש לי שאלה על הזמנה');
await chat.locator('button.send').click();
await chat.locator('.msg.me:has-text("יש לי שאלה על הזמנה")').waitFor();
check('widget: visitor message shown', true);
await chat.locator('textarea').pressSequentially('משלוח', { delay: 30 });
await chat.locator('#sug li[role=option]').first().waitFor({ timeout: 10000 });
check('widget: matching common questions are offered while typing', (await chat.locator('#sug li').first().textContent()).includes('כמה זמן לוקח משלוח'));
await chat.locator('textarea').press('ArrowDown');
check('widget: arrow keys move through the suggestions', (await chat.locator('#sug li[aria-selected=true]').count()) === 1);
await chat.locator('textarea').press('Enter');
await chat.locator('.msg.them:has-text("3 ימי עסקים")').waitFor({ timeout: 10000 });
check('widget: choosing a suggestion shows its answer at once (and sends nothing)', (await chat.locator('textarea').inputValue()) === '');
const vframe = vp.frames().find((f) => f.url().includes('/w/wc_'));
await vframe.evaluate(axeSrc);
const vax = await vframe.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }));
check('axe: widget chat window', vax.violations.length === 0, vax.violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 80)}`).join(' | '));

// the conversation arrives in the inbox; a staff reply reaches the visitor
await page.click('aside.sidebar nav >> text=שיחות');
await page.click('.conv-list button:has-text("דנה מהאתר")');
await page.fill('#reply', 'שלום דנה, אנחנו בודקים');
await page.click('button:has-text("שליחה")');
await chat.locator('.msg.them:has-text("אנחנו בודקים")').waitFor({ timeout: 15000 });
check('widget: staff reply reaches the visitor', true);
// the agent puts an emoji on the visitor's message: chosen from a short list in the inbox, shown on the visitor's bubble in the widget
await page.click('.msg.in:has-text("יש לי שאלה על הזמנה") button.rx-add');
await page.waitForSelector('.rx-quick button[aria-label="🙏"]');
await axe('reaction picker');
await page.click('.rx-quick button[aria-label="🙏"]');
await page.waitForSelector('.msg.in:has-text("יש לי שאלה על הזמנה") button.rx-badge:has-text("🙏")');
await chat.locator('.msg.me:has-text("יש לי שאלה על הזמנה") .rx:has-text("🙏")').waitFor({ timeout: 15000 });
check('reactions: an agent picks an emoji on the customer message and the visitor sees it', true);
// a thank-you from the visitor gets the heart automatically
await chat.locator('textarea').fill('תודה רבה, אתם אחלה');
await chat.locator('button.send').click();
await chat.locator('.msg.me:has-text("אתם אחלה") .rx:has-text("❤️")').waitFor({ timeout: 15000 });
await page.waitForSelector('.msg.in:has-text("אתם אחלה") button.rx-badge:has-text("❤️")', { timeout: 15000 });
check('reactions: a thank-you gets a heart automatically, in the widget and in the inbox', true);

// digital forms, end to end through the website chat: a template from a PDF, sent from the conversation, the code arrives in the chat,
// the visitor fills and signs on their own device, a signed copy comes back and the inbox shows it as signed
{ const { PDFDocument, StandardFonts } = createRequire(import.meta.url)('pdf-lib');
  const d = await PDFDocument.create(); const pg = d.addPage([595, 842]); const font = await d.embedFont(StandardFonts.Helvetica);
  pg.drawText('Visitor safety declaration', { x: 170, y: 780, size: 16, font }); pg.drawText('Name:', { x: 480, y: 700, size: 11, font }); pg.drawText('Date:', { x: 480, y: 670, size: 11, font }); pg.drawText('Signature:', { x: 470, y: 600, size: 11, font });
  const pdf = Buffer.from(await d.save());
  await page.click('aside.sidebar nav >> text=טפסים');
  await page.waitForSelector('text=טפסים שנשלחו');
  await axe('forms: sent');
  await page.click('.chips button:has-text("תבניות")');
  await page.setInputFiles('#fu-file', { name: 'declaration.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.fill('#fu-title', 'הצהרת בטיחות למבקר');
  await page.click('button:has-text("יצירת תבנית")');
  await page.waitForSelector('.fe-page canvas', { timeout: 30000 });
  await page.waitForSelector('.fe-field');
  check('forms: a PDF becomes a template with suggested fields (name, date, signature) on its rendered page', (await page.locator('.fe-field').count()) === 3, String(await page.locator('.fe-field').count()));
  await axe('forms: editor');
  await page.locator('.fe-field.t-text').focus();
  await page.keyboard.press('ArrowLeft');
  await page.fill('#fe-l', 'שם מלא');
  await page.click('.form-editor button:has-text("שמירה")');
  await page.waitForSelector('.form-editor [role=status].ok');
  check('forms: the editor moves a field with the keyboard and saves', true);
  await page.click('.form-editor button:has-text("סגירה")');
  await axe('forms: templates');
  // one form to a group: the people pasted from a spreadsheet; whoever never wrote gets a link to pass on, not an unsolicited message
  await page.click('.form-tpls li:has-text("הצהרת בטיחות למבקר") button:has-text("שליחה לקבוצה")');
  await page.waitForSelector('#fb-p');
  await page.fill('#fb-p', 'רון קבלן\t053-9990001\nמיכל עובדת\t053-9990002');
  await axe('forms: send to a group');
  await page.click('section[aria-labelledby="fb-h"] button:has-text("שליחה ל-2 אנשים")');
  await page.waitForSelector('section[aria-labelledby="fbl-h"] li:has-text("הצהרת בטיחות למבקר")', { timeout: 20000 });
  await page.waitForSelector('section[aria-labelledby="fbl-h"] table tbody tr', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('section[aria-labelledby="fbl-h"] tbody')?.textContent?.includes('בתור'), null, { timeout: 30000 }).catch(() => undefined);
  { const d = await page.$$eval('section[aria-labelledby="fbl-h"] tbody td:nth-child(3)', (tds) => tds.map((x) => x.textContent ?? ''));
    check('forms: a group gets personal links; nobody who never wrote is messaged out of the blue', d.length === 2 && d.every((x) => x.startsWith('קישור להעברה')), JSON.stringify(d)); }
  await axe('forms: group report');
  // send it from the website-chat conversation
  await page.click('aside.sidebar nav >> text=שיחות');
  await page.click('.conv-list button:has-text("דנה מהאתר")');
  await page.click('button:has-text("שליחת טופס לחתימה")');
  await page.waitForSelector('#sf-t');
  await axe('inbox: send a form');
  await page.click('#send-form button[type=submit]');
  await page.waitForSelector('#send-form [role=status].ok');
  const link = await chat.locator('.msg.them:has-text("הצהרת בטיחות למבקר") a').getAttribute('href', { timeout: 15000 });
  check('forms: the personal link reaches the visitor in the chat', /\/f\/f_[\w-]+$/.test(link ?? ''), link ?? '');
  const fp = await visitorCtx.newPage();
  await fp.setViewportSize({ width: 390, height: 844 });
  await fp.goto(link);
  await fp.click('button:has-text("שליחת קוד אימות לצ׳אט")');
  await chat.locator('.msg.them:has-text("קוד האימות")').waitFor({ timeout: 15000 });
  const code = (await chat.locator('.msg.them:has-text("קוד האימות")').last().textContent()).match(/(\d{6})/)[1];
  check('forms: the inbox never shows the code itself', !(await page.textContent('.messages')).includes(code));
  await fp.fill('#code', code);
  await fp.click('form button.primary');
  await fp.waitForSelector('canvas.pad');
  { await fp.evaluate(axeSrc); const r = await fp.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }));
    check('axe: form fill page (phone)', r.violations.length === 0, r.violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 80)}`).join(' | ')); }
  for (const el of await fp.locator('form input[type=text]:visible').all()) await el.fill('דנה כהן');
  await fp.fill('form input[type=date]', '2026-11-20');
  await fp.click('button:has-text("הקלדת שם במקום ציור")');
  await fp.fill('.field input[autocomplete=name]:visible >> nth=-1', 'דנה כהן');
  await fp.check('#consent');
  await fp.click('form button.primary');
  await fp.waitForSelector('.done', { timeout: 30000 });
  check('forms: the visitor signs on the phone and gets the confirmation', true);
  await page.waitForSelector('.conv-forms .fs-signed', { state: 'attached', timeout: 20000 }).catch(() => undefined);
  if (!(await page.locator('.conv-forms .fs-signed').count())) { await page.click('.conv-list button:has-text("דנה מהאתר")'); await page.waitForSelector('.conv-forms .fs-signed', { state: 'attached', timeout: 15000 }); }
  check('forms: the inbox shows the form as signed, with the signed PDF to download', (await page.locator('.conv-forms a:has-text("הורדת הטופס החתום")').count()) === 1);
  await fp.close(); }

// a site that is not on the list gets no launcher (the config call is refused cross-origin) and cannot frame the chat page either
const bp = await visitorCtx.newPage();
await bp.goto('http://localhost:4011/');
await bp.waitForTimeout(2500);
check('widget: no launcher on an unlisted site', (await bp.locator('[data-botwa-widget]').count()) === 0);
const direct = bp.frames().find((f) => f !== bp.mainFrame() && (f.url().includes('/w/wc_') || f.url().startsWith('chrome-error')));
check('widget: an unlisted site cannot frame the chat page directly', !!direct && direct.url().startsWith('chrome-error'), direct?.url() ?? 'no frame');
await visitorCtx.close();
hosts.forEach((h) => h.close());

// clean up so later steps are unaffected
await page.click('aside.sidebar nav >> text=ערוצים');
await page.click('li.card:has-text("האתר שלנו") >> button:has-text("מחיקת ערוץ")');
await page.click('dialog[open] button:has-text("אישור")');
await page.waitForFunction(() => !document.body.textContent?.includes('האתר שלנו'));

// integrations: API key (shown once), webhook (secret shown once), documentation
await page.click('aside.sidebar nav >> text=אינטגרציות');
await page.waitForSelector('h1:has-text("אינטגרציות")');
await page.fill('#k-name', 'מערכת CRM');
await page.click('button:has-text("יצירת מפתח")');
await page.waitForSelector('[role=status] code');
const apiKey = await page.textContent('[role=status] code');
check('integrations: API key created and shown once', /^bk_[\w-]{8}_[\w-]{30,}$/.test(apiKey ?? ''), apiKey ?? '');
const me = await fetch('http://localhost:3077/api/v1/me', { headers: { authorization: `Bearer ${apiKey}` } });
check('integrations: the key works against the public API', me.status === 200 && (await me.json()).name === 'מערכת CRM');
await axe('integrations: API keys');
await page.click('.chips >> text=Webhooks');
await page.fill('#h-name', 'CRM'); await page.fill('#h-url', 'https://example.org/botwa-hook');
await page.click('button:has-text("יצירה")');
await page.waitForSelector('[role=status] code:has-text("whsec_")');
check('integrations: webhook created, secret shown once', true);
await page.fill('#h-url', 'http://example.org/x'); await page.fill('#h-name', 'x');
await page.click('button:has-text("יצירה")');
await page.waitForSelector('text=נדרשת כתובת https.');
await axe('integrations: webhooks');
await page.click('.chips >> text=תיעוד');
await page.waitForTimeout(500); // colour transition
await axe('integrations: docs');
await page.click('.chips >> text=מפתחות API');
await page.click('table button.danger:has-text("ביטול")');
await page.click('dialog[open] button:has-text("אישור")');
await page.waitForSelector('text=בוטל');
const revoked = await fetch('http://localhost:3077/api/v1/me', { headers: { authorization: `Bearer ${apiKey}` } });
check('integrations: a revoked key stops working at once', revoked.status === 401);

// canned replies page
await page.click('aside.sidebar nav >> text=תשובות ותגיות');
await page.fill('#c-title', 'ברכה'); await page.fill('#c-body', 'שלום, איך אפשר לעזור?');
await page.click('button:has-text("הוספה")');
await page.waitForSelector('li.card:has-text("ברכה")');
await page.click('li.card:has-text("ברכה") >> button:has-text("עריכה")');
await page.fill('#c-folder', 'פתיחה'); await page.click('button:has-text("שמירה")');
await page.waitForSelector('li.card:has-text("ברכה") .badge:has-text("פתיחה")');
check('canned reply edited into a folder', true);
await page.fill('#c-search', 'zzz-none'); check('canned search finds nothing', await page.locator('li.card:has-text("ברכה")').count() === 0); await page.fill('#c-search', '');
await page.fill('#tag-name', 'VIP'); await page.click('button:has-text("הוספת תגית")');
await page.waitForSelector('li.badge:has-text("VIP")');
await axe('canned replies + tags');

// GIF library: a manager adds a GIF (checked by content, scanned by clamd), then edits its title
const GIF = Buffer.from('R0lGODlhEAAQAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEFAAfACwAAAAAEAAQAAAIHQAPCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBACH5BAUUAAAALA8ADwABAAEAAAgEAAEEBAAh+QQFFAAAACwPAA8AAQABAAAIBAABBAQAIfkEBRQAAAAsDwAPAAEAAQAACAQAAQQEADs=', 'base64');
await page.fill('#gif-title', 'אגודל מהצוות'); await page.fill('#gif-kw', 'אגודל, שמחה');
await page.setInputFiles('#gif-file', { name: 'thanks.gif', mimeType: 'image/gif', buffer: GIF });
await page.click('button:has-text("הוספה לספרייה")');
await page.waitForSelector('.gif-admin li:has-text("אגודל מהצוות")', { timeout: 20000 }).catch(() => undefined);
check('GIF added to the library', await page.locator('.gif-admin li:has-text("אגודל מהצוות")').count() === 1, await page.textContent('#gifs-h ~ p[role=status]').catch(() => ''));
await page.setInputFiles('#gif-file', { name: 'fake.gif', mimeType: 'image/gif', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
await page.fill('#gif-title', 'מזויף'); await page.click('button:has-text("הוספה לספרייה")');
await page.waitForSelector('[role=status].error:has-text("רק קובצי GIF")', { timeout: 8000 }).catch(() => undefined);
check('a PNG renamed .gif is refused', await page.isVisible('[role=status].error:has-text("רק קובצי GIF")'));
await axe('canned replies: GIF library');
check('GIF library: the 12 built-in GIFs are there (e.g. "בטיחות קודם!")', await page.locator('.gif-admin li:has-text("בטיחות קודם!")').count() === 1 && await page.locator('.gif-admin li').count() === 13, String(await page.locator('.gif-admin li').count()));

// seed an inbound conversation directly (adapter can't reach WhatsApp here)
const ch = psql("SELECT id FROM channels LIMIT 1");
psql(`INSERT INTO contacts (channel_id, external_id, display_name) VALUES ('${ch}','972501234567@s.whatsapp.net','יוסי לקוח')`);
psql(`INSERT INTO conversations (channel_id, contact_id, unread_count) SELECT '${ch}', id, 2 FROM contacts WHERE external_id = '972501234567@s.whatsapp.net'`);
psql(`INSERT INTO messages (conversation_id, direction, body, external_id) SELECT id, 'in', 'היי, צריך עזרה בהזמנה', 'x1' FROM conversations`);

// same customer (same phone) also writing on a second WhatsApp channel
psql(`INSERT INTO channels (type, label) VALUES ('whatsapp', 'ערוץ שני')`);
psql(`INSERT INTO contacts (channel_id, external_id, display_name) SELECT id, '972501234567@s.whatsapp.net', 'לקוח משני' FROM channels WHERE label='ערוץ שני'`);
psql(`INSERT INTO conversations (channel_id, contact_id) SELECT channel_id, id FROM contacts WHERE display_name='לקוח משני'`);
psql(`INSERT INTO messages (conversation_id, direction, body, external_id) SELECT id, 'in', 'הודעה בערוץ שני', 'sec1' FROM conversations WHERE contact_id=(SELECT id FROM contacts WHERE display_name='לקוח משני')`);

await page.click('aside.sidebar nav >> text=שיחות');
await page.waitForSelector('.conv-list button');
check('conversation listed with unread', (await page.textContent('.conv-list button:has-text("יוסי לקוח") .unread')).includes('2'));
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.waitForSelector('.msg.in');
await axe('inbox open conversation');
await openMore();
await page.fill('#msgq', 'zzzz-none');
await page.waitForFunction(() => document.querySelectorAll('.msg').length === 0, null, { timeout: 15000 });
await page.fill('#msgq', 'עזרה');
await page.waitForSelector('.msg:has-text("צריך עזרה")');
check('in-conversation search narrows messages', true);
await page.fill('#msgq', '');
await page.waitForSelector('.msg:has-text("היי, צריך עזרה")');
await page.waitForSelector('.person-list .mchip:has-text("אותו מספר ווצאפ")');
check('related conversation (same phone, other channel) listed', await page.isVisible('.person-list >> text=ערוץ שני'));
await page.click('.person-list button.linkish');
await page.waitForSelector('.chat-pane h2:has-text("לקוח משני")');
check('opening related conversation works', true);
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.waitForSelector('.chat-pane h2:has-text("יוסי לקוח")');
// who handles the inquiry: one labelled state in the header and on the list row (here nobody yet)
{ const head = await page.textContent('.chat-head .mchip.handler'); const row = await page.textContent('.conv-list button:has-text("יוסי לקוח") .mchip.handler');
  check('who handles it: a clear state in the header and in the list', /מי מטפל בפנייה/.test(head) && /(ממתינה לנציג\/ה|בטיפולך|מטפל\/ת)/.test(head) && head.replace(/ · .*/, '') === row, JSON.stringify({ head, row })); }
await page.click('.inbox-adv summary');
await page.selectOption('#lp-h', 'waiting');
await page.waitForTimeout(200);
{ const rows = await page.locator('.conv-list li').count(); const waiting = await page.locator('.conv-list .mchip.h-waiting').count();
  check('filter by handler: only inquiries waiting for a person', rows > 0 && rows === waiting, JSON.stringify({ rows, waiting })); }
await axe('inbox: filter by handler');
await page.selectOption('#lp-h', '');
await page.click('.inbox-adv summary');
await page.selectOption('#canned', { label: 'ברכה' });
await page.waitForFunction(() => document.querySelector('#reply')?.value.includes('איך אפשר לעזור'), null, { timeout: 5000 }).catch(() => {});
check('canned reply inserted', (await page.inputValue('#reply')).includes('איך אפשר לעזור'));
await page.click('.conv-list button:has-text("לקוח משני")');
await page.waitForSelector('.chat-pane h2:has-text("לקוח משני")');
await page.waitForFunction(() => document.querySelector('#reply').value === '', null, { timeout: 4000 }).catch(() => undefined);
check('draft does not leak into another conversation', (await page.inputValue('#reply')) === '');
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.waitForSelector('.chat-pane h2:has-text("יוסי לקוח")');
await page.waitForFunction(() => document.querySelector('#reply').value.includes('איך אפשר לעזור'), null, { timeout: 4000 }).catch(() => undefined);
check('draft is restored when returning to the conversation', (await page.inputValue('#reply')).includes('איך אפשר לעזור'));
await page.fill('#reply', '/ברכ');
await page.waitForSelector('.slash button:has-text("ברכה")');
await page.click('.slash button:has-text("ברכה")');
await page.waitForFunction(() => { const v = document.querySelector('#reply')?.value ?? ''; return v.includes('איך אפשר לעזור') && !v.startsWith('/'); }, null, { timeout: 5000 }).catch(() => {});
check('slash menu inserts the canned reply', (await page.inputValue('#reply')).includes('איך אפשר לעזור') && !(await page.inputValue('#reply')).startsWith('/'));
await page.click('button:has-text("☆ סימון")');
await page.click('.chips >> text=מסומנות');
await page.waitForSelector('.conv-list button:has-text("יוסי לקוח")');
check('starred chat shows under the starred filter', true);
await page.click('.chips >> text=פתוחות');
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.click('button:has-text("★ הסרת סימון")');
await page.selectOption('#snz', { label: 'שעה' });
await page.waitForFunction(() => !document.querySelector('.conv-list')?.textContent?.includes('יוסי לקוח'));
check('snoozed chat leaves the open list', true);
await page.click('.chips >> text=נדחו');
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.selectOption('#snz', { label: 'ביטול דחייה' });
await page.click('.chips >> text=פתוחות');
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.waitForSelector('.chat-pane h2:has-text("יוסי לקוח")');
check('un-snoozed chat is back in the open list', true);
await openMore();
await page.fill('#note', 'לקוח חשוב'); await page.click('button:has-text("הוספת הערה")');
await page.waitForSelector('#notes-h ~ ul li:has-text("לקוח חשוב")');
check('internal note added', true);
await axe('inbox with notes + canned');
// one person across channels: link this WhatsApp customer with the website visitor by hand, see it, undo it
{
  const chId = psql("SELECT channel_id FROM contacts WHERE display_name='יוסי לקוח'");
  psql(`WITH c AS (INSERT INTO contacts (channel_id, external_id, display_name) VALUES ('${chId}', '972500000999@s.whatsapp.net', 'רונית לבדיקה') RETURNING id) INSERT INTO conversations (channel_id, contact_id) SELECT '${chId}', id FROM c`);
}
await page.click('summary:has-text("קישור ידני לאיש קשר אחר")');
await page.fill('input[id^="ps-"]', 'רונית');
await page.waitForSelector('ul[aria-label="תוצאות חיפוש"] li', { timeout: 8000 }).catch(() => undefined);
await page.click('ul[aria-label="תוצאות חיפוש"] li >> button:has-text("קישור")');
await page.click('dialog[open] button:has-text("קישור")');
await page.waitForSelector('.person-list .mchip:has-text("קושר בידי הצוות")', { timeout: 8000 }).catch(() => undefined);
check('contacts linked by hand appear as the same person', await page.isVisible('.person-list .mchip:has-text("קושר בידי הצוות")') && await page.isVisible('.head-meta .mchip.person'));
await axe('inbox: same person on other channels');
check('inquiry history is shown with its inquiries', await page.isVisible('#cases-h') && (await page.locator('.case-list li').count()) >= 1);
await page.click('.case-list li >> nth=0 >> button.case-row');
await page.waitForSelector('.case-msgs', { timeout: 8000 }).catch(() => undefined);
check('an inquiry opens to show its messages', await page.isVisible('.case-msgs'));
await axe('inbox: inquiry history');
await page.click('.case-list li >> nth=0 >> button.case-row');
await page.click('.person-list button:has-text("ביטול קישור")');
await page.click('dialog[open] button:has-text("ביטול הקישור")');
await page.waitForSelector('text=הקישור בוטל', { timeout: 8000 }).catch(() => undefined);
check('a link can be undone', await page.isVisible('text=הקישור בוטל') && !(await page.isVisible('.person-list .mchip:has-text("קושר בידי הצוות")')));
// a public comment thread: the reply needs an explicit choice; a public answer shows a warning
{
  const chId = psql("SELECT channel_id FROM contacts WHERE display_name='יוסי לקוח'");
  psql(`WITH c AS (INSERT INTO contacts (channel_id, external_id, display_name) VALUES ('${chId}', '8880001@fbcomment', 'מגיב בפוסט') RETURNING id),
        v AS (INSERT INTO conversations (channel_id, contact_id) SELECT '${chId}', id FROM c RETURNING id)
        INSERT INTO messages (conversation_id, direction, body, external_id) SELECT id, 'in', 'כמה זה עולה?', '111_2' FROM v`);
}
await page.click('.conv-list button:has-text("מגיב בפוסט")');
await page.waitForSelector('.reply-mode');
await page.fill('#reply', 'שלחנו לך הודעה פרטית');
check('comment reply: sending waits for a public/private choice', await page.isDisabled('button.send'));
await page.check('input[name="comment-reply"] >> nth=1');
check('comment reply: a public answer shows a warning', await page.isVisible('.reply-warn') && !(await page.isDisabled('button.send')));
await axe('inbox: replying to a public comment');
await page.fill('#reply', '');
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.waitForSelector('.chat-pane h2:has-text("יוסי לקוח")');
// closing a conversation offers the closing message (with a preview) and lets the agent skip it
await openMore();
await page.click('.chat-actions button:has-text("סגירת שיחה"), button:has-text("סגירת שיחה") >> nth=0');
await page.waitForSelector('form.close-ask', { timeout: 8000 }).catch(() => undefined);
check('closing a conversation offers the closing message with a preview', await page.isVisible('form.close-ask') && (await page.textContent('form.close-ask')).includes('לשלוח ללקוח הודעת סיום'));
await page.check('form.close-ask input[type=checkbox]');
check('closing message preview shows the text', await page.isVisible('.close-preview'));
await axe('inbox: close with closing message');
await page.click('form.close-ask button:has-text("ביטול")');
check('waiting time shown in list', await page.isVisible('.conv-list >> text=ממתין'));
await openMore();
await page.selectOption('#addtag', { label: 'VIP' });
await page.waitForSelector('.chat-pane .badge:has-text("VIP")');
await page.selectOption('#tgf', { label: 'VIP' });
await page.waitForSelector('.conv-list button');
check('tag filter keeps the tagged conversation', true);
await page.selectOption('#tgf', { value: '' });
await page.fill('#srch', 'הזמנה');
await page.waitForSelector('.conv-list button');
await page.fill('#srch', 'zzzz-none');
await page.waitForSelector('text=אין שיחות להצגה');
check('search filters list', true);
await page.fill('#srch', '');
await page.waitForSelector('.conv-list button');
// block a customer, review in the "blocked" filter, unblock and reopen
await openMore();
await page.click('button:has-text("חסימת לקוח")');
await page.fill('#blk-r', 'בדיקת מערכת');
await axe('block panel');
await page.click('button:has-text("אישור חסימה")');
await page.click('button.chip:has-text("חסומים")');
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.waitForSelector('text=הלקוח חסום (בדיקת מערכת)');
check('blocked customer shown with reason in the blocked filter', true);
check('reply disabled while blocked', await page.isDisabled('button:has-text("שליחה")'));
await page.click('button:has-text("ביטול חסימה")');
await page.waitForSelector('text=אין שיחות להצגה');
await page.click('button.chip:has-text("סגורות")');
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.click('button:has-text("פתיחה מחדש")');
await page.click('button.chip:has-text("פתוחות")');
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.waitForSelector('.msg.in');

await openMore();
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("ייצוא נתוני איש הקשר")')]);
check('admin can export contact data', dl.suggestedFilename().startsWith('contact-'));
await page.fill('#reply', 'שלום, אני בודק');
await page.click('button:has-text("שליחה")');
await page.waitForSelector('text=הערוץ אינו מחובר');
check('send while disconnected shows friendly error', true);

// attachments: seeded rows in each state + real upload path (multipart + validation + clamd, stops at "channel not connected")
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const store = randomUUID();
mkdirSync('/tmp/e2e-media/clean', { recursive: true });
writeFileSync(`/tmp/e2e-media/clean/${store}`, PNG);
const conv = psql("SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.display_name='יוסי לקוח'");
const seed = (ext, body, kind, mime, status, detail, st) => {
  psql(`INSERT INTO messages (conversation_id, direction, body, external_id) VALUES ('${conv}','in','${body}','${ext}')`);
  psql(`INSERT INTO attachments (message_id, kind, mime, size, file_name, storage_name, status, detail) SELECT id,'${kind}',${mime},${PNG.length},'${ext}.png',${st},'${status}',${detail} FROM messages WHERE external_id='${ext}'`);
};
seed('ma', 'תמונה נקייה', 'image', "'image/png'", 'clean', 'NULL', `'${store}'`);
seed('mb', 'ממתין', 'image', "'image/png'", 'pending', 'NULL', 'NULL');
seed('mc', 'וירוס', 'image', 'NULL', 'infected', "'Eicar'", 'NULL');
seed('md', 'חסום', 'document', 'NULL', 'blocked', "'type_not_allowed'", 'NULL');
await page.waitForSelector('img[alt^="תמונה מצורפת"]', { timeout: 15000 });
const loaded = await page.$eval('img[alt^="תמונה מצורפת"]', (i) => i.complete && i.naturalWidth > 0);
check('authenticated image attachment renders', loaded);
check('pending/infected/blocked states shown',
  (await page.isVisible('text=בסריקת אבטחה')) && (await page.isVisible('text=זוהתה בו תוכנה זדונית')) && (await page.isVisible('text=סוג הקובץ אינו נתמך')));
await axe('inbox with attachments');
// emoji picker: search in Hebrew, insert at the cursor, Escape gives focus back to its button
await page.fill('#reply', 'מעולה ');
await page.click('button[aria-label="אימוג׳י"]');
await page.waitForSelector('#emoji-picker');
check('emoji picker opens with focus in its search box', await page.evaluate(() => document.activeElement?.id === 'emoji-q'));
await axe('inbox: emoji picker');
await page.fill('#emoji-q', 'אגודל');
await page.click('#emoji-picker button[aria-label="אגודל למעלה"]');
check('emoji is inserted into the reply', (await page.inputValue('#reply')) === 'מעולה 👍');
await page.click('#emoji-q');
await page.fill('#emoji-q', '');
await page.click('#emoji-picker .picker-tabs button[title="בטיחות"]');
await page.focus('#emoji-picker .emoji-grid button[tabindex="0"]');
await page.keyboard.press('ArrowLeft');
const moved = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
check('arrow keys move inside the emoji grid (RTL: left = next)', moved === 'קסדת חילוץ', moved ?? '');
await page.keyboard.press('Escape');
check('Escape closes the emoji picker and returns focus', !(await page.isVisible('#emoji-picker')) && await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'אימוג׳י'));
// GIF picker: the library item is there; sending reaches the server (stops at "channel not connected" here)
await page.click('button[aria-label="שליחת GIF"]');
await page.waitForSelector('#gif-picker .gif-tile', { timeout: 8000 }).catch(() => undefined);
check('GIF picker lists the library, with the built-in GIFs drawn for the system', await page.locator('#gif-picker .gif-tile').count() === 13, String(await page.locator('#gif-picker .gif-tile').count()));
await axe('inbox: GIF picker');
await page.click('#gif-picker .gif-tile');
await page.waitForSelector('[role=alert]:has-text("הערוץ אינו מחובר")', { timeout: 8000 }).catch(() => undefined);
check('sending a GIF goes through the server checks', await page.isVisible('[role=alert]:has-text("הערוץ אינו מחובר")'));
check('the typed text stays in the box after a GIF', (await page.inputValue('#reply')) === 'מעולה 👍');
await page.keyboard.press('Escape');
await page.fill('#reply', '');
await page.setInputFiles('#attach', { name: 'pic.png', mimeType: 'image/png', buffer: PNG });
await page.click('button:has-text("שליחה")');
await page.waitForSelector('[role=alert]:has-text("הערוץ אינו מחובר")');
check('upload passes validation+antivirus, stops at disconnected channel', true);
await page.setInputFiles('#attach', { name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*') });
await page.click('button:has-text("שליחה")');
await page.waitForSelector('[role=alert]:has-text("סוג הקובץ אינו נתמך")');
check('non-image content disguised as png is rejected', true);
await page.setInputFiles('#attach', []);

// logout, then agent login & authz
await page.click('aside.sidebar >> button:has-text("התנתקות")');
await page.waitForSelector('#email');
await page.fill('#email', 'dana@e2e.io'); await page.fill('#pw', 'agent-password-123'); await page.click('button[type=submit]');
await page.waitForSelector('aside.sidebar nav >> text=שיחות');
check('agent sees availability toggle', await page.isVisible('aside.sidebar label:has-text("זמין לפניות חדשות")'));
check('agent has no Channels/Team nav', (await page.locator('aside.sidebar nav >> text=ערוצים').count()) === 0 && (await page.locator('aside.sidebar nav >> text=צוות').count()) === 0);
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.click('text=קח שיחה'); await page.waitForSelector('text=שחרור שיחה');
check('agent claimed conversation', true);
await page.click('button:has-text("העברה לנציג")');
await page.waitForSelector('#handover');
check('handover form needs a note and a target', await page.isDisabled('#handover button[type=submit]'));
await axe('handover form');
await page.click('#handover button:has-text("ביטול")');
await page.click('details.sched summary');
check('schedule button needs text and time', await page.isDisabled('details.sched button:has-text("תזמון ההודעה")'));
await axe('inbox with scheduling panel');
await page.click('details.sched summary');
check('handover form closes', (await page.locator('#handover').count()) === 0);

// keyboard & widget & mobile
await page.click('.a11y-widget button.primary'); await page.click('button:has-text("ניגודיות גבוהה")');
check('high contrast toggles', (await page.getAttribute('html', 'data-contrast')) === 'high');
await page.waitForTimeout(500); // let colour transitions finish before measuring contrast
await axe('high contrast + inbox');
await page.setViewportSize({ width: 375, height: 700 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
check('no horizontal scroll at 375px', !overflow);
check('phone: the bottom bar is out of the way while a conversation fills the screen', !(await page.isVisible('nav.bottomnav')));
await page.click('button[aria-label="חזרה לרשימה"]');
await page.click('nav.bottomnav button:has-text("עוד")');
check('phone: "more" sheet holds sign-out', await page.isVisible('dialog[open] button:has-text("התנתקות")'));
await page.click('dialog[open] button:has-text("סגירה")');
await page.goto(BASE + '/#/accessibility'); await axe('a11y statement');
await page.goto(BASE + '/#/privacy'); await axe('privacy page');
for (const [p, name] of [['/legal/privacy', 'public privacy policy'], ['/legal/terms', 'public terms'], ['/legal/data-deletion', 'public data deletion']]) {
  await page.goto(BASE + p);
  check(`${name}: renders without scripts`, (await page.locator('h1').count()) === 1 && (await page.locator('script').count()) === 0);
  await axe(name);
}
await page.screenshot({ path: '/tmp/botwa-e2e-shot.png', fullPage: true });

// data erasure by admin (privacy request)
await page.setViewportSize({ width: 1200, height: 800 });
await page.goto(BASE + '/#/inbox');
await page.click('aside.sidebar >> button:has-text("התנתקות")');
await page.waitForSelector('#email');
await page.fill('#email', 'admin@e2e.io'); await page.fill('#pw', 'e2e-password-123'); await page.click('button[type=submit]');
await page.waitForSelector('#totp');
await page.fill('#totp', authenticator.generate(secret)); await page.click('button[type=submit]');
await page.waitForSelector('.conv-list button');
await page.click('.conv-list button:has-text("יוסי לקוח")');
await openMore();
await page.click('button:has-text("מחיקת איש הקשר וכל הנתונים")');
await axe('erase confirm dialog');
await page.click('dialog[open] button:has-text("מחיקה לצמיתות")');
await page.waitForFunction(() => !document.body.innerText.includes('יוסי לקוח'), null, { timeout: 15000 });
check('contact erased: its conversation and files gone, other customers untouched', psql("SELECT count(*) FROM contacts WHERE display_name = 'יוסי לקוח'") === '0' && psql("SELECT count(*) FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.display_name IN ('לקוח משני', 'רונית לבדיקה')") === '2' && psql('SELECT count(*) FROM attachments') === '0');


// ============ passkeys (virtual authenticator = a real WebAuthn ceremony in Chromium) ============
await page.setViewportSize({ width: 1200, height: 800 });
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await page.click('aside.sidebar nav >> text=החשבון שלי');
await page.fill('#pk-name', 'מכשיר וירטואלי');
await page.click('button:has-text("הוספת Passkey")');
await page.waitForSelector('text=ה-Passkey נוסף.');
await page.waitForSelector('li:has-text("מכשיר וירטואלי")');
await page.setInputFiles(`#av-${(await page.evaluate(() => fetch('/auth/me', { credentials: 'same-origin' }).then((r) => r.json()))).id}`, { name: 'me.png', mimeType: 'image/png', buffer: png });
await page.waitForSelector('text=התמונה עודכנה.');
await page.waitForSelector('aside.sidebar .me-card img.avatar-img');
check('account: profile picture uploaded and shown in the side menu', true);
await page.click('button:has-text("בחירה מהגלריה")');
await page.waitForSelector('.avatar-gallery button img');
check('account: the avatar gallery offers the built-in pictures', (await page.locator('.avatar-gallery button').count()) >= 24);
await axe('account: avatar gallery open');
await page.click('.avatar-gallery button >> nth=3');
await page.waitForSelector('text=התמונה נבחרה.');
check('account: a gallery picture is chosen', true);
check('account: phone alerts card with what-to-alert choices', (await page.textContent('section[aria-labelledby="ntf-h"]'))?.includes('התראות'));
check('account: "install the app" card with instructions', (await page.textContent('section[aria-labelledby="inst-h"]'))?.includes('אפליקציה'));
const mf = await (await page.request.get(BASE + '/manifest.webmanifest')).json();
check('PWA: manifest has an id and shortcuts to inbox / safety / reports', mf.id === '/' && mf.shortcuts?.length === 3);
await axe('account with passkey');
check('passkey registered through a real WebAuthn ceremony', true);
await page.click('aside.sidebar >> button:has-text("התנתקות")');
await page.waitForSelector('#email');
await axe('login with passkey button');
await page.click('button:has-text("כניסה עם Passkey")');
await page.waitForSelector('aside.sidebar nav');
check('signed in with the passkey (no password, no TOTP)', await page.isVisible('aside.sidebar >> text=Botwa'));
check('audit records passkey login', Number(psql("SELECT count(*) FROM audit_log WHERE action='login.success' AND meta->>'via'='passkey'")) >= 1);

// ============ roles: custom role limits what a user sees ============
await page.click('aside.sidebar nav >> text=תפקידים');
await page.click('button:has-text("תפקיד חדש")');
await page.fill('#r-name', 'אנליסט');
await page.check('label:has-text("לצפות בדוחות") input');
await axe('roles editor');
await page.click('button:has-text("שמירה")');
await page.waitForSelector('th:has-text("אנליסט")');
await page.click('aside.sidebar nav >> text=צוות');
await page.fill('#u-name', 'אנה אנליסטית'); await page.fill('#u-email', 'ana@e2e.io'); await page.fill('#u-pw', 'analyst-password-1');
await page.selectOption('#u-role', { label: 'אנליסט' });
await page.click('button:has-text("יצירת משתמש")');
await page.waitForSelector('td:has-text("ana@e2e.io")');

// reset password and delete a user
await page.waitForFunction(() => document.querySelector('#u-name').value === '', null, { timeout: 5000 });   // the form clears itself after a creation
await page.fill('#u-name', 'זמני'); await page.fill('#u-email', 'tmp@e2e.io'); await page.fill('#u-pw', 'temporary-password-1');
await page.click('button:has-text("יצירת משתמש")');
await page.waitForSelector('td:has-text("tmp@e2e.io")');
await page.click('tr:has(td:has-text("tmp@e2e.io")) button:has-text("איפוס סיסמה")');
await page.waitForSelector('h2:has-text("איפוס סיסמה: זמני")');
await axe('team: reset password panel');
await page.click('section[aria-labelledby="pw-h"] button[type=submit]');
await page.waitForSelector('section[aria-labelledby="pw-h"] code');
const temp = await page.textContent('section[aria-labelledby="pw-h"] code');
check('team: a temporary password is shown once', /^[A-Za-z2-9]{16}$/.test(temp ?? ''), temp ?? '');
await axe('team: temporary password shown');
await page.click('section[aria-labelledby="pw-h"] button:has-text("סגירה")');
check('team: the temporary password is gone after closing', (await page.locator('code:has-text("' + temp + '")').count()) === 0);
await page.click('tr:has(td:has-text("tmp@e2e.io")) button:has-text("מחיקה")');
await page.waitForSelector('h2:has-text("מחיקת משתמש: זמני")');
check('team: delete stays disabled until the e-mail is typed', await page.isDisabled('section[aria-labelledby="del-h"] button[type=submit]'));
await axe('team: delete panel');
await page.fill('#del-em', 'tmp@e2e.io');
await page.click('section[aria-labelledby="del-h"] button[type=submit]');
await page.waitForFunction(() => !document.body.innerText.includes('tmp@e2e.io'), null, { timeout: 8000 }).catch(() => undefined);
check('team: the user is deleted', (await page.locator('td:has-text("tmp@e2e.io")').count()) === 0);
await page.click('aside.sidebar >> button:has-text("התנתקות")');
await page.waitForSelector('#email');
await page.fill('#email', 'ana@e2e.io'); await page.fill('#pw', 'analyst-password-1'); await page.click('button[type=submit]');
await page.waitForSelector('aside.sidebar nav', { timeout: 10000 }).catch(async () => { console.log('DEBUG ana login failed; alert text:', JSON.stringify(await page.textContent('[role=alert]').catch(() => null)), 'url', page.url()); await page.screenshot({ path: '/tmp/e2e-ana.png' }); throw new Error('ana login did not reach the app'); });
const navText = await page.textContent('aside.sidebar nav');
check('custom role sees exactly its screens (reports yes; channels/team/roles/settings no)', navText.includes('דוחות') && !navText.includes('ערוצים') && !navText.includes('צוות') && !navText.includes('תפקידים') && !navText.includes('הגדרות'));
check('custom role is refused by the API too', (await page.request.get(BASE + '/users')).status() === 403);
await page.click('aside.sidebar >> button:has-text("התנתקות")');
await page.waitForSelector('#email');

// ============ themes: every accent in light and dark passes axe; choice persists ============
await page.fill('#email', 'ana@e2e.io'); await page.fill('#pw', 'analyst-password-1'); await page.click('button[type=submit]');
await page.waitForSelector('aside.sidebar nav');
await page.click('aside.sidebar nav >> text=החשבון שלי');
for (const mode of ['כהה', 'בהיר', 'רך']) {
  for (const [accent, key] of [['אינדיגו', 'indigo'], ['טורקיז', 'teal'], ['ורוד', 'rose'], ['ענבר', 'amber'], ['אפור-כחול', 'slate']]) {
    await page.click('aside.sidebar button[aria-label="מראה המערכת"]');
    await page.click(`#theme-pop button[role=radio]:has-text("${mode}")`);
    await page.click(`#theme-pop button[aria-label="${accent}"]`);
    await page.keyboard.press('Escape');
    const attrs = await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.accent]);
    if (attrs[0] !== (mode === 'כהה' ? 'dark' : mode === 'רך' ? 'soft' : 'light') || attrs[1] !== key) { check(`theme applied ${mode}/${key}`, false, JSON.stringify(attrs)); }
    await axe(`theme ${mode}/${key}`);
  }
}
await page.click('aside.sidebar button[aria-label="מראה המערכת"]');
await page.click('#theme-pop button[role=radio]:has-text("כהה")');
await page.click('#theme-pop button[aria-label="טורקיז"]');
await page.reload();
await page.waitForSelector('aside.sidebar nav');
check('theme persists across reload (dark/teal)', JSON.stringify(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.accent])) === '["dark","teal"]');

// ============ phone layout (analyst = few destinations; then admin for the full inbox/chat experience) ============
await page.setViewportSize({ width: 390, height: 800 });
check('phone: sidebar hidden, bottom navigation visible', !(await page.isVisible('aside.sidebar')) && (await page.isVisible('nav.bottomnav')));
await axe('phone: account (dark/teal)');
const overflow390 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
check('phone: no horizontal scroll', !overflow390);
await page.click('aside.sidebar >> button:has-text("התנתקות")').catch(async () => { await page.setViewportSize({ width: 1200, height: 800 }); await page.click('aside.sidebar >> button:has-text("התנתקות")'); });
await page.waitForSelector('#email');
await page.setViewportSize({ width: 390, height: 800 });
await page.fill('#email', 'admin@e2e.io'); await page.fill('#pw', 'e2e-password-123'); await page.click('button[type=submit]');
await page.waitForSelector('#totp');
await page.fill('#totp', authenticator.generate(secret)); await page.click('button[type=submit]');
await page.waitForSelector('nav.bottomnav');
await page.goto(BASE + '/#/inbox');
await page.waitForSelector('.list-pane');
await axe('phone: inbox list');
check('phone: bottom nav has at most 4 items', (await page.locator('nav.bottomnav .bn-item').count()) <= 4);
await page.click('nav.bottomnav button:has-text("עוד")');
check('phone: "more" sheet lists every screen', (await page.textContent('dialog[open]')).includes('הגדרות') && (await page.textContent('dialog[open]')).includes('יומן ביקורת'));
await page.keyboard.press('Escape');
// open a conversation: full-screen chat with a composer pinned at the bottom
psql(`INSERT INTO messages (conversation_id, direction, body, external_id) SELECT id, 'in', 'שאלה מהטלפון', 'ph1' FROM conversations WHERE contact_id=(SELECT id FROM contacts WHERE display_name='לקוח משני')`);
await page.reload();
await page.waitForSelector('.conv-list button');
await page.click('.conv-list button:has-text("לקוח משני")');
await page.waitForSelector('.composer');
const geo = await page.evaluate(() => {
  const chat = document.querySelector('.chat-pane').getBoundingClientRect();
  const comp = document.querySelector('.composer').getBoundingClientRect();
  const send = document.querySelector('.composer .send').getBoundingClientRect();
  return { chatTop: chat.top, chatH: chat.height, vh: innerHeight, compBottom: comp.bottom, sendW: send.width, sendH: send.height, pos: getComputedStyle(document.querySelector('.chat-pane')).position };
});
check('phone: conversation is full-screen (fixed) and fills the viewport', geo.pos === 'fixed' && Math.abs(geo.chatH - geo.vh) < 4 && geo.chatTop <= 1);
check('phone: composer is pinned at the bottom edge', Math.abs(geo.compBottom - geo.vh) < 4);
check('phone: send button is a comfortable tap target (>=44px)', geo.sendW >= 44 && geo.sendH >= 44);
check('phone: bottom nav hidden behind the open chat', await page.evaluate(() => { const n = document.querySelector('nav.bottomnav').getBoundingClientRect(); const c = document.querySelector('.chat-pane'); const top = document.elementFromPoint(n.left + n.width / 2, n.top + n.height / 2); return c.contains(top); }));
await axe('phone: open conversation');
await page.fill('#reply', 'תשובה מהטלפון');
check('phone: send enabled after typing', !(await page.isDisabled('.composer .send')));
// the comment thread's taller composer (public / private choice) still fits on a phone, pinned at the bottom
await page.click('button[aria-label="חזרה לרשימה"]');
await page.click('.conv-list button:has-text("מגיב בפוסט")');
await page.waitForSelector('.reply-mode');
const cgeo = await page.evaluate(() => { const c = document.querySelector('.composer').getBoundingClientRect(); const s = document.querySelector('.composer .send').getBoundingClientRect(); return { bottom: c.bottom, top: c.top, vh: innerHeight, sendBottom: s.bottom }; });
check('phone: comment reply composer fits and stays at the bottom', Math.abs(cgeo.bottom - cgeo.vh) < 4 && cgeo.sendBottom <= cgeo.vh && cgeo.top > cgeo.vh * 0.35, JSON.stringify(cgeo));
await page.click('button[aria-label="חזרה לרשימה"]');
await page.waitForSelector('.list-pane');
const small = await page.evaluate(() => [...document.querySelectorAll('.chip, .bn-item, .conv-item')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && Math.min(r.width, r.height) < 44; }).map((e) => e.className));
check('phone: chips, tabs and list rows are all >= 44px touch targets', small.length === 0, JSON.stringify(small));
// no page scrolls sideways on a phone (wide tables become cards); every <details> opened so hidden tables are measured too
{ const wide = [];
  for (const pg of ['inbox', 'bot', 'flow', 'safety', 'kb', 'forms', 'reports', 'canned', 'channels', 'team', 'roles', 'integrations', 'audit', 'settings', 'account']) {
    await page.goto(`${BASE}/#/${pg}`); await page.waitForTimeout(700);
    await page.evaluate(() => document.querySelectorAll('main details').forEach((d) => { d.open = true; }));
    await page.waitForTimeout(150);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) wide.push(`${pg}:${over}`);
  }
  check('phone: no page scrolls sideways (tables become cards)', wide.length === 0, wide.join(' ')); }
for (const route of ['settings', 'team', 'channels', 'reports', 'roles', 'bot', 'kb', 'flow', 'integrations']) {
  await page.goto(BASE + '/#/' + route);
  await page.waitForSelector('main h1');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200);   // let the page fetch its data and settle before measuring
  const o = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  let why = '';
  if (o) why = JSON.stringify(await page.evaluate(() => { const vw = document.documentElement.clientWidth; const out = []; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.right > vw + 1) { let a = e.parentElement, clipped = false; while (a && a !== document.body) { const ox = getComputedStyle(a).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { clipped = true; break; } a = a.parentElement; } if (!clipped) out.push(`${e.tagName}.${e.className}|${(e.textContent || '').slice(0, 30)}|${Math.round(r.left)}..${Math.round(r.right)}`); } } if (!out.length) { for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) out.push(`CLIPPED ${e.tagName}.${e.className}|${getComputedStyle(e).position}|${Math.round(r.left)}..${Math.round(r.right)}`); } out.unshift(`sw=${document.documentElement.scrollWidth} cw=${vw} body=${document.body.scrollWidth}`); } return out.slice(0, 8); }));
  check(`phone: ${route} page has no horizontal page scroll`, !o, why);
}
await axe('phone: roles page');
check('PWA: manifest and service worker are served', (await page.request.get(BASE + '/manifest.webmanifest')).ok() && (await page.request.get(BASE + '/sw.js')).ok() && (await page.request.get(BASE + '/icons/icon-192.png')).ok());

await browser.close();
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
