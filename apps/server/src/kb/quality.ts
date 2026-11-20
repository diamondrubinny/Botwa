import type { Db } from '../db.js';

/**
 * Data quality of the knowledge base: duplicates and mistakes, each with what to do. "fix" issues are corrected safely and
 * reversibly by fixQuality (a duplicate is switched off, never deleted; it can be switched on again from the sources list);
 * "review" issues need a person (two answers to the same question that differ, a source in error, damaged text).
 *
 * Checks:
 *  - same_content: identical text under several sources (an upload and an import of the same law, the same page twice): one stays
 *  - contained:    a source whose passages (90% or more, at least 3) all appear in a larger one: it adds nothing
 *  - empty:        switched on and "ready" but without any passage: it can never answer
 *  - repeated_variants: a question's other wordings repeat themselves or the title: cleaned
 *  - stuck:        waiting to be read for over a day: sent again
 *  - same_question: two questions with the same wording and different answers (review: which one is right?)
 *  - short_answer: an answer of a few characters, or the question repeated as its answer (review)
 *  - broken:       a source in error (review: the reason is shown)
 *  - garbled:      text with many unreadable characters, usually a scanned or damaged file (review)
 */
export type IssueKind = 'same_content' | 'contained' | 'empty' | 'repeated_variants' | 'stuck' | 'same_question' | 'short_answer' | 'broken' | 'garbled';
export interface QualityItem { id: string; title: string; kind: string; origin: string | null; url: string | null }
export interface QualityIssue { kind: IssueKind; action: 'fix' | 'review'; keep?: QualityItem; items: QualityItem[]; detail?: string }

const ITEM = `json_build_object('id', s.id, 'title', s.title, 'kind', s.kind, 'origin', s.origin, 'url', s.url)`;
/** A question's wording compared without punctuation, spaces or letter case. */
const NORM = (col: string) => `regexp_replace(lower(${col}), '[[:punct:][:space:]״׳?!.,:;"''()-]+', '', 'g')`;

export async function kbQuality(db: Db): Promise<{ issues: QualityIssue[]; checked: number }> {
  const issues: QualityIssue[] = [];
  const checked = (await db.query(`SELECT count(*)::int AS n FROM kb_sources WHERE enabled`)).rows[0].n as number;

  // identical text: the fingerprint of all of a source's passages (works for questions, texts, files, pages and imports alike).
  // The one kept: an import (kept up to date by its source), then the most used, then the oldest.
  const same = (await db.query(
    `WITH d AS (SELECT s.id, md5(string_agg(c.body, E'\\n' ORDER BY c.ord)) AS h FROM kb_sources s JOIN kb_chunks c ON c.source_id = s.id WHERE s.enabled GROUP BY s.id)
     SELECT json_agg(${ITEM} ORDER BY (s.origin IS NULL), s.uses DESC, s.created_at) AS items FROM d JOIN kb_sources s ON s.id = d.id GROUP BY d.h HAVING count(*) > 1 LIMIT 200`)).rows;
  const inSame = new Set<string>();
  for (const g of same) {
    const [keep, ...rest] = g.items as QualityItem[];
    issues.push({ kind: 'same_content', action: 'fix', keep, items: rest });
    for (const i of g.items as QualityItem[]) inSame.add(i.id);
  }

  // contained: nearly every passage of a source appears, word for word, in one other (larger) source
  const contained = (await db.query(
    `WITH c AS (SELECT c.source_id, md5(c.body) AS h FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id WHERE s.enabled AND length(c.body) >= 40),
          tot AS (SELECT source_id, count(*) AS n FROM c GROUP BY source_id),
          pair AS (SELECT a.source_id AS small, b.source_id AS big, count(DISTINCT a.h) AS shared FROM c a JOIN c b ON a.h = b.h AND a.source_id <> b.source_id GROUP BY a.source_id, b.source_id)
     SELECT ${ITEM.replace(/s\./g, 'sa.')} AS item, ${ITEM.replace(/s\./g, 'sb.')} AS keep, p.shared::int AS shared, ta.n::int AS total
       FROM pair p JOIN tot ta ON ta.source_id = p.small JOIN tot tb ON tb.source_id = p.big
       JOIN kb_sources sa ON sa.id = p.small JOIN kb_sources sb ON sb.id = p.big
      WHERE ta.n >= 3 AND p.shared >= 0.9 * ta.n AND (tb.n > ta.n OR (tb.n = ta.n AND sb.created_at < sa.created_at)) AND sa.parent_id IS DISTINCT FROM sb.id
      ORDER BY ta.n DESC LIMIT 200`)).rows;
  const seen = new Set<string>();
  for (const r of contained) {
    const item = r.item as QualityItem;
    if (inSame.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    issues.push({ kind: 'contained', action: 'fix', keep: r.keep, items: [item], detail: `${r.shared} מתוך ${r.total} קטעים מופיעים גם ב"${(r.keep as QualityItem).title}"` });
  }

  const one = async (kind: IssueKind, action: 'fix' | 'review', sql: string, detail?: (r: Record<string, unknown>) => string) => {
    for (const r of (await db.query(sql)).rows) issues.push({ kind, action, items: [r.item as QualityItem], ...(detail ? { detail: detail(r) } : {}) });
  };
  await one('empty', 'fix', `SELECT ${ITEM} AS item FROM kb_sources s WHERE s.enabled AND s.status = 'ready' AND s.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.source_id = s.id) AND s.kind <> 'link' LIMIT 200`);
  await one('repeated_variants', 'fix', `SELECT ${ITEM} AS item FROM kb_sources s WHERE s.kind = 'faq' AND cardinality(s.variants) > 0
      AND (SELECT count(DISTINCT ${NORM('v')}) FROM unnest(s.variants) v) < cardinality(s.variants)
       OR (s.kind = 'faq' AND EXISTS (SELECT 1 FROM unnest(s.variants) v WHERE ${NORM('v')} = ${NORM('s.title')})) LIMIT 200`);
  await one('stuck', 'fix', `SELECT ${ITEM} AS item FROM kb_sources s WHERE s.enabled AND s.status = 'pending' AND s.updated_at < now() - interval '1 day' LIMIT 200`);
  for (const g of (await db.query(
    `SELECT json_agg(${ITEM} ORDER BY s.created_at) AS items FROM kb_sources s WHERE s.enabled AND s.kind = 'faq'
      GROUP BY ${NORM('s.title')} HAVING count(DISTINCT ${NORM("coalesce(s.body, '')")}) > 1 LIMIT 100`)).rows) {
    issues.push({ kind: 'same_question', action: 'review', items: g.items as QualityItem[] });
  }
  await one('short_answer', 'review', `SELECT ${ITEM} AS item FROM kb_sources s WHERE s.enabled AND s.kind = 'faq'
      AND (length(trim(coalesce(s.body, ''))) < 15 OR ${NORM("coalesce(s.body, '')")} = ${NORM('s.title')}) LIMIT 200`);
  await one('broken', 'review', `SELECT ${ITEM} AS item, s.error FROM kb_sources s WHERE s.enabled AND s.status = 'error' LIMIT 200`, (r) => String(r.error ?? ''));
  await one('garbled', 'review', `SELECT ${ITEM} AS item, x.bad::int AS bad, x.len::int AS len FROM kb_sources s
      JOIN (SELECT source_id, sum(length(body) - length(replace(body, chr(65533), ''))) AS bad, sum(length(body)) AS len FROM kb_chunks GROUP BY source_id) x ON x.source_id = s.id
     WHERE s.enabled AND x.bad >= 20 AND x.bad * 50 >= x.len LIMIT 100`, (r) => `${r.bad} תווים לא קריאים`);
  return { issues, checked };
}

/**
 * Correct the "fix" issues: duplicates are switched off (with a note saying which source stays), empty sources are switched off,
 * repeated wordings are removed, stuck sources are sent to be read again. Returns what was done and the ids to read again.
 */
export async function fixQuality(db: Db): Promise<{ disabled: number; cleaned: string[]; requeued: string[] }> {
  const { issues } = await kbQuality(db);
  let disabled = 0;
  const cleaned: string[] = [];
  const requeued: string[] = [];
  for (const i of issues) {
    if (i.action !== 'fix') continue;
    if (i.kind === 'same_content' || i.kind === 'contained') {
      for (const it of i.items) {
        const r = await db.query(`UPDATE kb_sources SET enabled = false, meta = meta || jsonb_build_object('duplicateOf', $2::text, 'duplicateKind', $3::text), updated_at = now() WHERE id = $1 AND enabled RETURNING id`, [it.id, i.keep?.id ?? null, i.kind]);
        disabled += r.rowCount ?? 0;
      }
    } else if (i.kind === 'empty') {
      disabled += (await db.query(`UPDATE kb_sources SET enabled = false, updated_at = now() WHERE id = $1 AND enabled`, [i.items[0]!.id])).rowCount ?? 0;
    } else if (i.kind === 'repeated_variants') {
      const r = await db.query(
        `UPDATE kb_sources s SET variants = COALESCE((SELECT array_agg(v ORDER BY o) FROM (SELECT DISTINCT ON (${NORM('v')}) v, o FROM unnest(s.variants) WITH ORDINALITY AS u(v, o)
             WHERE ${NORM('v')} <> ${NORM('s.title')} ORDER BY ${NORM('v')}, o) x), '{}'), updated_at = now() WHERE s.id = $1 RETURNING id`, [i.items[0]!.id]);
      if (r.rowCount) cleaned.push(i.items[0]!.id);
    } else if (i.kind === 'stuck') {
      requeued.push(i.items[0]!.id);
    }
  }
  return { disabled, cleaned, requeued };
}
