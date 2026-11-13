import { sniffImage } from './branding.js';

export const MAX_AVATAR_BYTES = 512 * 1024;

/**
 * Remove everything but the picture from a PNG or JPEG: EXIF (GPS position, camera, date), XMP, comments, text chunks.
 * Returns null for anything that is not a well-formed PNG/JPEG (WebP and others are refused).
 */
export function stripImageMetadata(buf: Buffer): { mime: 'image/png' | 'image/jpeg'; data: Buffer } | null {
  const mime = sniffImage(buf);
  if (mime === 'image/png') {
    const out: Buffer[] = [buf.subarray(0, 8)];
    let p = 8, sawEnd = false;
    const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs']);
    while (p + 12 <= buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.subarray(p + 4, p + 8).toString('latin1');
      const end = p + 12 + len;
      if (len > buf.length || end > buf.length) return null;
      if (KEEP.has(type)) out.push(buf.subarray(p, end));
      p = end;
      if (type === 'IEND') { sawEnd = true; break; }
    }
    return sawEnd ? { mime, data: Buffer.concat(out) } : null;
  }
  if (mime === 'image/jpeg') {
    const out: Buffer[] = [buf.subarray(0, 2)];
    let p = 2;
    while (p + 4 <= buf.length) {
      if (buf[p] !== 0xff) return null;
      const marker = buf[p + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(buf.subarray(p, p + 2)); p += 2; continue; }
      if (marker === 0xda) { out.push(buf.subarray(p)); return { mime, data: Buffer.concat(out) }; }   // start of scan: the image data to the end
      const len = buf.readUInt16BE(p + 2);
      const end = p + 2 + len;
      if (len < 2 || end > buf.length) return null;
      // keep JFIF (APP0) and Adobe colour info (APP14); drop APP1-13/15 (EXIF, XMP, ICC with names) and comments
      const drop = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
      if (!drop) out.push(buf.subarray(p, end));
      p = end;
    }
    return null;
  }
  return null;
}

/** Width and height of a PNG (IHDR) or JPEG (first SOF marker), or null when they cannot be read. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.subarray(1, 4).toString('latin1') === 'PNG' && buf.subarray(12, 16).toString('latin1') === 'IHDR') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) return null;
      const m = buf[p + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
      p += 2 + buf.readUInt16BE(p + 2);
    }
  }
  return null;
}
