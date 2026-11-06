// 单测:auth-probe 白盒 —— isConnectPhaseError 判定、probeUpstreamAuth 读取上限/非 401 处理/不跟随跳转、
// OpenAI 代理端到端(大请求被重置 → 探测 401 → message 截 500)。只用 127.0.0.1 临时端口假服务,不打外网。
// 先把 HOME/USERPROFILE 指到临时空目录,再动态 import 代理模块(代理会按 HOME 读用户级 settings.json)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-probe-unit-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const assert = (await import('node:assert/strict')).default;
const http = await import('node:http');
const { isConnectPhaseError, probeUpstreamAuth, startOpenAIProxy, setOpenAIUpstream } = await import('../../server/services/openai-proxy.js');

const listen = (handler) => new Promise((resolve) => {
  const srv = http.createServer(handler);
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});
const baseOf = (srv) => `http://127.0.0.1:${srv.address().port}`;
const servers = [];

// a) isConnectPhaseError
{
  assert.equal(isConnectPhaseError({ code: 'ECONNREFUSED' }), true, 'a: err.code 命中');
  assert.equal(isConnectPhaseError({ cause: { code: 'ENOTFOUND' } }), true, 'a: err.cause.code 命中');
  const agg = new AggregateError([{ code: 'EHOSTUNREACH' }, { code: 'ENETUNREACH' }], 'connect failed');
  assert.equal(isConnectPhaseError({ cause: agg }), true, 'a: AggregateError errors 命中');
  for (const code of ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']) {
    assert.equal(isConnectPhaseError({ cause: { code } }), false, `a: ${code} 不得排除`);
  }
  assert.equal(isConnectPhaseError(null), false, 'a: null');
  assert.equal(isConnectPhaseError({}), false, 'a: 空对象');
  assert.equal(isConnectPhaseError(new TypeError('fetch failed')), false, 'a: 无 cause');
}

// b) probeUpstreamAuth
{
  // 401 + 200000 字节正文 → 截到 64 KB
  const big = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(200000, 0x61));
    });
  });
  servers.push(big);
  const r1 = await probeUpstreamAuth(baseOf(big) + '/chat/completions', { 'content-type': 'application/json' }, 'probe-model-1');
  assert.ok(r1, 'b: 401 应返回结果');
  assert.equal(r1.status, 401);
  assert.equal(r1.body.length, 65536, 'b: 正文读取上限 64 KB');

  // 200 → null
  const ok = await listen((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  servers.push(ok);
  assert.equal(await probeUpstreamAuth(baseOf(ok) + '/chat/completions', {}, 'm'), null, 'b: 200 返回 null');

  // 302 → null,且 Location 指向的服务收到 0 个请求
  let elsewhereHits = 0;
  const elsewhere = await listen((req, res) => { elsewhereHits++; req.resume(); res.writeHead(401); res.end(); });
  servers.push(elsewhere);
  const redirector = await listen((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(302, { location: baseOf(elsewhere) + '/steal' }); res.end(); });
  });
  servers.push(redirector);
  assert.equal(await probeUpstreamAuth(baseOf(redirector) + '/chat/completions', {}, 'm'), null, 'b: 302 返回 null');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(elsewhereHits, 0, 'b: 不得跟随 Location');
}

// c) OpenAI 代理端到端:大请求被重置,探测 401 带 2000 字 message → 回 401 且 message 截 500
{
  const longMsg = '错'.repeat(2000);
  const fake = await listen((req, res) => {
    if (Number(req.headers['content-length'] || 0) >= 100 * 1024) { req.socket.destroy(); return; }
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: longMsg, type: 'authentication_error' } }));
    });
  });
  servers.push(fake);
  setOpenAIUpstream({ baseURL: baseOf(fake), apiKey: 'sk-unit-test-dummy' });
  const port = await startOpenAIProxy(0);
  const reqBody = {
    model: 'probe-model-1', max_tokens: 16, stream: false,
    system: 'x'.repeat(117 * 1024),
    messages: [{ role: 'user', content: 'hi' }],
  };
  const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqBody),
  });
  assert.equal(resp.status, 401, 'c: 应回 401');
  assert.equal(resp.headers.get('x-should-retry'), 'false', 'c: 应带 x-should-retry:false');
  const j = await resp.json();
  assert.equal(j.error.message.length, 500, 'c: message 截到 500');
}

// d) 接线:主请求 fetch 抛错后,连接阶段错误与 AbortError 不探测,其它网络错误才探测(两个代理各测)。
// 换掉 globalThis.fetch:发往代理自身(127.0.0.1:<代理端口>)的放行给真 fetch;其余视为发往上游,
// 记进 calls 并按脚本抛错或返回合成 Response。上游地址 http://upstream.invalid,不发真实网络请求。
{
  const { startAnthropicProxy, setAnthropicUpstream } = await import('../../server/services/anthropic-proxy.js');
  const upstreamBase = 'http://upstream.invalid';
  const connectErr = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const abortErr = () => new DOMException('This operation was aborted', 'AbortError');
  const socketErr = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  const auth401 = () => new Response('{"error":{"message":"Authentication Fails"}}', { status: 401, headers: { 'content-type': 'application/json' } });
  const minimalBody = JSON.stringify({ model: 'probe-model-1', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

  const realFetch = globalThis.fetch;
  // script[i] 决定第 i 次上游调用的结果:返回 Response 或抛错;脚本外的调用一律抛错(探测会得 null → 502)。
  const runCase = async (proxyPort, { method = 'POST', urlPath = '/v1/messages' }, script) => {
    const proxyPrefix = `http://127.0.0.1:${proxyPort}`;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : (input?.url ?? String(input));
      if (target.startsWith(proxyPrefix)) return realFetch(input, init);
      calls.push(target);
      const step = script[calls.length - 1];
      if (!step) throw new TypeError('unscripted upstream call: ' + target);
      return step();
    };
    try {
      const resp = await realFetch(proxyPrefix + urlPath, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
        body: method === 'POST' ? minimalBody : undefined,
      });
      const text = await resp.text();
      return { status: resp.status, shouldRetry: resp.headers.get('x-should-retry'), text, calls };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const throwing = (mk) => () => { throw mk(); };
  const messageOf = (text) => { try { return JSON.parse(text)?.error?.message ?? ''; } catch { return ''; } };

  const proxies = [];
  setOpenAIUpstream({ baseURL: upstreamBase, apiKey: 'sk-unit-test-dummy' });
  proxies.push({ name: 'openai', port: await startOpenAIProxy(0) }); // c) 已起过,返回同一实例端口
  setAnthropicUpstream({ baseURL: upstreamBase, authToken: 'sk-unit-test-dummy' });
  proxies.push({ name: 'anthropic', port: await startAnthropicProxy(0) });

  for (const { name, port } of proxies) {
    assert.ok(port > 0, `d/${name}: 代理应起在临时端口`);

    const r1 = await runCase(port, {}, [throwing(connectErr)]);
    assert.equal(r1.calls.length, 1, `d/${name}/连接阶段错误: 上游调用应恰为 1 次(不探测),实际 ${r1.calls.length}: ${r1.calls.join(', ')}`);
    assert.equal(r1.status, 502, `d/${name}/连接阶段错误: 应回 502,实际 ${r1.status}`);
    assert.ok(messageOf(r1.text).startsWith('upstream fetch failed'), `d/${name}/连接阶段错误: message 应以 upstream fetch failed 开头,实际 ${r1.text}`);

    const r2 = await runCase(port, {}, [throwing(abortErr)]);
    assert.equal(r2.calls.length, 1, `d/${name}/AbortError: 上游调用应恰为 1 次(不探测),实际 ${r2.calls.length}: ${r2.calls.join(', ')}`);
    assert.equal(r2.status, 502, `d/${name}/AbortError: 应回 502,实际 ${r2.status}`);
    assert.ok(messageOf(r2.text).startsWith('upstream fetch failed'), `d/${name}/AbortError: message 应以 upstream fetch failed 开头,实际 ${r2.text}`);

    const r3 = await runCase(port, {}, [throwing(socketErr), auth401]);
    assert.equal(r3.calls.length, 2, `d/${name}/UND_ERR_SOCKET: 上游调用应恰为 2 次(主请求+探测),实际 ${r3.calls.length}: ${r3.calls.join(', ')}`);
    assert.equal(r3.status, 401, `d/${name}/UND_ERR_SOCKET: 探测得 401 应回 401,实际 ${r3.status} ${r3.text}`);
    assert.equal(r3.shouldRetry, 'false', `d/${name}/UND_ERR_SOCKET: 应带 x-should-retry:false,实际 ${r3.shouldRetry}`);

    if (name === 'anthropic') {
      const r4 = await runCase(port, { method: 'GET', urlPath: '/v1/models' }, [throwing(socketErr)]);
      assert.equal(r4.calls.length, 1, `d/anthropic/GET /v1/models: 非 POST /v1/messages 不探测,上游调用应恰为 1 次,实际 ${r4.calls.length}: ${r4.calls.join(', ')}`);
      assert.equal(r4.status, 502, `d/anthropic/GET /v1/models: 应回 502,实际 ${r4.status}`);
    }
  }
}

for (const s of servers) s.closeAllConnections?.(), s.close();
fs.rmSync(tmpHome, { recursive: true, force: true });
console.log('check-auth-probe-connect-phase: all assertions passed');
process.exit(0);
