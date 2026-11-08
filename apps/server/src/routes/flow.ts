import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { loadBot } from '../bot.js';
import { isOpen } from '../business-hours.js';
import type { Db } from '../db.js';
import { runFlow, type FlowState } from '../flow/engine.js';
import { flowFromMenu } from '../flow/fromMenu.js';
import { buildSafetyFlow, TEMPLATE_TAGS, templateLinksSchema } from '../flow/safetyTemplate.js';
import { listOfficers } from '../safety/officers.js';
import { flowSchema, unfinished, unreachable, validateFlow, type Flow } from '../flow/schema.js';
import { loadFlow, saveFlow } from '../flow/store.js';
import type { KnowledgeBase } from '../kb/service.js';
import { resolveArea } from '../safety/areas.js';
import { loadBusinessHours } from './settings.js';

const stateSchema = z.object({
  node: z.string().max(30).nullable(), invalid: z.number().int().min(0).max(10), done: z.boolean(), endedAt: z.number().optional(), files: z.number().int().min(0).max(1000).optional(),
  vars: z.record(z.string().max(40), z.string().max(1000)).refine((v) => Object.keys(v).length <= 40),
  list: z.object({ items: z.array(z.string().max(200)).max(20), phase: z.enum(['item', 'more']) }).optional(),
});

export function flowRoutes(app: FastifyInstance, db: Db, kb: KnowledgeBase) {
  const view = requireAuth(db, 'bot.view');
  const manage = requireAuth(db, 'bot.manage');

  /** Everything the editor needs to pick from: people and tags. */
  app.get('/flow/refs', { preHandler: view }, async () => ({
    users: (await db.query('SELECT id, name FROM users WHERE active ORDER BY lower(name)')).rows,
    tags: (await db.query('SELECT id, name FROM tags ORDER BY lower(name)')).rows,
    /** officers by topic, for the "hand over to the officer of a topic" choice */
    officers: (await listOfficers(db)).map((o) => ({ id: o.id, name: o.name, active: o.active, hasAccount: !!o.userId && o.userActive, topics: o.topics })),
    topics: [...new Set([...TEMPLATE_TAGS, ...(await db.query('SELECT DISTINCT topic FROM officer_topics')).rows.map((r) => r.topic as string)])],
  }));

  app.get('/flow', { preHandler: view }, async () => {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'flow'`);
    const p = flowSchema.safeParse(rows[0]?.value);
    const bot = await loadBot(db);
    return { mode: bot.mode, flow: p.success ? p.data : null, problems: p.success ? validateFlow(p.data) : [], unreachable: p.success ? unreachable(p.data) : [], unfinished: p.success ? unfinished(p.data) : [] };
  });

  app.put('/flow', { preHandler: manage, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = flowSchema.safeParse((req.body as { flow?: unknown } | null)?.flow);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', problems: b.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) });
    const problems = validateFlow(b.data);
    if (problems.length) return reply.code(400).send({ error: 'invalid_flow', problems });
    const users = [...new Set(b.data.nodes.flatMap((n) => (n.type === 'handoff' && n.userId ? [n.userId] : [])))];
    const tags = [...new Set(b.data.nodes.flatMap((n) => (n.type === 'tag' ? [n.tagId] : [])))];
    if (users.length && (await db.query('SELECT count(*)::int AS n FROM users WHERE active AND id = ANY($1::uuid[])', [users])).rows[0].n !== users.length) return reply.code(400).send({ error: 'unknown_user' });
    if (tags.length && (await db.query('SELECT count(*)::int AS n FROM tags WHERE id = ANY($1::uuid[])', [tags])).rows[0].n !== tags.length) return reply.code(400).send({ error: 'unknown_tag' });
    await saveFlow(db, b.data);
    await audit(db, { actorId: req.user!.id, action: 'settings.flow', ip: req.ip, meta: { nodes: b.data.nodes.length } });
    return { ok: true, unreachable: unreachable(b.data) };
  });

  // Which bot mode answers customers: the numbered menu or the flow chart (a saved, valid flow is required for "flow").
  app.put('/flow/mode', { preHandler: manage }, async (req, reply) => {
    const b = z.object({ mode: z.enum(['menu', 'flow']) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const saved = b.data.mode === 'flow' ? await loadFlow(db) : null;
    if (b.data.mode === 'flow' && !saved) return reply.code(409).send({ error: 'no_valid_flow' });
    // customers must never receive "[להשלים: ...]" placeholders
    if (saved && unfinished(saved).length) return reply.code(409).send({ error: 'unfinished_flow', nodes: unfinished(saved) });
    const bot = await loadBot(db);
    await db.query(`INSERT INTO settings (key, value) VALUES ('bot', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ ...bot, mode: b.data.mode })]);
    await audit(db, { actorId: req.user!.id, action: 'settings.bot_mode', ip: req.ip, meta: { mode: b.data.mode } });
    return { mode: b.data.mode };
  });

  // The safety unit's flow (identification, forms, reports with photos, officers by area). Creates the tags it uses; not saved until PUT.
  app.post('/flow/templates/safety', { preHandler: manage, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const links = z.object({ links: templateLinksSchema.default(() => ({})) }).safeParse(req.body ?? {});
    if (!links.success) return reply.code(400).send({ error: 'bad_request' });
    const ids = new Map<string, string>();
    for (const name of TEMPLATE_TAGS) {
      await db.query('INSERT INTO tags (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
      ids.set(name, (await db.query('SELECT id FROM tags WHERE lower(name) = lower($1)', [name])).rows[0].id as string);
    }
    await audit(db, { actorId: req.user!.id, action: 'flow.template_safety', ip: req.ip });
    return { flow: buildSafetyFlow((n) => ids.get(n) ?? ids.get('שאלה כללית')!, links.data.links), unfinished: [] as string[] };
  });

  // A flow equivalent to today's numbered menu: a starting point to edit (not saved until PUT).
  app.post('/flow/from-menu', { preHandler: manage }, async () => ({ flow: flowFromMenu(await loadBot(db)) }));

  // Dry run for the editor's test chat: nothing is stored, no message is sent. The client keeps the state between calls.
  app.post('/flow/simulate', { preHandler: view, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ flow: flowSchema.optional(), state: stateSchema.nullable(), text: z.string().max(1000).nullable(), media: z.boolean().optional(), open: z.boolean().default(true), channel: z.enum(['whatsapp', 'whatsapp_cloud', 'telegram']).default('whatsapp') }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const flow: Flow | null = b.data.flow ?? (await loadFlow(db));
    if (!flow) return reply.code(404).send({ error: 'no_flow' });
    if (validateFlow(flow).length) return reply.code(400).send({ error: 'invalid_flow', problems: validateFlow(flow) });
    const bot = await loadBot(db);
    const hours = await loadBusinessHours(db);
    const r = await runFlow(flow, b.data.state as FlowState | null, { text: b.data.text, media: b.data.media }, {
      isOpen: b.data.open ?? (!hours.enabled || isOpen(hours, new Date())), channelType: b.data.channel,
      humanKeywords: bot.humanKeywords, humanOption: bot.humanOption, invalidRetries: bot.invalidRetries, invalidMessage: bot.invalidMessage,
      kbAnswer: async (t) => { const a = await kb.answer(t, { minScore: bot.kb.minScore, maxChars: bot.kb.maxChars }, 'bot', 'test').catch(() => null); return a ? [bot.kb.intro, a.text].filter(Boolean).join('\n\n') : null; },
      matchOption: (t, o) => kb.matchOption(t, o),
      resolveArea: (t) => resolveArea(db, t),
    }, bot.humanLabel);
    return r;
  });
}
