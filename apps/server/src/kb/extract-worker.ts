import { parentPort, workerData } from 'node:worker_threads';
import { parse } from 'node-html-parser';

/**
 * Runs inside a worker thread with a memory cap and a hard timeout set by the parent (extract.ts): parsers handle untrusted
 * files, so a crash, memory bomb or endless loop must only cost this thread, not the server.
 */
type Job = { kind: 'html' | 'text' | 'csv' | 'docx' | 'pdf'; data: Uint8Array };
const MAX_CHARS = 2_000_000;

function htmlToText(html: string): { title: string | null; text: string; links: string[] } {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  const links = root.querySelectorAll('a[href]').map((a) => a.getAttribute('href') ?? '').filter(Boolean).slice(0, 500);
  const title = root.querySelector('title')?.text.trim() || root.querySelector('h1')?.text.trim() || null;
  root.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,svg,iframe,template,button,select').forEach((n) => n.remove());
  const main = root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('body') ?? root;
  const lines: string[] = [];
  const walk = (n: import('node-html-parser').Node) => {
    if (n.nodeType === 3) { const t = n.text.replace(/\s+/g, ' '); if (t.trim()) lines.push(t); return; }
    const el = n as import('node-html-parser').HTMLElement;
    const tag = (el.tagName ?? '').toLowerCase();
    if (/^h[1-4]$/.test(tag)) { lines.push(`\n\n# ${el.text.replace(/\s+/g, ' ').trim()}\n\n`); return; }
    if (tag === 'li') lines.push('\n- ');
    if (tag === 'br') { lines.push('\n'); return; }
    el.childNodes.forEach(walk);
    if (/^(p|div|section|ul|ol|table|tr|li|blockquote|pre|dl|dd|dt)$/.test(tag)) lines.push('\n');
    if (tag === 'td' || tag === 'th') lines.push(' | ');
  };
  walk(main);
  const text = lines.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text, links };
}

function csvToText(s: string): string {
  const rows = s.split(/\r?\n/).filter(Boolean).slice(0, 5000).map((l) => l.split(/,|;|\t/).map((c) => c.replace(/^"|"$/g, '').trim()));
  const head = rows[0] ?? [];
  return rows.slice(1).map((r) => r.map((c, i) => (head[i] ? `${head[i]}: ${c}` : c)).join('; ')).join('\n\n');
}

async function run(job: Job): Promise<{ title: string | null; text: string; links?: string[] }> {
  const buf = Buffer.from(job.data);
  if (job.kind === 'text') return { title: null, text: buf.toString('utf8') };
  if (job.kind === 'csv') return { title: null, text: csvToText(buf.toString('utf8')) };
  if (job.kind === 'html') return htmlToText(buf.toString('utf8'));
  if (job.kind === 'docx') {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buf);
    const entries = Object.values(zip.files) as unknown as { _data?: { uncompressedSize?: number } }[];
    if (entries.length > 3000 || entries.reduce((n, e) => n + (e._data?.uncompressedSize ?? 0), 0) > 80 * 1024 * 1024) throw new Error('archive_too_large');
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    return { title: null, text: r.value };
  }
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  if (pdf.numPages > 300) throw new Error('too_many_pages');
  const { text } = await extractText(pdf, { mergePages: false });
  return { title: null, text: (text as string[]).map((t) => t.replace(/[ \t]+/g, ' ')).join('\n\n') };
}

run(workerData as Job)
  .then((r) => parentPort!.postMessage({ ok: true, title: r.title, text: r.text.slice(0, MAX_CHARS), links: r.links ?? [] }))
  .catch((e: Error) => parentPort!.postMessage({ ok: false, error: e.message.slice(0, 200) }));
