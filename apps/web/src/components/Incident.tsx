import { useState } from 'react';
import { api, ApiError, can, type Me } from '../api';
import { usePoll } from '../hooks';
import { errText } from '../strings';

/** A wide emergency ("אירוע חירום רחב"): the banner every staff screen shows while it is on, and the switch on the bot page. */
export interface IncidentState { active: boolean; text: string; textEn: string; textAr?: string; startedAt: string | null; answered?: number }

export function IncidentBanner({ me }: { me: Me }) {
  const [i, setI] = useState<IncidentState | null>(null);
  usePoll(async () => { setI(await api<IncidentState>('GET', '/incident').catch(() => null)); }, 30000);
  if (!i?.active) return null;
  const end = async () => {
    if (!confirm('לסיים את מצב אירוע החירום הרחב? בטי תפסיק לשלוח את הודעת המצב.')) return;
    setI(await api<IncidentState>('PUT', '/incident', { active: false, text: i.text, textEn: i.textEn, textAr: i.textAr ?? '' }).catch(() => i));
  };
  return (
    <div className="banner incident-banner" role="alert">
      <strong>🚨 אירוע חירום רחב פעיל</strong>
      {i.startedAt && <> מאז {new Date(i.startedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</>}
      {typeof i.answered === 'number' && <> · בטי שלחה את הודעת המצב ל-{i.answered} פונים</>}
      {can(me, 'bot.manage') && <> · <a href="#/bot?s=inc-h">עריכת ההודעה</a> · <button type="button" className="danger sm" onClick={() => void end()}>סיום האירוע</button></>}
    </div>
  );
}

export function IncidentControl({ canEdit }: { canEdit: boolean }) {
  const [i, setI] = useState<IncidentState | null>(null);
  const [text, setText] = useState('');
  const [textEn, setTextEn] = useState('');
  const [textAr, setTextAr] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  usePoll(async () => {
    const x = await api<IncidentState>('GET', '/incident').catch(() => null);
    if (x) { setI(x); if (!text) setText(x.text); if (!textEn) setTextEn(x.textEn); if (!textAr) setTextAr(x.textAr ?? ''); }
  }, 30000);
  if (!i) return null;
  const put = async (active: boolean) => {
    if (active && !i.active && !confirm('להפעיל מצב אירוע חירום רחב? כל מי שיכתוב יקבל את הודעת המצב, וכל הצוות יראה באנר.')) return;
    setMsg(null);
    try { const x = await api<IncidentState>('PUT', '/incident', { active, text, textEn, textAr }); setI(x); setMsg({ ok: true, text: active ? (i.active ? 'ההודעה עודכנה.' : 'מצב אירוע החירום הופעל.') : 'מצב אירוע החירום הסתיים.' }); }
    catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
  };
  return (
    <section className="card" aria-labelledby="inc-h">
      <h2 id="inc-h">אירוע חירום רחב</h2>
      <p className="hint">באירוע שמשפיע על הרבה אנשים בבת אחת (אזעקה, שריפה גדולה, פינוי): כל מי שכותב מקבל מבטי את הודעת המצב פעם אחת, והשיחה שלו מתויגת "אירוע חירום". כל הצוות רואה באנר עליון. חירום אישי (למשל פצוע) עדיין מטופל קודם. אפשר לעדכן את ההודעה תוך כדי האירוע.</p>
      <p role="status"><strong>{i.active ? `🚨 פעיל עכשיו${typeof i.answered === 'number' ? ` · נשלח ל-${i.answered} פונים` : ''}` : 'לא פעיל'}</strong></p>
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="field"><label htmlFor="inc-t">הודעת המצב</label><textarea id="inc-t" rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div className="field"><label htmlFor="inc-en">באנגלית (אופציונלי, ללקוחות שכותבים באנגלית)</label><textarea id="inc-en" dir="ltr" lang="en" rows={3} maxLength={1000} value={textEn} onChange={(e) => setTextEn(e.target.value)} /></div>
        <div className="field"><label htmlFor="inc-ar">בערבית (אופציונלי, ללקוחות שכותבים בערבית)</label><textarea id="inc-ar" dir="rtl" lang="ar" rows={3} maxLength={1000} value={textAr} onChange={(e) => setTextAr(e.target.value)} /></div>
        <p>
          {!i.active && <button type="button" className="danger" onClick={() => void put(true)} disabled={text.trim().length < 10}>🚨 הפעלת מצב אירוע חירום</button>}
          {i.active && <><button type="button" className="primary" onClick={() => void put(true)}>עדכון ההודעה</button> <button type="button" className="danger" onClick={() => void put(false)}>סיום האירוע</button></>}
        </p>
      </fieldset>
      <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
    </section>
  );
}
