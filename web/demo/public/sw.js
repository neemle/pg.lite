// Service worker of the demo: offline navigation and assets. It is a cache, never the owner of the database
// (that is the engine Worker of the page).
//
// asset-manifest.json (made at build time by tools/asset-manifest.js) lists every file of this build and a version
// that changes when any of them does. The worker installs only when ALL of them were fetched: cache.addAll() is
// all-or-nothing, so a registration becomes active, and the page can say "ready for offline use", only for one
// complete, consistent set of one version. A newer version installs next to the old cache and replaces it on
// activation; until then the old complete set keeps serving.

const PREFIX = 'compactdb-demo-';
const META = `${PREFIX}meta`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const response = await fetch(new URL('asset-manifest.json', self.registration.scope), { cache: 'no-store' });
    if (!response.ok) throw new Error(`asset-manifest.json: HTTP ${response.status}`);
    const manifest = await response.json();
    const cache = await caches.open(PREFIX + manifest.version);
    await cache.addAll(manifest.files.map((f) => new URL(f, self.registration.scope).href));
    await (await caches.open(META)).put('latest', new Response(manifest.version));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const latest = await (await (await caches.open(META)).match('latest'))?.text();
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== META && name !== PREFIX + latest) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: false });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (error) {
      // a navigation while offline: the app shell
      if (request.mode === 'navigate') { const shell = await caches.match(new URL('index.html', self.registration.scope).href); if (shell) return shell; }
      throw error;
    }
  })());
});
