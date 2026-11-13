import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type SignalKeyStore,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import type { AdapterContext, ChannelAdapter, OutboundMedia, StartOptions } from './types.js';

// NOTE: Baileys is an UNOFFICIAL WhatsApp Web client. Using it violates WhatsApp's ToS and the
// number may be banned. Accepted by the product owner; keep outbound volume low and human-like.

// Baileys' own logs can contain phone numbers/JIDs, so they stay off unless explicitly enabled for debugging.
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
// Our own diagnostics: status codes and error names only, never numbers or message content.
const diag = pino({ level: 'info', base: { svc: 'whatsapp' } });
const MAX_RECONNECT_DELAY_MS = 60_000;

function dbKeyStore(ctx: AdapterContext): SignalKeyStore {
  const k = (type: string, id: string) => `${type}:${id}`;
  return {
    async get(type, ids) {
      const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
      await Promise.all(
        ids.map(async (id) => {
          const raw = await ctx.store.get(k(type, id));
          if (!raw) return;
          let value = JSON.parse(raw, BufferJSON.reviver);
          if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value);
          out[id] = value;
        }),
      );
      return out;
    },
    async set(data) {
      const tasks: Promise<void>[] = [];
      for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
        const entries = data[category] ?? {};
        for (const [id, value] of Object.entries(entries)) {
          tasks.push(
            value
              ? ctx.store.set(k(category, id), JSON.stringify(value, BufferJSON.replacer))
              : ctx.store.delete(k(category, id)),
          );
        }
      }
      await Promise.all(tasks);
    },
  };
}

export class WhatsAppAdapter implements ChannelAdapter {
  private sock?: WASocket;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private creds?: AuthenticationCreds;
  private pairingPhone?: string;
  private lastPairingAt = 0;

  constructor(private readonly ctx: AdapterContext) {}

  async start(opts?: StartOptions): Promise<void> {
    this.pairingPhone = opts?.pairingPhone;
    this.stopped = false;
    this.attempts = 0;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { store, events } = this.ctx;
    const raw = await store.get('creds');
    const creds: AuthenticationCreds = raw ? JSON.parse(raw, BufferJSON.reviver) : initAuthCreds();
    this.creds = creds;
    const keys = makeCacheableSignalKeyStore(dbKeyStore(this.ctx), logger);

    events.onStatus('connecting');
    const sock = makeWASocket({
      auth: { creds, keys },
      logger,
      // Phone-number pairing is rejected ("Couldn't link device") unless the platform/browser pair is one WhatsApp recognises.
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      store.set('creds', JSON.stringify(creds, BufferJSON.replacer)).catch(() => events.onStatus('error'));
    });

    sock.ev.on('connection.update', (u) => {
      if (sock !== this.sock) return; // stale socket
      if (u.qr) {
        if (this.pairingPhone && !creds.registered) {
          // Phone-number linking: ask WhatsApp for an 8-char code (not refreshed within ~110s, so the code the user is typing stays valid) instead of showing the QR.
          if (Date.now() - this.lastPairingAt > 110_000) {
            this.lastPairingAt = Date.now();
            sock.requestPairingCode(this.pairingPhone)
              .then((code) => events.onPairingCode?.(code))
              .catch((e: unknown) => { diag.warn({ event: 'pairing_code_failed', err: e instanceof Error ? e.message : 'unknown' }); events.onStatus('error'); });
          }
        } else {
          events.onQr(u.qr);
        }
        events.onStatus('qr');
      }
      if (u.connection === 'open') {
        this.attempts = 0;
        events.onStatus('connected');
      }
      if (u.connection === 'close') void this.onClose((u.lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode);
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const jid = m.key.remoteJid;
        if (!jid || m.key.fromMe || !m.key.id) continue;
        if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
        const msg = m.message;
        // a reaction is not a message: it is feedback on one of ours (never starts the bot)
        if (msg?.reactionMessage) {
          const rk = msg.reactionMessage.key;
          if (rk?.id && rk.fromMe) events.onReaction?.({ externalContactId: jid, targetMessageId: rk.id, emoji: msg.reactionMessage.text ?? '' });
          continue;
        }
        const mediaMsg = msg?.imageMessage ?? msg?.documentMessage ?? msg?.audioMessage ?? msg?.videoMessage;
        const caption = msg?.imageMessage?.caption ?? msg?.documentMessage?.caption ?? msg?.videoMessage?.caption ?? undefined;
        const text = msg?.conversation ?? msg?.extendedTextMessage?.text ?? caption ?? (mediaMsg ? '' : '[unsupported message type]');
        const size = Number(mediaMsg?.fileLength?.toString() ?? 0) || undefined;
        const ts = Number(m.messageTimestamp ?? Math.floor(Date.now() / 1000));
        void Promise.resolve(
          events.onMessage({
            externalContactId: jid,
            contactName: m.pushName ?? undefined,
            externalMessageId: m.key.id,
            text,
            timestamp: new Date(ts * 1000),
            media: mediaMsg
              ? {
                  fileName: msg?.documentMessage?.fileName ?? undefined,
                  size,
                  download: () => downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }),
                }
              : undefined,
          }),
        ).catch(() => undefined);
      }
    });
  }

  private async onClose(code?: number): Promise<void> {
    const { store, events } = this.ctx;
    diag.info({ event: 'connection_closed', code: code ?? null, registered: !!this.creds?.registered, pairing: !!this.pairingPhone });
    if (this.stopped) return;
    if (code === DisconnectReason.loggedOut) {
      this.stopped = true;
      await store.clear();
      events.onStatus('logged_out');
      return;
    }
    // 403 = forbidden: WhatsApp refused this account (restricted / banned). Do NOT keep reconnecting - it makes things worse.
    if (code === DisconnectReason.forbidden) {
      this.stopped = true;
      events.onStatus('restricted');
      return;
    }
    // 515 = restart required right after pairing; always reconnect immediately.
    const restart = code === DisconnectReason.restartRequired;
    // Never paired and QR window expired: stop instead of looping forever; user can press "link" again.
    if (!restart && !this.creds?.registered) {
      this.stopped = true;
      events.onStatus('stopped');
      return;
    }
    const delay = restart ? 0 : Math.min(1000 * 2 ** this.attempts++, MAX_RECONNECT_DELAY_MS);
    events.onStatus('connecting');
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => events.onStatus('error'));
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = undefined;
    sock?.end(undefined);
    this.ctx.events.onStatus('stopped');
  }

  async logout(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = undefined;
    try {
      await sock?.logout();
    } catch {
      /* already disconnected: still wipe local session below */
    }
    await this.ctx.store.clear();
    this.ctx.events.onStatus('logged_out');
  }

  async sendText(externalContactId: string, text: string): Promise<{ externalMessageId?: string }> {
    if (!this.sock) throw new Error('channel_not_connected');
    const res = await this.sock.sendMessage(externalContactId, { text });
    return { externalMessageId: res?.key.id ?? undefined };
  }

  async sendMedia(externalContactId: string, media: OutboundMedia): Promise<{ externalMessageId?: string }> {
    if (!this.sock) throw new Error('channel_not_connected');
    const { buffer, mime, fileName, caption } = media;
    // a GIF plays only as a looping silent video ("gifPlayback"); without one WhatsApp shows its first frame
    const content = mime === 'image/gif' && media.animation
      ? { video: media.animation, gifPlayback: true, caption, mimetype: 'video/mp4' }
      : mime.startsWith('image/')
      ? { image: buffer, caption }
      : mime === 'video/mp4'
        ? { video: buffer, caption }
        : mime.startsWith('audio/')
          ? { audio: buffer, mimetype: mime }
          : { document: buffer, mimetype: mime, fileName, caption };
    const res = await this.sock.sendMessage(externalContactId, content);
    return { externalMessageId: res?.key.id ?? undefined };
  }

  async setProfilePhoto(image: Buffer): Promise<string> {
    const me = this.sock?.user?.id;
    if (!this.sock || !me) return 'channel_not_connected';
    try {
      await this.sock.updateProfilePicture(`${me.split(':')[0]!.split('@')[0]}@s.whatsapp.net`, image);
      return 'ok';
    } catch { return 'profile_photo_failed'; }
  }

  async typing(externalContactId: string, ms: number): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendPresenceUpdate('composing', externalContactId);
    await new Promise((r) => setTimeout(r, ms));
    await this.sock.sendPresenceUpdate('paused', externalContactId);
  }

  async listGroups(): Promise<{ id: string; name: string; size: number }[]> {
    if (!this.sock) throw new Error('channel_not_connected');
    const groups = await this.sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({ id: g.id, name: g.subject ?? '', size: g.participants?.length ?? 0 })).sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  async react(externalContactId: string, externalMessageId: string, emoji: string): Promise<void> {
    if (!this.sock) throw new Error('channel_not_connected');
    await this.sock.sendMessage(externalContactId, { react: { text: emoji, key: { remoteJid: externalContactId, id: externalMessageId, fromMe: false } } });
  }

  async markRead(externalContactId: string, externalMessageIds: string[]): Promise<void> {
    if (!this.sock || externalMessageIds.length === 0) return;
    await this.sock.readMessages(externalMessageIds.map((id) => ({ remoteJid: externalContactId, id, fromMe: false })));
  }
}
