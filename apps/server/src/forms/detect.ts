import { Worker } from 'node:worker_threads';

export interface Detected { pages: { w: number; h: number }[]; suggestions: { type: string; label: string; page: number; x: number; y: number; w: number; h: number; required: boolean }[] }
const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

/** Page sizes and suggested fields of an untrusted PDF, read in an isolated worker (memory cap, hard timeout). */
export function detectFields(data: Buffer, timeoutMs = 30_000): Promise<Detected> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(`./detect-worker${ext}`, import.meta.url), {
      workerData: { data: new Uint8Array(data) },
      resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32 },
      execArgv: ext === '.ts' ? ['--import', 'tsx'] : [],
    });
    const timer = setTimeout(() => { void w.terminate(); reject(new Error('pdf_timeout')); }, timeoutMs);
    w.once('message', (m: { ok: boolean; error?: string } & Partial<Detected>) => {
      clearTimeout(timer); void w.terminate();
      if (m.ok) resolve({ pages: m.pages!, suggestions: m.suggestions! }); else reject(new Error(m.error ?? 'pdf_unreadable'));
    });
    w.once('error', () => { clearTimeout(timer); reject(new Error('pdf_unreadable')); });
    w.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error('pdf_unreadable')); });
  });
}
