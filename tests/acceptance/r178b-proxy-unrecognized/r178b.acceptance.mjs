// r178b-proxy-unrecognized 验收用例:只经代理的 HTTP 接口 POST /v1/messages 看响应,
// 启动与配置只用 openai-proxy.js 的 startOpenAIProxy / setOpenAIUpstream 两个导出。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeUpstream, postMessages, parseSse } from './fake-upstream.mjs';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const proxyModulePath = path.resolve(suiteDir, '../../../server/services/openai-proxy.js');

// 隔离:导入代理模块之前先把 HOME / USERPROFILE 指到临时目录,清掉 ANTHROPIC_* 与代理环境变量
const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'r178b-home-'));
process.env.HOME = suiteHome;
process.env.USERPROFILE = suiteHome;
for (const name of Object.keys(process.env)) {
  if (name.startsWith('ANTHROPIC_')) delete process.env[name];
}
for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
  delete process.env[name];
}
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

// 32 个字符的假 Key
const FAKE_KEY = 'sk-Zq7Kx9Rw3Lm5Bn8Vc2Td4Hy6Jp1F!';
assert.equal(FAKE_KEY.length, 32, '测试用假 Key 必须是 32 个字符');

const ERROR_PREFIX = '上游返回了无法识别的响应(HTTP 200):';

let upstream = null;
let proxyPort = null;
let proxyModule = null;

after(async () => {
  if (upstream) await upstream.close();
  fs.rmSync(suiteHome, { recursive: true, force: true });
});

// 一次调用 = 设定假上游的回复 + 把代理指向假上游 + 向代理发一次 /v1/messages
async function callProxy({ stream, status = 200, contentType, body }) {
  if (!proxyModule) {
    proxyModule = await import(pathToFileURL(proxyModulePath).href);
    assert.equal(typeof proxyModule.startOpenAIProxy, 'function', 'startOpenAIProxy 应是导出的函数');
    assert.equal(typeof proxyModule.setOpenAIUpstream, 'function', 'setOpenAIUpstream 应是导出的函数');
  }
  if (!upstream) upstream = await startFakeUpstream();
  if (proxyPort === null) proxyPort = await proxyModule.startOpenAIProxy(0);
  assert.equal(typeof proxyPort, 'number', 'startOpenAIProxy(0) 应返回实际监听端口');
  assert.ok(![6677, 6689, 6710, 8788, 8789, 8798, 8799].includes(proxyPort), `代理端口不应是保留端口:${proxyPort}`);
  upstream.setResponse({ status, contentType, body });
  proxyModule.setOpenAIUpstream({
    baseURL: `http://127.0.0.1:${upstream.port}/v1`,
    apiKey: FAKE_KEY,
    model: 'test-model',
  });
  return postMessages(proxyPort, { stream });
}

// ---- 断言辅助 ----

// 「错误体」:502 + application/json + 标准错误体 + x-should-retry: false + message 以固定前缀开头
function assertErrorBody(r, label) {
  assert.equal(r.status, 502, `${label}:HTTP 状态应为 502,实际 ${r.status},响应体:${r.text.slice(0, 200)}`);
  assert.match(String(r.headers['content-type'] ?? ''), /^application\/json/, `${label}:Content-Type 应为 application/json`);
  assert.equal(r.headers['x-should-retry'], 'false', `${label}:响应头 x-should-retry 应为 false`);
  let body;
  try {
    body = JSON.parse(r.text);
  } catch {
    assert.fail(`${label}:响应体应是 JSON,实际:${r.text.slice(0, 200)}`);
  }
  assert.equal(body.type, 'error', `${label}:body.type 应为 error`);
  assert.equal(body.error?.type, 'api_error', `${label}:error.type 应为 api_error`);
  assert.equal(typeof body.error?.message, 'string', `${label}:error.message 应是字符串`);
  assert.ok(body.error.message.startsWith(ERROR_PREFIX), `${label}:message 应以「${ERROR_PREFIX}」开头,实际:${body.error.message.slice(0, 80)}`);
  return body.error.message;
}

function assertNoRetryHeader(r, label) {
  assert.equal(r.headers['x-should-retry'], undefined, `${label}:响应头里不应有 x-should-retry,实际 ${r.headers['x-should-retry']}`);
}

// 「内容数组为空的非流式消息」:200 + application/json + type=message + content=[]
function assertEmptyMessage(r, label) {
  assert.equal(r.status, 200, `${label}:HTTP 状态应为 200,实际 ${r.status},响应体:${r.text.slice(0, 200)}`);
  assertNoRetryHeader(r, label);
  assert.match(String(r.headers['content-type'] ?? ''), /^application\/json/, `${label}:Content-Type 应为 application/json,实际 ${r.headers['content-type']}`);
  let body;
  try {
    body = JSON.parse(r.text);
  } catch {
    assert.fail(`${label}:响应体应是 JSON,实际:${r.text.slice(0, 200)}`);
  }
  assert.equal(body.type, 'message', `${label}:body.type 应为 message`);
  assert.equal(body.role, 'assistant', `${label}:body.role 应为 assistant`);
  assert.deepEqual(body.content, [], `${label}:content 应为空数组`);
  return body;
}

// 「没有内容块的合法流」:200 + text/event-stream + 有 message_start/message_delta/message_stop,没有 content_block_start
function assertEmptyStream(r, label) {
  assert.equal(r.status, 200, `${label}:HTTP 状态应为 200,实际 ${r.status},响应体:${r.text.slice(0, 200)}`);
  assertNoRetryHeader(r, label);
  assert.match(String(r.headers['content-type'] ?? ''), /^text\/event-stream/, `${label}:Content-Type 应为 text/event-stream,实际 ${r.headers['content-type']}`);
  const names = parseSse(r.text).map((e) => e.event);
  for (const need of ['message_start', 'message_delta', 'message_stop']) {
    assert.ok(names.includes(need), `${label}:流里应有 ${need} 事件,实际事件:${JSON.stringify(names)}`);
  }
  assert.ok(!names.includes('content_block_start'), `${label}:流里不应有 content_block_start,实际事件:${JSON.stringify(names)}`);
}

// 取出响应里的所有文字内容块(流或非流两种形态都认),返回 [文字, ...]
function collectTextBlocks(r, label) {
  const contentType = String(r.headers['content-type'] ?? '');
  if (/^text\/event-stream/.test(contentType)) {
    const events = parseSse(r.text);
    const starts = events.filter((e) => e.event === 'content_block_start');
    assert.equal(starts.length, 1, `${label}:流里应恰好一个 content_block_start,实际 ${starts.length}`);
    assert.equal(starts[0].data?.content_block?.type, 'text', `${label}:内容块类型应为 text`);
    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => e.data?.delta?.text ?? '')
      .join('');
    return { texts: [text], events };
  }
  const body = JSON.parse(r.text);
  assert.equal(body.type, 'message', `${label}:body.type 应为 message`);
  const blocks = body.content.filter((b) => b.type === 'text');
  assert.equal(body.content.length, 1, `${label}:content 应恰好一个块,实际 ${body.content.length}`);
  return { texts: blocks.map((b) => b.text), events: null };
}

// 「正常流」:200 + 一个文字内容块,正文等于期望
function assertNormalTextResponse(r, expectedText, label) {
  assert.equal(r.status, 200, `${label}:HTTP 状态应为 200,实际 ${r.status},响应体:${r.text.slice(0, 200)}`);
  assertNoRetryHeader(r, label);
  const { texts } = collectTextBlocks(r, label);
  assert.deepEqual(texts, [expectedText], `${label}:文字内容块应为 [${expectedText}]`);
}

function assertNoKeyWindow(message, label) {
  for (let i = 0; i + 8 <= FAKE_KEY.length; i += 1) {
    const piece = FAKE_KEY.slice(i, i + 8);
    assert.ok(!message.includes(piece), `${label}:message 里不应出现 Key 的 8 个连续字符「${piece}」,实际 message:${message.slice(-120)}`);
  }
}

// ---- 上游响应体构造 ----
const sse = (...items) => items.map((it) => `data: ${typeof it === 'string' ? it : JSON.stringify(it)}\n\n`).join('');
const roleChunk = { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] };
const textChunk = (text) => ({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] });
const finishChunk = (reason) => ({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageChunk = { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } };
const errorLine429 = '{"code":429,"msg":"余额不足,请充值"}';
const chatJson = (message, finishReason) => JSON.stringify({
  id: 'c1',
  object: 'chat.completion',
  choices: [{ index: 0, message, finish_reason: finishReason }],
});

// ================= 第 3 类 → 错误体 =================

test('P1 空响应体:流式+json、非流式+json、流式+event-stream 0 字节,都是错误体且含「响应体为空」', async () => {
  const a = await callProxy({ stream: true, contentType: 'application/json', body: '' });
  assert.ok(assertErrorBody(a, 'P1(a)').includes('响应体为空'), 'P1(a):message 应含「响应体为空」');
  const b = await callProxy({ stream: false, contentType: 'application/json', body: '' });
  assert.ok(assertErrorBody(b, 'P1(b)').includes('响应体为空'), 'P1(b):message 应含「响应体为空」');
  const c = await callProxy({ stream: true, contentType: 'text/event-stream', body: '' });
  assert.ok(assertErrorBody(c, 'P1(c)').includes('响应体为空'), 'P1(c):message 应含「响应体为空」');
});

test('P2 网页(text/html):标签被去掉只剩文字;清理后没文字写「响应体没有可读文字」', async () => {
  const page = '<html><body><h1>504 Gateway Time-out</h1></body></html>';
  for (const [label, stream] of [['P2(a) 流式', true], ['P2(b) 非流式', false]]) {
    const message = assertErrorBody(await callProxy({ stream, contentType: 'text/html', body: page }), label);
    assert.ok(message.includes('504 Gateway Time-out'), `${label}:message 应含「504 Gateway Time-out」,实际:${message}`);
    assert.ok(!message.includes('<') && !message.includes('>'), `${label}:message 不应含 < 或 >,实际:${message}`);
  }
  const emptyPage = await callProxy({ stream: false, contentType: 'text/html', body: '<html><body></body></html>' });
  const message = assertErrorBody(emptyPage, 'P2(c)');
  assert.ok(message.includes('响应体没有可读文字'), `P2(c):message 应含「响应体没有可读文字」,实际:${message}`);
});

test('P3 纯文本 upstream busy:流式、非流式都是错误体且含原话', async () => {
  const text = 'upstream busy, please retry later';
  for (const [label, stream] of [['P3 流式', true], ['P3 非流式', false]]) {
    const message = assertErrorBody(await callProxy({ stream, contentType: 'text/plain', body: text }), label);
    assert.ok(message.includes(text), `${label}:message 应含「${text}」,实际:${message}`);
  }
});

test('P4 JSON {code:429,msg}:流式、非流式都是错误体且含 msg 原话', async () => {
  const body = '{"code":429,"msg":"余额不足,请充值"}';
  for (const [label, stream] of [['P4 流式', true], ['P4 非流式', false]]) {
    const message = assertErrorBody(await callProxy({ stream, contentType: 'application/json', body }), label);
    assert.ok(message.includes('余额不足,请充值'), `${label}:message 应含「余额不足,请充值」,实际:${message}`);
  }
});

test('P5 JSON {success:false,message}:流式、非流式都是错误体且含 message 原话', async () => {
  const body = '{"success":false,"message":"model not found: claude-opus-4-6"}';
  for (const [label, stream] of [['P5 流式', true], ['P5 非流式', false]]) {
    const message = assertErrorBody(await callProxy({ stream, contentType: 'application/json', body }), label);
    assert.ok(message.includes('model not found: claude-opus-4-6'), `${label}:message 应含「model not found: claude-opus-4-6」,实际:${message}`);
  }
});

test('P6 choices 为空数组(带不带 usage)、[null]、[{code:429}]:都是错误体', async () => {
  const usage = { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 };
  const cases = [
    ['P6(a) choices=[]', JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [] })],
    ['P6(b) choices=[] 带 usage', JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [], usage })],
    ['P6(c) choices=[null]', JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [null] })],
    ['P6(d) choices=[{code:429}]', JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [{ code: 429 }] })],
  ];
  for (const [label, body] of cases) {
    assertErrorBody(await callProxy({ stream: false, contentType: 'application/json', body }), `${label} 非流式`);
  }
  const streamed = await callProxy({ stream: true, contentType: 'application/json', body: cases[0][1] });
  assertErrorBody(streamed, 'P6(a) 流式请求');
});

test('P7 流式:错误行出现在 [DONE] 之前,三种前后搭配都是错误体且含「余额不足」', async () => {
  const cases = [
    ['P7(a) 错误行 → [DONE]', sse(errorLine429, '[DONE]')],
    ['P7(b) role 首包 → 错误行 → [DONE]', sse(roleChunk, errorLine429, '[DONE]')],
    ['P7(c) 错误行 → 空 choices+usage → [DONE]', sse(errorLine429, usageChunk, '[DONE]')],
  ];
  for (const [label, body] of cases) {
    const message = assertErrorBody(await callProxy({ stream: true, contentType: 'text/event-stream', body }), label);
    assert.ok(message.includes('余额不足'), `${label}:message 应含「余额不足」,实际:${message}`);
  }
});

test('P8 5000 字符长文字:message 不超过 330 个字符且以省略号结尾', async () => {
  const longText = 'abcdefghi '.repeat(500).trim().padEnd(5000, 'z');
  assert.equal(longText.length, 5000);
  const message = assertErrorBody(await callProxy({ stream: false, contentType: 'text/plain', body: longText }), 'P8');
  const codePoints = Array.from(message).length;
  assert.ok(codePoints <= 330, `P8:message 不应超过 330 个字符,实际 ${codePoints}`);
  assert.ok(message.endsWith('…'), `P8:message 应以「…」结尾,实际结尾:${message.slice(-10)}`);
});

test('P9 Key 脱敏:靠前、截断点落在 Key 中间、Key 中间夹控制字符,都不泄漏 8 个连续字符', async () => {
  // (a) Key 全文在第 20 个字符附近
  const bodyA = `${'error from upstrm: '.slice(0, 19)} ${FAKE_KEY} then more words`;
  const a = assertErrorBody(await callProxy({ stream: false, contentType: 'text/plain', body: bodyA }), 'P9(a)');
  assert.ok(a.includes('***'), `P9(a):message 应含 ***,实际:${a}`);
  assertNoKeyWindow(a, 'P9(a)');

  // (b) 无多余空白/控制字符;Key 从第 290 个字符处开始,截断点(300)落在 Key 中间,截断点前有 10 个 Key 字符
  const bodyB = 'a'.repeat(290) + FAKE_KEY + 'a'.repeat(100);
  assert.equal(bodyB.indexOf(FAKE_KEY), 290);
  const b = assertErrorBody(await callProxy({ stream: false, contentType: 'text/plain', body: bodyB }), 'P9(b)');
  assertNoKeyWindow(b, 'P9(b)');

  // (c) Key 中间夹一个 \u0001
  const splitKey = `${FAKE_KEY.slice(0, 16)}\u0001${FAKE_KEY.slice(16)}`;
  const c = assertErrorBody(await callProxy({ stream: false, contentType: 'text/plain', body: `bad gateway ${splitKey} end` }), 'P9(c)');
  assert.ok(c.includes('***'), `P9(c):message 应含 ***,实际:${c}`);
  assertNoKeyWindow(c, 'P9(c)');
});

test('P19 流式:只有空白行、只有注释心跳且没有 [DONE],都是错误体', async () => {
  const a = assertErrorBody(await callProxy({ stream: true, contentType: 'text/event-stream', body: '\n\n   \n\n' }), 'P19(a)');
  assert.ok(a.includes('响应体为空'), `P19(a):message 应含「响应体为空」,实际:${a}`);
  const b = assertErrorBody(await callProxy({ stream: true, contentType: 'text/event-stream', body: ': keepalive\n\n: keepalive\n\n' }), 'P19(b)');
  assert.ok(b.includes('流里没有任何数据行'), `P19(b):message 应含「流里没有任何数据行」,实际:${b}`);
});

test('P20 行首 data: 的判据:网页内的 data: 不算流;text/plain 里行首 data: 的流按流处理', async () => {
  const page = '<html><body><img src="data:image/png;base64,AAAA"><p>网关错误</p></body></html>';
  const a = assertErrorBody(await callProxy({ stream: false, contentType: 'text/html', body: page }), 'P20(a)');
  assert.ok(a.includes('网关错误'), `P20(a):message 应含「网关错误」,实际:${a}`);
  const b = assertErrorBody(await callProxy({ stream: true, contentType: 'text/plain', body: `data: ${errorLine429}` }), 'P20(b)');
  assert.ok(b.includes('余额不足'), `P20(b):message 应含「余额不足」,实际:${b}`);
});

// ================= 第 2 类 → 不变 =================

test('P10 结构正常但正文为空的整段 JSON:仍回内容为空的非流式消息(流式请求也不是流)', async () => {
  const stopBody = chatJson({ role: 'assistant', content: null }, 'stop');
  const a = await callProxy({ stream: true, contentType: 'application/json', body: stopBody });
  assertEmptyMessage(a, 'P10(a) 流式请求');
  const b = await callProxy({ stream: false, contentType: 'application/json', body: stopBody });
  assertEmptyMessage(b, 'P10(b) 非流式请求');
  const lengthBody = chatJson({ role: 'assistant', content: '' }, 'length');
  const c = assertEmptyMessage(await callProxy({ stream: false, contentType: 'application/json', body: lengthBody }), 'P10(c)');
  assert.equal(c.stop_reason, 'max_tokens', 'P10(c):finish_reason=length 时 stop_reason 应为 max_tokens');
});

test('P11 流式:只有 [DONE]、注释加 [DONE],都是没有内容块的合法流', async () => {
  assertEmptyStream(await callProxy({ stream: true, contentType: 'text/event-stream', body: sse('[DONE]') }), 'P11(a) 只有 [DONE]');
  assertEmptyStream(await callProxy({ stream: true, contentType: 'text/event-stream', body: `: ping\n\n${sse('[DONE]')}` }), 'P11(b) 注释+[DONE]');
});

test('P12 流式:正文为空串以 stop 结束、正文为空以 content_filter 结束,都是没有内容块的合法流', async () => {
  const emptyThenStop = sse(roleChunk, textChunk(''), finishChunk('stop'), '[DONE]');
  assertEmptyStream(await callProxy({ stream: true, contentType: 'text/event-stream', body: emptyThenStop }), 'P12(a) 空串+stop');
  const emptyThenFilter = sse(
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
    finishChunk('content_filter'),
    '[DONE]',
  );
  assertEmptyStream(await callProxy({ stream: true, contentType: 'text/event-stream', body: emptyThenFilter }), 'P12(b) 空+content_filter');
});

test('P13 流式:role 首包 → delta:{} → 空 choices 加 usage → [DONE],是没有内容块的合法流', async () => {
  const emptyDelta = { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {} }] };
  const body = sse(roleChunk, emptyDelta, usageChunk, '[DONE]');
  assertEmptyStream(await callProxy({ stream: true, contentType: 'text/event-stream', body }), 'P13');
});

// ================= 回归 =================

test('P14 流式正常流(正文「你好」):正常的流,有且只有一个文字内容块', async () => {
  const body = sse(roleChunk, textChunk('你'), textChunk('好'), finishChunk('stop'), '[DONE]');
  const r = await callProxy({ stream: true, contentType: 'text/event-stream', body });
  assert.match(String(r.headers['content-type'] ?? ''), /^text\/event-stream/, 'P14:Content-Type 应为 text/event-stream');
  assertNormalTextResponse(r, '你好', 'P14');
});

test('P15 正常 JSON(正文「你好」):流式、非流式请求各有一个文字内容块', async () => {
  const body = chatJson({ role: 'assistant', content: '你好' }, 'stop');
  assertNormalTextResponse(await callProxy({ stream: true, contentType: 'application/json', body }), '你好', 'P15 流式请求');
  assertNormalTextResponse(await callProxy({ stream: false, contentType: 'application/json', body }), '你好', 'P15 非流式请求');
});

test('P16 带标准 error:整段 JSON 与流里数据行都是非 200 的标准错误体,且没有 x-should-retry', async () => {
  const a = await callProxy({
    stream: false,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: '标准错误字段里的文字', type: 'invalid_request_error' } }),
  });
  const b = await callProxy({
    stream: true,
    contentType: 'text/event-stream',
    body: sse({ error: { message: '流里的标准错误', code: 429 } }),
  });
  for (const [label, r, expected] of [['P16(a) 整段 JSON', a, '标准错误字段里的文字'], ['P16(b) 流里数据行', b, '流里的标准错误']]) {
    assert.ok(r.status >= 400 && r.status <= 599, `${label}:HTTP 状态应为 4xx/5xx,实际 ${r.status}`);
    assertNoRetryHeader(r, label);
    const parsed = JSON.parse(r.text);
    assert.equal(parsed.type, 'error', `${label}:body.type 应为 error`);
    assert.ok(String(parsed.error?.message).includes(expected), `${label}:message 应含「${expected}」,实际:${r.text.slice(0, 200)}`);
  }
});

test('P17 流式:先来一行 {code:429,msg},随后正常正文:正常流,一个文字内容块,没有 error 事件', async () => {
  const body = sse('{"code":429,"msg":"余额不足"}', roleChunk, textChunk('你好'), finishChunk('stop'), '[DONE]');
  const r = await callProxy({ stream: true, contentType: 'text/event-stream', body });
  assert.match(String(r.headers['content-type'] ?? ''), /^text\/event-stream/, 'P17:Content-Type 应为 text/event-stream');
  assertNormalTextResponse(r, '你好', 'P17');
  const events = parseSse(r.text);
  const errorEvents = events.filter((e) => e.event === 'error' || e.data?.type === 'error');
  assert.equal(errorEvents.length, 0, `P17:流里不应有 error 事件,实际:${JSON.stringify(errorEvents)}`);
});

test('P18 上游 HTTP 500 的 JSON 错误体(流式请求):非 200 的标准错误体,没有 x-should-retry', async () => {
  const r = await callProxy({
    stream: true,
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'upstream exploded', type: 'server_error' } }),
  });
  assert.notEqual(r.status, 200, 'P18:HTTP 状态不应为 200');
  assert.ok(r.status >= 400 && r.status <= 599, `P18:HTTP 状态应为 4xx/5xx,实际 ${r.status}`);
  assertNoRetryHeader(r, 'P18');
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.type, 'error', 'P18:body.type 应为 error');
  assert.equal(typeof parsed.error?.message, 'string', 'P18:error.message 应是字符串');
});

test('P21(不做)非流式请求遇到上游正常流式正文:仍是 200 + 内容数组为空的消息', async () => {
  const body = sse(roleChunk, textChunk('你好'), finishChunk('stop'), '[DONE]');
  assertEmptyMessage(await callProxy({ stream: false, contentType: 'text/event-stream', body }), 'P21');
});
