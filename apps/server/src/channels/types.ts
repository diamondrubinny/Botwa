export type ChannelType = 'whatsapp' | 'whatsapp_cloud' | 'telegram' | 'webchat';
export type ChannelStatus = 'stopped' | 'connecting' | 'qr' | 'connected' | 'logged_out' | 'password' | 'restricted' | 'error';

export interface InboundMedia {
  fileName?: string;
  size?: number;
  download(): Promise<Buffer>;
}

export interface OutboundMedia {
  buffer: Buffer;
  mime: string;
  fileName: string;
  caption?: string;
}

export interface InboundMessage {
  externalContactId: string;
  contactName?: string;
  externalMessageId: string;
  text: string;
  timestamp: Date;
  media?: InboundMedia;
}

export interface AdapterEvents {
  onQr(qr: string): void;
  /** WhatsApp "link with phone number" (8-char code typed on the phone instead of scanning a QR). */
  onPairingCode?(code: string): void;
  onStatus(status: ChannelStatus): void;
  onMessage(msg: InboundMessage): void | Promise<void>;
}

/** Persistent encrypted key/value storage for one channel's platform session. */
export interface AuthStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface StartOptions {
  /** WhatsApp only: digits with country code (no +). Use phone-number pairing instead of a QR. */
  pairingPhone?: string;
}

export interface ChannelAdapter {
  start(opts?: StartOptions): Promise<void>;
  /** Disconnect but keep the session (can be started again without re-scanning). */
  stop(): Promise<void>;
  /** Unlink the device on the platform side if possible and wipe local session. */
  logout(): Promise<void>;
  /** Telegram only: supply the cloud (2FA) password when status is 'password'. Never stored. */
  submitPassword?(password: string): void;
  sendText(externalContactId: string, text: string): Promise<{ externalMessageId?: string }>;
  /** Show a "typing" indicator for `ms` before a message is sent (WhatsApp). Best effort. */
  typing?(externalContactId: string, ms: number): Promise<void>;
  /** Tell the platform the customer's messages were read (best effort). */
  markRead?(externalContactId: string, externalMessageIds: string[]): Promise<void>;
  /** React to a customer's message with an emoji (empty string removes our reaction). Best effort; not every platform has it. */
  react?(externalContactId: string, externalMessageId: string, emoji: string): Promise<void>;
  sendMedia?(externalContactId: string, media: OutboundMedia): Promise<{ externalMessageId?: string }>;
}

export interface AdapterContext {
  channelId: string;
  store: AuthStore;
  events: AdapterEvents;
}

export interface TelegramCredentials { apiId: number; apiHash: string }

export type AdapterFactory = (type: ChannelType, ctx: AdapterContext) => ChannelAdapter | null;
