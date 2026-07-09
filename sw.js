/* Bloom service worker.
   Two jobs:
   1) Be present + control the page, which (together with manifest.json) is what makes
      "Add to Home Screen" turn Bloom into an installable app instead of just a bookmark.
   2) Show real OS-level notifications on behalf of the page via showNotification(), which
      look and behave like a native app's notifications (banner, sound, notification center)
      instead of the more limited in-tab `new Notification()`.

   NOTE: this is still *local* notification display triggered while Bloom's page or this
   worker is alive in the browser — it is not server-pushed "wake the phone from anywhere"
   push messaging. True background push (like Spotify gets from its own servers) needs a
   real backend with a push service (VAPID keys, a push endpoint per device, etc). This
   worker is written so that layer can be added later without changing how the app calls it. */

const CACHE_NAME = 'bloom-shell-v1';
const SHELL_FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first for the HTML shell so users always get the latest build when online;
// falls back to cache when offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// The page calls navigator.serviceWorker.ready.then(reg => reg.active.postMessage({...}))
// to ask the worker to show a notification. Doing it through the worker (rather than
// `new Notification()` directly on the page) means the notification can still show up
// even if the tab is backgrounded/minimized, and gets tap-to-open behavior.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'bloom-notify') return;
  const { title, body, tag, url } = data;
  event.waitUntil(
    self.registration.showNotification(title || 'Bloom', {
      body: body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: tag || undefined,
      data: { url: url || './index.html' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// Real server push support — wired up and ready for whenever there's a backend to send it.
self.addEventListener('push', (event) => {
  let payload = { title: 'Bloom', body: 'You have a new notification.' };
  try { payload = event.data ? event.data.json() : payload; } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Bloom', {
      body: payload.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: payload.url || './index.html' },
    })
  );
});
