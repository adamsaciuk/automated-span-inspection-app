self.__ASI_BUILD__ = "0.1.5+202609201452";
self.__ASI_SHELL__ = ["./","./app/app.css","./app/assign.js","./app/camera.js","./app/coverage.js","./app/field.css","./app/field.js","./app/fielddb.js","./app/flight.js","./app/geo.js","./app/kmz.js","./app/main.js","./app/map.js","./app/pwa.js","./app/search.js","./app/stage3d.js","./app/store.js","./app/tower3d.js","./app/validate.js","./brand/dh-mark-neg.png","./brand/dh-mark-pos.png","./brand/dh-tokens.css","./brand/dh-wordmark-neg.png","./brand/dh-wordmark-pos.png","./brand/PROVENANCE.md","./design-system/PROVENANCE.md","./design-system/styles.css","./field.html","./field.webmanifest","./icons/icon-192.png","./icons/icon-512-maskable.png","./icons/icon-512.png","./index.html","./manifest.webmanifest","./vendor/leaflet/leaflet.css","./vendor/leaflet/leaflet.js","./vendor/lines/LineMaterial.js","./vendor/lines/LineSegments2.js","./vendor/lines/LineSegmentsGeometry.js","./vendor/three.min.js","./version.json"];
/* sw.js — the service worker that makes the app installable and offline
   (D-A885). The app shell (every file listed in the manifest below, written
   by tools/site.mjs) is cached on install under a cache named by the build
   stamp; a new build brings a new stamp, the old cache is dropped on
   activate, and the page is told "updated" so it can show the version.
   Same-origin requests are answered cache-first; map tiles and other
   cross-origin requests go straight to the network and are never cached. */
const BUILD = self.__ASI_BUILD__ || 'dev';
const CACHE = 'asi-' + BUILD;
const SHELL = self.__ASI_SHELL__ || ['./', './index.html'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('asi-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }).then(function () {
    return self.clients.matchAll({ type: 'window' }).then(function (cs) { cs.forEach(function (c) { c.postMessage({ type: 'asi-updated', build: BUILD }); }); });
  }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return fetch(e.request).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
      return res;
    }).catch(function () { return url.pathname.endsWith('/') || url.pathname.endsWith('.html') ? caches.match('./index.html') : Response.error(); });
  }));
});
