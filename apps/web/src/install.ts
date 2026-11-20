/** "Install the app" (Android/desktop Chrome, Edge): the browser's prompt is kept so the panel can offer it from a button. */
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}
export const canPromptInstall = () => deferred !== null;
export const isInstalled = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export function onInstallChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const d = deferred;
  await d.prompt();
  const { outcome } = await d.userChoice;
  deferred = null; notify();
  return outcome === 'accepted';
}
