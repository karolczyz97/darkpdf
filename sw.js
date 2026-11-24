// DarkPDF – pamięć podręczna aplikacji, dzięki której czytnik działa bez internetu.
// Pliki aplikacji: najpierw z sieci (zawsze świeże, bez ręcznych ?v=), bez sieci – ostatnia zapisana wersja.
// pdf.js w lib/pdfjs i KaTeX w ../calc/lib/katex się nie zmieniają, więc bierzemy je od razu z pamięci.
const CACHE = 'darkpdf-v26';
const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
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
  '../calc/lib/katex/katex.min.js',
  '../calc/lib/katex/katex.min.css',
  '../calc/lib/katex/fonts/KaTeX_Main-Regular.woff2',
  '../calc/lib/katex/fonts/KaTeX_Math-Italic.woff2',
  '../calc/lib/katex/fonts/KaTeX_Size1-Regular.woff2',
  '../calc/lib/katex/fonts/KaTeX_Size2-Regular.woff2',
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
  if (url.origin !== location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (url.pathname.includes('/lib/pdfjs/') || url.pathname.includes('/lib/katex/')) {
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
      // bez ?query: ten sam plik z innym adresem nie dokłada osobnej kopii (odczyt i tak ignoreSearch)
      if (res.ok) await cache.put(url.origin + url.pathname, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      if (!hit) throw err;
      if (navigate && e.resultingClientId) cachedClients.add(e.resultingClientId);
      return hit;
    }
  })());
});
