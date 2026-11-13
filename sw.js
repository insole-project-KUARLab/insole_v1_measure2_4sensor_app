// アプリを更新したら VERSION の数字を上げてください
const VERSION = "v4";
const PREFIX = "insole4-";
const CACHE = PREFIX + VERSION;
const FILES = ["./", "./index.html", "./core.js", "./geometry.js", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
// 消すのはこのアプリの古いキャッシュだけ（同じサイトに5センサー版アプリがあっても消さない）
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// ネットにつながれば最新版、つながらなければ保存しておいた版を使う
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
