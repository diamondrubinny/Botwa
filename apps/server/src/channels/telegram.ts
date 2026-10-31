import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { CustomFile } from 'telegram/client/uploads.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import type { AdapterContext, ChannelAdapter, OutboundMedia, TelegramCredentials } from './types.js';

// Telegram USER-account login by QR (MTProto via gramJS). Use your own api_id/api_hash.
// Automated messaging from user accounts can get the account limited; keep volume human-like.

const SESSION_KEY = 'session';
const CONNECT_TIMEOUT_MS = 30_000;
const QR_WINDOW_MS = 3 * 60_000; // give up if nobody scans within 3 minutes

/** Contact id = "<userId>:<accessHash>": the access hash is required to message a user after a restart. */
export const formatTgContactId = (userId: string, accessHash: string) => `${userId}:${accessHash}`;
export function parseTgContactId(id: string): { userId: string; accessHash: string } {
  const m = /^(\d+):(-?\d+)$/.exec(id);
  if (!m) throw new Error('invalid_contact_id');
  return { userId: m[1]!, accessHash: m[2]! };
}

export const tgQrPayload = (token: Buffer) => `tg://login?token=${token.toString('base64url')}`;

/** Telegram errors that mean the account is limited/banned (not a normal send failure). */
const RESTRICTION_ERRORS = ['PEER_FLOOD', 'USER_DEACTIVATED_BAN', 'USER_DEACTIVATED', 'PHONE_NUMBER_BANNED', 'FLOOD_PREMIUM_WAIT'];
export const isRestriction = (e: unknown) => RESTRICTION_ERRORS.includes((e as { errorMessage?: string })?.errorMessage ?? '');

export class TelegramAdapter implements ChannelAdapter {
  private client?: TelegramClient;
  private stopped = true;
  private qrTimer?: NodeJS.Timeout;
  private pendingPassword?: (pw: string) => void;

  constructor(private readonly ctx: AdapterContext, private readonly creds: TelegramCredentials) {}

  async start(): Promise<void> {
    const { store, events } = this.ctx;
    this.stopped = false;
    events.onStatus('connecting');

    const saved = await store.get(SESSION_KEY);
    const client = new TelegramClient(new StringSession(saved ?? ''), this.creds.apiId, this.creds.apiHash, {
      connectionRetries: 5,
      deviceModel: 'Botwa',
      appVersion: '1.0.0',
    });
    client.setLogLevel(LogLevel.NONE);
    this.client = client;
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('telegram_connect_timeout')), CONNECT_TIMEOUT_MS).unref()),
      ]);
    } catch (e) {
      this.client = undefined;
      this.stopped = true;
      await client.disconnect().catch(() => undefined);
      throw e;
    }

    if (await client.checkAuthorization()) {
      await this.onAuthorized(client);
      return;
    }
    if (saved) {
      // Stored session was revoked on Telegram's side: require a fresh, deliberate QR link.
      await store.clear();
      await client.disconnect();
      this.client = undefined;
      this.stopped = true;
      events.onStatus('logged_out');
      return;
    }
    void this.qrLogin(client);
  }

  private async qrLogin(client: TelegramClient): Promise<void> {
    const { events } = this.ctx;
    events.onStatus('qr');
    this.qrTimer = setTimeout(() => {
      if (this.client === client && !this.stopped) void this.stop();
    }, QR_WINDOW_MS);
    try {
      await client.signInUserWithQrCode(this.creds, {
        qrCode: async ({ token }) => {
          events.onQr(tgQrPayload(token));
        },
        password: (hint) =>
          new Promise<string>((resolve) => {
            events.onStatus('password');
            this.pendingPassword = (pw) => {
              this.pendingPassword = undefined;
              resolve(pw);
            };
            void hint;
          }),
        // Wrong 2FA password: ask again (returning false keeps the flow alive).
        onError: async () => false,
      });
      clearTimeout(this.qrTimer);
      if (this.stopped || this.client !== client) return;
      await this.onAuthorized(client);
    } catch {
      clearTimeout(this.qrTimer);
      if (this.stopped || this.client !== client) return; // stopped by user/timeout
      this.stopped = true;
      events.onStatus('error');
    }
  }

  private async onAuthorized(client: TelegramClient): Promise<void> {
    await this.ctx.store.set(SESSION_KEY, (client.session as StringSession).save());
    client.addEventHandler((e: NewMessageEvent) => void this.onMessage(e).catch(() => undefined), new NewMessage({ incoming: true }));
    this.ctx.events.onStatus('connected');
  }

  private async onMessage(e: NewMessageEvent): Promise<void> {
    const m = e.message;
    if (!e.isPrivate || m.out || !m.id) return;
    const peer = await m.getInputSender();
    if (!(peer instanceof Api.InputPeerUser)) return;
    const hasMedia = !!(m.photo || m.document);
    const sender = await m.getSender().catch(() => undefined);
    const name =
      sender instanceof Api.User
        ? [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.username || undefined
        : undefined;
    await this.ctx.events.onMessage({
      externalContactId: formatTgContactId(peer.userId.toString(), peer.accessHash.toString()),
      contactName: name,
      externalMessageId: String(m.id),
      text: m.message || (hasMedia ? '' : '[unsupported message type]'),
      timestamp: new Date((m.date ?? Math.floor(Date.now() / 1000)) * 1000),
      media: hasMedia
        ? {
            fileName: m.file?.name ?? undefined,
            size: Number(m.file?.size?.toString() ?? 0) || undefined,
            download: async () => {
              const data = await this.client?.downloadMedia(m);
              if (!Buffer.isBuffer(data)) throw new Error('download_failed');
              return data;
            },
          }
        : undefined,
    });
  }

  submitPassword(password: string): void {
    this.pendingPassword?.(password);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.qrTimer);
    const c = this.client;
    this.client = undefined;
    this.pendingPassword = undefined;
    await c?.disconnect().catch(() => undefined);
    this.ctx.events.onStatus('stopped');
  }

  async logout(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.qrTimer);
    const c = this.client;
    this.client = undefined;
    try {
      await c?.invoke(new Api.auth.LogOut());
    } catch {
      /* already unauthorised: still wipe local session */
    }
    await c?.disconnect().catch(() => undefined);
    await this.ctx.store.clear();
    this.ctx.events.onStatus('logged_out');
  }

  async sendText(externalContactId: string, text: string): Promise<{ externalMessageId?: string }> {
    if (!this.client) throw new Error('channel_not_connected');
    const { userId, accessHash } = parseTgContactId(externalContactId);
    const peer = new Api.InputPeerUser({ userId: bigInt(userId), accessHash: bigInt(accessHash) });
    try {
      const res = await this.client.sendMessage(peer, { message: text });
      return { externalMessageId: String(res.id) };
    } catch (e) {
      if (isRestriction(e)) this.ctx.events.onStatus('restricted');
      throw e;
    }
  }

  async sendMedia(externalContactId: string, media: OutboundMedia): Promise<{ externalMessageId?: string }> {
    if (!this.client) throw new Error('channel_not_connected');
    const { userId, accessHash } = parseTgContactId(externalContactId);
    const peer = new Api.InputPeerUser({ userId: bigInt(userId), accessHash: bigInt(accessHash) });
    try {
      const res = await this.client.sendFile(peer, {
        file: new CustomFile(media.fileName, media.buffer.length, '', media.buffer),
        caption: media.caption,
        forceDocument: !media.mime.startsWith('image/'),
      });
      return { externalMessageId: String(res.id) };
    } catch (e) {
      if (isRestriction(e)) this.ctx.events.onStatus('restricted');
      throw e;
    }
  }

  async markRead(externalContactId: string): Promise<void> {
    if (!this.client) return;
    const { userId, accessHash } = parseTgContactId(externalContactId);
    await this.client.markAsRead(new Api.InputPeerUser({ userId: bigInt(userId), accessHash: bigInt(accessHash) }));
  }
}
