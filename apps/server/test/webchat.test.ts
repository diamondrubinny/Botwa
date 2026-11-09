import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { contrast, identitySignature, normalizeOrigin, originAllowed, textOn, verifyIdentity } from '../src/webchat/config.js';

describe('widget configuration helpers', () => {
  it('accepts only exact https origins (or localhost) and wildcard subdomains', () => {
    expect(normalizeOrigin('https://Example.com/')).toBe('https://example.com');
    expect(normalizeOrigin('https://*.shop.co.il')).toBe('https://*.shop.co.il');
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    for (const bad of ['http://example.com', 'https://example.com/path', '*', 'https://*', 'javascript:alert(1)', 'https://exa mple.com', 'https://localhost', 'ftp://x.com', 'https://a.b.c.d.e/ ' + 'x'.repeat(5)]) expect(normalizeOrigin(bad), bad).toBeNull();
    const list = ['https://example.com', 'https://*.shop.co.il'];
    expect(originAllowed(list, 'https://example.com')).toBe(true);
    expect(originAllowed(list, 'https://www.shop.co.il')).toBe(true);
    expect(originAllowed(list, 'https://a.b.shop.co.il')).toBe(true);
    for (const o of ['https://evil.com', 'https://example.com.evil.com', 'https://shop.co.il', 'https://evilshop.co.il', 'http://example.com', 'https://notexample.com']) expect(originAllowed(list, o), o).toBe(false);
  });
  it('picks a readable text colour or refuses the brand colour', () => {
    expect(textOn('#4338ca')).toBe('#ffffff');
    expect(textOn('#ffeb3b')).toBe('#111111');
    expect(textOn('#7a7a7a')).toBeNull(); // this grey: neither white nor near-black reaches 4.5:1
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
  it('verifies identity signatures in constant time and rejects malformed input', () => {
    const sig = identitySignature('secret', 'cust-42');
    expect(verifyIdentity('secret', 'cust-42', sig)).toBe(true);
    expect(verifyIdentity('secret', 'cust-43', sig)).toBe(false);
    expect(verifyIdentity('other', 'cust-42', sig)).toBe(false);
    expect(verifyIdentity('secret', 'cust 42', sig)).toBe(false);
    expect(verifyIdentity('secret', 'cust-42', 'zz')).toBe(false);
  });
});

describe('website chat widget', () => {
  const ORIGIN = 'https://panel.test';
  const SITE = 'https://shop.example.com';
  const PW = 'correct-horse-battery';
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false',
  });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  const cookies: Record<string, string> = {};
  let ip = 0;
  const staff = (method: 'GET' | 'POST' | 'PUT', url: string, who: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.63.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
  // the widget calls come from the iframe page, which is served by our own origin
  const pub = (method: 'GET' | 'POST', url: string, token?: string, payload?: object, remote?: string) =>
    app.inject({ method, url, payload, remoteAddress: remote ?? `10.64.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  let channelId = '';
  let key = '';

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r, n] of [['admin', 'admin', 'Admin Boss'], ['a1', 'agent', 'Dana Levi']] as const) {
      await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [`${e}@t.io`, n, r, await hashPassword(PW)]);
      cookies[`${e}@t.io`] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.9.0.${++ip}`, headers: { origin: ORIGIN }, payload: { email: `${e}@t.io`, password: PW } })).cookies[0]!.value}`;
    }
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('admins create the channel; defaults are safe; settings are validated', async () => {
    const c = await staff('POST', '/channels', 'admin@t.io', { type: 'webchat', label: 'Shop site' });
    expect(c.statusCode).toBe(201);
    channelId = c.json().id;
    expect((await staff('GET', `/channels/${channelId}/webchat`, 'a1@t.io')).statusCode).toBe(403);
    const g = (await staff('GET', `/channels/${channelId}/webchat`, 'admin@t.io')).json();
    key = g.publicKey;
    expect(key).toMatch(/^wc_[\w-]{20,}$/);
    expect(g.allowedOrigins).toEqual([]); // nobody may embed it until the owner lists a site
    expect(g.embedCode).toBe(`<!-- Chat widget -->\n<script src="${ORIGIN}/widget.js" data-key="${key}" async></script>`);
    const base = { design: g.design, behavior: g.behavior, allowedOrigins: [SITE], allowAnyOrigin: false };
    expect((await staff('PUT', `/channels/${channelId}/webchat`, 'admin@t.io', { ...base, design: { ...g.design, color: '#7a7a7a' } })).json()).toEqual({ error: 'bad_color' });
    expect((await staff('PUT', `/channels/${channelId}/webchat`, 'admin@t.io', { ...base, allowedOrigins: ['http://shop.example.com'] })).json()).toEqual({ error: 'bad_origin' });
    expect((await staff('PUT', `/channels/${channelId}/webchat`, 'admin@t.io', { ...base, behavior: { ...g.behavior, consentLink: 'javascript:alert(1)' } })).statusCode).toBe(400);
    expect((await staff('PUT', `/channels/${channelId}/webchat`, 'admin@t.io', { ...base, design: { ...g.design, title: '<img src=x>', evil: 1 } })).statusCode).toBe(400); // strict schema
    const ok = await staff('PUT', `/channels/${channelId}/webchat`, 'admin@t.io', { ...base, behavior: { ...g.behavior, askName: 'required', askEmail: 'optional', consentText: 'אני מאשר את מדיניות הפרטיות', consentLink: 'https://shop.example.com/privacy' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('connected'); // saving starts the channel
    const sec = (await staff('POST', `/channels/${channelId}/webchat/identity-secret`, 'admin@t.io')).json().secret as string;
    expect(sec.length).toBeGreaterThan(30);
    const stored = (await db.query('SELECT identity_secret_enc FROM webchat_configs')).rows[0].identity_secret_enc as string;
    expect(stored).not.toContain(sec); // encrypted at rest
    expect(JSON.stringify((await staff('GET', `/channels/${channelId}/webchat`, 'admin@t.io')).json())).not.toContain(sec);
    (globalThis as { __secret?: string }).__secret = sec;
  });

  it('packages the WordPress plugin for this chat (admins only), pre-filled and without test files', async () => {
    const JSZip = (await import('jszip')).default;
    expect((await staff('GET', `/channels/${channelId}/webchat/wordpress-plugin.zip`, 'a1@t.io')).statusCode).toBe(403);
    expect((await staff('GET', '/channels/00000000-0000-4000-8000-000000000000/webchat/wordpress-plugin.zip', 'admin@t.io')).statusCode).toBe(404);
    const r = await staff('GET', `/channels/${channelId}/webchat/wordpress-plugin.zip`, 'admin@t.io');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    const z = await JSZip.loadAsync(r.rawPayload);
    const names = Object.keys(z.files);
    expect(names).toContain('botwa-chat/botwa-chat.php');
    expect(names).toContain('botwa-chat/includes/class-botwa-chat-frontend.php');
    expect(names).toContain('botwa-chat/languages/botwa-chat-he_IL.mo');
    expect(names.some((n) => n.includes('/tests/'))).toBe(false);
    const defaults = await z.file('botwa-chat/botwa-chat-defaults.php')!.async('string');
    expect(defaults).toContain(`'server' => "${ORIGIN}"`);
    expect(defaults).toContain(`'key' => "${key}"`);
    expect(defaults).not.toMatch(/secret/i);
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'channel.webchat_plugin_download'`)).rowCount).toBe(1);
  });

  it('serves the loader and the chat page with the right isolation headers', async () => {
    const js = await app.inject({ url: '/widget.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.headers['cross-origin-resource-policy']).toBe('cross-origin'); // must be loadable from other sites
    expect(js.body).toContain('BotwaChat');
    const page = await app.inject({ url: `/w/${key}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['x-frame-options']).toBeUndefined();
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain(`frame-ancestors ${SITE} ${ORIGIN}`);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect((await app.inject({ url: '/w/wc_doesnotexist12345' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/w/..%2F..%2Fetc' })).statusCode).toBe(404);
    // a chat page for a site that was never allowed can only be framed by the admin panel itself
    const g = (await staff('GET', `/channels/${channelId}/webchat`, 'admin@t.io')).json();
    await staff('PUT', `/channels/${channelId}/webchat`, 'admin@t.io', { design: g.design, behavior: g.behavior, allowedOrigins: [], allowAnyOrigin: false });
    expect(String((await app.inject({ url: `/w/${key}` })).headers['content-security-policy'])).toContain(`frame-ancestors ${ORIGIN}`);
    await staff('PUT', `/channels/${channelId}/webchat`, 'admin@t.io', { design: g.design, behavior: { ...g.behavior, askName: 'required', askEmail: 'optional', consentText: 'אני מאשר את מדיניות הפרטיות', consentLink: 'https://shop.example.com/privacy' }, allowedOrigins: [SITE], allowAnyOrigin: false });
  });

  it('config is public but CORS only opens for allowed sites; secrets never leak', async () => {
    const ok = await app.inject({ url: `/widget/config?key=${key}`, headers: { origin: SITE } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(SITE);
    expect((await app.inject({ url: `/widget/config?key=${key}`, headers: { origin: 'https://evil.com' } })).headers['access-control-allow-origin']).toBeUndefined();
    const j = ok.json();
    expect(j).toMatchObject({ available: true, textColor: '#ffffff', behavior: { askName: 'required' } });
    expect(JSON.stringify(j)).not.toMatch(/secret|identity/i);
    expect((await app.inject({ url: '/widget/config?key=nope' })).statusCode).toBe(404);
  });

  let token = '';
  it('a visitor starts a chat: details are validated, consent is required, bots are ignored, the inbox gets the conversation', async () => {
    const s = (await pub('POST', '/widget/session', undefined, { key })).json();
    token = s.token;
    expect(token.length).toBeGreaterThan(30);
    expect(s).toMatchObject({ hasConversation: false, verified: false });
    expect((await pub('POST', '/widget/messages', undefined, { text: 'hi' })).statusCode).toBe(401);
    expect((await pub('POST', '/widget/messages', 'x'.repeat(40), { text: 'hi' })).statusCode).toBe(401);
    expect((await pub('POST', '/widget/messages', token, { text: 'שלום' })).json()).toEqual({ error: 'missing_details' });                         // name required
    expect((await pub('POST', '/widget/messages', token, { text: 'שלום', name: 'דנה' })).json()).toEqual({ error: 'consent_required' });
    expect((await pub('POST', '/widget/messages', token, { text: 'שלום', name: 'דנה', consent: true, email: 'not-an-email' })).json()).toEqual({ error: 'bad_email' });
    expect((await db.query('SELECT count(*)::int AS n FROM conversations')).rows[0].n).toBe(0);
    expect((await pub('POST', '/widget/messages', token, { text: 'spam', name: 'bot', consent: true, hp: 'http://spam' })).json()).toEqual({ ok: true }); // honeypot: looks fine, stores nothing
    expect((await db.query('SELECT count(*)::int AS n FROM conversations')).rows[0].n).toBe(0);
    const r = await pub('POST', '/widget/messages', token, { text: '<b>שלום</b> יש לי שאלה', name: 'דנה כהן', email: 'dana@example.com', consent: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().seq).toBeGreaterThan(0);
    const conv = (await db.query(`SELECT c.id, ct.display_name, ct.external_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id`)).rows;
    expect(conv).toHaveLength(1);
    expect(conv[0]).toMatchObject({ display_name: 'דנה כהן' });
    expect(conv[0].external_id).toMatch(/^v[0-9a-f]{32}@web$/);
    const note = (await db.query('SELECT body FROM conversation_notes WHERE conversation_id = $1', [conv[0].id])).rows.map((x) => x.body).join('|');
    expect(note).toContain('dana@example.com');
    expect(note).toContain('אישר');
    expect((await pub('POST', '/widget/session', undefined, { key, token })).json()).toMatchObject({ hasConversation: true });
    expect((await pub('POST', '/widget/messages', token, { text: 'x'.repeat(3000) })).statusCode).toBe(200); // trimmed to the limit, not an error
    expect((await db.query(`SELECT max(length(body))::int AS n FROM messages`)).rows[0].n).toBeLessThanOrEqual(2000);
  });

  it('staff replies reach the visitor (long poll wakes at once); only own conversation is visible; agent first name is shown', async () => {
    const conv = (await db.query(`SELECT id FROM conversations`)).rows[0].id as string;
    const first = (await pub('GET', '/widget/messages?after=0', token)).json().messages as { seq: number; direction: string; text: string }[];
    expect(first.map((m) => m.direction)).toEqual(['in', 'in']);
    const last = first[first.length - 1]!.seq;
    const t0 = Date.now();
    const waiting = pub('GET', `/widget/messages?after=${last}&wait=10`, token);
    await new Promise((r) => setTimeout(r, 300));
    expect((await staff('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: 'שלום דנה, אני כאן' })).statusCode).toBe(201);
    const got = (await waiting).json().messages as { direction: string; text: string; sender: string | null }[];
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(got).toEqual([expect.objectContaining({ direction: 'out', text: 'שלום דנה, אני כאן', sender: 'Dana' })]);
    // internal notes are never visible
    await db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, 'פנימי')`, [conv]);
    expect(JSON.stringify((await pub('GET', '/widget/messages?after=0', token)).json())).not.toContain('פנימי');
    // another visitor sees nothing of this conversation
    const other = (await pub('POST', '/widget/session', undefined, { key })).json().token as string;
    expect((await pub('GET', '/widget/messages?after=0', other)).json().messages).toEqual([]);
    // a token of channel A does not work to reach channel B's config
    expect((await pub('GET', '/widget/messages?after=0&wait=abc', token)).statusCode).toBe(400);
  });

  it('verified identity links devices to one customer; a wrong signature is ignored', async () => {
    const secretPlain = (globalThis as { __secret?: string }).__secret!;
    const sig = identitySignature(secretPlain, 'cust-77');
    const s1 = (await pub('POST', '/widget/session', undefined, { key, identity: { id: 'cust-77', signature: sig } })).json();
    expect(s1.verified).toBe(true);
    const s2 = (await pub('POST', '/widget/session', undefined, { key, identity: { id: 'cust-77', signature: 'a'.repeat(64) } })).json();
    expect(s2.verified).toBe(false);
    const send = (tok: string, text: string) => pub('POST', '/widget/messages', tok, { text, name: 'לקוח', consent: true });
    expect((await send(s1.token, 'מהמחשב')).statusCode).toBe(200);
    const s3 = (await pub('POST', '/widget/session', undefined, { key, identity: { id: 'cust-77', signature: sig } })).json(); // second device
    expect(s3.hasConversation).toBe(true);
    expect((await pub('GET', '/widget/messages?after=0', s3.token)).json().messages.map((m: { text: string }) => m.text)).toEqual(['מהמחשב']);
    expect((await db.query(`SELECT count(*)::int AS n FROM contacts WHERE external_id = 'cust-77@web'`)).rows[0].n).toBe(1);
  });

  it('the bot and knowledge base answer web visitors like any other channel; a stopped channel refuses messages', async () => {
    await db.query(`INSERT INTO settings (key, value) VALUES ('bot', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ enabled: true, mode: 'menu', welcome: 'ברוכים הבאים לאתר', items: [{ title: 'שעות', answer: 'פתוחים 9-17' }], humanOption: true, humanLabel: 'נציג', humanKeywords: ['נציג'], humanMessage: 'מעביר', invalidMessage: 'לא הבנתי', invalidRetries: 1, footer: '', kb: { enabled: false, minScore: 0.6, maxChars: 700, showSource: true, intro: '' } })]);
    const t = (await pub('POST', '/widget/session', undefined, { key })).json().token as string;
    await pub('POST', '/widget/messages', t, { text: 'היי', name: 'ג׳ו', consent: true });
    const msgs = (await pub('GET', '/widget/messages?after=0', t)).json().messages as { direction: string; text: string; auto: boolean }[];
    expect(msgs.find((m) => m.direction === 'out')).toMatchObject({ auto: true, text: expect.stringContaining('1. שעות') });
    await staff('POST', `/channels/${channelId}/stop`, 'admin@t.io');
    expect((await pub('POST', '/widget/messages', t, { text: 'עוד', consent: true })).json()).toEqual({ error: 'chat_offline' });
    expect((await app.inject({ url: `/widget/config?key=${key}` })).json().available).toBe(false);
  });

  it('suggests matching FAQ questions while the visitor types, with the answer on demand; only bot FAQs; can be switched off', async () => {
    const faq = (title: string, body: string, audience = 'both', variants: string[] = []) => staff('POST', '/kb/sources/faq', 'admin@t.io', { title, body, variants, audience });
    const ship = (await faq('כמה זמן לוקח משלוח', 'משלוח עד 3 ימי עסקים. פרטים: https://shop.example.com/ship', 'both', ['מתי תגיע ההזמנה'])).json().id as string;
    await faq('איך מחזירים מוצר', 'החזרה תוך 14 יום.');
    await faq('מה הסיסמה של מערכת הקופה', 'סוד פנימי', 'staff');                                  // staff only: never suggested
    await mgr.kb!.idle();
    const s = (await pub('POST', '/widget/session', undefined, { key })).json().token as string;
    expect((await pub('GET', '/widget/suggest?q=משלוח')).statusCode).toBe(401);               // a session is needed
    expect((await pub('GET', '/widget/suggest?q=מש', s)).json()).toEqual({ items: [] });       // too short
    expect((await pub('GET', '/widget/suggest?q=משלוח', s)).json().items).toEqual([{ id: ship, q: 'כמה זמן לוקח משלוח' }]);
    expect((await pub('GET', '/widget/suggest?q=מתי תגיע', s)).json().items.map((x: { id: string }) => x.id)).toEqual([ship]);   // by another wording
    expect((await pub('GET', '/widget/suggest?q=סיסמה', s)).json().items).toEqual([]);
    expect((await pub('GET', `/widget/suggest?q=${encodeURIComponent('%_%')}`, s)).json().items).toEqual([]);   // wildcards are plain text
    const a = (await pub('GET', `/widget/answer/${ship}`, s)).json();
    expect(a).toEqual({ q: 'כמה זמן לוקח משלוח', a: 'משלוח עד 3 ימי עסקים. פרטים: https://shop.example.com/ship', url: null });
    const staffOnly = (await db.query(`SELECT id FROM kb_sources WHERE title = 'מה הסיסמה של מערכת הקופה'`)).rows[0].id;
    expect((await pub('GET', `/widget/answer/${staffOnly}`, s)).statusCode).toBe(404);
    expect((await pub('GET', '/widget/answer/not-an-id', s)).statusCode).toBe(404);
    expect((await db.query(`SELECT uses FROM kb_sources WHERE id = $1`, [ship])).rows[0].uses).toBeGreaterThan(0);
    // off in the settings: nothing is suggested or answered
    const g = (await staff('GET', `/channels/${channelId}/webchat`, 'admin@t.io')).json();
    expect(g.behavior.suggestions).toBe(true);
    await staff('PUT', `/channels/${channelId}/webchat`, 'admin@t.io', { design: g.design, behavior: { ...g.behavior, suggestions: false }, allowedOrigins: g.allowedOrigins, allowAnyOrigin: g.allowAnyOrigin });
    expect((await pub('GET', '/widget/suggest?q=משלוח', s)).json()).toEqual({ items: [] });
    expect((await pub('GET', `/widget/answer/${ship}`, s)).statusCode).toBe(404);
    await staff('PUT', `/channels/${channelId}/webchat`, 'admin@t.io', { design: g.design, behavior: { ...g.behavior, suggestions: true }, allowedOrigins: g.allowedOrigins, allowAnyOrigin: g.allowAnyOrigin });
  });
});
