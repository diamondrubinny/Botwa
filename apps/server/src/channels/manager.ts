import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { ingestInbound } from '../inbox.js';
import { decide, loadBot, type BotConfig } from '../bot.js';
import { isOpen } from '../business-hours.js';
import { autoAssign } from '../routing.js';
import { audit } from '../audit.js';
import { MediaService } from '../media/store.js';
import { loadBusinessHours } from '../routes/settings.js';
import { sendAlert } from '../alerts.js';
import { createAuthStore } from './auth-store.js';
import { ChannelSender, loadSending as loadSendingRaw, TEST_SENDING } from './sender.js';
import type { AdapterFactory, ChannelAdapter, ChannelStatus, ChannelType, OutboundMedia, StartOptions } from './types.js';
import { TelegramAdapter } from './telegram.js';
import { WhatsAppAdapter } from './whatsapp.js';

export type BusEvent =
  | { channelId: string; type: 'status'; status: ChannelStatus }
  | { channelId: string; type: 'qr'; qr: string } // PNG data URL
  | { channelId: string; type: 'pairing_code'; code: string }
  | { channelId: string; type: 'message'; conversationId: string; messageId: string };

export function createDefaultFactory(cfg: Config): AdapterFactory {
  return (type, ctx) => {
    if (type === 'whatsapp') return new WhatsAppAdapter(ctx);
    if (type === 'telegram' && cfg.TELEGRAM_API_ID && cfg.TELEGRAM_API_HASH) {
      return new TelegramAdapter(ctx, { apiId: cfg.TELEGRAM_API_ID, apiHash: cfg.TELEGRAM_API_HASH });
    }
    return null;
  };
}

export class ChannelManager {
  readonly bus = new EventEmitter();
  private adapters = new Map<string, ChannelAdapter>();
  private lastQr = new Map<string, string>();
  private lastCode = new Map<string, string>();
  private statuses = new Map<string, ChannelStatus>();
  private readonly sender: ChannelSender;
  private readonly sendingFallback?: typeof TEST_SENDING;
  private loadSending() { return loadSendingRaw(this.db, this.sendingFallback); }

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly factory: AdapterFactory = createDefaultFactory(cfg),
    private readonly media: MediaService = new MediaService(db, cfg),
  ) {
    this.bus.setMaxListeners(100);
    this.sender = new ChannelSender(db);
    this.sendingFallback = cfg.NODE_ENV === 'test' ? TEST_SENDING : undefined;
  }

  supports(type: ChannelType): boolean {
    const probe = this.factory(type, {
      channelId: '', store: {} as never, events: { onQr() {}, onStatus() {}, onMessage() {} },
    });
    return probe !== null;
  }

  snapshot(channelId: string): { status: ChannelStatus; qr?: string; code?: string } {
    return { status: this.statuses.get(channelId) ?? 'stopped', qr: this.lastQr.get(channelId), code: this.lastCode.get(channelId) };
  }

  private emit(e: BusEvent) {
    this.bus.emit('event', e);
  }

  private async setStatus(channelId: string, status: ChannelStatus) {
    const prev = this.statuses.get(channelId);
    this.statuses.set(channelId, status);
    if (status !== 'qr') { this.lastQr.delete(channelId); this.lastCode.delete(channelId); }
    if (status === 'stopped' || status === 'logged_out' || status === 'error' || status === 'restricted') this.adapters.delete(channelId);
    // never auto-reconnect an account the platform has restricted: it must be reviewed by a person first
    if (status === 'restricted') await this.db.query('UPDATE channels SET auto_start=false WHERE id=$1', [channelId]).catch(() => undefined);
    await this.db.query('UPDATE channels SET status=$2 WHERE id=$1', [channelId, status]).catch(() => undefined);
    if (prev !== status) {
      await this.db.query('INSERT INTO channel_events (channel_id, kind) VALUES ($1,$2)', [channelId, status]).catch(() => undefined);
      // unexpected loss of a working channel => tell the operator (in-app health panel always; webhook if configured)
      if (['logged_out', 'error', 'restricted'].includes(status) && prev === 'connected') {
        const { rows } = await this.db.query('SELECT label, type FROM channels WHERE id=$1', [channelId]).catch(() => ({ rows: [] as { label: string; type: string }[] }));
        const label = rows[0]?.label ?? channelId;
        const msg = status === 'restricted'
          ? `⚠️ הערוץ "${label}" הוגבל או נחסם על ידי הפלטפורמה (חשד). עצרו שליחה אוטומטית ובדקו את החשבון.`
          : `⚠️ הערוץ "${label}" התנתק (${status}). נדרש קישור מחדש.`;
        await audit(this.db, { action: 'channel.alert', target: channelId, meta: { status } }).catch(() => undefined);
        void sendAlert(this.cfg, msg, { channelId, status });
      }
    }
    this.emit({ channelId, type: 'status', status });
  }

  async start(channelId: string, opts?: StartOptions): Promise<void> {
    if (this.adapters.has(channelId)) return;
    const { rows } = await this.db.query('SELECT type FROM channels WHERE id=$1', [channelId]);
    if (!rows[0]) throw new Error('not_found');
    const adapter = this.factory(rows[0].type, {
      channelId,
      store: createAuthStore(this.db, channelId, this.cfg.ENCRYPTION_KEY),
      events: {
        onStatus: (s) => void this.setStatus(channelId, s),
        onPairingCode: (code) => {
          this.lastCode.set(channelId, code);
          this.emit({ channelId, type: 'pairing_code', code });
        },
        onQr: (qr) => {
          void QRCode.toDataURL(qr, { margin: 2, width: 320 }).then((url) => {
            this.lastQr.set(channelId, url);
            this.emit({ channelId, type: 'qr', qr: url });
          });
        },
        onMessage: async (m) => {
          const r = await ingestInbound(this.db, channelId, m, { floodLimit: this.cfg.FLOOD_LIMIT });
          if (r.flooded) {
            await audit(this.db, { action: 'contact.auto_block', target: r.contactId, meta: { reason: 'flood', limit: this.cfg.FLOOD_LIMIT } }).catch(() => undefined);
            void sendAlert(this.cfg, `🚫 לקוח נחסם אוטומטית עקב הצפת הודעות (יותר מ-${this.cfg.FLOOD_LIMIT} ב-2 דקות).`, { contactId: r.contactId });
          }
          if (r.blocked) return; // blocked contact: stored as evidence, nothing else happens (no files, bot, away reply, routing, notification)
          if (r.messageId && m.media) await this.media.ingestInbound(r.messageId, m.media);
          const bot = r.messageId ? await loadBot(this.db) : null;
          if (r.messageId && bot?.enabled) {
            // the menu bot owns new conversations; people are assigned only at hand-over
            await this.runBot(channelId, r.conversationId, m.externalContactId, bot, m.media ? null : m.text).catch(() => undefined);
          } else if (r.messageId) {
            if (r.needsRouting) {
              const to = await autoAssign(this.db, r.conversationId).catch(() => null);
              if (to) await audit(this.db, { action: 'conversation.auto_assign', target: r.conversationId, meta: { to } }).catch(() => undefined);
            }
            await this.maybeAway(channelId, r.conversationId, m.externalContactId).catch(() => undefined);
          }
          if (r.messageId) this.emit({ channelId, type: 'message', conversationId: r.conversationId, messageId: r.messageId });
        },
      },
    });
    if (!adapter) throw new Error('unsupported_channel_type');
    this.adapters.set(channelId, adapter);
    await this.db.query('UPDATE channels SET auto_start=true WHERE id=$1', [channelId]);
    try {
      await adapter.start(opts);
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
    await this.media.purgeFiles('v.channel_id = $1', [channelId]);
    await this.db.query('DELETE FROM channels WHERE id=$1', [channelId]);
  }

  /** Telegram 2FA: hand the cloud password to the waiting login flow (kept in memory only). */
  submitPassword(channelId: string, password: string): void {
    const a = this.adapters.get(channelId);
    if (!a?.submitPassword || this.statuses.get(channelId) !== 'password') throw new Error('password_not_requested');
    a.submitPassword(password);
  }

  /** All outbound traffic goes through the per-channel lane: human-like spacing, per-minute/day caps, typing indicator. */
  async sendText(channelId: string, externalContactId: string, text: string, opts: { background?: boolean } = {}) {
    const a = this.adapters.get(channelId);
    if (!a || this.statuses.get(channelId) !== 'connected') throw new Error('channel_not_connected');
    const settings = await this.loadSending();
    return this.sender.run(
      channelId,
      settings,
      async () => {
        if (settings.typing && a.typing) await a.typing(externalContactId, Math.min(4000, 400 + text.length * 30)).catch(() => undefined);
        return a.sendText(externalContactId, text);
      },
      { maxWaitMs: opts.background ? 45_000 : 8_000 },
    );
  }

  /** Send-rate view for the health panel. */
  async sendUsage(channelId: string) {
    const settings = await this.loadSending();
    const u = await this.sender.usage(channelId);
    return { ...u, settings };
  }

  private async botSay(channelId: string, convId: string, ext: string, text: string): Promise<void> {
    const sent = await this.sendText(channelId, ext, text, { background: true });
    await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto) VALUES ($1,'out',$2,$3,true) ON CONFLICT DO NOTHING`, [convId, text, sent.externalMessageId ?? null]);
  }

  /** Menu bot: answer, or hand over to a person (assign via routing, leave a note, away notice outside hours). */
  private async runBot(channelId: string, convId: string, ext: string, bot: BotConfig, text: string | null): Promise<void> {
    const { rows } = await this.db.query('SELECT bot_state, bot_invalid, assigned_to FROM conversations WHERE id = $1', [convId]);
    const c = rows[0];
    if (!c || c.assigned_to) return; // a person already owns this conversation
    if (text !== null && text.trim() === '[unsupported message type]') text = null;

    // loop guard: two bots talking to each other. Many automatic replies in a short time => stop and hand over silently.
    const recent = await this.db.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND auto AND created_at > now() - interval '10 minutes'`, [convId]);
    if (recent.rows[0].n >= 8) {
      await this.db.query(`UPDATE conversations SET bot_state = 'human' WHERE id = $1`, [convId]);
      await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, 'הבוט נעצר: יותר מדי הודעות אוטומטיות בזמן קצר (ייתכן בוט בצד הלקוח).')`, [convId]);
      await autoAssign(this.db, convId).catch(() => null);
      return;
    }

    const d = decide(bot, { state: c.bot_state, invalid: c.bot_invalid }, text);
    for (const reply of d.replies) await this.botSay(channelId, convId, ext, reply);
    await this.db.query('UPDATE conversations SET bot_state = $2, bot_invalid = $3 WHERE id = $1', [convId, d.next.state, d.next.invalid]);

    if (d.handoff) {
      const why = { requested: 'הלקוח ביקש נציג', unrecognized: 'הלקוח שלח הודעה שהבוט לא זיהה', media: 'הלקוח שלח קובץ או תוכן שאינו טקסט' }[d.handoff];
      await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)`, [convId, `מועבר מהבוט לנציג: ${why}.`]);
      const to = await autoAssign(this.db, convId).catch(() => null);
      if (to) await audit(this.db, { action: 'conversation.auto_assign', target: convId, meta: { to, via: 'bot' } }).catch(() => undefined);
      const hours = await loadBusinessHours(this.db);
      const closed = hours.enabled && !isOpen(hours, new Date());
      await this.botSay(channelId, convId, ext, closed ? hours.awayMessage : bot.humanMessage);
      if (closed) await this.db.query('UPDATE conversations SET last_away_at = now() WHERE id = $1', [convId]);
    }
  }

  /**
   * Out-of-hours auto reply. Guards against loops/spam: only for a customer's message (never for our own sends),
   * at most once per conversation per 12h, stored as an `auto` message so reports don't count it as a human reply.
   */
  private async maybeAway(channelId: string, conversationId: string, externalContactId: string): Promise<void> {
    const hours = await loadBusinessHours(this.db);
    if (!hours.enabled || isOpen(hours, new Date())) return;
    const claim = await this.db.query(
      `UPDATE conversations SET last_away_at = now()
        WHERE id = $1 AND (last_away_at IS NULL OR last_away_at < now() - interval '12 hours') RETURNING id`,
      [conversationId],
    );
    if (!claim.rowCount) return;
    try {
      const sent = await this.sendText(channelId, externalContactId, hours.awayMessage, { background: true });
      const ins = await this.db.query(
        `INSERT INTO messages (conversation_id, direction, body, external_id, auto) VALUES ($1,'out',$2,$3,true) RETURNING id`,
        [conversationId, hours.awayMessage, sent.externalMessageId ?? null],
      );
      this.emit({ channelId, type: 'message', conversationId, messageId: ins.rows[0].id });
    } catch {
      // channel went away: release the claim so the next customer message can retry
      await this.db.query('UPDATE conversations SET last_away_at = NULL WHERE id = $1', [conversationId]);
    }
  }

  async sendMedia(channelId: string, externalContactId: string, media: OutboundMedia) {
    const a = this.adapters.get(channelId);
    if (!a || this.statuses.get(channelId) !== 'connected') throw new Error('channel_not_connected');
    if (!a.sendMedia) throw new Error('media_unsupported');
    const send = a.sendMedia.bind(a);
    return this.sender.run(channelId, await this.loadSending(), () => send(externalContactId, media), { maxWaitMs: 8_000 });
  }

  async startAll(): Promise<void> {
    const { rows } = await this.db.query('SELECT id FROM channels WHERE auto_start');
    for (const r of rows) await this.start(r.id).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => a.stop().catch(() => undefined)));
  }
}
