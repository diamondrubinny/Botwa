import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const NOTIFY_KEY = 'botwa_notify';
export const notifyEnabled = (): boolean => { try { return localStorage.getItem(NOTIFY_KEY) === '1'; } catch { return false; } };
export async function setNotifyEnabled(on: boolean): Promise<boolean> {
  if (on && 'Notification' in window && Notification.permission !== 'granted') {
    if ((await Notification.requestPermission()) !== 'granted') return false;
  }
  try { localStorage.setItem(NOTIFY_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
  return on;
}
/** Generic alert only (no sender, no message text): shown when the tab is in the background. */
function alertNewMessage() {
  if (!notifyEnabled() || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification('הודעה חדשה בתיבת התמיכה', { tag: 'botwa-new', icon: '/icons/icon-192.png' }); } catch { /* not supported in this context */ }
}

interface Live { tick: number; announce: string }
const Ctx = createContext<Live>({ tick: 0, announce: '' });
export const useLive = () => useContext(Ctx);

/**
 * One server-sent-events connection for the whole app: events carry no content, they only tell pages to refetch.
 * `announce` feeds a polite aria-live region so screen-reader users hear about new messages.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    const es = new EventSource('/events');
    let t: ReturnType<typeof setTimeout>;
    es.onmessage = () => {
      setTick((n) => n + 1);
      alertNewMessage();
      setAnnounce('התקבלה הודעה חדשה');
      clearTimeout(t);
      t = setTimeout(() => setAnnounce(''), 1500);
    };
    return () => { clearTimeout(t); es.close(); };
  }, []);
  return (
    <Ctx.Provider value={{ tick, announce }}>
      {children}
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    </Ctx.Provider>
  );
}
