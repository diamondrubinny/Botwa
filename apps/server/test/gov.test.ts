import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterFactory } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { LEGAL_NOTE } from '../src/kb/gov/notes.js';
import { parseLawWikitext, splitArgs } from '../src/kb/gov/wikilaw.js';
import { makeHttp, type HttpResult, type WsOptions } from '../src/kb/gov/wikisource.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

// A shortened excerpt in the format of the Open Law Book (ספר החוקים הפתוח, Hebrew Wikisource, CC BY-SA).
const FIRST_AID = `{{ח:התחלה}}
{{ח:כותרת|תקנות הבטיחות בעבודה (עזרה ראשונה במקומות עבודה), התשמ״ח–1988}}

{{ח:פתיח-התחלה}}
{{ח:תיבה|ק״ת תשמ״ח, 445|תקנות הבטיחות בעבודה (עזרה ראשונה במקומות עבודה)|https://olaw.org.il/takanot/takanot-5083.pdf}}; {{ח:תיבה|תשמ״ט, 147|תיקון}}.
{{ח:סוגר}}
{{ח:מפריד}}

{{ח:מבוא}}
בתוקף סמכותי לפי {{ח:חיצוני|פקודת הבטיחות בעבודה#סעיף 147|סעיפים 147(א)}} לפקודה, אני מתקין תקנות אלה:
{{ח:סוגר}}

{{ח:קטע2||תוכן עניינים}}
<div class="law-toc">
<div class="law-toc-2">{{ח:פנימי|פרק א|פרק א׳: כללי}}</div>
</div>

{{ח:קטע2|פרק א|פרק א׳: כללי}}
{{ח:סעיף|1|הגדרות|תיקון: תשנ״א}}
{{ח:ת}} בתקנות אלה –
{{ח:ת|סוג=הגדרה}} ”מגיש מאומן“ – אדם שמונה על ידי המעסיק להגיש עזרה ראשונה, בהתאם {{ח:חיצוני|פקודת הבטיחות בעבודה#סעיף 148|לסעיף 148 לפקודה}};

{{ח:סעיף|2|חובת החזקת ארגז עזרה ראשונה}}
{{ח:ת}} בכל מקום עבודה חייבים להימצא בכל עת '''ארגז עזרה ראשונה''' בהתאם למספר העובדים כמצויין {{ח:פנימי|תוספת|בתוספת}}.

{{ח:סעיף|3א|ערכת חילוץ ומילוט}}
{{ח:תת|(א)}} בכל מקום עבודה שבו מועסקים 50 עובדים או יותר תימצא ערכת חילוץ ומילוט{{ח:הערה|<ref>הערה</ref>}}.
{{ח:תת|(ב)}} פחות מ־50 עובדים – ערכה אחת לפחות, אם הסיכון מחייב זאת.<script>alert(1)</script>

{{ח:קטע2|תוספת|תוספת}}
{{ח:סעיף*|||עוגן=תוספת חלק א}}
<table>
<tr><th>{{מוקטן|פריט}}</th><th>{{מוקטן|מ־1 עד 19 {{ש}} עובדים}}</th></tr>
<tr><td>פדים סטריליים</td><td>25</td></tr>
</table>

{{ח:חתימות|ב׳ בכסלו התשמ״ח (23 בנובמבר 1987)}}
* '''שם השר'''<br>שר העבודה והרווחה
{{ח:סוף}}
[[קטגוריה:בוט חוקים]]`;

describe('Open Law Book wikitext', () => {
  it('splits template arguments, keeping nested templates whole', () => {
    expect(splitArgs('ח:חיצוני|א#ב|טקסט {{ח:הערה|x|y}} סוף')).toEqual(['ח:חיצוני', 'א#ב', 'טקסט {{ח:הערה|x|y}} סוף']);
  });

  it('turns a regulation into headed sections, without the table of contents, publications, signatures or markup', () => {
    const r = parseLawWikitext(FIRST_AID, 'תקנות הבטיחות בעבודה (עזרה ראשונה במקומות עבודה)');
    expect(r.title).toBe('תקנות הבטיחות בעבודה (עזרה ראשונה במקומות עבודה), התשמ״ח–1988');
    expect(r.unit).toBe('תקנה');
    expect(r.sections).toBe(3);
    expect(r.signed).toBe('ב׳ בכסלו התשמ״ח (23 בנובמבר 1987)');
    expect(r.publications).toEqual([
      { citation: 'ק״ת תשמ״ח, 445', label: 'תקנות הבטיחות בעבודה (עזרה ראשונה במקומות עבודה)', url: 'https://olaw.org.il/takanot/takanot-5083.pdf' },
      { citation: 'תשמ״ט, 147', label: 'תיקון', url: null },
    ]);
    const t = r.text;
    expect(t).toContain('# פרק א׳: כללי\n\n### תקנה 1 – הגדרות');
    expect(t).toContain('### תקנה 2 – חובת החזקת ארגז עזרה ראשונה\n\nבכל מקום עבודה חייבים להימצא בכל עת ארגז עזרה ראשונה בהתאם למספר העובדים כמצויין בתוספת.');
    expect(t).toContain('(א) בכל מקום עבודה שבו מועסקים 50 עובדים או יותר תימצא ערכת חילוץ ומילוט.');
    expect(t).toContain('”מגיש מאומן“ – אדם שמונה על ידי המעסיק להגיש עזרה ראשונה, בהתאם לסעיף 148 לפקודה;');
    expect(t).toContain('# תוספת\n\n### תוספת חלק א');
    expect(t).toContain('פריט | מ־1 עד 19\nעובדים');
    expect(t).toContain('פדים סטריליים | 25');
    expect(t).toContain('בתוקף סמכותי לפי סעיפים 147(א) לפקודה');
    for (const gone of ['תוכן עניינים', 'law-toc', 'olaw.org.il', 'שם השר', 'קטגוריה', '{{', '}}', '<', '>', "'''", 'alert(1)'.replace('alert', '<script>')]) expect(t).not.toContain(gone);
    expect(t).not.toMatch(/\u0001|\u0002|\u0003/);
  });

  it('numbers the sections of a law as "סעיף"', () => {
    expect(parseLawWikitext('{{ח:סעיף|4|חובה}}\n{{ח:ת}} טקסט ארוך מספיק.', 'פקודת הבטיחות בעבודה').text).toContain('### סעיף 4 – חובה');
  });

  it('refuses any host but Wikisource', async () => {
    await expect(makeHttp('t')('https://example.com/w/api.php')).rejects.toThrow('blocked_address');
    await expect(makeHttp('t')('http://he.wikisource.org/w/api.php')).rejects.toThrow('blocked_address');
  });
});

// ---- the import, against a stand-in for the MediaWiki API -----------------------------------------------------------------------
const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
const cookies: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, who: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.97.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });

const T1 = 'תקנות הבטיחות בעבודה (עזרה ראשונה במקומות עבודה)';
const T2 = 'תקנות הבטיחות בעבודה (חשמל)';
const wiki: Record<string, { revid: number; content: string }> = {
  [T1]: { revid: 100, content: FIRST_AID },
  [T2]: { revid: 200, content: `{{ח:כותרת|${T2}, התש״ן–1990}}\n{{ח:סעיף|2|עבודה במיתקן חשמלי}}\n{{ח:ת}} לא יעבוד אדם במיתקן חשמלי חי אלא אם כן הוא חשמלאי בעל רישיון מתאים, והעבודה נעשית בהתאם להוראות תקנות אלה ובאמצעי הגנה מתאימים.\n\n{{ח:סעיף|3|ציוד מגן}}\n{{ח:ת}} המעסיק יספק לעובד ציוד מגן מבודד, ויוודא שהוא תקין ונבדק לפני כל שימוש בעבודה במיתקן חשמלי.` },
};
let throttleNext = 0;
const requests: string[] = [];
const slept: number[] = [];
const fakeHttp = async (url: string): Promise<HttpResult> => {
  requests.push(url);
  if (throttleNext > 0) { throttleNext--; return { status: 429, retryAfter: 7, body: '' }; }
  const q = new URL(url).searchParams;
  const titles = (q.get('titles') ?? '').split('|');
  if (q.get('prop') === 'info') return { status: 200, retryAfter: null, body: JSON.stringify({ query: { pages: titles.map((t) => (wiki[t] ? { title: t, lastrevid: wiki[t]!.revid } : { title: t, missing: true })) } }) };
  if (q.get('prop') === 'revisions') {
    const t = titles[0]!;
    const p = wiki[t];
    return { status: 200, retryAfter: null, body: JSON.stringify({ query: { pages: [p ? { title: t, revisions: [{ revid: p.revid, timestamp: '2026-01-01T00:00:00Z', slots: { main: { content: p.content } } }] } : { title: t, missing: true }] } }) };
  }
  if (q.get('list') === 'search') return { status: 200, retryAfter: null, body: JSON.stringify({ query: { search: [{ title: T1 }, { title: T2 }, { title: `${T2}/תזכיר` }, { title: 'ויקיטקסט:משהו' }] } }) };
  return { status: 400, retryAfter: null, body: '' };
};
const ws: WsOptions = { http: fakeHttp, sleep: async (ms) => { slept.push(ms); }, gapMs: 0 };
const state = async () => (await call('GET', '/kb/gov', 'adm')).json() as { settings: { enabled: boolean; lastReport: Record<string, unknown> | null; catalog: string[] | null }; running: boolean; imported: { id: string; pageTitle: string; status: string; error: string | null; enabled: boolean; detached: boolean; revid: number; sections: number; chunks: number; audience: string }[] };
const save = (who: string, p: object) => call('PUT', '/kb/gov', who, { enabled: true, audience: 'staff', refreshDays: 7, selection: [T1, T2], ...p });

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, (() => null) as unknown as AdapterFactory);
  app = await buildApp(cfg, db, mgr);
  mgr.gov!.setWs(ws);
  for (const [e, r] of [['adm', 'admin'], ['ag', 'agent']] as const) {
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [`${e}@t.io`, e, r, await hashPassword(PW)]);
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `${e}@t.io`, password: PW }, remoteAddress: `10.97.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('importing safety laws into the knowledge base', () => {
  it('is off until enabled, and only kb.manage may see or change it', async () => {
    const s = await state();
    expect(s.settings.enabled).toBe(false);
    expect(await mgr.gov!.runDue()).toBeNull();
    expect((await call('GET', '/kb/gov', 'ag')).statusCode).toBe(403);
    expect((await save('ag', {})).statusCode).toBe(403);
    expect((await call('POST', '/kb/gov/sync', 'ag')).statusCode).toBe(403);
  });

  it('accepts only plain law titles', async () => {
    for (const bad of ['תקנות הבטיחות|action=delete', 'תקנות {{x}} בעבודה', 'משתמש:מישהו', `${T2}/תזכיר`, 'תקנות א\nב']) expect((await save('adm', { selection: [bad] })).statusCode).toBe(400);
    expect((await save('adm', { refreshDays: 0 })).statusCode).toBe(400);
    expect((await save('adm', { audience: 'everyone' })).statusCode).toBe(400);
  });

  it('lists the available laws and regulations (law texts only)', async () => {
    expect((await call('POST', '/kb/gov/catalog', 'adm')).json()).toEqual({ catalog: [T2, T1] });   // alphabetical (ח before ע)
    expect((await state()).settings.catalog).toEqual([T2, T1]);
  });

  it('imports the chosen regulations as staff-only knowledge, one section per passage', async () => {
    expect((await save('adm', {})).statusCode).toBe(200);
    const r = await mgr.gov!.sync('manual');
    expect(r).toMatchObject({ checked: 2, created: 2, updated: 0, unchanged: 0, failed: [], missing: [] });
    const s = await state();
    expect(s.imported.map((x) => [x.pageTitle, x.status, x.audience, x.revid, x.sections])).toEqual([[T2, 'ready', 'staff', 200, 2], [T1, 'ready', 'staff', 100, 3]]);
    const row = (await db.query(`SELECT s.title, s.url, s.meta, c.name FROM kb_sources s JOIN kb_categories c ON c.id = s.category_id WHERE s.external_id = $1`, [T1])).rows[0];
    expect(row.title).toBe('תקנות הבטיחות בעבודה (עזרה ראשונה במקומות עבודה), התשמ״ח–1988');
    expect(row.url).toBe('https://he.wikisource.org/wiki/' + encodeURIComponent(T1.replace(/ /g, '_')));
    expect(row.name).toBe('חקיקה ותקינה (ייבוא אוטומטי)');
    expect(row.meta).toMatchObject({ revid: 100, sections: 3, source: 'wikisource' });
    expect(row.meta.attribution).toContain('CC BY-SA');
    // staff find the section; the bot (customers) does not, while the audience is staff
    const hit = (await call('POST', '/kb/search', 'adm', { q: 'ארגז עזרה ראשונה במקום עבודה' })).json() as { hits?: { heading: string; title: string }[] } | { heading: string; title: string }[];
    const hits = Array.isArray(hit) ? hit : hit.hits ?? [];
    expect(hits[0]).toMatchObject({ heading: 'פרק א׳: כללי › תקנה 2 – חובת החזקת ארגז עזרה ראשונה' });
    expect(await mgr.kb!.answer('חובת החזקת ארגז עזרה ראשונה במקום עבודה', { minScore: 0.5, maxChars: 600 }, 'bot', 'test')).toBeNull();
  });

  it('a bot answer from the law names the law and section and says it is not legal advice', async () => {
    expect((await save('adm', { audience: 'both' })).statusCode).toBe(200);
    expect((await state()).imported.every((x) => x.audience === 'both')).toBe(true);   // applies at once
    const a = await mgr.kb!.answer('חובת החזקת ארגז עזרה ראשונה במקום עבודה', { minScore: 0.5, maxChars: 600 }, 'bot', 'test');
    expect(a?.text).toContain('ארגז עזרה ראשונה');
    expect(a?.text).toContain('(תקנות הבטיחות בעבודה (עזרה ראשונה במקומות עבודה), התשמ״ח–1988, תקנה 2 – חובת החזקת ארגז עזרה ראשונה)');
    expect(a?.text.endsWith(LEGAL_NOTE)).toBe(true);
    expect((await save('adm', { audience: 'staff' })).statusCode).toBe(200);
  });

  it('fetches again only what changed at the source', async () => {
    requests.length = 0;
    expect(await mgr.gov!.sync('manual')).toMatchObject({ unchanged: 2, created: 0, updated: 0 });
    expect(requests.filter((u) => u.includes('prop=revisions'))).toHaveLength(0);   // one light revision check only
    wiki[T2]!.revid = 201;
    wiki[T2]!.content = wiki[T2]!.content.replace('ציוד מגן מבודד', 'ציוד מגן מבודד תקני');
    expect(await mgr.gov!.sync('manual')).toMatchObject({ unchanged: 1, updated: 1 });
    expect((await db.query(`SELECT body FROM kb_sources WHERE external_id = $1`, [T2])).rows[0].body).toContain('ציוד מגן מבודד תקני');
  });

  it('waits as long as the source asks when it is busy (429)', async () => {
    wiki[T1]!.revid = 101;
    slept.length = 0;
    throttleNext = 2;
    expect(await mgr.gov!.sync('manual')).toMatchObject({ updated: 1, failed: [] });
    expect(slept.filter((ms) => ms === 7500)).toHaveLength(2);
  });

  it('a text edited by staff is theirs: later imports leave it alone', async () => {
    const id = (await state()).imported.find((x) => x.pageTitle === T2)!.id;
    expect((await call('PATCH', `/kb/sources/${id}`, 'adm', { body: 'נוסח פנימי שלנו לתקנות החשמל, כולל הנחיות המפעל.' })).statusCode).toBe(200);
    wiki[T2]!.revid = 202;
    expect(await mgr.gov!.sync('manual')).toMatchObject({ detached: 1, updated: 0 });
    expect((await db.query(`SELECT body, detached FROM kb_sources WHERE id = $1`, [id])).rows[0]).toMatchObject({ body: 'נוסח פנימי שלנו לתקנות החשמל, כולל הנחיות המפעל.', detached: true });
  });

  it('a page that disappeared stops answering; a title no longer chosen is removed (an edited one is kept as a normal entry)', async () => {
    const r1 = wiki[T1]!;
    delete wiki[T1];
    expect(await mgr.gov!.sync('manual')).toMatchObject({ missing: [T1] });
    expect((await state()).imported.find((x) => x.pageTitle === T1)).toMatchObject({ enabled: false, status: 'error', error: 'gone' });
    wiki[T1] = { ...r1, revid: 102 };
    expect(await mgr.gov!.sync('manual')).toMatchObject({ updated: 1 });
    expect((await state()).imported.find((x) => x.pageTitle === T1)).toMatchObject({ enabled: true, status: 'ready', error: null });

    expect((await save('adm', { selection: [T1] })).statusCode).toBe(200);
    expect(await mgr.gov!.sync('manual')).toMatchObject({ removed: 1, checked: 1 });
    expect((await state()).imported.map((x) => x.pageTitle)).toEqual([T1]);
    expect((await db.query(`SELECT origin FROM kb_sources WHERE body LIKE 'נוסח פנימי שלנו%'`)).rows).toEqual([{ origin: null }]);
  });

  it('runs on schedule only when the refresh interval has passed', async () => {
    expect(await mgr.gov!.runDue()).toBeNull();                                  // just ran
    await db.query(`UPDATE gov_sources SET last_run_at = now() - interval '8 days'`);
    expect(await mgr.gov!.runDue()).toMatchObject({ trigger: 'schedule' });
    const audit = (await db.query(`SELECT action FROM audit_log WHERE action LIKE 'kb.gov.%' ORDER BY id`)).rows.map((r) => r.action);
    expect(audit).toContain('kb.gov.update');
    expect(audit).toContain('kb.gov.catalog');
  });

  it('starting an import from the screen runs in the background', async () => {
    const r = await call('POST', '/kb/gov/sync', 'adm');
    expect(r.statusCode).toBe(202);
    for (let i = 0; i < 50 && (await state()).running; i++) await new Promise((res) => setTimeout(res, 20));
    expect((await state()).settings.lastReport).toMatchObject({ trigger: 'manual' });
  });
});

// ---- stage 2: the official standards list (data.gov.il) -----------------------------------------------------------------------------
import { matchesKeywords, DEFAULT_KEYWORDS, standardEntry, type StdRecord } from '../src/kb/gov/standards.js';
import { STANDARDS_NOTE } from '../src/kb/gov/notes.js';

const rec = (i: number, number: string, name: string, extra: Partial<StdRecord> = {}): StdRecord => ({
  index: `1-${String(i).padStart(5, '0')}`, standard_number: number, standard_name: name, standard_edition: 'פברואר 2022', validity_from: '21/02/2022', validity_to: 'התקן בתוקף',
  amendments: 'אין', mandatory_sections: 'כל הסעיפים', note: 'אין', standard_process: 'לא בתהליך', standard_originality: 'מאומץ', standard_number_en: number.replace('ת"י', 'SI'), standard_name_en: 'Ladders', ...extra,
});

describe('official standards: choosing and describing', () => {
  it('matches whole words (after a Hebrew prefix letter) and word starts marked with *', () => {
    expect(matchesKeywords('ציוד לכיבוי אש: זרנוקים', DEFAULT_KEYWORDS)).toBe(true);
    expect(matchesKeywords('סולמות: סולמות טלסקופיים', DEFAULT_KEYWORDS)).toBe(true);
    expect(matchesKeywords('ציוד מגן אישי: מנעלי בטיחות', DEFAULT_KEYWORDS)).toBe(true);
    expect(matchesKeywords('אבזרים להיגיינה של האשה: טמפונים', DEFAULT_KEYWORDS)).toBe(false);          // "אש" is not "האשה"
    expect(matchesKeywords('ציוד רפואי: אגד גזה', DEFAULT_KEYWORDS)).toBe(false);                     // "גז" is not "גזה"
    expect(matchesKeywords('צמנט: צמנט רגיל', DEFAULT_KEYWORDS)).toBe(false);
    expect(matchesKeywords('מערכות מובלים עבור מתקני חשמל', ['מתקני חשמל'])).toBe(true);
    expect(matchesKeywords('Ladders - safety', ['ladder*'])).toBe(true);
  });

  it('describes a standard in plain text, without the source\'s HTML', () => {
    const e = standardEntry(rec(1, 'ת"י 1847 חלק 2', 'סולמות: דרישות, בדיקות וסימון', { amendments: "גיליון תיקון מס' 1 (מרץ 2023)", note: '<p>שים&nbsp;לב</p>', validity_to: '08/02/2027' }), '10.11.2026');
    expect(e.title).toBe('ת"י 1847 חלק 2 – סולמות: דרישות, בדיקות וסימון');
    expect(e.variants).toEqual(['תקן 1847 חלק 2', 'תקן ישראלי 1847 חלק 2', 'ת"י 1847', 'סולמות: דרישות, בדיקות וסימון', 'Ladders']);
    expect(e.body).toContain('מהדורה: פברואר 2022.\nתוקף: מ־21/02/2022, עד 08/02/2027.\nסעיפים מחייבים: כל הסעיפים.\nגיליונות תיקון: גיליון תיקון מס\' 1 (מרץ 2023).');
    expect(e.body).toContain('הערה: שים לב');
    expect(e.body).not.toContain('<');
    expect(e.body).not.toContain('בתהליך');                                                           // "not in process" is not worth a line
  });
});

describe('importing the official standards', () => {
  let records: StdRecord[] = [];
  let modified = '2026-11-09T18:59:03';
  let dgReq: string[] = [];
  const filler = Array.from({ length: 60 }, (_, i) => rec(100 + i, `ת"י ${9000 + i}`, `צמנט סוג ${i}`, { standard_name_en: 'Cement' }));
  const dgHttp = async (url: string): Promise<HttpResult> => {
    dgReq.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/resource_show')) return { status: 200, retryAfter: null, body: JSON.stringify({ success: true, result: { last_modified: modified } }) };
    if (u.pathname.endsWith('/datastore_search')) return { status: 200, retryAfter: null, body: JSON.stringify({ success: true, result: { total: records.length, records } }) };
    return { status: 404, retryAfter: null, body: '' };
  };
  const stdState = async () => (await call('GET', '/kb/gov/standards', 'adm')).json() as { settings: { lastReport: Record<string, unknown> }; imported: { id: string; title: string; audience: string; detached: boolean }[]; defaults: string[] };
  const saveStd = (who: string, p: object = {}) => call('PUT', '/kb/gov/standards', who, { enabled: true, audience: 'staff', refreshDays: 7, includeAll: false, keywords: [], ...p });

  beforeAll(() => {
    records = [rec(1, 'ת"י 1847 חלק 2', 'סולמות: דרישות, בדיקות וסימון'), rec(2, 'ת"י 129 חלק 1', 'מטפים מיטלטלים: תחזוקה', { standard_name_en: 'Portable fire extinguishers: Maintenance' }), ...filler];
    mgr.standards!.setDg({ http: dgHttp, sleep: async () => undefined });
  });

  it('only kb.manage may change it; keywords must be plain words', async () => {
    expect((await call('GET', '/kb/gov/standards', 'ag')).statusCode).toBe(403);
    expect((await saveStd('ag')).statusCode).toBe(403);
    expect((await call('POST', '/kb/gov/standards/sync', 'ag')).statusCode).toBe(403);
    for (const bad of ['a', 'x<script>', 'גז|גזים', '*סולם']) expect((await saveStd('adm', { keywords: [bad] })).statusCode).toBe(400);
    expect((await stdState()).defaults).toContain('סולמ*');
  });

  it('imports the matching standards as question-and-answer entries, staff only', async () => {
    expect((await saveStd('adm')).statusCode).toBe(200);
    const r = await mgr.standards!.sync('manual');
    expect(r).toMatchObject({ total: 62, matched: 2, created: 2, failed: [] });
    expect(dgReq.some((u) => u.includes('fields=index%2Cstandard_number'))).toBe(true);            // only the fields used, not the whole record
    const s = await stdState();
    expect(s.imported.map((x) => [x.title, x.audience])).toEqual([['ת"י 129 חלק 1 – מטפים מיטלטלים: תחזוקה', 'staff'], ['ת"י 1847 חלק 2 – סולמות: דרישות, בדיקות וסימון', 'staff']]);
    const hits = (await call('POST', '/kb/search', 'adm', { q: 'תקן 1847 חלק 2' })).json().hits as { title: string; exact: boolean }[];
    expect(hits[0]).toMatchObject({ title: 'ת"י 1847 חלק 2 – סולמות: דרישות, בדיקות וסימון', exact: true });
    expect(await mgr.kb!.answer('תקן 1847 חלק 2', { minScore: 0.5, maxChars: 900 }, 'bot', 'test')).toBeNull();   // not for customers yet
  });

  it('opened to the bot, the answer is the whole entry plus where it comes from', async () => {
    expect((await saveStd('adm', { audience: 'both' })).statusCode).toBe(200);
    const a = await mgr.kb!.answer('תקן 1847 חלק 2', { minScore: 0.5, maxChars: 900 }, 'bot', 'test');
    expect(a?.text).toContain('סעיפים מחייבים: כל הסעיפים.');
    expect(a?.text.endsWith(STANDARDS_NOTE)).toBe(true);
    expect((await saveStd('adm')).statusCode).toBe(200);
  });

  it('skips the download when the source did not change, and updates or removes what changed', async () => {
    dgReq = [];
    expect(await mgr.standards!.sync('manual')).toMatchObject({ skipped: true });
    expect(dgReq.filter((u) => u.includes('datastore_search'))).toHaveLength(0);
    modified = '2026-11-12T08:00:00';
    records[0] = { ...records[0]!, amendments: "גיליון תיקון מס' 1 (מרץ 2026)" };
    records.splice(1, 1);                                                                             // the extinguisher standard is no longer official
    expect(await mgr.standards!.sync('manual')).toMatchObject({ updated: 1, removed: 1, unchanged: 0 });
    const s = await stdState();
    expect(s.imported).toHaveLength(1);
    expect((await db.query(`SELECT body FROM kb_sources WHERE id = $1`, [s.imported[0]!.id])).rows[0].body).toContain('מרץ 2026');
  });

  it('an empty or broken answer from the source never wipes the list', async () => {
    const keep = records;
    records = [];
    modified = '2026-11-13T08:00:00';
    expect(await mgr.standards!.sync('manual')).toMatchObject({ failed: [{ title: '*', error: 'unrecognized_format' }] });
    expect((await stdState()).imported).toHaveLength(1);
    records = keep;
  });

  it('"all official standards" imports the whole list; an edited entry is kept as the staff\'s own', async () => {
    const id = (await stdState()).imported[0]!.id;
    expect((await call('PATCH', `/kb/sources/${id}`, 'adm', { variants: ['סולם מאושר'] })).statusCode).toBe(200);
    expect((await saveStd('adm', { includeAll: true })).statusCode).toBe(200);
    expect(await mgr.standards!.sync('manual')).toMatchObject({ matched: 61, created: 60, detached: 1 });
    expect((await saveStd('adm', { includeAll: false, keywords: ['מטפ*'] })).statusCode).toBe(200);
    expect(await mgr.standards!.sync('manual')).toMatchObject({ matched: 0, removed: 61 });
    expect((await db.query(`SELECT origin, variants FROM kb_sources WHERE id = $1`, [id])).rows[0]).toEqual({ origin: null, variants: ['סולם מאושר'] });
  });
});

// ---- stage 3: status of the imported laws in the Knesset database -----------------------------------------------------------------
describe('law status from the Knesset database', () => {
  const L1 = 'פקודת הבטיחות בעבודה';
  const L2 = 'חוק ארגון הפיקוח על העבודה';
  const lawText = (title: string, extra = '') => `${extra}{{ח:כותרת|${title}}}\n{{ח:סעיף|1|הגדרות}}\n{{ח:ת}} בחוק זה מפקח עבודה הוא מי שמונה לפי סעיף 2, והוא רשאי להיכנס לכל מקום עבודה ולבדוק את קיום הוראות הבטיחות והגיהות בו.\n\n{{ח:סעיף|2|מינוי}}\n{{ח:ת}} השר ימנה מפקח עבודה ראשי ומפקחי עבודה, ויפרסם הודעה על כך ברשומות כפי שנקבע.`;
  const laws: Record<number, { IsraelLawID: number; Name: string; LawValidityDesc: string; PublicationDate: string; LatestPublicationDate: string; ValidityFinishDate: string | null }> = {
    2000850: { IsraelLawID: 2000850, Name: 'פקודת הבטיחות בעבודה [נוסח חדש], התש"ל-1970', LawValidityDesc: 'תקף', PublicationDate: '1970-08-30T00:00:00', LatestPublicationDate: '2017-07-12T00:00:00', ValidityFinishDate: null },
    2000843: { IsraelLawID: 2000843, Name: 'פקודת הבטיחות בעבודה, 1946', LawValidityDesc: 'בטל', PublicationDate: '1946-02-05T00:00:00', LatestPublicationDate: '1970-08-30T00:00:00', ValidityFinishDate: '1971-03-27T00:00:00' },
    2000104: { IsraelLawID: 2000104, Name: 'חוק ארגון הפיקוח על העבודה, התשי"ד-1954', LawValidityDesc: 'תקף', PublicationDate: '1954-09-03T00:00:00', LatestPublicationDate: '2023-11-21T00:00:00', ValidityFinishDate: null },
  };
  const knReq: string[] = [];
  const knHttp = async (url: string): Promise<HttpResult> => {
    knReq.push(decodeURIComponent(url));
    const u = new URL(url);
    const byId = /KNS_IsraelLaw\((\d+)\)$/.exec(u.pathname);
    if (byId) { const r = laws[Number(byId[1])]; return r ? { status: 200, retryAfter: null, body: JSON.stringify(r) } : { status: 404, retryAfter: null, body: '' }; }
    const f = /startswith\(Name,'(.*)'\)/.exec(u.searchParams.get('$filter') ?? '')?.[1] ?? '';
    return { status: 200, retryAfter: null, body: JSON.stringify({ value: Object.values(laws).filter((r) => r.Name.startsWith(f.replace(/''/g, "'"))) }) };
  };
  const row = async (t: string) => (await state()).imported.find((x) => x.pageTitle === t) as unknown as { enabled: boolean; status: string; error: string | null; knesset: Record<string, unknown> | null };

  beforeAll(async () => {
    wiki[L1] = { revid: 300, content: lawText('פקודת הבטיחות בעבודה [נוסח חדש], תש״ל–1970', '{{ח:מאגר|2000850}}\n') };
    wiki[L2] = { revid: 400, content: lawText('חוק ארגון הפיקוח על העבודה, התשי״ד–1954') };
    mgr.gov!.setKn({ http: knHttp, sleep: async () => undefined });
    expect((await save('adm', { selection: [T1, L1, L2] })).statusCode).toBe(200);
  });
  afterAll(() => mgr.gov!.setKn(null));

  it('checks only laws and ordinances (regulations are not in the database), by id or by name and year', async () => {
    const r = await mgr.gov!.sync('manual');
    expect(r.knesset).toMatchObject({ checked: 2, repealed: [], notFound: [], error: null });
    expect(knReq.some((u) => u.includes('KNS_IsraelLaw(2000850)'))).toBe(true);                                 // the id stated on the page
    expect(knReq.some((u) => u.includes(`startswith(Name,'${L2}')`))).toBe(true);                                // the other by name
    expect(knReq.some((u) => u.includes('עזרה ראשונה'))).toBe(false);
    expect((await row(L1)).knesset).toMatchObject({ id: 2000850, validity: 'תקף', repealed: false, latestPublication: '2017-07-12', newerThanText: false });
    // the text was revised (2026) after the law's latest publication: not outdated. A later amendment would flag it:
    expect(r.knesset!.outdated).toEqual([]);
  });

  it('a newer amendment than the text is flagged; a repealed law stops answering and comes back when in force again', async () => {
    laws[2000104]!.LatestPublicationDate = '2027-01-15T00:00:00';
    laws[2000850]!.LawValidityDesc = 'בטל';
    const r = await mgr.gov!.sync('manual');
    expect(r.knesset).toMatchObject({ repealed: [L1], outdated: [{ title: L2, latest: '2027-01-15' }] });
    expect(await row(L1)).toMatchObject({ enabled: false, status: 'error', error: 'repealed' });
    expect((await row(L2)).knesset).toMatchObject({ newerThanText: true });
    expect((await mgr.gov!.sync('manual')).knesset!.repealed).toEqual([]);                                      // reported once
    laws[2000850]!.LawValidityDesc = 'תקף';
    expect((await mgr.gov!.sync('manual')).knesset!.reinstated).toEqual([L1]);
    expect(await row(L1)).toMatchObject({ enabled: true, status: 'ready', error: null });
  });

  it('without an id, picks the law of the title\'s year and prefers the one in force', async () => {
    const { lawStatus } = await import('../src/kb/gov/knesset.js');
    const kn = { http: knHttp, sleep: async () => undefined };
    expect(await lawStatus(kn, { knessetId: null, pageTitle: L1, fullTitle: 'פקודת הבטיחות בעבודה [נוסח חדש], תש״ל–1970' })).toMatchObject({ id: 2000850 });
    expect(await lawStatus(kn, { knessetId: null, pageTitle: L1, fullTitle: 'פקודת הבטיחות בעבודה, 1946' })).toMatchObject({ id: 2000843, repealed: true });
    expect(await lawStatus(kn, { knessetId: null, pageTitle: "חוק שאינו קיים'", fullTitle: 'x' })).toBeNull();
    expect(knReq.at(-1)).toContain("startswith(Name,'חוק שאינו קיים''')");                                       // quotes doubled for OData
  });

  it('a Knesset outage never fails the import', async () => {
    mgr.gov!.setKn({ http: async () => ({ status: 500, retryAfter: null, body: '' }), sleep: async () => undefined });
    const r = await mgr.gov!.sync('manual');
    expect(r.failed).toEqual([]);
    expect(r.knesset).toMatchObject({ error: 'http_500' });
    expect((await row(L1)).knesset).toMatchObject({ id: 2000850 });                                              // the previous status is kept
  });
});

// ---- stage 4: fire-safety requirements for business licensing ----------------------------------------------------------------------
import { groupRows, subtypeEntry } from '../src/kb/gov/fire.js';
import { FIRE_NOTE } from '../src/kb/gov/notes.js';

describe('fire-safety licensing requirements', () => {
  const row = (code: number, name: string, sub: string, num: string, desc: string, remarks = 'NULL', src = 'הוראת נציב 550') => ({
    CategoryDesc1: `קבוצה ${Math.floor(code)} - קבוצה`, CategoryCode2: code, CategoryDesc2: name, CategoryDesc3: sub, CategoryDesc4: '', CategoryDesc5: '', CategoryDesc6: '', CategoryDesc7: '',
    RequirementNumber: num, RequirementDesc: desc, Remarks: remarks, REQUIREMENT_SOURCE_DESC: src,
  });
  let rows: ReturnType<typeof row>[] = [];
  const build = () => {
    rows = [
      row(1.01, 'בית מרקחת', 'בית מרקחת עד 200 מ"ר', '3.2.18.1', 'שילוט', 'בעסק יותקנו שלטי "יציאה" בגוון לבן על רקע ירוק, עם תאורת חירום ל־60 דקות.'),
      row(1.01, 'בית מרקחת', 'בית מרקחת עד 200 מ"ר', '3.2.18.1', 'שילוט', 'בעסק יותקנו שלטי "יציאה" בגוון לבן על רקע ירוק, עם תאורת חירום ל־60 דקות.'),   // repeated in the source
      row(1.01, 'בית מרקחת', 'בית מרקחת מעל 500 מ"ר', '03.04.03.1', 'מערכת מתזי מים אוטומטית (ספרינקלרים) לפי ת"י 1596', 'המערכת תותקן בכל חלקי העסק'),
      row(1.01, 'בית מרקחת', 'בית מרקחת מעל 500 מ"ר', '3.2.18.1', 'שילוט', 'בעסק יותקנו שלטי "יציאה" בגוון לבן על רקע ירוק, עם תאורת חירום ל־60 דקות.'),
      { ...row(1, '', '', '9.9', 'שורה של קבוצה שלמה'), CategoryCode2: null as unknown as number },
    ];
    // filler: other business types, so the answer looks like the real dataset (it is checked for size)
    for (let t = 2; t <= 12; t++) for (let i = 0; i < 100; i++) rows.push(row(t + 0.01, `עסק מסוג ${t}`, `תת סוג ${i % 4}`, `${t}.${i}`, `דרישה כללית מספר ${i} לעסק מסוג ${t}`));
  };
  let resources = [
    { id: '00000000-0000-4000-8000-000000000001', datastore_active: true, last_modified: '2026-10-01T00:00:00' },
    { id: '00000000-0000-4000-8000-000000000002', datastore_active: true, last_modified: '2026-11-03T07:34:48' },
    { id: '00000000-0000-4000-8000-000000000003', datastore_active: false, last_modified: '2026-12-01T00:00:00' },
  ];
  const fireReq: string[] = [];
  const fireHttp = async (url: string): Promise<HttpResult> => {
    fireReq.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/package_show')) return { status: 200, retryAfter: null, body: JSON.stringify({ success: true, result: { resources } }) };
    if (u.pathname.endsWith('/datastore_search')) {
      const off = Number(u.searchParams.get('offset')), lim = Number(u.searchParams.get('limit'));
      return { status: 200, retryAfter: null, body: JSON.stringify({ success: true, result: { total: rows.length, records: rows.slice(off, off + lim) } }) };
    }
    return { status: 404, retryAfter: null, body: '' };
  };
  const fireState = async () => (await call('GET', '/kb/gov/fire', 'adm')).json() as { settings: { catalog: { code: string; name: string; subtypes: number; requirements: number }[] | null; lastReport: Record<string, unknown> }; imported: { id: string; title: string; code: string; audience: string; chunks: number }[] };
  const saveFire = (who: string, p: object = {}) => call('PUT', '/kb/gov/fire', who, { enabled: true, audience: 'staff', refreshDays: 30, selection: [], ...p });

  beforeAll(() => { build(); mgr.fire!.setDg({ http: fireHttp, sleep: async () => undefined }); });

  it('groups by business type and sub-type, without repeating a requirement, and skips rows that are not a business', () => {
    const { types, subtypes } = groupRows(rows);
    expect(types[0]).toEqual({ code: '1.01', name: 'בית מרקחת', group: 'קבוצה 1 - קבוצה', subtypes: 2, requirements: 3 });
    expect(types).toHaveLength(12);
    const e = subtypeEntry(subtypes.get('1.01')![1]!, '10.11.2026');
    expect(e.title).toBe('דרישות כבאות לרישוי עסקים – בית מרקחת › בית מרקחת מעל 500 מ"ר');
    expect(e.body).toContain('### דרישה 03.04.03.1 – מערכת מתזי מים אוטומטית (ספרינקלרים) לפי ת"י 1596\n\nמערכת מתזי מים אוטומטית (ספרינקלרים) לפי ת"י 1596\nהמערכת תותקן בכל חלקי העסק\nמקור הדרישה: הוראת נציב 550.');
    expect(e.body).not.toContain('NULL');
  });

  it('is off and empty until chosen; only kb.manage; business type numbers only', async () => {
    expect(await mgr.fire!.runDue()).toBeNull();
    expect((await call('GET', '/kb/gov/fire', 'ag')).statusCode).toBe(403);
    expect((await saveFire('ag')).statusCode).toBe(403);
    expect((await call('POST', '/kb/gov/fire/sync', 'ag')).statusCode).toBe(403);
    for (const bad of [['1'], ['1.01; DROP'], ['abc']]) expect((await saveFire('adm', { selection: bad })).statusCode).toBe(400);
  });

  it('the first import loads the list of business types from the newest snapshot (in pages) and imports nothing', async () => {
    expect((await saveFire('adm')).statusCode).toBe(200);
    const r = await mgr.fire!.sync('manual');
    expect(r).toMatchObject({ resource: '00000000-0000-4000-8000-000000000002', total: 1105, types: 12, chosen: 0, created: 0, failed: [] });
    expect(fireReq.filter((u) => u.includes('datastore_search'))).toHaveLength(1);                       // 1,105 rows: one page of 3,000
    expect(fireReq.some((u) => u.includes('fields=CategoryDesc1'))).toBe(true);
    expect((await fireState()).settings.catalog?.[0]).toMatchObject({ code: '1.01', name: 'בית מרקחת', subtypes: 2, requirements: 3 });
  });

  it('imports the chosen business types, one source per sub-type and one passage per requirement', async () => {
    expect((await saveFire('adm', { selection: ['1.01'] })).statusCode).toBe(200);
    expect(await mgr.fire!.sync('manual')).toMatchObject({ chosen: 1, created: 2 });
    const s = await fireState();
    expect(s.imported.map((x) => [x.title, x.code, x.audience, x.chunks])).toEqual([
      ['דרישות כבאות לרישוי עסקים – בית מרקחת › בית מרקחת מעל 500 מ"ר', '1.01', 'staff', 3],
      ['דרישות כבאות לרישוי עסקים – בית מרקחת › בית מרקחת עד 200 מ"ר', '1.01', 'staff', 2],
    ]);
    const hits = (await call('POST', '/kb/search', 'adm', { q: 'ספרינקלרים בבית מרקחת מעל 500 מטר' })).json().hits as { title: string; heading: string }[];
    expect(hits[0]).toMatchObject({ title: 'דרישות כבאות לרישוי עסקים – בית מרקחת › בית מרקחת מעל 500 מ"ר' });
    expect(hits[0]!.heading).toContain('דרישה 03.04.03.1');
    expect(await mgr.kb!.answer('ספרינקלרים בבית מרקחת מעל 500', { minScore: 0.5, maxChars: 900 }, 'bot', 'test')).toBeNull();   // staff only
    expect((await saveFire('adm', { selection: ['1.01'], audience: 'both' })).statusCode).toBe(200);
    const a = await mgr.kb!.answer('ספרינקלרים בבית מרקחת מעל 500', { minScore: 0.5, maxChars: 900 }, 'bot', 'test');
    expect(a?.text).toContain('המערכת תותקן בכל חלקי העסק');
    expect(a?.text.endsWith(FIRE_NOTE)).toBe(true);
    expect((await saveFire('adm', { selection: ['1.01'] })).statusCode).toBe(200);
  });

  it('skips an unchanged snapshot; a new one updates what changed and removes what is gone; a broken one changes nothing', async () => {
    fireReq.length = 0;
    expect(await mgr.fire!.sync('manual')).toMatchObject({ skipped: true });
    expect(fireReq.filter((u) => u.includes('datastore_search'))).toHaveLength(0);
    resources = [...resources, { id: '00000000-0000-4000-8000-000000000004', datastore_active: true, last_modified: '2026-12-07T00:00:00' }];
    rows = rows.filter((r) => r.CategoryDesc3 !== 'בית מרקחת עד 200 מ"ר');
    rows[0] = { ...rows[0]!, Remarks: 'המערכת תותקן בכל חלקי העסק, כולל המחסן' };
    expect(await mgr.fire!.sync('manual')).toMatchObject({ resource: '00000000-0000-4000-8000-000000000004', updated: 1, removed: 1 });
    const keep = rows;
    rows = rows.slice(0, 50);
    resources = [...resources, { id: '00000000-0000-4000-8000-000000000005', datastore_active: true, last_modified: '2027-01-07T00:00:00' }];
    expect(await mgr.fire!.sync('manual')).toMatchObject({ failed: [{ title: '*', error: 'unrecognized_format' }] });
    expect((await fireState()).imported).toHaveLength(1);
    rows = keep;
  });
});
