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
  APP_ORIGIN: z.string().url(),
  COOKIE_SECURE: bool('true'),
  TRUST_PROXY: bool('false'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  // Telegram user-account login (QR). Get both from https://my.telegram.org -> API development tools.
  TELEGRAM_API_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_API_HASH: z.string().min(8).optional(),
  WEB_DIST: z.string().optional(),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(0).default(365),
  REQUIRE_MFA_FOR_PRIVILEGED: bool('true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
