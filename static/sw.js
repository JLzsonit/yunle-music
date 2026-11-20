/* 云乐 Service Worker：缓存界面外壳，保证离线可打开应用 */
const CACHE = "yunle-shell-v2";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/manifest.json",
  "/default-cover.svg", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API 请求永远走网络（音频流、曲库数据）
  if (url.pathname.startsWith("/api/")) return;
  // 界面文件：缓存优先，后台更新
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fetchAndCache = fetch(e.request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || fetchAndCache;
    })
  );
});
