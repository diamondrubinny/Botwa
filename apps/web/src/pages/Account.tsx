import { PageTitle } from '../components/Illustration';
import QRCode from 'qrcode';
import { useState, type FormEvent } from 'react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, ApiError, type Me, type PasskeyRow } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { AvatarEditor } from '../components/Avatar';
import { InstallApp } from '../components/InstallApp';
import { NotificationsCard } from '../components/NotificationsCard';
import { ThemeMenu } from '../components/ThemeMenu';
import { usePoll } from '../hooks';
import { errText } from '../strings';

export function Account({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [mfaMsg, setMfaMsg] = useState('');
  const [pks, setPks] = useState<PasskeyRow[]>([]);
  const [pkName, setPkName] = useState('');
  const [pkMsg, setPkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [delPk, setDelPk] = useState<PasskeyRow | null>(null);
  const loadPks = async () => setPks(await api<PasskeyRow[]>('GET', '/auth/passkeys').catch(() => []));
  usePoll(loadPks, 60000);
  const supported = browserSupportsWebAuthn();

  async function addPasskey() {
    setPkMsg(null);
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('POST', '/auth/passkeys/register/options');
      const response = await startRegistration({ optionsJSON: options });
      await api('POST', '/auth/passkeys/register/verify', { challengeId, response, name: pkName.trim() || undefined });
      setPkName('');
      setPkMsg({ ok: true, text: 'ה-Passkey נוסף.' });
      await loadPks();
      onChanged();
    } catch (err) {
      const cancelled = err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      if (!cancelled) setPkMsg({ ok: false, text: err instanceof ApiError ? errText(err.code) : 'ההוספה נכשלה. ודאו שהמכשיר תומך ב-Passkey ושה-HTTPS פעיל.' });
    }
  }

  async function changePw(e: FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    try {
      await api('POST', '/auth/password', { current: cur, next });
      setCur(''); setNext('');
      setPwMsg({ ok: true, text: 'הסיסמה עודכנה.' });
      onChanged();
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
      <PageTitle art="team" title="החשבון שלי" />
      <p>{me.name} · {me.email} · {me.roleName}{me.username ? <> · שם משתמש: <bdi dir="ltr">@{me.username}</bdi></> : null}</p>
      <section className="card" aria-labelledby="av-h">
        <h2 id="av-h">תמונת פרופיל</h2>
        <p className="hint">מוצגת לצוות בלבד (לא ללקוחות). התמונה נחתכת לריבוע ומוקטנת בדפדפן, ופרטי מיקום ומצלמה מוסרים לפני השמירה.</p>
        <AvatarEditor userId={me.id} name={me.name} v={me.avatarV} uploadUrl="/me/avatar" onChanged={onChanged} />
      </section>
      <InstallApp />
      <NotificationsCard />

      <section className="card" aria-labelledby="pk-h">
        <h2 id="pk-h"><Icon name="key" size={20} /> Passkey (כניסה בטביעת אצבע / זיהוי פנים / נעילת מכשיר)</h2>
        <p className="hint">Passkey מחליף סיסמה, עמיד בפני הונאות דיוג, ונחשב גם כאימות דו-שלבי. אפשר לרשום כמה מכשירים.</p>
        {pks.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {pks.map((k) => (
              <li key={k.id} className="row" style={{ borderBottom: '1px solid var(--border)', padding: '.5rem 0' }}>
                <strong>{k.name}</strong>
                <small className="hint">נוסף {new Date(k.createdAt).toLocaleDateString('he-IL')}{k.lastUsedAt ? ` · שימוש אחרון ${new Date(k.lastUsedAt).toLocaleDateString('he-IL')}` : ''}{k.backedUp ? ' · מסונכרן בענן' : ''}</small>
                <span className="spacer" />
                <button className="danger" onClick={() => setDelPk(k)}>הסרה<span className="sr-only"> {k.name}</span></button>
              </li>
            ))}
          </ul>
        )}
        {supported ? (
          <div className="row">
            <div style={{ flex: 1, minWidth: 180 }}>
              <label htmlFor="pk-name" className="sr-only">שם למכשיר</label>
              <input id="pk-name" maxLength={60} placeholder="שם למכשיר (למשל: הטלפון שלי)" value={pkName} onChange={(e) => setPkName(e.target.value)} />
            </div>
            <button className="primary" onClick={addPasskey}><Icon name="plus" size={18} />הוספת Passkey</button>
          </div>
        ) : <p className="error">הדפדפן או המכשיר אינם תומכים ב-Passkey.</p>}
        <p role="status" className={pkMsg?.ok ? 'ok' : 'error'}>{pkMsg?.text}</p>
        <ConfirmDialog open={!!delPk} danger title="הסרת Passkey" message={`ה-Passkey "${delPk?.name ?? ''}" יוסר. עדיין אפשר להיכנס עם סיסמה.`} onCancel={() => setDelPk(null)}
          onConfirm={async () => { const k = delPk!; setDelPk(null); await api('DELETE', `/auth/passkeys/${k.id}`).catch(() => undefined); await loadPks(); onChanged(); }} />
      </section>

      <section className="card" aria-labelledby="look-h">
        <h2 id="look-h">מראה</h2>
        <p className="hint">בחירת מצב בהיר/כהה וצבע ראשי. נשמר במכשיר הזה בלבד.</p>
        <ThemeMenu align="start" />
      </section>

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
