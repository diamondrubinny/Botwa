import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { audit } from '../audit.js';
import { needsMfaEnrollment, requireAuth, SESSION_COOKIE, startSession } from '../auth.js';
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
  /** stay signed in on this device (longer, renewed while in use) */
  remember: z.boolean().optional(),
});

export function authRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  // Enrolment endpoints must stay reachable for privileged users who still have to set up MFA.
  const auth = requireAuth(db, undefined, { allowEnrollment: true });
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
      // Same response as a wrong password: do not reveal that the account exists or is locked.
      await dummyVerify(password);
      await audit(db, { actorId: u.id, action: 'login.locked', ip: req.ip });
      return reply.code(401).send(invalid);
    }

    let ok = await verifyPassword(u.password_hash, password);
    if (ok && u.totp_enabled) {
      if (!totp) return reply.code(401).send({ error: 'mfa_required' });
      ok = authenticator.check(totp, decrypt(u.totp_secret_enc, cfg.ENCRYPTION_KEY));
    }
    if (!ok) {
      // Single atomic statement: concurrent guesses cannot read the same counter value.
      const upd = await db.query(
        `UPDATE users
            SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1 RETURNING (failed_logins = 0) AS locked`,
        [u.id, MAX_FAILS, LOCK_MINUTES],
      );
      const lock = upd.rows[0]?.locked === true;
      await audit(db, { actorId: u.id, action: lock ? 'login.lockout' : 'login.fail', ip: req.ip });
      return reply.code(401).send(invalid);
    }

    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
    await startSession(db, cfg, req, reply, u.id, !!body.data.remember);
    await audit(db, { actorId: u.id, action: 'login.success', ip: req.ip });
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
    const av = await db.query('SELECT available FROM users WHERE id = $1', [u.id]);
    return {
      available: av.rows[0]?.available ?? true,
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      roleName: u.roleName,
      permissions: u.permissions,
      mfaEnabled: u.totpEnabled,
      passkeys: u.passkeys,
      mfaEnrollmentRequired: cfg.REQUIRE_MFA_FOR_PRIVILEGED && needsMfaEnrollment(u),
      passwordChangeRequired: u.mustChangePassword,
    };
  });

  // Agents mark themselves on/off duty (affects automatic routing only).
  app.post('/auth/availability', { preHandler: requireAuth(db) }, async (req, reply) => {
    const b = z.object({ available: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query('UPDATE users SET available = $2 WHERE id = $1', [req.user!.id, b.data.available]);
    return { available: b.data.available };
  });

  app.post('/auth/password', { preHandler: auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ current: z.string().max(256), next: z.string().min(PASSWORD_MIN).max(256) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!(await verifyPassword(rows[0].password_hash, body.data.current))) return reply.code(401).send(invalid);
    if (body.data.next === body.data.current) return reply.code(400).send({ error: 'password_unchanged' });
    await db.query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [
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
