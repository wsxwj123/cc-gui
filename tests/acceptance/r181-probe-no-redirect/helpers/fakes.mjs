// r181 · 本机假上游:按「方法 + 路径」配置回什么,并逐次记录收到的请求。只听 127.0.0.1,端口在 6700–6999 里挑空闲的,
// 不碰 6677 / 6689 / 6710 / 8788 / 8789 / 8798 / 8799。
//
//   const A = await startFake();
//   A.on('GET', '/v1/models', { status: 302, location: 'http://127.0.0.1:6801/v1/models' });
//   A.on('POST', '/v1/messages', (hit) => ({ status: 400, body: { error: `bad ${hit.xkey}` } }));   // 回应可以是函数(拿到本次请求记录)
//   A.fallback({ status: 302, location: ... });          // 没配到的「方法 + 路径」走兜底;不设兜底回 404
//   A.hits                                               // 每次请求一条:{ method, path, query, auth, xkey, xgoog, body, bodyHash }
//   A.count('GET', '/v1/models')                         // 精确按「方法 + 路径」计数(结尾斜杠有区别)
//
// 回应规格:{ status = 200, location?, body? }。body 是对象 → JSON;是字符串 → 原样;没给 → 空 JSON 对象。location 可以是函数(延迟取值)。
import crypto from 'node:crypto';
import http from 'node:http';

const FORBIDDEN = new Set([6677, 6689, 6710, 8788, 8789, 8798, 8799]);

async function listenInRange(server) {
  const start = 6700 + Math.floor(Math.random() * 300);
  for (let i = 0; i < 300; i += 1) {
    const port = 6700 + ((start - 6700 + i) % 300);
    if (FORBIDDEN.has(port)) continue;
    const ok = await new Promise((resolve) => {
      const onErr = () => { server.removeListener('listening', onOk); resolve(false); };
      const onOk = () => { server.removeListener('error', onErr); resolve(true); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, '127.0.0.1');
    });
    if (ok) return port;
  }
  throw new Error('6700–6999 没有空闲端口给假上游');
}

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); });
}

export async function startFake() {
  const hits = [];
  const routes = new Map();
  let fallbackSpec = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const raw = Buffer.concat(chunks);
      const hit = {
        method: req.method, path: u.pathname, query: u.search,
        auth: String(req.headers.authorization || ''), xkey: String(req.headers['x-api-key'] || ''), xgoog: String(req.headers['x-goog-api-key'] || ''),
        body: raw.toString('utf8'), bodyHash: crypto.createHash('sha256').update(raw).digest('hex'),
      };
      hits.push(hit);
      let spec = routes.get(`${req.method} ${u.pathname}`) || fallbackSpec || { status: 404, body: { error: 'not found' } };
      if (typeof spec === 'function') spec = spec(hit);
      const headers = { 'content-type': 'application/json' };
      const loc = typeof spec.location === 'function' ? spec.location() : spec.location;
      if (loc !== undefined) headers.location = loc;
      res.writeHead(spec.status ?? 200, headers);
      const b = spec.body;
      res.end(b === undefined ? '{}' : typeof b === 'string' ? b : JSON.stringify(b));
    });
  });
  const closeAll = trackSockets(server);
  const port = await listenInRange(server);
  return {
    port, url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, hits,
    on(method, path, spec) { routes.set(`${method} ${path}`, spec); return this; },
    fallback(spec) { fallbackSpec = spec; return this; },
    clearRoutes() { routes.clear(); fallbackSpec = null; },
    reset() { hits.length = 0; },
    count: (method, path) => hits.filter((h) => h.method === method && h.path === path).length,
    at: (method, path) => hits.filter((h) => h.method === method && h.path === path),
    close: closeAll,
  };
}

/** 模型列表的回应体:同时带 openai / anthropic 风格(data)与 gemini 风格(models),各接口都能解析。 */
export const modelsBody = (ids) => ({ data: ids.map((id) => ({ id })), models: ids.map((id) => ({ name: `models/${id}` })) });
