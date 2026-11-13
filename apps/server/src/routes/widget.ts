import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChannelManager } from '../channels/manager.js';
import type { Config } from '../config.js';
import { isOpen } from '../business-hours.js';
import { decrypt } from '../crypto.js';
import type { Db } from '../db.js';
import { normalizeEmail, normalizePhone } from '../contacts/identity.js';
import { loadPersona } from './branding.js';
import { behaviorSchema, designSchema, originAllowed, socialUrl, textOn, verifyIdentity, type Behavior, type Design } from '../webchat/config.js';
import { loadBusinessHours } from './settings.js';

const asset = (name: string) => readFileSync(new URL(`../webchat/assets/${name}`, import.meta.url));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Site { channelId: string; design: Design; behavior: Behavior; origins: string[]; anyOrigin: boolean; secretEnc: string }

/**
 * Public API of the website chat widget. Visitors are anonymous: the only credential is a random token kept in the widget's
 * own storage (hashed here). Which sites may embed the widget is enforced by the browser through CSP frame-ancestors on the
 * chat page; the API itself is same-origin to that page.
 */
export function widgetRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager, cfg: Config) {
  const appOrigins = cfg.APP_ORIGIN.split(',').map((o) => o.trim().replace(/\/$/, ''));
  const files = { js: asset('widget.js'), appJs: asset('widget-app.js'), css: asset('widget-app.css'), html: asset('widget-app.html') };
  const etag = (b: Buffer) => `"${sha(b.toString('latin1')).slice(0, 20)}"`;
  const tags = { js: etag(files.js), appJs: etag(files.appJs), css: etag(files.css), html: etag(files.html) };

  const serve = (path: string, type: string, body: Buffer, tag: string, extra: Record<string, string> = {}) =>
    app.get(path, async (req, reply) => {
      reply.header('content-type', type).header('etag', tag).header('cache-control', 'public, max-age=300').header('x-content-type-options', 'nosniff');
      for (const [k, v] of Object.entries(extra)) reply.header(k, v);
      return req.headers['if-none-match'] === tag ? reply.code(304).send() : reply.send(body);
    });
  // the loader is a cross-origin <script>: helmet's same-origin resource policy must be relaxed for it
  serve('/widget.js', 'text/javascript; charset=utf-8', files.js, tags.js, { 'cross-origin-resource-policy': 'cross-origin' });
  serve('/widget-app.js', 'text/javascript; charset=utf-8', files.appJs, tags.appJs);
  serve('/widget-app.css', 'text/css; charset=utf-8', files.css, tags.css);

  async function site(key: unknown): Promise<Site | null> {
    if (typeof key !== 'string' || !/^wc_[\w-]{10,60}$/.test(key)) return null;
    const { rows } = await db.query(
      `SELECT w.channel_id, w.design, w.behavior, w.allowed_origins, w.allow_any_origin, w.identity_secret_enc FROM webchat_configs w JOIN channels c ON c.id = w.channel_id WHERE w.public_key = $1 AND c.type = 'webchat'`, [key]);
    const r = rows[0];
    if (!r) return null;
    return { channelId: r.channel_id, design: designSchema.parse(r.design), behavior: behaviorSchema.parse(r.behavior), origins: r.allowed_origins, anyOrigin: r.allow_any_origin, secretEnc: r.identity_secret_enc };
  }

  // The chat page that sites embed in an iframe. WHO may embed it is decided by the browser from frame-ancestors.
  app.get('/w/:key', async (req, reply) => {
    const s = await site((req.params as { key: string }).key);
    if (!s) return reply.code(404).send('not found');
    const ancestors = s.anyOrigin ? '*' : [...s.origins, ...appOrigins].join(' ');
    reply.removeHeader('x-frame-options');
    reply
      .header('content-security-policy', `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`)
      .header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-cache').header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff');
    return reply.send(files.html);
  });

  const corsFor = (s: Site, req: FastifyRequest, reply: FastifyReply) => {
    const o = req.headers.origin;
    if (o && (s.anyOrigin || originAllowed(s.origins, o) || appOrigins.includes(o))) reply.header('access-control-allow-origin', o).header('vary', 'origin');
  };

  app.get('/widget/config', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = await site((req.query as { key?: string }).key);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    corsFor(s, req, reply);
    const hours = await loadBusinessHours(db);
    const text = textOn(s.design.color) ?? '#ffffff';
    const b = s.behavior;
    const lg = (await db.query(`SELECT extract(epoch FROM updated_at)::bigint AS v FROM branding_logo WHERE id = 1`)).rows[0];
    return {
      design: s.design, textColor: text, logo: lg ? `${appOrigins[0]}/branding/logo?v=${Number(lg.v)}` : null, available: !!mgr.webchatAdapter(s.channelId)?.isActive(), online: !hours.enabled || isOpen(hours, new Date()),
      behavior: { askName: b.askName, askEmail: b.askEmail, askPhone: b.askPhone, popupText: b.popupText, popupDelaySec: b.popupDelaySec, autoOpenSec: b.autoOpenSec, consentText: b.consentText, consentLink: b.consentLink, offlineMessage: b.offlineMessage, maxLength: b.maxLength },
      social: b.socialLinks.map((l) => ({ network: l.network, url: socialUrl(l) })),
      bot: await loadPersona(db).then((p) => ({ name: p.name, role: p.role, avatar: p.avatarV ? `${appOrigins[0]}/branding/bot-avatar?v=${p.avatarV}` : null })),
    };
  });

  // ---- visitor session -------------------------------------------------------------------------------------------
  const contactId = (visitor: { id: string; identity_id: string | null }) => (visitor.identity_id ? `${visitor.identity_id}@web` : `v${visitor.id.replaceAll('-', '')}@web`);

  async function visitorFrom(req: FastifyRequest): Promise<{ id: string; channel_id: string; identity_id: string | null } | null> {
    const h = req.headers.authorization;
    const t = h?.startsWith('Bearer ') ? h.slice(7) : '';
    if (!/^[\w-]{30,80}$/.test(t)) return null;
    const { rows } = await db.query('UPDATE webchat_visitors SET last_seen_at = now() WHERE token_hash = $1 RETURNING id, channel_id, identity_id', [sha(t)]);
    return rows[0] ?? null;
  }

  const conversationOf = async (channelId: string, v: { id: string; identity_id: string | null }) =>
    (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.channel_id = $1 AND ct.external_id = $2`, [channelId, contactId(v)])).rows[0]?.id as string | undefined;

  app.post('/widget/session', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ key: z.string().max(80), token: z.string().max(100).optional(), identity: z.object({ id: z.string().max(64), signature: z.string().max(128) }).passthrough().nullish() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const s = await site(b.data.key);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    let visitor: { id: string; identity_id: string | null } | undefined;
    let token: string | undefined;
    if (b.data.token && /^[\w-]{30,80}$/.test(b.data.token)) {
      visitor = (await db.query('UPDATE webchat_visitors SET last_seen_at = now() WHERE token_hash = $1 AND channel_id = $2 RETURNING id, identity_id', [sha(b.data.token), s.channelId])).rows[0];
    }
    if (!visitor) {
      const recent = (await db.query(`SELECT count(*)::int AS n FROM webchat_visitors WHERE channel_id = $1 AND created_at > now() - interval '1 hour'`, [s.channelId])).rows[0].n as number;
      if (recent >= 1000) return reply.code(429).send({ error: 'rate_limited' }); // a flood of new sessions is not a normal day
      token = randomBytes(32).toString('base64url');
      visitor = (await db.query('INSERT INTO webchat_visitors (channel_id, token_hash) VALUES ($1, $2) RETURNING id, identity_id', [s.channelId, sha(token)])).rows[0];
    }
    // verified identity: only a valid signature (computed by the host site's server with the identity secret) links the chat to a customer id
    const idn = b.data.identity;
    if (idn && visitor && verifyIdentity(decrypt(s.secretEnc, cfg.ENCRYPTION_KEY), idn.id, idn.signature)) {
      await db.query('UPDATE webchat_visitors SET identity_id = $2 WHERE id = $1', [visitor.id, idn.id]);
      visitor.identity_id = idn.id;
    }
    return { token, verified: !!visitor!.identity_id, hasConversation: !!(await conversationOf(s.channelId, visitor!)) };
  });

  // ---- messages --------------------------------------------------------------------------------------------------
  const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

  const perVisitor = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => sha(r.headers.authorization ?? r.ip) } });
  app.post('/widget/messages', { config: perVisitor(40) }, async (req, reply) => {
    const v = await visitorFrom(req);
    if (!v) return reply.code(401).send({ error: 'unauthorized' });
    const pk = (await db.query('SELECT public_key FROM webchat_configs WHERE channel_id = $1', [v.channel_id])).rows[0]?.public_key as string | undefined;
    const s = pk ? await site(pk) : null;
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const b = z.object({ text: z.string().max(4100), name: z.string().max(120).optional(), email: z.string().max(260).optional(), phone: z.string().max(40).optional(), consent: z.boolean().optional(), hp: z.string().max(200).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (b.data.hp) return { ok: true }; // honeypot filled: a bot. Pretend it worked.
    const text = clean(b.data.text, s.behavior.maxLength);
    if (!text) return reply.code(400).send({ error: 'bad_request' });
    const adapter = mgr.webchatAdapter(s.channelId);
    if (!adapter?.isActive()) return reply.code(503).send({ error: 'chat_offline' });

    const first = !(await conversationOf(s.channelId, v));
    let name = clean(b.data.name, 80), email = clean(b.data.email, 254), phone = clean(b.data.phone, 20);
    if (first) {
      const need = (mode: string, val: string) => mode === 'required' && !val;
      if (need(s.behavior.askName, name) || need(s.behavior.askEmail, email) || need(s.behavior.askPhone, phone)) return reply.code(400).send({ error: 'missing_details' });
      if (email && !/^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/.test(email)) return reply.code(400).send({ error: 'bad_email' });
      if (phone && !/^\+?[\d\s()-]{7,20}$/.test(phone)) return reply.code(400).send({ error: 'bad_phone' });
      if (s.behavior.consentText && b.data.consent !== true) return reply.code(400).send({ error: 'consent_required' });
    } else { name = ''; email = ''; phone = ''; }

    const externalMessageId = `wc-${randomUUID()}`;
    // later messages carry no name: the placeholder is only for a first message without one, so it never replaces a real name
    await adapter.ingest({ externalContactId: contactId(v), contactName: name || (first ? `מבקר באתר #${v.id.slice(0, 4)}` : undefined), externalMessageId, text, timestamp: new Date() });
    const row = (await db.query(`SELECT m.seq, m.conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE ct.channel_id = $1 AND m.external_id = $2`, [s.channelId, externalMessageId])).rows[0];
    if (first && row) {
      const bits = [email && `אימייל: ${email}`, phone && `טלפון: ${phone}`, v.identity_id && `מזהה לקוח מאומת: ${v.identity_id}`, s.behavior.consentText && 'אישר את ההצהרה באתר'].filter(Boolean);
      if (bits.length) await db.query('INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)', [row.conversation_id, `פרטים מצ׳אט האתר: ${bits.join(' | ')}`]).catch(() => undefined);
      // kept as typed-in (unverified) identifiers: staff are offered to link this visitor with the same person on other channels
      const cp = normalizePhone(phone), ce = normalizeEmail(email);
      if (cp || ce) await db.query('UPDATE contacts SET claimed_phone = COALESCE($2, claimed_phone), claimed_email = COALESCE($3, claimed_email) WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)', [row.conversation_id, cp, ce]).catch(() => undefined);
    }
    return { ok: true, seq: row ? Number(row.seq) : undefined };
  });

  // ---- question suggestions (autocomplete) --------------------------------------------------------------------------
  // Only questions from the knowledge base marked for the bot (FAQ entries), only for a visitor with a session, rate-limited.
  const suggestOn = async (channelId: string) => {
    const r = (await db.query('SELECT behavior FROM webchat_configs WHERE channel_id = $1', [channelId])).rows[0];
    return behaviorSchema.safeParse(r?.behavior ?? {}).data?.suggestions !== false;
  };
  const FAQ = `s.kind = 'faq' AND s.enabled AND s.status = 'ready' AND s.audience IN ('bot', 'both')`;
  app.get('/widget/suggest', { config: perVisitor(60) }, async (req, reply) => {
    const v = await visitorFrom(req);
    if (!v) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await suggestOn(v.channel_id))) return { items: [] };
    const q = clean((req.query as { q?: unknown }).q, 120).toLowerCase();
    if (q.length < 3) return { items: [] };
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const direct = (await db.query(
      `SELECT s.id, s.title FROM kb_sources s
        WHERE ${FAQ} AND (lower(s.title) LIKE $1 OR EXISTS (SELECT 1 FROM unnest(s.variants) x WHERE lower(x) LIKE $1))
        ORDER BY (lower(s.title) LIKE $2) DESC, s.uses DESC, length(s.title) LIMIT 5`, [like, `${q.replace(/[\\%_]/g, '\\$&')}%`])).rows as { id: string; title: string }[];
    const items = direct.map((r) => ({ id: r.id, q: r.title }));
    if (items.length < 5 && mgr.kb && q.includes(' ')) {
      // whole words typed: also entries that share several of them (Hebrew prefixes included)
      const hits = await mgr.kb.search(q, { audience: 'bot', limit: 8 }).catch(() => []);
      for (const h of hits) if (h.kind === 'faq' && (h.matched >= 2 || h.exact) && !items.some((x) => x.id === h.sourceId) && items.length < 5) items.push({ id: h.sourceId, q: h.title });
    }
    return { items };
  });
  app.get('/widget/answer/:id', { config: perVisitor(30) }, async (req, reply) => {
    const v = await visitorFrom(req);
    if (!v) return reply.code(401).send({ error: 'unauthorized' });
    const id = (req.params as { id?: string }).id ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id) || !(await suggestOn(v.channel_id))) return reply.code(404).send({ error: 'not_found' });
    const r = (await db.query(`UPDATE kb_sources s SET uses = uses + 1 WHERE s.id = $1 AND ${FAQ} RETURNING s.title, s.body, s.url`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await mgr.kb?.logQuery(r.title as string, 'bot', true, 1, id).catch(() => undefined);
    return { q: r.title, a: String(r.body ?? '').slice(0, 2000), url: typeof r.url === 'string' && /^https:\/\//.test(r.url) ? r.url : null };
  });

  app.get('/widget/messages', { config: perVisitor(90) }, async (req, reply) => {
    const v = await visitorFrom(req);
    if (!v) return reply.code(401).send({ error: 'unauthorized' });
    const q = z.object({ after: z.coerce.number().int().min(0).default(0), wait: z.coerce.number().int().min(0).max(25).default(0) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const cfgRow = (await db.query('SELECT behavior FROM webchat_configs WHERE channel_id = $1', [v.channel_id])).rows[0];
    if (!cfgRow) return reply.code(404).send({ error: 'not_found' });
    const showName = behaviorSchema.parse(cfgRow.behavior).showAgentName;

    const fetchNew = async () => {
      const convId = await conversationOf(v.channel_id, v);
      if (!convId) return { convId: undefined, rows: [] as Record<string, unknown>[], reactions: {} as Record<string, string> };
      const { rows } = await db.query(
        `SELECT m.seq, m.direction, m.body AS text, m.created_at AS "createdAt", m.auto, CASE WHEN m.direction = 'out' AND NOT m.auto THEN split_part(COALESCE(u.name_he, u.name), ' ', 1) END AS sender
           FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.conversation_id = $1 AND m.seq > $2 ORDER BY m.seq LIMIT 100`, [convId, q.data.after]);
      // our emoji on the visitor's own recent messages (a heart on "תודה"), sent in full every time so a removal shows too
      const rx = await db.query(`SELECT seq, our_reaction AS emoji FROM messages WHERE conversation_id = $1 AND direction = 'in' AND our_reaction IS NOT NULL ORDER BY seq DESC LIMIT 100`, [convId]);
      return { convId, rows, reactions: Object.fromEntries(rx.rows.map((r) => [String(r.seq), r.emoji as string])) };
    };
    let cur = await fetchNew();
    if (!cur.rows.length && q.data.wait > 0) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); clearInterval(tick); mgr.bus.off('event', onEvent); req.raw.off('close', finish); resolve(); };
        const onEvent = (e: { type?: string; channelId?: string }) => { if (e.type === 'message' && e.channelId === v.channel_id) finish(); };
        const timer = setTimeout(finish, q.data.wait * 1000);
        const tick = setInterval(finish, 8000); // safety net if a wake-up is missed
        mgr.bus.on('event', onEvent);
        req.raw.on('close', finish);
      });
      cur = await fetchNew();
    }
    return { messages: cur.rows.map((r) => ({ ...r, seq: Number(r.seq), sender: showName ? r.sender ?? null : null })), reactions: cur.reactions };
  });
}
