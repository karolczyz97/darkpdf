// DarkPDF – pamięć podręczna aplikacji, dzięki której czytnik działa bez internetu.
// Pliki aplikacji: najpierw z sieci (zawsze świeże), bez sieci – ostatnia zapisana wersja.
// pdf.js w lib/pdfjs się nie zmienia, więc bierzemy go od razu z pamięci.
const CACHE = 'darkpdf-v5';
const CORE = [
  './',
  'index.html',
  'theme.css',
  'viewer.css',
  '../calc/calc.css',
  '../calc/calc-app.js',
  'calc-panel.js',
  'lib/pdfjs/build/pdf.min.mjs',
  'lib/pdfjs/build/pdf.worker.min.mjs'
];

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
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const katex = url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/katex@');
  if (url.origin !== location.origin && !katex) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (katex) {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }
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
