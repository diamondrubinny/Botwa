import { useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../api';
import { errText } from '../strings';

/** How I am introduced to a customer when I take an inquiry: my role and an optional work phone (both mine to fill or leave). */
export function IntroCard({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [title, setTitle] = useState(me.jobTitle ?? '');
  const [phone, setPhone] = useState(me.introPhone ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const phoneOk = !phone.trim() || /^\+?[0-9][0-9 -]{5,18}[0-9]$/.test(phone.trim());
  const preview = `שלום, כאן ${me.name}${title.trim() ? `, ${title.trim()}` : ''}. אני אטפל בפנייתך מעכשיו ואחזור אליך בהקדם.`;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!phoneOk) return;
    setBusy(true); setMsg(null);
    try { await api('PUT', '/auth/me/intro', { jobTitle: title.trim() || null, introPhone: phone.trim() || null }); setMsg({ ok: true, text: 'נשמר.' }); onChanged(); }
    catch (er) { setMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); }
    finally { setBusy(false); }
  }

  return (
    <section className="card" aria-labelledby="intro-h">
      <h2 id="intro-h">איך אני מוצג/ת ללקוחות</h2>
      <p className="hint">כשפנייה עוברת אליך, הלקוח מקבל הודעה שמציגה אותך. השם נלקח מהחשבון. התפקיד והטלפון לא חובה, ויופיעו רק אם תמלאו אותם.</p>
      <form onSubmit={save}>
        <div className="field"><label htmlFor="intro-title">תפקיד (למשל: ממונת בטיחות, הפקולטה לכימיה)</label>
          <input id="intro-title" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="organization-title" /></div>
        <div className="field"><label htmlFor="intro-phone">טלפון עבודה להצגה (לא חובה)</label>
          <input id="intro-phone" type="tel" inputMode="tel" dir="ltr" maxLength={20} value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!phoneOk} aria-describedby="intro-phone-h" />
          <p id="intro-phone-h" className={phoneOk ? 'hint' : 'error'}>{phoneOk ? 'מוצג רק בהודעות שמשתמשות ב-{טלפון נציג}. אל תמלאו טלפון פרטי.' : 'מספר טלפון לא תקין (ספרות, רווחים, מקפים, ואפשר + בהתחלה).'}</p></div>
        <p className="intro-preview" aria-live="polite"><span className="sr-only">תצוגה מקדימה: </span>{preview}</p>
        <button className="primary" type="submit" disabled={busy || !phoneOk}>שמירה</button>
        {msg && <p role="status" className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      </form>
    </section>
  );
}
