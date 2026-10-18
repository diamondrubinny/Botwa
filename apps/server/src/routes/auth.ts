import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { audit } from '../audit.js';
import { cookieOptions, isPrivileged, requireAuth, SESSION_COOKIE } from '../auth.js';
import type { Config } from '../config.js';
import { decrypt, encrypt, newToken, sha256 } from '../crypto.js';
import type { Db } from '../db.js';
import { dummyVerify, hashPassword, PASSWORD_MIN, verifyPassword } from '../password.js';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

const loginBody = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(256),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

export function authRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  const auth = requireAuth(db);
  const invalid = { error: 'invalid_credentials' };

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const { email, password, totp } = body.data;

    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const u = rows[0];
    if (!u || !u.active) {
      await dummyVerify(password);
      await audit(db, { action: 'login.fail', target: email, ip: req.ip });
      return reply.code(401).send(invalid);
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      await audit(db, { actorId: u.id, action: 'login.locked', ip: req.ip });
      return reply.code(429).send({ error: 'account_locked' });
    }

    let ok = await verifyPassword(u.password_hash, password);
    if (ok && u.totp_enabled) {
      if (!totp) return reply.code(401).send({ error: 'mfa_required' });
      ok = authenticator.check(totp, decrypt(u.totp_secret_enc, cfg.ENCRYPTION_KEY));
    }
    if (!ok) {
      const fails = u.failed_logins + 1;
      const lock = fails >= MAX_FAILS;
      await db.query(
        `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) END WHERE id = $1`,
        [u.id, lock ? 0 : fails, lock, LOCK_MINUTES],
      );
      await audit(db, { actorId: u.id, action: lock ? 'login.lockout' : 'login.fail', ip: req.ip });
      return reply.code(401).send(invalid);
    }

    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
    const token = newToken();
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5))`,
      [u.id, sha256(token), req.ip, (req.headers['user-agent'] ?? '').slice(0, 300), cfg.SESSION_TTL_HOURS],
    );
    await audit(db, { actorId: u.id, action: 'login.success', ip: req.ip });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(cfg));
    return { ok: true };
  });

  app.post('/auth/logout', { preHandler: auth }, async (req, reply) => {
    await db.query('DELETE FROM sessions WHERE id = $1', [req.user!.sessionId]);
    await audit(db, { actorId: req.user!.id, action: 'logout', ip: req.ip });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: auth }, async (req) => {
    const u = req.user!;
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      mfaEnabled: u.totpEnabled,
      mfaEnrollmentRequired: cfg.REQUIRE_MFA_FOR_PRIVILEGED && isPrivileged(u.role) && !u.totpEnabled,
    };
  });

  app.post('/auth/password', { preHandler: auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ current: z.string().max(256), next: z.string().min(PASSWORD_MIN).max(256) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!(await verifyPassword(rows[0].password_hash, body.data.current))) return reply.code(401).send(invalid);
    await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
      req.user!.id,
      await hashPassword(body.data.next),
    ]);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user!.id, req.user!.sessionId]);
    await audit(db, { actorId: req.user!.id, action: 'password.change', ip: req.ip });
    return { ok: true };
  });

  app.post('/auth/mfa/setup', { preHandler: auth }, async (req, reply) => {
    if (req.user!.totpEnabled) return reply.code(409).send({ error: 'mfa_already_enabled' });
    const secret = authenticator.generateSecret();
    await db.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [req.user!.id, encrypt(secret, cfg.ENCRYPTION_KEY)]);
    return { secret, otpauthUrl: authenticator.keyuri(req.user!.email, 'Botwa', secret) };
  });

  app.post('/auth/mfa/enable', { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query('SELECT totp_secret_enc FROM users WHERE id = $1', [req.user!.id]);
    const enc = rows[0]?.totp_secret_enc;
    if (!enc || !authenticator.check(body.data.code, decrypt(enc, cfg.ENCRYPTION_KEY))) {
      return reply.code(400).send({ error: 'invalid_code' });
    }
    await db.query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.user!.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user!.id, req.user!.sessionId]);
    await audit(db, { actorId: req.user!.id, action: 'mfa.enable', ip: req.ip });
    return { ok: true };
  });
}
