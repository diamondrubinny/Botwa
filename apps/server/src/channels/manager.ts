import type { GovImporter } from '../kb/gov/importer.js';
import type { StandardsImporter } from '../kb/gov/standards.js';
import type { FireImporter } from '../kb/gov/fire.js';
import { runSlaCheck } from '../sla.js';
import { learnNorm, reactionMeaning, recordLearn } from '../learn.js';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { ingestInbound } from '../inbox.js';
import { decide, isGreeting, isThanks, loadBot, normalize, type BotConfig } from '../bot.js';
import { isStopMessage } from '../optout.js';
import { isOpen } from '../business-hours.js';
import { autoAssign } from '../routing.js';
import { audit } from '../audit.js';
import { permissionsOfRole } from '../routes/users.js';
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
import { countUsage, usageAllows, type UsageKind } from '../usage.js';
import { createAuthStore } from './auth-store.js';
import { ChannelSender, loadSending as loadSendingRaw, SendError, TEST_SENDING, type SendingSettings } from './sender.js';
import type { AdapterFactory, ChannelAdapter, ChannelStatus, ChannelType, OutboundMedia, StartOptions } from './types.js';
import { TelegramAdapter } from './telegram.js';
import { CLOUD_CREDS_KEY, newVerifyToken, WhatsAppCloudAdapter, type CloudCreds } from './whatsapp-cloud.js';
import { EMAIL_CREDS_KEY, EmailAdapter, type EmailCreds } from './email.js';
import { closeByCustomer, introduceAgent, isCloseRequest, thankForFeedback } from '../automations.js';
import { composeAnswer, type KbAnswer } from '../kb/compose.js';
import { loadPersona } from '../routes/branding.js';
import { saveUsername } from './username-store.js';
import { isSensitive, pickGif, type GifMoment } from '../bot-gifs.js';
import { isEmergency } from '../emergency.js';
import { isPastReportQuestion, isWaitingQuestion } from '../waiting.js';
import { loadIncident } from '../incident.js';
import { dueReminders, reminderText } from '../safety/inspections.js';
import { officerReply, officerUserFor } from '../safety/whoIs.js';
import { comfortText, detectDistress, stillHereText, type Distress } from '../empathy.js';
import { detectLang, withDirectionMarks, type Lang } from '../i18n/lang.js';
import { dictionary, fromEnglish, localize } from '../i18n/translate.js';
import { factReply } from '../safety/facts.js';
import { hoursSummary } from '../canned.js';
import { staffMessage } from '../staff/assistant.js';
import { detect, sanitizeFileName } from '../media/validate.js';
import { renderBotText, cleanName, identityReply, smallTalkReply, withoutBotName, type BotTextContext } from '../bot-text.js';
import { isCommentContact, META_CREDS_KEY, MetaMessagingAdapter, type CommentReplyMode, type MetaCreds } from './meta-messaging.js';
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
    if (type === 'email') return new EmailAdapter(ctx);
    if (type === 'messenger' || type === 'instagram') return new MetaMessagingAdapter(ctx, type, undefined, cfg.WHATSAPP_GRAPH_VERSION);
    if (type === 'telegram' && cfg.TELEGRAM_API_ID && cfg.TELEGRAM_API_HASH) {
      return new TelegramAdapter(ctx, { apiId: cfg.TELEGRAM_API_ID, apiHash: cfg.TELEGRAM_API_HASH });
    }
    return null;
  };
}

/** After a side answer: how to get the menu (one line, not the menu itself). */
const MENU_HINT = 'לתפריט הראשי כתבו "תפריט".';
/** Under an answer from a Hebrew entry, in an English conversation. */
const KB_HEBREW_NOTE = 'התשובה ממאגר המידע שלנו בעברית. אם צריך עזרה, אפשר לכתוב "נציג".';

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
  /** automatic import of laws and regulations into the knowledge base */
  gov?: GovImporter;
  /** automatic import of the official standards list */
  standards?: StandardsImporter;
  /** automatic import of the fire-safety licensing requirements */
  fire?: FireImporter;

  /** The person who now holds the conversation introduces themselves to the customer (see introduceAgent). Never throws. */
  introduce(convId: string): Promise<boolean> { return introduceAgent(this.db, this, convId).catch(() => false); }

  /** Set by the app: called for each new customer message that reached staff (not blocked, not a duplicate). */
  onInbound?: (conversationId: string) => void;

  /** Set by the app: a conversation was given to a person (alert on their phone). */
  onAssigned?: (conversationId: string, userId: string, how?: 'assigned' | 'handover') => void;
  /** a push to one person (a reminder) */
  onNotifyUser?: (userId: string, title: string, url: string, tag: string) => void;

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
    await this.usageGate(channelId, false);
    const settings = this.effective(channelId, await this.loadSending());
    const out = await this.sender.run(channelId, settings, async () => a.sendTemplate(externalContactId, t), { maxWaitMs: 8_000 });
    await this.usageCount(channelId, 'template');
    return out;
  }
  /** A form to fill inside WhatsApp (Flows): official channel only, same pause, usage and pacing rules as any send. */
  async sendFlow(channelId: string, externalContactId: string, f: Parameters<WhatsAppCloudAdapter['sendFlow']>[1]): Promise<{ externalMessageId?: string }> {
    const a = this.cloudAdapter(channelId);
    if (!a || this.statuses.get(channelId) !== 'connected') throw new Error('channel_not_connected');
    await this.assertNotPaused(channelId);
    await this.usageGate(channelId, false);
    const settings = this.effective(channelId, await this.loadSending());
    const out = await this.sender.run(channelId, settings, async () => a.sendFlow(externalContactId, f), { maxWaitMs: 8_000 });
    await this.usageCount(channelId, 'interactive');
    return out;
  }
  /** Set by the forms module: a form filled in WhatsApp arrived (the message is already stored). */
  onFlowReply?: (a: { channelId: string; conversationId: string; externalContactId: string; messageId: string; responseJson: string }) => Promise<void>;

  /** A menu as buttons or a list. Returns false when the channel cannot, or the menu does not fit, or Meta refuses it: the caller then sends the numbered text. */
  async sendMenu(channelId: string, externalContactId: string, body: string, options: { id: string; title: string }[]): Promise<{ externalMessageId?: string } | null> {
    const a = this.adapters.get(channelId);
    if (!a?.sendInteractive || this.statuses.get(channelId) !== 'connected') return null;
    await this.assertNotPaused(channelId);
    await this.usageGate(channelId, true);
    const settings = this.effective(channelId, await this.loadSending());
    try { const out = await this.sender.run(channelId, settings, async () => a.sendInteractive!(externalContactId, body, options), { maxWaitMs: 45_000 }); await this.usageCount(channelId, 'interactive'); return out; } catch (e) {
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
    if (status === 'stopped' || status === 'logged_out' || status === 'error' || status === 'restricted') {
      // an official channel that failed its credentials check: keep the reason for the settings screen
      const a = this.adapters.get(channelId);
      if (a instanceof WhatsAppCloudAdapter || a instanceof MetaMessagingAdapter || a instanceof EmailAdapter) this.cloudErrors.set(channelId, a.lastError);
      this.adapters.delete(channelId);
    }
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
        onReaction: (ev) => { void this.customerReaction(channelId, ev).catch(() => undefined); },
        onMessage: async (m) => {
          // a linked manager asking Betty about the inquiries (or linking with a code): answered here, never stored as a customer conversation
          if (['whatsapp', 'whatsapp_cloud', 'telegram'].includes(this.types.get(channelId) ?? '') && !m.flowReply) {
            const staff = await staffMessage(this.db, channelId, m.externalContactId, m.media ? null : m.text, this.cfg.APP_ORIGIN.split(',')[0]!.trim()).catch(() => null);
            if (staff !== null) { await this.sendText(channelId, m.externalContactId, staff, { background: true }).catch(() => undefined); return; }
          }
          const r = await ingestInbound(this.db, channelId, m, { floodLimit: this.cfg.FLOOD_LIMIT });
          if (r.externalContactId !== m.externalContactId) m = { ...m, externalContactId: r.externalContactId };   // known by number, came by user id: answer the contact we know
          if (r.flooded) {
            await audit(this.db, { action: 'contact.auto_block', target: r.contactId, meta: { reason: 'flood', limit: this.cfg.FLOOD_LIMIT } }).catch(() => undefined);
            void sendAlert(this.cfg, `🚫 לקוח נחסם אוטומטית עקב הצפת הודעות (יותר מ-${this.cfg.FLOOD_LIMIT} ב-2 דקות).`, { contactId: r.contactId });
          }
          if (r.blocked) return; // blocked contact: stored as evidence, nothing else happens (no files, bot, away reply, routing, notification)
          // the customer's language (Hebrew or English): Betty answers in it, and the conversation shows it as a tag
          if (r.messageId && !m.media && m.text && !isCommentContact(m.externalContactId)) await this.noteLanguage(r.conversationId, m.text).catch(() => undefined);
          // a form filled inside WhatsApp: handled by the forms module (signed PDF), never by the bot
          if (m.flowReply && r.messageId) {
            await this.onFlowReply?.({ channelId, conversationId: r.conversationId, externalContactId: m.externalContactId, messageId: r.messageId, responseJson: m.flowReply.responseJson }).catch(() => undefined);
            this.emit({ channelId, type: 'message', conversationId: r.conversationId, messageId: r.messageId });
            this.hookMessage('message.received', r.conversationId, r.messageId);
            return;
          }
          if (r.rated) {   // a rating for the feedback question: thank them; no bot, no routing, the conversation stays closed
            await thankForFeedback(this.db, this, r.conversationId).catch(() => undefined);
            if (r.messageId) this.emit({ channelId, type: 'message', conversationId: r.conversationId, messageId: r.messageId });
            return;
          }
          if (r.messageId && m.media) await this.media.ingestInbound(r.messageId, m.media);
          const stop = !!r.messageId && !m.media && isStopMessage(m.text);
          if (stop) {
            await this.db.query('UPDATE contacts SET opted_out = true, opted_out_at = now() WHERE id = $1', [r.contactId]);
            await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, 'הלקוח ביקש להפסיק לקבל הודעות. לא יישלחו אליו הודעות אוטומטיות או הודעות צוות עד שיכתוב שוב.')`, [r.conversationId]);
          } else if (r.optedOut) {
            await this.db.query('UPDATE contacts SET opted_out = false, opted_out_at = NULL WHERE id = $1', [r.contactId]); // they wrote again: conversation is welcome
          }
          const bot = r.messageId ? await loadBot(this.db) : null;
          // an emergency: the numbers to call at once and an urgent hand-over, before anything else (no greeting, menu or GIF)
          if (r.messageId && !stop && !m.media && bot?.emergency.enabled && !isCommentContact(m.externalContactId) && isEmergency(m.text)) {
            await this.emergency(channelId, r.conversationId, m.externalContactId, r.messageId, bot.emergency.text).catch(() => undefined);
            this.emit({ channelId, type: 'message', conversationId: r.conversationId, messageId: r.messageId });
            this.onInbound?.(r.conversationId);
            this.hookMessage('message.received', r.conversationId, r.messageId);
            return;
          }
          // a wide emergency is on: the unit's status message, once per conversation for this incident
          if (r.messageId && !stop && !isCommentContact(m.externalContactId) && await this.incidentReply(channelId, r.conversationId, m.externalContactId).catch(() => false)) {
            this.emit({ channelId, type: 'message', conversationId: r.conversationId, messageId: r.messageId });
            this.onInbound?.(r.conversationId);
            this.hookMessage('message.received', r.conversationId, r.messageId);
            return;
          }
          // a stressed or upset customer: the feeling acknowledged, a person at once, and Betty stays until a person answers
          let distress = r.messageId && !stop && !m.media && (bot?.empathy?.enabled ?? true) && !isCommentContact(m.externalContactId) ? detectDistress(m.text) : null;
          // the same message three times in a row in half an hour, with no answer at all in between: the customer feels unheard
          // (answers to the bot's questions, like "דלג" twice, always have the bot's messages in between)
          if (!distress && r.messageId && !stop && !m.media && (bot?.empathy?.enabled ?? true) && !isCommentContact(m.externalContactId) && (m.text ?? '').trim().length >= 2) {
            const last = (await this.db.query(
              `SELECT body, created_at FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 3`, [r.conversationId])).rows as { body: string | null; created_at: Date }[];
            const same = last.length === 3 && last.every((x) => (x.body ?? '').trim().toLowerCase() === (m.text ?? '').trim().toLowerCase())
              && Date.now() - new Date(last[2]!.created_at).getTime() < 30 * 60_000;
            if (same) {
              const answered = (await this.db.query(`SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'out' AND automation IS NULL AND created_at > $2 LIMIT 1`, [r.conversationId, last[2]!.created_at])).rowCount;
              if (!answered) distress = 'upset';
            }
          }
          if (distress && r.messageId && await this.comfort(channelId, r.conversationId, m.externalContactId, r.messageId, m.text ?? '', distress).catch(() => false)) {
            this.emit({ channelId, type: 'message', conversationId: r.conversationId, messageId: r.messageId });
            this.onInbound?.(r.conversationId);
            this.hookMessage('message.received', r.conversationId, r.messageId);
            return;
          }
          // a thank-you or praise ("תודה רבה", "אתם אחלה") gets a heart (or the chosen emoji), whoever handles the conversation
          let thanked = '';
          if (r.messageId && !stop && !m.media && bot?.reactions.thanks && !isCommentContact(m.externalContactId) && isThanks(m.text)) {
            if ((await this.setOurReaction(r.messageId, bot.reactions.thanks, null).catch(() => 'error')) === 'ok') thanked = bot.reactions.thanks;
          }
          // "הסתדרתי" / "תסגרו את הקריאה": the customer closes the inquiry; no bot, routing or away reply for this message
          if (r.messageId && !stop && !m.media && !isCommentContact(m.externalContactId) && isCloseRequest(m.text)
              && await closeByCustomer(this.db, this, r.conversationId, m.text ?? '').catch(() => false)) {
            await this.botGif(channelId, r.conversationId, 'close', bot ?? undefined);
            this.emit({ channelId, type: 'message', conversationId: r.conversationId, messageId: r.messageId });
            this.hookMessage('message.received', r.conversationId, r.messageId);   // no "new message" push: it is closed, nothing to do
            this.hookConversation('conversation.status_changed', r.conversationId);
            return;
          }
          // "מתי חוזרים אליי?" while the inquiry is with the team: where it stands, instead of silence (the team is notified as usual)
          // "מה עם הדיווח שלי מאתמול?" about an inquiry that was closed (this message only reopened the conversation): what became of it
          const told = !!r.messageId && !stop && !m.media && !isCommentContact(m.externalContactId) && (isPastReportQuestion(m.text) || isWaitingQuestion(m.text))
            && await this.pastReportStatus(channelId, r.conversationId, m.externalContactId, isPastReportQuestion(m.text)).catch(() => false);
          const waited = !told && !!r.messageId && !stop && !m.media && !isCommentContact(m.externalContactId) && isWaitingQuestion(m.text)
            && await this.waitingStatus(channelId, r.conversationId, m.externalContactId).catch(() => false);
          // "מי הממונה על לייזרים?" while the inquiry is with the team: the officer's public details, unless a person is answering now
          const informed = !waited && !told && !!r.messageId && !stop && !m.media && !isCommentContact(m.externalContactId)
            && await this.officerWhileWaiting(channelId, r.conversationId, m.externalContactId, m.text).catch(() => false);
          if (waited || informed || told) {
            // nothing more: no bot and no away notice for this message
          } else if (r.messageId && stop) {
            // customer said stop: no bot, no away reply - a person decides what happens next
            if (r.needsRouting) await autoAssign(this.db, r.conversationId).catch(() => null);
          } else if (r.messageId && isCommentContact(m.externalContactId)) {
            // a public comment: never answered automatically (no bot, no away reply); a person decides, in public or in private
            if (r.needsRouting) { const to = await autoAssign(this.db, r.conversationId).catch(() => null); if (to) this.onAssigned?.(r.conversationId, to); }
          } else if (r.messageId && bot?.enabled) {
            // the menu bot owns new conversations; people are assigned only at hand-over
            await this.attemptBot(channelId, r.conversationId, m.externalContactId, bot, { text: m.text, media: !!m.media, ext: m.externalMessageId, thanked }, true);
          } else if (r.messageId) {
            if (r.needsRouting) {
              const to = await autoAssign(this.db, r.conversationId).catch(() => null);
              if (to) await audit(this.db, { action: 'conversation.auto_assign', target: r.conversationId, meta: { to } }).catch(() => undefined);
              if (to) { this.onAssigned?.(r.conversationId, to); void this.introduce(r.conversationId); }
            }
            await this.maybeAway(channelId, r.conversationId, m.externalContactId).catch(() => undefined);
          }
          // a new inquiry that stays with the person who held the conversation: they introduce themselves again (no-op otherwise)
          if (r.messageId && !stop && !isCommentContact(m.externalContactId)) await this.introduce(r.conversationId);
          if (r.messageId) this.emit({ channelId, type: 'message', conversationId: r.conversationId, messageId: r.messageId });
          if (r.messageId && !r.blocked) { this.onInbound?.(r.conversationId); this.hookMessage('message.received', r.conversationId, r.messageId); }
        },
      },
    });
    if (!adapter) throw new Error('unsupported_channel_type');
    this.adapters.set(channelId, adapter);
    // Meta reports a change of the number's business username (when the app is subscribed to business_username_updates)
    if (adapter instanceof WhatsAppCloudAdapter) adapter.onUsernameUpdate = (v) => { void saveUsername(this.db, channelId, v).catch(() => undefined); };
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

  /** Official WhatsApp: the key of the number's monthly count (its phone number id), or null for other channels. */
  usageKey(channelId: string): string | null {
    if (this.types.get(channelId) !== 'whatsapp_cloud') return null;
    return this.cloudAdapter(channelId)?.numberId ?? `channel:${channelId}`;
  }

  /** Refuses a message when the number's monthly limit is reached and the channel is set to stop (all, or automatic messages only). */
  private async usageGate(channelId: string, auto: boolean): Promise<void> {
    const key = this.usageKey(channelId);
    if (key && !(await usageAllows(this.db, key, channelId, auto))) throw new SendError('monthly_limit');
  }

  /** Counts a message that went out and alerts once at the warning level and once at the limit. Never fails the send. */
  private async usageCount(channelId: string, kind: UsageKind): Promise<void> {
    const key = this.usageKey(channelId);
    if (!key) return;
    try {
      const r = await countUsage(this.db, key, channelId, kind);
      if (!r.crossed) return;
      const label = (await this.db.query('SELECT label FROM channels WHERE id = $1', [channelId])).rows[0]?.label ?? '';
      const what = r.crossed === 'reached'
        ? `הגיע למגבלה החודשית: ${r.total} מתוך ${r.limit.limit} הודעות יוצאות.${r.limit.action === 'block_all' ? ' השליחה בערוץ נעצרה עד תחילת החודש הבא.' : r.limit.action === 'block_auto' ? ' הודעות אוטומטיות (בוט, מענה מחוץ לשעות, אוטומציות) נעצרו עד תחילת החודש הבא; נציגים עדיין יכולים לענות.' : ' השליחה ממשיכה (מוגדר "התראה בלבד").'}`
        : `הגיע ל-${r.limit.warnAt}% מהמגבלה החודשית: ${r.total} מתוך ${r.limit.limit} הודעות יוצאות.`;
      await this.db.query('INSERT INTO channel_events (channel_id, kind, detail) VALUES ($1,$2,$3)', [channelId, r.crossed === 'reached' ? 'monthly_limit_reached' : 'monthly_limit_warning', what]).catch(() => undefined);
      void sendAlert(this.cfg, `📊 ווצאפ רשמי "${label}" ${what}`, { channelId });
    } catch { /* counting must never break sending */ }
  }

  /** All outbound traffic goes through the per-channel lane: human-like spacing, per-minute/day caps, typing indicator. */
  async sendText(channelId: string, externalContactId: string, text: string, opts: { background?: boolean } = {}) {
    const a = this.adapters.get(channelId);
    if (!a || this.statuses.get(channelId) !== 'connected') throw new Error('channel_not_connected');
    await this.assertNotPaused(channelId);
    await this.usageGate(channelId, !!opts.background);
    const settings = this.effective(channelId, await this.loadSending());
    const out = await this.sender.run(
      channelId,
      settings,
      async () => {
        if (settings.typing && a.typing) await a.typing(externalContactId, Math.min(4000, 400 + text.length * 30)).catch(() => undefined);
        // apps that align each line by its first letter (WhatsApp, Telegram, SMS, Messenger): invisible marks keep each line the
        // message's way; the website chat and e-mail lay out the direction themselves
        const t = this.types.get(channelId);
        return a.sendText(externalContactId, t === 'webchat' || t === 'email' ? text : withDirectionMarks(text));
      },
      { maxWaitMs: opts.background ? 45_000 : 8_000 },
    );
    await this.usageCount(channelId, 'text');
    return out;
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
    return (await this.reactOutcome(channelId, externalContactId, externalMessageId, emoji, true)) === 'sent';
  }

  /** Same as react(), with the reason when it was not sent: no_support, not_connected, paused, rate_limited, error. */
  async reactOutcome(channelId: string, externalContactId: string, externalMessageId: string, emoji: string, auto = true): Promise<'sent' | 'no_support' | 'not_connected' | 'paused' | 'rate_limited' | 'monthly_limit' | 'error'> {
    const a = this.adapters.get(channelId);
    if (!a?.react) { this.noteReact(channelId, emoji, 'no_support'); return 'no_support'; }
    if (this.statuses.get(channelId) !== 'connected') { this.noteReact(channelId, emoji, 'not_connected'); return 'not_connected'; }
    try { await this.assertNotPaused(channelId); } catch { this.noteReact(channelId, emoji, 'paused'); return 'paused'; }
    try { await this.usageGate(channelId, auto); } catch { this.noteReact(channelId, emoji, 'monthly_limit'); return 'monthly_limit'; }
    const now = Date.now();
    const l = this.reactLog.get(channelId) ?? { minute: [], day: 0, dayStart: now };
    if (now - l.dayStart > 86_400_000) { l.day = 0; l.dayStart = now; }
    l.minute = l.minute.filter((t) => now - t < 60_000);
    if (l.minute.length >= 30 || l.day >= 600) { this.reactLog.set(channelId, l); this.noteReact(channelId, emoji, 'rate_limited'); return 'rate_limited'; }
    l.minute.push(now); l.day++; this.reactLog.set(channelId, l);
    try {
      await Promise.race([a.react(externalContactId, externalMessageId, emoji), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      this.noteReact(channelId, emoji, 'sent');
      await this.usageCount(channelId, 'reaction');
      return 'sent';
    } catch (e) { this.noteReact(channelId, emoji, `error:${(e as Error).message.slice(0, 80)}`); return 'error'; }
  }

  /**
   * Our emoji on one customer message (a staff member's choice, or the automatic thank-you heart when `by` is null); empty removes it.
   * Sent to the platform where it has reactions; the website chat shows it in the widget. Stored on the message so the inbox shows it.
   */
  async setOurReaction(messageId: string, emoji: string, by: string | null): Promise<'ok' | 'not_found' | 'no_support' | 'not_connected' | 'paused' | 'rate_limited' | 'monthly_limit' | 'error'> {
    const m = (await this.db.query(
      `SELECT m.id, m.external_id, m.conversation_id, m.our_reaction, ct.external_id AS contact, c.channel_id, ch.type
         FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id
        WHERE m.id = $1 AND m.direction = 'in'`, [messageId])).rows[0] as { id: string; external_id: string | null; conversation_id: string; our_reaction: string | null; contact: string; channel_id: string; type: string } | undefined;
    if (!m) return 'not_found';
    if ((m.our_reaction ?? '') === emoji) return 'ok';
    if (m.type !== 'webchat') {
      if (!m.external_id || isCommentContact(m.contact)) return 'no_support';
      const out = await this.reactOutcome(m.channel_id, m.contact, m.external_id, emoji, by === null);
      if (out !== 'sent') return out;
    }
    await this.db.query(`UPDATE messages SET our_reaction = NULLIF($2, ''), our_reaction_by = CASE WHEN $2 = '' THEN NULL ELSE $3::uuid END, our_reaction_at = CASE WHEN $2 = '' THEN NULL ELSE now() END WHERE id = $1`, [m.id, emoji, by]);
    this.emit({ channelId: m.channel_id, type: 'message', conversationId: m.conversation_id, messageId: m.id });
    return 'ok';
  }

  /** What the bot does with the reactions of one incoming message: show it is working, then replace that by how it went. */
  private reactor(channelId: string, ext: string, inboundId: string | undefined, bot: BotConfig, thanked = '') {
    let cur = thanked;
    let greeted = !!thanked;   // a thank-you heart stays, like the greeting wave
    return {
      /** a greeting gets its own reaction (👋) and keeps it: later working/done marks are skipped, a hand-over still shows */
      greet: async (text: string | null): Promise<void> => {
        if (greeted || !bot.reactions.enabled || !inboundId || !bot.reactions.greeting || !isGreeting(text)) return;
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
    const type = this.types.get(channelId) ?? '';
    // official WhatsApp: no daily cap (its own monthly limit applies instead); the per-minute cap still stops runaway loops
    return ['whatsapp_cloud', 'webchat', 'messenger', 'instagram', 'email'].includes(type) ? { ...s, warmup: false, typing: false, minDelayMs: 0, maxDelayMs: Math.min(s.maxDelayMs, 300), ...(type === 'whatsapp_cloud' ? { perDay: 20_000 } : {}) } : s;
  }

  // ---- Official WhatsApp (Cloud API) -------------------------------------------------------------------------------
  /** The running official-API adapter for webhook handling (null when the channel is not started or is another type). */
  private cloudErrors = new Map<string, string | null>();
  /** Why the official channel's last credentials check failed (null when it did not fail or the reason is unknown). */
  cloudLastError(channelId: string): string | null { return (this.cloudAdapter(channelId) ?? this.metaAdapter(channelId) ?? this.emailAdapter(channelId))?.lastError ?? this.cloudErrors.get(channelId) ?? null; }

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

  /** When a signed webhook from Meta last arrived for each official channel (since this server started). */
  private cloudWebhookAt = new Map<string, string>();
  noteCloudWebhook(channelId: string): void { this.cloudWebhookAt.set(channelId, new Date().toISOString()); }
  /**
   * The last request Meta (or anyone) made to the channel's webhook and what happened to it: the screen can then tell
   * "Meta never reached the server" from "it reached it but the App secret / verify token does not match".
   */
  private webhookAttempt = new Map<string, { at: string; outcome: string }>();
  noteWebhookAttempt(channelId: string, outcome: 'ok' | 'bad_signature' | 'unsigned' | 'not_running' | 'handshake_ok' | 'handshake_bad_token'): void {
    this.webhookAttempt.set(channelId, { at: new Date().toISOString(), outcome });
  }
  lastWebhookAttempt(channelId: string): { at: string; outcome: string } | null { return this.webhookAttempt.get(channelId) ?? null; }

  async getCloudConfig(channelId: string): Promise<{ configured: boolean; phoneNumberId?: string; verifyToken?: string; wabaId?: string; lastWebhookAt?: string | null; lastAttempt?: { at: string; outcome: string } | null }> {
    const raw = await createAuthStore(this.db, channelId, this.cfg.ENCRYPTION_KEY).get(CLOUD_CREDS_KEY);
    if (!raw) return { configured: false };
    const c = JSON.parse(raw) as CloudCreds;
    return { configured: true, phoneNumberId: c.phoneNumberId, verifyToken: c.verifyToken, wabaId: c.wabaId, lastWebhookAt: this.cloudWebhookAt.get(channelId) ?? null, lastAttempt: this.lastWebhookAttempt(channelId) };
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

  /** Antivirus check for files staff hand to a channel (e.g. a profile picture). */
  scanFile(buf: Buffer) { return this.media.scanBuffer(buf); }

  /** Change the profile picture of a connected WhatsApp channel (QR or official). */
  async setProfilePhoto(channelId: string, image: Buffer, mime: 'image/png' | 'image/jpeg'): Promise<string> {
    const a = this.adapters.get(channelId);
    if (!a || this.statuses.get(channelId) !== 'connected') return 'channel_not_connected';
    if (!a.setProfilePhoto) return 'profile_photo_unsupported';
    return a.setProfilePhoto(image, mime);
  }

  // ---- Messenger / Instagram (Meta Messenger Platform) -----------------------------------------------------------------
  metaAdapter(channelId: string): MetaMessagingAdapter | null {
    const a = this.adapters.get(channelId);
    return a instanceof MetaMessagingAdapter ? a : null;
  }

  /** Reply to a comment (public or private) through the channel's sending limits. */
  async replyComment(channelId: string, commentId: string, text: string, mode: CommentReplyMode) {
    const a = this.metaAdapter(channelId);
    if (!a || this.statuses.get(channelId) !== 'connected') throw new Error('channel_not_connected');
    await this.assertNotPaused(channelId);
    return this.sender.run(channelId, this.effective(channelId, await this.loadSending()), () => a.replyComment(commentId, text, mode), { maxWaitMs: 8_000 });
  }

  async getMetaConfig(channelId: string): Promise<{ configured: boolean; pageId?: string; igAccountId?: string; verifyToken?: string; lastWebhookAt?: string | null; comments?: boolean; lastAttempt?: { at: string; outcome: string } | null }> {
    const raw = await createAuthStore(this.db, channelId, this.cfg.ENCRYPTION_KEY).get(META_CREDS_KEY);
    if (!raw) return { configured: false };
    const c = JSON.parse(raw) as MetaCreds;
    return { configured: true, pageId: c.pageId, igAccountId: c.igAccountId, verifyToken: c.verifyToken, lastWebhookAt: this.cloudWebhookAt.get(channelId) ?? null, comments: !!c.comments, lastAttempt: this.lastWebhookAttempt(channelId) };
  }

  /** Save Page credentials (encrypted at rest) and restart the channel. The verify token is kept across edits. */
  async setMetaCredentials(channelId: string, c: { pageId: string; pageAccessToken: string; appSecret: string; igAccountId?: string; comments?: boolean }): Promise<void> {
    const store = createAuthStore(this.db, channelId, this.cfg.ENCRYPTION_KEY);
    const prev = await store.get(META_CREDS_KEY);
    const old = prev ? (JSON.parse(prev) as MetaCreds) : null;
    await store.set(META_CREDS_KEY, JSON.stringify({ ...c, verifyToken: old?.verifyToken ?? newVerifyToken() } satisfies MetaCreds));
    const a = this.adapters.get(channelId);
    if (a) await a.stop().catch(() => undefined);
    await this.start(channelId);
  }

  // ---- E-mail (IMAP/SMTP) -------------------------------------------------------------------------------------------------
  emailAdapter(channelId: string): EmailAdapter | null {
    const a = this.adapters.get(channelId);
    return a instanceof EmailAdapter ? a : null;
  }
  /** the mailbox settings without the password */
  async getEmailConfig(channelId: string): Promise<{ configured: boolean } & Partial<Omit<EmailCreds, 'password'>>> {
    const raw = await createAuthStore(this.db, channelId, this.cfg.ENCRYPTION_KEY).get(EMAIL_CREDS_KEY);
    if (!raw) return { configured: false };
    const { password: _pw, ...rest } = JSON.parse(raw) as EmailCreds;
    return { configured: true, ...rest };
  }
  /** Save (encrypted at rest) and reconnect. An empty password keeps the saved one, so other fields can be edited without retyping it. */
  async setEmailCredentials(channelId: string, c: Omit<EmailCreds, 'password'> & { password?: string }): Promise<boolean> {
    const store = createAuthStore(this.db, channelId, this.cfg.ENCRYPTION_KEY);
    const prev = await store.get(EMAIL_CREDS_KEY);
    const password = c.password || (prev ? (JSON.parse(prev) as EmailCreds).password : '');
    if (!password) return false;
    await store.set(EMAIL_CREDS_KEY, JSON.stringify({ ...c, password } satisfies EmailCreds));
    const a = this.adapters.get(channelId);
    if (a) await a.stop().catch(() => undefined);
    await this.start(channelId);
    return true;
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

  /** The conversation's language (Hebrew unless the customer writes in English). */
  async langOf(convId: string): Promise<Lang> {
    return ((await this.db.query('SELECT lang FROM conversations WHERE id = $1', [convId]).catch(() => ({ rows: [] as { lang: string }[] }))).rows[0]?.lang === 'en' ? 'en' : 'he');
  }
  /** A message of Betty's in the conversation's language (so the stored copy is exactly what the customer got). */
  async say(convId: string, text: string): Promise<string> { return localize(this.db, await this.langOf(convId), text); }

  /** The customer wrote in Hebrew or in English: remember it on the conversation; an English one gets an "English" tag the team sees. */
  async noteLanguage(convId: string, text: string): Promise<Lang | null> {
    const lang = detectLang(text);
    if (!lang) return null;
    const r = await this.db.query(`UPDATE conversations SET lang = $2 WHERE id = $1 AND lang IS DISTINCT FROM $2 RETURNING id`, [convId, lang]);
    if (!r.rowCount) return lang;
    // Hebrew is the default: only an English conversation gets a tag ("English"); writing in Hebrew again takes it off
    if (lang === 'en') {
      await this.db.query(`INSERT INTO tags (name) SELECT 'English' WHERE NOT EXISTS (SELECT 1 FROM tags WHERE lower(name) = 'english')`).catch(() => undefined);
      await this.db.query(`INSERT INTO conversation_tags (conversation_id, tag_id) SELECT $1, id FROM tags WHERE lower(name) = 'english' ON CONFLICT DO NOTHING`, [convId]);
    } else {
      await this.db.query(`DELETE FROM conversation_tags WHERE conversation_id = $1 AND tag_id IN (SELECT id FROM tags WHERE lower(name) = 'english')`, [convId]);
    }
    return lang;
  }

  private async botSay(channelId: string, convId: string, ext: string, textIn: string): Promise<void> {
    const text = await this.say(convId, textIn);
    const sent = await this.sendText(channelId, ext, text, { background: true });
    const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto) VALUES ($1,'out',$2,$3,true) ON CONFLICT DO NOTHING RETURNING id`, [convId, text, sent.externalMessageId ?? null]);
    if (ins.rows[0]) { this.notifyMessage(channelId, convId, ins.rows[0].id); this.hookMessage('message.sent', convId, ins.rows[0].id); }
  }

  /** Who the bot is (its persona name) and what we know to call the customer: the name they gave the bot, else their profile name. */
  private async botTextContext(convId: string, nameHint?: string, lang: Lang = 'he'): Promise<BotTextContext> {
    const [persona0, row] = await Promise.all([
      loadPersona(this.db).catch(() => null),
      this.db.query(`SELECT ct.profile->>'fullName' AS full_name, ct.display_name FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`, [convId]).then((r) => r.rows[0]).catch(() => undefined),
    ]);
    // in English, the bot's name as translated ("בטי" → "Betty")
    const persona = persona0 && lang === 'en' ? { ...persona0, name: (await dictionary(this.db)).exact.get(persona0.name?.trim() ?? '') ?? persona0.name } : persona0;
    return { botName: persona?.name, fullName: cleanName(nameHint) || cleanName(row?.full_name) || cleanName(row?.display_name) };
  }

  /** The bot's replies of one step; when the last is its menu and the channel can show buttons or a list, send the menu that way (the text is kept in the conversation either way). */
  private async botSayAll(channelId: string, convId: string, ext: string, bot: BotConfig, rawReplies: string[], menu: boolean | undefined, nameHint?: string): Promise<void> {
    const lang = await this.langOf(convId);
    const localized = lang === 'en' ? await Promise.all(rawReplies.map((r) => localize(this.db, lang, r))) : rawReplies;
    const replies = localized.some((r) => r.includes('{')) ? await this.botTextContext(convId, nameHint, lang).then((c) => localized.map((r) => renderBotText(r, c))) : localized;
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

  /** The knowledge-base answer in the chosen wording: the passage itself, or a local model's wording of the passages only. */
  async wordAnswer(bot: BotConfig, question: string, a: KbAnswer): Promise<string> {
    const persona = await loadPersona(this.db).catch(() => null);
    return composeAnswer({ url: this.cfg.LOCAL_LLM_URL, model: this.cfg.LOCAL_LLM_MODEL, timeoutMs: this.cfg.LOCAL_LLM_TIMEOUT_MS }, bot, question, a, persona?.name || 'העוזר/ת', undefined, persona?.role || undefined);
  }

  /** Menu bot: answer, or hand over to a person (assign via routing, leave a note, away notice outside hours). */
  /** A confident knowledge-base answer for a free-text message, formatted for the customer; null when unsure (then the normal menu flow applies). */
  private async kbAnswer(bot: BotConfig, state: string | null, text: string | null, inFlow = false, onSearch?: () => Promise<void>, onFound?: (sourceId: string) => void, lang?: Lang): Promise<string | null> {
    if (!this.kb || (!bot.kb.enabled && !inFlow) || state === 'human' || !text) return null;
    const t = text.trim();
    if (/^\d{1,2}$/.test(t) || t.length < 3) return null;
    // a request for a person is answered by handing over, not by a search (the decision below would ignore the answer anyway)
    const norm = normalize(t);
    if (bot.humanKeywords.some((k) => norm.includes(normalize(k)))) return null;
    try {
      await onSearch?.();
      const a = await this.kb.answer(t, { minScore: bot.kb.minScore, maxChars: bot.kb.maxChars }, 'bot', 'bot', lang);
      if (!a) return null;
      onFound?.(a.sourceId);
      const worded = await this.wordAnswer(bot, t, a);
      // an English conversation answered from a Hebrew entry: say so (the line is translated with the rest of the message)
      return lang === 'en' && a.lang !== 'en' ? `${worded}\n\n${KB_HEBREW_NOTE}` : worded;
    } catch { return null; }
  }

  /**
   * Run the bot for one customer message, and remember the message until the bot has really answered it. If the channel is down or
   * sending fails, the message stays "pending" and catchUp() answers it when the channel is back (see bot.catchupHours).
   * Replies are sent before the bot's state changes, so running the same message again is safe.
   */
  /** One bot run at a time per conversation: two quick messages (or a catch-up during a slow reply) must not both answer from the same state. */
  private botRuns = new Map<string, Promise<unknown>>();
  private serial<T>(convId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.botRuns.get(convId) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.botRuns.set(convId, next);
    void next.catch(() => undefined).finally(() => { if (this.botRuns.get(convId) === next) this.botRuns.delete(convId); });
    return next;
  }

  private attemptBot(channelId: string, convId: string, contact: string, bot: BotConfig, p: { text: string | null; media: boolean; ext: string; thanked?: string }, fresh: boolean): Promise<boolean> {
    return this.serial(convId, async () => {
      if (!fresh) {
        // a catch-up: answer only if that exact message is still waiting (a run that just finished may have answered it)
        const still = (await this.db.query('SELECT 1 FROM conversations WHERE id = $1 AND bot_pending_ext = $2', [convId, p.ext])).rowCount;
        if (!still) return false;
      }
      return this.attemptBotNow(channelId, convId, contact, bot, p, fresh);
    });
  }

  private async attemptBotNow(channelId: string, convId: string, contact: string, bot: BotConfig, p: { text: string | null; media: boolean; ext: string; thanked?: string }, fresh: boolean): Promise<boolean> {
    if (fresh && bot.catchupHours > 0) await this.db.query('UPDATE conversations SET bot_pending_at = now(), bot_pending_ext = $2, bot_pending_text = $3, bot_pending_media = $4, bot_tries = 0 WHERE id = $1', [convId, p.ext, p.text, p.media]).catch(() => undefined);
    try {
      await this.runBot(channelId, convId, contact, bot, p.text, p.media, p.ext, p.thanked);
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
        if (this.botRuns.has(r.id)) continue;                                    // the bot is answering it right now
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

  private async runBot(channelId: string, convId: string, ext: string, bot: BotConfig, rawText: string | null, hasMedia = false, inboundId?: string, thanked = ''): Promise<void> {
    const rx = this.reactor(channelId, ext, inboundId, bot, thanked);
    let text: string | null = hasMedia ? null : rawText;
    const { rows } = await this.db.query('SELECT bot_state, bot_invalid, bot_item, assigned_to, flow_state, lang FROM conversations WHERE id = $1', [convId]);
    const c = rows[0];
    if (!c || c.assigned_to) return; // a person already owns this conversation
    // English commands and option names are read as the Hebrew ones the flow knows ("menu" → "תפריט", "Lasers" → "לייזרים")
    if (c.lang === 'en' && text) { text = await fromEnglish(this.db, text); rawText = text; }
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

    // the bot's own name is not part of the question ("היי בטי" is a greeting, "בטי, מה זה…" searches "מה זה…")
    const persona = (await loadPersona(this.db).catch(() => null)) ?? { name: '', role: '' };
    text = withoutBotName(text, persona.name);
    rawText = withoutBotName(rawText, persona.name);
    if (c.lang === 'en') {   // "Betty, are you there?": her English name is not part of the question either
      const en = (await dictionary(this.db)).exact.get(persona.name?.trim() ?? '');
      if (en) { text = withoutBotName(text, en); rawText = withoutBotName(rawText, en); }
    }
    // "מי את?" / "את בוט?" / "מה שלומך?": the bot answers as itself, then picks up the question it was waiting for
    const told = async () => {
      const r = (await this.db.query(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'out' AND (body LIKE '💡 הידעת?%' OR body LIKE '💡 Did you know?%') ORDER BY created_at DESC LIMIT 30`, [convId])).rows.map((x) => x.body as string);
      const last = (await this.db.query(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY created_at DESC LIMIT 1`, [convId])).rows[0]?.body as string | undefined;
      return { r, lastWasFact: !!last && (last.startsWith('💡 הידעת?') || last.startsWith('💡 Did you know?')) };
    };
    const chat = identityReply(text, persona) ?? smallTalkReply(text, persona.name);   // small talk: nothing to lose if the flow opens after it
    const own = chat ?? await officerReply(this.db, text).catch(() => null)
      ?? await told().then(({ r, lastWasFact }) => factReply(text, r, lastWasFact)).catch(() => null);
    if (own) {
      const st = c.flow_state as FlowState | null;
      const flow = bot.mode === 'flow' ? await loadFlow(this.db) : null;
      const node = flow && st?.node && !st.done ? flow.nodes.find((n) => n.id === st.node) : undefined;
      // an answer with information (officer, safety fact) stays the last thing on the screen: never the whole menu again after
      // it (it pushes the answer out of sight). In the middle of a question, the question once more; otherwise one line on how
      // to get the menu. Only small talk at the very start is followed by the flow's opening.
      const opening = !!chat && !!flow && (!st || (st.node === null && !st.done));   // "היי, מה נשמע?" to start with: the flow opens as usual
      const resume = node?.type === 'question' ? `\n\nנמשיך: ${node.text}` : opening ? '' : flow || bot.mode === 'menu' ? `\n\n${MENU_HINT}` : '';
      await this.botSay(channelId, convId, ext, `${own}${resume}`);
      if (opening) await this.runFlowStep(channelId, convId, ext, bot, flow!, { text: null, media: false }, rx);
      return;
    }
    await rx.greet(text);
    if (bot.reactions.ackAll) await rx.set('working');   // "seen, working on it" for every message the bot handles
    // the moment for a GIF: a thank-you, or the start of a new inquiry (the bot's opening message)
    const moment = (fresh: boolean): GifMoment | null => (text && isThanks(text) ? 'thanks' : fresh ? 'greeting' : null);
    if (bot.mode === 'flow') {
      const flow = await loadFlow(this.db);
      if (flow) {
        const st = c.flow_state as FlowState | null;
        const fresh = !st || st.node === null || st.done === true;
        await this.runFlowStep(channelId, convId, ext, bot, flow, { text: rawText !== null && rawText.trim() === '[unsupported message type]' ? null : rawText, media: hasMedia }, rx);
        const mo = moment(fresh);
        if (mo) await this.botGif(channelId, convId, mo, bot);
        return;
      }
    }

    let searched = false;
    let answeredFrom: string | null = null;
    const kbText = c.bot_state === 'area' ? null : await this.kbAnswer(bot, c.bot_state, text, false, async () => { searched = true; await rx.set('working'); }, (id) => { answeredFrom = id; }, c.lang === 'en' ? 'en' : 'he');
    const d = decide(bot, { state: c.bot_state, invalid: c.bot_invalid, item: c.bot_item }, text, kbText);
    const stepStart: Date = (await this.db.query('SELECT now() AS t')).rows[0].t;   // database clock, like the messages' own times
    await this.botSayAll(channelId, convId, ext, bot, d.replies, d.menu);
    if (answeredFrom && kbText && d.replies.some((x) => x.includes(kbText))) await this.tagAnswer(convId, answeredFrom, stepStart);
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
      await this.handoffNow(channelId, convId, ext, bot, why, d.topic ? { userId: userId!, topic: d.topic.title } : undefined, undefined, undefined, text && isThanks(text) ? 'thanks' : 'handoff');
    }
    const mo = moment(c.bot_state === null);
    if (mo && !d.handoff) await this.botGif(channelId, convId, mo, bot);
  }

  /**
   * The bot adds a fitting GIF from the gallery at a pleasant moment (greeting, thanks, hand-over, closing). Restrained on
   * purpose: never on sensitive topics (accident, injury, fire, emergency…), never to blocked or opted-out customers or public
   * comments, at most one per conversation within the cool-down, only on channels that can show it. Never throws.
   */
  async botGif(channelId: string, convId: string, moment: GifMoment, bot?: BotConfig): Promise<boolean> {
    try {
      const b = bot ?? await loadBot(this.db);
      if (!b.enabled || !b.gifs.enabled || !b.gifs[moment] || !this.media.enabled) return false;
      const a = this.adapters.get(channelId);
      if (!a?.sendMedia || this.statuses.get(channelId) !== 'connected') return false;
      const c = (await this.db.query(
        `SELECT ct.external_id AS ext, ct.blocked, ct.opted_out,
                (SELECT string_agg(body, ' ') FROM (SELECT body FROM messages WHERE conversation_id = c.id AND direction = 'in' AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 15) x) AS recent,
                (SELECT string_agg(t.name, ' ') FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = c.id) AS tags
           FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`, [convId])).rows[0] as { ext: string; blocked: boolean; opted_out: boolean; recent: string | null; tags: string | null } | undefined;
      if (!c || c.blocked || c.opted_out || isCommentContact(c.ext)) return false;
      if (isSensitive(`${c.recent ?? ''} ${c.tags ?? ''}`)) return false;
      // claim the cool-down first, so two moments at once (a hand-over right after a greeting) send one GIF
      const claim = await this.db.query(`UPDATE conversations SET last_bot_gif_at = now() WHERE id = $1 AND (last_bot_gif_at IS NULL OR last_bot_gif_at <= now() - make_interval(mins => $2::int)) RETURNING id`, [convId, b.gifs.cooldownMinutes]);
      if (!claim.rowCount) return false;
      // the official API shows animations only as MP4 (see whatsapp-cloud.ts): only GIFs that have their MP4 copy
      const g = await pickGif(this.db, moment, this.types.get(channelId) === 'whatsapp_cloud');
      const d = g ? await detect(g.gif) : null;
      if (!g || d?.mime !== 'image/gif') { await this.db.query('UPDATE conversations SET last_bot_gif_at = NULL WHERE id = $1', [convId]); return false; }
      const fileName = sanitizeFileName(`${g.title.replace(/[\\/]+/g, '-')}.gif`, 'animation.gif');
      const sent = await this.sendMedia(channelId, c.ext, { buffer: g.gif, mime: 'image/gif', fileName, ...(g.mp4 ? { animation: g.mp4 } : {}) });
      const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto) VALUES ($1,'out','',$2,true) RETURNING id`, [convId, sent.externalMessageId ?? null]);
      await this.media.storeSent(ins.rows[0].id, g.gif, d, fileName);
      this.notifyMessage(channelId, convId, ins.rows[0].id);
      this.hookMessage('message.sent', convId, ins.rows[0].id);
      return true;
    } catch {
      // keep the cool-down even when sending failed: no retry storm on a channel that cannot take media right now
      return false;
    }
  }

  /**
   * Emergency: the emergency numbers to the customer (at most once in 10 minutes), a 🚨 on the message, an urgent note and the
   * tag "דחוף", the bot stops and a person gets the conversation (also outside working hours: no away notice instead of the
   * numbers), and an alert to the admins (no customer text in it).
   */
  async emergency(channelId: string, convId: string, ext: string, messageId: string, text: string): Promise<void> {
    const recent = (await this.db.query(`SELECT 1 FROM messages WHERE conversation_id = $1 AND automation = 'emergency' AND created_at > now() - interval '10 minutes' LIMIT 1`, [convId])).rowCount;
    if (!recent) {
      const textL = await this.say(convId, text);
      const sent = await this.sendText(channelId, ext, textL, { background: true }).catch(() => ({} as { externalMessageId?: string }));
      const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto, automation) VALUES ($1,'out',$2,$3,true,'emergency') ON CONFLICT DO NOTHING RETURNING id`, [convId, textL, sent.externalMessageId ?? null]);
      if (ins.rows[0]) { this.notifyMessage(channelId, convId, ins.rows[0].id); this.hookMessage('message.sent', convId, ins.rows[0].id); }
    }
    await this.setOurReaction(messageId, '🚨', null).catch(() => undefined);
    await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, '🚨 פנייה דחופה: ההודעה נראית כמו מצב חירום (סכנה, פציעה, שריפה או דליפה). נשלחו ללקוח מספרי החירום. יש לחזור אליו מיד.')`, [convId]);
    await this.db.query(`INSERT INTO tags (name) SELECT 'דחוף' WHERE NOT EXISTS (SELECT 1 FROM tags WHERE lower(name) = 'דחוף')`).catch(() => undefined);
    const tag = (await this.db.query(`SELECT id FROM tags WHERE lower(name) = 'דחוף' LIMIT 1`)).rows[0]?.id as string | undefined;
    if (tag) await this.db.query('INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [convId, tag]).catch(() => undefined);
    await this.db.query(`UPDATE conversations SET status = 'open', bot_state = 'human', snoozed_until = NULL, urgent_since = COALESCE(urgent_since, now()), escalated_at = NULL WHERE id = $1`, [convId]);
    const held = (await this.db.query('SELECT assigned_to FROM conversations WHERE id = $1', [convId])).rows[0]?.assigned_to as string | null;
    const to = held ?? await autoAssign(this.db, convId).catch(() => null);
    if (to) this.onAssigned?.(convId, to);
    await audit(this.db, { action: 'conversation.emergency', target: convId, meta: { assignedTo: to } }).catch(() => undefined);
    void sendAlert(this.cfg, `🚨 פנייה דחופה (נראית כמו מצב חירום) התקבלה ב-${this.types.get(channelId) ?? 'ערוץ'}. ${to ? 'שויכה לנציג.' : 'לא שויכה: אין נציג זמין!'} יש לפתוח את השיחה ולחזור ללקוח מיד.`, { conversationId: convId });
  }

  /**
   * Escalation (bot settings): an urgent conversation (emergency or hazard report) nobody from the team has written in since it was
   * marked, after the set minutes: to the backup person, else the active manager (access to all conversations) with the fewest open
   * conversations, other than whoever holds it now. A note, an audit entry, an alert, a push to that person and, when they linked
   * their WhatsApp to Betty, a short message there (no customer details). Once per mark; a person's message or closing ends it.
   */
  async runEscalations(now = new Date()): Promise<number> {
    const bot = await loadBot(this.db);
    if (!bot.escalation.enabled) return 0;
    const due = (await this.db.query(
      `SELECT c.id, c.assigned_to, c.urgent_since,
              (SELECT number FROM cases k WHERE k.conversation_id = c.id AND k.closed_at IS NULL ORDER BY opened_at DESC LIMIT 1) AS num
         FROM conversations c
        WHERE c.urgent_since IS NOT NULL AND c.escalated_at IS NULL AND c.status = 'open'
          AND c.urgent_since < $1::timestamptz - make_interval(mins => $2)
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND NOT m.auto AND m.created_at > c.urgent_since)
        ORDER BY c.urgent_since LIMIT 20`, [now, bot.escalation.minutes])).rows as { id: string; assigned_to: string | null; urgent_since: Date; num: number | null }[];
    let n = 0;
    for (const c of due) {
      // the backup person if active and not the one already holding it, else the least busy available manager
      let to: string | null = null;
      if (bot.escalation.backupUserId && bot.escalation.backupUserId !== c.assigned_to) {
        to = (await this.db.query('SELECT id FROM users WHERE id = $1 AND active', [bot.escalation.backupUserId])).rows[0]?.id ?? null;
      }
      if (!to) {
        const managers = (await this.db.query(
          `SELECT u.id, u.role FROM users u WHERE u.active AND u.id IS DISTINCT FROM $1
            ORDER BY (u.available IS NOT FALSE) DESC, (SELECT count(*) FROM conversations x WHERE x.assigned_to = u.id AND x.status = 'open'), u.created_at`, [c.assigned_to])).rows as { id: string; role: string }[];
        for (const m of managers) { const perms = await permissionsOfRole(this.db, m.role); if (perms?.includes('inbox.view_all')) { to = m.id; break; } }
      }
      const claimed = await this.db.query(`UPDATE conversations SET escalated_at = $2, assigned_to = COALESCE($3, assigned_to), assigned_at = CASE WHEN $3::uuid IS NULL THEN assigned_at ELSE $2 END
          WHERE id = $1 AND escalated_at IS NULL RETURNING id`, [c.id, now, to]);
      if (!claimed.rowCount) continue;
      n++;
      const mins = Math.round((now.getTime() - new Date(c.urgent_since).getTime()) / 60_000);
      const who = to ? (await this.db.query('SELECT COALESCE(name_he, name) AS n FROM users WHERE id = $1', [to])).rows[0]?.n : null;
      await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)`, [c.id, `⏫ הסלמה אוטומטית: אין מענה אנושי לפנייה הדחופה כבר ${mins} דקות. ${who ? `הועברה אל ${who}.` : 'לא נמצא מנהל זמין להעביר אליו!'}`]);
      await audit(this.db, { action: 'conversation.escalate', target: c.id, meta: { to, minutes: mins } }).catch(() => undefined);
      void sendAlert(this.cfg, `⏫ פנייה דחופה${c.num ? ` #${c.num}` : ''} בלי מענה אנושי ${mins} דקות. ${who ? `הועברה אל ${who}.` : 'לא נמצא מנהל זמין!'}`, { conversationId: c.id });
      if (to) {
        this.onAssigned?.(c.id, to, 'handover');
        // the person linked their WhatsApp to Betty: a short message there (no customer details)
        const link = (await this.db.query('SELECT channel_id, external_id FROM staff_links WHERE user_id = $1 ORDER BY last_used_at DESC NULLS LAST LIMIT 1', [to])).rows[0] as { channel_id: string; external_id: string } | undefined;
        if (link) await this.sendText(link.channel_id, link.external_id, `⏫ פנייה דחופה${c.num ? ` #${c.num}` : ''} הועברה אליך: אין מענה אנושי כבר ${mins} דקות.
לפתיחה: ${this.cfg.APP_ORIGIN.split(',')[0]!.trim()}/#/inbox?c=${c.id}`, { background: true }).catch(() => undefined);
      }
    }
    // a person answered or the conversation was closed: the mark is done
    await this.db.query(`UPDATE conversations c SET urgent_since = NULL WHERE c.urgent_since IS NOT NULL AND (c.status <> 'open'
        OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND NOT m.auto AND m.created_at > c.urgent_since))`);
    return n;
  }

  /**
   * Periodic inspections due within a week or overdue: one reminder a day to the person responsible, as a push and, when they linked
   * their WhatsApp to Betty, a message there (all their due inspections in one message).
   */
  async runInspectionReminders(): Promise<number> {
    const due = await dueReminders(this.db);
    const byUser = new Map<string, typeof due>();
    for (const i of due) byUser.set(i.assignee, [...(byUser.get(i.assignee) ?? []), i]);
    for (const [userId, list] of byUser) {
      const overdue = list.filter((i) => i.daysLeft < 0).length;
      this.onNotifyUser?.(userId, overdue ? `${overdue} בדיקות תקופתיות באיחור` : `${list.length} בדיקות תקופתיות מתקרבות`, '/#/account?s=my-insp', 'botwa-inspections');
      const link = (await this.db.query('SELECT channel_id, external_id FROM staff_links WHERE user_id = $1 ORDER BY last_used_at DESC NULLS LAST LIMIT 1', [userId])).rows[0] as { channel_id: string; external_id: string } | undefined;
      if (link) await this.sendText(link.channel_id, link.external_id, reminderText(list), { background: true }).catch(() => undefined);
      await this.db.query('UPDATE inspections SET last_reminded_at = now() WHERE id = ANY($1::uuid[])', [list.map((i) => i.id)]);
    }
    return due.length;
  }

  alertTeam(text: string, extra: Record<string, unknown> = {}): void { if (this.alertBudget()) void sendAlert(this.cfg, text, extra); }
  /** At most 30 "stressed customer" alerts in 10 minutes: a flood of chats must not flood the managers (notes and tags still go on). */
  private alertTimes: number[] = [];
  private alertBudget(): boolean {
    const now = Date.now();
    this.alertTimes = this.alertTimes.filter((t) => now - t < 600_000);
    if (this.alertTimes.length >= 30) return false;
    this.alertTimes.push(now);
    return true;
  }

  /**
   * A stressed or upset customer (empathy.ts): an acknowledging answer with who handles the inquiry, the inquiry handed to a
   * person (the officer for the topic when they have an account, else normal routing), a note, a "זקוק לליווי" tag and an alert;
   * the follow-ups run from runComfort until a person answers. Not when a person answered in the last 10 minutes (only a note
   * for them) or a comforting message went out in the last 15 minutes. Returns true when it handled the message.
   */
  async comfort(channelId: string, convId: string, ext: string, messageId: string, text: string, level: Distress): Promise<boolean> {
    const c = (await this.db.query(
      `SELECT c.assigned_to, c.bot_state,
              EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND NOT m.auto AND m.created_at > now() - interval '10 minutes') AS answered,
              EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.automation = 'comfort' AND m.created_at > now() - interval '15 minutes') AS recent
         FROM conversations c WHERE c.id = $1`, [convId])).rows[0];
    if (!c) return false;
    const feeling = level === 'hazard' ? 'מדווח/ת על מפגע או סכנה' : level === 'worried' ? 'נשמע/ת לחוץ/ה או מודאג/ת' : 'נשמע/ת מתוסכל/ת מההמתנה';
    if (c.answered) {
      await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)`, [convId, `💛 הלקוח ${feeling}. כדאי להכיר בזה בתשובה ולומר מה הצעד הבא ומתי.`]);
      return false;   // a person is in the conversation: they answer, as usual
    }
    if (c.recent) {
      // writing again while nobody answered yet: never silence. A short "received, still on it" at most every 5 minutes
      const lately = (await this.db.query(`SELECT 1 FROM messages WHERE conversation_id = $1 AND automation IN ('comfort', 'comfort_follow') AND created_at > now() - interval '5 minutes' LIMIT 1`, [convId])).rowCount;
      if (lately) return true;
      const who = (await this.db.query(`SELECT COALESCE(u.name_he, u.name) AS who FROM conversations c JOIN users u ON u.id = c.assigned_to WHERE c.id = $1`, [convId])).rows[0]?.who as string | undefined;
      const body = stillHereText(who ?? null);
      const bodyL = await this.say(convId, body);
      const sent = await this.sendText(channelId, ext, bodyL, { background: true }).catch(() => ({} as { externalMessageId?: string }));
      const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto, automation) VALUES ($1,'out',$2,$3,true,'comfort_follow') ON CONFLICT DO NOTHING RETURNING id`, [convId, bodyL, sent.externalMessageId ?? null]);
      if (ins.rows[0]) { this.notifyMessage(channelId, convId, ins.rows[0].id); this.hookMessage('message.sent', convId, ins.rows[0].id); }
      if (this.alertBudget()) void sendAlert(this.cfg, `💛 הלקוח כתב שוב ועדיין מחכה למענה${who ? ` (אצל ${who})` : ''}.`, { conversationId: convId });
      return true;
    }
    // a person now: the officer for the topic named (if they have an account), else whoever holds it, else normal routing
    let movedNow = false;
    let topic: string | null = null;
    if (!c.assigned_to) {
      const officer = await officerUserFor(this.db, text).catch(() => null);
      let to: string | null = null;
      if (officer) {
        const u = await this.db.query(`UPDATE conversations SET assigned_to = $2, assigned_at = now() WHERE id = $1 AND assigned_to IS NULL RETURNING id`, [convId, officer.userId]).catch(() => ({ rowCount: 0 }));
        if (u.rowCount) { to = officer.userId; topic = officer.topic; await audit(this.db, { action: 'conversation.topic_assign', target: convId, meta: { to, topic, via: 'comfort' } }).catch(() => undefined); }
      }
      if (!to) to = await autoAssign(this.db, convId).catch(() => null);
      if (to) { this.onAssigned?.(convId, to); movedNow = true; }
      else movedNow = c.bot_state !== 'human';
    }
    await this.db.query(`UPDATE conversations SET status = 'open', bot_state = 'human', snoozed_until = NULL, comfort_since = now(), comfort_steps = 0,
        urgent_since = CASE WHEN $2 THEN COALESCE(urgent_since, now()) ELSE urgent_since END, escalated_at = CASE WHEN $2 THEN NULL ELSE escalated_at END WHERE id = $1`, [convId, level === 'hazard']);
    const who = (await this.db.query(`SELECT COALESCE(u.name_he, u.name) AS who FROM conversations c JOIN users u ON u.id = c.assigned_to WHERE c.id = $1`, [convId])).rows[0]?.who as string | undefined;
    const hours = await loadBusinessHours(this.db);
    const closed = hours.enabled && !isOpen(hours, new Date());
    const body = comfortText(level, { who: who ?? null, topic: topic ? `האחראי/ת על ${topic}` : null, closed, hours: closed ? hoursSummary(hours) : undefined, movedNow }, text);
    const bodyL = await this.say(convId, body);
    const sent = await this.sendText(channelId, ext, bodyL, { background: true }).catch(() => ({} as { externalMessageId?: string }));
    const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto, automation) VALUES ($1,'out',$2,$3,true,'comfort') ON CONFLICT DO NOTHING RETURNING id`, [convId, bodyL, sent.externalMessageId ?? null]);
    if (ins.rows[0]) { this.notifyMessage(channelId, convId, ins.rows[0].id); this.hookMessage('message.sent', convId, ins.rows[0].id); }
    await this.setOurReaction(messageId, level === 'hazard' ? '⚠️' : '💛', null).catch(() => undefined);
    await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)`, [convId, `💛 הלקוח ${feeling}. בטי הכירה בזה, ${movedNow ? 'העבירה את הפנייה לטיפול אנושי ' : ''}ותשלח עדכוני ליווי עד שמישהו מהצוות יענה. מומלץ לחזור אליו בהקדם.`]);
    await this.db.query(`INSERT INTO tags (name) SELECT 'זקוק לליווי' WHERE NOT EXISTS (SELECT 1 FROM tags WHERE lower(name) = 'זקוק לליווי')`).catch(() => undefined);
    const tag = (await this.db.query(`SELECT id FROM tags WHERE lower(name) = 'זקוק לליווי' LIMIT 1`)).rows[0]?.id as string | undefined;
    if (tag) await this.db.query('INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [convId, tag]).catch(() => undefined);
    await audit(this.db, { action: 'conversation.comfort', target: convId, meta: { level, assignedTo: who ? 'yes' : 'no' } }).catch(() => undefined);
    if (this.alertBudget()) void sendAlert(this.cfg, `💛 לקוח ${feeling} מחכה למענה${who ? ` (אצל ${who})` : ' (עדיין לא שויך!)'}. כדאי לחזור אליו בהקדם.`, { conversationId: convId });
    return true;
  }

  /**
   * The customer asks how their inquiry is going while it is with the team (assigned, or handed over and waiting): the inquiry
   * number, who handles it (or that it waits for the next person), and the working hours when closed now. At most every 30
   * minutes, and not when a person answered in the last 10 minutes. Returns false when the conversation is not with the team.
   */
  async waitingStatus(channelId: string, convId: string, ext: string): Promise<boolean> {
    const c = (await this.db.query(
      `SELECT c.assigned_to, c.bot_state, COALESCE(u.name_he, u.name) AS who, u.job_title,
              (SELECT number FROM cases k WHERE k.conversation_id = c.id AND k.closed_at IS NULL ORDER BY opened_at DESC LIMIT 1) AS num,
              EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.automation = 'waiting_status' AND m.created_at > now() - interval '30 minutes') AS recent,
              EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND NOT m.auto AND m.created_at > now() - interval '10 minutes') AS answered
         FROM conversations c LEFT JOIN users u ON u.id = c.assigned_to WHERE c.id = $1`, [convId])).rows[0];
    if (!c || (!c.assigned_to && c.bot_state !== 'human')) return false;
    if (c.recent || c.answered) return true;   // already told, or a person is answering right now: stay quiet
    const hours = await loadBusinessHours(this.db);
    const closed = hours.enabled && !isOpen(hours, new Date());
    const ref = c.num ? ` (מספר ${c.num})` : '';
    const text = [
      c.who ? `הפנייה שלך${ref} נמצאת בטיפול של ${c.who}${c.job_title ? `, ${c.job_title}` : ''}.` : `הפנייה שלך${ref} התקבלה ומחכה לנציג הפנוי הבא.`,
      closed ? `כרגע אנחנו מחוץ לשעות הפעילות (${hoursSummary(hours)}), ונחזור אליך בהקדם בשעות הפעילות.` : 'נחזור אליך בהקדם האפשרי. אפשר לכתוב כאן כל פרט נוסף, והוא יתווסף לפנייה.',
      'אם זה מצב חירום, התקשרו מיד למד"א 101 או לכבאות והצלה 102.',
    ].join('\n');
    const textL = await this.say(convId, text);
    const sent = await this.sendText(channelId, ext, textL, { background: true });
    const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto, automation) VALUES ($1,'out',$2,$3,true,'waiting_status') ON CONFLICT DO NOTHING RETURNING id`, [convId, textL, sent.externalMessageId ?? null]);
    if (ins.rows[0]) { this.notifyMessage(channelId, convId, ins.rows[0].id); this.hookMessage('message.sent', convId, ins.rows[0].id); }
    return true;
  }

  /** A wide emergency is on and this conversation has not had its status message yet: send it (English when given) and tag it. */
  async incidentReply(channelId: string, convId: string, ext: string): Promise<boolean> {
    const i = await loadIncident(this.db);
    if (!i.active || !i.startedAt) return false;
    const already = (await this.db.query(`SELECT 1 FROM messages WHERE conversation_id = $1 AND automation = 'incident' AND created_at >= $2 LIMIT 1`, [convId, i.startedAt])).rowCount;
    if (already) return false;
    const body = (await this.langOf(convId)) === 'en' && i.textEn ? i.textEn : i.text;
    const sent = await this.sendText(channelId, ext, body, { background: true }).catch(() => ({} as { externalMessageId?: string }));
    const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto, automation) VALUES ($1,'out',$2,$3,true,'incident') ON CONFLICT DO NOTHING RETURNING id`, [convId, body, sent.externalMessageId ?? null]);
    if (ins.rows[0]) { this.notifyMessage(channelId, convId, ins.rows[0].id); this.hookMessage('message.sent', convId, ins.rows[0].id); }
    await this.db.query(`INSERT INTO tags (name) SELECT 'אירוע חירום' WHERE NOT EXISTS (SELECT 1 FROM tags WHERE lower(name) = 'אירוע חירום')`).catch(() => undefined);
    await this.db.query(`INSERT INTO conversation_tags (conversation_id, tag_id) SELECT $1, id FROM tags WHERE lower(name) = 'אירוע חירום' ON CONFLICT DO NOTHING`, [convId]).catch(() => undefined);
    return true;
  }

  /**
   * The customer asks about an earlier inquiry that was closed (their message only reopened the conversation): its number, when it
   * was opened and closed, and by whom; if the problem is still there, writing about it goes on in the new one. False when there is
   * nothing to tell, or an inquiry is still open (waitingStatus answers that).
   */
  async pastReportStatus(channelId: string, convId: string, ext: string, aboutReport = true): Promise<boolean> {
    // an inquiry still open (other than one this very message opened) is answered by waitingStatus
    const open = (await this.db.query(`SELECT opened_at FROM cases WHERE conversation_id = $1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`, [convId])).rows[0] as { opened_at: Date } | undefined;
    if (open && Date.now() - new Date(open.opened_at).getTime() > 3 * 60_000) return false;
    const k = (await this.db.query(
      `SELECT k.number, k.opened_at, k.closed_at, k.close_kind, COALESCE(u.name_he, u.name) AS who
         FROM cases k LEFT JOIN users u ON u.id = COALESCE(k.closed_by, k.assigned_to)
        WHERE k.conversation_id = $1 AND k.closed_at IS NOT NULL ORDER BY k.closed_at DESC LIMIT 1`, [convId])).rows[0] as { number: number; opened_at: Date; closed_at: Date; close_kind: string | null; who: string | null } | undefined;
    if (!k) return false;
    // "מתי חוזרים אליי?" / "?" (not about a report as such): only when that inquiry closed in the last three days
    if (!aboutReport && Date.now() - new Date(k.closed_at).getTime() > 3 * 86_400_000) return false;
    const d = (x: Date) => new Date(x).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric' });
    const by = k.close_kind === 'auto' ? 'נסגרה אוטומטית' : k.who ? `טופלה ונסגרה על ידי ${k.who}` : 'טופלה ונסגרה';
    const body = `הפנייה האחרונה שלך (מספר ${k.number}, מ-${d(k.opened_at)}) ${by} ב-${d(k.closed_at)} ✅\nאם הבעיה עדיין קיימת, כתבו כאן מה המצב, ונפתח פנייה חדשה.`;
    const bodyL = await this.say(convId, body);
    const sent = await this.sendText(channelId, ext, bodyL, { background: true });
    const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto, automation) VALUES ($1,'out',$2,$3,true,'waiting_status') ON CONFLICT DO NOTHING RETURNING id`, [convId, bodyL, sent.externalMessageId ?? null]);
    if (ins.rows[0]) { this.notifyMessage(channelId, convId, ins.rows[0].id); this.hookMessage('message.sent', convId, ins.rows[0].id); }
    return true;
  }

  /** An officer question in a conversation that is with the team (where the bot is silent): answered from the officers list. */
  async officerWhileWaiting(channelId: string, convId: string, ext: string, text: string | null | undefined): Promise<boolean> {
    const c = (await this.db.query(
      `SELECT c.assigned_to, c.bot_state,
              EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out' AND NOT m.auto AND m.created_at > now() - interval '10 minutes') AS answered
         FROM conversations c WHERE c.id = $1`, [convId])).rows[0];
    if (!c || (!c.assigned_to && c.bot_state !== 'human') || c.answered) return false;
    const reply = await officerReply(this.db, text);
    if (!reply) return false;
    const replyL = await this.say(convId, reply);
    const sent = await this.sendText(channelId, ext, replyL, { background: true });
    const ins = await this.db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto, automation) VALUES ($1,'out',$2,$3,true,'officer_info') ON CONFLICT DO NOTHING RETURNING id`, [convId, replyL, sent.externalMessageId ?? null]);
    if (ins.rows[0]) { this.notifyMessage(channelId, convId, ins.rows[0].id); this.hookMessage('message.sent', convId, ins.rows[0].id); }
    return true;
  }

  /** Hand a bot conversation to a person: note, assignment (the named person if active, else normal routing), then the hand-over or away notice. */
  private async handoffNow(channelId: string, convId: string, ext: string, bot: BotConfig, why: string, topic?: { userId: string; topic: string }, customText?: string, extra?: string, gif: GifMoment = 'handoff'): Promise<void> {
    await this.db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)`, [convId, `מועבר מהבוט לנציג: ${why}.`]);
    let to: string | null = null;
    if (topic) {
      // the person responsible for the chosen topic gets the conversation (if they are still active); otherwise normal routing
      const r = await this.db.query(`UPDATE conversations SET assigned_to = u.id FROM users u WHERE conversations.id = $1 AND u.id = $2 AND u.active RETURNING u.id`, [convId, topic.userId]).catch(() => ({ rows: [] as { id: string }[] }));
      to = (r.rows[0]?.id as string | undefined) ?? null;
      if (to) await audit(this.db, { action: 'conversation.topic_assign', target: convId, meta: { to, topic: topic.topic } }).catch(() => undefined);
    }
    if (!to) to = await autoAssign(this.db, convId).catch(() => null);
    if (to) { this.onAssigned?.(convId, to); void this.introduce(convId); }
    if (to && !topic) await audit(this.db, { action: 'conversation.auto_assign', target: convId, meta: { to, via: 'bot' } }).catch(() => undefined);
    const hours = await loadBusinessHours(this.db);
    const closed = hours.enabled && !isOpen(hours, new Date());
    await this.botSay(channelId, convId, ext, [closed ? hours.awayMessage : customText || bot.humanMessage, extra].filter(Boolean).join('\n\n'));
    if (closed) await this.db.query('UPDATE conversations SET last_away_at = now() WHERE id = $1', [convId]);
    else await this.botGif(channelId, convId, gif, bot);   // "a person is on the way" (a thank-you that ends up with a person: "glad to help"); not with the away notice
    void this.autoForward(convId).catch(() => undefined);
  }

  /** Mark the bot messages just sent in this conversation as answered from a knowledge-base entry (for customers' reactions). */
  private async tagAnswer(convId: string, sourceId: string, since: Date): Promise<void> {
    await this.db.query(`UPDATE messages SET kb_source_id = $2 WHERE conversation_id = $1 AND direction = 'out' AND auto AND created_at >= $3`, [convId, sourceId, since]).catch(() => undefined);
  }

  /** A customer reacted to one of our messages: on a knowledge-base answer it counts as feedback (👍 helpful, 👎 not); removing it undoes it. */
  async customerReaction(channelId: string, ev: { externalContactId: string; targetMessageId: string; emoji: string }): Promise<'counted' | 'removed' | 'ignored'> {
    const m = (await this.db.query(
      `SELECT m.id, m.kb_source_id FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
        WHERE c.channel_id = $1 AND ct.external_id = $2 AND m.external_id = $3 AND m.direction = 'out' LIMIT 1`, [channelId, ev.externalContactId, ev.targetMessageId])).rows[0];
    if (!m?.kb_source_id) return 'ignored';
    const meaning = reactionMeaning(ev.emoji);
    if (meaning === null) { const d = await this.db.query('DELETE FROM kb_answer_reactions WHERE message_id = $1', [m.id]); return d.rowCount ? 'removed' : 'ignored'; }
    await this.db.query(`INSERT INTO kb_answer_reactions (message_id, source_id, positive) VALUES ($1,$2,$3) ON CONFLICT (message_id) DO UPDATE SET positive = EXCLUDED.positive, created_at = now()`, [m.id, m.kb_source_id, meaning]);
    return 'counted';
  }

  /** The flow chart bot: one customer message in, replies + side effects out (see flow/engine.ts). */
  private async runFlowStep(channelId: string, convId: string, ext: string, bot: BotConfig, flow: NonNullable<Awaited<ReturnType<typeof loadFlow>>>, input: FlowInput, rx: ReturnType<ChannelManager['reactor']>): Promise<void> {
    let searched = false, found = false;
    let answeredFrom: string | null = null;
    const row = (await this.db.query('SELECT c.flow_state, c.lang, ct.profile, ct.display_name, ct.claimed_email, ct.claimed_phone FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1', [convId])).rows[0];
    const convLang: Lang = row?.lang === 'en' ? 'en' : 'he';
    const st = row?.flow_state as FlowState | null;
    const hours = await loadBusinessHours(this.db);
    const ctx: FlowContext = {
      isOpen: !hours.enabled || isOpen(hours, new Date()),
      channelType: this.types.get(channelId) ?? 'whatsapp',
      humanKeywords: bot.humanKeywords, humanOption: bot.humanOption, invalidRetries: bot.invalidRetries, invalidMessage: bot.invalidMessage,
      profile: (row?.profile ?? {}) as Record<string, string>,
      // the website chat's own form already asked these: the flow does not ask them again
      known: this.types.get(channelId) === 'webchat' ? {
        name: row?.display_name && !/^מבקר באתר #/.test(row.display_name) ? cleanName(row.display_name) || undefined : undefined,
        email: row?.claimed_email ?? undefined, phone: row?.claimed_phone ?? undefined,
      } : undefined,
      resolveArea: (t) => resolveArea(this.db, t),
      kbAnswer: async (t) => { const a = await this.kbAnswer(bot, null, t, true, async () => { searched = true; await rx.set('working'); }, (id) => { answeredFrom = id; }, convLang); if (a) found = true; return a; },
      matchOption: async (t, options) => this.kb?.matchOption(t, options) ?? null,
      kbSuggest: async (t) => {
        if (!this.kb || t.trim().length < 3) return [];
        const hits = await this.kb.search(t, { audience: 'bot', limit: 5 }).catch(() => []);
        // only entries with real evidence: two or more of the question's words, an exact phrase, or a strong meaning match
        return hits.filter((h) => h.score >= bot.kb.minScore * 0.4 && (h.exact || h.matched >= 2 || h.sem >= bot.kb.minScore * 0.8)).slice(0, 3).map((h) => ({ id: h.sourceId, label: h.title.replace(/\s+/g, ' ').slice(0, 70) }));
      },
      kbSource: async (id, q) => {
        const a = await this.kb?.answerFor(id, q, { minScore: bot.kb.minScore, maxChars: bot.kb.maxChars }).catch(() => null);
        if (a) {
          answeredFrom = id;
          // the customer's own wording led to this entry: a new wording for it (applied when a person approves)
          if (learnNorm(q) !== learnNorm(a.title)) void recordLearn(this.db, this.kb, { kind: 'variant', target: id, sourceId: id, text: q, conversationId: convId }).catch(() => undefined);
        }
        return a ? this.wordAnswer(bot, q, a) : null;
      },
    };
    const r = await runFlow(flow, st, input, ctx, bot.humanLabel);
    const stepStart: Date = (await this.db.query('SELECT now() AS t')).rows[0].t;   // database clock, like the messages' own times
    await this.botSayAll(channelId, convId, ext, bot, r.replies, r.menu, r.state.vars.fullName);
    if (answeredFrom) await this.tagAnswer(convId, answeredFrom, stepStart);
    const handoff = r.effects.find((e): e is Extract<Effect, { kind: 'handoff' }> => e.kind === 'handoff');
    if (handoff) await rx.set('handoff'); else if (searched) await rx.set(found ? 'done' : 'noAnswer'); else if (bot.reactions.ackAll) await rx.set('done');
    await this.db.query('UPDATE conversations SET flow_state = $2, bot_state = $3 WHERE id = $1', [convId, JSON.stringify(r.state), handoff ? 'human' : 'menu']);
    for (const e of r.effects) {
      if (e.kind === 'note') await this.db.query('INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)', [convId, e.text]).catch(() => undefined);
      else if (e.kind === 'tag') await this.db.query('INSERT INTO conversation_tags (conversation_id, tag_id) SELECT $1, id FROM tags WHERE id = $2 ON CONFLICT DO NOTHING', [convId, e.tagId]).catch(() => undefined);
      else if (e.kind === 'profile') await this.db.query(`UPDATE contacts SET profile = profile || $2::jsonb WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`, [convId, JSON.stringify(e.vars)]).catch(() => undefined);
      else if (e.kind === 'name') await this.db.query(`UPDATE contacts SET display_name = $2 WHERE id = (SELECT contact_id FROM conversations WHERE id = $1) AND display_name IS NULL`, [convId, e.value]).catch(() => undefined);
      else if (e.kind === 'learn_option') await recordLearn(this.db, this.kb, { kind: 'option_example', target: `${e.node}\n${e.label}`, text: e.text, conversationId: convId }).catch(() => undefined);
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
      await this.handoffNow(channelId, convId, ext, bot, why, userId ? { userId, topic: handoff.officerTopic ?? 'תרשים זרימה' } : undefined, handoff.text, extra, input.text && isThanks(input.text) ? 'thanks' : 'handoff');
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
      const away = await this.say(conversationId, hours.awayMessage);
      const sent = await this.sendText(channelId, externalContactId, away, { background: true });
      const ins = await this.db.query(
        `INSERT INTO messages (conversation_id, direction, body, external_id, auto) VALUES ($1,'out',$2,$3,true) RETURNING id`,
        [conversationId, away, sent.externalMessageId ?? null],
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
    await this.usageGate(channelId, false);
    const send = a.sendMedia.bind(a);
    const out = await this.sender.run(channelId, this.effective(channelId, await this.loadSending()), () => send(externalContactId, media), { maxWaitMs: 8_000 });
    await this.usageCount(channelId, 'media');
    return out;
  }

  async startAll(): Promise<void> {
    const { rows } = await this.db.query('SELECT id FROM channels WHERE auto_start');
    for (const r of rows) await this.start(r.id).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => a.stop().catch(() => undefined)));
  }
}
