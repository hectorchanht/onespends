// OneSpends service worker — v24 (header redesign: one month pill in
// the bar; the ‹ › steppers + month input live in the picker panel
// that opens from it).
// Strategy: navigations AND app js/css are network-first (deploys land
// immediately; cache is only the offline fallback). The big immutable
// vendor payloads (tesseract / ppocr / chart) stay cache-first — they
// change only by path/content, not by app release. HTML entries also
// reference local css/js with a ?v=N query so a stale HTTP cache can
// never pin an old entry file to an old module graph.
const CACHE = "onespends-v25";
const SHELL = [
  "./",
  "./index.html",
  "./app",
  "./app.html",
  "./value",
  "./tour",
  "./tour.html",
  "./guides",
  "./guides.html",
  "./styles.css?v=23",
  "./vendor/driver.css?v=23",
  "./app.css?v=25",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./js/app.js?v=25",
  "./vendor/driver.js?v=23",
  "./js/tour.js?v=24",
  "./js/db.js",
  "./js/parser.js",
  "./js/seed.js",
  "./js/stats.js",
  "./js/seed-data.js",
  "./js/sync.js",
  "./js/sync-core.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API traffic (auth + sync) is never served from or written to the cache.
  if (url.pathname.startsWith("/api/")) return;
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (e.request.mode === "navigate") {
    // network-first so deploys land immediately, fall back to cache offline
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => {
          if (r) return r;
          // offline fallback: /app (incl. ?demo=1) → app shell, everything else → landing
          return caches.match(/\/app(\.html)?$/.test(url.pathname) ? "./app.html" : "./index.html");
        }))
    );
    return;
  }
  // OCR engine assets (Tesseract ~46 MB vendored incl. lang-best;
  // PP-OCRv5 ~34 MB incl. the onnxruntime wasm): NOT in the install
  // shell, so casual visitors never pay those downloads. Runtime
  // cache-first instead — the first scan fetches them from the network
  // and caches them; every later scan (including fully offline) is
  // served from this cache.
  if (url.pathname.startsWith("/vendor/tesseract/") || url.pathname.startsWith("/vendor/ppocr/") || url.pathname.startsWith("/vendor/chart/")) {
    e.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(e.request).then((hit) => {
          if (hit) return hit;
          return fetch(e.request).then((res) => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }
  // network-first for everything else same-origin (app js/css, icons,
  // manifest): a cached copy is served ONLY when the network fails, so
  // an old worker can never pin stale app code after a deploy.
  // ignoreSearch on the fallback lets a ?v=N request reuse the bare-URL
  // precache entry (and vice versa) when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
