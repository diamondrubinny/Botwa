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

  /** Who should hear about a new customer message: the assignee, or everyone allowed to see an unassigned, non-bot conversation. */
  async notifyInbound(conversationId: string): Promise<void> {
    if (!this.ready) return;
    const { rows } = await this.db.query(
      `SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth
         FROM conversations c
         JOIN push_subscriptions s ON true
         JOIN users u ON u.id = s.user_id AND u.active
         JOIN roles r ON r.key = u.role
        WHERE c.id = $1 AND c.status = 'open'
          AND (c.assigned_to = u.id
               OR (c.assigned_to IS NULL AND c.bot_state IS DISTINCT FROM 'menu')
               OR ('inbox.view_all' = ANY(r.permissions) AND c.assigned_to IS NULL))`,
      [conversationId],
    );
    const now = Date.now();
    for (const s of rows) {
      if (now - (this.lastSent.get(s.user_id as string) ?? 0) < 15_000) continue; // at most one alert per person per 15s
      this.lastSent.set(s.user_id as string, now);
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: 'הודעה חדשה בתיבת התמיכה', tag: 'botwa-new' }),
          { TTL: 3600, urgency: 'normal', timeout: 8000 },
        );
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await this.db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => undefined);
      }
    }
  }
}
