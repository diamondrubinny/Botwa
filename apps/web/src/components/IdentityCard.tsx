import { useEffect, useState } from 'react';
import { api } from '../api';

type Lang = 'he' | 'en' | 'ar' | 'ru';
interface Profile { fields: { key: string; label: string; value: string }[]; lang: Lang; langLocked?: boolean }
const LANG_NAME: Record<Lang, string> = { he: 'עברית', en: 'English', ar: 'العربية (ערבית)', ru: 'Русский (רוסית)' };

/**
 * What the customer told Betty when identifying, at the top of the conversation, and the conversation's language: detected
 * automatically, or set here by a person when the detection got it wrong (Betty answers in it from the next message).
 */
export function IdentityCard({ convId, refresh }: { convId: string; refresh?: unknown }) {
  const [p, setP] = useState<Profile | null>(null);
  const [msg, setMsg] = useState('');
  const load = () => api<Profile>('GET', `/conversations/${convId}/profile`).then(setP).catch(() => setP(null));
  useEffect(() => {
    let live = true;
    setMsg('');
    api<Profile>('GET', `/conversations/${convId}/profile`).then((x) => { if (live) setP(x); }).catch(() => { if (live) setP(null); });
    return () => { live = false; };
  }, [convId, refresh]);
  if (!p) return null;
  const choice = p.langLocked ? p.lang : 'auto';
  return (
    <section className="identity-card" aria-labelledby={`idc-${convId}`}>
      <h3 id={`idc-${convId}`} className="sr-only">פרטי הפונה</h3>
      <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '.25rem .9rem', margin: 0, padding: '.4rem .75rem', fontSize: '.9rem', alignItems: 'center' }}>
        {p.fields.map((f) => (
          <div key={f.key} style={{ display: 'flex', gap: '.3rem', minWidth: 0 }}>
            <dt style={{ fontWeight: 600 }}>{f.label}:</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere', unicodeBidi: 'isolate' }}>{f.value}</dd>
          </div>
        ))}
        <div style={{ display: 'flex', gap: '.3rem', alignItems: 'center' }}>
          <dt style={{ fontWeight: 600 }}><label htmlFor={`idc-lang-${convId}`}>שפת השיחה:</label></dt>
          <dd style={{ margin: 0 }}>
            <select id={`idc-lang-${convId}`} value={choice} aria-describedby={`idc-lang-h-${convId}`} style={{ width: 'auto', minHeight: 'auto', padding: '.1rem .4rem' }}
              onChange={async (e) => {
                const lang = e.target.value as Lang | 'auto';
                try { await api('POST', `/conversations/${convId}/lang`, { lang }); setMsg(lang === 'auto' ? 'השפה תזוהה שוב לפי מה שהלקוח כותב.' : `בטי תענה ב${lang === 'he' ? 'עברית' : lang === 'en' ? 'אנגלית' : lang === 'ar' ? 'ערבית' : 'רוסית'} מההודעה הבאה.`); await load(); }
                catch { setMsg('השינוי לא נשמר.'); }
              }}>
              <option value="auto">אוטומטית ({LANG_NAME[p.lang]})</option>
              {(['he', 'en', 'ar', 'ru'] as const).map((l) => <option key={l} value={l}>{LANG_NAME[l]} (קבוע)</option>)}
            </select>
            <span id={`idc-lang-h-${convId}`} className="sr-only">השפה שבה בטי עונה ללקוח. שפה קבועה לא משתנה לפי מה שהלקוח כותב.</span>
          </dd>
        </div>
      </dl>
      {msg && <p role="status" className="hint" style={{ margin: '0 .75rem .3rem' }}>{msg}</p>}
    </section>
  );
}
