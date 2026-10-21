import net from 'node:net';

export type ScanResult = { status: 'clean' } | { status: 'infected'; detail: string } | { status: 'error'; detail: string };

const CHUNK = 64 * 1024;

/** ClamAV clamd INSTREAM protocol over TCP (see clamd docs): zINSTREAM\0 then [u32 BE len][data]... [0 len]. */
export function clamScan(buf: Buffer, opts: { host: string; port: number; timeoutMs?: number }): Promise<ScanResult> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: opts.host, port: opts.port });
    let out = '';
    let done = false;
    const finish = (r: ScanResult) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(opts.timeoutMs ?? 60_000, () => finish({ status: 'error', detail: 'timeout' }));
    sock.on('error', (e: NodeJS.ErrnoException) => finish({ status: 'error', detail: e.code ?? 'connection_error' }));
    sock.on('data', (d) => { out += d.toString('utf8'); });
    sock.on('close', () => finish(parseReply(out)));
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buf.length; i += CHUNK) {
        const part = buf.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
    });
  });
}

export function parseReply(raw: string): ScanResult {
  const msg = raw.replace(/\0/g, '').trim();
  if (/^stream: OK$/.test(msg)) return { status: 'clean' };
  const m = /^stream: (.+) FOUND$/.exec(msg);
  if (m) return { status: 'infected', detail: m[1]!.replace(/[^\w.\-/]/g, '').slice(0, 120) };
  return { status: 'error', detail: msg ? 'scanner_error' : 'empty_reply' };
}
