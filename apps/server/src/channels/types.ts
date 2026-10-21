export type ChannelType = 'whatsapp' | 'telegram';
export type ChannelStatus = 'stopped' | 'connecting' | 'qr' | 'connected' | 'logged_out' | 'password' | 'error';

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

export interface ChannelAdapter {
  start(): Promise<void>;
  /** Disconnect but keep the session (can be started again without re-scanning). */
  stop(): Promise<void>;
  /** Unlink the device on the platform side if possible and wipe local session. */
  logout(): Promise<void>;
  /** Telegram only: supply the cloud (2FA) password when status is 'password'. Never stored. */
  submitPassword?(password: string): void;
  sendText(externalContactId: string, text: string): Promise<{ externalMessageId?: string }>;
  sendMedia?(externalContactId: string, media: OutboundMedia): Promise<{ externalMessageId?: string }>;
}

export interface AdapterContext {
  channelId: string;
  store: AuthStore;
  events: AdapterEvents;
}

export interface TelegramCredentials { apiId: number; apiHash: string }

export type AdapterFactory = (type: ChannelType, ctx: AdapterContext) => ChannelAdapter | null;
