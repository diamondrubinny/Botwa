import { fileTypeFromBuffer } from 'file-type';

export type MediaKind = 'image' | 'audio' | 'video' | 'document';
export interface Detected { mime: string; ext: string; kind: MediaKind; inline: boolean }

// Allowlist by CONTENT (magic bytes), never by extension or declared MIME. Anything else is blocked.
// SVG/HTML/scripts/executables/archives are deliberately absent. Only images are ever displayed inline.
const ALLOWED: Record<string, { kind: MediaKind; inline: boolean }> = {
  'image/jpeg': { kind: 'image', inline: true },
  'image/png': { kind: 'image', inline: true },
  'image/webp': { kind: 'image', inline: true },
  'image/gif': { kind: 'image', inline: true },
  'application/pdf': { kind: 'document', inline: false },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'document', inline: false },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'document', inline: false },
  'audio/ogg': { kind: 'audio', inline: false },
  'audio/opus': { kind: 'audio', inline: false },
  'audio/mpeg': { kind: 'audio', inline: false },
  'audio/mp4': { kind: 'audio', inline: false },
  'audio/x-m4a': { kind: 'audio', inline: false },
  'audio/aac': { kind: 'audio', inline: false },
  'video/mp4': { kind: 'video', inline: false },
};

export async function detect(buf: Buffer): Promise<Detected | null> {
  const t = await fileTypeFromBuffer(buf);
  if (!t) return null;
  const a = ALLOWED[t.mime];
  return a ? { mime: t.mime, ext: t.ext, ...a } : null;
}

/** Display-only name: no path parts, no control or shell/HTML-significant characters, bounded length. */
export function sanitizeFileName(name: string | undefined | null, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g, '').trim().replace(/^\.+/, '');
  return (clean || fallback).slice(0, 100);
}
