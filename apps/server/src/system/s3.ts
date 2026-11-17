import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * A minimal client for S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO): PUT, HEAD, GET, DELETE and
 * list, signed with AWS Signature Version 4, path-style addressing ({endpoint}/{bucket}/{key}). No SDK: only what backups need.
 */
export interface S3Config { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string }
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding as SigV4 wants it (every byte but A-Z a-z 0-9 - _ . ~); "/" kept in paths. */
const enc = (s: string, keepSlash = false) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(keepSlash ? /%2F/g : /$^/, '/');
export const EMPTY_SHA256 = sha256hex('');

/**
 * The Authorization header for a request (SigV4). `headers` are the ones to sign (lower-case names): host, x-amz-date and
 * x-amz-content-sha256 must be among them. Exported for the test against AWS's published example.
 */
export function signV4(o: { method: string; path: string; query?: Record<string, string>; headers: Record<string, string>; payloadHash: string; region: string; service?: string; accessKey: string; secretKey: string; amzDate: string }): string {
  const service = o.service ?? 's3';
  const date = o.amzDate.slice(0, 8);
  const names = Object.keys(o.headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(o.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((h) => `${h}:${String(lower[h]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = Object.entries(o.query ?? {}).map(([k, v]) => [enc(k), enc(v)]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [o.method, enc(o.path, true), query, canonicalHeaders, signedHeaders, o.payloadHash].join('\n');
  const scope = `${date}/${o.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', o.amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretKey}`, date), o.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${o.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export class S3Client {
  constructor(private readonly c: S3Config, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i)) {}

  private async request(method: string, key: string | null, o: { query?: Record<string, string>; body?: Buffer; file?: { path: string; size: number }; payloadHash?: string; timeoutMs?: number } = {}): Promise<Response> {
    const base = new URL(this.c.endpoint);
    const path = `${base.pathname.replace(/\/$/, '')}/${this.c.bucket}${key !== null ? `/${key}` : ''}`;
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadHash = o.payloadHash ?? (o.body ? sha256hex(o.body) : EMPTY_SHA256);
    const headers: Record<string, string> = { host: base.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
    const authorization = signV4({ method, path, query: o.query, headers, payloadHash, region: this.c.region, accessKey: this.c.accessKey, secretKey: this.c.secretKey, amzDate });
    const qs = Object.entries(o.query ?? {}).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
    const url = `${base.protocol}//${base.host}${enc(path, true)}${qs ? `?${qs}` : ''}`;
    const length = o.body ? o.body.length : o.file?.size;
    return this.fetchImpl(url, {
      method,
      // a file is streamed from disk (backups can be large); the provider checks it against the SHA-256 signed above
      body: o.body ? new Uint8Array(o.body) : o.file ? (Readable.toWeb(createReadStream(o.file.path)) as unknown as BodyInit) : undefined,
      ...(o.file ? { duplex: 'half' } : {}),
      headers: { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, authorization, ...(length !== undefined ? { 'content-length': String(length) } : {}) },
      signal: AbortSignal.timeout(o.timeoutMs ?? 60_000), redirect: 'error',
    } as RequestInit);
  }

  /** Upload one object (up to 5GB in a single request); the provider checks the payload against its SHA-256. */
  async put(key: string, body: Buffer): Promise<void> {
    const r = await this.request('PUT', key, { body, timeoutMs: 30 * 60_000 });
    if (!r.ok) throw new Error(`s3_put_${r.status}`);
  }
  /** Upload a file from disk, streamed (hashed first, then sent). */
  async putFile(key: string, path: string): Promise<{ size: number; sha256: string }> {
    const size = (await stat(path)).size;
    const h = createHash('sha256');
    await pipeline(createReadStream(path), async function* (src) { for await (const chunk of src) h.update(chunk as Buffer); });
    const sha256 = h.digest('hex');
    const r = await this.request('PUT', key, { file: { path, size }, payloadHash: sha256, timeoutMs: 60 * 60_000 });
    if (!r.ok) throw new Error(`s3_put_${r.status}`);
    return { size, sha256 };
  }
  /** Download an object to a file, streamed. */
  async getFile(key: string, path: string): Promise<number> {
    const r = await this.request('GET', key, { timeoutMs: 60 * 60_000 });
    if (!r.ok || !r.body) throw new Error(`s3_get_${r.status}`);
    await pipeline(Readable.fromWeb(r.body as never), createWriteStream(path, { mode: 0o600 }));
    return (await stat(path)).size;
  }
  async head(key: string): Promise<{ size: number } | null> {
    const r = await this.request('HEAD', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`s3_head_${r.status}`);
    return { size: Number(r.headers.get('content-length') ?? -1) };
  }
  async get(key: string): Promise<Buffer> {
    const r = await this.request('GET', key, { timeoutMs: 30 * 60_000 });
    if (!r.ok) throw new Error(`s3_get_${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async delete(key: string): Promise<void> {
    const r = await this.request('DELETE', key);
    if (!r.ok && r.status !== 404) throw new Error(`s3_delete_${r.status}`);
  }
  /** Keys under a prefix (ListObjectsV2, up to 1000: enough for backups kept by count). */
  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const r = await this.request('GET', null, { query: { 'list-type': '2', prefix, 'max-keys': '1000' } });
    if (!r.ok) throw new Error(`s3_list_${r.status}`);
    const xml = await r.text();
    return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
      key: (/<Key>([^<]*)<\/Key>/.exec(m[1]!)?.[1] ?? '').replace(/&amp;/g, '&'),
      size: Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? 0),
    })).filter((x) => x.key);
  }
}
