// オフライン対応(N-3): アプリ本体をキャッシュする。デプロイ時は CACHE_VERSION を上げること。
// 配信方式はネットワーク優先(オンライン時は常に最新、オフライン時のみキャッシュ)。
const CACHE_VERSION = 'v4';
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
  // API 呼び出しなど別オリジンはキャッシュしない
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // ネットワーク優先: オンラインなら常に最新のファイルを使い、キャッシュを更新。
  // オフラインのときだけキャッシュから返す。
  event.respondWith(
    fetch(event.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return res;
    }).catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
