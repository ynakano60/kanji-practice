// 繧ｪ繝輔Λ繧､繝ｳ蟇ｾ蠢・N-3): 繧｢繝励Μ譛ｬ菴薙ｒ繧ｭ繝｣繝・す繝･縺吶ｋ縲ゅョ繝励Ο繧､譎ゅ・ CACHE_VERSION 繧剃ｸ翫￡繧九％縺ｨ縲・const CACHE_VERSION = 'v3';
const CACHE_NAME = 'kanji-practice-' + CACHE_VERSION;
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/db.js',
  './js/parser.js',
  './js/api.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // API 蜻ｼ縺ｳ蜃ｺ縺励↑縺ｩ蛻･繧ｪ繝ｪ繧ｸ繝ｳ縺ｯ繧ｭ繝｣繝・す繝･縺励↑縺・  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(cached => {
      const fetched = fetch(event.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
