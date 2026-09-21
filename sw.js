// DarkPDF – pamięć podręczna aplikacji, dzięki której czytnik działa bez internetu.
// Pliki aplikacji: najpierw z sieci (zawsze świeże), bez sieci – ostatnia zapisana wersja.
// pdf.js w lib/pdfjs się nie zmienia, więc bierzemy go od razu z pamięci.
const CACHE = 'darkpdf-v1';
const CORE = ['./', 'index.html', 'theme.css', 'lib/pdfjs/build/pdf.min.mjs', 'lib/pdfjs/build/pdf.worker.min.mjs'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // tylko nasze pliki
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (url.pathname.includes('/lib/pdfjs/')) {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });   // viewer.js?v=… – każda zapisana wersja się nada
      if (hit) return hit;
      throw err;
    }
  })());
});
