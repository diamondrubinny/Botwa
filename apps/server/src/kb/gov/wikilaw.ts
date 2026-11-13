/**
 * Converts a law or regulation page of the Open Law Book project ("ספר החוקים הפתוח", on Hebrew Wikisource) from its wikitext into
 * plain text with markdown-style headings, so the knowledge base splits it by chapter and section:
 *
 *   # פרק ג׳: עבודה בגובה          (ח:קטע2)
 *   ## סימן א׳ – ...                (ח:קטע3)
 *   ### תקנה 17 – עבודה בגובה ...   (ח:סעיף)
 *
 * The Open Law Book marks structure with "ח:" templates (ח:סעיף, ח:תת, ח:פנימי ...). Anything unknown is reduced to its text, and
 * every HTML tag is removed: the result is plain text and is never rendered as HTML.
 */

export interface Publication { citation: string; label: string; url: string | null }
export interface ParsedLaw {
  title: string;
  /** "תקנה" for regulations and rules, "סעיף" for laws and ordinances */
  unit: 'תקנה' | 'סעיף';
  text: string;
  sections: number;
  publications: Publication[];
  /** Knesset law id when the page states it (ח:מאגר) */
  knessetId: string | null;
  signed: string | null;
}

/** Split template arguments on top-level pipes (nested {{...}} and [[...]] keep theirs). */
export function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (let i = 0; i < inner.length; i++) {
    const two = inner.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
    if ((two === '}}' || two === ']]') && depth > 0) { depth--; cur += two; i++; continue; }
    if (inner[i] === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += inner[i];
  }
  out.push(cur);
  return out;
}

const positional = (args: string[]): string[] => args.filter((a) => !/^\s*[\p{L}_ ]+\s*=/u.test(a));

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", shy: '', lrm: '', rlm: '', ndash: '–', mdash: '—' };
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d{1,6});/g, (_, n) => { const c = Number(n); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => { const c = parseInt(h, 16); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

/** Inline markup to text: links, bold/italic quotes, tags, entities. Templates must already be resolved. */
function inline(s: string): string {
  return decodeEntities(s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>\s*(?=<t[dh])/gi, ' | ')      // table cells stay apart
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]{0,500}>/g, '')
    .replace(/\[\[(?:קטגוריה|Category|קובץ|File|תמונה|Image):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/[^\s\]]+\]/g, '')
    .replace(/'''''|'''|''/g, ''))
    .replace(/[ \t ]+/g, ' ');
}

/**
 * Resolve the templates of one line (or block), innermost first. Structural templates (sections, headings) are turned into markers
 * the line handler understands; the rest become their text.
 */
function resolveTemplates(s: string, ctx: { pubs: Publication[]; knessetId: string | null }): string {
  let guard = 0;
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\{\{([^{}]*)\}\}/g, (_m, inner: string) => {
      const args = splitArgs(inner);
      const name = args[0]!.trim();
      const pos = positional(args.slice(1)).map((a) => a.trim());
      switch (name) {
        case 'ח:פנימי': case 'ח:חיצוני': return pos[1] ?? pos[0] ?? '';
        case 'ח:הערה': return pos[0] ?? '';
        case 'ח:תיבה': {
          // a publication in Reshumot: citation | what was published | link
          ctx.pubs.push({ citation: inline(pos[0] ?? '').trim(), label: inline(pos[1] ?? '').trim(), url: /^https:\/\/[^\s"<>]+$/.test(pos[2] ?? '') ? pos[2]! : null });
          return `${pos[1] ?? ''} (${pos[0] ?? ''})`;
        }
        case 'ח:מאגר': ctx.knessetId = /^\d{4,9}$/.test(pos[0] ?? '') ? pos[0]! : null; return '';
        case 'ח:כותרת': return `\u0001T${pos[0] ?? ''}\u0002`;
        case 'ח:קטע1': case 'ח:קטע2': return `\u0001H1${pos[1] ?? pos[0] ?? ''}\u0002`;
        case 'ח:קטע3': return `\u0001H2${pos[1] ?? pos[0] ?? ''}\u0002`;
        case 'ח:קטע4': case 'ח:קטע5': return `\u0001P${pos[1] ?? pos[0] ?? ''}\u0002`;
        case 'ח:סעיף': return `\u0001S${pos[0] ?? ''}\u0003${pos[1] ?? ''}\u0002`;
        case 'ח:סעיף*': {
          // a schedule item: numbered "(א)", or only an anchor such as "תוספת חלק א"
          const anchor = args.slice(1).map((a) => /^\s*עוגן\s*=(.*)$/.exec(a)?.[1]?.trim()).find(Boolean) ?? '';
          return `\u0001X${pos[0] || anchor}\u0003${pos[1] ?? ''}\u0002`;
        }
        case 'ח:חתימות': return `\u0001D${pos[0] ?? ''}\u0002`;
        case 'ח:ת': return '';
        case 'ח:תת': case 'ח:תתת': case 'ח:תתתת': case 'ח:תתתתת': case 'ח:תתתתתת': return pos[0] ? `${pos[0]} ` : '';
        case 'ח:פתיח-התחלה': return '\u0001O\u0002';   // the list of publications: kept as data, not as text
        case 'ח:סוגר': return '\u0001C\u0002';
        case 'ח:התחלה': case 'ח:סוף': case 'ח:מפריד': case 'ח:מבוא': return '';
        case 'ש': return '\n';
        default: return pos.join(' ');   // מוקטן, ממורכז, דוכיווני, שמאל ...: their text
      }
    });
  } while (s !== prev && ++guard < 12);
  return s.replace(/\{\{|\}\}/g, '');
}

export function parseLawWikitext(wikitext: string, pageTitle: string): ParsedLaw {
  const ctx = { pubs: [] as Publication[], knessetId: null as string | null };
  let src = wikitext.replace(/\r/g, '');
  // the table of contents repeats every heading: drop it (its lines are marked with law-toc)
  src = src.split('\n').filter((l) => !/class="law-toc/.test(l) && !/^<\/div>\s*$/.test(l.trim())).join('\n');
  const resolved = resolveTemplates(src, ctx);

  const shortTitle = pageTitle.trim();
  const unit: ParsedLaw['unit'] = /^(תקנות|כללי|צו)(?=\s|$)/.test(shortTitle) ? 'תקנה' : 'סעיף';
  let title = shortTitle;
  let signed: string | null = null;
  let sections = 0;
  const out: string[] = [];
  let skipToc = false;
  let afterSigned = false;
  let preamble = false;

  for (const rawLine of resolved.split('\n')) {
    let line = rawLine;
    // structural markers may sit at the start of a line followed by text
    const parts: string[] = [];
    line = line.replace(/\u0001(H1|H2|[TPSXDOC])([^\u0002]*)\u0002/g, (_m, kind: string, body: string) => {
      const text = (s: string) => inline(s).replace(/\s+/g, ' ').trim();
      if (kind === 'T') { title = text(body) || title; return ''; }
      if (kind === 'H1' || kind === 'H2') {
        const h = text(body);
        skipToc = h === 'תוכן עניינים';
        if (h && !skipToc) parts.push(`\n${kind === 'H1' ? '#' : '##'} ${h}\n`);
        return '';
      }
      if (kind === 'P') { const h = text(body); if (h) parts.push(`\n${h}\n`); return ''; }
      if (kind === 'S' || kind === 'X') {
        const [num, head] = body.split('\u0003').map(text) as [string, string];
        skipToc = false;
        if (kind === 'S') sections++;
        const label = kind === 'S' ? `${unit} ${num}` : /^\(/.test(num) ? `פרט ${num}` : num || 'פרט';
        parts.push(`\n### ${label}${head ? ` – ${head}` : ''}\n`);
        return '';
      }
      if (kind === 'O') { preamble = true; return ''; }
      if (kind === 'C') { preamble = false; return ''; }
      if (kind === 'D') { signed = text(body) || null; afterSigned = true; return ''; }
      return '';
    });
    if (afterSigned) { if (parts.length) out.push(...parts); continue; }   // names and titles of the signing ministers are not content
    if (skipToc || preamble) continue;
    if (/^\s*(\{\||\|\}|\|-)/.test(line)) continue;                      // wiki table frame
    const text = inline(line.replace(/^\s*[*#:;]+\s*/, '').replace(/^\s*[|!]\s*/, '')).trim();
    out.push(...parts);
    if (text) out.push(text);
  }

  const body = out.join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    // a heading line must be its own paragraph for the chunker
    .map((l) => (/^#{1,3} /.test(l) ? `\n${l}\n` : l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title: inline(title).trim() || shortTitle, unit, text: body, sections, publications: ctx.pubs.slice(0, 200), knessetId: ctx.knessetId, signed };
}
