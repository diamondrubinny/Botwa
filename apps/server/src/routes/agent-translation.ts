import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { loadAccessible } from '../access.js';
import { requireAuth } from '../auth.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { asLang, detectLang, type Lang } from '../i18n/lang.js';
import { MT_MAX_INPUT, translateText } from '../i18n/mt.js';
import { llmStatus, type LlmConfig } from '../kb/compose.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Whether customers' messages are translated for the agent as soon as a conversation is opened (default on). */
export async function loadAgentTranslation(db: Db): Promise<{ auto: boolean }> {
  const v = (await db.query(`SELECT value FROM settings WHERE key = 'agent_translation'`)).rows[0]?.value as { auto?: unknown } | undefined;
  return { auto: v?.auto !== false };
}

/** The conversation's language; when it was never set, the language of the customer's latest message that shows one. */
export async function conversationLang(db: Db, convId: string): Promise<Lang> {
  const r = (await db.query(`SELECT lang FROM conversations WHERE id = $1`, [convId])).rows[0];
  if (r?.lang) return asLang(r.lang);
  const msgs = (await db.query(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'in' AND body IS NOT NULL ORDER BY created_at DESC LIMIT 5`, [convId])).rows as { body: string }[];
  for (const m of msgs) { const l = detectLang(m.body); if (l) return l; }
  return 'he';
}

/**
 * Translation for the team by the local model (no outside service):
 *  - GET  /translation/status                              is it set up, and is it automatic for incoming messages
 *  - PUT  /settings/agent-translation {auto}               switch the automatic translation (bot.manage)
 *  - POST /conversations/:id/messages/:mid/translation     a customer's message in Hebrew (kept with the message)
 *  - POST /conversations/:id/translate-draft {text}        the agent's Hebrew draft in the conversation's language (not stored)
 * Every conversation route checks the caller may see the conversation, like the rest of the inbox.
 */
export function agentTranslationRoutes(app: FastifyInstance, db: Db, cfg?: Config, fetchImpl?: FetchLike) {
  const llm: LlmConfig = { url: cfg?.LOCAL_LLM_URL ?? '', model: cfg?.LOCAL_LLM_MODEL ?? '', timeoutMs: cfg?.LOCAL_LLM_TIMEOUT_MS ?? 30_000 };
  const any = requireAuth(db);
  // opening a conversation translates its recent messages once (then they are kept); the model itself is protected by running at
  // most two translations at a time
  const limit = { rateLimit: { max: 120, timeWindow: '1 minute' } };
  // model availability is asked of Ollama at most once a minute
  let status: { at: number; ready: boolean } | null = null;
  const ready = async () => {
    if (!llm.url) return false;
    if (status && Date.now() - status.at < 60_000) return status.ready;
    const s = await llmStatus(llm, fetchImpl);
    status = { at: Date.now(), ready: s.reachable && s.installed };
    return status.ready;
  };

  app.get('/translation/status', { preHandler: any }, async () => ({ configured: !!llm.url, ready: await ready(), ...(await loadAgentTranslation(db)) }));

  app.put('/settings/agent-translation', { preHandler: requireAuth(db, 'bot.manage') }, async (req, reply) => {
    const b = z.object({ auto: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query(`INSERT INTO settings (key, value) VALUES ('agent_translation', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(b.data)]);
    await audit(db, { actorId: req.user!.id, action: 'settings.agent_translation', target: b.data.auto ? 'auto' : 'manual', ip: req.ip });
    return b.data;
  });

  app.post('/conversations/:id/messages/:mid/translation', { preHandler: any, config: limit }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), mid: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    const m = (await db.query(
      `SELECT m.body, m.automation, c.lang, t.body AS cached, t.numbers_differ AS warn FROM messages m JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN message_translations t ON t.message_id = m.id AND t.lang = 'he' WHERE m.id = $1 AND m.conversation_id = $2`,
      [p.data.mid, conv.id],
    )).rows[0] as { body: string | null; automation: string | null; lang: string | null; cached: string | null; warn: boolean | null } | undefined;
    if (!m || m.automation === 'form_otp') return reply.code(404).send({ error: 'not_found' });
    if (m.cached) return { text: m.cached, cached: true, ...(m.warn ? { warning: 'numbers' } : {}) };
    const body = (m.body ?? '').trim();
    // the language of this message, else the conversation's; Hebrew needs no translation
    const from: Lang = detectLang(body) ?? asLang(m.lang);
    if (!body || from === 'he') return reply.code(409).send({ error: 'not_needed' });
    if (body.length > MT_MAX_INPUT) return reply.code(413).send({ error: 'too_long' });
    if (!(await ready())) return reply.code(503).send({ error: 'translation_unavailable' });
    const r = await translateText(llm, body, from, 'he', fetchImpl);
    if (!r) return reply.code(502).send({ error: 'translation_failed' });
    await db.query(
      `INSERT INTO message_translations (message_id, lang, body, model, numbers_differ) VALUES ($1, 'he', $2, $3, $4) ON CONFLICT (message_id, lang) DO NOTHING`,
      [p.data.mid, r.text, llm.model, !!r.warning],
    );
    return { text: r.text, cached: false, ...(r.warning ? { warning: r.warning } : {}) };
  });

  app.post('/conversations/:id/translate-draft', { preHandler: any, config: limit }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const b = z.object({ text: z.string().trim().min(1).max(MT_MAX_INPUT), to: z.enum(['en', 'ar', 'ru']).optional() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    const to: Lang = b.data.to ?? await conversationLang(db, conv.id);
    if (to === 'he') return reply.code(409).send({ error: 'not_needed' });
    const from: Lang = detectLang(b.data.text) ?? 'he';
    if (from === to) return reply.code(409).send({ error: 'not_needed' });
    if (!(await ready())) return reply.code(503).send({ error: 'translation_unavailable' });
    const r = await translateText(llm, b.data.text, from, to, fetchImpl);
    if (!r) return reply.code(502).send({ error: 'translation_failed' });
    return { text: r.text, to, ...(r.warning ? { warning: r.warning } : {}) };
  });
}
