// Offline support. The app shell is cached so the site opens without a connection, and read-only family
// data is kept so the tree and history can still be browsed offline. Contributor-only data lives in a
// separate cache that the page clears whenever the token changes.
const VERSION = 'v1';
const SHELL = `heritage-shell-${VERSION}`;
const PUBLIC = `heritage-public-${VERSION}`;
const PRIVATE = `heritage-private-${VERSION}`;
const CACHEABLE_API = /^\/api\/(tree|history|analysis|person|stories|network|celebrations)(\/|$|\?)/;
const PRECACHE = ['/', '/index.html', '/styles.css', '/app.css', '/extras.css', '/manifest.webmanifest', '/icons/icon-192.png',
  '/js/main.js', '/js/core.js', '/js/session.js', '/js/tree.js', '/js/rich.js', '/js/pages-content.js', '/js/pages-network.js',
  '/js/pages-admin.js', '/js/extras.js', '/js/i18n.js', '/js/relate.js', '/js/journey.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, PUBLIC, PRIVATE].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'clear-private') e.waitUntil(caches.delete(PRIVATE));
  if (e.data === 'skip-waiting') self.skipWaiting();
});

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (fallbackUrl && (await cache.match(fallbackUrl))) || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    if (!CACHEABLE_API.test(url.pathname + url.search)) return;
    const withToken = req.headers.has('x-family-token');
    e.respondWith(networkFirst(req, withToken ? PRIVATE : PUBLIC));
    return;
  }
  if (url.pathname.startsWith('/share') || url.pathname.startsWith('/.netlify/')) return;
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, SHELL, '/index.html')); return; }
  e.respondWith(networkFirst(req, SHELL));
});
