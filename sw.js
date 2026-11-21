// Service Worker: アプリ本体とポスター画像をキャッシュしてオフラインでも開けるようにする
// アプリを更新したら VERSION を上げると、古いキャッシュが削除されます。
const VERSION = 'v1';
const APP_CACHE = `app-${VERSION}`;
const IMG_CACHE = 'posters';
const IMG_LIMIT = 400;
const APP_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('app-') && k !== APP_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trimImages() {
  const c = await caches.open(IMG_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - IMG_LIMIT; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ポスター画像: キャッシュ優先
  if (url.hostname === 'image.tmdb.org') {
    e.respondWith(caches.open(IMG_CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); trimImages(); }
      return res;
    }));
    return;
  }

  // アプリ本体: キャッシュを即表示しつつ裏で更新（stale-while-revalidate）
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(APP_CACHE).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }));
  }
  // TMDb API などはそのまま通信（データはアプリ側で localStorage にキャッシュ済み）
});
