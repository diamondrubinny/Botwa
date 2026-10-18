import QRCode from 'qrcode';
import { useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../api';
import { errText } from '../strings';

export function Account({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [mfaMsg, setMfaMsg] = useState('');

  async function changePw(e: FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    try {
      await api('POST', '/auth/password', { current: cur, next });
      setCur(''); setNext('');
      setPwMsg({ ok: true, text: 'הסיסמה עודכנה.' });
    } catch (err) {
      setPwMsg({ ok: false, text: errText(err instanceof ApiError ? err.code : 'generic') });
    }
  }

  async function startSetup() {
    setMfaMsg('');
    try {
      const r = await api<{ secret: string; otpauthUrl: string }>('POST', '/auth/mfa/setup');
      setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 2, width: 240 }) });
    } catch (err) {
      setMfaMsg(errText(err instanceof ApiError ? err.code : 'generic'));
    }
  }

  async function enable(e: FormEvent) {
    e.preventDefault();
    try {
      await api('POST', '/auth/mfa/enable', { code });
      setSetup(null); setCode('');
      onChanged();
    } catch (err) {
      setMfaMsg(errText(err instanceof ApiError ? err.code : 'generic'));
    }
  }

  return (
    <>
      <h1 tabIndex={-1}>החשבון שלי</h1>
      <p>{me.name} · {me.email}</p>

      <section className="card" aria-labelledby="mfa-h">
        <h2 id="mfa-h">אימות דו-שלבי (MFA)</h2>
        {me.mfaEnabled ? (
          <p className="ok">אימות דו-שלבי פעיל.</p>
        ) : setup ? (
          <form onSubmit={enable}>
            <p>סרקו את הקוד באפליקציית אימות (למשל Google Authenticator), או הזינו את המפתח ידנית:</p>
            <img src={setup.qr} alt="קוד QR להגדרת אפליקציית האימות" width={240} height={240} style={{ background: '#fff', padding: 8 }} />
            <p dir="ltr"><code>{setup.secret}</code></p>
            <div className="field">
              <label htmlFor="mfa-code">קוד מהאפליקציה</label>
              <input id="mfa-code" inputMode="numeric" maxLength={6} pattern="\d{6}" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" />
            </div>
            <button className="primary" type="submit">הפעלה</button>
          </form>
        ) : (
          <button className="primary" onClick={startSetup}>הגדרת אימות דו-שלבי</button>
        )}
        <p role="alert" className="error">{mfaMsg}</p>
      </section>

      <section className="card" aria-labelledby="pw-h">
        <h2 id="pw-h">שינוי סיסמה</h2>
        <form onSubmit={changePw}>
          <div className="field">
            <label htmlFor="cur">סיסמה נוכחית</label>
            <input id="cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} dir="ltr" />
          </div>
          <div className="field">
            <label htmlFor="next">סיסמה חדשה</label>
            <input id="next" type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} dir="ltr" aria-describedby="next-h" />
            <p id="next-h" className="hint">לפחות 12 תווים. שינוי הסיסמה מנתק מכשירים אחרים.</p>
          </div>
          <button className="primary" type="submit">{'עדכון סיסמה'}</button>
          <p role="status" className={pwMsg?.ok ? 'ok' : 'error'}>{pwMsg?.text}</p>
        </form>
      </section>
    </>
  );
}
