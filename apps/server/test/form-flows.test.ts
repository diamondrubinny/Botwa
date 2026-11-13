import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager, createDefaultFactory } from '../src/channels/manager.js';
import { WhatsAppCloudAdapter } from '../src/channels/whatsapp-cloud.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { buildFlowJson, flowStartData, initialsOf, parseFlowReply, shortLabel } from '../src/forms/flowjson.js';
import type { Field } from '../src/forms/schema.js';
import { createTemplate } from '../src/forms/service.js';
import { MediaService } from '../src/media/store.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const F = (id: string, type: Field['type'], label: string, extra: Partial<Field> = {}): Field => ({ id, type, label, page: 0, x: 10, y: 10, w: 100, h: 20, required: true, prefill: null, locked: false, hint: '', ...extra });

describe('a form template as a WhatsApp Flow', () => {
  it('short labels of at most 20 characters, whole words first', () => {
    expect(shortLabel('שם מלא:')).toBe('שם מלא');
    expect(shortLabel('מספר תעודת זהות של העובד המבצע')).toBe('מספר תעודת זהות של');
    expect(shortLabel('מספר תעודת זהות של העובד המבצע').length).toBeLessThanOrEqual(20);
    expect(shortLabel('אאאאאאאאאאאאאאאאאאאאאאאאאא')).toHaveLength(20);
  });

  it('screens of at most 8 inputs, a signature screen at the end, values read globally, prefills as initial values', () => {
    const fields = [F('name', 'text', 'שם מלא', { prefill: 'contact_name' }), ...Array.from({ length: 9 }, (_, i) => F(`q${i}`, 'text', `שאלה ${i + 1}`)), F('when', 'date', 'תאריך'), F('ok', 'checkbox', 'קראתי את הנוהל'),
      F('sig', 'signature', 'חתימה'), F('ini', 'initials', 'ראשי תיבות'), F('lk', 'text', 'מספר פנייה', { prefill: 'case_number', locked: true })];
    const b = buildFlowJson('היתר עבודה בגובה', fields);
    expect(b.problems).toEqual([]);
    const j = b.json as { version: string; screens: { id: string; terminal?: boolean; data: Record<string, unknown>; layout: { children: Record<string, unknown>[] } }[] };
    expect(j.version).toBe('7.3');
    expect(j.screens.map((s) => s.id)).toEqual(['S1', 'S2', 'S3']);
    expect(j.screens.some((s) => s.id === 'SUCCESS')).toBe(false);
    const inputs = (s: { layout: { children: Record<string, unknown>[] } }) => s.layout.children.filter((c) => !['TextSubheading', 'TextBody', 'Footer'].includes(c.type as string));
    expect(inputs(j.screens[0]!)).toHaveLength(8);
    expect(Object.values(b.names)).not.toContain('lk');                          // a locked system value is not asked
    expect(Object.values(b.names)).not.toContain('sig');
    const first = inputs(j.screens[0]!)[0]!;
    expect(first).toMatchObject({ type: 'TextInput', name: 'f0', 'init-value': '${data.p_f0}' });
    expect(j.screens[0]!.data).toEqual({ p_f0: { type: 'string', __example__: '' } });
    const last = j.screens[2]!;
    expect(last.terminal).toBe(true);
    const footer = last.layout.children.find((c) => c.type === 'Footer') as { 'on-click-action': { name: string; payload: Record<string, string> } };
    expect(footer['on-click-action'].name).toBe('complete');
    expect(footer['on-click-action'].payload).toMatchObject({ f0: '${screen.S1.form.f0}', f9: '${screen.S2.form.f9}', consent: '${form.consent}', signer_name: '${form.signer_name}' });
    for (const s of j.screens) for (const c of s.layout.children) if (typeof c.label === 'string' && c.type !== 'OptIn' && c.type !== 'Footer') expect((c.label as string).length, c.label as string).toBeLessThanOrEqual(20);
    const date = inputs(j.screens[1]!).find((c) => c.type === 'DatePicker');
    expect(date).toBeDefined();
    expect(flowStartData(fields, b.names, { name: 'דנה לוי', q0: 'x' })).toEqual({ p_f0: 'דנה לוי' });
  });

  it('reads the reply back by field id, and makes initials', () => {
    const r = parseFlowReply(JSON.stringify({ flow_token: 'f_x', f0: 'דנה', f1: true, consent: true, signer_name: '  דנה   לוי ', other: 'x' }), { f0: 'name', f1: 'ok' });
    expect(r).toEqual({ token: 'f_x', values: { name: 'דנה', ok: true }, consent: true, signer: 'דנה לוי' });
    expect(parseFlowReply('not json', {})).toBeNull();
    expect(parseFlowReply('[1]', {})).toBeNull();
    expect(initialsOf('דנה בת-שבע לוי')).toBe('ד.ב.ל.');
  });

  it('too long for WhatsApp: the link stays the way to fill it', () => {
    const b = buildFlowJson('ארוך', Array.from({ length: 70 }, (_, i) => F(`q${i}`, 'text', `שאלה ${i}`)));
    expect(b.problems).toContain('too_many_fields');
  });
});

describe('forms filled inside WhatsApp, end to end against a simulated Meta', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const SECRET = 'app-secret-0123456789abcdef';
  const TOKEN = 'EAAG' + 'y'.repeat(40);
  let db: ReturnType<typeof createDb>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let channelId = '';
  let templateId = '';
  let ip = 0;
  const cookies: Record<string, string> = {};
  const posts: { url: string; body: unknown }[] = [];
  let flowSeq = 0;
  let outSeq = 0;
  let createErrors: unknown[] = [];
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ? '[form]' : undefined;
    if (init?.method === 'POST' || init?.method === 'DELETE') posts.push({ url, body });
    if (init?.method === 'POST' && url.endsWith('/5550009999/flows')) return Response.json({ id: `77700011${++flowSeq}`, success: true, validation_errors: createErrors });
    if (/\/77700011\d\?fields=status/.test(url)) return Response.json({ status: createErrors.length ? 'DRAFT' : 'PUBLISHED', validation_errors: createErrors, preview: { preview_url: 'https://business.facebook.com/wa/manage/flows/1/preview/?token=abc' } });
    if (init?.method === 'POST' && url.endsWith('/1234567890/media')) return Response.json({ id: 'MEDIA1' });
    if (init?.method === 'POST' && url.endsWith('/1234567890/messages')) return Response.json({ messages: [{ id: `wamid.OUT${++outSeq}` }] });
    if (url.includes('/app?fields=id')) return Response.json({ id: '5550001112' });
    if (url.includes('/subscribed_apps')) return Response.json({ data: [{}], success: true });
    return Response.json({ display_phone_number: '+972 50-000-0000', verified_name: 'Unit', success: true });
  };
  const call = (who: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never, remoteAddress: `10.81.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  const hook = async (value: object) => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value }] }] });
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
    return app.inject({ method: 'POST', url: `/webhooks/whatsapp/${channelId}`, payload: raw, remoteAddress: '203.0.113.9', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
  };
  const now = () => String(Math.floor(Date.now() / 1000));
  const say = (from: string, id: string, text: string) => hook({ contacts: [{ wa_id: from, profile: { name: 'Dana Levi' } }], messages: [{ id, from, timestamp: now(), type: 'text', text: { body: text } }] });
  const reply = (from: string, id: string, response: object) => hook({ contacts: [{ wa_id: from }], messages: [{ id, from, timestamp: now(), type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify(response) } } }] });
  const convOf = async (phone: string) => (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [`${phone}@s.whatsapp.net`])).rows[0]?.id as string;

  beforeAll(async () => {
    const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'botwa-flows-'));
    const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true', MEDIA_DIR: mediaDir });
    db = createDb(cfg.DATABASE_URL);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    const media = new MediaService(db, cfg);
    await media.init();
    const mgr = new ChannelManager(db, cfg, (type, ctx) => (type === 'whatsapp_cloud' ? new WhatsAppCloudAdapter(ctx, fakeFetch) : createDefaultFactory(cfg)(type, ctx)), media);
    app = await buildApp(cfg, db, mgr, media);
    for (const [e, role] of [['adm@t.io', 'admin'], ['ag@t.io', 'agent']] as const) {
      await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3)`, [e, role, await hashPassword(PW)]);
      cookies[e] = `botwa_sid=${(await call(null, 'POST', '/auth/login', { email: e, password: PW })).cookies[0]!.value}`;
    }
    channelId = (await call('adm@t.io', 'POST', '/channels', { type: 'whatsapp_cloud', label: 'רשמי' })).json().id;
    expect((await call('adm@t.io', 'PUT', `/channels/${channelId}/cloud`, { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET, wabaId: '5550009999' })).json()).toMatchObject({ ok: true, status: 'connected' });
    const d = await PDFDocument.create(); d.addPage([595, 842]).drawText('Permit', { x: 50, y: 800, size: 14, font: await d.embedFont(StandardFonts.Helvetica) });
    const t = await createTemplate(db, { title: 'היתר עבודה', pdf: Buffer.from(await d.save()), sourceName: 'permit.pdf', userId: (await db.query(`SELECT id FROM users WHERE email = 'adm@t.io'`)).rows[0].id });
    templateId = t.id;
    const fields = [F('name', 'text', 'שם מלא של העובד המבצע את העבודה', { prefill: 'contact_name' }), F('when', 'date', 'תאריך העבודה'), F('ok', 'checkbox', 'קראתי והבנתי את נוהל העבודה בגובה'), F('sig', 'signature', 'חתימה', { y: 100 })];
    expect((await call('adm@t.io', 'PATCH', `/forms/templates/${templateId}`, { fields })).statusCode).toBe(200);
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('the editor shows short labels; publishing creates the Flow at Meta (managers only); sending needs it', async () => {
    const st = (await call('ag@t.io', 'GET', `/forms/templates/${templateId}/flow`)).json();
    expect(st.fields[0]).toMatchObject({ id: 'name', short: 'שם מלא של העובד' });
    expect(st.signature).toBe(true);
    expect(st.channels).toEqual([expect.objectContaining({ id: channelId, flow: null, ready: false, connected: true })]);
    expect((await call('ag@t.io', 'PUT', `/forms/templates/${templateId}/flow`, { enabled: true, labels: { name: 'שם העובד' } })).statusCode).toBe(403);
    expect((await call('adm@t.io', 'PUT', `/forms/templates/${templateId}/flow`, { enabled: true, labels: { name: 'שם העובד', when: 'x'.repeat(21) } })).statusCode).toBe(400);
    expect((await call('adm@t.io', 'PUT', `/forms/templates/${templateId}/flow`, { enabled: true, labels: { name: 'שם העובד' } })).statusCode).toBe(200);
    // the customer writes first (the 24-hour window), then the form cannot go out before the Flow is published
    await say('972501112233', 'wamid.IN1', 'שלום, צריך היתר');
    const conv = await convOf('972501112233');
    expect((await call('adm@t.io', 'POST', `/conversations/${conv}/forms`, { templateId, via: 'flow' })).json()).toEqual({ error: 'flow_not_published' });
    expect((await call('ag@t.io', 'POST', `/forms/templates/${templateId}/flow/publish`, { channelId })).statusCode).toBe(403);
    const pub = await call('adm@t.io', 'POST', `/forms/templates/${templateId}/flow/publish`, { channelId });
    expect(pub.json()).toMatchObject({ flowId: '777000111', status: 'PUBLISHED', errors: [] });
    const created = posts.find((p) => p.url.endsWith('/5550009999/flows'))!.body as { categories: string[]; publish: boolean; flow_json: string };
    expect(created).toMatchObject({ categories: ['OTHER'], publish: true });
    expect(JSON.parse(created.flow_json).screens[0].layout.children.find((c: { name?: string }) => c.name === 'f0').label).toBe('שם העובד');
  });

  it('sent from the conversation: a Flow message with the token and the prefilled name; the answers become the locked PDF', async () => {
    const conv = await convOf('972501112233');
    posts.length = 0;
    const r = await call('ag@t.io', 'POST', `/conversations/${conv}/forms`, { templateId, via: 'flow', note: 'לפני העבודה מחר' });
    expect(r.statusCode).toBe(201);
    const msg = posts.find((p) => p.url.endsWith('/1234567890/messages'))!.body as { to: string; interactive: { type: string; body: { text: string }; action: { name: string; parameters: { flow_id: string; flow_token: string; flow_cta: string; flow_action_payload: { screen: string; data: Record<string, string> } } } } };
    expect(msg.to).toBe('972501112233');
    expect(msg.interactive).toMatchObject({ type: 'flow', action: { name: 'flow', parameters: { flow_id: '777000111', flow_cta: 'מילוי הטופס', flow_action_payload: { screen: 'S1', data: { p_f0: 'Dana Levi' } } } } });
    expect(msg.interactive.body.text).toContain('לפני העבודה מחר');
    const token = msg.interactive.action.parameters.flow_token;
    expect(token).toMatch(/^f_[\w-]{20,}$/);
    expect((await db.query(`SELECT via, status FROM form_requests WHERE id = $1`, [r.json().id])).rows[0]).toEqual({ via: 'flow', status: 'sent' });
    // the customer fills it in WhatsApp
    posts.length = 0;
    await reply('972501112233', 'wamid.IN2', { flow_token: token, f0: 'דנה לוי', f1: '2026-11-20', f2: true, consent: true, signer_name: 'דנה לוי' });
    const req = (await db.query(`SELECT r.status, r.signer_name, s.sha256 FROM form_requests r LEFT JOIN form_submissions s ON s.request_id = r.id WHERE r.id = $1`, [r.json().id])).rows[0];
    expect(req).toMatchObject({ status: 'signed', signer_name: 'דנה לוי' });
    expect(req.sha256).toMatch(/^[0-9a-f]{64}$/);
    await new Promise((res) => setTimeout(res, 50));
    expect(posts.some((p) => p.url.endsWith('/1234567890/media'))).toBe(true);                    // the signed copy back to the chat
    const notes = (await db.query(`SELECT body FROM conversation_notes WHERE conversation_id = $1`, [conv])).rows.map((x) => x.body);
    expect(notes.join('\n')).toContain('מולא ונחתם בתוך ווצאפ');
    // the chat shows a short line, never the answers
    expect((await db.query(`SELECT body FROM messages WHERE external_id = 'wamid.IN2'`)).rows[0].body).toBe('📝 הטופס מולא ונשלח בווצאפ.');
    // the PDF's record page names the way it was signed
    const pdf = await call('adm@t.io', 'GET', `/forms/requests/${r.json().id}/signed.pdf`);
    expect(pdf.statusCode).toBe(200);
    // sent twice: nothing new, a short answer
    posts.length = 0;
    await reply('972501112233', 'wamid.IN3', { flow_token: token, f0: 'אחר', consent: true, signer_name: 'אחר' });
    expect((await db.query(`SELECT count(*)::int AS n FROM form_submissions WHERE request_id = $1`, [r.json().id])).rows[0].n).toBe(1);
    expect(JSON.stringify(posts)).toContain('כבר נחתם');
  });

  it('refuses a token from another chat, a missing statement or name, and invalid values (and says what to fix)', async () => {
    const conv = await convOf('972501112233');
    const r = (await call('ag@t.io', 'POST', `/conversations/${conv}/forms`, { templateId, via: 'flow' })).json();
    expect(r, JSON.stringify(r)).toHaveProperty('id');
    const token = (posts.filter((p) => p.url.endsWith('/1234567890/messages')).pop()!.body as { interactive: { action: { parameters: { flow_token: string } } } }).interactive.action.parameters.flow_token;
    // the same token from someone else
    await say('972509998888', 'wamid.X1', 'היי');
    await reply('972509998888', 'wamid.X2', { flow_token: token, f0: 'זר', f1: '2026-11-20', f2: true, consent: true, signer_name: 'זר' });
    expect((await db.query(`SELECT status FROM form_requests WHERE id = $1`, [r.id])).rows[0].status).toBe('sent');
    expect((await db.query(`SELECT body FROM conversation_notes WHERE conversation_id = $1`, [await convOf('972509998888')])).rows[0].body).toContain('אינה שייכת');
    // no statement
    posts.length = 0;
    await reply('972501112233', 'wamid.X3', { flow_token: token, f0: 'דנה', f1: '2026-11-20', f2: true, consent: false, signer_name: 'דנה לוי' });
    expect(JSON.stringify(posts)).toContain('לא התקבל אישור ההצהרה');
    // a bad date
    posts.length = 0;
    await reply('972501112233', 'wamid.X4', { flow_token: token, f0: 'דנה', f1: 'מחר', f2: true, consent: true, signer_name: 'דנה לוי' });
    expect(JSON.stringify(posts)).toContain('תאריך העבודה');
    expect((await db.query(`SELECT status FROM form_requests WHERE id = $1`, [r.id])).rows[0].status).toBe('sent');
  });

  it('a changed template needs a new Flow; the old published one keeps serving, a failed draft is removed; Meta validation errors are shown; the switch turns it off', async () => {
    const conv = await convOf('972501112233');
    await call('adm@t.io', 'PUT', `/forms/templates/${templateId}/flow`, { enabled: true, labels: { name: 'שם' } });
    expect((await call('adm@t.io', 'GET', `/forms/templates/${templateId}/flow`)).json().channels[0]).toMatchObject({ upToDate: false, ready: false });
    expect((await call('adm@t.io', 'POST', `/conversations/${conv}/forms`, { templateId, via: 'flow' })).json()).toEqual({ error: 'flow_outdated' });
    createErrors = [{ message: "Invalid value found for property 'type'.", pointers: [{ path: 'screens[0]' }] }];
    posts.length = 0;
    const p = (await call('adm@t.io', 'POST', `/forms/templates/${templateId}/flow/publish`, { channelId })).json();
    expect(p).toMatchObject({ status: 'DRAFT', errors: ["Invalid value found for property 'type'. (screens[0])"] });
    expect(posts.some((x) => x.url.includes('/777000111/deprecate'))).toBe(false);               // the published one keeps serving sent requests
    // a failed draft is removed when the next one is made
    createErrors = [];
    posts.length = 0;
    expect((await call('adm@t.io', 'POST', `/forms/templates/${templateId}/flow/publish`, { channelId })).json()).toMatchObject({ status: 'PUBLISHED' });
    expect(posts.some((x) => x.url.endsWith('/777000112') )).toBe(true);
    await call('adm@t.io', 'PUT', `/forms/templates/${templateId}/flow`, { enabled: true, labels: { name: 'שם מלא' } });
    createErrors = [{ message: "Invalid value found for property 'type'.", pointers: [{ path: 'screens[0]' }] }];
    expect((await call('adm@t.io', 'POST', `/forms/templates/${templateId}/flow/publish`, { channelId })).json()).toMatchObject({ status: 'DRAFT' });
    expect((await call('adm@t.io', 'POST', `/conversations/${conv}/forms`, { templateId, via: 'flow' })).json()).toMatchObject({ error: 'flow_not_published' });
    await call('adm@t.io', 'PUT', `/forms/templates/${templateId}/flow`, { enabled: false, labels: {} });
    expect((await call('adm@t.io', 'POST', `/conversations/${conv}/forms`, { templateId, via: 'flow' })).json()).toEqual({ error: 'flow_disabled' });
    // the link is still there
    expect((await call('adm@t.io', 'POST', `/conversations/${conv}/forms`, { templateId })).statusCode).toBe(201);
  });
});
