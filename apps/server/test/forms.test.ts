import { randomBytes } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter, OutboundMedia } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { forPdf, visualOrder } from '../src/forms/bidi.js';
import { validIsraeliId } from '../src/forms/schema.js';
import { sha256 } from '../src/forms/service.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('forms helpers', () => {
  it('Israeli ID check digit', () => {
    for (const ok of ['000000018', '123456782', '39337423']) expect(validIsraeliId(ok), ok).toBe(true);
    for (const bad of ['123456789', '', 'abc', '1234567890', '000000000']) expect(validIsraeliId(bad), bad).toBe(false);
  });
  it('Hebrew with numbers and Latin words keeps a readable visual order', () => {
    expect(visualOrder('abc 123')).toBe('abc 123');
    expect(visualOrder('חדר 214')).toBe('214 רדח');
    expect(visualOrder('אלקטרו-טק Ltd בע"מ')).toBe('מ"עב Ltd קט-ורטקלא');
    expect(visualOrder('(6 מ׳)')).toBe('(׳מ 6)');
    expect(forPdf('abc')).toBe('abc');
  });
});

/** A small real PNG (a diagonal line), as a signature pad would send. */
function png(): Buffer {
  const w = 300, h = 120, raw = Buffer.alloc((w * 4 + 1) * h, 255);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let k = 0; k < 6; k++) { const x = (y * 2 + k * 37 + ((y * 7919) % 13)) % w; const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = 10; raw[o + 1] = 20; raw[o + 2] = 90; } }
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function samplePdf(): Promise<Buffer> {
  const d = await PDFDocument.create(); const p = d.addPage([595, 842]); const f = await d.embedFont(StandardFonts.Helvetica);
  p.drawText('Work permit for contractors', { x: 150, y: 780, size: 16, font: f });
  p.drawText('Name:', { x: 480, y: 700, size: 11, font: f });
  p.drawText('Date:', { x: 480, y: 670, size: 11, font: f });
  p.drawText('Signature:', { x: 470, y: 600, size: 11, font: f });
  return Buffer.from(await d.save());
}

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let ctxA: AdapterContext;
const texts: string[] = [];
const files: OutboundMedia[] = [];
let seq = 0;
class Fake implements ChannelAdapter {
  constructor(c: AdapterContext) { ctxA = c; }
  async start() { ctxA.events.onStatus('connected'); }
  async stop() {} async logout() {}
  async sendText(_t: string, text: string) { texts.push(text); return { externalMessageId: `t${++seq}` }; }
  async sendMedia(_t: string, m: OutboundMedia) { files.push(m); return { externalMessageId: `m${++seq}` }; }
}
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let ip = 0;
const call = (who: string | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as never, remoteAddress: `10.79.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}), ...headers } });
const multipart = (buf: Buffer, fields: Record<string, string>, name = 'permit.pdf') => {
  const b = '----f'; const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  return { body: Buffer.concat([...parts, Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
};

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, ((_t, c) => new Fake(c)) as AdapterFactory);
  app = await buildApp(cfg, db, mgr);
  for (const [e, role] of [['admin@t.io', 'admin'], ['ag@t.io', 'agent'], ['ag2@t.io', 'agent']] as const) {
    ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [e, e, role, await hashPassword(PW)])).rows[0].id;
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: e, password: PW }, remoteAddress: `10.79.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
  const ch = (await call('admin@t.io', 'POST', '/channels', { type: 'whatsapp', label: 'WA' })).json().id;
  await call('admin@t.io', 'POST', `/channels/${ch}/start`);
  await new Promise((r) => setTimeout(r, 40));
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('digital forms end to end', () => {
  let tpl: { id: string; fields: { id: string; type: string; label: string }[] };
  let conv = '';
  let token = '';

  it('a forms manager uploads a PDF: checked by content, pages read, fields suggested from its labels', async () => {
    const m = multipart(await samplePdf(), { title: 'הרשאת עבודה לקבלן', audience: 'contractor' });
    expect((await call('ag@t.io', 'POST', '/forms/templates', m.body, m.headers)).statusCode).toBe(403);
    const r = await call('admin@t.io', 'POST', '/forms/templates', m.body, m.headers);
    expect(r.statusCode).toBe(201);
    tpl = r.json();
    expect(tpl.fields.map((f) => f.type).sort()).toEqual(['date', 'signature', 'text']);
    const fake = multipart(Buffer.from('<html>not a pdf</html>'), { title: 'x' }, 'x.pdf');
    expect((await call('admin@t.io', 'POST', '/forms/templates', fake.body, fake.headers)).json().error).toBe('pdf_only');
    // the editor saves the fields (prefill the name, add an ID field)
    const fields = (tpl.fields as Record<string, unknown>[]).map((f) => (f.type === 'text' ? { ...f, label: 'שם מלא', prefill: 'contact_name' } : f));
    fields.push({ id: 'idn', type: 'id_number', label: 'תעודת זהות', page: 0, x: 300, y: 640, w: 150, h: 16, required: true, prefill: null, locked: false, hint: '' });
    const p = await call('admin@t.io', 'PATCH', `/forms/templates/${tpl.id}`, { fields });
    expect(p.statusCode).toBe(200);
    expect((await call('admin@t.io', 'PATCH', `/forms/templates/${tpl.id}`, { fields: [{ ...fields[0], page: 9 }] })).statusCode).toBe(400);
    tpl = p.json();
  });

  it('an agent sends it from a conversation: a personal link goes to the chat; another agent cannot see it', async () => {
    await ctxA.events.onMessage({ externalContactId: '972500000301', contactName: 'יוסי כהן', externalMessageId: 'in1', text: 'שלום', timestamp: new Date() });
    conv = (await db.query('SELECT id FROM conversations')).rows[0].id;
    await db.query('UPDATE conversations SET assigned_to = $2 WHERE id = $1', [conv, ids['ag@t.io']]);
    texts.length = 0;
    const r = await call('ag@t.io', 'POST', `/conversations/${conv}/forms`, { templateId: tpl.id, days: 3 });
    expect(r.statusCode).toBe(201);
    const link = texts[0]!.match(/https:\/\/panel\.test\/f\/(f_[\w-]+)/);
    expect(link).toBeTruthy();
    token = link![1]!;
    expect(texts[0]).toContain('הרשאת עבודה לקבלן');
    expect((await call('ag@t.io', 'GET', `/conversations/${conv}/forms`)).json()[0]).toMatchObject({ status: 'sent', title: 'הרשאת עבודה לקבלן' });
    expect((await call('ag2@t.io', 'GET', `/forms/requests/${r.json().id}`)).statusCode).toBe(404);
    expect((await call('ag2@t.io', 'GET', '/forms/requests')).json()).toEqual([]);
  });

  it('the signer: sees the form, verifies with a code sent to the chat (never stored readable), and signs', async () => {
    expect((await call(null, 'GET', '/f/f_not-a-real-token-1234567890')).statusCode).toBe(200);          // the page itself, the API refuses
    expect((await call(null, 'GET', '/f/f_not-a-real-token-1234567890/info')).statusCode).toBe(404);
    const info = (await call(null, 'GET', `/f/${token}/info`)).json();
    expect(info).toMatchObject({ title: 'הרשאת עבודה לקבלן', status: 'opened', phoneHint: '•••••••••301' });
    expect(info.prefill[(tpl.fields.find((f) => f.type === 'text'))!.id]).toBe('יוסי כהן');
    expect(JSON.stringify(info)).not.toMatch(/"x":|token_hash|otp/);
    expect((await call(null, 'GET', `/f/${token}/document.pdf`)).headers['content-type']).toBe('application/pdf');
    // submitting before verifying is refused
    expect((await call(null, 'POST', `/f/${token}/submit`, { key: 'x', consent: true, values: {} })).statusCode).toBe(401);
    texts.length = 0;
    expect((await call(null, 'POST', `/f/${token}/otp`)).statusCode).toBe(200);
    const code = texts[0]!.match(/(\d{6})/)![1]!;
    expect((await call(null, 'POST', `/f/${token}/otp`)).json().error).toBe('too_soon');
    const stored = (await db.query(`SELECT body FROM messages WHERE automation = 'form_otp'`)).rows.map((r) => r.body).join(' ');
    expect(stored).not.toContain(code);                                                                // not kept readable (not a website chat)
    const inbox = JSON.stringify((await call('ag@t.io', 'GET', `/conversations/${conv}/messages`)).json());
    expect(inbox).toContain('הקוד מוסתר');                                                             // staff never see the code
    expect(inbox).not.toContain(code);
    expect((await call(null, 'POST', `/f/${token}/verify`, { code: '000000' === code ? '111111' : '000000' })).json().error).toBe('otp_wrong');
    const v = await call(null, 'POST', `/f/${token}/verify`, { code });
    expect(v.statusCode).toBe(200);
    const key = v.json().key as string;
    const f = (t: string) => tpl.fields.find((x) => x.type === t)!.id;
    // a wrong ID and a missing signature come back per field
    const bad = await call(null, 'POST', `/f/${token}/submit`, { key, consent: true, values: { [f('text')]: 'יוסי כהן', [f('date')]: '2026-11-15', idn: '123456789' }, marks: {} });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().fields).toMatchObject({ idn: 'id_number', [f('signature')]: 'required' });
    files.length = 0;
    const ok = await call(null, 'POST', `/f/${token}/submit`, { key, consent: true, values: { [f('text')]: 'יוסי כהן', [f('date')]: '2026-11-15', idn: '000000018' }, marks: { [f('signature')]: { png: `data:image/png;base64,${png().toString('base64')}` } } });
    expect(ok.statusCode).toBe(200);
    const hash = ok.json().sha256 as string;
    // the signer downloads their copy right away; a second submit is refused
    const dl = await call(null, 'POST', `/f/${token}/signed.pdf`);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(sha256(dl.rawPayload)).toBe(hash);
    expect((await call(null, 'POST', `/f/${token}/submit`, { key, consent: true, values: {} })).statusCode).toBe(409);
    expect((await call(null, 'GET', `/f/${token}/info`)).json().status).toBe('signed');
    // a copy went back to the chat, and the team got a note
    await new Promise((r) => setTimeout(r, 100));
    expect(files[0]).toMatchObject({ mime: 'application/pdf' });
    expect(sha256(files[0]!.buffer)).toBe(hash);
    expect((await db.query(`SELECT body FROM conversation_notes WHERE conversation_id = $1`, [conv])).rows.map((r) => r.body).join(' ')).toContain('נחתם');
  });

  it('staff download the stored copy (encrypted at rest), see the values and the trail, and can check a file', async () => {
    const list = (await call('ag@t.io', 'GET', '/forms/requests')).json();
    expect(list[0]).toMatchObject({ status: 'signed', signerName: 'יוסי כהן' });
    const id = list[0].id;
    const raw = (await db.query('SELECT signed_pdf, values_enc FROM form_submissions')).rows[0];
    expect(raw.signed_pdf.subarray(0, 4).toString()).not.toBe('%PDF');                                  // not readable in the database
    expect(raw.values_enc).not.toContain('יוסי');
    const pdf = await call('ag@t.io', 'GET', `/forms/requests/${id}/signed.pdf`);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const d = await PDFDocument.load(pdf.rawPayload);
    expect(d.getPageCount()).toBe(2);                                                                   // the form + the signature record page
    const det = (await call('ag@t.io', 'GET', `/forms/requests/${id}`)).json();
    expect(det.values.idn).toBe('000000018');
    expect(det.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['sent', 'opened', 'otp_sent', 'otp_wrong', 'verified', 'signed']));
    const m = multipart(pdf.rawPayload, {}, 'copy.pdf');
    expect((await call('ag@t.io', 'POST', '/forms/verify', m.body, m.headers)).json()).toMatchObject({ match: true, title: 'הרשאת עבודה לקבלן' });
    const t = multipart(Buffer.concat([pdf.rawPayload, Buffer.from(' ')]), {}, 'copy.pdf');
    expect((await call('ag@t.io', 'POST', '/forms/verify', t.body, t.headers)).json().match).toBe(false);
    expect((await call('ag2@t.io', 'GET', `/forms/requests/${id}/signed.pdf`)).statusCode).toBe(404);
    expect((await call('admin@t.io', 'DELETE', `/forms/templates/${tpl.id}`)).json().error).toBe('template_in_use');
  });

  it('expired and cancelled links stop working', async () => {
    texts.length = 0;
    const a = (await call('ag@t.io', 'POST', `/conversations/${conv}/forms`, { templateId: tpl.id, days: 1 })).json();
    const tok = texts[0]!.match(/\/f\/(f_[\w-]+)/)![1]!;
    expect((await call('ag@t.io', 'POST', `/forms/requests/${a.id}/cancel`)).statusCode).toBe(200);
    expect((await call(null, 'GET', `/f/${tok}/info`)).json().status).toBe('cancelled');
    expect((await call(null, 'POST', `/f/${tok}/otp`)).statusCode).toBe(409);
    texts.length = 0;
    const b = (await call('ag@t.io', 'POST', `/conversations/${conv}/forms`, { templateId: tpl.id, days: 1 })).json();
    const tok2 = texts[0]!.match(/\/f\/(f_[\w-]+)/)![1]!;
    await db.query(`UPDATE form_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [b.id]);
    expect((await call(null, 'GET', `/f/${tok2}/info`)).json().status).toBe('expired');
  });
});

describe('Word forms through the converter', () => {
  it('without the converter a Word file is refused with a clear reason; with it, it becomes a template', async () => {
    const JSZip = (await import('jszip')).default;
    const z = new JSZip();
    z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    z.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Name:</w:t></w:r></w:p></w:body></w:document>');
    const docx = await z.generateAsync({ type: 'nodebuffer' });
    const m = multipart(docx, { title: 'טופס וורד' }, 'form.docx');
    expect((await call('admin@t.io', 'POST', '/forms/templates', m.body, m.headers)).json().error).toBe('word_needs_converter');
    expect((await call('admin@t.io', 'GET', '/forms/converter')).json()).toEqual({ word: false, installed: false });

    // a stand-in for apps/office-converter: answers /convert with a PDF
    const { createServer } = await import('node:http');
    const pdf = await samplePdf();
    let got = 0;
    const srv = createServer((req, res) => {
      if (req.url === '/health') { res.end('ok'); return; }
      const parts: Buffer[] = []; req.on('data', (c: Buffer) => parts.push(c)); req.on('end', () => { got = Buffer.concat(parts).length; res.setHeader('content-type', 'application/pdf'); res.end(pdf); });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const cfg2 = loadConfig({ NODE_ENV: 'test', DATABASE_URL: cfg.DATABASE_URL, ENCRYPTION_KEY: cfg.ENCRYPTION_KEY, APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true', OFFICE_CONVERTER_URL: `http://127.0.0.1:${port}` });
    const app2 = await buildApp(cfg2, db, mgr);
    try {
      const r = await app2.inject({ method: 'POST', url: '/forms/templates', payload: m.body, headers: { ...m.headers, origin: ORIGIN, cookie: cookies['admin@t.io']! }, remoteAddress: '10.79.200.1' });
      expect(r.statusCode).toBe(201);
      expect(got).toBe(docx.length);                                                                  // the Word file went to the converter
      expect(r.json()).toMatchObject({ title: 'טופס וורד', sourceName: 'form.pdf' });
      expect(r.json().fields.length).toBe(3);                                                         // fields suggested from the converted PDF
      expect((await app2.inject({ url: '/forms/converter', headers: { cookie: cookies['admin@t.io']! } })).json()).toEqual({ word: true, installed: true });
    } finally { await app2.close(); srv.close(); }
  });
});

describe('one form to a group', () => {
  it('within the reply window the link is sent; otherwise it is kept for the staff to pass on; reminders once a day', async () => {
    const tpl = (await call('admin@t.io', 'GET', '/forms/templates')).json().find((t: { title: string }) => t.title === 'הרשאת עבודה לקבלן');
    const ch = (await db.query(`SELECT id FROM channels WHERE type = 'whatsapp' LIMIT 1`)).rows[0].id;
    texts.length = 0;
    const body = { channelId: ch, days: 7, people: [{ name: 'יוסי כהן', phone: '+972 50-000-0301' }, { name: 'קבלן חדש', phone: '052-111-1111' }, { name: 'שגוי', phone: 'abc123' }] };
    expect((await call('ag@t.io', 'POST', `/forms/templates/${tpl.id}/batch`, body)).statusCode).toBe(403);
    const r = await call('admin@t.io', 'POST', `/forms/templates/${tpl.id}/batch`, body);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ total: 2, invalid: [{ row: 3, value: 'abc123' }] });
    const id = r.json().batchId;
    for (let i = 0; i < 50 && !(await db.query('SELECT done FROM form_batches WHERE id = $1', [id])).rows[0].done; i++) await new Promise((x) => setTimeout(x, 50));
    const rows = (await call('admin@t.io', 'GET', `/forms/batches/${id}`)).json() as { signerPhone: string; delivery: string; deliveryDetail: string | null; link: string | null }[];
    const yossi = rows.find((x) => x.signerPhone === '972500000301')!, newbie = rows.find((x) => x.signerPhone === '972521111111')!;
    expect(yossi.delivery).toBe('sent');                                         // wrote to us recently: a plain message
    expect(newbie).toMatchObject({ delivery: 'link_only', deliveryDetail: 'outside_reply_window' });   // never wrote: not messaged out of the blue
    expect(newbie.link).toMatch(/^https:\/\/panel\.test\/f\/f_/);               // the link is there to pass on
    expect(texts.filter((t) => t.includes('הרשאת עבודה לקבלן'))).toHaveLength(1);
    const list = (await call('admin@t.io', 'GET', '/forms/batches')).json();
    expect(list[0]).toMatchObject({ total: 2, delivered: 1, linkOnly: 1, signed: 0, done: true });
    // the new person's conversation stays out of the open inbox until they answer
    expect((await db.query(`SELECT c.status FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = '972521111111@s.whatsapp.net'`)).rows[0].status).toBe('closed');
    texts.length = 0;
    expect((await call('admin@t.io', 'POST', `/forms/batches/${id}/remind`)).json()).toEqual({ reminded: 1, skipped: 0, bySms: 0, smsFailed: 0 });
    expect(texts[0]).toContain('תזכורת');
    expect((await call('admin@t.io', 'POST', `/forms/batches/${id}/remind`)).json()).toEqual({ reminded: 0, skipped: 0, bySms: 0, smsFailed: 0 });   // not twice a day
    expect((await call('admin@t.io', 'GET', `/forms/requests?batchId=${id}`)).json()).toHaveLength(2);
    // a channel that cannot be addressed by phone is refused
    const tg = (await call('admin@t.io', 'POST', '/channels', { type: 'webchat', label: 'אתר' })).json().id;
    expect((await call('admin@t.io', 'POST', `/forms/templates/${tpl.id}/batch`, { ...body, channelId: tg })).json().error).toBe('channel_type_unsupported');
  });
});
