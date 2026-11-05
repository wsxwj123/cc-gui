// auth-probe 验收测试的共用夹具:假上游 + 小工具。
// 只依赖 node 内置模块,不 import 任何被测代码。
import http from 'node:http';
import { Buffer } from 'node:buffer';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// ---------- 常量(来自接口文件第 1 节) ----------
export const OPENAI_KEY = 'sk-probe-openai-0123456789abcdef';
export const ANTHROPIC_TOKEN = 'tok-probe-anthropic-0123456789abcdef';
export const MODEL = 'probe-model-1'; // 非 claude 开头,不会被改写
export const FILLER_MARKER = 'PROBE-FILLER-BLOCK'; // 填充文本里的特征串
export const BIG_MIN_BYTES = 100 * 1024; // 大请求:体 >= 100 KB
export const SETTLE_MS = 300; // 拿到响应后多等一会儿,抓"多发的第三个请求"

// DeepSeek 对错误 Key 的真实形态(接口文件第 1 节第 5 条)
export const DEEPSEEK_401_BODY =
  '{"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid","type":"authentication_error","param":null,"code":"invalid_request_error"}}';
export const DEEPSEEK_403_BODY =
  '{"error":{"message":"Forbidden: your api key has no permission for this model","type":"permission_error","param":null,"code":"forbidden"}}';

// ---------- 假上游的三类行为 ----------
// reset:收到请求头立刻 destroy 套接字,不读正文,不回任何东西
export const reset = () => ({ kind: 'reset' });
// hang:收下(读完正文)但永不应答
export const hang = () => ({ kind: 'hang' });
// reply:回指定状态码和正文;contentType 传 null 则不带 content-type
export const reply = (status, body = '', contentType = 'application/json', extraHeaders = {}) => ({
  kind: 'reply',
  status,
  body,
  contentType,
  extraHeaders,
});
export const redirectTo = (location) => reply(302, '', null, { location });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 假上游服务 ----------
// 按请求体大小(content-length)分两类:big(>= 100 KB)和 small(其余,含没有 content-length 的 GET)。
// 每类各自配一个行为,用 set() 切换。requests 按到达顺序记录每个请求。
export async function startFakeUpstream({ big = reset(), small = reply(200, '{}') } = {}) {
  const requests = [];
  const sockets = new Set();
  const behaviors = { big, small };

  const respond = (b, res) => {
    if (b.kind === 'hang') return; // 收下但永不应答
    const payload = Buffer.from(b.body ?? '', 'utf8');
    const headers = { connection: 'close', 'content-length': String(payload.length), ...b.extraHeaders };
    if (b.contentType) headers['content-type'] = b.contentType;
    res.writeHead(b.status, headers);
    res.end(payload);
  };

  const server = http.createServer((req, res) => {
    const lenHeader = req.headers['content-length'];
    const contentLength = lenHeader === undefined ? null : Number(lenHeader);
    const klass = contentLength !== null && contentLength >= BIG_MIN_BYTES ? 'big' : 'small';
    const rec = {
      time: Date.now(),
      method: req.method,
      path: req.url, // 含查询串
      authorization: req.headers['authorization'] ?? null,
      xApiKey: req.headers['x-api-key'] ?? null,
      contentLength,
      klass,
      headers: { ...req.headers },
      body: null, // 只有小请求才读
    };
    requests.push(rec);
    const b = behaviors[klass];
    req.on('error', () => {});
    res.on('error', () => {});
    if (b.kind === 'reset') {
      req.socket.destroy(); // 收到头就断,不读正文
      return;
    }
    const chunks = [];
    req.on('data', (c) => {
      if (klass === 'small') chunks.push(c);
    });
    req.on('end', () => {
      if (klass === 'small') rec.body = Buffer.concat(chunks).toString('utf8');
      respond(b, res);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
  });
  server.on('clientError', (_e, s) => s.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  return {
    port,
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    set(next) {
      if (next.big) behaviors.big = next.big;
      if (next.small) behaviors.small = next.small;
    },
    clear() {
      requests.length = 0; // 每次发送前把请求计数清零
    },
    destroyOpenConnections() {
      for (const s of sockets) s.destroy(); // 关掉挂起的连接
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------- 请求体与调用代理 ----------
export function makeFiller(chars) {
  const unit = `${FILLER_MARKER}-0123456789 `;
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

// Anthropic 形态请求体;bigSystem=true 时 system 填充约 117 KB(>= 100 KB 即"大请求")
export function anthropicRequestBody({ stream = false, bigSystem = false, model = MODEL } = {}) {
  const body = {
    model,
    max_tokens: 64,
    stream,
    messages: [{ role: 'user', content: 'ping from auth-probe test' }],
  };
  if (bigSystem) body.system = [{ type: 'text', text: makeFiller(117000) }];
  return body;
}

export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseJsonOrFail(text, label) {
  const parsed = tryParseJson(text);
  if (parsed === undefined) assert.fail(`${label}: 响应正文不是合法 JSON,前 200 字符: ${text.slice(0, 200)}`);
  return parsed;
}

// 向代理发请求。网络层失败/超时一律转成断言失败,方便定位。
export async function callProxy(port, { method = 'POST', path = '/v1/messages', body, headers = {} } = {}) {
  const t0 = Date.now();
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  let res;
  let buf;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': 'client-side-dummy-key',
        ...headers,
      },
      body: payload,
      signal: AbortSignal.timeout(30000),
    });
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    assert.fail(`向代理发 ${method} ${path} 没拿到完整响应(${Date.now() - t0}ms): ${e?.name}: ${e?.message}`);
  }
  const text = buf.toString('utf8');
  return {
    status: res.status,
    headers: res.headers,
    buf,
    text,
    json: tryParseJson(text),
    elapsedMs: Date.now() - t0,
    // 头+正文拼成一段文本,供"密钥不外泄"扫描用
    dump: `${res.status} ${JSON.stringify([...res.headers.entries()])}\n${text}`,
  };
}

// ---------- 通用断言 ----------
export function assertShouldRetryFalse(res, label) {
  assert.equal(res.headers.get('x-should-retry'), 'false', `${label}: 响应头 x-should-retry 应为 false,实际为 ${res.headers.get('x-should-retry')}`);
}

export function assertNoShouldRetryFalse(res, label) {
  assert.notEqual(res.headers.get('x-should-retry'), 'false', `${label}: 不应带 x-should-retry: false`);
}

export function assertUpstreamCount(upstream, expected, label) {
  assert.equal(upstream.requests.length, expected, `${label}: 假上游应收到 ${expected} 个请求,实际 ${upstream.requests.length} 个`);
}

// 主请求失败 + 探测失败/其它状态 => 502 + 不带 x-should-retry:false + message 以 upstream fetch failed 开头
export function assertUpstreamFetchFailed502(res, label) {
  assert.equal(res.status, 502, `${label}: 应回 502,实际 ${res.status}`);
  assertNoShouldRetryFalse(res, label);
  const message = res.json?.error?.message;
  assert.equal(typeof message, 'string', `${label}: 502 正文应为 {error:{message}} 形态,实际 ${res.text.slice(0, 200)}`);
  assert.ok(message.startsWith('upstream fetch failed'), `${label}: message 应以 "upstream fetch failed" 开头,实际 ${message.slice(0, 120)}`);
}

// 探测请求的外部特征(接口文件第 3 节"探测请求"各条里与代理种类无关的部分)。
// 认证头因代理而异,由调用方另行断言。要求假上游里第 1 个是被重置的大请求,第 2 个是探测。
export function assertProbeShape(upstream, { label, path, model = MODEL }) {
  const reqs = upstream.requests;
  assert.equal(reqs.length, 2, `${label}: 假上游应收到 2 个请求(被重置的大请求 + 1 个探测),实际 ${reqs.length} 个`);
  const [main, probe] = reqs;
  assert.ok(main.contentLength >= BIG_MIN_BYTES, `${label}: 第 1 个请求应是大请求,实际 content-length=${main.contentLength}`);
  assert.equal(probe.method, 'POST', `${label}: 探测方法应为 POST,实际 ${probe.method}`);
  assert.equal(probe.path, path, `${label}: 探测路径应恰为 ${path},实际 ${probe.path}`);
  assert.equal(typeof probe.body, 'string', `${label}: 探测应带正文`);
  const size = Buffer.byteLength(probe.body, 'utf8');
  assert.ok(size > 0 && size < 1024, `${label}: 探测正文应小于 1 KB,实际 ${size} 字节`);
  assert.ok(!probe.body.includes(FILLER_MARKER), `${label}: 探测正文不应含大请求里的填充文本`);
  const parsed = parseJsonOrFail(probe.body, `${label}(探测正文)`);
  const users = Array.isArray(parsed.messages) ? parsed.messages.filter((m) => m?.role === 'user') : [];
  assert.equal(users.length, 1, `${label}: 探测应恰好一条 role 为 user 的消息,实际 ${users.length} 条`);
  assert.ok(Number.isInteger(parsed.max_tokens) && parsed.max_tokens >= 1 && parsed.max_tokens <= 16, `${label}: max_tokens 应是 1-16 的整数,实际 ${parsed.max_tokens}`);
  assert.notEqual(parsed.stream, true, `${label}: 探测的 stream 不应为 true`);
  assert.equal(parsed.model, model, `${label}: 探测的 model 应与主请求相同(${model}),实际 ${parsed.model}`);
  return { main, probe, parsed };
}

// ---------- 输出捕获(给"密钥不外泄"用例用) ----------
// 包一层 process.stdout/stderr.write:内容照常放行,同时记下来。stop() 还原并返回捕获到的全部文本。
export function startCapture() {
  const chunks = [];
  const streams = [process.stdout, process.stderr];
  const originals = streams.map((s) => s.write);
  streams.forEach((s, i) => {
    s.write = function patchedWrite(chunk, ...rest) {
      try {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1'));
      } catch {
        // 捕获失败不能影响原输出
      }
      return originals[i].call(s, chunk, ...rest);
    };
  });
  return {
    stop() {
      streams.forEach((s, i) => {
        s.write = originals[i];
      });
      return chunks.join('\n');
    },
  };
}

// ---------- 用例登记与进程退出 ----------
// 代理模块是进程内单例且没有关闭函数,监听口会让 node --test 的子进程一直不退出,
// 所以最后一个钩子里关掉假上游,稍等报告写完,再按"有无失败"强制退出。
export function createSuite({ perTestMs = 45000 } = {}) {
  let failed = false;
  const withTimeout = (promise, name) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`用例超过 ${perTestMs}ms 仍未结束: ${name}`)), perTestMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  return {
    add(name, fn) {
      test(name, { timeout: perTestMs + 15000 }, async () => {
        try {
          await withTimeout(Promise.resolve().then(fn), name);
        } catch (e) {
          failed = true;
          throw e;
        }
      });
    },
    finish(closeAll) {
      after(async () => {
        try {
          await closeAll();
        } catch {
          // 关闭失败也要继续走到强制退出
        } finally {
          setTimeout(() => process.exit(failed || process.exitCode ? 1 : 0), 500);
        }
      });
    },
  };
}
