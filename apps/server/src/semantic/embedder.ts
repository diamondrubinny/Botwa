import type { Config } from '../config.js';

/**
 * Local text embeddings ("meaning" matching) with no external service: a small multilingual model (e5) runs on this server
 * through ONNX. The only network access is the one-time model download from the model hub into MODEL_DIR; no customer text is sent anywhere.
 * The runtime library is optional (installed with WITH_SEMANTIC=1); without it the system keeps working with keyword search.
 */
export type EmbedKind = 'query' | 'passage';
export type EmbedderState = 'off' | 'loading' | 'ready' | 'error';
export interface Embedder {
  status(): { state: EmbedderState; detail?: string; model?: string };
  /** Normalised vectors (unit length), so a dot product is the cosine similarity. */
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
}

export const dot = (a: Float32Array, b: Float32Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
export const toBuffer = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBuffer = (b: Buffer): Float32Array => { const out = new Float32Array(b.byteLength / 4); for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4); return out; };

export class LocalEmbedder implements Embedder {
  private state: EmbedderState = 'off';
  private detail?: string;
  private extractor?: (input: string[], opts: object) => Promise<{ tolist(): number[][] }>;
  private loading?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: Pick<Config, 'SEMANTIC_SEARCH' | 'SEMANTIC_MODEL' | 'MODEL_DIR'>, private readonly onReady?: () => void) {
    if (cfg.SEMANTIC_SEARCH === 'local') void this.load();
  }

  status() { return { state: this.state, detail: this.detail, model: this.cfg.SEMANTIC_SEARCH === 'local' ? this.cfg.SEMANTIC_MODEL : undefined }; }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      this.state = 'loading';
      try {
        const name = '@huggingface/transformers'; // optional dependency: resolved at run time so a plain install does not need it
        const tf = (await import(/* @vite-ignore */ name).catch(() => null)) as null | { pipeline: (t: string, m: string, o: object) => Promise<never>; env: { cacheDir: string } };
        if (!tf) { this.state = 'error'; this.detail = 'not_installed'; return; }
        tf.env.cacheDir = this.cfg.MODEL_DIR;
        this.extractor = (await tf.pipeline('feature-extraction', this.cfg.SEMANTIC_MODEL, { dtype: 'q8' })) as unknown as typeof this.extractor;
        this.state = 'ready';
        this.onReady?.();
      } catch (e) {
        this.state = 'error';
        this.detail = e instanceof Error ? e.message.slice(0, 160) : 'load_failed';
      }
    })();
    return this.loading;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (this.state !== 'ready' || !this.extractor) throw new Error('embedder_not_ready');
    const prefix = kind === 'query' ? 'query: ' : 'passage: ';
    const run = this.chain.then(async () => {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 16) { // batches keep memory flat
        const res = await this.extractor!(texts.slice(i, i + 16).map((t) => prefix + t.slice(0, 1200)), { pooling: 'mean', normalize: true });
        for (const row of res.tolist()) out.push(Float32Array.from(row));
      }
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export const NO_EMBEDDER: Embedder = { status: () => ({ state: 'off' }), embed: async () => { throw new Error('embedder_not_ready'); } };
