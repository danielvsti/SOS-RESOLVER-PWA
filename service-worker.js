const CACHE_NAME = "queltu-resolver-v13.4-offline-banner-ux";
const APP_SHELL = [
  "/", "/index.html", "/app.js", "/styles.css", "/queltu-brand.css", "/manifest.json",
  "/queltu-logo.png", "/queltu-symbol.png", "/vendor/jssip.min.js",
  "/icons/icon-192.png", "/icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request)
      .then((response) => {
        caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", response.clone()));
        return response;
      })
      .catch(() => caches.match("/index.html")));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => {
    const network = fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => cached);
    return cached || network;
  }));
});
