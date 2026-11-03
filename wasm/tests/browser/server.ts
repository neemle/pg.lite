// Static file server for the browser tests: URL prefix -> directory, correct MIME types, and an on/off switch
// that makes every request fail (the "origin server stopped" case of the offline tests).
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.css': 'text/css', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

export type Mount = [prefix: string, directory: string];

export interface TestServer {
  url: string;
  port: number;
  state: { down: boolean; hits: string[] };
  close(): Promise<void>;
}

// mounts: [['/engine/', '/w/build/wasm/18.6/web'], ['/', '/w/wasm/tests/browser/fixtures']]  (first match wins)
export function createServer(mounts: Mount[], { port = 0 }: { port?: number } = {}): Promise<TestServer> {
  const state = { down: false, hits: [] as string[] };
  const server = http.createServer((req, res) => {
    state.hits.push(req.url ?? '');
    if (state.down) { req.socket.destroy(); return; }
    const url = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    for (const [prefix, dir] of mounts) {
      if (!url.startsWith(prefix)) continue;
      let rel = url.slice(prefix.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(dir, rel);
      if (!file.startsWith(path.resolve(dir))) break;
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const bound = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${bound}`, port: bound, state,
        close: () => new Promise<void>((r) => { server.close(() => r()); }),
      });
    });
  });
}
