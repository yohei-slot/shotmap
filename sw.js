// アプリ本体: ネットワーク優先（圏外ならキャッシュ）／地理院タイル: キャッシュ優先
// キャッシュ名は "shotmap-" で始める。同じドメインに別アプリが同居しても、自分のキャッシュ以外は消さない
const PREFIX = 'shotmap-';
const SHELL = `${PREFIX}shell-v2`;
const TILES = `${PREFIX}tiles-v1`;
const SHELL_FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/model.js', 'js/prior.js', 'js/clubs.js', 'js/courses.js', 'js/contour.js', 'js/geo.js', 'js/dem.js', 'js/store.js',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
  'courses/harmonyhills.json', 'courses/sample-kisokoma.json', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && ![SHELL, TILES].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'cyberjapandata.gsi.go.jp') {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request.url);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request.url, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
