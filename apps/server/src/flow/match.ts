import { queryTokens, variants } from '../kb/text.js';

/**
 * Which menu option did free text mean, by words: every meaningful word of an option's label (or one of its example phrases)
 * appears in the text, and exactly one option qualifies. Prefix/plural-light matching comes from kb/text variants.
 */
export function matchOptionLexical(text: string, options: { label: string; examples: string[] }[]): number | null {
  const have = new Set(queryTokens(text).flatMap((w) => variants(w)));
  if (have.size === 0) return null;
  const hits: number[] = [];
  options.forEach((o, i) => {
    const ok = [o.label, ...o.examples].some((phrase) => {
      const toks = queryTokens(phrase);
      return toks.length > 0 && toks.every((t) => variants(t).some((v) => have.has(v)));
    });
    if (ok) hits.push(i);
  });
  return hits.length === 1 ? hits[0]! : null;
}
