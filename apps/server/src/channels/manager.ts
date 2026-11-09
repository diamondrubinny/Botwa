import { runSlaCheck } from '../sla.js';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { ingestInbound } from '../inbox.js';
import { decide, isGreeting, loadBot, normalize, type BotConfig } from '../bot.js';
import { isStopMessage } from '../optout.js';
import { isOpen } from '../business-hours.js';
import { autoAssign } from '../routing.js';
import { audit } from '../audit.js';
import { MediaService } from '../media/store.js';
import type { KnowledgeBase } from '../kb/service.js';
import { conversationEventData, messageEventData } from '../integrations/events.js';
import type { EventType, WebhookService } from '../integrations/webhooks.js';
import { runFlow, type Effect, type FlowContext, type FlowInput, type FlowState } from '../flow/engine.js';
import { resolveArea } from '../safety/areas.js';
import { contactText, officerNote, officersForTopic, pickOfficer } from '../safety/officers.js';
import { forwardText, type ForwardRule } from './forward.js';
import { parseNumberedMenu, type CloudTemplate, type TemplateSend } from './cloud-messages.js';
import { loadFlow } from '../flow/store.js';
import { loadBusinessHours } from '../routes/settings.js';
import { sendAlert } from '../alerts.js';
import { createAuthStore } from './auth-store.js';
import { ChannelSender, loadSending as loadSendingRaw, SendError, TEST_SENDING, type SendingSettings } from './sender.js';
import type { AdapterFactory, ChannelAdapter, ChannelStatus, ChannelType, OutboundMedia, StartOptions } from './types.js';
import { TelegramAdapter } from './telegram.js';
import { CLOUD_CREDS_KEY, newVerifyToken, WhatsAppCloudAdapter, type CloudCreds } from './whatsapp-cloud.js';
import { WebChatAdapter } from './webchat.js';
import { WhatsAppAdapter } from './whatsapp.js';

export type BusEvent =
  | { channelId: string; type: 'status'; status: ChannelStatus }
  | { channelId: string; type: 'qr'; qr: string } // PNG data URL
  | { channelId: string; type: 'pairing_code'; code: string }
  | { channelId: string; type: 'message'; conversationId: string; messageId: string };

export function createDefaultFactory(cfg: Config): AdapterFactory {
  return (type, ctx) => {
    if (type === 'whatsapp') return new WhatsAppAdapter(ctx);
    if (type === 'webchat') return new WebChatAdapter(ctx);
    if (type === 'whatsapp_cloud') return new WhatsAppCloudAdapter(ctx, undefined, cfg.WHATSAPP_GRAPH_VERSION);
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
  private types = new Map<string, ChannelType>();
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
    this.sender.onAutoPause = (channelId, until, failures) => {
      void (async () => {
        await this.db.query('INSERT INTO channel_events (channel_id, kind, detail) VALUES ($1,$2,$3)', [channelId, 'auto_paused', `${failures} failures in a row, paused until ${until.toISOString()}`]).catch(() => undefined);
        await audit(this.db, { action: 'channel.auto_pause', target: channelId, meta: { failures, until: until.toISOString() } }).catch(() => undefined);
        const { rows } = await this.db.query('SELECT label FROM channels WHERE id=$1', [channelId]).catch(() => ({ rows: [] as { label: string }[] }));
        void sendAlert(this.cfg, `⏸️ הערוץ "${rows[0]?.label ?? channelId}" הושהה אוטומטית אחרי ${failures} כשלי שליחה ברצף (עד ${until.toLocaleTimeString('he-IL')}). ייתכן שהפלטפורמה דוחה הודעות.`, { channelId, failures });
      })();
    };
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

  /** Set by the app: outgoing webhooks. All hook* calls are fire-and-forget and can never break message handling. */
  webhooks?: WebhookService;
  hookMessage(type: 'message.received' | 'message.sent', conversationId: string, messageId: string): void {
    const w = this.webhooks;
    if (w) void messageEventData(this.db, conversationId, messageId).then((d) => (d ? w.enqueue(type, d) : undefined)).catch(() => undefined);
  }
  hookConversation(type: Exclude<EventType, 'message.received' | 'message.sent'>, conversationId: string, extra: Record<string, unknown> = {}): void {
    const w = this.webhooks;
    if (w) void conversationEventData(this.db, conversationId).then((d) => (d ? w.enqueue(type, { ...d, ...extra }) : undefined)).catch(() => undefined);
  }

  /** Set by the app: lets the menu bot answer free-text questions from the knowledge base. */
  kb?: KnowledgeBase;

  /** Set by the app: called for each new customer message that reached staff (not blocked, not a duplicate). */
  onInbound?: (conversationId: string) => void;

  /** Set by the app: called once when a waiting customer passes the SLA target. */
  onSlaBreach?: (conversationId: string) => void;

  /** Raise SLA alerts for conversations that have waited past the target (webhook + push). */
  async checkSla(): Promise<number> {
    return runSlaCheck(this.db, (id) => { this.hookConversation('conversation.sla_breached', id); this.onSlaBreach?.(id); });
  }

  private emit(e: BusEvent) {
    this.bus.emit('event', e);
  }

  private groupCache = new Map<string, { at: number; groups: { id: string; name: string; size: number }[] }>();
  /** The WhatsApp groups the linked number belongs to (asked of WhatsApp at most every 5 minutes unless refreshed). */
  async listGroups(channelId: string, refresh = false): Promise<{ id: string; name: string; size: number }[]> {
    const a = this.adapters.get(channelId);
    if (!a?.listGroups || this.statuses.get(channelId) !== 'connected') throw new Error('channel_not_connected');
    const c = this.groupCache.get(channelId);
    if (!refresh && c && Date.now() - c.at < 300_000) return c.groups;
    const groups = await a.listGroups();
    this.groupCache.set(channelId, { at: Date.now(), groups });
    return groups;
  }

  /** Post a message into a group through the channel's normal sending lane (pacing, caps). Recorded first, so a failure is retried later; an automatic forward is recorded once per rule and conversation. */
  async forwardToGroup(o: { ruleId: string | null; convId: string | null; channelId: string; jid: string; text: string; trigger: 'handoff' | 'manual' | 'test'; by: string | null }): Promise<boolean> {
    const ins = await this.db.query(
      `INSERT INTO forward_log (rule_id, conversation_id, channel_id, group_jid, text, trigger, by_user) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
      [o.ruleId, o.convId, o.channelId, o.jid, o.text, o.trigger, o.by]);
    if (!ins.rows[0]) return false;
    return this.deliverForward(ins.rows[0].id as number);
  }
  private async deliverForward(id: number): Promise<boolean> {
    const r = (await this.db.query(`SELECT channel_id, group_jid, text, tries FROM forward_log WHERE id = $1 AND status = 'pending'`, [id])).rows[0];
    if (!r) return false;
    try {
      await this.sendText(r.channel_id, r.group_jid, r.text, { background: true });
      await this.db.query(`UPDATE forward_log SET status = 'sent', sent_at = now(), tries = tries + 1 WHERE id = $1`, [id]);
      return true;
    } catch {
      await this.db.query(`UPDATE forward_log SET tries = tries + 1, status = CASE WHEN tries + 1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id = $1`, [id]);
      return false;
    }
  }
  /** Forwards that could not be sent (channel down) go out when it is back; gives up after five tries or a day. */
  async retryForwards(): Promise<number> {
    await this.db.query(`UPDATE forward_log SET status = 'failed' WHERE status = 'pending' AND created_at < now() - interval '1 day'`);
    const { rows } = await this.db.query(`SELECT id, channel_id FROM forward_log WHERE status = 'pending' AND tries < 5 ORDER BY id LIMIT 20`);
    let n = 0;
    for (const r of rows) if (this.statuses.get(r.channel_id) === 'connected' && (await this.deliverForward(r.id))) n++;
    return n;
  }
  /** When the bot hands a conversation to people: post it into the groups of every matching rule. */
  private async autoForward(convId: string): Promise<void> {
    const rules = (await this.db.query(`SELECT * FROM forward_rules WHERE enabled AND on_handoff`)).rows as ForwardRule[];
    if (!rules.length) return;
    const tags = (await this.db.query('SELECT tag_id FROM conversation_tags WHERE conversation_id = $1', [convId])).rows.map((r) => r.tag_id as string);
    for (const rule of rules) {
      if (rule.tag_ids.length && !rule.tag_ids.some((t) => tags.includes(t))) continue;
      const text = await forwardText(this.db, convId, rule, this.cfg.APP_ORIGIN);
      if (text) await this.forwardToGroup({ ruleId: rule.id, convId, channelId: rule.channel_id, jid: rule.group_jid, text, trigger: 'handoff', by: null });
    }
  }

  private templateCache = new Map<string, { at: number; list: CloudTemplate[] }>();
  /** The templates of an official-WhatsApp channel (cached for 5 minutes unless refreshed). */
  async cloudTemplates(channelId: string, refresh = false): Promise<CloudTemplate[]> {
    const a = this.cloudAdapter(channelId);
    if (!a || !a.isActive()) throw new Error('channel_not_connected');
    const c = this.templateCache.get(channelId);
    if (!refresh && c && Date.now() - c.at < 300_000) return c.list;
    const list = await a.listTemplates();
    this.templateCache.set(channelId, { at: Date.now(), list });
    return list;
  }
  async createCloudTemplate(channelId: string, t: Parameters<WhatsAppCloudAdapter['createTemplate']>[0]) {
    const a = this.cloudAdapter(channelId);
    if (!a || !a.isActive()) throw new Error('channel_not_connected');
    const r = await a.createTemplate(t);
    this.templateCache.delete(channelId);
    return r;
  }
  /** Send an approved template to a customer through the channel's normal lane. */
  async sendTemplate(channelId: string, externalContactId: string, t: TemplateSend): Promise<{ externalMessageId?: string }> {
    const a = this.cloudAdapter(channelId);
    if (!a || this.statuses.get(channelId) !== 'connected') throw new Error('channel_not_connected');
    await this.assertNotPaused(channelId);
    const settings = this.effective(channelId, await this.loadSending());
    return this.sender.run(channelId, settings, async () => a.sendTemplate(externalContactId, t), { maxWaitMs: 8_000 });
  }
  /** A menu as buttons or a list. Returns false when the channel cannot, or the menu does not fit, or Meta refuses it: the caller then sends the numbered text. */
  async sendMenu(channelId: string, externalContactId: string, body: string, options: { id: string; title: string }[]): Promise<{ externalMessageId?: string } | null> {
    const a = this.adapters.get(channelId);
    if (!a?.sendInteractive || this.statuses.get(channelId) !== 'connected') return null;
    await this.assertNotPaused(channelId);
    const settings = this.effective(channelId, await this.loadSending());
    try { return await this.sender.run(channelId, settings, async () => a.sendInteractive!(externalContactId, body, options), { maxWaitMs: 45_000 }); } catch (e) {
      if (e instanceof SendError) throw e;
      return null;
    }
  }

  private statusSince = new Map<string, number>();
  private revive = new Map<string, { at: number; tries: number }>();

  /**
   * Keeps linked channels connected without anybody pressing anything. A channel that was working once, is meant to run (not stopped by a
   * person), and has dropped to "error" or "stopped" - or has been "connecting" for too long - is started again, with a growing wait between
   * tries (30 s, 1 min, 2 min ... up to 15 min). It never touches: a channel a person stopped, one the platform logged out or restricted
   * (those need a person), the official API (its state is the token), or a channel that was never linked.
   */
  async supervise(): Promise<number> {
    let started = 0;
    const { rows } = await this.db.query(
      `SELECT c.id, c.type FROM channels c WHERE c.auto_start AND c.type IN ('whatsapp', 'telegram')
          AND EXISTS (SELECT 1 FROM channel_events e WHERE e.channel_id = c.id AND e.kind = 'connected')`);
    const now = Date.now();
    for (const r of rows) {
      const id = r.id as string;
      const status = this.statuses.get(id);
      if (status === 'connected') { this.revive.delete(id); continue; }
      if (status && ['logged_out', 'restricted', 'password', 'qr'].includes(status)) continue;
      const stuck = status === 'connecting' && now - (this.statusSince.get(id) ?? now) > 6 * 60_000;
      if (!(status === undefined || status === 'error' || status === 'stopped' || stuck)) continue;
      const st = this.revive.get(id) ?? { at: 0, tries: 0 };
      const wait = this.cfg.NODE_ENV === 'test' ? 0 : Math.min(15 * 60_000, 30_000 * 2 ** st.tries);
      if (now - st.at < wait) continue;
      this.revive.set(id, { at: now, tries: st.tries + 1 });
      try {
        if (stuck) { const a = this.adapters.get(id); this.adapters.delete(id); await a?.stop().catch(() => undefined); }
        await this.start(id);
        await this.db.query('INSERT INTO channel_events (channel_id, kind) VALUES ($1,$2)', [id, 'auto_restart']).catch(() => undefined);
        started++;
      } catch { /* the next round tries again, later */ }
    }
    return started;
  }

  private async setStatus(channelId: string, status: ChannelStatus) {
    const prev = this.statuses.get(channelId);
    this.statuses.set(channelId, status);
    if (prev !== status) this.statusSince.set(channelId, Date.now());
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
    // back online: answer the customers whose messages the bot could not answer while the channel was down
    if (status === 'connected' && prev !== 'connected') setTimeout(() => { void this.catchUp(channelId).catch(() => undefined); void this.retryForwards().catch(() => undefined); }, this.cfg.NODE_ENV === 'test' ? 30 : 4000).unref?.();
  }

  async start(channelId: string, opts?: StartOptions): Promise<void> {
    if (this.adapters.has(channelId)) return;
    const { rows } = await this.db.query('SELECT type FROM channels WHERE id=$1', [channelId]);
    if (!rows[0]) throw new Error('not_found');
    this.types.set(channelId, rows[0].type as ChannelType);
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
          const stop = !!r.messageId && !m.media && isStopMessage(m.text);
          if (stop) {
            await this.db.query('UPDATE contacts SET opted_out = true, opted_out_at = now() WHERE id = $1', [r.contactId]);
            await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, 'הלקוח ביקש להפסיק לקבל הודעות. לא יישלחו אליו הודעות אוטומטיות או הודעות צוות עד שיכתוב שוב.')`, [r.conversationId]);
          } else if (r.optedOut) {
            await this.db.query('UPDATE contacts SET opted_out = false, opted_out_at = NULL WHERE id = $1', [r.contactId]); // they wrote again: conversation is welcome
          }
          const bot = r.messageId ? await loadBot(this.db) : null;
          if (r.messageId && stop) {
            // customer said stop: no bot, no away reply - a person decides what happens next
            if (r.needsRouting) await autoAssign(this.db, r.conversationId).catch(() => null);
          } else if (r.messageId && bot?.enabled) {
            // the menu bot owns new conversations; people are assigned only at hand-over
            await this.attemptBot(channelId, r.conversationId, m.externalContactId, bot, { text: m.text, media: !!m.media, ext: m.externalMessageId }, true);
          } else if (r.messageId) {
            if (r.needsRouting) {
              const to = await autoAssign(this.db, r.conversationId).catch(() => null);
              if (to) await audit(this.db, { action: 'conversation.auto_assign', target: r.conversationId, meta: { to } }).catch(() => undefined);
            }
            await this.maybeAway(channelId, r.conversationId, m.externalContactId).catch(() => undefined);
          }
          if (r.messageId) this.emit({ channelId, type: 'message', conversationId: r.conversationId, messageId: r.messageId });
          if (r.messageId && !r.blocked) { this.onInbound?.(r.conversationId); this.hookMessage('message.received', r.conversationId, r.messageId); }
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
    await this.assertNotPaused(channelId);
    const settings = this.effective(channelId, await this.loadSending());
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

  private reactLog = new Map<string, { minute: number[]; day: number; dayStart: number }>();
  private reactHistory: { at: number; channelId: string; emoji: string; outcome: string }[] = [];
  /** The last reaction attempts and what became of each (for the "why is there no reaction" panel). */
  reactionHistory() { return [...this.reactHistory]; }
  private noteReact(channelId: string, emoji: string, outcome: string) { this.reactHistory.push({ at: Date.now(), channelId, emoji, outcome }); if (this.reactHistory.length > 30) this.reactHistory.shift(); }

  /**
   * An emoji reaction on the customer's message. Reactions answer a message the customer just sent, so they are the safest kind of
   * traffic; still capped per channel (30 a minute, 600 a day), skipped when the channel is not connected, paused or restricted, never
   * waits in the pacing queue (it must appear at once), and never throws: a reaction is a courtesy, not part of the answer.
   */
  async react(channelId: string, externalContactId: string, externalMessageId: string, emoji: string): Promise<boolean> {
    const a = this.adapters.get(channelId);
    if (!a?.react) { this.noteReact(channelId, emoji, 'no_support'); return false; }
    if (this.statuses.get(channelId) !== 'connected') { this.noteReact(channelId, emoji, 'not_connected'); return false; }
    try { await this.assertNotPaused(channelId); } catch { this.noteReact(channelId, emoji, 'paused'); return false; }
    const now = Date.now();
    const l = this.reactLog.get(channelId) ?? { minute: [], day: 0, dayStart: now };
    if (now - l.dayStart > 86_400_000) { l.day = 0; l.dayStart = now; }
    l.minute = l.minute.filter((t) => now - t < 60_000);
    if (l.minute.length >= 30 || l.day >= 600) { this.reactLog.set(channelId, l); this.noteReact(channelId, emoji, 'rate_limited'); return false; }
    l.minute.push(now); l.day++; this.reactLog.set(channelId, l);
    try {
      await Promise.race([a.react(externalContactId, externalMessageId, emoji), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      this.noteReact(channelId, emoji, 'sent');
      return true;
    } catch (e) { this.noteReact(channelId, emoji, `error:${(e as Error).message.slice(0, 80)}`); return false; }
  }

  /** What the bot does with the reactions of one incoming message: show it is working, then replace that by how it went. */
  private reactor(channelId: string, ext: string, inboundId: string | undefined, bot: BotConfig) {
    let cur = '';
    let greeted = false;
    return {
      /** a greeting gets its own reaction (👋) and keeps it: later working/done marks are skipped, a hand-over still shows */
      greet: async (text: string | null): Promise<void> => {
        if (!bot.reactions.enabled || !inboundId || !bot.reactions.greeting || !isGreeting(text)) return;
        if (await this.react(channelId, ext, inboundId, bot.reactions.greeting)) { cur = bot.reactions.greeting; greeted = true; }
      },
      set: async (ev: 'working' | 'done' | 'noAnswer' | 'handoff'): Promise<void> => {
        if (!bot.reactions.enabled || !inboundId) return;
        if (greeted && ev !== 'handoff') return;
        const e = bot.reactions[ev];
        if (e === cur) return;                       // same reaction already there (or none to remove)
        if (await this.react(channelId, ext, inboundId, e)) cur = e;
      },
    };
  }

  /** The official API needs no human-like pacing or warm-up (Meta enforces its own limits); the per-minute/day caps still apply. */
  private effective(channelId: string, s: SendingSettings): SendingSettings {
    return ['whatsapp_cloud', 'webchat'].includes(this.types.get(channelId) ?? '') ? { ...s, warmup: false, typing: false, minDelayMs: 0, maxDelayMs: Math.min(s.maxDelayMs, 300) } : s;
  }

  // ---- Official WhatsApp (Cloud API) -------------------------------------------------------------------------------
  /** The running official-API adapter for webhook handling (null when the channel is not started or is another type). */
  cloudAdapter(channelId: string): WhatsAppCloudAdapter | null {
    const a = this.adapters.get(channelId);
    return a instanceof WhatsAppCloudAdapter ? a : null;
  }

  /** The running website-chat adapter, for the public widget API (null when the channel is not started or is another type). */
  webchatAdapter(channelId: string): WebChatAdapter | null {
    const a = this.adapters.get(channelId);
    return a instanceof WebChatAdapter ? a : null;
  }

  /** Wake long-polling widgets: a message (from staff, the bot or the customer) was stored for this conversation. */
  notifyMessage(channelId: string, conversationId: string, messageId: string): void {
    this.emit({ channelId, type: 'message', conversationId, messageId });
  }

  async getCloudConfig(channelId: string): Promise<{ configured: boolean; phoneNumberId?: string; verifyToken?: string; wabaId?: string }> {
    const raw = await createAuthStore(this.db, channelId, this.cfg.ENCRYPTION_KEY).get(CLOUD_CREDS_KEY);
    if (!raw) return { configured: false };
    const c = JSON.parse(raw) as CloudCreds;
    return { configured: true, phoneNumberId: c.phoneNumberId, verifyToken: c.verifyToken, wabaId: c.wabaId };
  }

  /** Save the official-API credentials (encrypted at rest) and restart the channel so they take effect. The verify token is kept across edits. */
  async setCloudCredentials(channelId: string, c: { phoneNumberId: string; accessToken: string; appSecret: string; wabaId?: string }): Promise<void> {
    const store = createAuthStore(this.db, channelId, this.cfg.ENCRYPTION_KEY);
    const prev = await store.get(CLOUD_CREDS_KEY);
    const old = prev ? (JSON.parse(prev) as CloudCreds) : null;
    const verifyToken = old?.verifyToken ?? newVerifyToken();
    await store.set(CLOUD_CREDS_KEY, JSON.stringify({ ...c, wabaId: c.wabaId ?? old?.wabaId, verifyToken } satisfies CloudCreds));
    this.templateCache.delete(channelId);
    const a = this.adapters.get(channelId);
    if (a) await a.stop().catch(() => undefined);
    await this.start(channelId);
  }

  private async assertNotPaused(channelId: string): Promise<void> {
    const { rows } = await this.db.query('SELECT paused FROM channels WHERE id = $1', [channelId]);
    if (rows[0]?.paused) throw new SendError('channel_paused');
  }

  /** Manual emergency stop/resume of ALL outbound messages of a channel (incoming messages keep arriving). */
  async setPaused(channelId: string, paused: boolean): Promise<void> {
    await this.db.query('UPDATE channels SET paused = $2, paused_at = CASE WHEN $2 THEN now() END WHERE id = $1', [channelId, paused]);
    if (!paused) this.sender.resume(channelId);
    await this.db.query('INSERT INTO channel_events (channel_id, kind) VALUES ($1,$2)', [channelId, paused ? 'paused' : 'resumed']).catch(() => undefined);
  }

  isAutoPausedUntil(channelId: string): number { return this.sender.pausedUntil(channelId); }

  /** Read receipts for the customer's unread messages (what a person does when opening a chat). Best effort, never throws. */
  async markRead(channelId: string, conversationId: string, externalContactId: string): Promise<void> {
    try {
      const a = this.adapters.get(channelId);
      if (!a?.markRead || this.statuses.get(channelId) !== 'connected') return;
      if (!(await this.loadSending()).readReceipts) return;
      const { rows } = await this.db.query(
        `SELECT id, external_id FROM messages WHERE conversation_id = $1 AND direction = 'in' AND NOT read_sent AND external_id IS NOT NULL ORDER BY created_at DESC LIMIT 50`,
        [conversationId],
      );
      if (rows.length === 0) return;
      await a.markRead(externalContactId, rows.map((r) => r.external_id as string));
      await this.db.query('UPDATE messages SET read_sent = true WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
    } catch { /* cosmetic */ }
  }

  /** Send-rate view for the health panel. */
  async sendUsage(channelId: string) {
    const settings = await this.loadSending();
    const u = await this.sender.usage(channelId);
    return { ...u, settings };
  }

  private async botSay(channelId: string, convId: string, ext: string, text: string): Promise<void> {
    const sent = await this.sendText(channelId, ext, text, { background: true });
    const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto) VALUES ($1,'out',$2,$3,true) ON CONFLICT DO NOTHING RETURNING id`, [convId, text, sent.externalMessageId ?? null]);
    if (ins.rows[0]) { this.notifyMessage(channelId, convId, ins.rows[0].id); this.hookMessage('message.sent', convId, ins.rows[0].id); }
  }

  /** The bot's replies of one step; when the last is its menu and the channel can show buttons or a list, send the menu that way (the text is kept in the conversation either way). */
  private async botSayAll(channelId: string, convId: string, ext: string, bot: BotConfig, replies: string[], menu: boolean | undefined): Promise<void> {
    for (let i = 0; i < replies.length; i++) {
      const reply = replies[i]!;
      if (menu && i === replies.length - 1 && bot.interactiveMenus) {
        const parsed = parseNumberedMenu(reply);
        const sent = parsed ? await this.sendMenu(channelId, ext, parsed.body, parsed.options).catch((e) => { if (e instanceof SendError) throw e; return null; }) : null;
        if (sent) {
          const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto) VALUES ($1,'out',$2,$3,true) ON CONFLICT DO NOTHING RETURNING id`, [convId, reply, sent.externalMessageId ?? null]);
          if (ins.rows[0]) { this.notifyMessage(channelId, convId, ins.rows[0].id); this.hookMessage('message.sent', convId, ins.rows[0].id); }
          continue;
        }
      }
      await this.botSay(channelId, convId, ext, reply);
    }
  }

  /** Menu bot: answer, or hand over to a person (assign via routing, leave a note, away notice outside hours). */
  /** A confident knowledge-base answer for a free-text message, formatted for the customer; null when unsure (then the normal menu flow applies). */
  private async kbAnswer(bot: BotConfig, state: string | null, text: string | null, inFlow = false, onSearch?: () => Promise<void>): Promise<string | null> {
    if (!this.kb || (!bot.kb.enabled && !inFlow) || state === 'human' || !text) return null;
    const t = text.trim();
    if (/^\d{1,2}$/.test(t) || t.length < 3) return null;
    // a request for a person is answered by handing over, not by a search (the decision below would ignore the answer anyway)
    const norm = normalize(t);
    if (bot.humanKeywords.some((k) => norm.includes(normalize(k)))) return null;
    try {
      await onSearch?.();
      const a = await this.kb.answer(t, { minScore: bot.kb.minScore, maxChars: bot.kb.maxChars });
      if (!a) return null;
      return [bot.kb.intro, a.text, bot.kb.showSource ? `מקור: ${a.url ?? a.title}` : ''].filter(Boolean).join('\n\n');
    } catch { return null; }
  }

  /**
   * Run the bot for one customer message, and remember the message until the bot has really answered it. If the channel is down or
   * sending fails, the message stays "pending" and catchUp() answers it when the channel is back (see bot.catchupHours).
   * Replies are sent before the bot's state changes, so running the same message again is safe.
   */
  private async attemptBot(channelId: string, convId: string, contact: string, bot: BotConfig, p: { text: string | null; media: boolean; ext: string }, fresh: boolean): Promise<boolean> {
    if (fresh && bot.catchupHours > 0) await this.db.query('UPDATE conversations SET bot_pending_at = now(), bot_pending_ext = $2, bot_pending_text = $3, bot_pending_media = $4, bot_tries = 0 WHERE id = $1', [convId, p.ext, p.text, p.media]).catch(() => undefined);
    try {
      await this.runBot(channelId, convId, contact, bot, p.text, p.media, p.ext);
      await this.db.query('UPDATE conversations SET bot_pending_at = NULL, bot_pending_text = NULL, bot_pending_ext = NULL WHERE id = $1 AND bot_pending_ext = $2', [convId, p.ext]).catch(() => undefined);
      return true;
    } catch {
      if (fresh && bot.catchupHours > 0) await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, 'הבוט לא הצליח לענות להודעה האחרונה (הערוץ מנותק או שהשליחה נכשלה). הוא ינסה שוב כשהחיבור יחזור.')`, [convId]).catch(() => undefined);
      return false;
    }
  }

  private catching = false;
  /** Answer the customer messages the bot could not answer earlier, for connected channels, oldest first. Gives up after bot.catchupHours or 5 tries. */
  async catchUp(only?: string): Promise<number> {
    if (this.catching) return 0;
    this.catching = true;
    let answered = 0;
    try {
      const bot = await loadBot(this.db);
      const { rows } = await this.db.query(
        `SELECT c.id, c.channel_id AS "channelId", ct.external_id AS ext, c.bot_pending_ext AS "pendingExt", c.bot_pending_text AS text, c.bot_pending_media AS media, c.bot_pending_at AS "at", c.bot_tries AS tries
           FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.bot_pending_at IS NOT NULL AND ($1::uuid IS NULL OR c.channel_id = $1) ORDER BY c.bot_pending_at LIMIT 30`, [only ?? null]);
      for (const r of rows) {
        if (this.statuses.get(r.channelId) !== 'connected') continue;           // wait for the channel
        const ageH = (Date.now() - new Date(r.at).getTime()) / 3_600_000;
        if (!bot.enabled || bot.catchupHours === 0 || ageH > bot.catchupHours || r.tries >= 5) {
          await this.db.query('UPDATE conversations SET bot_pending_at = NULL, bot_pending_text = NULL, bot_pending_ext = NULL WHERE id = $1', [r.id]);
          if (bot.enabled && bot.catchupHours > 0) await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, 'הבוט לא ענה להודעה האחרונה של הלקוח (ניסיונות חוזרים נכשלו או שעבר זמן רב). יש לטפל בה ידנית.')`, [r.id]).catch(() => undefined);
          continue;
        }
        await this.db.query('UPDATE conversations SET bot_tries = bot_tries + 1 WHERE id = $1', [r.id]);
        if (await this.attemptBot(r.channelId, r.id, r.ext, bot, { text: r.text, media: r.media, ext: r.pendingExt }, false)) answered++;
      }
    } finally { this.catching = false; }
    return answered;
  }

  private async runBot(channelId: string, convId: string, ext: string, bot: BotConfig, rawText: string | null, hasMedia = false, inboundId?: string): Promise<void> {
    const rx = this.reactor(channelId, ext, inboundId, bot);
    let text: string | null = hasMedia ? null : rawText;
    const { rows } = await this.db.query('SELECT bot_state, bot_invalid, bot_item, assigned_to FROM conversations WHERE id = $1', [convId]);
    const c = rows[0];
    if (!c || c.assigned_to) return; // a person already owns this conversation
    if (c.bot_state === 'human') return; // handed over (or stopped by the loop guard): silent, no reactions either, until a person closes it
    if (text !== null && text.trim() === '[unsupported message type]') text = null;

    // loop guard: two bots talking to each other. A person going through a flow quickly (identification: 6-8 short answers)
    // must not trip it, so it looks for what only a machine does: the same text again and again, or many messages a minute,
    // or a very long run of automatic replies.
    const g = (await this.db.query(
      `SELECT (SELECT count(*) FROM messages WHERE conversation_id = $1 AND auto AND created_at > now() - interval '10 minutes')::int AS auto10,
              (SELECT count(*) FROM messages WHERE conversation_id = $1 AND direction = 'in' AND created_at > now() - interval '60 seconds')::int AS in60,
              (SELECT coalesce(max(n), 0) FROM (SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'in' AND body <> '' AND created_at > now() - interval '10 minutes' GROUP BY lower(trim(body))) x)::int AS same10`,
      [convId])).rows[0] as { auto10: number; in60: number; same10: number };
    if (g.same10 >= 5 || g.in60 >= 20 || g.auto10 >= 40) {
      await this.db.query(`UPDATE conversations SET bot_state = 'human' WHERE id = $1`, [convId]);
      await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, 'הבוט נעצר: נראה שבצד הלקוח עונה בוט (אותה הודעה שוב ושוב, או הודעות רבות מאוד בזמן קצר).')`, [convId]);
      await autoAssign(this.db, convId).catch(() => null);
      return;
    }

    await rx.greet(text);
    if (bot.reactions.ackAll) await rx.set('working');   // "seen, working on it" for every message the bot handles
    if (bot.mode === 'flow') {
      const flow = await loadFlow(this.db);
      if (flow) { await this.runFlowStep(channelId, convId, ext, bot, flow, { text: rawText !== null && rawText.trim() === '[unsupported message type]' ? null : rawText, media: hasMedia }, rx); return; }
    }

    let searched = false;
    const kbText = c.bot_state === 'area' ? null : await this.kbAnswer(bot, c.bot_state, text, false, async () => { searched = true; await rx.set('working'); });
    const d = decide(bot, { state: c.bot_state, invalid: c.bot_invalid, item: c.bot_item }, text, kbText);
    await this.botSayAll(channelId, convId, ext, bot, d.replies, d.menu);
    await this.db.query('UPDATE conversations SET bot_state = $2, bot_invalid = $3, bot_item = $4 WHERE id = $1', [convId, d.next.state, d.next.invalid, d.next.state === 'area' ? d.next.item ?? null : null]);

    if (d.handoff) await rx.set('handoff');
    else if (searched) await rx.set(kbText ? 'done' : 'noAnswer');
    else if (bot.reactions.ackAll) await rx.set('done');
    if (d.handoff) {
      const why = { requested: 'הלקוח ביקש נציג', unrecognized: 'הלקוח שלח הודעה שהבוט לא זיהה', media: 'הלקוח שלח קובץ או תוכן שאינו טקסט', topic: `הלקוח בחר בנושא "${d.topic?.title ?? ''}"` }[d.handoff];
      let userId = d.topic?.userId;
      if (d.topic && d.topic.place) {
        // routed by area: the officer responsible for the place the customer wrote, else the topic's own officer
        userId = (await resolveArea(this.db, d.topic.place).catch(() => null)) ?? userId;
        await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)`, [convId, `מיקום שנמסר: ${d.topic.place}`]).catch(() => undefined);
      }
      await this.handoffNow(channelId, convId, ext, bot, why, d.topic ? { userId: userId!, topic: d.topic.title } : undefined);
    }
  }

  /** Hand a bot conversation to a person: note, assignment (the named person if active, else normal routing), then the hand-over or away notice. */
  private async handoffNow(channelId: string, convId: string, ext: string, bot: BotConfig, why: string, topic?: { userId: string; topic: string }, customText?: string, extra?: string): Promise<void> {
    await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)`, [convId, `מועבר מהבוט לנציג: ${why}.`]);
    let to: string | null = null;
    if (topic) {
      // the person responsible for the chosen topic gets the conversation (if they are still active); otherwise normal routing
      const r = await this.db.query(`UPDATE conversations SET assigned_to = u.id FROM users u WHERE conversations.id = $1 AND u.id = $2 AND u.active RETURNING u.id`, [convId, topic.userId]).catch(() => ({ rows: [] as { id: string }[] }));
      to = (r.rows[0]?.id as string | undefined) ?? null;
      if (to) await audit(this.db, { action: 'conversation.topic_assign', target: convId, meta: { to, topic: topic.topic } }).catch(() => undefined);
    }
    if (!to) to = await autoAssign(this.db, convId).catch(() => null);
    if (to && !topic) await audit(this.db, { action: 'conversation.auto_assign', target: convId, meta: { to, via: 'bot' } }).catch(() => undefined);
    const hours = await loadBusinessHours(this.db);
    const closed = hours.enabled && !isOpen(hours, new Date());
    await this.botSay(channelId, convId, ext, [closed ? hours.awayMessage : customText || bot.humanMessage, extra].filter(Boolean).join('\n\n'));
    if (closed) await this.db.query('UPDATE conversations SET last_away_at = now() WHERE id = $1', [convId]);
    void this.autoForward(convId).catch(() => undefined);
  }

  /** The flow chart bot: one customer message in, replies + side effects out (see flow/engine.ts). */
  private async runFlowStep(channelId: string, convId: string, ext: string, bot: BotConfig, flow: NonNullable<Awaited<ReturnType<typeof loadFlow>>>, input: FlowInput, rx: ReturnType<ChannelManager['reactor']>): Promise<void> {
    let searched = false, found = false;
    const row = (await this.db.query('SELECT c.flow_state, ct.profile FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1', [convId])).rows[0];
    const st = row?.flow_state as FlowState | null;
    const hours = await loadBusinessHours(this.db);
    const ctx: FlowContext = {
      isOpen: !hours.enabled || isOpen(hours, new Date()),
      channelType: this.types.get(channelId) ?? 'whatsapp',
      humanKeywords: bot.humanKeywords, humanOption: bot.humanOption, invalidRetries: bot.invalidRetries, invalidMessage: bot.invalidMessage,
      profile: (row?.profile ?? {}) as Record<string, string>,
      resolveArea: (t) => resolveArea(this.db, t),
      kbAnswer: async (t) => { const a = await this.kbAnswer(bot, null, t, true, async () => { searched = true; await rx.set('working'); }); if (a) found = true; return a; },
      matchOption: async (t, options) => this.kb?.matchOption(t, options) ?? null,
      kbSuggest: async (t) => {
        if (!this.kb || t.trim().length < 3) return [];
        const hits = await this.kb.search(t, { audience: 'bot', limit: 5 }).catch(() => []);
        // only entries with real evidence: two or more of the question's words, an exact phrase, or a strong meaning match
        return hits.filter((h) => h.score >= bot.kb.minScore * 0.5 && (h.exact || h.matched >= 2 || h.sem >= bot.kb.minScore * 0.8)).slice(0, 3).map((h) => ({ id: h.sourceId, label: h.title.replace(/\s+/g, ' ').slice(0, 70) }));
      },
      kbSource: async (id, q) => {
        const a = await this.kb?.answerFor(id, q, { minScore: bot.kb.minScore, maxChars: bot.kb.maxChars }).catch(() => null);
        return a ? [bot.kb.intro, a.text, bot.kb.showSource ? `מקור: ${a.url ?? a.title}` : ''].filter(Boolean).join('\n\n') : null;
      },
    };
    const r = await runFlow(flow, st, input, ctx, bot.humanLabel);
    await this.botSayAll(channelId, convId, ext, bot, r.replies, r.menu);
    const handoff = r.effects.find((e): e is Extract<Effect, { kind: 'handoff' }> => e.kind === 'handoff');
    if (handoff) await rx.set('handoff'); else if (searched) await rx.set(found ? 'done' : 'noAnswer'); else if (bot.reactions.ackAll) await rx.set('done');
    await this.db.query('UPDATE conversations SET flow_state = $2, bot_state = $3 WHERE id = $1', [convId, JSON.stringify(r.state), handoff ? 'human' : 'menu']);
    for (const e of r.effects) {
      if (e.kind === 'note') await this.db.query('INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)', [convId, e.text]).catch(() => undefined);
      else if (e.kind === 'tag') await this.db.query('INSERT INTO conversation_tags (conversation_id, tag_id) SELECT $1, id FROM tags WHERE id = $2 ON CONFLICT DO NOTHING', [convId, e.tagId]).catch(() => undefined);
      else if (e.kind === 'profile') await this.db.query(`UPDATE contacts SET profile = profile || $2::jsonb WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`, [convId, JSON.stringify(e.vars)]).catch(() => undefined);
      else if (e.kind === 'name') await this.db.query(`UPDATE contacts SET display_name = $2 WHERE id = (SELECT contact_id FROM conversations WHERE id = $1) AND display_name IS NULL`, [convId, e.value]).catch(() => undefined);
    }
    if (handoff) {
      const why = { requested: 'הלקוח ביקש נציג', unrecognized: 'הלקוח שלח הודעה שהבוט לא זיהה', media: 'הלקוח שלח קובץ או תוכן שאינו טקסט', flow: 'לפי תרשים הזרימה' }[handoff.reason];
      // the officer of the topic named in the node: gets the conversation when they have an account (a place-based choice wins), and is shown to the customer when asked
      let userId = handoff.userId, extra: string | undefined;
      if (handoff.officerTopic) {
        const o = pickOfficer(await officersForTopic(this.db, handoff.officerTopic).catch(() => []));
        if (o) {
          if (!handoff.viaArea && o.userId && o.userActive) userId = o.userId;
          await this.db.query('INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)', [convId, officerNote(handoff.officerTopic, o)]).catch(() => undefined);
          if (handoff.showContact) extra = contactText(o);
        }
      }
      await this.handoffNow(channelId, convId, ext, bot, why, userId ? { userId, topic: handoff.officerTopic ?? 'תרשים זרימה' } : undefined, handoff.text, extra);
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
    await this.assertNotPaused(channelId);
    const send = a.sendMedia.bind(a);
    return this.sender.run(channelId, this.effective(channelId, await this.loadSending()), () => send(externalContactId, media), { maxWaitMs: 8_000 });
  }

  async startAll(): Promise<void> {
    const { rows } = await this.db.query('SELECT id FROM channels WHERE auto_start');
    for (const r of rows) await this.start(r.id).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => a.stop().catch(() => undefined)));
  }
}
