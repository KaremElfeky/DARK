// Service worker: offline support + push notifications.
const VERSION = 'mahami-v1';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/dates.js',
  './js/icons.js',
  './js/ui.js',
  './js/notify.js',
  './js/ink.js',
  './js/calendar.js',
  './js/config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-96.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/api/')) return; // never cache the API
    // Network first (fresh code when online), cache fallback (works offline).
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await Promise.race([fetch(req), timeout(4000)]);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
        return Response.error();
      }
    })());
    return;
  }

  // Google Fonts: stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const cache = await caches.open(`${VERSION}-fonts`);
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })());
  }
});

/* ---------------- Push ---------------- */

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: event.data?.text() }; }
  const title = d.title || 'مهامي';
  const actions = d.kind === 'test' || !d.taskId ? []
    : d.kind === 'day' ? [{ action: 'done', title: 'خلصتها ✓' }]
      : [{ action: 'done', title: 'خلصتها ✓' }, { action: 'snooze', title: 'أجّل ساعة' }];
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    lang: 'ar',
    dir: 'rtl',
    data: { taskId: d.taskId, kind: d.kind },
    actions,
  }));
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  const action = event.action || 'open';
  n.close();
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => c.url.startsWith(scope));
    if (client) {
      try { await client.focus(); } catch { /* ignore */ }
      if (data.taskId) client.postMessage({ type: 'notification-action', action, taskId: data.taskId });
      return;
    }
    const url = new URL('./', scope);
    if (data.taskId) {
      url.searchParams.set('task', data.taskId);
      url.searchParams.set('do', action);
    }
    await self.clients.openWindow(url.href);
  })());
});
