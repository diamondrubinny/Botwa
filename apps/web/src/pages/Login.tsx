import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { errText, t } from '../strings';

export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needMfa, setNeedMfa] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('POST', '/auth/login', { email, password, ...(needMfa && totp ? { totp } : {}) });
      onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'generic';
      if (code === 'mfa_required') setNeedMfa(true);
      setError(errText(code));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login" id="main">
      <h1 tabIndex={-1}>{t.appName}</h1>
      <form className="card" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="email">אימייל</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
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
        <p role="alert" className="error">{error}</p>
        <button className="primary" type="submit" disabled={busy}>{busy ? t.loading : 'התחברות'}</button>
      </form>
    </main>
  );
}
