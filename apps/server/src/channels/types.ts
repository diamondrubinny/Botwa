export type ChannelType = 'whatsapp' | 'telegram';
export type ChannelStatus = 'stopped' | 'connecting' | 'qr' | 'connected' | 'logged_out' | 'error';

export interface InboundMessage {
  externalContactId: string;
  contactName?: string;
  externalMessageId: string;
  text: string;
  timestamp: Date;
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
  sendText(externalContactId: string, text: string): Promise<{ externalMessageId?: string }>;
}

export interface AdapterContext {
  channelId: string;
  store: AuthStore;
  events: AdapterEvents;
}

export type AdapterFactory = (type: ChannelType, ctx: AdapterContext) => ChannelAdapter | null;
