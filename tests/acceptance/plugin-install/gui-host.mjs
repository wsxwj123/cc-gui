import { createReadStream } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import http, { request as httpRequest } from 'node:http';
import net from 'node:net';
import path from 'node:path';

const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function proxyHttp(request, response, backendPort) {
  const headers = { ...request.headers, host: `127.0.0.1:${backendPort}` };
  const upstream = httpRequest({
    host: '127.0.0.1',
    port: backendPort,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 500, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', (error) => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error.message);
  });
  request.pipe(upstream);
}

export async function startGuiHost({ distDir, backendPort, port }) {
  const realDistDir = await realpath(distDir).catch(() => null);
  if (!realDistDir) throw new Error(`client/dist missing: ${distDir}`);
  const indexPath = path.join(realDistDir, 'index.html');
  await access(indexPath);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) return proxyHttp(request, response, backendPort);

    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const candidate = path.resolve(realDistDir, relative);
    if (candidate.startsWith(`${realDistDir}${path.sep}`) || candidate === indexPath) {
      try {
        const resolved = await realpath(candidate);
        if (resolved.startsWith(`${realDistDir}${path.sep}`) || resolved === indexPath) {
          response.writeHead(200, {
            'content-type': MIME.get(path.extname(resolved)) || 'application/octet-stream',
            'cache-control': 'no-store',
          });
          return createReadStream(resolved).pipe(response);
        }
      } catch {
        // SPA routes fall through to the real built index.
      }
    }
    const html = await readFile(indexPath);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });
  server.on('connection', (socket) => socket.on('error', () => {}));
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    const upstream = net.connect(backendPort, '127.0.0.1', () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) lines.push(`${key}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
