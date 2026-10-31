import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth, startSession } from '../auth.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';

const CHALLENGE_TTL = '5 minutes';

/** RP ID = the registrable host the passkeys are bound to. With several panel origins (apex + www) use the shortest host that all others end with. */
export function relyingParty(cfg: Config): { rpID: string; origins: string[] } {
  const origins = cfg.APP_ORIGIN.split(',').map((o) => o.trim().replace(/\/$/, ''));
  const hosts = origins.map((o) => new URL(o).hostname);
  const common = [...hosts].sort((a, b) => a.length - b.length).find((h) => hosts.every((x) => x === h || x.endsWith(`.${h}`)));
  return { rpID: cfg.WEBAUTHN_RP_ID ?? common ?? hosts[0]!, origins };
}

const b64 = z.string().min(1).max(4096);
const credentialSchema = z.object({
  id: b64,
  rawId: b64,
  type: z.literal('public-key'),
  response: z.record(z.string(), z.unknown()),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().optional(),
}).passthrough();

export function passkeyRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  const { rpID, origins } = relyingParty(cfg);
  const auth = requireAuth(db, undefined, { allowEnrollment: true });
  const limit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  async function takeChallenge(id: string, kind: 'register' | 'login'): Promise<{ challenge: string; user_id: string | null } | null> {
    const { rows } = await db.query(
      `DELETE FROM webauthn_challenges WHERE id = $1 AND kind = $2 AND expires_at > now() RETURNING challenge, user_id`,
      [id, kind],
    );
    return rows[0] ?? null; // one-time use: replays and expired challenges find nothing
  }

  // ---- registration (signed-in user adds a passkey) ----
  app.post('/auth/passkeys/register/options', { preHandler: auth, config: limit }, async (req) => {
    const u = req.user!;
    await db.query(`DELETE FROM webauthn_challenges WHERE expires_at < now()`);
    const existing = await db.query('SELECT credential_id, transports FROM passkeys WHERE user_id = $1', [u.id]);
    const options = await generateRegistrationOptions({
      rpName: 'Botwa',
      rpID,
      userName: u.email,
      userDisplayName: u.name,
      userID: new TextEncoder().encode(u.id),
      attestationType: 'none',
      excludeCredentials: existing.rows.map((r) => ({ id: r.credential_id, transports: r.transports ?? undefined })),
      // discoverable credential + biometric/PIN: sign-in needs no username and counts as a second factor
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const id = randomUUID();
    await db.query(`INSERT INTO webauthn_challenges (id, user_id, kind, challenge, expires_at) VALUES ($1,$2,'register',$3, now() + interval '${CHALLENGE_TTL}')`, [id, u.id, options.challenge]);
    return { challengeId: id, options };
  });

  app.post('/auth/passkeys/register/verify', { preHandler: auth, config: limit }, async (req, reply) => {
    const body = z.object({ challengeId: z.string().uuid(), response: credentialSchema, name: z.string().trim().min(1).max(60).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const ch = await takeChallenge(body.data.challengeId, 'register');
    if (!ch || ch.user_id !== req.user!.id) return reply.code(400).send({ error: 'challenge_expired' });
    let v;
    try {
      v = await verifyRegistrationResponse({
        response: body.data.response as never,
        expectedChallenge: ch.challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      await audit(db, { actorId: req.user!.id, action: 'passkey.register_failed', ip: req.ip });
      return reply.code(400).send({ error: 'passkey_invalid' });
    }
    if (!v.verified) return reply.code(400).send({ error: 'passkey_invalid' });
    const c = v.registrationInfo.credential;
    try {
      await db.query(
        `INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.user!.id, c.id, Buffer.from(c.publicKey), c.counter, c.transports ?? null, v.registrationInfo.credentialDeviceType, v.registrationInfo.credentialBackedUp, body.data.name ?? 'Passkey'],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'passkey_exists' });
      throw e;
    }
    await audit(db, { actorId: req.user!.id, action: 'passkey.register', ip: req.ip });
    return reply.code(201).send({ ok: true });
  });

  // ---- sign-in (no username needed: the browser offers the discoverable passkeys for this site) ----
  app.post('/auth/passkeys/login/options', { config: limit }, async () => {
    await db.query(`DELETE FROM webauthn_challenges WHERE expires_at < now()`);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    const id = randomUUID();
    await db.query(`INSERT INTO webauthn_challenges (id, user_id, kind, challenge, expires_at) VALUES ($1,NULL,'login',$2, now() + interval '${CHALLENGE_TTL}')`, [id, options.challenge]);
    return { challengeId: id, options };
  });

  app.post('/auth/passkeys/login/verify', { config: limit }, async (req, reply) => {
    const fail = async (why: string, userId?: string) => {
      await audit(db, { actorId: userId, action: 'login.fail', ip: req.ip, meta: { via: 'passkey', why } });
      return reply.code(401).send({ error: 'invalid_credentials' }); // same answer for every failure
    };
    const body = z.object({ challengeId: z.string().uuid(), response: credentialSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const ch = await takeChallenge(body.data.challengeId, 'login');
    if (!ch) return fail('challenge');
    const { rows } = await db.query(
      `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports, u.active
         FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = $1`,
      [body.data.response.id],
    );
    const pk = rows[0];
    if (!pk || !pk.active) return fail('unknown_credential', pk?.user_id);
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: body.data.response as never,
        expectedChallenge: ch.challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: { id: body.data.response.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports ?? undefined },
      });
    } catch {
      return fail('verification', pk.user_id);
    }
    if (!v.verified) return fail('verification', pk.user_id);
    await db.query('UPDATE passkeys SET counter = $2, last_used_at = now(), backed_up = $3 WHERE id = $1', [pk.id, v.authenticationInfo.newCounter, v.authenticationInfo.credentialBackedUp]);
    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [pk.user_id]);
    await startSession(db, cfg, req, reply, pk.user_id);
    await audit(db, { actorId: pk.user_id, action: 'login.success', ip: req.ip, meta: { via: 'passkey' } });
    return { ok: true };
  });

  // ---- manage own passkeys ----
  app.get('/auth/passkeys', { preHandler: auth }, async (req) => {
    const { rows } = await db.query(
      `SELECT id, name, device_type AS "deviceType", backed_up AS "backedUp", created_at AS "createdAt", last_used_at AS "lastUsedAt"
         FROM passkeys WHERE user_id = $1 ORDER BY created_at`,
      [req.user!.id],
    );
    return rows;
  });

  app.delete('/auth/passkeys/:id', { preHandler: auth }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2', [p.data.id, req.user!.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'passkey.delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });
}
