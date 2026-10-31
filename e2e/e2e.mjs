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
await page.waitForSelector('text=מחייב אימות דו-שלבי');
check('forced MFA banner', true);
await page.click('text=הגדרת אימות דו-שלבי');
const secret = (await page.textContent('code')).trim();
await page.fill('#mfa-code', authenticator.generate(secret)); await page.click('button:has-text("הפעלה")');
await page.click('aside.sidebar nav >> text=החשבון שלי');
await page.waitForSelector('text=אימות דו-שלבי פעיל');
check('MFA enabled', true);
await axe('account');

// channels
await page.click('aside.sidebar nav >> text=ערוצים');
await page.fill('#ch-label', 'תמיכה ראשית'); await page.click('button:has-text("יצירה")');
await page.waitForSelector('text=תמיכה ראשית');
await page.waitForSelector('#health-h');
await page.waitForSelector('th:has-text("נשלחו ב-24 שעות")');
check('channel health panel present', true);
await page.waitForSelector('th:has-text("סיכון חסימה")');
await page.click('button:has-text("עצירת חירום של שליחה")');
await page.waitForSelector('text=השליחה מושהית ידנית.');
await axe('channels: paused');
await page.click('button:has-text("חידוש שליחה")');
await page.waitForSelector('button:has-text("עצירת חירום של שליחה")');
check('emergency pause and resume work from the panel', true);
await axe('channels');
await page.click('text=קישור עם מספר טלפון (בלי QR)');
await page.waitForSelector('input[placeholder="972501234567"]');
await axe('phone-number pairing form');
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
await axe('team');

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
await page.selectOption('#route', 'round_robin');
await page.waitForSelector('text=נשמר.');
await page.waitForSelector('#s-min');
await page.waitForSelector('#s-rw');
await axe('settings: sending protection');
await page.click('button:has-text("יצירת גיבוי עכשיו")');
await page.waitForSelector('text=הגיבוי נוצר.', { timeout: 60000 });
await page.waitForSelector('a:has-text("הורדה")');
await axe('settings with routing + backups');
const bkHref = await page.getAttribute('a:has-text("הורדה")', 'href');
const bk = await page.request.get(BASE + bkHref);
check('backup download is encrypted', bk.ok() && (await bk.body()).subarray(0, 8).toString() === 'BOTWABK1');
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

// canned replies page
await page.click('aside.sidebar nav >> text=תשובות ותגיות');
await page.fill('#c-title', 'ברכה'); await page.fill('#c-body', 'שלום, איך אפשר לעזור?');
await page.click('button:has-text("הוספה")');
await page.waitForSelector('li.card:has-text("ברכה")');
await page.fill('#tag-name', 'VIP'); await page.click('button:has-text("הוספת תגית")');
await page.waitForSelector('li.badge:has-text("VIP")');
await axe('canned replies + tags');

// seed an inbound conversation directly (adapter can't reach WhatsApp here)
const ch = psql("SELECT id FROM channels LIMIT 1");
psql(`INSERT INTO contacts (channel_id, external_id, display_name) VALUES ('${ch}','972501234567@s.whatsapp.net','יוסי לקוח')`);
psql(`INSERT INTO conversations (channel_id, contact_id, unread_count) SELECT '${ch}', id, 2 FROM contacts`);
psql(`INSERT INTO messages (conversation_id, direction, body, external_id) SELECT id, 'in', 'היי, צריך עזרה בהזמנה', 'x1' FROM conversations`);

// same customer (same phone) also writing on a second WhatsApp channel
psql(`INSERT INTO channels (type, label) VALUES ('whatsapp', 'ערוץ שני')`);
psql(`INSERT INTO contacts (channel_id, external_id, display_name) SELECT id, '972501234567@s.whatsapp.net', 'לקוח משני' FROM channels WHERE label='ערוץ שני'`);
psql(`INSERT INTO conversations (channel_id, contact_id) SELECT channel_id, id FROM contacts WHERE display_name='לקוח משני'`);
psql(`INSERT INTO messages (conversation_id, direction, body, external_id) SELECT id, 'in', 'הודעה בערוץ שני', 'sec1' FROM conversations WHERE contact_id=(SELECT id FROM contacts WHERE display_name='לקוח משני')`);

await page.click('aside.sidebar nav >> text=שיחות');
await page.waitForSelector('.conv-list button');
check('conversation listed with unread', (await page.textContent('.unread')).includes('2'));
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
await page.waitForSelector('#rel-h');
check('related conversation (same phone, other channel) listed', await page.isVisible('#rel-h ~ ul >> text=ערוץ שני'));
await page.click('#rel-h ~ ul button');
await page.waitForSelector('.chat-pane h2:has-text("לקוח משני")');
check('opening related conversation works', true);
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.waitForSelector('.chat-pane h2:has-text("יוסי לקוח")');
await page.selectOption('#canned', { label: 'ברכה' });
check('canned reply inserted', (await page.inputValue('#reply')).includes('איך אפשר לעזור'));
await page.click('.conv-list button:has-text("לקוח משני")');
await page.waitForSelector('.chat-pane h2:has-text("לקוח משני")');
check('draft does not leak into another conversation', (await page.inputValue('#reply')) === '');
await page.click('.conv-list button:has-text("יוסי לקוח")');
await page.waitForSelector('.chat-pane h2:has-text("יוסי לקוח")');
check('draft is restored when returning to the conversation', (await page.inputValue('#reply')).includes('איך אפשר לעזור'));
await page.fill('#reply', '/ברכ');
await page.waitForSelector('.slash button:has-text("ברכה")');
await page.click('.slash button:has-text("ברכה")');
check('slash menu inserts the canned reply', (await page.inputValue('#reply')).includes('איך אפשר לעזור') && !(await page.inputValue('#reply')).startsWith('/'));
await openMore();
await page.fill('#note', 'לקוח חשוב'); await page.click('button:has-text("הוספת הערה")');
await page.waitForSelector('#notes-h ~ ul li:has-text("לקוח חשוב")');
check('internal note added', true);
await axe('inbox with notes + canned');
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
check('contact erased: its conversation and files gone, other customer untouched', psql('SELECT count(*) FROM conversations') === '1' && psql('SELECT count(*) FROM attachments') === '0');


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
await page.click('.conv-list button >> nth=0');
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
await page.click('button[aria-label="חזרה לרשימה"]');
await page.waitForSelector('.list-pane');
const small = await page.evaluate(() => [...document.querySelectorAll('.chip, .bn-item, .conv-item')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && Math.min(r.width, r.height) < 44; }).map((e) => e.className));
check('phone: chips, tabs and list rows are all >= 44px touch targets', small.length === 0, JSON.stringify(small));
for (const route of ['settings', 'team', 'channels', 'reports', 'roles', 'bot']) {
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
