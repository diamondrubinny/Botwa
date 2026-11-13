// Minimal service worker: makes the panel installable and keeps the app shell available when the connection drops.
// API calls are never cached (customer data must not be stored by the worker).
const CACHE = 'botwa-shell-v3';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    // hashed static files: cache first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  if (req.mode === 'navigate') {
    // page loads: network first, fall back to the cached shell when offline
    e.respondWith(fetch(req).catch(() => caches.match('/')));
  }
  // everything else (the JSON API, SSE, attachments): straight to the network, never cached
});

// Web Push: the payload is a generic alert (no customer name or text). Tapping it opens the inbox.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { /* ignore malformed payload */ }
  // only a same-site path is followed (the link opens the conversation; no customer data is in the payload)
  const url = typeof d.url === 'string' && d.url.startsWith('/') && !d.url.startsWith('//') ? d.url : '/#/inbox';
  e.waitUntil(self.registration.showNotification(d.title || 'הודעה חדשה', { tag: d.tag || 'botwa-new', icon: typeof d.icon === 'string' && /^\/branding\/logo(\?v=\d+)?$/.test(d.icon) ? d.icon : '/icons/icon-192.png', badge: '/icons/icon-192.png', lang: 'he', dir: 'rtl', renotify: true, data: { url } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const url = (e.notification.data && e.notification.data.url) || '/#/inbox';
    const c = cs.find((x) => 'focus' in x);
    if (c) { if ('navigate' in c) c.navigate(url).catch(() => undefined); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
