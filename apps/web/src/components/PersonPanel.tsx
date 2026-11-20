import { useEffect, useState } from 'react';
import { api, ApiError, CHANNEL_NAMES, type ChannelKind, type RelatedConv } from '../api';
import { errText } from '../strings';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * The same person on other channels: linked conversations, suggestions from a phone or e-mail the customer typed (unverified,
 * so a person confirms), and linking by hand. Links never widen access: other conversations appear only if this user may open them.
 */
export function PersonPanel({ convId, contactRowId, related, onOpen, onChanged }: {
  convId: string; contactRowId: string; related: RelatedConv[]; onOpen: (id: string) => void; onChanged: () => void;
}) {
  const [sugs, setSugs] = useState<RelatedConv[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<RelatedConv[] | null>(null);
  const [ask, setAsk] = useState<{ kind: 'link' | 'unlink'; r: RelatedConv } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const loadSugs = () => api<RelatedConv[]>('GET', `/conversations/${convId}/link-suggestions`).then(setSugs).catch(() => setSugs([]));
  useEffect(() => { setFound(null); setQ(''); setMsg(null); void loadSugs(); }, [convId]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound(null); return; }
    const t = setTimeout(() => { void api<RelatedConv[]>('GET', `/contacts/search?q=${encodeURIComponent(q.trim())}&not=${convId}`).then(setFound).catch(() => setFound([])); }, 300);
    return () => clearTimeout(t);
  }, [q, convId]);

  const name = (r: RelatedConv) => `${r.contactName ?? 'ללא שם'} · ${CHANNEL_NAMES[r.channelType as ChannelKind] ?? r.channelType}${r.channelLabel && r.channelLabel !== r.channelType ? ` (${r.channelLabel})` : ''}`;
  async function run(kind: 'link' | 'unlink', r: RelatedConv) {
    setMsg(null);
    try {
      if (kind === 'link') await api('POST', `/contacts/${contactRowId}/link`, { with: r.contactRowId });
      else await api('POST', `/contacts/${r.contactRowId}/unlink`);
      setMsg({ ok: true, text: kind === 'link' ? `קושר: ${name(r)}.` : `הקישור בוטל: ${name(r)}.` });
      setQ(''); setFound(null); void loadSugs(); onChanged();
    } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
  }
  const linkedIds = new Set(related.map((r) => r.id));

  return (
    <section aria-labelledby="person-h">
      <h3 id="person-h">אותו אדם בערוצים אחרים</h3>
      {related.length === 0 ? <p className="hint">אין שיחות מקושרות.</p> : (
        <ul className="plain person-list">
          {related.map((r) => (
            <li key={r.id}>
              <button type="button" className="linkish" onClick={() => onOpen(r.id)}>{name(r)}</button>
              <span className="mchip">{r.reason === 'linked' ? 'קושר בידי הצוות' : 'אותו מספר ווצאפ'}</span>
              <small className="hint">{r.status === 'open' ? 'פתוחה' : 'סגורה'}{r.lastMessage ? ` · ${r.lastMessage.slice(0, 60)}` : ''}</small>
              {r.reason === 'linked' && <button type="button" className="small" onClick={() => setAsk({ kind: 'unlink', r })}>ביטול קישור<span className="sr-only"> של {name(r)}</span></button>}
            </li>
          ))}
        </ul>
      )}

      {sugs.length > 0 && (
        <div className="person-sugs">
          <p className="hint"><strong>ייתכן שזה אותו אדם.</strong> הלקוח הקליד את אותו {sugs.some((s) => s.reason === 'email') ? 'אימייל או טלפון' : 'טלפון'}. זה לא מאומת, לכן קשרו רק אם בטוח שזה אותו אדם.</p>
          <ul className="plain person-list">
            {sugs.map((r) => (
              <li key={r.id}>
                <span>{name(r)}</span>
                <span className="mchip">{r.reason === 'email' ? 'אותו אימייל' : 'אותו טלפון'}</span>
                <button type="button" className="small" onClick={() => setAsk({ kind: 'link', r })}>קישור<span className="sr-only"> עם {name(r)}</span></button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="person-manual">
        <summary>קישור ידני לאיש קשר אחר</summary>
        <label htmlFor={`ps-${convId}`}>חיפוש לפי שם, מספר או אימייל</label>
        <input id={`ps-${convId}`} type="search" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} aria-describedby={`psh-${convId}`} />
        <p id={`psh-${convId}`} className="hint">מוצגות רק שיחות שמותר לך לפתוח.</p>
        {found && (found.filter((r) => !linkedIds.has(r.id)).length === 0
          ? <p role="status">לא נמצאו אנשי קשר מתאימים.</p>
          : <ul className="plain person-list" aria-label="תוצאות חיפוש">
              {found.filter((r) => !linkedIds.has(r.id)).map((r) => (
                <li key={r.id}><span>{name(r)}</span><button type="button" className="small" onClick={() => setAsk({ kind: 'link', r })}>קישור<span className="sr-only"> עם {name(r)}</span></button></li>
              ))}
            </ul>)}
      </details>
      <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>

      <ConfirmDialog open={!!ask} title={ask?.kind === 'unlink' ? 'ביטול קישור' : 'קישור אנשי קשר'}
        message={ask?.kind === 'unlink'
          ? `השיחה "${ask ? name(ask.r) : ''}" לא תוצג יותר כאותו אדם.`
          : `"${ask ? name(ask.r) : ''}" יוצג כאותו אדם כמו הלקוח בשיחה הזו. מי שרשאי לפתוח את שתי השיחות יראה אותן יחד. קשרו רק אם בטוח שזה אותו אדם, אפשר לבטל.`}
        confirmLabel={ask?.kind === 'unlink' ? 'ביטול הקישור' : 'קישור'} onCancel={() => setAsk(null)}
        onConfirm={() => { const a = ask; setAsk(null); if (a) void run(a.kind, a.r); }} />
    </section>
  );
}
