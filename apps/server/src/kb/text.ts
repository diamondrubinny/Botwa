/**
 * Text tools for the knowledge base: normalisation for Hebrew/English matching, chunking and snippet selection.
 * No stemmer exists for Hebrew in PostgreSQL, so words are indexed together with their prefix-stripped forms
 * (ה/ו/ב/כ/ל/מ/ש + combinations) and queries are expanded the same way.
 */
const NIQQUD = /[֑-ׇ]/g;
const FINAL: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
const PREFIX = new Set([...'והבכלמש']);

const STOP = new Set(`איזה באיזה איזו באיזו מהי מהו מהם מהן כיצד היכן את של על עם אל או גם כי אם לא כן יש אין היא הוא הם הן אני אתה את אנחנו מה איך מתי איפה למה מי כמה האם זה זאת אלה אלו לי לך לו לה לנו שלי שלך רוצה רוצים צריך צריכה יכול יכולה אפשר בבקשה תודה שלום היי הי ערב טוב בוקר
a an the of to in on at is are was were be been do does did i you we they it my your our can could would should please hello hi thanks thank what how when where why who which and or but for with about`.split(/\s+/));

export function normalizeWord(w: string): string {
  return w.normalize('NFKC').replace(NIQQUD, '').toLowerCase().replace(/[ךםןףץ]/g, (c) => FINAL[c]!);
}

/** Words of a text: letters/digits only, normalised, length >= 2. */
export function words(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).map(normalizeWord).filter((w) => w.length >= 2 && w.length <= 40);
}

/** The word plus its forms with one or two Hebrew prefix letters removed (kept only if >= 3 letters remain). */
export function variants(w: string): string[] {
  const out = [w];
  if (/^[א-ת]/.test(w) && w.length >= (w[0] === 'ש' ? 5 : 4) && PREFIX.has(w[0]!)) {
    const first = w[0]!;
    let cur = w.slice(1);
    out.push(cur);
    // "ו"/"ש" can be followed by another prefix letter (והשעות, שבשעות)
    if ((first === 'ו' || first === 'ש') && cur.length >= 4 && 'הבכלמ'.includes(cur[0]!)) out.push(cur.slice(1));
  }
  return out;
}

/** Meaningful tokens of a question (stop words removed). */
export function queryTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const w of words(text)) if (!STOP.has(w) && !/^\d$/.test(w)) seen.add(w);
  return [...seen];
}

/** Space-joined searchable terms of a chunk: every word and its prefix-stripped variants. */
export function indexTerms(text: string): string {
  const set = new Set<string>();
  for (const w of words(text)) for (const v of variants(w)) set.add(v);
  return [...set].join(' ');
}

export interface Chunk { heading: string | null; body: string }

/** Split extracted text into chunks of about 700-1200 characters, keeping the nearest heading ("# title" lines). */
export function chunkText(text: string, target = 800, max = 1200): Chunk[] {
  const chunks: Chunk[] = [];
  let heading: string | null = null;
  const stack: string[] = [];   // headings by level: "H1 › H2" is kept as the context of each chunk
  let buf = '';
  const flush = () => { const b = buf.trim(); if (b.length >= 15) chunks.push({ heading, body: b }); buf = ''; };
  const paras = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const raw of paras) {
    const p = raw.trim();
    if (!p) continue;
    const h = /^(#{1,4})\s+(.+)$/.exec(p.split('\n')[0]!);
    if (h) { flush(); const lvl = h[1]!.length; stack.length = Math.min(stack.length, lvl - 1); while (stack.length < lvl - 1) stack.push(''); stack[lvl - 1] = h[2]!.trim(); heading = stack.filter(Boolean).join(' › ').slice(0, 200); const rest = p.split('\n').slice(1).join('\n').trim(); if (rest) buf = rest; continue; }
    if (p.length > max) {
      flush();
      for (const piece of splitLong(p, target)) { buf = piece; flush(); }
      continue;
    }
    if (buf && buf.length + p.length > target) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks.slice(0, 400);
}

function splitLong(p: string, target: number): string[] {
  const sentences = p.split(/(?<=[.!?։׃])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > target) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${s}` : s;
    while (cur.length > target * 1.6) { out.push(cur.slice(0, target)); cur = cur.slice(target); }
  }
  if (cur) out.push(cur);
  return out;
}

/** The best window (about `max` characters) of a chunk for the question: the sentence with most matches plus what follows. */
export function bestSnippet(body: string, tokens: string[], max: number): string {
  const text = body.trim();
  if (text.length <= max) return text;
  const sentences = text.split(/(?<=[.!?։׃\n])\s+/).filter(Boolean);
  const want = new Set(tokens.flatMap((t) => variants(t)));
  let bestI = 0, bestScore = -1;
  sentences.forEach((s, i) => {
    const sc = words(s).reduce((n, w) => n + (variants(w).some((v) => want.has(v)) ? 1 : 0), 0);
    if (sc > bestScore) { bestScore = sc; bestI = i; }
  });
  let out = '';
  for (let i = bestI; i < sentences.length && (out + sentences[i]).length <= max; i++) out += (out ? ' ' : '') + sentences[i];
  if (!out) out = sentences[bestI]!.slice(0, max);
  return out.length < text.length ? out.trim() : out;
}
