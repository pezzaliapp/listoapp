/* ListoAPP Service Worker
 * Strategie:
 *   - index.html / admin.html  -> network-first, fallback cache
 *   - promo/promo.json         -> sempre rete diretta, MAI cache (gestito bypass)
 *   - version.json             -> sempre rete diretta, MAI cache
 *   - promo/ binari (pdf/img)  -> network-first, fallback cache
 *   - assets statici           -> stale-while-revalidate
 * CACHE_NAME va bumpato a ogni deploy via ./bump-version.sh
 */
const CACHE_NAME = 'listoapp-cache-v20260506T201706';
const SHELL = [
  './',
  './index.html',
  './admin.html',
  './manifest.webmanifest',
  './icon.svg',
  './assets/styles.css',
  './assets/app.js',
  './assets/admin.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isHTMLRequest(req, url) {
  if (req.mode === 'navigate') return true;
  return url.pathname.endsWith('/index.html') || url.pathname.endsWith('/admin.html') || url.pathname.endsWith('/');
}

function isNeverCache(url) {
  return url.pathname.endsWith('/promo/promo.json') || url.pathname.endsWith('/version.json');
}

function isPromoBinary(url) {
  return url.pathname.includes('/promo/') && !url.pathname.endsWith('/promo.json');
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request, { cache: 'no-store' });
    if (fresh && fresh.ok) cache.put(cacheKey || request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(cacheKey || request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || network || fetch(request);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return; // mai toccare cross-origin
  if (isNeverCache(url)) return; // bypass: lascia passare alla rete
  if (isHTMLRequest(req, url)) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (isPromoBinary(url)) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
