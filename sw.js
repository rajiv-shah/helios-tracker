/* ==========================================================================
   HELIOS — PWA Service Worker
   Offline Cache Engine
   ========================================================================== */

const CACHE_NAME = "helios-v2";
const ASSETS_TO_CACHE = [
  "index.html",
  "index.css",
  "app.js",
  "logo.png",
  "icon-192.png",
  "apple-touch-icon.png",
  "manifest.json"
];

// Install Event - Pre-cache essential files
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[Service Worker] Pre-caching application assets...");
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate Event - Clean up deprecated legacy caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log("[Service Worker] Removing old cache:", key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event - Serve cached files when offline, fetch from network when online
self.addEventListener("fetch", (event) => {
  // Only intercept HTTP/S requests (bypass chrome-extensions / internal schemes)
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      
      return fetch(event.request).then((networkResponse) => {
        // Dynamically cache successful requests to local assets
        if (networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch((err) => {
        console.warn("[Service Worker] Fetch failed. Network is offline and resource not cached.", err);
      });
    })
  );
});
