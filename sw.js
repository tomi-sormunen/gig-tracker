// Network-first service worker: the app always loads fresh when online and
// falls back to the last cached copy offline. Query strings (cache-busting)
// are ignored for cache keys so the store stays bounded.
const CACHE = 'gig-tracker-v1';
const SHELL = [
  './',
  'index.html',
  'assets/style.css',
  'assets/app.js',
  'assets/vendor/leaflet/leaflet.css',
  'assets/vendor/leaflet/leaflet.js',
  'manifest.webmanifest',
  'data/gigs.json',
  'config/favourites.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(url.pathname).then((m) => m || caches.match('index.html'))
      )
  );
});
