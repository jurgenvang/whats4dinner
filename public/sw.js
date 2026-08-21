// Kleine service worker: de app blijft bruikbaar zonder bereik,
// maar gegevens komen altijd vers van de server als dat kan.
const CACHE = 'whats4dinner-v1';
const SCHIL = ['/', '/index.html', '/manifest.webmanifest', '/icoon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SCHIL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(namen => Promise.all(namen.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // API nooit uit de cache: verouderde planning is erger dan geen planning
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(e.request)
      .then(r => {
        const kopie = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, kopie));
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
