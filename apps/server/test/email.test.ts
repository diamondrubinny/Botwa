import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { EmailAdapter, isAutomatic, mailError, stripQuoted, type MailBox, type MailFactory, type MailSender } from '../src/channels/email.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AuthStore, ChannelStatus, InboundMessage } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const raw = (h: Record<string, string>, body: string) => Buffer.from(`${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`);
const mail = (n: number, extra: Record<string, string> = {}, body = 'שלום, יש לי שאלה') => raw({ From: '"Dana Levi" <Dana@Example.com>', To: 'support@shop.test', Subject: 'בעיה בהזמנה', 'Message-ID': `<m${n}@example.com>`, Date: new Date().toUTCString(), ...extra }, body);

class FakeBox implements MailBox {
  uidValidity = '1';
  uidNext = 5;
  msgs: { uid: number; source: Buffer }[] = [];
  seen: number[] = [];
  private onNewCb: (() => void) | null = null;
  async open() { return { uidValidity: this.uidValidity, uidNext: this.uidNext }; }
  async fetchAfter(after: number, max: number) { return this.msgs.filter((m) => m.uid > after).map((m) => ({ uid: m.uid, source: m.source.length > max ? null : m.source })); }
  async markSeen(uids: number[]) { this.seen.push(...uids); }
  onNew(cb: () => void) { this.onNewCb = cb; }
  onClose() {}
  async close() {}
  deliver(source: Buffer) { const uid = this.uidNext++; this.msgs.push({ uid, source }); this.onNewCb?.(); return uid; }
}
class FakeSender implements MailSender {
  sent: Parameters<MailSender['send']>[0][] = [];
  fail: Error | null = null;
  async verify() { if (this.fail) throw this.fail; }
  async send(m: Parameters<MailSender['send']>[0]) { this.sent.push(m); return { messageId: `<out${this.sent.length}@shop.test>` }; }
}
const memStore = (): AuthStore => { const m = new Map<string, string>(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, clear: async () => m.clear() }; };
const CREDS = { imapHost: 'mail.shop.test', imapPort: 993, smtpHost: 'mail.shop.test', smtpPort: 465, username: 'support@shop.test', password: 'secret-pass', fromAddress: 'support@shop.test', fromName: 'שירות לקוחות', mailbox: 'INBOX' };

describe('mail helpers', () => {
  it('keeps only the new part of a reply (English and Hebrew clients, quotes, signatures)', () => {
    expect(stripQuoted('Thanks, that worked!\n\nOn Tue, 10 Nov 2026 at 10:00, Support <support@shop.test> wrote:\n> old text\n> more')).toBe('Thanks, that worked!');
    expect(stripQuoted('תודה רבה!\n\nבתאריך יום ג׳, 10 בנוב׳ 2026 ב-10:00 מאת שירות <support@shop.test>‏ כתב:\n> ישן')).toBe('תודה רבה!');
    expect(stripQuoted('Hello\n-- \nDana\n050-0000000')).toBe('Hello');
    expect(stripQuoted('See below\n-----Original Message-----\nFrom: x')).toBe('See below');
    expect(stripQuoted('Line\nFrom: Support\nSent: Monday\nold')).toBe('Line');
    expect(stripQuoted('> only a quote')).toBe('> only a quote');   // nothing new: keep it rather than drop everything
  });
  it('names a mail connection failure without echoing the server', () => {
    expect(mailError({ code: 'EAUTH', message: 'Invalid login: 535 5.7.8 bad user dana' }, 'smtp')).toBe('smtp_auth_failed');
    expect(mailError({ authenticationFailed: true }, 'imap')).toBe('imap_auth_failed');
    expect(mailError({ code: 'ENOTFOUND' }, 'imap')).toBe('imap_host_not_found');
    expect(mailError({ code: 'ECONNREFUSED' }, 'smtp')).toBe('smtp_unreachable');
    expect(mailError({ code: 'ESOCKET', message: 'connect ECONNREFUSED 127.0.0.1:465' }, 'smtp')).toBe('smtp_unreachable');
    expect(mailError({ message: 'self-signed certificate' }, 'imap')).toBe('imap_tls_failed');
    expect(mailError({ message: '?' }, 'smtp')).toBe('smtp_failed');
  });
});

describe('e-mail adapter', () => {
  const box = new FakeBox();
  const sender = new FakeSender();
  const factory: MailFactory = { box: () => box, sender: () => sender };
  const store = memStore();
  const got: InboundMessage[] = [];
  const statuses: ChannelStatus[] = [];
  const ctx: AdapterContext = { channelId: 'c1', store, events: { onQr() {}, onStatus: (s) => { statuses.push(s); }, onMessage: (m) => { got.push(m); } } };
  const a = new EmailAdapter(ctx, factory);
  beforeAll(async () => {
    box.msgs.push({ uid: 3, source: mail(3) });   // already in the mailbox before connecting: never imported
    await store.set('email', JSON.stringify(CREDS));
    await a.start();
  });
  afterAll(async () => { await a.stop(); });

  it('connects, and imports only mail that arrives afterwards; marks it seen', async () => {
    expect(statuses).toContain('connected');
    await a.check();
    expect(got).toHaveLength(0);
    const uid = box.deliver(mail(10));
    await a.check();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ externalContactId: 'dana@example.com', contactName: 'Dana Levi', externalMessageId: '<m10@example.com>', text: 'נושא: בעיה בהזמנה\n\nשלום, יש לי שאלה' });
    expect(box.seen).toContain(uid);
  });

  it('never answers automatic mail: auto-replies, lists, bounces, our own address', async () => {
    const before = got.length;
    box.deliver(mail(20, { 'Auto-Submitted': 'auto-replied' }));
    box.deliver(mail(21, { Precedence: 'bulk' }));
    box.deliver(mail(22, { 'List-Id': '<news.example.com>' }));
    box.deliver(raw({ From: 'MAILER-DAEMON@mx.example.com', Subject: 'Undelivered', 'Message-ID': '<b1@x>' }, 'failed'));
    box.deliver(raw({ From: 'support@shop.test', Subject: 'loop', 'Message-ID': '<own@x>' }, 'me'));
    await a.check();
    expect(got.length).toBe(before);
    expect(isAutomatic({ headers: new Map([['auto-submitted', 'no']]) as never, from: { value: [{ address: 'a@b.co', name: '' }], html: '', text: '' } }, 'support@shop.test')).toBe(false);
  });

  it('replies in the same thread (Re: subject, In-Reply-To, References); a reply from the customer is not a new topic', async () => {
    const out = await a.sendText('dana@example.com', 'בודקים ונחזור אלייך');
    expect(out.externalMessageId).toBe('<out1@shop.test>');
    expect(sender.sent[0]).toMatchObject({ to: 'dana@example.com', subject: 'Re: בעיה בהזמנה', inReplyTo: '<m10@example.com>', text: 'בודקים ונחזור אלייך', from: '"שירות לקוחות" <support@shop.test>' });
    expect(sender.sent[0]!.references).toContain('<m10@example.com>');
    box.deliver(mail(30, { Subject: 'Re: בעיה בהזמנה', 'In-Reply-To': '<out1@shop.test>' }, 'תודה!\n\nOn Tue, Support wrote:\n> בודקים'));
    await a.check();
    expect(got.at(-1)!.text).toBe('תודה!');
  });

  it('each attachment arrives (up to 5); inline pictures are skipped', async () => {
    const b = 'XYZ';
    const multi = Buffer.from([
      'From: Noa <noa@example.org>', 'To: support@shop.test', 'Subject: תמונות', 'Message-ID: <att@x>', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
      `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', 'מצרפת', `--${b}`,
      'Content-Type: image/png; name="a.png"', 'Content-Disposition: attachment; filename="a.png"', 'Content-Transfer-Encoding: base64', '', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', `--${b}`,
      'Content-Type: application/pdf; name="b.pdf"', 'Content-Disposition: attachment; filename="b.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64'), `--${b}--`, '',
    ].join('\r\n'));
    box.deliver(multi);
    await a.check();
    const mine = got.filter((m) => m.externalContactId === 'noa@example.org');
    expect(mine.map((m) => [m.externalMessageId, m.media?.fileName])).toEqual([['<att@x>', 'a.png'], ['<att@x>#2', 'b.pdf']]);
    expect((await mine[0]!.media!.download()).subarray(1, 4).toString()).toBe('PNG');
  });

  it('a rebuilt mailbox (new UIDVALIDITY) starts again from now', async () => {
    await a.stop();
    box.uidValidity = '2'; box.msgs = [{ uid: 1, source: mail(99) }]; box.uidNext = 2;
    const before = got.length;
    await a.start();
    await a.check();
    expect(got.length).toBe(before);
  });

  it('a wrong SMTP password stops the channel with a reason', async () => {
    await a.stop();
    sender.fail = Object.assign(new Error('535 auth'), { code: 'EAUTH' });
    await a.start();
    expect(statuses.at(-1)).toBe('error');
    expect(a.lastError).toBe('smtp_auth_failed');
    sender.fail = null;
  });
});

describe('e-mail channel settings', () => {
  const ORIGIN = 'https://panel.test';
  const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
  const db = createDb(DB_URL);
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = '';
  let id = '';
  const sender = new FakeSender();
  const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: '10.94.0.1', headers: { origin: ORIGIN, cookie } });
  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    app = await buildApp(cfg, db, new ChannelManager(db, cfg, (t, ctx) => (t === 'email' ? new EmailAdapter(ctx, { box: () => new FakeBox(), sender: () => sender }) : null)));
    await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ('adm@t.io','adm','admin',$1)`, [await hashPassword('correct-horse-battery')]);
    cookie = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'adm@t.io', password: 'correct-horse-battery' }, remoteAddress: '10.94.0.2', headers: { origin: ORIGIN } })).cookies[0]!.value}`;
    id = (await call('POST', '/channels', { type: 'email', label: 'support@' })).json().id;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('validates each field, keeps the password write-only and encrypted, connects, and reports why it could not', async () => {
    const good = { ...CREDS };
    expect((await call('PUT', `/channels/${id}/email`, { ...good, imapHost: 'mail.shop.test; rm -rf /' })).json()).toEqual({ error: 'invalid_mail_host' });
    expect((await call('PUT', `/channels/${id}/email`, { ...good, smtpPort: 25 })).json()).toEqual({ error: 'invalid_mail_port' });
    expect((await call('PUT', `/channels/${id}/email`, { ...good, fromAddress: 'not-an-address' })).json()).toEqual({ error: 'invalid_from_address' });
    expect((await call('PUT', `/channels/${id}/email`, { ...good, fromName: 'X\r\nBcc: all@x.com' })).json()).toEqual({ error: 'invalid_from_name' });
    expect((await call('PUT', `/channels/${id}/email`, { ...good, password: '' })).json()).toEqual({ error: 'mail_password_required' });
    expect((await call('PUT', `/channels/${id}/email`, good)).json()).toEqual({ ok: true, status: 'connected' });
    const cfgOut = (await call('GET', `/channels/${id}/email`)).json();
    expect(cfgOut).toMatchObject({ configured: true, imapHost: 'mail.shop.test', fromAddress: 'support@shop.test' });
    expect(JSON.stringify(cfgOut)).not.toContain('secret-pass');
    expect(JSON.stringify((await db.query('SELECT * FROM channel_auth WHERE channel_id = $1', [id])).rows)).not.toContain('secret-pass');
    // editing without retyping the password keeps the saved one
    expect((await call('PUT', `/channels/${id}/email`, { ...good, password: undefined, fromName: 'צוות' })).json()).toMatchObject({ status: 'connected' });
    sender.fail = Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' });
    expect((await call('PUT', `/channels/${id}/email`, good)).json()).toEqual({ ok: true, status: 'error', error: 'smtp_host_not_found' });
    sender.fail = null;
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'channel.email_settings'`)).rows[0].n).toBe(3);
  });
});
