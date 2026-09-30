// Lumen phone app service worker: keeps the app shell available offline.
// API responses are never cached, because recommendations depend on today's model run.
const SHELL = "lumen-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/m", "/lumen.svg", "/manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // network first, fall back to the cached shell
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && (url.pathname.startsWith("/assets/") || url.pathname === "/m")) {
          const copy = r.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/m"))),
  );
});
