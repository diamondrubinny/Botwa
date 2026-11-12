import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { adapt, contrast, loadBrand, logoSrc, onColor, setBrand, useBrand, type Brand } from '../brand';
import { errText } from '../strings';

interface Swatch { hex: string; source: string }
interface Found { url: string; title: string | null; colors: Swatch[]; logos: string[] }

const SOURCE: Record<string, string> = { 'theme-color': 'צבע ערכת הנושא של האתר', manifest: 'צבע האפליקציה של האתר', 'css-var': 'משתנה צבע ראשי באתר', css: 'צבע נפוץ באתר', logo: 'מהלוגו' };

/** The most common saturated colours of an image, found in the browser (nothing is uploaded for this). */
function logoColors(src: string): Promise<Swatch[]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const ctx = c.getContext('2d'); if (!ctx) return resolve([]);
        ctx.drawImage(img, 0, 0, 64, 64);
        const d = ctx.getImageData(0, 0, 64, 64).data;
        const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3]! < 200) continue;
          const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx - mn < 40 || mx > 235 || mx < 30) continue; // greys, white and black are not brand colours
          const k = `${r >> 5}-${g >> 5}-${b >> 5}`;
          const e = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
          e.n++; e.r += r; e.g += g; e.b += b; buckets.set(k, e);
        }
        resolve([...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 4).map((e) => ({ hex: `#${[e.r, e.g, e.b].map((v) => Math.round(v / e.n).toString(16).padStart(2, '0')).join('')}`, source: 'logo' })));
      } catch { resolve([]); }
    };
    img.onerror = () => resolve([]);
    img.src = src;
  });
}

export function Branding() {
  const brand = useBrand();
  const [name, setName] = useState(brand.appName);
  const [color, setColor] = useState(brand.color ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [site, setSite] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [fromLogo, setFromLogo] = useState<Swatch[]>([]);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  useEffect(() => { if (!loaded.current && brand.v !== undefined) { setName(brand.appName); setColor(brand.color ?? ''); loaded.current = true; } }, [brand]);
  useEffect(() => { if (brand.hasLogo) void logoColors(logoSrc(brand)).then(setFromLogo); else setFromLogo([]); }, [brand.hasLogo, brand.v]); // eslint-disable-line react-hooks/exhaustive-deps

  const valid = /^#[0-9a-fA-F]{6}$/.test(color);
  const fail = (e: unknown) => setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') });
  const apply = (b: Brand) => setBrand(b);

  async function save(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    try { apply(await api<Brand>('PUT', '/branding', { appName: name.trim(), color: valid ? color.toLowerCase() : null })); setMsg({ ok: true, text: 'המיתוג נשמר.' }); } catch (er) { fail(er); }
  }
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setMsg(null); setBusy(true);
    const f = (e.currentTarget.elements.namedItem('logo') as HTMLInputElement).files?.[0];
    if (!f) { setBusy(false); return; }
    const fd = new FormData(); fd.append('file', f);
    try {
      const res = await fetch('/branding/logo', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = (await res.json().catch(() => ({}))) as Brand & { error?: string };
      if (!res.ok) throw new ApiError(res.status, j.error ?? 'error');
      apply(j); setMsg({ ok: true, text: 'הלוגו הוחלף.' }); (e.target as HTMLFormElement).reset();
    } catch (er) { fail(er); }
    setBusy(false);
  }
  async function removeLogo() { setMsg(null); try { apply(await api<Brand>('DELETE', '/branding/logo')); setMsg({ ok: true, text: 'הלוגו הוסר.' }); } catch (er) { fail(er); } }
  async function extract(e: FormEvent) {
    e.preventDefault(); setMsg(null); setBusy(true); setFound(null);
    try { setFound(await api<Found>('POST', '/branding/extract', { url: site.trim() })); } catch (er) { fail(er); }
    setBusy(false);
  }
  async function useRemoteLogo(url: string) {
    setMsg(null); setBusy(true);
    try { apply(await api<Brand>('POST', '/branding/logo-from-url', { url })); setMsg({ ok: true, text: 'הלוגו נשמר מהאתר.' }); } catch (er) { fail(er); }
    setBusy(false);
  }

  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  const cs = (n: string, f: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
  const ad = valid ? adapt(color, cs('--bg', '#fff'), cs('--surface', '#fff'), dark) : null;
  const sw = (s: Swatch) => (
    <button key={s.hex + s.source} type="button" className="bswatch" onClick={() => setColor(s.hex)} aria-label={`בחירת הצבע ${s.hex} (${SOURCE[s.source] ?? s.source})`}>
      <i style={{ background: s.hex }} aria-hidden="true" /><span dir="ltr">{s.hex}</span>
    </button>
  );

  return (
    <section className="card" aria-labelledby="br-h">
      <h2 id="br-h">מיתוג: שם, לוגו וצבע</h2>
      <p className="hint">השם, הלוגו והצבע מופיעים במסך הכניסה, בתפריט, בלשונית הדפדפן ובכפתורים. הצבע מותאם אוטומטית כך שיישאר קריא (ניגודיות 4.5:1 לפחות) בכל ערכת נושא. מצב ניגודיות גבוהה מבטל את הצבע המותאם.</p>
      <form onSubmit={save}>
        <div className="field"><label htmlFor="br-name">שם המוצר (עד 40 תווים)</label><input id="br-name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field">
          <label htmlFor="br-color">צבע המותג (למשל #0f766e). ריק = ערכות הנושא המובנות</label>
          <div className="row">
            <input id="br-color" dir="ltr" maxLength={7} value={color} onChange={(e) => setColor(e.target.value.trim())} placeholder="#0f766e" aria-invalid={color !== '' && !valid} style={{ maxWidth: 160 }} />
            <label htmlFor="br-picker" className="sr-only">בוחר צבע</label>
            <input id="br-picker" type="color" value={valid ? color : '#6a3de8'} onChange={(e) => setColor(e.target.value)} style={{ width: 56, minHeight: 44, padding: 2 }} />
          </div>
          {color !== '' && !valid && <p className="error">נדרש צבע בפורמט #rrggbb.</p>}
          {ad && (
            <p className="hint" role="status">
              כפתור בצבע הזה: טקסט {onColor(ad.hex) === '#ffffff' ? 'לבן' : 'כהה'}, ניגודיות {contrast(ad.hex, onColor(ad.hex)).toFixed(1)}:1.
              {ad.changed ? ` בערכת הנושא הנוכחית הצבע מוצג מעט ${dark ? 'בהיר' : 'כהה'} יותר (${ad.hex}) כדי לעמוד בניגודיות.` : ' הצבע עומד בניגודיות בערכת הנושא הנוכחית.'}
            </p>
          )}
        </div>
        {fromLogo.length > 0 && <div><strong>צבעים מהלוגו</strong><div className="bswatches">{fromLogo.map(sw)}</div></div>}
        <button className="primary" type="submit">שמירת שם וצבע</button>
        {color !== '' && <button type="button" onClick={() => setColor('')} style={{ marginInlineStart: '.5rem' }}>חזרה לערכות המובנות</button>}
      </form>

      <h3>לוגו</h3>
      <div className="row">
        {brand.hasLogo ? <img className="brand-logo" src={logoSrc(brand)} alt="הלוגו הנוכחי" /> : <span className="hint">אין לוגו. מוצג סמל ברירת מחדל.</span>}
        {brand.hasLogo && <button type="button" className="danger" onClick={removeLogo}>הסרת הלוגו</button>}
      </div>
      <form onSubmit={upload}>
        <div className="field"><label htmlFor="br-logo">העלאת לוגו (PNG, JPEG או WebP, עד 512KB)</label><input id="br-logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" required /></div>
        <p className="hint">SVG לא נתמך מטעמי אבטחה. הקובץ נבדק לפי תוכנו ונסרק לוירוסים.</p>
        <button type="submit" disabled={busy}>העלאה</button>
      </form>

      <h3>משיכה מאתר או ממותג</h3>
      <form onSubmit={extract}>
        <div className="field"><label htmlFor="br-site">כתובת האתר של המותג</label><input id="br-site" dir="ltr" required maxLength={500} value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://www.example.com" /></div>
        <button type="submit" disabled={busy}>{busy ? 'בודק…' : 'משיכת צבעים ולוגו'}</button>
      </form>
      <p className="hint">השרת קורא את דף הבית ואת קובצי העיצוב שלו ומציע צבעים, ולוגואים שהאתר מצהיר עליהם. זה רק הצעה: בוחרים בעצמם. יש לוודא שיש רשות להשתמש בלוגו ובמותג.</p>
      {found && (
        <div aria-live="polite">
          <p>נמצא באתר {found.title ? `"${found.title}"` : found.url}:</p>
          {found.colors.length === 0 ? <p>לא נמצאו צבעים בולטים.</p> : <div className="bswatches">{found.colors.map(sw)}</div>}
          {found.logos.length > 0 && (
            <div>
              <strong>לוגואים אפשריים</strong>
              <ul>{found.logos.map((u) => <li key={u} className="row"><span dir="ltr" style={{ overflowWrap: 'anywhere' }}>{u}</span><button type="button" disabled={busy} onClick={() => useRemoteLogo(u)}>שימוש כלוגו</button></li>)}</ul>
              <p className="hint">רק PNG, JPEG או WebP. סמלי ico ו-SVG לא נקלטים.</p>
            </div>
          )}
        </div>
      )}
      <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
    </section>
  );
}

export { loadBrand };
