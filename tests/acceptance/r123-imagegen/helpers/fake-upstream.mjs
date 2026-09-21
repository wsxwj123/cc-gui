// r123 · 本地假上游 / 假图片服务 / 跨源诱饵,全部只绑 127.0.0.1、端口只在 6700–6999。
//   假上游:按"路径前缀"切换脚本(每条用例注册自己的前缀,互不串);带控制口
//          GET  /__control/health                 → {ok:true}
//          GET  /__control/requests?prefix=/xxx   → {requests:[{method,path,search,auth,body,at}]} 收到过哪些请求
//          POST /__control/reset                  → 清空请求日志
//   假图片口(与假上游同一个监听口):GET /__img/<任意>.png → 1×1 PNG;GET /__img/<任意>.webp → 1×1 WebP;也记请求日志。
//     为什么不单独起一个端口:探路实测(P3)产品只肯下载与提供方基址同 host:port 的 http 图片链接
//     (回环但端口不同的链接被拒:「拒绝下载该链接:公网 baseURL 必须使用 https…」),所以图片必须挂在上游同源之下。
//   诱饵(A3 跨源用):任何请求都回"已完成 + 有图"(让不守同源的实现快速跑完、被断言抓住,而不是挂死);记请求日志。
// 脚本处理函数签名:(ctx) => {status?, type?, headers?, body}
//   ctx = { method, path(前缀之后的余下路径,以 / 开头或为空), search, headers, bodyText, json, hits(同一 method+path 第几次被打,从 1 起) }
//   body 是对象 → JSON;字符串 / Buffer → 原样。
import http from 'node:http';
import { freePort, okPort } from './ports.mjs';
import { PNG, WEBP } from './images.mjs';

const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => resolve(s)); });
const record = (log, req, url, bodyText) => {
  const rec = {
    method: req.method, path: url.pathname, search: url.search,
    auth: req.headers.authorization || null,
    googKey: req.headers['x-goog-api-key'] || null,
    contentType: req.headers['content-type'] || null,
    body: (bodyText || '').slice(0, 4096), at: Date.now(),
  };
  log.push(rec);
  return rec;
};
function send(res, out) {
  const status = out.status ?? 200;
  const headers = { ...(out.headers || {}) };
  let body = out.body;
  if (Buffer.isBuffer(body)) { headers['content-type'] = headers['content-type'] || out.type || 'application/octet-stream'; }
  else if (typeof body === 'string') { headers['content-type'] = headers['content-type'] || out.type || 'text/plain; charset=utf-8'; }
  else { body = JSON.stringify(body ?? {}); headers['content-type'] = headers['content-type'] || out.type || 'application/json; charset=utf-8'; }
  res.writeHead(status, headers);
  res.end(body);
}
const listenOn = (server, port) => new Promise((resolve, reject) => {
  if (!okPort(port)) { reject(new Error(`端口 ${port} 不在允许范围(6700–6999,且不碰 6677/6689/6710)`)); return; }
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(port));
});
const closeOf = (server) => new Promise((r) => server.close(() => r()));

/** 假上游:按前缀注册脚本 + 控制口。 */
export function createFakeUpstream() {
  const requests = [];
  const scenarios = new Map();     // prefix → handler
  const hitCounter = new Map();    // `${prefix} ${method} ${path}` → n
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-upstream');
    const bodyText = await readBody(req);
    record(requests, req, url, bodyText);
    if (url.pathname.startsWith('/__control/')) {
      const op = url.pathname.slice('/__control/'.length);
      if (op === 'health') return send(res, { body: { ok: true, scenarios: [...scenarios.keys()] } });
      if (op === 'requests') {
        const prefix = url.searchParams.get('prefix') || '';
        const list = requests.filter((r) => !r.path.startsWith('/__control/') && (!prefix || r.path === prefix || r.path.startsWith(`${prefix}/`)));
        return send(res, { body: { requests: list } });
      }
      if (op === 'reset' && req.method === 'POST') { requests.length = 0; hitCounter.clear(); return send(res, { body: { ok: true } }); }
      return send(res, { status: 404, body: { error: 'unknown control op' } });
    }
    if (/^\/__img\/[^/]+\.png$/.test(url.pathname)) return send(res, { type: 'image/png', body: PNG });
    if (/^\/__img\/[^/]+\.webp$/.test(url.pathname)) return send(res, { type: 'image/webp', body: WEBP });
    // 最长前缀优先
    const prefixes = [...scenarios.keys()].filter((p) => url.pathname === p || url.pathname.startsWith(`${p}/`)).sort((a, b) => b.length - a.length);
    if (!prefixes.length) return send(res, { status: 404, body: { error: { message: `fake upstream: no scenario for ${req.method} ${url.pathname}` } } });
    const prefix = prefixes[0];
    const rest = url.pathname.slice(prefix.length);
    const key = `${prefix} ${req.method} ${rest}`;
    const hits = (hitCounter.get(key) || 0) + 1;
    hitCounter.set(key, hits);
    let json = null; try { json = bodyText ? JSON.parse(bodyText) : null; } catch { /* 非 JSON */ }
    try {
      const out = await scenarios.get(prefix)({ method: req.method, path: rest, search: url.search, headers: req.headers, bodyText, json, hits });
      if (!out) return send(res, { status: 404, body: { error: { message: `fake upstream: scenario ${prefix} declined ${req.method} ${rest}` } } });
      return send(res, out);
    } catch (e) {
      return send(res, { status: 500, body: { error: { message: `fake upstream scenario threw: ${e?.message || e}` } } });
    }
  });
  return {
    server, requests,
    base: '',
    async listen() { const port = await freePort(6800); await listenOn(server, port); this.base = `http://127.0.0.1:${port}`; return this.base; },
    close: () => closeOf(server),
    /** 注册一个前缀脚本;返回该前缀在假上游上的完整基址(含前缀)。 */
    scenario(prefix, handler) { if (!prefix.startsWith('/')) throw new Error('prefix 须以 / 开头'); scenarios.set(prefix, handler); return `${this.base}${prefix}`; },
    /** 走控制口(不是直接读内存)查某前缀收到过哪些请求。 */
    async received(prefix) {
      const r = await fetch(`${this.base}/__control/requests?prefix=${encodeURIComponent(prefix)}`);
      return (await r.json()).requests;
    },
    /** 假图片链接(与上游同源)。 */
    img(name = 'a', ext = 'png') { return `${this.base}/__img/${name}.${ext}`; },
    /** 图片口收到过哪些下载请求。 */
    imageRequests() { return this.received('/__img'); },
  };
}

/** 跨源诱饵:另一个端口;任何请求都回"完成 + 有图"(图片地址由调用方给),并记日志。 */
export function createDecoy(imageUrl) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://decoy');
    record(requests, req, url, await readBody(req));
    return send(res, { body: { id: 'decoy', status: 'completed', result: { data: [{ url: imageUrl }] }, data: [{ url: imageUrl }], url: imageUrl } });
  });
  return {
    server, requests, base: '',
    async listen() { const port = await freePort(6900); await listenOn(server, port); this.base = `http://127.0.0.1:${port}`; return this.base; },
    close: () => closeOf(server),
  };
}
