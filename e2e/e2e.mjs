import { chromium } from 'playwright-core';
import { authenticator } from 'otplib';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = 'http://localhost:3077';
const axeSrc = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const psql = (sql) => execSync(`psql -h localhost -U postgres -d botwa_e2e -tAc "${sql}"`, { env: { ...process.env, PGPASSWORD: 'pw' } }).toString().trim();
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'he-IL' });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

async function axe(label) {
  await page.evaluate(axeSrc);
  const r = await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }));
  check(`axe: ${label}`, r.violations.length === 0, r.violations.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0].html.slice(0, 90)}`).join(' | '));
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
await page.waitForSelector('text=תפקידכם מחייב אימות דו-שלבי');
check('forced MFA banner', true);
await page.click('text=הגדרת אימות דו-שלבי');
const secret = (await page.textContent('code')).trim();
await page.fill('#mfa-code', authenticator.generate(secret)); await page.click('button:has-text("הפעלה")');
await page.click('nav >> text=החשבון שלי');
await page.waitForSelector('text=אימות דו-שלבי פעיל');
check('MFA enabled', true);
await axe('account');

// channels
await page.click('nav >> text=ערוצים');
await page.fill('#ch-label', 'תמיכה ראשית'); await page.click('button:has-text("יצירה")');
await page.waitForSelector('text=תמיכה ראשית');
await axe('channels');
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
await page.click('nav >> text=צוות');
await page.fill('#u-name', 'דנה נציגה'); await page.fill('#u-email', 'dana@e2e.io'); await page.fill('#u-pw', 'agent-password-123');
await page.click('button:has-text("יצירת משתמש")');
await page.waitForSelector('td:has-text("dana@e2e.io")');
await axe('team');

// reports page
await page.click('nav >> text=דוחות');
await page.waitForSelector('text=זמן תגובה ממוצע');
await axe('reports');

// canned replies page
await page.click('nav >> text=תשובות מוכנות');
await page.fill('#c-title', 'ברכה'); await page.fill('#c-body', 'שלום, איך אפשר לעזור?');
await page.click('button:has-text("הוספה")');
await page.waitForSelector('li.card:has-text("ברכה")');
await axe('canned replies');

// seed an inbound conversation directly (adapter can't reach WhatsApp here)
const ch = psql("SELECT id FROM channels LIMIT 1");
psql(`INSERT INTO contacts (channel_id, external_id, display_name) VALUES ('${ch}','972501234567@s.whatsapp.net','יוסי לקוח')`);
psql(`INSERT INTO conversations (channel_id, contact_id, unread_count) SELECT '${ch}', id, 2 FROM contacts`);
psql(`INSERT INTO messages (conversation_id, direction, body, external_id) SELECT id, 'in', 'היי, צריך עזרה בהזמנה', 'x1' FROM conversations`);

await page.click('nav >> text=שיחות');
await page.waitForSelector('.conv-list button');
check('conversation listed with unread', (await page.textContent('.unread')).includes('2'));
await page.click('.conv-list button');
await page.waitForSelector('.msg.in');
await axe('inbox open conversation');
await page.selectOption('#canned', { label: 'ברכה' });
check('canned reply inserted', (await page.inputValue('#reply')).includes('איך אפשר לעזור'));
await page.fill('#note', 'לקוח חשוב'); await page.click('button:has-text("הוספת הערה")');
await page.waitForSelector('#notes-h ~ ul li:has-text("לקוח חשוב")');
check('internal note added', true);
await axe('inbox with notes + canned');
await page.fill('#srch', 'הזמנה');
await page.waitForSelector('.conv-list button');
await page.fill('#srch', 'zzzz-none');
await page.waitForSelector('text=אין שיחות להצגה');
check('search filters list', true);
await page.fill('#srch', '');
await page.waitForSelector('.conv-list button');
await page.fill('#reply', 'שלום, אני בודק'); await page.click('button:has-text("שליחה")');
await page.waitForSelector('text=הערוץ אינו מחובר');
check('send while disconnected shows friendly error', true);

// attachments: seeded rows in each state + real upload path (multipart + validation + clamd, stops at "channel not connected")
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const store = randomUUID();
mkdirSync('/tmp/e2e-media/clean', { recursive: true });
writeFileSync(`/tmp/e2e-media/clean/${store}`, PNG);
const conv = psql("SELECT id FROM conversations LIMIT 1");
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
await page.click('text=התנתקות');
await page.waitForSelector('#email');
await page.fill('#email', 'dana@e2e.io'); await page.fill('#pw', 'agent-password-123'); await page.click('button[type=submit]');
await page.waitForSelector('nav >> text=שיחות');
check('agent has no Channels/Team nav', (await page.locator('nav >> text=ערוצים').count()) === 0 && (await page.locator('nav >> text=צוות').count()) === 0);
await page.click('.conv-list button');
await page.click('text=קח שיחה'); await page.waitForSelector('text=שחרור שיחה');
check('agent claimed conversation', true);

// keyboard & widget & mobile
await page.click('.a11y-widget button.primary'); await page.click('button:has-text("ניגודיות גבוהה")');
check('high contrast toggles', (await page.getAttribute('html', 'data-contrast')) === 'high');
await axe('high contrast + inbox');
await page.setViewportSize({ width: 375, height: 700 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
check('no horizontal scroll at 375px', !overflow);
await page.goto(BASE + '/#/accessibility'); await axe('a11y statement');
await page.goto(BASE + '/#/privacy'); await axe('privacy page');
await page.screenshot({ path: '/tmp/botwa-e2e-shot.png', fullPage: true });

await browser.close();
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
