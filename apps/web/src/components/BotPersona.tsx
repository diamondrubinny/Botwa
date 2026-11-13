import { useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { botAvatarSrc, loadBrand, useBrand } from '../brand';
import { errText } from '../strings';

/**
 * The bot's identity: name, role line and picture, shown next to its messages in the website chat and in the inbox.
 * The word "בוט" is always added to the name: customers must be able to tell they are talking to software, not a person.
 */
export function BotPersona({ canEdit }: { canEdit: boolean }) {
  const brand = useBrand();
  const bot = brand.bot ?? { name: '', role: '', avatarV: 0 };
  const [name, setName] = useState(bot.name);
  const [role, setRole] = useState(bot.role);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      const r = (await fn()) as { name?: string; role?: string } | undefined;
      await loadBrand();
      if (r && typeof r.name === 'string') { setName(r.name); setRole(r.role ?? ''); }
      setMsg({ ok: true, text: ok });
    } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
  };
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append('file', f);
    const res = await fetch('/branding/bot/avatar', { method: 'POST', credentials: 'same-origin', body: fd });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, j.error ?? 'error');
    return j;
  };
  const src = botAvatarSrc(brand);
  return (
    <section className="card" aria-labelledby="persona-h">
      <h2 id="persona-h">הזהות של הבוט</h2>
      <p className="hint">השם והתמונה מוצגים ליד תשובות הבוט בצ׳אט באתר ובתיבת השיחות. לשם מתווסף תמיד "(בוט)", כדי שלקוחות ידעו שהם מדברים עם מערכת ולא עם אדם. גילוי כזה נדרש בחלק מהמדינות (למשל ב-EU AI Act) ודורש בדיקה משפטית.</p>
      <div className="persona-row">
        <div className="persona-face">{src ? <img src={src} alt={`התמונה של ${name || 'הבוט'}`} width={96} height={96} /> : <span aria-hidden="true">🤖</span>}</div>
        <div className="persona-preview" aria-label="תצוגה מקדימה">
          <strong>{name ? `${name} (בוט)` : 'בוט'}</strong>
          {role && <small>{role}</small>}
        </div>
      </div>
      {canEdit && (
        <>
          <div className="row" style={{ marginBlock: '.6rem' }}>
            <button type="button" className="primary" onClick={() => void run(() => api('POST', '/branding/bot/preset', { preset: 'betty' }), 'בטי של יחידת הבטיחות הוגדרה כזהות הבוט.')}>בטי, הבוט של יחידת הבטיחות</button>
          </div>
          <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void run(() => api('PUT', '/branding/bot', { name, role }), 'נשמר.'); }}>
            <div className="field" style={{ flex: '1 1 160px' }}><label htmlFor="bp-name">שם הבוט</label><input id="bp-name" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} placeholder="למשל: בטי" /></div>
            <div className="field" style={{ flex: '2 1 220px' }}><label htmlFor="bp-role">שורת תפקיד</label><input id="bp-role" maxLength={60} value={role} onChange={(e) => setRole(e.target.value)} placeholder="למשל: הבוט של יחידת הבטיחות" /></div>
            <button type="submit">שמירת שם ותפקיד</button>
          </form>
          <div className="row" style={{ marginTop: '.6rem' }}>
            <button type="button" onClick={() => file.current?.click()}>החלפת תמונה (PNG או JPEG, עד 512KB)</button>
            <input id="bp-file" ref={file} type="file" accept="image/png,image/jpeg" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(() => upload(f), 'התמונה עודכנה.'); if (file.current) file.current.value = ''; }} />
            {src && <button type="button" className="danger" onClick={() => void run(() => api('DELETE', '/branding/bot/avatar'), 'התמונה הוסרה.')}>הסרת התמונה</button>}
          </div>
          <p className="hint">השתמשו רק בתמונה שמותר לכם להשתמש בה. אם זו תמונה של אדם אמיתי, נדרשת הסכמתו.</p>
        </>
      )}
      <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>
    </section>
  );
}
