import { useState } from 'react';
import { api, ApiError } from '../api';

/** A person's picture, or the first letter of their name. Decorative: the name is always shown next to it. */
export function Avatar({ userId, name, v, size = 36 }: { userId: string; name: string; v?: number | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, minWidth: size, fontSize: Math.round(size * 0.42) };
  if (v && !broken) return <img className="avatar avatar-img" src={`/users/${userId}/avatar?v=${v}`} alt="" aria-hidden="true" width={size} height={size} style={style} onError={() => setBroken(true)} />;
  return <span className="avatar" aria-hidden="true" style={style}>{name.slice(0, 1)}</span>;
}

/** Square-crop and shrink a chosen photo in the browser (256px JPEG): small upload, and the original's metadata never leaves the device. */
export async function prepareAvatar(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp|gif|heic|heif)$/i.test(file.type) && !/\.(png|jpe?g|webp|gif|heic|heif)$/i.test(file.name)) throw new ApiError(415, 'unsupported_image');
  if (file.size > 25 * 1024 * 1024) throw new ApiError(413, 'too_large');
  const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new ApiError(415, 'unsupported_image')); r.readAsDataURL(file); });
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new ApiError(415, 'unsupported_image')); i.src = url; });
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new ApiError(415, 'unsupported_image');
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 256, 256);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
  return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new ApiError(415, 'unsupported_image'))), 'image/jpeg', 0.88));
}

export async function uploadAvatar(url: string, file: File): Promise<void> {
  const blob = await prepareAvatar(file);
  const fd = new FormData();
  fd.append('file', blob, 'avatar.jpg');
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: fd });
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'error');
}
export const removeAvatar = (url: string) => api('DELETE', url);
export const AVATAR_ERR: Record<string, string> = {
  unsupported_image: 'אפשר להעלות תמונה בפורמט JPG, PNG, WEBP או HEIC.',
  too_large: 'התמונה גדולה מדי.',
  file_infected: 'הקובץ נחסם בבדיקת האבטחה.',
  scan_unavailable: 'בדיקת האבטחה לא זמינה כרגע. נסו שוב בעוד כמה דקות.',
  role_exceeds_permissions: 'אין הרשאה לשנות את התמונה של משתמש זה.',
};

/** Choose / change / remove a picture (own, or someone else's for managers). */
export function AvatarEditor({ userId, name, v, uploadUrl, onChanged, compact = false }: { userId: string; name: string; v?: number | null; uploadUrl: string; onChanged: () => void | Promise<void>; compact?: boolean }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = `av-${userId}`;
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setMsg(null);
    try { await uploadAvatar(uploadUrl, f); setMsg({ ok: true, text: 'התמונה עודכנה.' }); await onChanged(); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? AVATAR_ERR[e.code] ?? 'ההעלאה נכשלה.' : 'ההעלאה נכשלה.' }); }
    setBusy(false);
  };
  return (
    <div className="avatar-editor">
      <div className="row">
        {!compact && <Avatar userId={userId} name={name} v={v} size={72} />}
        <input id={inputId} type="file" accept="image/*" className="sr-only" disabled={busy} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        <label htmlFor={inputId} className={`btn${busy ? ' disabled' : ''}`} style={compact ? { minHeight: 32, padding: '0 .6rem' } : undefined}>
          {busy ? 'מעלה…' : v ? 'החלפת תמונה' : 'העלאת תמונה'}<span className="sr-only"> עבור {name}</span>
        </label>
        {v ? <button type="button" style={compact ? { minHeight: 32 } : undefined} disabled={busy} onClick={async () => { setMsg(null); try { await removeAvatar(uploadUrl); setMsg({ ok: true, text: 'התמונה הוסרה.' }); await onChanged(); } catch { setMsg({ ok: false, text: 'ההסרה נכשלה.' }); } }}>הסרה<span className="sr-only"> של התמונה של {name}</span></button> : null}
      </div>
      <p role={msg?.ok === false ? 'alert' : 'status'} className={msg?.ok === false ? 'error' : 'hint'} style={{ margin: msg ? '.3rem 0 0' : 0 }}>{msg?.text}</p>
    </div>
  );
}
