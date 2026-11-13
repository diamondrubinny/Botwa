import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { errText } from '../strings';

interface Status { configured: boolean; reachable: boolean; model: string; installed: boolean }

/** How knowledge-base answers are worded: the passage itself (no AI) or a local model on this server, from the passages only. */
export function AnswerMode({ mode, onChange, canEdit }: { mode: 'quote' | 'local'; onChange: (m: 'quote' | 'local') => void; canEdit: boolean }) {
  const [st, setSt] = useState<Status | null>(null);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ found: boolean; answer: string | null; usedModel?: boolean; ms?: number; source?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { void api<Status>('GET', '/settings/bot/llm').then(setSt).catch(() => undefined); }, []);
  const ready = !!st?.configured && st.reachable && st.installed;
  async function test() {
    setBusy(true); setErr(''); setRes(null);
    try { setRes(await api('POST', '/settings/bot/llm-test', { question: q, mode })); } catch (e) { setErr(errText(e instanceof ApiError ? e.code : 'generic')); }
    setBusy(false);
  }
  return (
    <div className="field answer-mode">
      <fieldset>
        <legend>אופן הניסוח של התשובה</legend>
        <label><input type="radio" name="answer-mode" checked={mode === 'quote'} disabled={!canEdit} onChange={() => onChange('quote')} /> ציטוט מהמאגר, בלי בינה מלאכותית</label>
        <p className="hint">הקטע הרלוונטי עצמו, עם פתיח, מקור ושורת סיום. מדויק ומהיר.</p>
        <label><input type="radio" name="answer-mode" checked={mode === 'local'} disabled={!canEdit} onChange={() => onChange('local')} /> מודל שפה מקומי בשרת (ניסוח טבעי)</label>
        <p className="hint">מודל שרץ על השרת שלכם מנסח תשובה בטון נעים ומקצועי, <strong>רק</strong> מתוך הקטעים שנמצאו במאגר. שום מידע לא נשלח החוצה. אם המודל לא בטוח, או מזכיר מספר או קישור שלא מופיע בקטעים, נשלח במקומו הציטוט. המקור והערת החקיקה מצורפים תמיד.</p>
        <p className={ready ? 'ok' : 'hint'} role="status">
          {!st ? 'בודק את המודל המקומי…'
            : !st.configured ? 'מודל מקומי לא הוגדר בשרת (LOCAL_LLM_URL). עד שיוגדר, נשלח ציטוט. הוראות התקנה: docs/LOCAL_LLM.he.md'
            : !st.reachable ? 'המודל המקומי מוגדר אבל לא עונה. בדקו ששירות Ollama פועל.'
            : !st.installed ? `השירות פועל, אבל המודל ${st.model} לא מותקן. הריצו: ollama pull ${st.model}`
            : `המודל המקומי ${st.model} מוכן.`}
        </p>
      </fieldset>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: '1 1 260px' }}><label htmlFor="am-q">בדיקה: שאלה לדוגמה</label><input id="am-q" value={q} maxLength={500} onChange={(e) => setQ(e.target.value)} placeholder="למשל: האם צריך הדרכה לעבודה בגובה?" /></div>
        <button type="button" onClick={() => void test()} disabled={busy || q.trim().length < 3}>{busy ? 'מנסח…' : 'איך הבוט יענה?'}</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {res && (
        <div role="status" className="answer-preview">
          {!res.found ? <p>אין במאגר תשובה בטוחה לשאלה הזו, ולכן הבוט לא יענה עליה. הוא יציג תפריט או יעביר לנציג.</p> : <>
            <p className="hint">{res.usedModel ? `נוסח בידי המודל המקומי (${Math.round((res.ms ?? 0) / 100) / 10} שניות)` : mode === 'local' ? 'המודל לא היה זמין או לא היה בטוח, ולכן יישלח ציטוט:' : 'ציטוט מהמאגר:'} · מקור: {res.source}</p>
            <p className="answer-text" dir="auto">{res.answer}</p>
          </>}
        </div>
      )}
    </div>
  );
}
