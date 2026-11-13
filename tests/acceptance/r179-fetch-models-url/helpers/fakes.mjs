// r179 · 本机假上游 + 假代理(都只听 127.0.0.1,端口在 6700–6999 里挑空闲的,不碰 6677/6689/6710 等保留口)。
// 假上游只记两样:收到的请求路径、鉴权头(authorization / x-api-key / x-goog-api-key)。
import http from 'node:http';
import net from 'node:net';

const FORBIDDEN = new Set([6677, 6689, 6710]);

/** 在 6700–6999 里从随机起点开始找一个能绑上的端口并监听。 */
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
  throw new Error('6700–6999 没有空闲端口给假上游 / 假代理');
}

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); });
}

/**
 * 假上游。kind:
 *   'openai' :GET <任意前缀>/models → { data:[{ id, context_length? }] }
 *   'gemini' :GET <任意前缀>/models → 没带 x-goog-api-key 回 401;带了回 { models:[{ name:'models/<id>' }] }
 * mode:'ok'(默认)| 'echo401'(一律 401,正文里回显收到的鉴权头,用来验证 Key 被打码)
 * models:[{ id, window? }]
 */
export async function startUpstream({ kind = 'openai', models = [], mode = 'ok' } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const hit = { path: pathname, auth: String(req.headers.authorization || ''), xkey: String(req.headers['x-api-key'] || ''), xgoog: String(req.headers['x-goog-api-key'] || '') };
    hits.push(hit);
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'GET' || !/\/models$/.test(pathname)) { send(404, { error: 'not found' }); return; }
    if (mode === 'echo401') { send(401, { error: { message: `invalid credentials: authorization=${hit.auth} x-api-key=${hit.xkey} x-goog-api-key=${hit.xgoog}` } }); return; }
    if (kind === 'gemini') {
      if (!hit.xgoog) { send(401, { error: 'API key required' }); return; }
      send(200, { models: models.map((m) => ({ name: `models/${m.id}` })) });
      return;
    }
    send(200, { data: models.map((m) => (m.window ? { id: m.id, context_length: m.window } : { id: m.id })) });
  });
  const closeAll = trackSockets(server);
  const port = await listenInRange(server);
  return {
    port, url: `http://127.0.0.1:${port}`, hits,
    reset: () => { hits.length = 0; },
    /** 请求里是否出现过这把 Key(Bearer / x-api-key / x-goog-api-key 三种头都看)。 */
    sawKey: (key) => hits.some((h) => h.auth === `Bearer ${key}` || h.xkey === key || h.xgoog === key),
    /** 每个请求是否都带着这把 Key。 */
    allCarry: (key) => hits.length > 0 && hits.every((h) => h.auth === `Bearer ${key}` || h.xkey === key || h.xgoog === key),
    close: closeAll,
  };
}

/** 假 HTTP 代理:记录 CONNECT 的目标(也兼容绝对 URI 请求行)。targets 里是 'host:port'。 */
export async function startProxy() {
  const targets = [];
  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); res.end('not an absolute URI'); return; }
    targets.push(`${u.hostname}:${u.port || 80}`);
    const fwd = http.request({ host: u.hostname, port: u.port || 80, path: `${u.pathname}${u.search}`, method: req.method, headers: req.headers }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    fwd.on('error', () => { res.writeHead(502); res.end('proxy upstream error'); });
    req.pipe(fwd);
  });
  server.on('connect', (req, socket, head) => {
    targets.push(String(req.url));
    const [host, p] = String(req.url).split(':');
    const upstream = net.connect(Number(p), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  const closeAll = trackSockets(server);
  const port = await listenInRange(server);
  return {
    port, url: `http://127.0.0.1:${port}`, targets,
    reset: () => { targets.length = 0; },
    /** 是否有请求经这个代理去了某台上游。 */
    reached: (upstream) => targets.includes(`127.0.0.1:${upstream.port}`),
    close: closeAll,
  };
}
