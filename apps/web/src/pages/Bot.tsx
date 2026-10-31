import { useState, type FormEvent } from 'react';
import { api, ApiError, can, type Me } from '../api';
import { usePoll } from '../hooks';

interface BotCfg {
  enabled: boolean; welcome: string; items: { title: string; answer: string }[]; humanOption: boolean; humanLabel: string;
  humanKeywords: string[]; humanMessage: string; invalidMessage: string; invalidRetries: number; footer: string; preview?: string;
}

const menuText = (b: BotCfg) =>
  `${b.welcome}\n\n${[...b.items.map((it, i) => `${i + 1}. ${it.title}`), ...(b.humanOption ? [`0. ${b.humanLabel}`] : [])].join('\n')}`;

export function Bot({ me }: { me: Me }) {
  const canEdit = can(me, 'bot.manage');
  const [b, setB] = useState<BotCfg | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  usePoll(async () => { if (!b) setB(await api<BotCfg>('GET', '/settings/bot').catch(() => null)); }, 60000);
  if (!b) return <><h1 tabIndex={-1}>בוט</h1><p role="status">טוען…</p></>;

  const set = (patch: Partial<BotCfg>) => setB({ ...b, ...patch });
  const setItem = (i: number, patch: Partial<{ title: string; answer: string }>) => set({ items: b.items.map((it, k) => (k === i ? { ...it, ...patch } : it)) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= b.items.length) return;
    const items = [...b.items]; [items[i], items[j]] = [items[j]!, items[i]!]; set({ items });
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const { preview: _p, ...payload } = b!;
    try {
      setB(await api<BotCfg>('PUT', '/settings/bot', payload));
      setMsg({ ok: true, text: 'הבוט נשמר.' });
    } catch (er) {
      setMsg({ ok: false, text: er instanceof ApiError && er.code === 'bad_request' ? 'הנתונים אינם תקינים (בדקו שכל כותרת ותשובה מלאות, עד 9 פריטים).' : 'השמירה נכשלה.' });
    }
  }

  return (
    <>
      <h1 tabIndex={-1}>בוט תפריט</h1>
      {!canEdit && <p className="banner" role="note">צפייה בלבד. רק מנהל יכול לשנות את הבוט.</p>}
      <form className="card" onSubmit={save}>
        <p className="hint">הלקוח מקבל תפריט ממוספר ועונה במספר. אם אין התאמה, או שהוא מבקש נציג, השיחה עוברת לנציג (עם הודעה פנימית, שיוך אוטומטי אם הוגדר ניתוב, ו"מחוץ לשעות" אם הוגדרו שעות פעילות). אין שימוש בשירותי AI חיצוניים.</p>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="field">
            <label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={b.enabled} onChange={(e) => set({ enabled: e.target.checked })} />הפעלת הבוט</label>
          </div>
          <div className="field">
            <label htmlFor="b-welcome">הודעת פתיחה (מעל התפריט)</label>
            <textarea id="b-welcome" rows={2} maxLength={1000} required value={b.welcome} onChange={(e) => set({ welcome: e.target.value })} />
          </div>

          <h2>פריטי התפריט (עד 9)</h2>
          {b.items.map((it, i) => (
            <fieldset key={i} className="card" style={{ marginBottom: '.75rem' }}>
              <legend>פריט {i + 1}</legend>
              <div className="field">
                <label htmlFor={`bt${i}`}>כותרת (מוצגת בתפריט)</label>
                <input id={`bt${i}`} required maxLength={60} value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`ba${i}`}>תשובה</label>
                <textarea id={`ba${i}`} required rows={3} maxLength={1500} value={it.answer} onChange={(e) => setItem(i, { answer: e.target.value })} />
              </div>
              <div className="row">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0}>הזזה למעלה<span className="sr-only"> פריט {i + 1}</span></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === b.items.length - 1}>הזזה למטה<span className="sr-only"> פריט {i + 1}</span></button>
                <button type="button" className="danger" onClick={() => set({ items: b.items.filter((_, k) => k !== i) })}>מחיקה<span className="sr-only"> פריט {i + 1}</span></button>
              </div>
            </fieldset>
          ))}
          {b.items.length < 9 && <button type="button" onClick={() => set({ items: [...b.items, { title: '', answer: '' }] })}>הוספת פריט</button>}

          <h2 style={{ marginTop: '1.25rem' }}>מעבר לנציג</h2>
          <div className="field">
            <label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={b.humanOption} onChange={(e) => set({ humanOption: e.target.checked })} />להציג בתפריט את האפשרות "0" לנציג אנושי</label>
          </div>
          <div className="field">
            <label htmlFor="b-hl">שם האפשרות "0"</label>
            <input id="b-hl" required maxLength={40} value={b.humanLabel} onChange={(e) => set({ humanLabel: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="b-kw">מילים שמעבירות לנציג (מופרדות בפסיק)</label>
            <input id="b-kw" value={b.humanKeywords.join(', ')} aria-describedby="b-kw-h"
              onChange={(e) => set({ humanKeywords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10) })} />
            <p id="b-kw-h" className="hint">הודעה שמכילה אחת מהמילים (באותיות כלשהן) מעבירה לנציג, למשל "נציג, agent, human".</p>
          </div>
          <div className="field">
            <label htmlFor="b-hm">הודעה ללקוח בעת המעבר לנציג</label>
            <textarea id="b-hm" required rows={2} maxLength={500} value={b.humanMessage} onChange={(e) => set({ humanMessage: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="b-im">הודעה כשלא הובנה הבחירה</label>
            <input id="b-im" required maxLength={300} value={b.invalidMessage} onChange={(e) => set({ invalidMessage: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="b-ir">כמה פעמים להציג שוב את התפריט לפני מעבר לנציג</label>
            <select id="b-ir" value={b.invalidRetries} onChange={(e) => set({ invalidRetries: Number(e.target.value) })}>
              <option value={0}>0 – מעבר מיידי לנציג</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="b-ft">שורת תחתית אחרי כל תשובה (אופציונלי)</label>
            <input id="b-ft" maxLength={300} value={b.footer} onChange={(e) => set({ footer: e.target.value })} />
          </div>
        </fieldset>

        <section aria-labelledby="b-prev" className="card">
          <h2 id="b-prev">תצוגה מקדימה של התפריט שהלקוח יקבל</h2>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>{menuText(b)}</pre>
        </section>

        {canEdit && <button className="primary" type="submit">שמירה</button>}
        <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
      </form>
    </>
  );
}
