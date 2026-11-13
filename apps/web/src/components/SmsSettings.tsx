import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { errText } from '../strings';

interface Sms { enabled: boolean; provider: 'twilio'; accountSid: string; from: string; monthlyLimit: number; hasSecret: boolean; usedThisMonth: number; recent: { to: string; purpose: string; segments: number; status: string; error: string | null; at: string }[] }
const PURPOSE: Record<string, string> = { otp: 'קוד אימות', reminder: 'תזכורת', test: 'בדיקה' };

/** SMS (outbound only): the form's one-time code when it does not reach the chat, and reminders to people WhatsApp cannot reach. */
export function SmsSettings() {
  const [s, setS] = useState<Sms | null>(null);
  const [secret, setSecret] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { void api<Sms>('GET', '/settings/sms').then(setS).catch(() => undefined); }, []);
  if (!s) return null;
  const fail = (e: unknown) => setMsg({ ok: false, text: `${errText(e instanceof ApiError ? e.code : 'generic')}${e instanceof ApiError && e.detail ? ` (${e.detail})` : ''}` });
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const { enabled, provider, accountSid, from, monthlyLimit } = s!;
      setS(await api<Sms>('PUT', '/settings/sms', { enabled, provider, accountSid, from, monthlyLimit, ...(secret ? { secret } : {}) }));
      setSecret(''); setMsg({ ok: true, text: 'נשמר.' });
    } catch (er) { fail(er); }
    setBusy(false);
  }
  async function test() {
    setBusy(true); setMsg(null);
    try { await api('POST', '/settings/sms/test', { to }); setMsg({ ok: true, text: 'נשלחה הודעת בדיקה.' }); setS(await api<Sms>('GET', '/settings/sms')); } catch (er) { fail(er); }
    setBusy(false);
  }
  return (
    <form className="card" onSubmit={save} aria-labelledby="sms-h">
      <h2 id="sms-h">SMS (יוצא בלבד)</h2>
      <p className="hint">SMS משמש לשני דברים בלבד: קוד האימות של טופס, כשהוא לא מגיע לצ׳אט (נשלח לאותו מספר ווצאפ), ותזכורות לטפסים למי שלא ניתן להגיע אליו בווצאפ. אין קבלת SMS ואין דיוור. מי שביקש להפסיק לקבל הודעות לא יקבל תזכורות. כל הודעה עולה כסף אצל הספק.</p>
      <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" role="switch" style={{ width: 'auto', minHeight: 'auto' }} checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> SMS פעיל</label>
      <div className="row">
        <div className="field"><label htmlFor="sms-sid">Account SID (Twilio)</label><input id="sms-sid" dir="ltr" autoComplete="off" spellCheck={false} placeholder="AC…" value={s.accountSid} onChange={(e) => setS({ ...s, accountSid: e.target.value.trim() })} /></div>
        <div className="field"><label htmlFor="sms-sec">Auth token {s.hasSecret ? '(שמור. להחלפה הקלידו חדש)' : ''}</label><input id="sms-sec" type="password" dir="ltr" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value.trim())} /></div>
      </div>
      <div className="row">
        <div className="field"><label htmlFor="sms-from">שולח</label><input id="sms-from" dir="ltr" maxLength={34} placeholder="+972… או Technion" aria-describedby="sms-from-h" value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} />
          <p id="sms-from-h" className="hint">מספר בפורמט בינלאומי, שם שולח באנגלית (עד 11 תווים), או Messaging Service SID. מה מותר בישראל: לפי הספק (דורש אימות מולו).</p></div>
        <div className="field"><label htmlFor="sms-lim">מגבלה חודשית (חלקי הודעה; 0 = בלי מגבלה)</label><input id="sms-lim" type="number" min={0} max={100000} style={{ maxWidth: 140 }} value={s.monthlyLimit} onChange={(e) => setS({ ...s, monthlyLimit: Math.max(0, Math.round(Number(e.target.value) || 0)) })} /></div>
      </div>
      <p className="hint">החודש נשלחו {s.usedThisMonth} חלקי הודעה{s.monthlyLimit ? ` מתוך ${s.monthlyLimit}` : ''}. הודעה בעברית: עד 70 תווים בחלק אחד, ומעבר לזה 67 לחלק.</p>
      <div className="row"><button className="primary" type="submit" disabled={busy}>שמירה</button></div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field"><label htmlFor="sms-to">שליחת בדיקה למספר</label><input id="sms-to" dir="ltr" inputMode="tel" placeholder="050-1234567" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button type="button" disabled={busy || !s.enabled || !to.trim()} onClick={() => void test()}>שליחת בדיקה</button>
      </div>
      {msg && <p role="status" className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      {s.recent.length > 0 && (
        <table>
          <caption>הודעות אחרונות (המספר מוסתר חלקית)</caption>
          <thead><tr><th scope="col">מתי</th><th scope="col">למי</th><th scope="col">סוג</th><th scope="col">חלקים</th><th scope="col">מצב</th></tr></thead>
          <tbody>{s.recent.map((r, i) => <tr key={i}><td>{new Date(r.at).toLocaleString('he-IL')}</td><td dir="ltr">{r.to}</td><td>{PURPOSE[r.purpose] ?? r.purpose}</td><td>{r.segments}</td><td>{r.status === 'failed' ? `נכשל${r.error ? ` (${r.error})` : ''}` : 'נשלח'}</td></tr>)}</tbody>
        </table>
      )}
    </form>
  );
}
