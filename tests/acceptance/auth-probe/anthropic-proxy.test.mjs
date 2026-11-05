// Anthropic 代理(server/services/anthropic-proxy.js)验收测试 T1-T12。
// 只通过接口文件第 0 节的公开入口调用:startAnthropicProxy / setAnthropicUpstream + HTTP 口。
// 运行: env -u http_proxy -u https_proxy node --test 'tests/acceptance/auth-probe/*.test.mjs'
import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ANTHROPIC_TOKEN as TOKEN,
  DEEPSEEK_401_BODY,
  DEEPSEEK_403_BODY,
  SETTLE_MS,
  startFakeUpstream,
  reset,
  hang,
  reply,
  redirectTo,
  sleep,
  anthropicRequestBody,
  callProxy,
  startCapture,
  createSuite,
  assertShouldRetryFalse,
  assertNoShouldRetryFalse,
  assertUpstreamCount,
  assertUpstreamFetchFailed502,
  assertProbeShape,
} from './lib/fake-upstream.mjs';

// ---- 环境隔离:必须先于动态 import 代理模块 ----
const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'auth-probe-anthropic-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY']) {
  delete process.env[k];
}
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

// ---- 启动:假上游 + 另一个假服务(给重定向用) + 代理(端口传 0) ----
let upstream;
let redirectTarget;
let proxyPort;
let setAnthropicUpstream;
try {
  const mod = await import(new URL('../../../server/services/anthropic-proxy.js', import.meta.url).href);
  setAnthropicUpstream = mod.setAnthropicUpstream;
  upstream = await startFakeUpstream();
  // 重定向目标:不管收到什么都回 401。万一代理跟随了重定向,既会被计数也会让状态码变成 401。
  redirectTarget = await startFakeUpstream({ big: reply(401, DEEPSEEK_401_BODY), small: reply(401, DEEPSEEK_401_BODY) });
  setAnthropicUpstream({ baseURL: upstream.baseURL, authToken: TOKEN });
  proxyPort = Number(await mod.startAnthropicProxy(0));
  assert.ok(Number.isInteger(proxyPort) && proxyPort > 0, `startAnthropicProxy(0) 应返回监听端口号,实际 ${proxyPort}`);
} catch (e) {
  console.error('[auth-probe] anthropic 测试启动失败:', e);
  process.exit(1);
}

const suite = createSuite();

// 每个用例开头调用:换上游行为、清请求记录,用例之间互不依赖
function arrange({ big = reset(), small = reply(200, '{}') } = {}) {
  upstream.destroyOpenConnections();
  upstream.clear();
  upstream.set({ big, small });
  setAnthropicUpstream({ baseURL: upstream.baseURL, authToken: TOKEN });
}
const MESSAGES_PATH = '/v1/messages?beta=true'; // claude 命令行的真实路径
const sendBig = (stream = true) => callProxy(proxyPort, { path: MESSAGES_PATH, body: anthropicRequestBody({ stream, bigSystem: true }) });
const sendSmall = (stream = false) => callProxy(proxyPort, { path: MESSAGES_PATH, body: anthropicRequestBody({ stream }) });

// 探测得 401/403 时:状态码、头、正文都要和探测响应一致,外加 x-should-retry:false
function assertForwardedProbeError(res, { label, status, body }) {
  assert.equal(res.status, status, `${label}: 探测得 ${status} 后应回 ${status},实际 ${res.status}`);
  assertShouldRetryFalse(res, label);
  assert.equal(res.headers.get('content-type'), 'application/json', `${label}: content-type 应与探测响应相同(application/json),实际 ${res.headers.get('content-type')}`);
  assert.equal(res.headers.get('cache-control'), 'no-cache', `${label}: cache-control 应为 no-cache,实际 ${res.headers.get('cache-control')}`);
  assert.ok(res.buf.equals(Buffer.from(body, 'utf8')), `${label}: 正文应与探测响应正文逐字节相同,实际 ${res.text.slice(0, 200)}`);
}

// ================= T1-T3:探测得到 401/403 =================
suite.add('T1 大请求被重置、探测回401: 回401+x-should-retry:false,头与正文同探测响应,假上游共收到2个请求', async () => {
  arrange({ small: reply(401, DEEPSEEK_401_BODY) });
  const res = await sendBig(true);
  await sleep(SETTLE_MS);
  assertForwardedProbeError(res, { label: 'T1', status: 401, body: DEEPSEEK_401_BODY });
  assertUpstreamCount(upstream, 2, 'T1');
});

suite.add('T2 大请求被重置、探测回403: 回403+x-should-retry:false+正文原样', async () => {
  arrange({ small: reply(403, DEEPSEEK_403_BODY) });
  const res = await sendBig(true);
  await sleep(SETTLE_MS);
  assertForwardedProbeError(res, { label: 'T2', status: 403, body: DEEPSEEK_403_BODY });
  assertUpstreamCount(upstream, 2, 'T2');
});

suite.add('T3 探测请求的外部特征: POST /v1/messages(无查询串)、x-api-key与Bearer同Key、有anthropic-version、小于1KB不含填充、1条user、max_tokens 1-16、model相同', async () => {
  arrange({ small: reply(401, DEEPSEEK_401_BODY) });
  await sendBig(true);
  await sleep(SETTLE_MS);
  const { main, probe } = assertProbeShape(upstream, { label: 'T3', path: '/v1/messages' });
  assert.equal(probe.xApiKey, TOKEN, 'T3: 探测的 x-api-key 应为 authToken');
  assert.equal(probe.authorization, `Bearer ${TOKEN}`, 'T3: 探测的 authorization 应为 Bearer <authToken>');
  assert.ok(probe.headers['anthropic-version'], 'T3: 探测应带 anthropic-version 头');
  assert.equal(main.xApiKey, probe.xApiKey, 'T3: 探测与主请求应使用同一把 Key(x-api-key)');
  assert.equal(main.authorization, probe.authorization, 'T3: 探测与主请求应使用同一把 Key(authorization)');
});

// ================= T4-T8:探测失败/其它状态/非 messages 请求 => 502 =================
suite.add('T4 大请求被重置、探测也被重置: 回502、不带x-should-retry:false、message以upstream fetch failed开头', async () => {
  arrange({ small: reset() });
  const res = await sendBig(true);
  await sleep(SETTLE_MS);
  assertUpstreamFetchFailed502(res, 'T4');
  assert.match(res.headers.get('content-type') ?? '', /application\/json/, 'T4: 502 的 content-type 应含 application/json');
  assert.ok(upstream.requests.length <= 2, `T4: 一个失败的主请求最多触发一个探测,假上游实际收到 ${upstream.requests.length} 个请求`);
});

const ANTHROPIC_OK_BODY =
  '{"id":"msg_probe_ok","type":"message","role":"assistant","model":"probe-model-1","content":[{"type":"text","text":"pong"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}';

suite.add('T5 大请求被重置、探测回200/400/404/429/500: 每次都回502且不带x-should-retry:false', async () => {
  arrange();
  const cases = [
    [200, ANTHROPIC_OK_BODY],
    [400, '{"type":"error","error":{"type":"invalid_request_error","message":"probe says bad request"}}'],
    [404, '{"type":"error","error":{"type":"not_found_error","message":"probe says not found"}}'],
    [429, '{"type":"error","error":{"type":"rate_limit_error","message":"probe says rate limited"}}'],
    [500, '{"type":"error","error":{"type":"api_error","message":"probe says internal error"}}'],
  ];
  for (const [status, body] of cases) {
    const label = `T5 探测回${status}`;
    upstream.clear();
    upstream.set({ small: reply(status, body) });
    const res = await sendBig(true);
    await sleep(SETTLE_MS);
    assertUpstreamFetchFailed502(res, label);
    assert.ok(upstream.requests.length <= 2, `${label}: 假上游实际收到 ${upstream.requests.length} 个请求,最多应为 2`);
  }
});

suite.add('T6 大请求被重置、探测收下不应答: 回502,且从发请求到收到响应不超过11秒', async () => {
  arrange({ small: hang() });
  try {
    const res = await sendBig(true);
    assert.ok(res.elapsedMs <= 11000, `T6: 从发出请求到收到响应应不超过 11 秒,实际 ${res.elapsedMs}ms`);
    assertUpstreamFetchFailed502(res, 'T6');
  } finally {
    upstream.destroyOpenConnections(); // 关掉挂起的探测连接
  }
});

suite.add('T7 大请求被重置、探测回302指向另一个服务: 回502,另一个服务收到0个请求(不跟随重定向)', async () => {
  arrange({ small: redirectTo(`${redirectTarget.baseURL}/redirect-target`) });
  redirectTarget.clear();
  const res = await sendBig(true);
  await sleep(SETTLE_MS);
  assert.equal(res.status, 502, `T7: 探测回 302 属于"其它状态",应回 502,实际 ${res.status}`);
  assertNoShouldRetryFalse(res, 'T7');
  assert.equal(redirectTarget.requests.length, 0, `T7: 不应跟随重定向,另一个假服务应收到 0 个请求,实际 ${redirectTarget.requests.length} 个`);
});

suite.add('T8 GET /v1/models 遇上游重置连接: 回502、message以upstream fetch failed开头,且不发探测(假上游只收到1个请求)', async () => {
  arrange({ big: reset(), small: reset() });
  const res = await callProxy(proxyPort, { method: 'GET', path: '/v1/models' });
  await sleep(SETTLE_MS);
  assertUpstreamFetchFailed502(res, 'T8');
  assertUpstreamCount(upstream, 1, 'T8');
  assert.equal(upstream.requests[0]?.method, 'GET', 'T8: 假上游收到的唯一请求应是被转发的 GET');
  assert.equal(upstream.requests[0]?.path, '/v1/models', 'T8: 假上游收到的唯一请求路径应是 /v1/models');
});

// ================= T9-T11:上游直接回应(不走探测) =================
suite.add('T9 上游对POST /v1/messages正常回200+JSON: 代理原样回200和该JSON,假上游只收到1个请求', async () => {
  arrange({ small: reply(200, ANTHROPIC_OK_BODY) });
  const res = await callProxy(proxyPort, { path: '/v1/messages', body: anthropicRequestBody({ stream: false }) });
  await sleep(SETTLE_MS);
  assert.equal(res.status, 200, `T9: 上游 200 时代理应回 200,实际 ${res.status}`);
  assert.equal(res.text, ANTHROPIC_OK_BODY, `T9: 代理应原样回上游的 JSON,实际 ${res.text.slice(0, 200)}`);
  assertNoShouldRetryFalse(res, 'T9');
  assertUpstreamCount(upstream, 1, 'T9');
});

suite.add('T10 上游对主请求直接回401: 代理回401+正文原样+x-should-retry:false,且不发探测', async () => {
  arrange({ small: reply(401, DEEPSEEK_401_BODY) });
  const res = await sendSmall(false);
  await sleep(SETTLE_MS);
  assert.equal(res.status, 401, `T10: 上游直接回 401 时代理应回 401,实际 ${res.status}`);
  assert.ok(res.buf.equals(Buffer.from(DEEPSEEK_401_BODY, 'utf8')), `T10: 正文应与上游原样一致,实际 ${res.text.slice(0, 200)}`);
  assertShouldRetryFalse(res, 'T10');
  assert.equal(res.headers.get('cache-control'), 'no-cache', `T10: cache-control 应为 no-cache,实际 ${res.headers.get('cache-control')}`);
  assertUpstreamCount(upstream, 1, 'T10');
});

suite.add('T11 上游对主请求直接回400+JSON: 代理回400+正文原样,不带x-should-retry:false,且不发探测', async () => {
  const body400 = '{"type":"error","error":{"type":"invalid_request_error","message":"bad param"}}';
  arrange({ small: reply(400, body400) });
  const res = await sendSmall(false);
  await sleep(SETTLE_MS);
  assert.equal(res.status, 400, `T11: 上游直接回 400 时代理应回 400,实际 ${res.status}`);
  assert.equal(res.text, body400, `T11: 正文应与上游原样一致,实际 ${res.text.slice(0, 200)}`);
  assertNoShouldRetryFalse(res, 'T11');
  assertUpstreamCount(upstream, 1, 'T11');
});

// ================= T12:密钥不外泄 =================
suite.add('T12 密钥不外泄: T1/T2/T4三个场景中,stdout/stderr及代理回给调用方的头和正文都不含哨兵Key', async () => {
  const dumps = [];
  const cap = startCapture();
  let captured = '';
  try {
    console.log('[auth-probe] T12 capture self-check stdout');
    console.error('[auth-probe] T12 capture self-check stderr');
    arrange({ small: reply(401, DEEPSEEK_401_BODY) }); // 对应 T1 场景
    dumps.push((await sendBig(true)).dump);
    arrange({ small: reply(403, DEEPSEEK_403_BODY) }); // 对应 T2 场景
    dumps.push((await sendBig(true)).dump);
    arrange({ small: reset() }); // 对应 T4 场景
    dumps.push((await sendBig(true)).dump);
    await sleep(SETTLE_MS);
  } finally {
    captured = cap.stop();
  }
  // 先确认捕获本身有效,避免"什么都没捕获到所以没泄漏"的空转
  assert.ok(captured.includes('capture self-check stdout'), 'T12: stdout 捕获未生效(自检失败)');
  assert.ok(captured.includes('capture self-check stderr'), 'T12: stderr 捕获未生效(自检失败)');
  assert.equal(dumps.length, 3, 'T12: 三个场景都应拿到代理响应');
  const haystack = [captured, ...dumps].join('\n');
  assert.ok(!haystack.includes(TOKEN), 'T12: 哨兵 Key 出现在了 stdout/stderr 或代理回给调用方的响应里');
});

suite.finish(async () => {
  await upstream.close();
  await redirectTarget.close();
  try {
    rmdirSync(fakeHome); // 只删空目录,不递归;非空就留着
  } catch {
    // 忽略
  }
});
