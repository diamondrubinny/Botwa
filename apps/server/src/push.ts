import webpush from 'web-push';
import { decrypt, encrypt } from './crypto.js';
import type { Config } from './config.js';
import type { Db } from './db.js';

/**
 * Web Push: a content-free "new message" alert to staff devices. The payload never contains names or text.
 * VAPID keys are generated once and kept in the settings table (private key encrypted with ENCRYPTION_KEY).
 * Subscription endpoints are supplied by browsers, so they are restricted to the known push services (SSRF guard).
 */
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function isAllowedPushEndpoint(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

export class PushService {
  private publicKey = '';
  private ready = false;
  private lastSent = new Map<string, number>();

  constructor(private readonly db: Db, private readonly cfg: Config) {}

  async init(): Promise<void> {
    let pub = '', priv = '';
    const { rows } = await this.db.query(`SELECT value FROM settings WHERE key = 'vapid'`);
    if (rows[0]) {
      try {
        pub = rows[0].value.publicKey as string;
        priv = decrypt(rows[0].value.privateKey as string, this.cfg.ENCRYPTION_KEY);
      } catch {
        // ENCRYPTION_KEY was changed: the old private key is unreadable, so start over (old subscriptions no longer match the new keys).
        pub = ''; priv = '';
        await this.db.query(`DELETE FROM settings WHERE key = 'vapid'`);
        await this.db.query('DELETE FROM push_subscriptions');
      }
    }
    if (!pub) {
      const k = webpush.generateVAPIDKeys();
      await this.db.query(
        `INSERT INTO settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify({ publicKey: k.publicKey, privateKey: encrypt(k.privateKey, this.cfg.ENCRYPTION_KEY) })],
      );
      const again = await this.db.query(`SELECT value FROM settings WHERE key = 'vapid'`); // another process may have won the race
      pub = again.rows[0].value.publicKey as string;
      priv = decrypt(again.rows[0].value.privateKey as string, this.cfg.ENCRYPTION_KEY);
    }
    webpush.setVapidDetails(this.cfg.APP_ORIGIN.split(',')[0]!.trim().startsWith('https://') ? this.cfg.APP_ORIGIN.split(',')[0]!.trim() : 'mailto:admin@localhost.invalid', pub, priv);
    this.publicKey = pub;
    this.ready = true;
  }

  getPublicKey(): string { return this.publicKey; }

  /** Send one alert to these devices; a device the push service says is gone is forgotten. The payload never holds customer data. */
  private async deliver(rows: { id: string; endpoint: string; p256dh: string; auth: string }[], payload: { title: string; tag: string; url?: string; icon?: string }, urgency: 'normal' | 'high' = 'normal'): Promise<number> {
    let ok = 0;
    if (!payload.icon) {
      const lg = (await this.db.query(`SELECT extract(epoch FROM updated_at)::bigint AS v FROM branding_logo WHERE id = 1`).catch(() => ({ rows: [] }))).rows[0] as { v: string } | undefined;
      if (lg) payload = { ...payload, icon: `/branding/logo?v=${Number(lg.v)}` };
    }
    for (const s of rows) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency, timeout: 8000 });
        ok++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await this.db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => undefined);
      }
    }
    return ok;
  }
  private static convUrl = (id: string) => `/#/inbox?c=${id}`;

  /** Who should hear about a new customer message: the assignee, or everyone allowed to see an unassigned, non-bot conversation. */
  async notifyInbound(conversationId: string): Promise<void> {
    if (!this.ready) return;
    const { rows } = await this.db.query(
      `SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth
         FROM conversations c
         JOIN push_subscriptions s ON true
         JOIN users u ON u.id = s.user_id AND u.active AND (u.push_prefs->>'messages')::boolean IS NOT FALSE
         JOIN roles r ON r.key = u.role
        WHERE c.id = $1 AND c.status = 'open'
          AND (c.assigned_to = u.id
               OR (c.assigned_to IS NULL AND c.bot_state IS DISTINCT FROM 'menu')
               OR ('inbox.view_all' = ANY(r.permissions) AND c.assigned_to IS NULL))`,
      [conversationId],
    );
    const now = Date.now();
    const due = rows.filter((s) => {
      if (now - (this.lastSent.get(s.user_id as string) ?? 0) < 15_000) return false; // at most one alert per person per 15s
      this.lastSent.set(s.user_id as string, now);
      return true;
    });
    await this.deliver(due, { title: 'הודעה חדשה בתיבת התמיכה', tag: 'botwa-new', url: PushService.convUrl(conversationId) });
  }

  /** SLA breach: tell the assignee, or the people who can see unassigned conversations when nobody has it. */
  async notifySla(conversationId: string): Promise<void> {
    if (!this.ready) return;
    const { rows } = await this.db.query(
      `SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth
         FROM conversations c
         JOIN push_subscriptions s ON true
         JOIN users u ON u.id = s.user_id AND u.active AND (u.push_prefs->>'sla')::boolean IS NOT FALSE
         JOIN roles r ON r.key = u.role
        WHERE c.id = $1 AND (c.assigned_to = u.id OR ('conversations.assign_others' = ANY(r.permissions) AND c.assigned_to IS NULL))`,
      [conversationId],
    );
    await this.deliver(rows, { title: 'לקוח ממתין מעבר ליעד השירות', tag: 'botwa-sla', url: PushService.convUrl(conversationId) }, 'high');
  }

  /** A conversation was given to this person (by a colleague, a hand-over, the bot or routing). */
  async notifyAssigned(conversationId: string, userId: string, how: 'assigned' | 'handover' = 'assigned'): Promise<void> {
    if (!this.ready) return;
    const { rows } = await this.db.query(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s JOIN users u ON u.id = s.user_id AND u.active AND (u.push_prefs->>'assigned')::boolean IS NOT FALSE
        WHERE s.user_id = $1`, [userId]);
    await this.deliver(rows, { title: how === 'handover' ? 'שיחה הועברה אליך' : 'שיחה שויכה אליך', tag: `botwa-asg-${conversationId}`, url: PushService.convUrl(conversationId) }, 'high');
  }

  /** "Send me a test alert": how many of this person's devices accepted it (0 = none registered or all failed). */
  async test(userId: string): Promise<number> {
    if (!this.ready) return 0;
    const { rows } = await this.db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
    return this.deliver(rows, { title: 'התראת בדיקה: ההתראות עובדות', tag: 'botwa-test', url: '/#/account' });
  }
}
