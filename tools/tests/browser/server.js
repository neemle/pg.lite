// Static file server for the browser tests: URL prefix -> directory, correct MIME types, and an on/off switch
// that makes every request fail (the "origin server stopped" case of the offline tests).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// mounts: [['/engine/', '/w/build/wasm/18.6/web'], ['/', '/w/tests/browser/fixtures']]  (first match wins)
function createServer(mounts, { port = 0 } = {}) {
  const state = { down: false, hits: [] };
  const server = http.createServer((req, res) => {
    state.hits.push(req.url);
    if (state.down) { req.socket.destroy(); return; }
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const [prefix, dir] of mounts) {
      if (!url.startsWith(prefix)) continue;
      let rel = url.slice(prefix.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(dir, rel);
      if (!file.startsWith(path.resolve(dir))) break;
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, state,
    close: () => new Promise((r) => server.close(r)),
  })));
}
module.exports = { createServer };
