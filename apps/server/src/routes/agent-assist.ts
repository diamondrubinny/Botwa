import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadAccessible } from '../access.js';
import { requireAuth } from '../auth.js';
import { loadBot } from '../bot.js';
import type { ChannelManager } from '../channels/manager.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { loadGlossary } from '../i18n/glossary.js';
import { detectLang } from '../i18n/lang.js';
import { translateText } from '../i18n/mt.js';
import { suggestReply, summarize, type Line } from '../kb/assist.js';
import type { LlmConfig } from '../kb/compose.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Help for the agent from the local model, on conversations the caller may see:
 *  - POST /conversations/:id/suggest-reply   a Hebrew draft from the knowledge base for the customer's latest question(s)
 *  - POST /conversations/:id/summary         "what was asked, what was done, what is open" (the agent may save it as a note)
 * Both return drafts only: nothing is sent to the customer or stored.
 */
export function agentAssistRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager, cfg?: Config, fetchImpl?: FetchLike) {
  const llm: LlmConfig = { url: cfg?.LOCAL_LLM_URL ?? '', model: cfg?.LOCAL_LLM_MODEL ?? '', timeoutMs: cfg?.LOCAL_LLM_TIMEOUT_MS ?? 30_000 };
  const any = requireAuth(db);
  const limit = { rateLimit: { max: 20, timeWindow: '1 minute' } };
  const idParam = z.object({ id: z.string().uuid() });

  /** The conversation's recent text messages, oldest first (form codes hidden, attachments left out). */
  const lines = async (convId: string, n: number): Promise<(Line & { at: Date })[]> => {
    const rows = (await db.query(
      `SELECT direction, auto, body, created_at FROM messages WHERE conversation_id = $1 AND body IS NOT NULL AND body <> '' AND automation IS DISTINCT FROM 'form_otp'
        ORDER BY created_at DESC LIMIT $2`, [convId, n],
    )).rows as { direction: 'in' | 'out'; auto: boolean; body: string; created_at: Date }[];
    return rows.reverse().map((r) => ({ who: r.direction === 'in' ? 'customer' : r.auto ? 'bot' : 'team', text: r.body, at: r.created_at }));
  };

  app.post('/conversations/:id/suggest-reply', { preHandler: any, config: limit }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    if (!llm.url) return reply.code(503).send({ error: 'assist_unavailable' });
    if (!mgr.kb) return reply.code(409).send({ error: 'no_kb' });
    const recent = await lines(conv.id, 12);
    // the customer's messages since the team last wrote: that is what needs an answer
    const lastTeam = recent.map((l) => l.who).lastIndexOf('team');
    const asks = recent.slice(lastTeam + 1).filter((l) => l.who === 'customer').slice(-3).map((l) => l.text.trim()).filter(Boolean);
    if (!asks.length) return reply.code(409).send({ error: 'no_question' });
    const bot = await loadBot(db);
    const glossary = await loadGlossary(db);
    // the newest message alone first (a short "thanks" before it should not dilute it), then all of them together. The agent reviews
    // every draft, so the bar is a little lower than the bot's own (never below 0.3); the passages still bound what is written.
    const settings = { minScore: Math.max(0.3, bot.kb.minScore - 0.1), maxChars: 1200 };
    let a: Awaited<ReturnType<NonNullable<typeof mgr.kb>['answer']>> = null;
    let question = '', lang: ReturnType<typeof detectLang> = null;
    for (const ask of [...new Set([asks[asks.length - 1]!, asks.join('\n')])]) {
      // the knowledge base is in Hebrew: a question in another language is searched in its Hebrew translation
      lang = detectLang(ask);
      question = lang && lang !== 'he' ? (await translateText(llm, ask, lang, 'he', fetchImpl, glossary))?.text ?? ask : ask;
      a = await mgr.kb.answer(question, settings, 'staff', 'staff').catch(() => null);
      if (a) break;
    }
    if (!a) return reply.code(404).send({ error: 'no_answer' });
    const hits = [{ title: a.title, heading: a.heading, snippet: a.passage ?? a.text }, ...(a.others ?? []).slice(0, 2).map((h) => ({ title: h.title, heading: h.heading, snippet: h.snippet }))];
    const draft = await suggestReply(llm, question, recent, hits, fetchImpl);
    if (!draft) return reply.code(404).send({ error: 'no_answer' });
    return { draft, source: { title: a.title, url: a.url }, ...(lang && lang !== 'he' ? { lang } : {}) };
  });

  app.post('/conversations/:id/summary', { preHandler: any, config: limit }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    if (!llm.url) return reply.code(503).send({ error: 'assist_unavailable' });
    const recent = await lines(conv.id, 40);
    if (recent.length < 2) return reply.code(409).send({ error: 'too_short' });
    const s = await summarize(llm, recent, fetchImpl);
    if (!s) return reply.code(502).send({ error: 'summary_failed' });
    return { summary: s };
  });
}
