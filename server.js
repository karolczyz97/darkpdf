const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.traineddata': 'application/octet-stream'
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
  if (reqPath === '/calc') {
    res.writeHead(302, { Location: '/calc/' });
    return res.end();
  }

  let filePath;
  const CALC_DIR = path.resolve(ROOT, '..', 'calc');
  if (reqPath.startsWith('/calc/')) {
    const subPath = reqPath.slice(6) || 'index.html';
    filePath = path.join(CALC_DIR, subPath === '' ? 'index.html' : subPath);
    if (!filePath.startsWith(CALC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
  } else {
    filePath = path.join(ROOT, reqPath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      console.log(`[404] ${req.method} ${req.url}`);
      res.writeHead(404);
      return res.end('Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    console.log(`[200] ${req.method} ${req.url}`);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// Nasłuchuj na wszystkich interfejsach (IPv4 i IPv6)
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/ (IPv4 and IPv6)`);
});
