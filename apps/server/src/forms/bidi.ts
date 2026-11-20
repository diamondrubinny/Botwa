/**
 * Visual order for drawing a line in a PDF, which lays glyphs left to right: Hebrew (right-to-left) runs are reversed and
 * placed from the right; Latin words and numbers keep their own order. Enough for form values (names, dates, IDs, addresses);
 * Hebrew needs no glyph shaping.
 */
const RTL = /[֐-׿יִ-ﭏ]/;
const LTR = /[A-Za-z0-9À-ɏ]/;
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

export function hasRtl(s: string): boolean { return RTL.test(s); }

export function visualOrder(s: string): string {
  if (!RTL.test(s)) return s;
  const tokens = s.match(/[֐-׿יִ-ﭏ]+|[A-Za-z0-9À-ɏ]+(?:[.,:/@_+%-][A-Za-z0-9À-ɏ]+)*|\s+|./gu) ?? [];
  const kind = tokens.map((t) => (RTL.test(t) ? 'r' : LTR.test(t) ? 'l' : 'n'));
  // a neutral between two left-to-right tokens joins them ("Tel Aviv 6"); otherwise it follows the right-to-left base
  const res = kind.map((k, i) => {
    if (k !== 'n') return k;
    let a = i - 1; while (a >= 0 && kind[a] === 'n') a--;
    let b = i + 1; while (b < kind.length && kind[b] === 'n') b++;
    return a >= 0 && b < kind.length && kind[a] === 'l' && kind[b] === 'l' ? 'l' : 'r';
  });
  // group left-to-right runs, then reverse the order of the groups; right-to-left text is reversed character by character
  const groups: { dir: string; text: string }[] = [];
  tokens.forEach((t, i) => {
    const last = groups[groups.length - 1];
    if (last && last.dir === 'l' && res[i] === 'l') last.text += t; else groups.push({ dir: res[i]!, text: t });
  });
  return groups.reverse().map((g) => (g.dir === 'l' ? g.text : [...g.text].reverse().map((c) => MIRROR[c] ?? c).join(''))).join('');
}

/**
 * The string to hand to pdf-lib: its font layout (fontkit) lays out a run containing Hebrew right to left by itself, reversing the
 * glyphs, so it gets the reverse of the visual order and the two cancel out; Latin words and numbers inside stay readable.
 */
export function forPdf(s: string): string {
  return RTL.test(s) ? [...visualOrder(s)].reverse().join('') : s;
}
