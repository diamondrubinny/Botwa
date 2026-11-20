import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATIONS } from '../src/automations.js';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT } from '../src/bot.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { emergencyLine } from '../src/routes/places.js';
import { extractPlaceCode, newPlaceCode, PLACE_CODE, placeText } from '../src/safety/places.js';

describe('QR place codes', () => {
  it('codes are 6 easy-to-read characters', () => {
    for (let i = 0; i < 200; i++) expect(newPlaceCode()).toMatch(PLACE_CODE);
    expect('K7M2Q0').not.toMatch(PLACE_CODE);   // no zero / O
  });
  it('finds the code in the WhatsApp text the sticker prefills, or typed by hand', () => {
    expect(extractPlaceCode('שלום 👋 (📍K7M2QX)')).toEqual({ code: 'K7M2QX', rest: 'שלום 👋' });
    expect(extractPlaceCode('יש נזילה, קוד מיקום: K7M2QX')).toEqual({ code: 'K7M2QX', rest: 'יש נזילה,' });
    expect(extractPlaceCode('(📍K7M2QX)')).toEqual({ code: 'K7M2QX', rest: '' });
    expect(extractPlaceCode('החדר שלי K7M2QX')).toBeNull();        // a bare code is not taken
    expect(extractPlaceCode('📍K7M2Q0')).toBeNull();
  });
  it('the scan page keeps the emergency numbers, not the "passed on" sentence', () => {
    expect(emergencyLine('🚨 אם יש סכנת חיים: התקשרו מיד למד"א 101. העברתי את הפנייה בדחיפות לצוות היחידה.')).toBe('🚨 אם יש סכנת חיים: התקשרו מיד למד"א 101.');
  });
  it('reads as label, building and room', () => {
    expect(placeText({ label: 'מעבדה לכימיה', building: '12', room: '214' })).toBe('מעבדה לכימיה, בניין 12, חדר 214');
    expect(placeText({ label: '', building: 'שרמן', room: '' })).toBe('בניין שרמן');
  });
});

describe('QR stickers live: management, landing page, the bot knows the place', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false',
  });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let ctxA: AdapterContext;
  const sent: string[] = [];
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ip = 0, outSeq = 0, mid = 0;
  class Fake implements ChannelAdapter {
    constructor(c: AdapterContext) { ctxA = c; }
    async start() { ctxA.events.onStatus('connected'); }
    async stop() {}
    async logout() {}
    async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `pl${++outSeq}` }; }
  }
  const factory: AdapterFactory = (ty, c) => (ty === 'whatsapp' ? new Fake(c) : null);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, who?: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.71.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  const say = async (who: string, text: string, media = false) => {
    sent.length = 0;
    await ctxA.events.onMessage({ externalContactId: who, externalMessageId: `pm${++mid}`, text, timestamp: new Date(), media: media ? { fileName: 'p.png', download: async () => Buffer.alloc(0) } : undefined });
    return [...sent];
  };
  const conv = async (who: string) => (await db.query(`SELECT c.id, c.assigned_to, c.place_id, ct.profile FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [who])).rows[0];
  let code = '', placeId = '';

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await db.query(`INSERT INTO settings (key, value) VALUES ('automations', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ...DEFAULT_AUTOMATIONS, introduce: { ...DEFAULT_AUTOMATIONS.introduce, enabled: false } })]);
    mgr = new ChannelManager(db, cfg, factory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['o1', 'agent']] as const) {
      ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
      cookies[e] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW })).cookies[0]!.value}`;
    }
    const ch = (await call('POST', '/channels', 'admin', { type: 'whatsapp', label: 'WA' })).json().id;
    await call('POST', `/channels/${ch}/start`, 'admin');
    await new Promise((r) => setTimeout(r, 40));
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('bot managers create, edit and switch off places; others only see them; changes are audited', async () => {
    expect((await call('POST', '/places', 'sup', { building: '12', room: '214', label: 'מעבדה לכימיה' })).statusCode).toBe(403);
    expect((await call('POST', '/places', 'admin', {})).statusCode).toBe(400);
    expect((await call('POST', '/places', 'admin', { building: '12', room: '214', label: 'מעבדה לכימיה', extra: 1 })).statusCode).toBe(400);
    const r = await call('POST', '/places', 'admin', { building: '12', room: '214', label: 'מעבדה לכימיה' });
    expect(r.statusCode).toBe(201);
    ({ code, id: placeId } = r.json());
    expect(code).toMatch(PLACE_CODE);
    expect((await call('GET', '/places', 'sup')).json().places).toHaveLength(1);
    expect((await call('PATCH', `/places/${placeId}`, 'admin', { label: 'מעבדה לכימיה אורגנית' })).json().label).toBe('מעבדה לכימיה אורגנית');
    expect((await call('PUT', '/places/targets', 'admin', { whatsappNumber: '+972-50-000-0000', webchatKey: '' })).json()).toEqual({ whatsappNumber: '972500000000', webchatKey: '' });
    expect((await call('PUT', '/places/targets', 'admin', { whatsappNumber: 'abc', webchatKey: '' })).statusCode).toBe(400);
    expect((await call('PUT', '/places/targets', 'admin', { whatsappNumber: '', webchatKey: 'wc_doesnotexist12' })).json()).toEqual({ error: 'unknown_site' });
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'places.%'`)).rows[0].n).toBe(3);
  });

  it('the scan page: where you are, the WhatsApp link with the code, counted; nothing for an unknown or inactive code', async () => {
    const page = await app.inject({ method: 'GET', url: `/q/${code}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain('מעבדה לכימיה אורגנית, בניין 12, חדר 214');
    expect(page.body).toContain(`https://wa.me/972500000000?text=${encodeURIComponent(`שלום 👋 (📍${code})`)}`);
    expect(page.body).not.toContain('<script');
    expect(page.body).toContain('101');                                      // the emergency numbers
    expect(page.body).not.toContain('העברתי');                               // not "I passed it on": nothing was sent yet
    expect((await db.query(`SELECT scans FROM qr_places WHERE id = $1`, [placeId])).rows[0].scans).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/q/AAAAAA' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/q/<script>' })).body).not.toContain('<script>');
  });

  it('a hazard reported from the sticker: place questions skipped, routed by building, not kept on the person\'s card', async () => {
    await call('POST', '/safety/areas', 'admin', { name: 'בניין 12', keywords: ['בניין 12'], userId: ids.o1 });
    const tpl = (await call('POST', '/flow/templates/safety', 'admin')).json();
    const f = JSON.parse(JSON.stringify(tpl.flow)) as { nodes: { id: string; userId?: string }[] };
    f.nodes.find((n) => n.id === 'chem_ho')!.userId = ids.o1;
    expect((await call('PUT', '/flow', 'admin', { flow: f })).statusCode).toBe(200);
    expect((await call('PUT', '/flow/mode', 'admin', { mode: 'flow' })).statusCode).toBe(200);
    await call('PUT', '/settings/bot', 'admin', { ...DEFAULT_BOT, enabled: true, mode: 'flow' });
    const first = await say('qr1', `שלום 👋 (📍${code})`);
    expect(first.join(' ')).toContain('שם מלא');
    const c0 = await conv('qr1');
    expect(c0.place_id).toBe(placeId);
    expect((await db.query(`SELECT body FROM conversation_notes WHERE conversation_id = $1`, [c0.id])).rows.map((r) => r.body).join(' ')).toContain(`📍 הפנייה נפתחה ממדבקת QR: מעבדה לכימיה אורגנית, בניין 12, חדר 214 (קוד ${code})`);
    // building and room are not asked: straight to the faculty
    expect((await say('qr1', 'דנה לוי')).join(' ')).toContain('פקולטה');
    await say('qr1', 'כימיה');
    await say('qr1', 'דלג');
    await say('qr1', '1');                                                   // status
    expect(await say('qr1', '6')).toEqual(['שלחו תמונה של המפגע או תארו אותו בכתב:']);
    // the exact place is not asked either: the report is complete
    expect(await say('qr1', 'המנדף לא שואב')).toEqual(['הפנייה התקבלה והועברה לטיפול. נחזור אליך בהקדם.']);
    const c1 = await conv('qr1');
    expect(c1.assigned_to).toBe(ids.o1);                                    // the officer of building 12
    expect(c1.profile.fullName).toBe('דנה לוי');
    expect(c1.profile.building).toBeUndefined();                            // the sticker's place is not the person's
    const note = (await db.query(`SELECT body FROM conversation_notes WHERE conversation_id = $1 AND body LIKE 'פרטים שנאספו%'`, [c1.id])).rows[0].body as string;
    expect(note).toContain('מעבדה לכימיה אורגנית, בניין 12, חדר 214');
  });

  it('an inactive sticker is ignored', async () => {
    await call('PATCH', `/places/${placeId}`, 'admin', { active: false });
    expect((await app.inject({ method: 'GET', url: `/q/${code}` })).statusCode).toBe(404);
    const hi = await say('qr2', `שלום 👋 (📍${code})`);
    expect((await conv('qr2')).place_id).toBeNull();
    expect(hi.join(' ')).toContain('שם מלא');                               // still read as a greeting: the flow opens as usual
    expect((await call('DELETE', `/places/${placeId}`, 'admin')).statusCode).toBe(200);
  });
});
