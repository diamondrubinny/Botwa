import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT } from '../src/bot.js';
import { buildInteractive, buildTemplate, buildTemplateCreate, parseNumberedMenu, renderTemplateBody, summarizeTemplate } from '../src/channels/cloud-messages.js';
import { ChannelManager, createDefaultFactory } from '../src/channels/manager.js';
import { WhatsAppCloudAdapter } from '../src/channels/whatsapp-cloud.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('interactive message shapes', () => {
  const opt = (n: number, len = 8) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), title: 'א'.repeat(len) }));
  it('three short options become reply buttons, more become a list, too many or too long fall back to null', () => {
    const b = buildInteractive('972501112233', 'במה אפשר לעזור?', opt(3, 12)) as { interactive: { type: string; action: { buttons: { reply: { id: string; title: string } }[] } } };
    expect(b.interactive.type).toBe('button');
    expect(b.interactive.action.buttons).toHaveLength(3);
    expect(b.interactive.action.buttons[0]!.reply).toEqual({ id: '1', title: 'א'.repeat(12) });
    const l = buildInteractive('972501112233', 'בחרו נושא', opt(4)) as { interactive: { type: string; action: { button: string; sections: { rows: { id: string; title: string; description?: string }[] }[] } } };
    expect(l.interactive.type).toBe('list');
    expect(l.interactive.action.sections[0]!.rows).toHaveLength(4);
    expect(l.interactive.action.button.length).toBeLessThanOrEqual(20);
    // three options but one title longer than 20: a list (titles up to 24, longer ones shortened and described in full)
    const mixed = buildInteractive('1', 'x', [{ id: '1', title: 'קצר' }, { id: '2', title: 'א'.repeat(22) }, { id: '3', title: 'ב' }]) as { interactive: { type: string } };
    expect(mixed.interactive.type).toBe('list');
    const long = buildInteractive('1', 'x', [{ id: '1', title: 'ת'.repeat(60) }, { id: '2', title: 'ב' }, { id: '3', title: 'ג' }, { id: '4', title: 'ד' }]) as { interactive: { action: { sections: { rows: { title: string; description?: string }[] }[] } } };
    const row = long.interactive.action.sections[0]!.rows[0]!;
    expect(row.title.length).toBeLessThanOrEqual(24);
    expect(row.description!.length).toBeLessThanOrEqual(72);
    expect(buildInteractive('1', 'x', opt(11))).toBeNull();
    expect(buildInteractive('1', 'x', [])).toBeNull();
    expect(buildInteractive('1', '  ', opt(2))).toBeNull();
    expect((buildInteractive('1', 'ש'.repeat(2000), opt(2)) as { interactive: { body: { text: string } } }).interactive.body.text.length).toBeLessThanOrEqual(1024);
  });
  it('turns the bot\'s numbered text menu back into intro and options, and refuses anything that is not one', () => {
    expect(parseNumberedMenu('שלום!\n\n1. שעות\n2. מיקום\n0. נציג אנושי')).toEqual({ body: 'שלום!', options: [{ id: '1', title: 'שעות' }, { id: '2', title: 'מיקום' }, { id: '0', title: 'נציג אנושי' }] });
    expect(parseNumberedMenu('לא הבנתי.\n\nבמה לעזור?\n\n1. א\n2. ב')!.body).toBe('לא הבנתי.\n\nבמה לעזור?');
    expect(parseNumberedMenu('1. אחד\n2. שניים')).toBeNull();                     // no intro
    expect(parseNumberedMenu('רק אפשרות אחת\n\n1. א')).toBeNull();
    expect(parseNumberedMenu('שלבים:\n\n2. שני\n3. שלישי')).toBeNull();             // does not start at 1
    expect(parseNumberedMenu('רגיל בלי מספרים')).toBeNull();
  });
  it('template shapes: send, create, summarise and render', () => {
    expect(buildTemplate('972501112233', { name: 'order_ready', language: 'he', params: ['דנה', '123'] })).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '972501112233', type: 'template',
      template: { name: 'order_ready', language: { code: 'he' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'דנה' }, { type: 'text', text: '123' }] }] },
    });
    expect((buildTemplate('1', { name: 'hello', language: 'en', params: [] }) as { template: Record<string, unknown> }).template.components).toBeUndefined();
    expect(buildTemplateCreate({ name: 'x', language: 'he', category: 'UTILITY', body: 'שלום {{1}}, ההזמנה {{2}} מוכנה', examples: ['דנה', '55', 'extra'] })).toEqual({ name: 'x', language: 'he', category: 'UTILITY', components: [{ type: 'BODY', text: 'שלום {{1}}, ההזמנה {{2}} מוכנה', example: { body_text: [['דנה', '55']] } }] });
    const t = summarizeTemplate({ name: 'order_ready', language: 'he', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'HEADER', text: 'כותרת' }, { type: 'BODY', text: 'שלום {{1}}, הזמנה {{2}}' }] })!;
    expect(t).toMatchObject({ name: 'order_ready', status: 'APPROVED', params: 2, body: 'שלום {{1}}, הזמנה {{2}}', rejectedReason: null });
    expect(summarizeTemplate({ name: 'a', language: 'he', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', components: [] })!.rejectedReason).toBe('INVALID_FORMAT');
    expect(summarizeTemplate({ language: 'he' })).toBeNull();
    expect(renderTemplateBody('שלום {{1}}, הזמנה {{2}}', ['דנה', '55'])).toBe('שלום דנה, הזמנה 55');
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
const SECRET = 'app-secret-0123456789abcdef';
const TOKEN = 'EAAG' + 'x'.repeat(40);

describe('official channel: menus as buttons and message templates', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  let failInteractive = false;
  let tplList: unknown[] = [];
  let createdBody: unknown = null;
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.method === 'POST' && url.endsWith('/messages')) {
      sent.push({ url, body });
      if (failInteractive && body.type === 'interactive') return Response.json({ error: { code: 100, message: 'bad' } }, { status: 400 });
      return Response.json({ messages: [{ id: `wamid.${sent.length}` }] });
    }
    if (init?.method === 'POST' && url.endsWith('/message_templates')) { createdBody = body; return Response.json({ id: '555', status: 'PENDING' }); }
    if (url.includes('/message_templates')) return Response.json({ data: tplList });
    return Response.json({ display_phone_number: '+972 50-000-0000', verified_name: 'Shop' });
  };
  const cookies: Record<string, string> = {};
  let ip = 0;
  let channelId = '';
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, who?: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: `10.79.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  const hook = (body: unknown) => {
    const raw = JSON.stringify(body);
    return app.inject({ method: 'POST', url: `/webhooks/whatsapp/${channelId}`, payload: raw, remoteAddress: '203.0.113.9', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex') } });
  };
  const inbound = (id: string, from: string, over: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, profile: { name: 'Dana' } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), ...over }] } }] }] });

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, (type, ctx) => (type === 'whatsapp_cloud' ? new WhatsAppCloudAdapter(ctx, fakeFetch) : createDefaultFactory(cfg)(type, ctx)));
    app = await buildApp(cfg, db, mgr);
    for (const [e, role] of [['adm', 'admin'], ['ag', 'agent'], ['ag2', 'agent']] as const) {
      await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3)`, [`${e}@t.io`, role, await hashPassword(PW)]);
      cookies[e] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW })).cookies[0]!.value}`;
    }
    channelId = (await call('POST', '/channels', 'adm', { type: 'whatsapp_cloud', label: 'Official' })).json().id;
    await call('PUT', `/channels/${channelId}/cloud`, 'adm', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET });
    await call('PUT', '/settings/bot', 'adm', { ...DEFAULT_BOT, enabled: true });
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('a customer message gets the bot menu as a list (4 options), the text is kept in the conversation, and a tap is read as the option number', async () => {
    await call('PUT', '/settings/bot', 'adm', { ...DEFAULT_BOT, enabled: true, items: [{ title: 'שעות פעילות', answer: 'א׳-ה׳ 9-17' }, { title: 'מיקום', answer: 'ברחוב הראשי' }, { title: 'משלוחים', answer: 'תוך 3 ימים' }], humanOption: true });
    sent.length = 0;
    await hook(inbound('wamid.IN1', '972501112233', { type: 'text', text: { body: 'שלום' } }));
    await new Promise((r) => setTimeout(r, 80));
    const menu = sent.find((s) => s.body.type === 'interactive')!;
    expect((menu.body.interactive as { type: string }).type).toBe('list');                                   // 3 items + the person option = 4 rows
    expect(((menu.body.interactive as { action: { sections: { rows: { id: string }[] }[] } }).action.sections[0]!.rows).map((r) => r.id)).toEqual(['1', '2', '3', '0']);
    expect(sent.some((s) => s.body.type === 'text')).toBe(false);                                            // not also sent as plain text
    const stored = (await db.query(`SELECT body, auto FROM messages WHERE direction = 'out' ORDER BY created_at LIMIT 1`)).rows[0];
    expect(stored.body).toContain('1. שעות פעילות');
    expect(stored.auto).toBe(true);
    // the customer taps row 2: the webhook says list_reply with id "2" and a title; the bot answers the second item
    sent.length = 0;
    await hook(inbound('wamid.IN2', '972501112233', { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: '2', title: 'מיק…' } } }));
    await new Promise((r) => setTimeout(r, 80));
    expect(sent.map((s) => JSON.stringify(s.body))).toEqual(expect.arrayContaining([expect.stringContaining('ברחוב הראשי')]));
    expect((await db.query(`SELECT body FROM messages WHERE direction = 'in' AND body = '2' LIMIT 1`)).rows[0].body).toBe('2');
  });

  it('two or three short options become reply buttons; when Meta refuses, or the setting is off, the numbered text is sent instead', async () => {
    await call('PUT', '/settings/bot', 'adm', { ...DEFAULT_BOT, enabled: true, items: [{ title: 'שעות', answer: 'a' }, { title: 'מיקום', answer: 'b' }], humanOption: false });
    sent.length = 0;
    await hook(inbound('wamid.IN3', '972501119999', { type: 'text', text: { body: 'שלום' } }));
    await new Promise((r) => setTimeout(r, 80));
    expect((sent.find((s) => s.body.type === 'interactive')!.body.interactive as { type: string }).type).toBe('button');
    failInteractive = true; sent.length = 0;
    await hook(inbound('wamid.IN4', '972501118888', { type: 'text', text: { body: 'שלום' } }));
    await new Promise((r) => setTimeout(r, 80));
    expect(sent.find((s) => s.body.type === 'text')!.body).toMatchObject({ text: expect.objectContaining({ body: expect.stringContaining('1. שעות') }) });
    failInteractive = false;
    await call('PUT', '/settings/bot', 'adm', { ...DEFAULT_BOT, enabled: true, interactiveMenus: false, items: [{ title: 'שעות', answer: 'a' }, { title: 'מיקום', answer: 'b' }], humanOption: false });
    sent.length = 0;
    await hook(inbound('wamid.IN5', '972501117777', { type: 'text', text: { body: 'שלום' } }));
    await new Promise((r) => setTimeout(r, 80));
    expect(sent.some((s) => s.body.type === 'interactive')).toBe(false);
    expect(sent.some((s) => s.body.type === 'text')).toBe(true);
  });

  it('templates: the business account id is needed to read them; admins see them with their status; creation is validated', async () => {
    expect((await call('GET', `/channels/${channelId}/templates`, 'ag')).statusCode).toBe(403);
    expect((await call('GET', `/channels/${channelId}/templates`, 'adm')).json()).toEqual({ error: 'waba_not_configured' });
    expect((await call('PUT', `/channels/${channelId}/cloud`, 'adm', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET, wabaId: 'abc' })).statusCode).toBe(400);
    expect((await call('PUT', `/channels/${channelId}/cloud`, 'adm', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET, wabaId: '998877665544' })).json()).toMatchObject({ ok: true, status: 'connected' });
    expect((await call('GET', `/channels/${channelId}/cloud`, 'adm')).json()).toMatchObject({ wabaId: '998877665544' });
    tplList = [
      { name: 'order_ready', language: 'he', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'שלום {{1}}, ההזמנה {{2}} מוכנה לאיסוף.' }] },
      { name: 'promo', language: 'he', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'מבצע!' }] },
      { name: 'old', language: 'en', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] },
    ];
    const list = (await call('GET', `/channels/${channelId}/templates?refresh=1`, 'adm')).json() as { name: string; status: string; params: number; rejectedReason: string | null }[];
    expect(list.map((t) => `${t.name}:${t.status}:${t.params}`)).toEqual(['order_ready:APPROVED:2', 'promo:PENDING:0', 'old:REJECTED:0']);
    expect(list[2]!.rejectedReason).toBe('INVALID_FORMAT');
    const good = { name: 'new_tpl', language: 'he', category: 'UTILITY', body: 'שלום {{1}}, הבקשה {{2}} התקבלה.', examples: ['דנה', '12'] };
    expect((await call('POST', `/channels/${channelId}/templates`, 'ag', good)).statusCode).toBe(403);
    for (const bad of [{ ...good, name: 'Bad Name' }, { ...good, category: 'AUTHENTICATION' }, { ...good, body: 'שלום {{2}}' }, { ...good, body: '{{1}} שלום', examples: ['a'] }, { ...good, examples: ['רק אחד'] }, { ...good, language: 'xx' }]) {
      expect((await call('POST', `/channels/${channelId}/templates`, 'adm', bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await call('POST', `/channels/${channelId}/templates`, 'adm', good)).json()).toEqual({ ok: true, status: 'PENDING' });
    expect(createdBody).toMatchObject({ name: 'new_tpl', category: 'UTILITY', components: [{ type: 'BODY', example: { body_text: [['דנה', '12']] } }] });
  });

  it('a template can be sent outside the 24-hour window, with checks: approved only, the right number of values, not to a blocked or opted-out customer', async () => {
    await hook(inbound('wamid.IN9', '972501115555', { type: 'text', text: { body: 'היי' } }));
    await new Promise((r) => setTimeout(r, 80));
    const conv = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = '972501115555@s.whatsapp.net'`)).rows[0];
    await db.query(`UPDATE messages SET created_at = now() - interval '3 days' WHERE conversation_id = $1`, [conv.id]);   // the customer last wrote 3 days ago
    // free text is refused now (outside the window) ...
    expect((await call('POST', `/conversations/${conv.id}/messages`, 'ag', { text: 'שלום' })).json()).toEqual({ error: 'outside_reply_window' });
    // ... the approved templates are listed ...
    const tpls = (await call('GET', `/conversations/${conv.id}/templates`, 'ag')).json() as { name: string }[];
    expect(tpls.map((t) => t.name)).toEqual(['order_ready']);
    // ... and one can be sent
    sent.length = 0;
    const ok = await call('POST', `/conversations/${conv.id}/send-template`, 'ag', { name: 'order_ready', language: 'he', params: ['דנה', '123'] });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().body).toBe('שלום דנה, ההזמנה 123 מוכנה לאיסוף.');
    expect(sent[0]!.body).toMatchObject({ type: 'template', to: '972501115555', template: { name: 'order_ready', language: { code: 'he' } } });
    expect((await db.query('SELECT assigned_to FROM conversations WHERE id = $1', [conv.id])).rows[0].assigned_to).not.toBeNull();
    expect((await call('POST', `/conversations/${conv.id}/send-template`, 'ag', { name: 'promo', language: 'he', params: [] })).json()).toEqual({ error: 'template_not_approved' });
    expect((await call('POST', `/conversations/${conv.id}/send-template`, 'ag', { name: 'order_ready', language: 'he', params: ['רק אחד'] })).json()).toEqual({ error: 'bad_params' });
    expect((await call('POST', `/conversations/${conv.id}/send-template`, 'ag', { name: 'nope', language: 'he', params: [] })).json()).toEqual({ error: 'template_not_found' });
    expect((await call('POST', `/conversations/${conv.id}/send-template`, 'ag2', { name: 'order_ready', language: 'he', params: ['א', 'ב'] })).statusCode).toBe(404);   // someone else's conversation
    await db.query(`UPDATE contacts SET opted_out = true WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`, [conv.id]);
    expect((await call('POST', `/conversations/${conv.id}/send-template`, 'ag', { name: 'order_ready', language: 'he', params: ['א', 'ב'] })).json()).toEqual({ error: 'contact_opted_out' });
    await db.query(`UPDATE contacts SET opted_out = false, blocked = true WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`, [conv.id]);
    expect((await call('POST', `/conversations/${conv.id}/send-template`, 'ag', { name: 'order_ready', language: 'he', params: ['א', 'ב'] })).json()).toEqual({ error: 'contact_blocked' });
  });
});
