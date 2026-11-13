import { z } from 'zod';
import { normalize } from './bot.js';
import type { Db } from './db.js';
import { flowSchema, validateFlow } from './flow/schema.js';
import type { KnowledgeBase } from './kb/service.js';

/** What the bot may learn, and whether repeated did-you-mean picks are approved without a person (off by default). */
export const learningSchema = z.object({
  enabled: z.boolean().default(true),
  autoVariants: z.boolean().default(false),
  /** different customers needed before an automatic approval */
  autoAfter: z.number().int().min(2).max(20).default(3),
});
export type LearningSettings = z.infer<typeof learningSchema>;
export const DEFAULT_LEARNING: LearningSettings = { enabled: true, autoVariants: false, autoAfter: 3 };

export async function loadLearning(db: Db): Promise<LearningSettings> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'learning'`);
  const p = learningSchema.safeParse(rows[0]?.value ?? {});
  return p.success ? p.data : DEFAULT_LEARNING;
}

export const learnNorm = (t: string) => normalize(t).replace(/[?!.,;:"'׳״()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * Personal details out of a staff answer before anyone sees it as a draft: phone numbers, e-mails, 9-digit ID numbers,
 * and the customer's own names. Not perfect, so a draft is always reviewed by a person.
 */
export function scrubPII(text: string, names: (string | null | undefined)[] = []): string {
  let s = text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[אימייל]')
    .replace(/(?<!\d)\d{9}(?!\d)/g, '[מספר מזהה]')
    .replace(/(?<![\w/])(\+?\d[\d\s-]{7,}\d)(?![\w/])/g, (m) => (m.replace(/\D/g, '').length >= 9 ? '[טלפון/מספר]' : m));
  for (const n of names) {
    for (const part of (n ?? '').split(/\s+/).filter((p) => p.length >= 2)) {
      s = s.replace(new RegExp(`(^|[\\s,.:;!?()"'\\-])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s,.:;!?()"'\\-])`, 'g'), '$1[שם]');
    }
  }
  return s.trim();
}

export interface LearnInput { kind: 'variant' | 'faq_draft' | 'option_example'; target: string; sourceId?: string | null; text: string; answer?: string | null; conversationId: string }

/** Record (or count again) a learning suggestion. Rejected ones stay rejected; approved ones are not re-opened. Returns the row. */
export async function recordLearn(db: Db, kb: KnowledgeBase | undefined, l: LearnInput): Promise<{ id: string; hits: number; status: string } | null> {
  const settings = await loadLearning(db);
  if (!settings.enabled) return null;
  const text = l.text.replace(/\s+/g, ' ').trim().slice(0, 500);
  const norm = learnNorm(text);
  if (norm.length < 3) return null;
  if (l.kind === 'variant' && l.sourceId) {
    // already known wording of this entry: nothing to learn
    const src = (await db.query('SELECT title, variants FROM kb_sources WHERE id = $1', [l.sourceId])).rows[0];
    if (!src) return null;
    if ([src.title as string, ...((src.variants as string[]) ?? [])].some((v) => learnNorm(v) === norm)) return null;
  }
  const r = (await db.query(
    `INSERT INTO kb_learn (kind, target, source_id, text, answer, norm, conversations) VALUES ($1,$2,$3,$4,$5,$6,ARRAY[$7::uuid])
     ON CONFLICT (kind, target, norm) DO UPDATE SET
       hits = kb_learn.hits + CASE WHEN $7::uuid = ANY(kb_learn.conversations) THEN 0 ELSE 1 END,
       conversations = CASE WHEN $7::uuid = ANY(kb_learn.conversations) THEN kb_learn.conversations ELSE (kb_learn.conversations || $7::uuid)[greatest(1, cardinality(kb_learn.conversations) - 18):] END,
       answer = COALESCE(EXCLUDED.answer, kb_learn.answer), updated_at = now()
     WHERE kb_learn.status = 'pending'
     RETURNING id, hits, status`,
    [l.kind, l.target, l.sourceId ?? null, text, l.answer ?? null, norm, l.conversationId])).rows[0] as { id: string; hits: number; status: string } | undefined;
  if (!r) return null;
  if (l.kind === 'variant' && settings.autoVariants && r.hits >= settings.autoAfter && kb) {
    await approveLearn(db, kb, r.id, null).catch(() => undefined);
    return { ...r, status: 'approved' };
  }
  return r;
}

export class LearnError extends Error { constructor(public code: string) { super(code); } }

/** Apply an approved suggestion: a new wording for an entry, a new FAQ entry, or a new example for a menu option. */
export async function approveLearn(db: Db, kb: KnowledgeBase, id: string, userId: string | null, edit: { text?: string; answer?: string } = {}): Promise<{ sourceId?: string }> {
  const l = (await db.query(`SELECT * FROM kb_learn WHERE id = $1`, [id])).rows[0];
  if (!l) throw new LearnError('not_found');
  if (l.status !== 'pending') throw new LearnError('not_pending');
  const text = (edit.text ?? l.text as string).replace(/\s+/g, ' ').trim();
  if (text.length < 2) throw new LearnError('bad_request');
  let sourceId: string | undefined;
  if (l.kind === 'variant') {
    const src = (await db.query('SELECT id, variants FROM kb_sources WHERE id = $1', [l.source_id])).rows[0];
    if (!src) throw new LearnError('not_found');
    const variants = (src.variants as string[]) ?? [];
    if (variants.length >= 20) throw new LearnError('variants_full');
    if (!variants.some((v) => learnNorm(v) === learnNorm(text))) await db.query('UPDATE kb_sources SET variants = array_append(variants, $2), updated_at = now() WHERE id = $1', [src.id, text.slice(0, 300)]);
    await kb.indexWritten(src.id).catch(() => undefined);
    sourceId = src.id;
  } else if (l.kind === 'faq_draft') {
    const answer = (edit.answer ?? l.answer ?? '').trim();
    if (answer.length < 2) throw new LearnError('bad_request');
    sourceId = (await db.query(
      `INSERT INTO kb_sources (kind, title, variants, body, audience, created_by) VALUES ('faq', $1, '{}', $2, 'both', $3) RETURNING id`,
      [text.slice(0, 300), answer.slice(0, 6000), userId])).rows[0].id as string;
    await kb.indexWritten(sourceId).catch(() => undefined);
  } else {
    const [node, label] = (l.target as string).split('\n');
    const row = (await db.query(`SELECT value FROM settings WHERE key = 'flow'`)).rows[0];
    const flow = flowSchema.safeParse(row?.value);
    if (!flow.success) throw new LearnError('no_flow');
    const n = flow.data.nodes.find((x) => x.id === node);
    const opt = n && n.type === 'menu' ? n.options.find((o) => o.label === label) : undefined;
    if (!opt) throw new LearnError('option_gone');
    if (opt.examples.length >= 8) throw new LearnError('examples_full');
    if (!opt.examples.some((e) => learnNorm(e) === learnNorm(text))) opt.examples.push(text.slice(0, 80));
    if (validateFlow(flow.data).length) throw new LearnError('invalid_flow');
    await db.query(`UPDATE settings SET value = $1, updated_at = now() WHERE key = 'flow'`, [JSON.stringify(flow.data)]);
  }
  await db.query(`UPDATE kb_learn SET status = 'approved', text = $2, answer = COALESCE($3, answer), decided_by = $4, decided_at = now(), updated_at = now() WHERE id = $1`, [id, text.slice(0, 500), edit.answer ?? null, userId]);
  return { sourceId };
}

const POSITIVE = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', '❤️', '🙏', '🙏🏻', '🙏🏼', '🙏🏽', '😊', '🙂', '👌', '💯', '😍', '🥰', '✅', '👏', '🤩', '💪']);
const NEGATIVE = new Set(['👎', '👎🏻', '👎🏼', '👎🏽', '👎🏾', '👎🏿', '😡', '😠', '😞', '😕', '🤨', '❌', '😤', '🙁', '☹️', '😒', '🤦', '🤦‍♂️', '🤦‍♀️']);
/** true = helpful, false = not helpful, null = a reaction that says nothing about the answer (or a removed reaction) */
export function reactionMeaning(emoji: string): boolean | null {
  const e = emoji.trim();
  if (POSITIVE.has(e)) return true;
  if (NEGATIVE.has(e)) return false;
  return null;
}

/** Customers' reactions on bot answers since the entry was last reviewed. */
export async function feedbackFor(db: Db, sourceId: string): Promise<{ up: number; down: number }> {
  const r = (await db.query(
    `SELECT count(*) FILTER (WHERE a.positive)::int AS up, count(*) FILTER (WHERE NOT a.positive)::int AS down
       FROM kb_answer_reactions a JOIN kb_sources s ON s.id = a.source_id
      WHERE a.source_id = $1 AND (s.feedback_reviewed_at IS NULL OR a.created_at > s.feedback_reviewed_at)`, [sourceId])).rows[0];
  return { up: r?.up ?? 0, down: r?.down ?? 0 };
}
/** Answers customers keep marking as unhelpful are not given directly any more (still offered as "did you mean") until reviewed. */
export const isFlagged = (f: { up: number; down: number }) => f.down >= 3 && f.down > f.up * 2;
export const isLiked = (f: { up: number; down: number }) => f.up - f.down >= 3;

/**
 * A person answered a question the bot could not: the pair becomes a draft FAQ entry (personal details removed),
 * used by the bot only after someone approves it.
 */
export async function learnFromStaff(db: Db, kb: KnowledgeBase | undefined, conversationId: string, staffText: string): Promise<boolean> {
  if (staffText.trim().length < 15) return false;
  const asked = (await db.query(
    `SELECT m.body, m.created_at FROM messages m
      WHERE m.conversation_id = $1 AND m.direction = 'in' AND m.body <> '' AND m.created_at > now() - interval '24 hours'
        AND EXISTS (SELECT 1 FROM kb_queries q WHERE q.via = 'bot' AND NOT q.answered AND q.created_at >= m.created_at - interval '1 minute'
                     AND q.created_at <= m.created_at + interval '10 minutes' AND lower(q.text) = lower(left(regexp_replace(trim(m.body), '\\s+', ' ', 'g'), 200)))
      ORDER BY m.created_at DESC LIMIT 1`, [conversationId])).rows[0];
  if (!asked) return false;
  // only the first staff answer after that question
  const staffAfter = (await db.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'out' AND NOT auto AND created_at > $2`, [conversationId, asked.created_at])).rows[0].n;
  if (staffAfter > 1) return false;
  const who = (await db.query(`SELECT ct.display_name, ct.profile->>'fullName' AS full FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`, [conversationId])).rows[0];
  const names = [who?.display_name, who?.full];
  const r = await recordLearn(db, kb, { kind: 'faq_draft', target: '', text: scrubPII(asked.body as string, names), answer: scrubPII(staffText, names), conversationId });
  return !!r;
}
