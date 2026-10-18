import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { ingestInbound } from '../inbox.js';
import { createAuthStore } from './auth-store.js';
import type { AdapterFactory, ChannelAdapter, ChannelStatus, ChannelType } from './types.js';
import { WhatsAppAdapter } from './whatsapp.js';

export type BusEvent =
  | { channelId: string; type: 'status'; status: ChannelStatus }
  | { channelId: string; type: 'qr'; qr: string } // PNG data URL
  | { channelId: string; type: 'message'; conversationId: string; messageId: string };

export const defaultFactory: AdapterFactory = (type, ctx) => (type === 'whatsapp' ? new WhatsAppAdapter(ctx) : null);

export class ChannelManager {
  readonly bus = new EventEmitter();
  private adapters = new Map<string, ChannelAdapter>();
  private lastQr = new Map<string, string>();
  private statuses = new Map<string, ChannelStatus>();

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly factory: AdapterFactory = defaultFactory,
  ) {
    this.bus.setMaxListeners(100);
  }

  supports(type: ChannelType): boolean {
    const probe = this.factory(type, {
      channelId: '', store: {} as never, events: { onQr() {}, onStatus() {}, onMessage() {} },
    });
    return probe !== null;
  }

  snapshot(channelId: string): { status: ChannelStatus; qr?: string } {
    return { status: this.statuses.get(channelId) ?? 'stopped', qr: this.lastQr.get(channelId) };
  }

  private emit(e: BusEvent) {
    this.bus.emit('event', e);
  }

  private async setStatus(channelId: string, status: ChannelStatus) {
    this.statuses.set(channelId, status);
    if (status !== 'qr') this.lastQr.delete(channelId);
    if (status === 'stopped' || status === 'logged_out' || status === 'error') this.adapters.delete(channelId);
    await this.db.query('UPDATE channels SET status=$2 WHERE id=$1', [channelId, status]).catch(() => undefined);
    this.emit({ channelId, type: 'status', status });
  }

  async start(channelId: string): Promise<void> {
    if (this.adapters.has(channelId)) return;
    const { rows } = await this.db.query('SELECT type FROM channels WHERE id=$1', [channelId]);
    if (!rows[0]) throw new Error('not_found');
    const adapter = this.factory(rows[0].type, {
      channelId,
      store: createAuthStore(this.db, channelId, this.cfg.ENCRYPTION_KEY),
      events: {
        onStatus: (s) => void this.setStatus(channelId, s),
        onQr: (qr) => {
          void QRCode.toDataURL(qr, { margin: 2, width: 320 }).then((url) => {
            this.lastQr.set(channelId, url);
            this.emit({ channelId, type: 'qr', qr: url });
          });
        },
        onMessage: async (m) => {
          const r = await ingestInbound(this.db, channelId, m);
          if (r.messageId) this.emit({ channelId, type: 'message', conversationId: r.conversationId, messageId: r.messageId });
        },
      },
    });
    if (!adapter) throw new Error('unsupported_channel_type');
    this.adapters.set(channelId, adapter);
    await this.db.query('UPDATE channels SET auto_start=true WHERE id=$1', [channelId]);
    try {
      await adapter.start();
    } catch (e) {
      this.adapters.delete(channelId);
      await this.setStatus(channelId, 'error');
      throw e;
    }
  }

  async stop(channelId: string): Promise<void> {
    await this.db.query('UPDATE channels SET auto_start=false WHERE id=$1', [channelId]);
    const a = this.adapters.get(channelId);
    if (a) await a.stop();
    else await this.setStatus(channelId, 'stopped');
  }

  async logout(channelId: string): Promise<void> {
    await this.db.query('UPDATE channels SET auto_start=false WHERE id=$1', [channelId]);
    const a = this.adapters.get(channelId);
    if (a) await a.logout();
    else {
      await createAuthStore(this.db, channelId, this.cfg.ENCRYPTION_KEY).clear();
      await this.setStatus(channelId, 'logged_out');
    }
  }

  /** Remove channel, session material and (via cascade) its contacts and conversations. */
  async remove(channelId: string): Promise<void> {
    const a = this.adapters.get(channelId);
    if (a) await a.logout().catch(() => undefined);
    this.adapters.delete(channelId);
    this.statuses.delete(channelId);
    this.lastQr.delete(channelId);
    await this.db.query('DELETE FROM channels WHERE id=$1', [channelId]);
  }

  async sendText(channelId: string, externalContactId: string, text: string) {
    const a = this.adapters.get(channelId);
    if (!a || this.statuses.get(channelId) !== 'connected') throw new Error('channel_not_connected');
    return a.sendText(externalContactId, text);
  }

  async startAll(): Promise<void> {
    const { rows } = await this.db.query('SELECT id FROM channels WHERE auto_start');
    for (const r of rows) await this.start(r.id).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => a.stop().catch(() => undefined)));
  }
}
