import { z } from 'zod';

const bool = (def: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64'),
  // Public origin(s) of the panel, comma-separated (e.g. "https://example.com,https://www.example.com").
  // Mutating requests must carry exactly one of them in the Origin header (CSRF defence).
  APP_ORIGIN: z
    .string()
    .refine((v) => v.split(',').every((o) => z.string().url().safeParse(o.trim()).success), 'APP_ORIGIN must be one or more comma-separated URLs'),
  COOKIE_SECURE: bool('true'),
  TRUST_PROXY: bool('false'),
  /** emergency switch: ignore the panel firewall (if you locked yourself out); set in .env and restart */
  FIREWALL_DISABLE: bool('false'),
  /** how long a sign-in survives without activity (it is renewed while the panel is in use) */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  /** the same for "stay signed in on this device" */
  SESSION_REMEMBER_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** nobody stays signed in longer than this from the moment they typed the password, however active */
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  /** Graph API version used by the official WhatsApp channel; check Meta's current supported versions. */
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
  // Telegram user-account login (QR). Get both from https://my.telegram.org -> API development tools.
  TELEGRAM_API_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_API_HASH: z.string().min(8).optional(),
  // Media (images/documents/voice). Enabled only when a ClamAV daemon is configured (fail closed).
  MEDIA_DIR: z.string().default('./data/media'),
  // Keep <= clamd StreamMaxLength (default 25 MB) or large files fail to scan (fail closed).
  MEDIA_MAX_MB: z.coerce.number().int().min(1).max(25).default(16),
  MEDIA_MAX_TOTAL_GB: z.coerce.number().min(0.1).default(20),
  MEDIA_MAX_FILES_PER_CONTACT_DAY: z.coerce.number().int().min(1).default(50),
  CLAMAV_HOST: z.string().min(1).optional(),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  MEDIA_ALLOW_UNSCANNED: bool('false'), // development only: accept files without antivirus
  /** ffmpeg binary that turns GIFs into short silent MP4s, so WhatsApp plays them as animations. Empty = off (WhatsApp then gets a still picture). */
  FFMPEG_PATH: z.string().default('ffmpeg'),
  REPORT_TZ: z.string().default('Asia/Jerusalem'),
  /** Android app (android/ folder): its package and signing-certificate SHA-256 fingerprint(s), so the app opens the panel full-screen */
  ANDROID_APP_PACKAGE: z.string().regex(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/).default('net.rubinny.botwa'),
  ANDROID_APP_SHA256: z.string().default('').refine((v) => v.split(',').map((x) => x.trim()).filter(Boolean).every((x) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(x)), 'ANDROID_APP_SHA256 must be colon-separated SHA-256 fingerprints'),
  /** "Meaning" search with a local model (needs the optional runtime: build with WITH_SEMANTIC=1). off = keyword search only. */
  SEMANTIC_SEARCH: z.enum(['off', 'local']).default('off'),
  SEMANTIC_MODEL: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default('Xenova/multilingual-e5-small'),
  MODEL_DIR: z.string().default('./data/models'),
  /**
   * Headless browser for web pages that build their content with JavaScript. off = plain fetching only. local = Chromium inside this process
   * (needs Chromium: build with WITH_BROWSER=1, or set BROWSER_PATH). With BROWSER_URL + BROWSER_TOKEN a separate rendering container is used instead.
   */
  BROWSER: z.enum(['off', 'local']).default('off'),
  BROWSER_PATH: z.string().optional(),
  BROWSER_NO_SANDBOX: bool('false'),
  BROWSER_URL: z.string().url().optional(),
  BROWSER_TOKEN: z.string().min(24).optional(),
  /** knowledge-base question log (customer text) is deleted after this many days */
  KB_QUERY_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  BACKUP_DIR: z.string().default('./data/backups'),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),
  // Hour of day (0-23, server local time) for the automatic daily backup. Unset = manual backups only.
  BACKUP_AUTO_HOUR: z.coerce.number().int().min(0).max(23).optional(),
  // Optional: POST a JSON alert here when a channel is logged out / restricted / in error. Leave blank to disable.
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  // Contact sent in the User-Agent when importing laws from Wikisource (Wikimedia asks automated clients for one). Default: APP_ORIGIN.
  GOV_IMPORT_CONTACT: z.string().trim().max(200).regex(/^[^\r\n]*$/).optional(),
  // Customers sending more than this many messages within 2 minutes are auto-blocked as flooders (0 = off).
  FLOOD_LIMIT: z.coerce.number().int().min(0).max(1000).default(30),
  // Passkeys are bound to this host. Default: derived from APP_ORIGIN (apex when apex+www are listed).
  WEBAUTHN_RP_ID: z.string().min(3).optional(),
  WEB_DIST: z.string().optional(),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(0).default(365),
  REQUIRE_MFA_FOR_PRIVILEGED: bool('true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` in .env / compose means "unset" (optional settings left blank), not an empty value.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
