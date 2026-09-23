// Serwer do pracy lokalnej – układ jak na GitHub Pages: czytnik pod /darkpdf/, kalkulator pod /calc/.
// Aplikacje sięgają do siebie ścieżką ../, więc drugie repo musi leżeć obok (…/darkpdf i …/calc).
// Start: npm start → http://localhost:8080/  (inny port: PORT=9000 npm start)
// Ten sam plik jest w obu repo – różni się tylko stałą SELF.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = 'darkpdf';                              // które to repo; drugie leży w katalogu obok
const OTHER = SELF === 'darkpdf' ? 'calc' : 'darkpdf';
const PORT = Number(process.env.PORT) || (SELF === 'darkpdf' ? 8080 : 3333);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPS = new Map([[SELF, HERE], [OTHER, path.resolve(HERE, '..', OTHER)]]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.ttf': 'font/ttf'
};

function send(res, code, text, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }
  if (pathname.includes('\0')) return send(res, 400, 'Bad Request');   // bez tego fs rzuca wyjątek i serwer pada

  const [, app = '', ...rest] = pathname.split('/');
  if (!app) return send(res, 302, '', { Location: `/${SELF}/` });
  const root = APPS.get(app);
  if (!root) return send(res, 404, 'Not Found');
  if (!rest.length) return send(res, 302, '', { Location: `/${app}/` });   // /calc → /calc/, jak na GitHub Pages

  let file = path.join(root, ...rest);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');   // ../ poza aplikację

  fs.stat(file, (err, stats) => {
    if (!err && stats.isDirectory()) {
      file = path.join(file, 'index.html');
      return fs.stat(file, (err2, s2) => serve(err2 || !s2.isFile()));
    }
    serve(err || !stats.isFile());
  });

  function serve(missing) {
    if (missing) {
      console.log(`[404] ${req.method} ${req.url}`);
      return send(res, 404, 'Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}/${SELF}/  (obok: /${OTHER}/)`);
});
