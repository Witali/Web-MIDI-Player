// A build replaces these constants; all URLs stay within this app's scope.
const VERSION = '__PWA_VERSION__';
const ASSETS = /* PWA_ASSETS */ [];
const BASE = new URL('./', self.location.href);
const PREFIX = 'web-midi-player:' + BASE.pathname + ':';
const CACHE = PREFIX + VERSION;
const urls = ASSETS.map(asset => ({ ...asset, url: new URL(asset.file, BASE).href }));
const allowed = new Set(urls.map(asset => asset.url));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(
    urls.filter(asset => asset.core).map(asset => new Request(asset.url, { cache: 'reload' }))
  )));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
async function cached(request, key) {
  const cache = await caches.open(CACHE);
  const stored = await cache.match(key);
  if (stored) return stored;
  const response = await fetch(request);
  if (response.ok && response.type !== 'opaque') {
    try { await cache.put(key, response.clone()); } catch { /* Playback can continue if storage is full. */ }
  }
  return response;
}
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.headers.has('range')) return;
  const url = new URL(event.request.url);
  if (url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  // File-handler launches may contain a query, but use the same cached shell.
  url.search = ''; url.hash = '';
  if (url.href === BASE.href || url.href === new URL('index.html', BASE).href) {
    event.respondWith(cached(new Request(new URL('index.html', BASE)), new URL('index.html', BASE).href));
  } else if (allowed.has(url.href)) event.respondWith(cached(event.request, url.href));
});
let saving;
self.addEventListener('message', event => {
  const port = event.ports[0];
  if (!port || !['OFFLINE_STATUS', 'CACHE_OFFLINE'].includes(event.data?.type)) return;
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      if (event.data.type === 'OFFLINE_STATUS') {
        const keys = new Set((await cache.keys()).map(request => request.url));
        port.postMessage({ done: true, ready: urls.every(asset => keys.has(asset.url)) }); return;
      }
      if (!saving) saving = (async () => {
        let next = 0, completed = 0;
        async function worker() {
          while (next < urls.length) {
            const asset = urls[next++];
            if (!await cache.match(asset.url)) {
              const response = await fetch(new Request(asset.url, { cache: 'reload' }));
              if (!response.ok || response.type === 'opaque') throw new Error('Ресурс недоступен: ' + asset.file);
              await cache.put(asset.url, response);
            }
            completed++;
            if (completed % 16 === 0 || completed === urls.length) port.postMessage({ completed, total: urls.length });
          }
        }
        await Promise.all(Array.from({ length: 6 }, worker));
      })().finally(() => { saving = null; });
      await saving;
      port.postMessage({ done: true, ready: true });
    } catch (error) { port.postMessage({ error: error.message }); }
  })());
});
