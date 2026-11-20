import net from 'node:net';

export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Minimal clamd INSTREAM server for tests: reports FOUND when the stream contains the EICAR string. */
export function startFakeClamd(port = 0): Promise<{ port: number; close(): Promise<void>; requests: number }> {
  const state = { port: 0, requests: 0, close: async () => {} };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const header = Buffer.from('zINSTREAM\0');
      if (buf.length < header.length || !buf.subarray(0, header.length).equals(header)) return;
      let off = header.length;
      const chunks: Buffer[] = [];
      for (;;) {
        if (buf.length < off + 4) return;
        const len = buf.readUInt32BE(off);
        if (len === 0) break;
        if (buf.length < off + 4 + len) return;
        chunks.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
      state.requests++;
      const found = Buffer.concat(chunks).includes(Buffer.from(EICAR));
      sock.end(found ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      state.port = (server.address() as net.AddressInfo).port;
      const conns = new Set<net.Socket>();
      server.on('connection', (c) => { conns.add(c); c.on('close', () => conns.delete(c)); });
      state.close = () => new Promise<void>((r) => { conns.forEach((c) => c.destroy()); server.close(() => r()); });
      resolve(state);
    });
  });
}
