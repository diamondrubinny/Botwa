import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api';
import { A11yWidget } from './components/A11yWidget';
import { useHashRoute } from './hooks';
import { Account } from './pages/Account';
import { CannedReplies } from './pages/Canned';
import { Audit } from './pages/Audit';
import { Settings } from './pages/Settings';
import { Channels } from './pages/Channels';
import { Inbox } from './pages/Inbox';
import { Accessibility, Privacy } from './pages/Legal';
import { Reports } from './pages/Reports';
import { Login } from './pages/Login';
import { Team } from './pages/Team';
import { t } from './strings';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [route] = useHashRoute();

  const loadMe = useCallback(async () => setMe(await api<Me>('GET', '/auth/me').catch(() => null)), []);
  useEffect(() => { void loadMe(); }, [loadMe]);

  // Move focus to the page heading on navigation (screen-reader friendly).
  useEffect(() => { document.querySelector<HTMLElement>('main h1')?.focus(); }, [route, me?.id]);

  if (me === undefined) return <p role="status" style={{ padding: '2rem' }}>{t.loading}</p>;
  if (me === null) return <><Login onDone={loadMe} /><A11yWidget /></>;

  const isAdmin = me.role === 'admin';
  const isManager = me.role !== 'agent';
  const page = me.mfaEnrollmentRequired ? 'account' : route;

  const links: [string, string][] = [['inbox', t.nav.inbox]];
  if (isManager) links.push(['reports', 'דוחות'], ['canned', 'תשובות ותגיות'], ['channels', t.nav.channels], ['team', t.nav.team]);
  if (isAdmin) links.push(['audit', 'יומן ביקורת'], ['settings', 'הגדרות']);
  links.push(['account', t.nav.account]);

  async function logout() {
    await api('POST', '/auth/logout').catch(() => undefined);
    setMe(null);
  }

  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.querySelector<HTMLElement>('main h1')?.focus(); }}>{t.skip}</a>
      <header className="top">
        <span className="brand">{t.appName}</span>
        <nav aria-label="ניווט ראשי">
          <ul>
            {links.map(([r, label]) => (
              <li key={r}><a href={`#/${r}`} aria-current={page === r ? 'page' : undefined}>{label}</a></li>
            ))}
          </ul>
        </nav>
        <span className="spacer" />
        <span>{me.name} ({t.roles[me.role]})</span>
        <button onClick={logout}>{t.nav.logout}</button>
      </header>

      <main id="main">
        {me.mfaEnrollmentRequired && (
          <p className="banner" role="alert">תפקידכם מחייב אימות דו-שלבי. יש להפעיל אותו כדי להמשיך.</p>
        )}
        {page === 'inbox' && <Inbox me={me} />}
        {page === 'channels' && isManager && <Channels isAdmin={isAdmin} />}
        {page === 'reports' && isManager && <Reports />}
        {page === 'canned' && isManager && <CannedReplies />}
        {page === 'audit' && isAdmin && <Audit />}
        {page === 'settings' && isAdmin && <Settings />}
        {page === 'team' && isManager && <Team meId={me.id} isAdmin={isAdmin} />}
        {page === 'account' && <Account me={me} onChanged={loadMe} />}
        {page === 'accessibility' && <Accessibility />}
        {page === 'privacy' && <Privacy />}
        {!['inbox', 'reports', 'canned', 'audit', 'settings', 'channels', 'team', 'account', 'accessibility', 'privacy'].includes(page) && (
          <><h1 tabIndex={-1}>הדף לא נמצא</h1><p><a href="#/inbox">חזרה לשיחות</a></p></>
        )}
      </main>

      <footer>
        <a href="#/accessibility">{t.nav.a11y}</a>
        <a href="#/privacy">{t.nav.privacy}</a>
      </footer>
      <A11yWidget />
    </div>
  );
}
