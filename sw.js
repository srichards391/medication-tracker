// Service worker: caches the app shell so Meds opens instantly and works offline,
// and shows the push reminders sent by GitHub Actions.
//
// Updates: bump CACHE_VERSION (and the ?v= below, and APP_VERSION in app.js) whenever app
// files change. The browser notices this file changed, installs the new worker, and it takes
// over at once (skipWaiting + claim); app.js then reloads the page onto the new code.
const CACHE_VERSION = 'meds-v3.1.0';
const DATA_CACHE = 'meds-data'; // the app's copy of your meds for reminder text; survives updates
const SHELL = [
  './',
  './index.html',
  './styles.css?v=3.1',
  './config.js?v=3.1',
  './sync-core.js?v=3.1',
  './app.js?v=3.1',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Same dose logic as the app, for "Warfarin 8 mg" in the reminder.
importScripts('./sync-core.js?v=3.1');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first for our own files, always checking with the server rather than the
// browser's HTTP cache, so a new release lands on the next open. The cache is only the
// offline fallback. Requests to other sites (GitHub sync) and version.json are never touched.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith('/version.json')) return;
  event.respondWith(
    fetch(new Request(event.request.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match(event.request, { ignoreSearch: true })).then((hit) => hit || caches.match('./index.html')))
  );
});

// ---------- push reminders ----------
// Sent by scripts/send-push.mjs as JSON: { slot, title, body, url }. The body from GitHub is
// generic (GitHub can't see your meds), so it's replaced here with the meds and doses this
// device has for that slot today. As-needed meds are never included.
// Always show a notification: iOS turns push off for apps that receive one silently.
async function reminderBody(slot, fallback) {
  try {
    if (!slot || !self.MedsSyncCore) return fallback;
    const hit = await (await caches.open(DATA_CACHE)).match('./meds-data.json');
    if (!hit) return fallback;
    const Core = self.MedsSyncCore;
    return Core.reminderBody(Core.migrate(await hit.json()), slot, Core.dayKeyOf(new Date()));
  } catch (e) {
    return fallback;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* not JSON; use the defaults */ }
  const title = data.title || 'Meds';
  event.waitUntil((async () => {
    const body = await reminderBody(data.slot, data.body || 'Time for your meds. Tap to log.');
    await self.registration.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: `meds-${data.slot || 'reminder'}`,
      renotify: true,
      data: { url: data.url || './#today' },
    });
  })());
});

// Tap: bring Meds forward on Today, or open it if it isn't running.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './#today', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (win) {
      await win.focus();
      win.postMessage({ type: 'open-today' });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
