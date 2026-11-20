import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { errText } from '../strings';
import { ConfirmDialog } from './ConfirmDialog';
import { GifThumb, motionOff, type GifItem } from './Pickers';

/** Managers keep a library of approved GIFs that agents send from the composer. Every file is checked by content and scanned. */
export function GifLibrary() {
  const [data, setData] = useState<{ gifs: (GifItem & { size: number })[]; enabled: boolean; max: number; maxBytes: number } | null>(null);
  const [title, setTitle] = useState('');
  const [keywords, setKeywords] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [del, setDel] = useState<GifItem | null>(null);
  const [edit, setEdit] = useState<{ id: string; title: string; keywords: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const still = motionOff();
  const reload = async () => setData(await api<NonNullable<typeof data>>('GET', '/gifs').catch(() => null));
  useEffect(() => { void reload(); }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData();
      fd.append('title', title.trim());
      if (keywords.trim()) fd.append('keywords', keywords.trim());
      fd.append('file', file);
      const res = await fetch('/gifs', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = (await res.json().catch(() => ({}))) as { error?: string; hasVideo?: boolean };
      if (!res.ok) throw new ApiError(res.status, j.error ?? 'error');
      setMsg({ ok: true, text: j.hasVideo ? 'ה-GIF נוסף לספרייה.' : 'ה-GIF נוסף לספרייה. בשרת אין ffmpeg, ולכן בווצאפ הוא יופיע כתמונה סטטית ובערוץ הרשמי לא יישלח.' });
      setTitle(''); setKeywords(''); setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await reload();
    } catch (er) { setMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); }
    setBusy(false);
  }

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); await reload(); } catch (er) { setMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); }
  }

  return (
    <section className="card" aria-labelledby="gifs-h">
      <h2 id="gifs-h">ספריית GIF</h2>
      <p className="hint">נציגים שולחים GIF מהספרייה בלחיצה, דרך הכפתור "GIF" שליד תיבת ההודעה. כל קובץ נבדק לפי התוכן ונסרק באנטי-וירוס.
        עד {data ? data.max : 300} קבצים, כל אחד עד {data ? Math.round(data.maxBytes / 1024 / 1024) : 5}MB. העלו רק קבצים שמותר לכם להשתמש בהם (זכויות יוצרים).</p>
      {data && !data.enabled && <p className="error">שליחת קבצים כבויה בשרת (אין סורק אנטי-וירוס), ולכן אי אפשר להוסיף או לשלוח GIF.</p>}
      <form onSubmit={add} className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: '1 1 180px' }}><label htmlFor="gif-title">כותרת (משמשת גם כטקסט חלופי)</label>
          <input id="gif-title" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="field" style={{ flex: '1 1 180px' }}><label htmlFor="gif-kw">מילות חיפוש (לא חובה)</label>
          <input id="gif-kw" maxLength={300} value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="תודה, כל הכבוד, בטיחות" /></div>
        <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor="gif-file">קובץ GIF</label>
          <input id="gif-file" ref={fileRef} required type="file" accept="image/gif" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        <button className="primary" type="submit" disabled={busy || !file || !title.trim() || data?.enabled === false}>{busy ? 'מעלה וסורק…' : 'הוספה לספרייה'}</button>
      </form>
      <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>
      {data && data.gifs.length === 0 && <p>הספרייה ריקה.</p>}
      {data && data.gifs.length > 0 && (
        <ul className="gif-admin">
          {data.gifs.map((g) => (
            <li key={g.id} onMouseEnter={() => setHover(g.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(g.id)} onBlur={() => setHover(null)}>
              <GifThumb id={g.id} moving={hover === g.id && !still} />
              {edit?.id === g.id ? (
                <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('PATCH', `/gifs/${g.id}`, { title: edit.title, keywords: edit.keywords }); setEdit(null); }, 'נשמר.'); }}>
                  <label htmlFor={`ge-t-${g.id}`} className="sr-only">כותרת</label>
                  <input id={`ge-t-${g.id}`} required maxLength={80} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                  <label htmlFor={`ge-k-${g.id}`} className="sr-only">מילות חיפוש</label>
                  <input id={`ge-k-${g.id}`} maxLength={300} value={edit.keywords} onChange={(e) => setEdit({ ...edit, keywords: e.target.value })} placeholder="מילות חיפוש" />
                  <div className="row"><button className="primary" type="submit">שמירה</button><button type="button" onClick={() => setEdit(null)}>ביטול</button></div>
                </form>
              ) : (
                <>
                  <strong>{g.title}</strong>
                  {g.keywords && <small className="muted">{g.keywords}</small>}
                  <small className="muted">{Math.max(1, Math.round(g.size / 1024))}KB{g.hasVideo ? '' : ' · בלי גרסת וידאו'}</small>
                  <div className="row">
                    <button type="button" onClick={() => setEdit({ id: g.id, title: g.title, keywords: g.keywords })}>עריכה<span className="sr-only"> של {g.title}</span></button>
                    <button type="button" className="danger" onClick={() => setDel(g)}>מחיקה<span className="sr-only"> של {g.title}</span></button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!del} danger title="מחיקת GIF מהספרייה" message={`ה-GIF "${del?.title ?? ''}" יימחק מהספרייה. הודעות שכבר נשלחו לא ישתנו.`}
        confirmLabel="מחיקה" onCancel={() => setDel(null)}
        onConfirm={() => { const g = del; setDel(null); if (g) void run(() => api('DELETE', `/gifs/${g.id}`), 'נמחק.'); }} />
    </section>
  );
}
