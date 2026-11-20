import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

/**
 * Help from the local model on the server (nothing leaves it): a draft reply from the knowledge base, and a summary of the
 * conversation. Both are drafts: the reply goes into the composer for the agent to edit; the summary can be saved as an internal
 * note or used in the hand-over note. Shown only when the local model is ready.
 */
const ERR: Record<string, string> = {
  no_answer: 'לא נמצאה במאגר הידע תשובה בטוחה לשאלה הזו. אפשר לכתוב תשובה בעצמכם.',
  no_question: 'אין שאלה חדשה של הלקוח שמחכה לתשובה.',
  no_kb: 'מאגר הידע לא זמין.',
  too_short: 'השיחה קצרה מדי לסיכום.',
  summary_failed: 'הסיכום לא הצליח או לא נראה אמין. נסו שוב.',
  assist_unavailable: 'המודל המקומי לא זמין כרגע.',
  rate_limited: 'יותר מדי בקשות בדקה. נסו שוב בעוד רגע.',
  request_timeout: 'המודל לא הספיק לענות. נסו שוב.',
};
const errText = (e: unknown) => ERR[e instanceof ApiError ? e.code : ''] ?? 'הפעולה נכשלה. נסו שוב.';

export function AssistBar({ convId, draft, onDraft, onSummary }: { convId: string; draft: string; onDraft: (text: string) => void; onSummary?: (text: string) => void }) {
  const [busy, setBusy] = useState<'reply' | 'summary' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  useEffect(() => { setMsg(null); setSummary(null); }, [convId]);
  const suggest = async () => {
    setBusy('reply'); setMsg(null);
    try {
      const r = await api<{ draft: string; source: { title: string } }>('POST', `/conversations/${convId}/suggest-reply`);
      onDraft(draft.trim() ? `${draft.trim()}\n${r.draft}` : r.draft);
      setMsg({ ok: true, text: `טיוטה מתוך "${r.source.title}" נוספה לתיבת הכתיבה. עברו עליה לפני השליחה.` });
    } catch (e) { setMsg({ ok: false, text: errText(e) }); }
    finally { setBusy(null); }
  };
  const summarize = async () => {
    setBusy('summary'); setMsg(null);
    try { setSummary((await api<{ summary: string }>('POST', `/conversations/${convId}/summary`)).summary); }
    catch (e) { setMsg({ ok: false, text: errText(e) }); }
    finally { setBusy(null); }
  };
  return (
    <div className="assist-bar">
      <div className="row" style={{ gap: '.4rem', flexWrap: 'wrap' }}>
        <button type="button" className="sm" disabled={!!busy} aria-busy={busy === 'reply'} onClick={() => void suggest()}>{busy === 'reply' ? 'מנסח…' : '✨ הצעת תשובה'}</button>
        <button type="button" className="sm" disabled={!!busy} aria-busy={busy === 'summary'} onClick={() => void summarize()}>{busy === 'summary' ? 'מסכם…' : '📝 סיכום שיחה'}</button>
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'hint' : 'mt-warn'}>{msg.text}</p>}
      {summary !== null && (
        <div className="assist-summary" role="group" aria-labelledby={`as-l-${convId}`}>
          <label id={`as-l-${convId}`} htmlFor={`as-${convId}`}>סיכום אוטומטי (אפשר לערוך, עשוי להכיל טעויות)</label>
          <textarea id={`as-${convId}`} rows={4} maxLength={2000} value={summary} onChange={(e) => setSummary(e.target.value)} />
          <div className="row" style={{ gap: '.4rem', flexWrap: 'wrap' }}>
            <button type="button" className="primary sm" disabled={!summary.trim()} onClick={async () => {
              try { await api('POST', `/conversations/${convId}/notes`, { body: `📝 סיכום שיחה:\n${summary.trim()}` }); setSummary(null); setMsg({ ok: true, text: 'הסיכום נשמר כהערה פנימית.' }); }
              catch (e) { setMsg({ ok: false, text: errText(e) }); }
            }}>שמירה כהערה פנימית</button>
            {onSummary && <button type="button" className="sm" disabled={!summary.trim()} onClick={() => { onSummary(summary.trim()); setSummary(null); }}>להעברה לעמית…</button>}
            <button type="button" className="sm" onClick={() => setSummary(null)}>סגירה</button>
          </div>
        </div>
      )}
    </div>
  );
}
