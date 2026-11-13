import { parentPort, workerData } from 'node:worker_threads';

/**
 * Reads an untrusted PDF in an isolated worker: page sizes, and suggested fields next to the labels a printed form uses
 * ("שם:", "ת.ז.", "תאריך", "חתימה", "טלפון", a run of underscores). The suggestions are a starting point the editor corrects.
 */
type Item = { s: string; x: number; y: number; w: number; h: number };
type Suggest = { type: string; label: string; page: number; x: number; y: number; w: number; h: number; required: boolean };

const KINDS: [RegExp, string, string][] = [
  [/חתימ|signature/i, 'signature', 'חתימה'],
  [/^ראשי תיבות|initials/i, 'initials', 'ראשי תיבות'],
  [/^תאריך|date/i, 'date', 'תאריך'],
  [/ת\.?\s?ז\.?|תעודת זהות|מס['׳]?\s*זהות|\bID\b/i, 'id_number', 'תעודת זהות'],
  [/טלפון|נייד|^טל['׳.]|phone|tel\b/i, 'phone', 'טלפון'],
  [/דוא["״]?ל|אימייל|מייל|e-?mail/i, 'email', 'אימייל'],
];

async function run(buf: Uint8Array) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(buf);
  if (pdf.numPages > 60) throw new Error('too_many_pages');
  const pages: { w: number; h: number }[] = [];
  const out: Suggest[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    pages.push({ w: vp.width, h: vp.height });
    const tc = await page.getTextContent();
    const items: Item[] = (tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[])
      .filter((i) => i.str && i.str.trim() && i.transform)
      .map((i) => ({ s: i.str!.trim(), x: i.transform![4]!, y: i.transform![5]!, w: i.width ?? 0, h: Math.max(6, Math.abs(i.transform![3]!) || i.height || 10) }));
    const used: { x: number; y: number; w: number; h: number }[] = [];
    const free = (b: { x: number; y: number; w: number; h: number }) => !used.some((u) => b.x < u.x + u.w && u.x < b.x + b.w && b.y < u.y + u.h && u.y < b.y + b.h);
    for (const it of items) {
      // a run of underscores is a blank to write on; the label is the nearest text to its right on the same line
      const blank = /_{4,}|\.{6,}/.test(it.s);
      const label = it.s.replace(/[_.]{4,}/g, '').trim();
      // a keyword counts only in a short label ("טלפון:", "חתימה"), not inside a sentence or a table topic
      const kind = label.length <= 25 ? KINDS.find(([re]) => re.test(label)) : undefined;
      const isLabel = (/[:׃]\s*$/.test(label) && /[\p{L}]{2}/u.test(label)) || !!kind;
      if (!blank && !isLabel) continue;
      if (label.length > 40) continue;
      const type = kind?.[1] ?? 'text';
      const name = label.replace(/[:׃]\s*$/, '').trim() || kind?.[2] || 'שדה';
      const h = type === 'signature' ? Math.max(18, it.h * 2) : Math.max(12, it.h + 4);
      let box: { x: number; y: number; w: number; h: number };
      if (blank && !label) box = { x: it.x, y: it.y - 2, w: Math.max(40, it.w), h };
      else {
        // right-to-left form: the space to write is left of the label, up to the next printed text on that line
        const leftNeighbour = items.filter((o) => o !== it && Math.abs(o.y - it.y) < it.h * 0.6 && o.x + o.w < it.x - 2).map((o) => o.x + o.w).sort((a, b) => b - a)[0];
        const start = Math.max(leftNeighbour !== undefined ? leftNeighbour + 6 : 30, it.x - (type === 'signature' ? 160 : 200));
        const end = it.x - 4;
        if (end - start < 30) continue;
        box = { x: start, y: it.y - (h - it.h) / 2 - 2, w: end - start, h };
      }
      if (!free(box)) continue;
      used.push(box);
      out.push({ type, label: name.slice(0, 80), page: n - 1, ...round(box), required: type === 'signature' });
      if (out.length >= 80) break;
    }
  }
  return { pages, suggestions: out };
}
const round = (b: { x: number; y: number; w: number; h: number }) => ({ x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, w: Math.round(b.w * 10) / 10, h: Math.round(b.h * 10) / 10 });

run((workerData as { data: Uint8Array }).data)
  .then((r) => parentPort!.postMessage({ ok: true, ...r }))
  .catch((e: Error) => parentPort!.postMessage({ ok: false, error: e.message === 'too_many_pages' ? 'too_many_pages' : 'pdf_unreadable' }));
