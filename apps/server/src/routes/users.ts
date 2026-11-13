import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth, type AuthUser } from '../auth.js';
import type { Db } from '../db.js';
import { hashPassword, PASSWORD_MIN } from '../password.js';
import { usernameSchema } from '../usernames.js';
import { sanitizeFileName } from '../media/validate.js';
import { parseUsersWorkbook, usersTemplate } from '../usersImport.js';
import { BUILTIN_ROLES, cleanPermissions, isSubset } from '../permissions.js';

const idParam = z.object({ id: z.string().uuid() });
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';   // no look-alike characters
const publicCols = 'id, email, username, name, role, active, available, job_title AS "jobTitle", name_he AS "nameHe", totp_enabled AS "mfaEnabled", created_at AS "createdAt", (SELECT floor(extract(epoch FROM a.updated_at))::float8 FROM user_avatars a WHERE a.user_id = users.id) AS "avatarV"';

export async function permissionsOfRole(db: Db, key: string): Promise<string[] | null> {
  const { rows } = await db.query('SELECT permissions, builtin FROM roles WHERE key = $1', [key]);
  if (!rows[0]) return null;
  return rows[0].builtin && BUILTIN_ROLES[key] ? BUILTIN_ROLES[key]!.permissions : cleanPermissions(rows[0].permissions);
}

/** Nobody can hand out (or take away) more than they hold themselves. */
export async function mayUseRole(db: Db, actor: AuthUser, roleKey: string): Promise<boolean> {
  const perms = await permissionsOfRole(db, roleKey);
  return perms !== null && isSubset(perms, actor.permissions);
}

async function activeAdmins(db: Db, exceptUserId?: string): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND ($1::uuid IS NULL OR id <> $1)`, [exceptUserId ?? null]);
  return rows[0].n;
}

export function userRoutes(app: FastifyInstance, db: Db, scan: (buf: Buffer) => Promise<'clean' | 'infected' | 'unavailable'> = async () => 'unavailable') {
  const manage = requireAuth(db, 'users.manage');

  app.get('/users', { preHandler: requireAuth(db, 'users.view') }, async () => {
    const { rows } = await db.query(`SELECT ${publicCols} FROM users ORDER BY created_at`);
    return rows;
  });

  // ---- many people at once: from a workbook (name, e-mail, job title, permission level), one first password for all ----
  app.get('/users/import/template.xlsx', { preHandler: manage }, async (_req, reply) => reply
    .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('content-disposition', 'attachment; filename="users-template.xlsx"').send(await usersTemplate()));

  /** Reads the workbook and shows what would be created; nothing is saved here. */
  app.post('/users/import/preview', { preHandler: manage, bodyLimit: 5 * 1024 * 1024 + 64 * 1024, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const file = await req.file({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    if (!file) return reply.code(400).send({ error: 'bad_request' });
    if (!/\.xlsx$/i.test(sanitizeFileName(file.filename, 'x'))) return reply.code(415).send({ error: 'unsupported_file_type' });
    let buf: Buffer;
    try { buf = await file.toBuffer(); } catch { return reply.code(413).send({ error: 'too_large' }); }
    if (file.file.truncated) return reply.code(413).send({ error: 'too_large' });
    const sc = await scan(buf);
    if (sc === 'infected') return reply.code(422).send({ error: 'file_infected' });
    if (sc === 'unavailable') return reply.code(503).send({ error: 'scan_unavailable' });
    const roles = (await db.query('SELECT key, name FROM roles')).rows as { key: string; name: string }[];
    let parsed;
    try { parsed = await parseUsersWorkbook(buf, roles); } catch (e) { return reply.code(422).send({ error: (e as Error).message === 'unknown_workbook' ? 'unknown_workbook' : 'extract_failed' }); }
    const existing = new Set((await db.query('SELECT lower(email) AS e FROM users WHERE lower(email) = ANY($1::text[])', [parsed.rows.map((r) => r.email)])).rows.map((r) => r.e as string));
    return { ...parsed, rows: parsed.rows.map((r) => ({ ...r, exists: existing.has(r.email) })) };
  });

  /** Creates the chosen people with one first password; each must change it at the first sign-in. Existing e-mails are skipped (or get their job title). */
  app.post('/users/import', { preHandler: manage, bodyLimit: 512 * 1024, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const body = z.object({
      password: z.string().min(PASSWORD_MIN).max(256),
      defaultRole: z.string().min(1).max(41),
      updateExisting: z.boolean().default(false),
      rows: z.array(z.object({
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().email().max(254).transform((s) => s.toLowerCase()),
        jobTitle: z.string().trim().max(80).nullable().optional(),
        role: z.string().min(1).max(41).nullable().optional(),
      })).min(1).max(500),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const b = body.data;
    const actor = req.user!;
    // every role used must exist and be within the actor's own permissions (no privilege escalation through a spreadsheet)
    const used = [...new Set([b.defaultRole, ...b.rows.map((r) => r.role).filter((r): r is string => !!r)])];
    for (const r of used) {
      if ((await permissionsOfRole(db, r)) === null) return reply.code(400).send({ error: 'unknown_role', detail: r });
      if (!(await mayUseRole(db, actor, r))) return reply.code(403).send({ error: 'role_exceeds_permissions', detail: r });
    }
    const out = { created: 0, updated: 0, skipped: [] as { email: string; reason: 'exists' | 'duplicate' }[] };
    // the same first password, hashed with its own salt per new person (argon2 is slow on purpose: four at a time)
    const known = new Set((await db.query('SELECT lower(email) AS e FROM users WHERE lower(email) = ANY($1::text[])', [b.rows.map((r) => r.email)])).rows.map((r) => r.e as string));
    const fresh = [...new Set(b.rows.map((r) => r.email))].filter((e) => !known.has(e));
    const hashes = new Map<string, string>();
    for (let i = 0; i < fresh.length; i += 4) {
      const part = fresh.slice(i, i + 4);
      (await Promise.all(part.map(() => hashPassword(b.password)))).forEach((h, k) => hashes.set(part[k]!, h));
    }
    const seen = new Set<string>();
    for (const r of b.rows) {
      if (seen.has(r.email)) { out.skipped.push({ email: r.email, reason: 'duplicate' }); continue; }
      seen.add(r.email);
      const title = r.jobTitle ? r.jobTitle.replace(/[\r\n]+/g, ' ') : null;
      const h = hashes.get(r.email);
      const ins = h ? await db.query(
        `INSERT INTO users (email, name, role, password_hash, must_change_password, job_title) VALUES ($1,$2,$3,$4,true,$5)
         ON CONFLICT DO NOTHING RETURNING id`, [r.email, r.name, r.role || b.defaultRole, h, title]) : { rowCount: 0 };
      if (ins.rowCount) { out.created++; continue; }
      if (b.updateExisting && title) {
        const u = await db.query('UPDATE users SET job_title = $2, updated_at = now() WHERE lower(email) = $1 RETURNING id', [r.email, title]);
        if (u.rowCount) { out.updated++; continue; }
      }
      out.skipped.push({ email: r.email, reason: 'exists' });
    }
    await audit(db, { actorId: actor.id, action: 'user.import', ip: req.ip, meta: { created: out.created, updated: out.updated, skipped: out.skipped.length, roles: used } });
    return out;
  });

  app.post('/users', { preHandler: manage }, async (req, reply) => {
    const body = z
      .object({
        email: z.string().email().max(254).transform((s) => s.toLowerCase()),
        name: z.string().min(1).max(100),
        role: z.string().min(1).max(41),
        password: z.string().min(PASSWORD_MIN).max(256),
        username: usernameSchema.optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const b = body.data;
    if ((await permissionsOfRole(db, b.role)) === null) return reply.code(400).send({ error: 'unknown_role' });
    if (!(await mayUseRole(db, req.user!, b.role))) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    try {
      const { rows } = await db.query(
        `INSERT INTO users (email, name, role, password_hash, username) VALUES ($1,$2,$3,$4,$5) RETURNING ${publicCols}`,
        [b.email, b.name, b.role, await hashPassword(b.password), b.username ?? null],
      );
      await audit(db, { actorId: req.user!.id, action: 'user.create', target: rows[0].id, ip: req.ip, meta: { role: b.role } });
      return reply.code(201).send(rows[0]);
    } catch (e) {
      if ((e as { code?: string; constraint?: string }).code === '23505') return reply.code(409).send({ error: (e as { constraint?: string }).constraint === 'users_username_idx' ? 'username_taken' : 'email_taken' });
      throw e;
    }
  });

  app.patch('/users/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = z
      .object({ name: z.string().min(1).max(100), role: z.string().min(1).max(41), active: z.boolean(), username: usernameSchema, jobTitle: z.string().trim().max(80).transform((v) => v.replace(/[\r\n]+/g, ' ')),
        nameHe: z.string().trim().max(100).refine((v) => v === '' || (v.length >= 2 && /[א-ת]/.test(v)), 'hebrew') })
      .partial()
      .refine((o) => Object.keys(o).length > 0)
      .safeParse(req.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: 'bad_request' });
    const { id } = p.data;
    const b = body.data;
    const actor = req.user!;

    const cur = (await db.query('SELECT role FROM users WHERE id = $1', [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (id === actor.id && (b.active === false || (b.role && b.role !== cur.role))) return reply.code(409).send({ error: 'cannot_demote_self' });
    // may only touch people whose current role is within your own permissions, and only assign roles within them
    if (!(await mayUseRole(db, actor, cur.role))) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    if (b.role) {
      if ((await permissionsOfRole(db, b.role)) === null) return reply.code(400).send({ error: 'unknown_role' });
      if (!(await mayUseRole(db, actor, b.role))) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    }
    // never leave the system without an active administrator
    const losesAdmin = cur.role === 'admin' && (b.active === false || (b.role !== undefined && b.role !== 'admin'));
    if (losesAdmin && (await activeAdmins(db, id)) === 0) return reply.code(409).send({ error: 'last_admin' });

    let rows;
    try {
      ({ rows } = await db.query(
        `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active), username = COALESCE($5, username),
                job_title = CASE WHEN $6::boolean THEN NULLIF($7, '') ELSE job_title END,
                name_he = CASE WHEN $8::boolean THEN NULLIF($9, '') ELSE name_he END, updated_at = now()
          WHERE id = $1 RETURNING ${publicCols}`,
        [id, b.name ?? null, b.role ?? null, b.active ?? null, b.username ?? null, b.jobTitle !== undefined, b.jobTitle ?? null, b.nameHe !== undefined, b.nameHe ?? null],
      ));
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'username_taken' });
      throw e;
    }
    if (b.active === false || b.role) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit(db, { actorId: actor.id, action: 'user.update', target: id, ip: req.ip, meta: b });
    return rows[0];
  });

  // Account recovery: removes the second factor (TOTP and passkeys) and signs the user out everywhere.
  app.post('/users/:id/reset-mfa', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = (await db.query('SELECT role FROM users WHERE id = $1', [p.data.id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayUseRole(db, req.user!, cur.role))) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    await db.query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL WHERE id = $1', [p.data.id]);
    await db.query('DELETE FROM passkeys WHERE user_id = $1', [p.data.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [p.data.id]);
    await audit(db, { actorId: req.user!.id, action: 'user.mfa_reset', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // A temporary password for someone who forgot theirs. Shown once; the person must choose their own at the next sign-in.
  app.post('/users/:id/reset-password', { preHandler: manage, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ password: z.string().min(PASSWORD_MIN).max(256).optional() }).safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (p.data.id === req.user!.id) return reply.code(409).send({ error: 'use_account_page' });
    const cur = (await db.query('SELECT role FROM users WHERE id = $1', [p.data.id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayUseRole(db, req.user!, cur.role))) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    const generated = b.data.password === undefined;
    const pw = b.data.password ?? Array.from({ length: 16 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('');
    await db.query('UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [p.data.id, await hashPassword(pw)]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [p.data.id]);
    await audit(db, { actorId: req.user!.id, action: 'user.password_reset', target: p.data.id, ip: req.ip, meta: { generated } });
    return reply.header('cache-control', 'no-store').send(generated ? { ok: true, temporaryPassword: pw } : { ok: true });
  });

  // Delete an account. The person's conversations stay (unassigned), their notes and messages stay without a name; sessions, passkeys and stars go.
  app.delete('/users/:id', { preHandler: manage, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ email: z.string().email().max(254).transform((s) => s.toLowerCase()) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const actor = req.user!;
    if (p.data.id === actor.id) return reply.code(409).send({ error: 'cannot_delete_self' });
    const cur = (await db.query('SELECT role, email, active FROM users WHERE id = $1', [p.data.id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (b.data.email !== String(cur.email).toLowerCase()) return reply.code(400).send({ error: 'confirm_mismatch' });   // typed address must match: no deleting by a mistaken click
    if (!(await mayUseRole(db, actor, cur.role))) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    if (cur.role === 'admin' && cur.active && (await activeAdmins(db, p.data.id)) === 0) return reply.code(409).send({ error: 'last_admin' });
    await db.query('DELETE FROM users WHERE id = $1', [p.data.id]);
    await audit(db, { actorId: actor.id, action: 'user.delete', target: p.data.id, ip: req.ip, meta: { role: cur.role } });
    return { ok: true };
  });

  app.get('/audit', { preHandler: requireAuth(db, 'audit.view') }, async (req, reply) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().positive().optional(), // keyset pagination: rows with id < before
        action: z.string().max(60).regex(/^[a-z_.]*$/).optional(), // prefix filter, e.g. "login" or "user."
      })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query(
      `SELECT a.id, a.actor_id AS "actorId", u.name AS "actorName", a.action, a.target, a.ip, a.created_at AS "createdAt"
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($2::bigint IS NULL OR a.id < $2) AND ($3::text IS NULL OR a.action LIKE $3 || '%')
        ORDER BY a.id DESC LIMIT $1`,
      [q.data.limit, q.data.before ?? null, q.data.action ?? null],
    );
    return rows;
  });
}
