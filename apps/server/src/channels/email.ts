import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import type { AdapterContext, ChannelAdapter, InboundMessage, OutboundMedia } from './types.js';

/**
 * E-mail as a channel: a support mailbox is read over IMAP (IDLE + a polling fallback) and replies go out over SMTP.
 * Every connection is TLS (implicit on 993/465, STARTTLS required on 143/587; certificates are verified). Only mail that arrives
 * after the channel is connected is imported. Automatic mail (auto-replies, bounces, mailing lists) is never answered, so a
 * bot cannot get into a loop with an auto-responder.
 */
export interface EmailCreds {
  imapHost: string; imapPort: number;
  smtpHost: string; smtpPort: number;
  username: string; password: string;
  fromAddress: string; fromName: string;
  mailbox: string;
}
export const EMAIL_CREDS_KEY = 'email';
const STATE_KEY = 'email:state';
const MAX_RAW = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const MAX_TEXT = 20_000;
const POLL_MS = 60_000;

/** What the adapter needs from a mailbox (an IMAP client in production, a fake in tests). */
export interface MailBox {
  open(): Promise<{ uidValidity: string; uidNext: number }>;
  /** uid and raw source of messages with uid > after, smallest first; larger than maxBytes: uid only (source null) */
  fetchAfter(after: number, maxBytes: number): Promise<{ uid: number; source: Buffer | null }[]>;
  markSeen(uids: number[]): Promise<void>;
  onNew(cb: () => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): Promise<void>;
}
export interface MailSender {
  verify(): Promise<void>;
  send(m: { from: string; to: string; subject: string; text: string; inReplyTo?: string; references?: string[]; attachments?: { filename: string; content: Buffer; contentType: string }[] }): Promise<{ messageId?: string }>;
}
export interface MailFactory { box(c: EmailCreds): MailBox; sender(c: EmailCreds): MailSender }

const tlsOpts = { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };

export const realMail: MailFactory = {
  box(c) {
    const client = new ImapFlow({
      host: c.imapHost, port: c.imapPort, secure: c.imapPort === 993, ...(c.imapPort === 993 ? {} : { doSTARTTLS: true }),
      auth: { user: c.username, pass: c.password }, logger: false, tls: tlsOpts,
    } as ConstructorParameters<typeof ImapFlow>[0]);
    return {
      async open() {
        await client.connect();
        const mb = await client.mailboxOpen(c.mailbox);
        return { uidValidity: String(mb.uidValidity), uidNext: Number(mb.uidNext) };
      },
      async fetchAfter(after, maxBytes) {
        const sizes: { uid: number; size: number }[] = [];
        for await (const m of client.fetch(`${after + 1}:*`, { uid: true, size: true }, { uid: true })) if (m.uid > after) sizes.push({ uid: m.uid, size: m.size ?? 0 });
        const out: { uid: number; source: Buffer | null }[] = [];
        for (const s of sizes.sort((a, b) => a.uid - b.uid).slice(0, 50)) {
          if (s.size > maxBytes) { out.push({ uid: s.uid, source: null }); continue; }
          const m = await client.fetchOne(String(s.uid), { source: true }, { uid: true });
          out.push({ uid: s.uid, source: m && m.source ? Buffer.from(m.source) : null });
        }
        return out;
      },
      async markSeen(uids) { if (uids.length) await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true }); },
      onNew(cb) { client.on('exists', cb); },
      onClose(cb) { client.on('close', () => cb()); client.on('error', (e: Error) => cb(e)); },
      async close() { await client.logout().catch(() => client.close()); },
    };
  },
  sender(c) {
    const t = nodemailer.createTransport({
      host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465, requireTLS: c.smtpPort !== 465,
      auth: { user: c.username, pass: c.password }, tls: tlsOpts, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    });
    return {
      async verify() { await t.verify(); },
      async send(m) {
        const info = await t.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, inReplyTo: m.inReplyTo, references: m.references, attachments: m.attachments });
        return { messageId: info.messageId };
      },
    };
  },
};

/** Automatic mail that must never get an answer (RFC 3834 Auto-Submitted, Precedence, list mail, bounces). */
export function isAutomatic(mail: Pick<ParsedMail, 'headers' | 'from'> & { headerLines?: ParsedMail['headerLines'] }, ownAddress: string): boolean {
  const h = mail.headers;
  const get = (k: string) => String(h.get(k) ?? '').toLowerCase();
  // the parser folds List-* headers into one 'list' entry: look at the raw header names as well
  const names = new Set((mail.headerLines ?? []).map((l) => l.key.toLowerCase()));
  if (h.has('list') || names.has('list-id') || names.has('list-unsubscribe') || names.has('list-post')) return true;
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (/^(bulk|junk|list|auto_reply)$/.test(get('precedence'))) return true;
  if (h.has('x-autoreply') || h.has('x-autorespond') || h.has('list-id') || h.has('list-unsubscribe')) return true;
  const from = (mail.from?.value?.[0]?.address ?? '').toLowerCase();
  if (!from || from === ownAddress.toLowerCase()) return true;
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+@.-]|$)/.test(from.split('@')[0] ?? '') && from.includes('@');
}

/** The new part of a reply: quoted history and the signature are cut (Hebrew and English mail clients' markers). */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const t = l.trim();
    if (/^On .{3,300} wrote:$/i.test(t) || /^ב?תאריך .{3,300}(כתב|כתבה|נכתב)[^:]{0,40}:$/.test(t) || /^.{3,200}(כתב|כתבה)\s*:$/.test(t) && i > 0 && lines.slice(i + 1).some((x) => x.startsWith('>'))) break;
    if (/^-{2,}\s*(Original Message|הודעה מקורית)\s*-{2,}$/i.test(t)) break;
    if (/^(From|מאת):\s.+/.test(t) && /^(Sent|Date|נשלח|תאריך):\s/.test((lines[i + 1] ?? '').trim())) break;
    if (l === '-- ' || t === '--') break;
    if (t.startsWith('>')) continue;
    out.push(l);
  }
  const s = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return (s || text.trim()).slice(0, MAX_TEXT);
}

const baseSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|השב|הע|תשובה)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();

interface Thread { subject: string; messageId?: string; refs: string[] }

export class EmailAdapter implements ChannelAdapter {
  private creds?: EmailCreds;
  private box?: MailBox;
  private sender?: MailSender;
  private active = false;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;
  private again = false;
  private failures = 0;
  lastError: string | null = null;

  constructor(private readonly ctx: AdapterContext, private readonly mail: MailFactory = realMail) {}

  isActive(): boolean { return this.active; }

  async start(): Promise<void> {
    const { store, events } = this.ctx;
    const raw = await store.get(EMAIL_CREDS_KEY);
    if (!raw) { events.onStatus('logged_out'); return; }
    this.creds = JSON.parse(raw) as EmailCreds;
    this.stopping = false;
    events.onStatus('connecting');
    this.lastError = null;
    try {
      this.sender = this.mail.sender(this.creds);
      await this.sender.verify();
    } catch (e) { this.lastError = mailError(e, 'smtp'); events.onStatus('error'); return; }
    if (!(await this.connect())) { events.onStatus('error'); return; }
    this.active = true;
    events.onStatus('connected');
    this.timer = setInterval(() => void this.check(), POLL_MS);
    this.timer.unref?.();
    void this.check();
  }

  private async connect(): Promise<boolean> {
    try {
      const box = this.mail.box(this.creds!);
      const info = await box.open();
      const state = JSON.parse((await this.ctx.store.get(STATE_KEY)) ?? 'null') as { uidValidity: string; lastUid: number } | null;
      // first connection, or the mailbox was rebuilt (new UIDVALIDITY): start from now, never import old mail
      if (!state || state.uidValidity !== info.uidValidity) await this.ctx.store.set(STATE_KEY, JSON.stringify({ uidValidity: info.uidValidity, lastUid: Math.max(0, info.uidNext - 1) }));
      box.onNew(() => void this.check());
      box.onClose(() => { if (!this.stopping && this.box === box) void this.reconnect(); });
      this.box = box;
      this.failures = 0;
      return true;
    } catch (e) { this.lastError = mailError(e, 'imap'); return false; }
  }

  private async reconnect(): Promise<void> {
    this.box = undefined;
    if (this.stopping) return;
    this.failures++;
    if (this.failures > 6) { this.active = false; this.lastError = this.lastError ?? 'mail_connection_lost'; this.ctx.events.onStatus('error'); return; }
    await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** this.failures)).unref?.());
    if (!this.stopping && (await this.connect())) void this.check();
    else if (!this.stopping) void this.reconnect();
  }

  /** Fetch what arrived since the last check. Single-flight: a check that is asked for while one runs happens right after it. */
  check(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.again = false; await this.fetchNew(); } while (this.again);
      } catch (e) { this.lastError = mailError(e, 'imap'); } finally { this.running = null; }
    })();
    return this.running;
  }

  private async fetchNew(): Promise<void> {
    if (!this.box || !this.creds) return;
    const state = JSON.parse((await this.ctx.store.get(STATE_KEY)) ?? 'null') as { uidValidity: string; lastUid: number } | null;
    if (!state) return;
    const items = await this.box.fetchAfter(state.lastUid, MAX_RAW);
    const seen: number[] = [];
    for (const it of items) {
      if (it.source) await this.handle(it.uid, it.source).catch(() => undefined);   // one broken message must not stop the mailbox
      seen.push(it.uid);
      state.lastUid = Math.max(state.lastUid, it.uid);
      await this.ctx.store.set(STATE_KEY, JSON.stringify(state));
    }
    await this.box.markSeen(seen).catch(() => undefined);
  }

  private async handle(uid: number, source: Buffer): Promise<void> {
    const mail = await simpleParser(source, { maxHtmlLengthToParse: 2_000_000 });
    if (isAutomatic(mail, this.creds!.fromAddress)) return;
    const fromAddr = mail.from!.value[0]!.address!.toLowerCase();
    if (!/^[^\s@<>"']{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/.test(fromAddr)) return;
    const contact = fromAddr;
    const subject = (mail.subject ?? '').slice(0, 300);
    const thread = await this.thread(contact);
    const newTopic = !!subject && baseSubject(subject) !== baseSubject(thread?.subject ?? '');
    const body = stripQuoted(mail.text ?? '');
    const text = newTopic ? `נושא: ${baseSubject(subject)}\n\n${body}` : body;
    const msgId = (mail.messageId ?? `<uid-${uid}@botwa>`).slice(0, 300);
    const refs = [...(thread?.refs ?? []), ...(Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : []), msgId].slice(-10);
    await this.ctx.store.set(`t:${contact}`, JSON.stringify({ subject: subject || thread?.subject || '', messageId: msgId, refs } satisfies Thread));

    const files = (mail.attachments ?? []).filter((a) => !a.related && a.content?.length).slice(0, MAX_ATTACHMENTS);
    const base: Omit<InboundMessage, 'externalMessageId' | 'text'> = { externalContactId: contact, contactName: mail.from!.value[0]!.name?.slice(0, 100) || undefined, timestamp: mail.date ?? new Date() };
    const first = files[0];
    await this.ctx.events.onMessage({ ...base, externalMessageId: msgId, text, media: first ? { fileName: first.filename, size: first.size, download: async () => first.content } : undefined });
    for (let i = 1; i < files.length; i++) {
      const f = files[i]!;
      await this.ctx.events.onMessage({ ...base, externalMessageId: `${msgId}#${i + 1}`, text: '', media: { fileName: f.filename, size: f.size, download: async () => f.content } });
    }
  }

  private async thread(contact: string): Promise<Thread | null> {
    const raw = await this.ctx.store.get(`t:${contact}`);
    return raw ? (JSON.parse(raw) as Thread) : null;
  }

  private from = () => (this.creds!.fromName ? `"${this.creds!.fromName.replace(/["\\\r\n]/g, '')}" <${this.creds!.fromAddress}>` : this.creds!.fromAddress);

  private async deliver(to: string, text: string, attachments?: { filename: string; content: Buffer; contentType: string }[]): Promise<{ externalMessageId?: string }> {
    if (!this.sender || !this.active || !this.creds) throw new Error('channel_not_connected');
    const t = await this.thread(to);
    const subject = t?.subject ? (/^re:/i.test(t.subject) ? t.subject : `Re: ${baseSubject(t.subject)}`) : `${this.creds.fromName || 'מענה לפנייתך'}`;
    const out = await this.sender.send({ from: this.from(), to, subject, text, inReplyTo: t?.messageId, references: t?.refs, attachments });
    if (out.messageId) await this.ctx.store.set(`t:${to}`, JSON.stringify({ subject: t?.subject ?? subject, messageId: t?.messageId, refs: [...(t?.refs ?? []), out.messageId].slice(-10) } satisfies Thread));
    return { externalMessageId: out.messageId };
  }

  sendText(externalContactId: string, text: string) { return this.deliver(externalContactId, text); }

  sendMedia(externalContactId: string, media: OutboundMedia) {
    return this.deliver(externalContactId, media.caption ?? '', [{ filename: media.fileName, content: media.buffer, contentType: media.mime }]);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    await this.box?.close().catch(() => undefined);
    this.box = undefined;
    this.ctx.events.onStatus('stopped');
  }

  async logout(): Promise<void> {
    await this.stop();
    await this.ctx.store.clear();
    this.ctx.events.onStatus('logged_out');
  }
}

/** A code the settings screen explains, from a connection or login failure (never the server's raw message, which may echo data). */
export function mailError(e: unknown, side: 'imap' | 'smtp'): string {
  const err = e as { code?: string; responseCode?: number; authenticationFailed?: boolean; message?: string };
  const msg = String(err?.message ?? '');
  if (err?.authenticationFailed || err?.code === 'EAUTH' || err?.responseCode === 535 || /auth|login|credentials|LOGIN failed/i.test(msg)) return `${side}_auth_failed`;
  // the SMTP library wraps network errors (code ESOCKET/ECONNECTION) and keeps the cause only in the message
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN' || /ENOTFOUND|EAI_AGAIN/.test(msg)) return `${side}_host_not_found`;
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err?.code ?? '') || /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|timeout/i.test(msg)) return `${side}_unreachable`;
  if (/certificate|self[- ]signed|TLS|SSL|STARTTLS/i.test(msg) || err?.code === 'ESOCKET') return `${side}_tls_failed`;
  if (/mailbox|NONEXISTENT|doesn't exist|not exist/i.test(msg)) return 'imap_mailbox_not_found';
  return `${side}_failed`;
}
