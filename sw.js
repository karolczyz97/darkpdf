// DarkPDF – pamięć podręczna aplikacji, dzięki której czytnik działa bez internetu.
// Pliki aplikacji: najpierw z sieci (zawsze świeże, bez ręcznych ?v=), bez sieci – ostatnia zapisana wersja.
// pdf.js w lib/pdfjs się nie zmienia, więc bierzemy go od razu z pamięci.
const CACHE = 'darkpdf-v22';
const CORE = [
  './',
  'index.html',
  'theme.css',
  'fonts/google-sans-flex-latin.woff2',
  'fonts/google-sans-flex-latin-ext.woff2',
  'viewer.css',
  'viewer.js',
  'theme.js',
  'menu-bar.js',
  'doc-history.js',
  'doc-url.js',
  'extension-loader.js',
  'doc-loader.js',
  'input.js',
  'util.js',
  'layout.js',
  'library.js',
  'calc-panel.js',
  '../calc/calc.css',
  '../calc/calc-app.js',
  '../calc/calc-engine.js',
  'lib/pdfjs/build/pdf.min.mjs',
  'lib/pdfjs/build/pdf.worker.min.mjs'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('darkpdf-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const cachedClients = new Set();   // karty, których strona przyszła z cache (wolna sieć albo offline)

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
    const hit = await cache.match(req, { ignoreSearch: true });
    // Strona podana z cache bierze z cache także swoje pliki – nowe moduły nie mieszają się ze starymi
    if (hit && cachedClients.has(e.clientId)) return hit;
    const navigate = req.mode === 'navigate';
    try {
      // no-cache: przeglądarka pyta serwer, czy plik się zmienił (GitHub Pages trzyma pliki 10 min),
      // więc po wdrożeniu od razu widać nową wersję wszystkich plików naraz.
      // Limit 2 s tylko dla samej strony: przy wolnej sieci cała aplikacja startuje z cache.
      const res = await fetch(req, { cache: 'no-cache', signal: hit && navigate ? AbortSignal.timeout(2000) : undefined });
      if (res.ok) await cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      if (!hit) throw err;
      if (navigate && e.resultingClientId) cachedClients.add(e.resultingClientId);
      return hit;
    }
  })());
});
