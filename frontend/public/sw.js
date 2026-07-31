const CACHE = 'fortress-hub-v1';
const urls = ['/', '/manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(urls))
  );
});

self.addEventListener('fetch', event => {
  if (event.request.url.startsWith(self.location.origin) && !event.request.url.includes('/api/')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, clone));
        return response;
      }))
    );
  }
});
