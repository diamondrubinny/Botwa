import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { logoSrc, useBrand } from '../brand';
import { Icon } from '../components/Icon';
import { ThemeMenu } from '../components/ThemeMenu';
import { errText, t } from '../strings';

export function Login({ onDone }: { onDone: () => void }) {
  const brand = useBrand();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needMfa, setNeedMfa] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // "stay signed in on this device": remembered in this browser; on by default so the panel does not sign people out while they work
  const [remember, setRemember] = useState(() => { try { return localStorage.getItem('botwa_remember') !== '0'; } catch { return true; } });
  const rememberChoice = (v: boolean) => { setRemember(v); try { localStorage.setItem('botwa_remember', v ? '1' : '0'); } catch { /* storage unavailable */ } };
  const passkeys = browserSupportsWebAuthn();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('POST', '/auth/login', { email, password, remember, ...(needMfa && totp ? { totp } : {}) });
      onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'generic';
      if (code === 'mfa_required') setNeedMfa(true);
      setError(errText(code));
    } finally {
      setBusy(false);
    }
  }

  async function withPasskey() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('POST', '/auth/passkeys/login/options');
      const response = await startAuthentication({ optionsJSON: options });
      await api('POST', '/auth/passkeys/login/verify', { challengeId, response, remember });
      onDone();
    } catch (err) {
      // user cancelled the browser prompt => stay quiet; real failures get the generic message
      const cancelled = err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      if (!cancelled) setError(err instanceof ApiError ? errText(err.code) : 'לא הצלחנו להיכנס עם Passkey. נסו שוב או היכנסו עם סיסמה.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div style={{ position: 'fixed', top: '.6rem', insetInlineStart: '.6rem' }}><ThemeMenu align="start" /></div>
      <main className="login" id="main">
        <div className="brand">{brand.hasLogo ? <img className="brand-logo" src={logoSrc(brand)} alt="" /> : <span className="brand-mark"><Icon name="chat" /></span>}<h1 tabIndex={-1}>{brand.appName === 'Botwa' ? t.appName : brand.appName}</h1></div>
        <form className="card" onSubmit={submit} noValidate>
          {passkeys && (
            <>
              <button type="button" className="primary" style={{ width: '100%' }} onClick={withPasskey} disabled={busy}><Icon name="key" size={20} />כניסה עם Passkey</button>
              <div className="divider" aria-hidden="true">או עם סיסמה</div>
            </>
          )}
          <div className="field">
            <label htmlFor="email">אימייל</label>
            <input id="email" type="email" autoComplete="username webauthn" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
          </div>
          <div className="field">
            <label htmlFor="pw">סיסמה</label>
            <input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
          </div>
          {needMfa && (
            <div className="field">
              <label htmlFor="totp">קוד אימות (6 ספרות)</label>
              <input id="totp" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" autoFocus value={totp} onChange={(e) => setTotp(e.target.value)} dir="ltr" aria-describedby="totp-hint" />
              <p id="totp-hint" className="hint">מתוך אפליקציית האימות שלכם.</p>
            </div>
          )}
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={remember} onChange={(e) => rememberChoice(e.target.checked)} aria-describedby="rem-h" /> להישאר מחובר במכשיר הזה</label>
            <p id="rem-h" className="hint">עד 30 יום, וממשיך כל עוד משתמשים במערכת. במחשב משותף כדאי לבטל.</p></div>
          <p role="alert" className="error">{error}</p>
          <button className={passkeys ? '' : 'primary'} style={{ width: '100%' }} type="submit" disabled={busy}>{busy ? t.loading : 'התחברות'}</button>
        </form>
      </main>
    </div>
  );
}
