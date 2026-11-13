import { useEffect, useState } from 'react';
import { api, CHANNEL_NAMES, type ChannelKind } from '../api';

interface Case {
  id: string; number: number; conversationId: string; openedAt: string; closedAt: string | null; closeKind: 'staff' | 'auto' | 'other' | null;
  firstMessage: string | null; rating: number | null; closedByName: string | null; assignedName: string | null; channelLabel: string; channelType: string; messages: number;
}
interface Msg { id: string; direction: 'in' | 'out'; body: string; createdAt: string; auto: boolean; senderName: string | null }

const fmt = (d: string) => new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
const dur = (a: string, b: string | null) => {
  const m = Math.max(0, Math.round(((b ? new Date(b) : new Date()).getTime() - new Date(a).getTime()) / 60000));
  return m < 60 ? `${m} דק'` : m < 1440 ? `${Math.round(m / 60)} שע'` : `${Math.round(m / 1440)} ימים`;
};

/** Every inquiry this customer opened (this conversation and the same person's other channels), with a read-only look at each. */
export function CaseHistory({ convId, refresh }: { convId: string; refresh: number }) {
  const [cases, setCases] = useState<Case[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  useEffect(() => { setOpen(null); void api<Case[]>('GET', `/conversations/${convId}/cases`).then(setCases).catch(() => setCases([])); }, [convId, refresh]);
  useEffect(() => { setMsgs(null); if (open) void api<Msg[]>('GET', `/cases/${open}/messages`).then(setMsgs).catch(() => setMsgs([])); }, [open]);
  if (!cases) return null;
  const rated = cases.filter((c) => c.rating);
  return (
    <section aria-labelledby="cases-h">
      <h3 id="cases-h">היסטוריית פניות ({cases.length})</h3>
      {rated.length > 0 && <p className="hint">דירוג ממוצע: {(rated.reduce((s, c) => s + c.rating!, 0) / rated.length).toFixed(1)} מתוך 5 ({rated.length} דירוגים)</p>}
      {cases.length === 0 ? <p className="hint">אין פניות קודמות.</p> : (
        <ol className="plain case-list" reversed>
          {cases.map((c) => (
            <li key={c.id} className={c.closedAt ? '' : 'is-open'}>
              <button type="button" className="case-row" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
                <span className="case-num">#{c.number}</span>
                <span className="case-main">
                  <span className="case-first" dir="auto">{c.firstMessage ?? '(בלי טקסט)'}</span>
                  <small>{fmt(c.openedAt)} · {CHANNEL_NAMES[c.channelType as ChannelKind] ?? c.channelType}{c.channelLabel && c.channelLabel !== c.channelType ? ` (${c.channelLabel})` : ''} · {c.messages} הודעות</small>
                </span>
                <span className="case-meta">
                  <span className={`mchip ${c.closedAt ? '' : 'case-open'}`}>{!c.closedAt ? 'פתוחה' : c.closeKind === 'auto' ? 'נסגרה אוטומטית' : c.closedByName ? `נסגרה ע״י ${c.closedByName}` : 'נסגרה'}</span>
                  {c.closedAt && <small>משך: {dur(c.openedAt, c.closedAt)}</small>}
                  {c.rating && <span className="case-rating" aria-label={`דירוג ${c.rating} מתוך 5`}><span aria-hidden="true">{'★'.repeat(c.rating)}{'☆'.repeat(5 - c.rating)}</span></span>}
                </span>
              </button>
              {open === c.id && (
                <div className="case-msgs" role="region" aria-label={`ההודעות בפנייה ${c.number}`}>
                  {!msgs ? <p className="hint">טוען…</p> : msgs.length === 0 ? <p className="hint">ההודעות של הפנייה הזו כבר נמחקו לפי מדיניות השמירה.</p> : msgs.map((m) => (
                    <p key={m.id} className={`case-msg ${m.direction}`}>
                      <small>{m.direction === 'in' ? 'לקוח' : m.auto ? 'אוטומטי' : (m.senderName ?? 'צוות')} · {fmt(m.createdAt)}</small>
                      <span dir="auto">{m.body || '[קובץ מצורף]'}</span>
                    </p>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
