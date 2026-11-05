// OpenAI 代理(server/services/openai-proxy.js)验收测试 O1-O11。
// 只通过接口文件第 0 节的公开入口调用:startOpenAIProxy / setOpenAIUpstream + HTTP 口。
// 运行: env -u http_proxy -u https_proxy node --test 'tests/acceptance/auth-probe/*.test.mjs'
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OPENAI_KEY as KEY,
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
const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'auth-probe-openai-home-'));
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
let setOpenAIUpstream;
try {
  const mod = await import(new URL('../../../server/services/openai-proxy.js', import.meta.url).href);
  setOpenAIUpstream = mod.setOpenAIUpstream;
  upstream = await startFakeUpstream();
  // 重定向目标:不管收到什么都回 401。万一代理跟随了重定向,既会被计数也会让状态码变成 401。
  redirectTarget = await startFakeUpstream({ big: reply(401, DEEPSEEK_401_BODY), small: reply(401, DEEPSEEK_401_BODY) });
  setOpenAIUpstream({ baseURL: upstream.baseURL, apiKey: KEY });
  proxyPort = Number(await mod.startOpenAIProxy(0));
  assert.ok(Number.isInteger(proxyPort) && proxyPort > 0, `startOpenAIProxy(0) 应返回监听端口号,实际 ${proxyPort}`);
} catch (e) {
  console.error('[auth-probe] openai 测试启动失败:', e);
  process.exit(1);
}

const suite = createSuite();

// 每个用例开头调用:换上游行为、清请求记录,用例之间互不依赖
function arrange({ big = reset(), small = reply(200, '{}') } = {}) {
  upstream.destroyOpenConnections();
  upstream.clear();
  upstream.set({ big, small });
  setOpenAIUpstream({ baseURL: upstream.baseURL, apiKey: KEY });
}
const sendBig = (stream) => callProxy(proxyPort, { body: anthropicRequestBody({ stream, bigSystem: true }) });
const sendSmall = (stream = false) => callProxy(proxyPort, { body: anthropicRequestBody({ stream }) });

// ================= O1-O3:探测得到 401/403 =================
suite.add('O1 大请求被重置、探测回401: 回401+x-should-retry:false+JSON错误体(stream=true/false各一次)', async () => {
  arrange({ small: reply(401, DEEPSEEK_401_BODY) });
  for (const stream of [true, false]) {
    const label = `O1 stream=${stream}`;
    upstream.clear();
    const res = await sendBig(stream);
    await sleep(SETTLE_MS);
    assert.equal(res.status, 401, `${label}: 探测得 401 后应回 401,实际 ${res.status}`);
    assertShouldRetryFalse(res, label);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/, `${label}: content-type 应含 application/json`);
    assert.ok(res.json, `${label}: 正文应是 JSON,实际 ${res.text.slice(0, 200)}`);
    assert.equal(res.json.type, 'error', `${label}: 正文 type 应为 error`);
    assert.equal(res.json.error?.type, 'api_error', `${label}: 正文 error.type 应为 api_error`);
    assert.match(String(res.json.error?.message), /Authentication Fails/, `${label}: error.message 应含 Authentication Fails`);
    assertUpstreamCount(upstream, 2, label);
  }
});

suite.add('O2 大请求被重置、探测回403: 回403+x-should-retry:false+message含Forbidden', async () => {
  arrange({ small: reply(403, DEEPSEEK_403_BODY) });
  for (const stream of [true, false]) {
    const label = `O2 stream=${stream}`;
    upstream.clear();
    const res = await sendBig(stream);
    await sleep(SETTLE_MS);
    assert.equal(res.status, 403, `${label}: 探测得 403 后应回 403,实际 ${res.status}`);
    assertShouldRetryFalse(res, label);
    assert.match(String(res.json?.error?.message), /Forbidden/, `${label}: error.message 应含 Forbidden,实际 ${res.text.slice(0, 200)}`);
    assertUpstreamCount(upstream, 2, label);
  }
});

suite.add('O3 探测请求的外部特征: POST /chat/completions、同一把Key、小于1KB不含填充、1条user、max_tokens 1-16、非流式、model相同', async () => {
  arrange({ small: reply(401, DEEPSEEK_401_BODY) });
  await sendBig(true); // 主请求 stream=true,才能看出探测有没有把 stream 抄过去
  await sleep(SETTLE_MS);
  const { main, probe } = assertProbeShape(upstream, { label: 'O3', path: '/chat/completions' });
  assert.equal(probe.authorization, `Bearer ${KEY}`, 'O3: 探测的 authorization 应为 Bearer <apiKey>');
  assert.equal(main.authorization, probe.authorization, 'O3: 探测与主请求应使用同一把 Key');
});

// ================= O4-O7:探测失败/其它状态 => 照旧 502 =================
suite.add('O4 大请求被重置、探测也被重置: 回502、不带x-should-retry:false、message以upstream fetch failed开头', async () => {
  arrange({ small: reset() });
  const res = await sendBig(false);
  await sleep(SETTLE_MS);
  assertUpstreamFetchFailed502(res, 'O4');
  assert.match(res.headers.get('content-type') ?? '', /application\/json/, 'O4: 502 的 content-type 应含 application/json');
  assert.ok(upstream.requests.length <= 2, `O4: 一个失败的主请求最多触发一个探测,假上游实际收到 ${upstream.requests.length} 个请求`);
});

const OPENAI_OK_BODY =
  '{"id":"chatcmpl-probe","object":"chat.completion","created":1,"model":"probe-model-1","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}';

suite.add('O5 大请求被重置、探测回200/400/404/429/500: 每次都回502且不带x-should-retry:false', async () => {
  arrange();
  const cases = [
    [200, OPENAI_OK_BODY],
    [400, '{"error":{"message":"probe says bad request","type":"invalid_request_error"}}'],
    [404, '{"error":{"message":"probe says not found","type":"not_found_error"}}'],
    [429, '{"error":{"message":"probe says rate limited","type":"rate_limit_error"}}'],
    [500, '{"error":{"message":"probe says internal error","type":"server_error"}}'],
  ];
  for (const [status, body] of cases) {
    const label = `O5 探测回${status}`;
    upstream.clear();
    upstream.set({ small: reply(status, body) });
    const res = await sendBig(false);
    await sleep(SETTLE_MS);
    assertUpstreamFetchFailed502(res, label);
    assert.ok(upstream.requests.length <= 2, `${label}: 假上游实际收到 ${upstream.requests.length} 个请求,最多应为 2`);
  }
});

suite.add('O6 大请求被重置、探测收下不应答: 回502,且从发请求到收到响应不超过11秒', async () => {
  arrange({ small: hang() });
  try {
    const res = await sendBig(false);
    assert.ok(res.elapsedMs <= 11000, `O6: 从发出请求到收到响应应不超过 11 秒,实际 ${res.elapsedMs}ms`);
    assertUpstreamFetchFailed502(res, 'O6');
  } finally {
    upstream.destroyOpenConnections(); // 关掉挂起的探测连接
  }
});

suite.add('O7 大请求被重置、探测回302指向另一个服务: 回502,另一个服务收到0个请求(不跟随重定向)', async () => {
  arrange({ small: redirectTo(`${redirectTarget.baseURL}/redirect-target`) });
  redirectTarget.clear();
  const res = await sendBig(false);
  await sleep(SETTLE_MS);
  assert.equal(res.status, 502, `O7: 探测回 302 属于"其它状态",应回 502,实际 ${res.status}`);
  assertNoShouldRetryFalse(res, 'O7');
  assert.equal(redirectTarget.requests.length, 0, `O7: 不应跟随重定向,另一个假服务应收到 0 个请求,实际 ${redirectTarget.requests.length} 个`);
});

// ================= O8-O9:上游直接回应(不走探测) =================
suite.add('O8 上游正常回200: 代理回200,假上游只收到1个请求(没有探测)', async () => {
  arrange({ small: reply(200, OPENAI_OK_BODY) });
  const res = await sendSmall(false);
  await sleep(SETTLE_MS);
  assert.equal(res.status, 200, `O8: 上游 200 时代理应回 200,实际 ${res.status}`);
  assertNoShouldRetryFalse(res, 'O8');
  assertUpstreamCount(upstream, 1, 'O8');
});

suite.add('O9 上游对主请求直接回401: 代理回401+原文案+x-should-retry:false,且不发探测', async () => {
  arrange({ small: reply(401, DEEPSEEK_401_BODY) });
  const res = await sendSmall(false);
  await sleep(SETTLE_MS);
  assert.equal(res.status, 401, `O9: 上游直接回 401 时代理应回 401,实际 ${res.status}`);
  assert.match(String(res.json?.error?.message), /Authentication Fails/, `O9: error.message 应含 Authentication Fails,实际 ${res.text.slice(0, 200)}`);
  assertShouldRetryFalse(res, 'O9');
  assertUpstreamCount(upstream, 1, 'O9');
});

// ================= O10:密钥不外泄 =================
suite.add('O10 密钥不外泄: O1/O2/O4三个场景中,stdout/stderr及代理回给调用方的头和正文都不含哨兵Key', async () => {
  const dumps = [];
  const cap = startCapture();
  let captured = '';
  try {
    console.log('[auth-probe] O10 capture self-check stdout');
    console.error('[auth-probe] O10 capture self-check stderr');
    arrange({ small: reply(401, DEEPSEEK_401_BODY) }); // 对应 O1 场景
    dumps.push((await sendBig(true)).dump);
    arrange({ small: reply(403, DEEPSEEK_403_BODY) }); // 对应 O2 场景
    dumps.push((await sendBig(true)).dump);
    arrange({ small: reset() }); // 对应 O4 场景
    dumps.push((await sendBig(false)).dump);
    await sleep(SETTLE_MS);
  } finally {
    captured = cap.stop();
  }
  // 先确认捕获本身有效,避免"什么都没捕获到所以没泄漏"的空转
  assert.ok(captured.includes('capture self-check stdout'), 'O10: stdout 捕获未生效(自检失败)');
  assert.ok(captured.includes('capture self-check stderr'), 'O10: stderr 捕获未生效(自检失败)');
  assert.equal(dumps.length, 3, 'O10: 三个场景都应拿到代理响应');
  const haystack = [captured, ...dumps].join('\n');
  assert.ok(!haystack.includes(KEY), 'O10: 哨兵 Key 出现在了 stdout/stderr 或代理回给调用方的响应里');
});

// ================= O11:探测回401,正文形态各异时 message 的取法 =================
suite.add('O11 探测回401但正文是纯文本/空/无error字段的JSON: 都回401+x-should-retry:false,message按规则取值', async () => {
  arrange();
  const cases = [
    { name: '(a) 纯文本', small: reply(401, 'Unauthorized: bad key', 'text/plain'), expected: 'Unauthorized: bad key' },
    { name: '(b) 空正文', small: reply(401, '', null), expected: 'upstream authentication failed (HTTP 401)' },
    { name: '(c) JSON无error字段', small: reply(401, '{"detail":"bad key"}', 'application/json'), expected: '{"detail":"bad key"}' },
  ];
  for (const c of cases) {
    const label = `O11${c.name}`;
    upstream.clear();
    upstream.set({ small: c.small });
    const res = await sendBig(false);
    await sleep(SETTLE_MS);
    assert.equal(res.status, 401, `${label}: 探测得 401 后应回 401,实际 ${res.status}`);
    assertShouldRetryFalse(res, label);
    assert.equal(res.json?.error?.message, c.expected, `${label}: error.message 应为 ${JSON.stringify(c.expected)},实际 ${res.text.slice(0, 200)}`);
  }
});

suite.finish(async () => {
  await upstream.close();
  await redirectTarget.close();
});
