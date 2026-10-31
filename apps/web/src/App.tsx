import { useCallback, useEffect, useRef, useState } from 'react';
import { api, can, type Me } from './api';
import { A11yWidget } from './components/A11yWidget';
import { Icon } from './components/Icon';
import { ThemeMenu } from './components/ThemeMenu';
import { useHashRoute, usePoll } from './hooks';
import { LiveProvider, resubscribeIfEnabled, unsubscribePush, useLive } from './live';
import { Account } from './pages/Account';
import { Audit } from './pages/Audit';
import { Bot } from './pages/Bot';
import { CannedReplies } from './pages/Canned';
import { Channels } from './pages/Channels';
import { Inbox } from './pages/Inbox';
import { Accessibility, Privacy } from './pages/Legal';
import { Login } from './pages/Login';
import { KnowledgeBase } from './pages/KnowledgeBase';
import { Reports } from './pages/Reports';
import { Roles } from './pages/Roles';
import { Settings } from './pages/Settings';
import { Team } from './pages/Team';
import { t } from './strings';

type IconName = Parameters<typeof Icon>[0]['name'];
interface NavItem { r: string; label: string; icon: IconName; allowed: (me: Me) => boolean }

const NAV: NavItem[] = [
  { r: 'inbox', label: t.nav.inbox, icon: 'chat', allowed: () => true },
  { r: 'bot', label: 'בוט', icon: 'bot', allowed: (m) => can(m, 'bot.view') },
  { r: 'kb', label: 'מאגר ידע', icon: 'book', allowed: (m) => can(m, 'kb.manage') },
  { r: 'reports', label: 'דוחות', icon: 'chart', allowed: (m) => can(m, 'reports.view') },
  { r: 'canned', label: 'תשובות ותגיות', icon: 'tag', allowed: (m) => can(m, 'canned.manage') || can(m, 'tags.manage') },
  { r: 'channels', label: t.nav.channels, icon: 'plug', allowed: (m) => can(m, 'channels.view') },
  { r: 'team', label: t.nav.team, icon: 'users', allowed: (m) => can(m, 'users.view') },
  { r: 'roles', label: 'תפקידים', icon: 'shield', allowed: (m) => can(m, 'roles.manage') },
  { r: 'audit', label: 'יומן ביקורת', icon: 'list', allowed: (m) => can(m, 'audit.view') },
  { r: 'settings', label: 'הגדרות', icon: 'gear', allowed: (m) => can(m, 'settings.view') || can(m, 'backups.manage') },
  { r: 'account', label: t.nav.account, icon: 'user', allowed: () => true },
];
const PAGES = [...NAV.map((n) => n.r), 'accessibility', 'privacy'];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const loadMe = useCallback(async () => setMe(await api<Me>('GET', '/auth/me').catch(() => null)), []);
  useEffect(() => { void loadMe(); }, [loadMe]);

  if (me === undefined) return <p role="status" style={{ padding: '2rem' }}>{t.loading}</p>;
  if (me === null) return <><Login onDone={loadMe} /><A11yWidget /></>;
  return <LiveProvider><Shell me={me} reloadMe={loadMe} onLogout={() => setMe(null)} /></LiveProvider>;
}

function Shell({ me, reloadMe, onLogout }: { me: Me; reloadMe: () => Promise<void>; onLogout: () => void }) {
  const [route] = useHashRoute();
  const { tick } = useLive();
  const [unread, setUnread] = useState(0);
  const sheet = useRef<HTMLDialogElement>(null);

  const page = me.mfaEnrollmentRequired ? 'account' : route;
  const visible = NAV.filter((n) => n.allowed(me));
  // phones: first three destinations + "more" (a sheet with everything); few destinations: show all
  const bottom = visible.length <= 4 ? visible : visible.slice(0, 3);

  usePoll(async () => {
    const r = await api<{ count: number }>('GET', '/conversations/unread').catch(() => null);
    if (r) setUnread(r.count);
  }, 30000, [tick]);

  // unread count in the tab title / installed-app badge so new work is noticed elsewhere
  useEffect(() => {
    const base = 'Botwa – מערכת תמיכה';
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (unread > 0) void nav.setAppBadge?.(unread).catch(() => undefined); else void nav.clearAppBadge?.().catch(() => undefined);
  }, [unread]);

  // move focus to the page heading on navigation (screen-reader friendly)
  useEffect(() => { document.querySelector<HTMLElement>('main h1')?.focus(); }, [page, me.id]);
  useEffect(() => { sheet.current?.close(); }, [page]);

  useEffect(() => { resubscribeIfEnabled(); }, []);
  async function logout() {
    await unsubscribePush();
    await api('POST', '/auth/logout').catch(() => undefined);
    onLogout();
  }
  const toggleAvailable = async (v: boolean) => { await api('POST', '/auth/availability', { available: v }).catch(() => undefined); await reloadMe(); };
  const isAgent = !can(me, 'inbox.view_all');
  const title = NAV.find((n) => n.r === page)?.label ?? (page === 'accessibility' ? t.nav.a11y : page === 'privacy' ? t.nav.privacy : '');

  const link = (n: NavItem) => (
    <li key={n.r}>
      <a className="nav-link" href={`#/${n.r}`} aria-current={page === n.r ? 'page' : undefined} onClick={() => sheet.current?.close()}>
        <Icon name={n.icon} />{n.label}
        {n.r === 'inbox' && unread > 0 && <span className="unread" style={{ marginInlineStart: 'auto' }}><span className="sr-only">הודעות שלא נקראו: </span>{unread}</span>}
      </a>
    </li>
  );
  const availability = isAgent && (
    <label className="availability">
      <input type="checkbox" checked={me.available !== false} onChange={(e) => toggleAvailable(e.target.checked)} />
      זמין לפניות חדשות
    </label>
  );

  return (
    <div className="app">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.querySelector<HTMLElement>('main h1')?.focus(); }}>{t.skip}</a>

      <aside className="sidebar" aria-label="תפריט צד">
        <div className="brand"><span className="brand-mark"><Icon name="chat" /></span><strong>Botwa</strong></div>
        <nav aria-label="ניווט ראשי"><ul className="nav-list">{visible.map(link)}</ul></nav>
        <div className="side-foot">
          {availability}
          <div className="me-card">
            <span className="avatar" aria-hidden="true">{me.name.slice(0, 1)}</span>
            <div style={{ minWidth: 0 }}><strong>{me.name}</strong><small>{me.roleName}</small></div>
            <span className="spacer" />
            <ThemeMenu align="start" />
          </div>
          <button onClick={logout}><Icon name="logout" size={18} />{t.nav.logout}</button>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <span className="brand-mark"><Icon name="chat" size={18} /></span>
          <strong>{title}</strong>
          <span className="spacer" />
          {availability}
          <ThemeMenu />
        </header>

        <main id="main">
          {me.mfaEnrollmentRequired && <p className="banner" role="alert">התפקיד שלכם מחייב אימות דו-שלבי או Passkey. הפעילו אחד מהם כדי להמשיך.</p>}
          {page === 'inbox' && <Inbox me={me} />}
          {page === 'bot' && can(me, 'bot.view') && <Bot me={me} />}
          {page === 'kb' && can(me, 'kb.manage') && <KnowledgeBase />}
          {page === 'reports' && can(me, 'reports.view') && <Reports />}
          {page === 'canned' && (can(me, 'canned.manage') || can(me, 'tags.manage')) && <CannedReplies me={me} />}
          {page === 'channels' && can(me, 'channels.view') && <Channels me={me} />}
          {page === 'team' && can(me, 'users.view') && <Team me={me} />}
          {page === 'roles' && can(me, 'roles.manage') && <Roles me={me} />}
          {page === 'audit' && can(me, 'audit.view') && <Audit />}
          {page === 'settings' && (can(me, 'settings.view') || can(me, 'backups.manage')) && <Settings me={me} />}
          {page === 'account' && <Account me={me} onChanged={reloadMe} />}
          {page === 'accessibility' && <Accessibility />}
          {page === 'privacy' && <Privacy />}
          {!PAGES.includes(page) && <><h1 tabIndex={-1}>הדף לא נמצא</h1><p><a href="#/inbox">חזרה לשיחות</a></p></>}
        </main>

        <footer className="legal">
          <a href="#/accessibility">{t.nav.a11y}</a>
          <a href="#/privacy">{t.nav.privacy}</a>
        </footer>
      </div>

      <nav className="bottomnav" aria-label="ניווט תחתון">
        {bottom.map((n) => (
          <a key={n.r} className="bn-item" href={`#/${n.r}`} aria-current={page === n.r ? 'page' : undefined}>
            <Icon name={n.icon} />{n.label}
            {n.r === 'inbox' && unread > 0 && <span className="bn-badge"><span className="sr-only">הודעות שלא נקראו: </span>{unread}</span>}
          </a>
        ))}
        {visible.length > 4 && <button className="bn-item" onClick={() => sheet.current?.showModal()}><Icon name="more" />עוד</button>}
      </nav>

      <dialog ref={sheet} aria-label="כל המסכים" style={{ width: 'min(420px, calc(100vw - 2rem))' }}>
        <h2>כל המסכים</h2>
        <ul className="nav-list" style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem' }}>{visible.map(link)}</ul>
        <div className="row"><button onClick={logout}><Icon name="logout" size={18} />{t.nav.logout}</button><button onClick={() => sheet.current?.close()}>סגירה</button></div>
      </dialog>
      <A11yWidget />
    </div>
  );
}
