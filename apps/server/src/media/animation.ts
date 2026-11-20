import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Width and height from a GIF header (logical screen descriptor), or null when the bytes are not a GIF. */
export function gifSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  const sig = buf.subarray(0, 6).toString('latin1');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

const MAX_OUT = 16 * 1024 * 1024;   // WhatsApp's video limit
const TIMEOUT_MS = 20_000;
let running = 0;

/**
 * GIF -> short silent H.264 MP4 (what WhatsApp plays as a looping "GIF"). Returns null when ffmpeg is off, missing, busy or fails;
 * callers then send the GIF as it is. Only ever called on bytes already identified as GIF by content and scanned by the antivirus.
 * Hardening: fixed argument list (no shell), the demuxer forced to gif, only the file protocol, a private temp folder,
 * output capped in length (15 s), width (480 px, even sizes for H.264) and bytes, and a hard kill after 20 s.
 */
export async function gifToMp4(gif: Buffer, opts: { ffmpegPath: string; tmpDir: string }): Promise<Buffer | null> {
  if (!opts.ffmpegPath || !gifSize(gif) || running >= 2) return null;
  running++;
  const dir = path.join(opts.tmpDir, `anim-${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const input = path.join(dir, 'in.gif');
    const output = path.join(dir, 'out.mp4');
    await writeFile(input, gif, { mode: 0o600, flag: 'wx' });
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-protocol_whitelist', 'file', '-f', 'gif', '-i', input,
      '-t', '15', '-an', '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
      '-vf', "scale='min(480,iw)':-2:flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-fs', String(MAX_OUT),
      '-f', 'mp4', output,
    ];
    const ok = await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      let child: ReturnType<typeof spawn>;
      try { child = spawn(opts.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'ignore'], shell: false, env: {} }); } catch { return finish(false); }
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false); }, TIMEOUT_MS);
      child.on('error', () => finish(false));
      child.on('exit', (code) => finish(code === 0));
    });
    if (!ok) return null;
    const st = await stat(output);
    if (st.size === 0 || st.size > MAX_OUT) return null;
    const out = await readFile(output);
    // a real MP4 starts with an ftyp box
    return out.subarray(4, 8).toString('latin1') === 'ftyp' ? out : null;
  } catch {
    return null;
  } finally {
    running--;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
