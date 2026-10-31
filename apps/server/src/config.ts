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
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
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
  REPORT_TZ: z.string().default('Asia/Jerusalem'),
  BACKUP_DIR: z.string().default('./data/backups'),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),
  // Hour of day (0-23, server local time) for the automatic daily backup. Unset = manual backups only.
  BACKUP_AUTO_HOUR: z.coerce.number().int().min(0).max(23).optional(),
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
