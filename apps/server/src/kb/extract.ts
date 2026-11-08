import { Worker } from 'node:worker_threads';

export type DocKind = 'html' | 'text' | 'csv' | 'docx' | 'pdf' | 'xlsx';
export interface Extracted { title: string | null; text: string; links: string[]; sheets?: { name: string; rows: string[][] }[] }

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Which parser to use for an uploaded file / fetched content type; null = not allowed. */
export function kindFor(fileNameOrUrl: string, mime: string): DocKind | null {
  const m = mime.toLowerCase();
  const ext = (/\.([a-z0-9]{1,5})(?:[?#].*)?$/i.exec(fileNameOrUrl)?.[1] ?? '').toLowerCase();
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m === DOCX || ext === 'docx') return 'docx';
  if (m === XLSX || ext === 'xlsx') return 'xlsx';
  if (/html|xhtml/.test(m) || ext === 'html' || ext === 'htm') return 'html';
  if (m === 'text/csv' || ext === 'csv') return 'csv';
  if (m.startsWith('text/') || ext === 'txt' || ext === 'md') return 'text';
  return null;
}

const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

/** Parse an untrusted document in an isolated worker (memory cap, hard timeout). */
export function extract(kind: DocKind, data: Buffer, timeoutMs = 30_000): Promise<Extracted> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(`./extract-worker${ext}`, import.meta.url), {
      workerData: { kind, data: new Uint8Array(data) },
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32 },
      execArgv: ext === '.ts' ? ['--import', 'tsx'] : [],
    });
    const timer = setTimeout(() => { void w.terminate(); reject(new Error('extract_timeout')); }, timeoutMs);
    w.once('message', (m: { ok: boolean; title?: string | null; text?: string; links?: string[]; sheets?: { name: string; rows: string[][] }[]; error?: string }) => {
      clearTimeout(timer);
      void w.terminate();
      if (m.ok) resolve({ title: m.title ?? null, text: m.text ?? '', links: m.links ?? [], sheets: m.sheets }); else reject(new Error(m.error ?? 'extract_failed'));
    });
    w.once('error', (e: Error) => { clearTimeout(timer); reject(e.message.includes('memory') ? new Error('extract_memory') : new Error('extract_failed')); });
    w.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error('extract_failed')); });
  });
}
