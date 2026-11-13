// r178b 套件的辅助:假上游(本机 HTTP 服务)与向代理发请求的小客户端。
// 假上游对 POST .../chat/completions 按"当前设定"原样回:状态码、Content-Type、响应体。
// 不记录、不打印请求头;只监听 127.0.0.1 的空闲端口。
import http from 'node:http';

export function startFakeUpstream() {
  // 当前设定:每次发请求前由 callProxy 写入
  let current = { status: 200, contentType: undefined, body: '' };
  const server = http.createServer((req, res) => {
    // 把请求体读掉再回,避免连接被半路掐断
    req.on('data', () => {});
    req.on('end', () => {
      if (req.method !== 'POST' || !String(req.url).endsWith('/chat/completions')) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = current.status;
      if (current.contentType !== undefined) res.setHeader('content-type', current.contentType);
      res.end(Buffer.from(current.body, 'utf8'));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        setResponse(next) {
          current = { status: 200, contentType: undefined, body: '', ...next };
        },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

// 向代理的 POST /v1/messages 发一次请求,返回 { status, headers, text }
export function postMessages(proxyPort, { stream }) {
  const payload = JSON.stringify({
    model: 'test-model',
    max_tokens: 64,
    stream,
    messages: [{ role: 'user', content: '你好' }],
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: '/v1/messages',
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'k',
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          complete: res.complete,
        }));
        res.on('error', reject);
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error('请求代理超时(20 秒)')));
    req.on('error', reject);
    req.end(payload);
  });
}

// 解析 SSE 文本:返回 [{ event, data(解析后的 JSON,不是 JSON 时为原文) }]
export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = null;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (event === null && dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    let data = raw;
    try { data = JSON.parse(raw); } catch { /* 保留原文 */ }
    events.push({ event, data });
  }
  return events;
}
