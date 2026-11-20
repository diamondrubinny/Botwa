import { parentPort, workerData } from 'node:worker_threads';
import { parse } from 'node-html-parser';

/**
 * Runs inside a worker thread with a memory cap and a hard timeout set by the parent (extract.ts): parsers handle untrusted
 * files, so a crash, memory bomb or endless loop must only cost this thread, not the server.
 */
type HtmlOpts = { select?: string; remove?: string[] };
type Job = { kind: 'html' | 'text' | 'csv' | 'docx' | 'pdf' | 'xlsx'; data: Uint8Array; opts?: HtmlOpts };
type Sheet = { name: string; rows: string[][] };
const MAX_CHARS = 2_000_000;

const BOILERPLATE = /(^|[-_\s])(cookie|cookies|consent|gdpr|breadcrumb|breadcrumbs|share|social|sidebar|popup|modal|newsletter|toolbar|skip-link|a11y|accessibility-widget)([-_\s]|$)/i;
const SHELL_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'dialog', 'search']);

function htmlToText(html: string, opts: HtmlOpts = {}): { title: string | null; text: string; links: string[] } {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  // links the site asks robots not to follow are not followed
  const links = root.querySelectorAll('a[href]').filter((a) => !/nofollow/i.test(a.getAttribute('rel') ?? '')).map((a) => a.getAttribute('href') ?? '').filter(Boolean).slice(0, 1000);
  const title = root.querySelector('title')?.text.trim() || root.querySelector('h1')?.text.trim() || null;
  root.querySelectorAll('script,style,noscript,nav,footer,header,aside,svg,iframe,template,button,select,input,textarea').forEach((n) => n.remove());
  // small forms (search, login, newsletter) are page furniture; but some sites (ASP.NET WebForms) wrap the whole page in one <form>, so a form with a lot of text is content
  root.querySelectorAll('form').forEach((f) => { if (f.text.replace(/\s+/g, ' ').trim().length < 600) f.remove(); });
  for (const sel of opts.remove ?? []) { try { root.querySelectorAll(sel).forEach((n) => n.remove()); } catch { /* an invalid selector is ignored */ } }
  let chosen: import('node-html-parser').HTMLElement | null = null;
  if (opts.select) { try { chosen = root.querySelector(opts.select); } catch { chosen = null; } }
  const main = chosen ?? root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('[role=main]') ?? root.querySelector('body') ?? root;
  if (!chosen) {
    // cookie banners, share bars, breadcrumbs, pop-ups and landmark regions that are page furniture, not content
    main.querySelectorAll('[class],[id],[role]').forEach((n) => {
      if (SHELL_ROLES.has((n.getAttribute('role') ?? '').toLowerCase()) || BOILERPLATE.test(`${n.getAttribute('class') ?? ''} ${n.getAttribute('id') ?? ''}`)) n.remove();
    });
  }
  const lines: string[] = [];
  const walk = (n: import('node-html-parser').Node) => {
    if (n.nodeType === 3) { const t = n.text.replace(/\s+/g, ' '); if (t.trim()) lines.push(t); return; }
    const el = n as import('node-html-parser').HTMLElement;
    const tag = (el.tagName ?? '').toLowerCase();
    if (/^h[1-4]$/.test(tag)) { lines.push(`\n\n${'#'.repeat(Number(tag[1]))} ${el.text.replace(/\s+/g, ' ').trim()}\n\n`); return; }
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

/** Spreadsheet cells as plain text. Limits: 30 sheets, 5000 rows, 40 columns per sheet. */
async function readWorkbook(buf: Buffer): Promise<Sheet[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files) as unknown as { _data?: { uncompressedSize?: number } }[];
  if (entries.length > 500 || entries.reduce((n, e) => n + (e._data?.uncompressedSize ?? 0), 0) > 100 * 1024 * 1024) throw new Error('archive_too_large');
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const out: Sheet[] = [];
  for (const ws of wb.worksheets.slice(0, 30)) {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n > 5000) return;
      while (rows.length < n - 1) rows.push([]);   // keep blank rows as empty ones, so rows[i] is spreadsheet row i + 1
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(40, ws.columnCount); c++) {
        const v = row.getCell(c).value;
        cells.push(v instanceof Date ? v.toISOString().slice(0, 10) : String(row.getCell(c).text ?? '').replace(/\u0000/g, '').trim().slice(0, 5000));
        void v;
      }
      rows.push(cells);
    });
    out.push({ name: ws.name, rows });
  }
  return out;
}

async function run(job: Job): Promise<{ title: string | null; text: string; links?: string[]; sheets?: Sheet[] }> {
  const buf = Buffer.from(job.data);
  if (job.kind === 'text') return { title: null, text: buf.toString('utf8') };
  if (job.kind === 'csv') return { title: null, text: csvToText(buf.toString('utf8')) };
  if (job.kind === 'html') return htmlToText(buf.toString('utf8'), job.opts);
  if (job.kind === 'xlsx') {
    const sheets = await readWorkbook(buf);
    const text = sheets.map((sh) => { const [head = [], ...rest] = sh.rows; return `# ${sh.name}\n\n${rest.map((r) => r.map((c, i) => (head[i] && c ? `${head[i]}: ${c}` : c)).filter(Boolean).join('; ')).filter(Boolean).join('\n\n')}`; }).join('\n\n');
    return { title: null, text, sheets };
  }
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
  .then((r) => parentPort!.postMessage({ ok: true, title: r.title, text: r.text.slice(0, MAX_CHARS), links: r.links ?? [], sheets: r.sheets }))
  .catch((e: Error) => parentPort!.postMessage({ ok: false, error: e.message.slice(0, 200) }));
