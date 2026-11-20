import { api } from './api';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const NOTIFY_KEY = 'botwa_notify';
export const notifyEnabled = (): boolean => { try { return localStorage.getItem(NOTIFY_KEY) === '1'; } catch { return false; } };
const b64ToBytes = (b64: string) => { const p = b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4); return Uint8Array.from(atob(p), (c) => c.charCodeAt(0)); };
const swReady = () => Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no service worker')), 3000))]);
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window;

/** Register this device for Web Push (alerts even when the app is closed). Falls back silently to in-tab alerts if unsupported. */
async function subscribePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await swReady();
  const { publicKey } = await api<{ publicKey: string }>('GET', '/push/key');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }));
  await api('POST', '/push/subscribe', sub.toJSON());
}
/** Called after sign-in: restores this device's subscription if alerts were switched on earlier. */
export function resubscribeIfEnabled(): void {
  if (notifyEnabled() && 'Notification' in window && Notification.permission === 'granted') void subscribePush().catch(() => undefined);
}
/** Remove this device's subscription (used on opt-out and at logout so a shared phone stops alerting the previous user). */
export async function unsubscribePush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const sub = await (await swReady()).pushManager.getSubscription();
    if (!sub) return;
    await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe();
  } catch { /* best effort */ }
}

export async function setNotifyEnabled(on: boolean): Promise<boolean> {
  if (on && 'Notification' in window && Notification.permission !== 'granted') {
    if ((await Notification.requestPermission()) !== 'granted') return false;
  }
  try { localStorage.setItem(NOTIFY_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
  if (on) await subscribePush().catch(() => undefined); else await unsubscribePush();
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
