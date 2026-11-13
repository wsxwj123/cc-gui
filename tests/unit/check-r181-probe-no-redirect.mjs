#!/usr/bin/env node
// 单测:r181 带 Key 的探测请求「同源最多跟 1 跳、跨源一律拒绝」(server/utils/probe-fetch.js 白盒)。
// fetchFollowSameOriginOnce 用注入的 fetchImpl 记录每次调用;redirectRefusedMessage 是纯函数。
// Run: node tests/unit/check-r181-probe-no-redirect.mjs
import assert from 'node:assert/strict';

const { fetchFollowSameOriginOnce, redirectRefusedMessage } = await import('../../server/utils/probe-fetch.js');

// 假响应:status + location;body.cancel 计数,确认 3xx 正文被释放
function fakeResponse(status, location) {
  const headers = new Headers();
  if (location !== undefined) headers.set('location', location);
  const body = { cancelled: 0, cancel() { this.cancelled += 1; return Promise.resolve(); } };
  return { status, ok: status >= 200 && status < 300, headers, body };
}

// 按调用顺序返回预设响应,并记录 (url, init)
function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`多发了一次请求:${url}`);
    return next;
  };
  return { calls, fetchImpl };
}

const A = 'http://127.0.0.1:6801';

// p1 GET 遇同源 301 → 跟 1 跳,拿到第二次响应;每次都 redirect:'manual',共用同一个 signal 与请求头
{
  const signal = AbortSignal.timeout(10_000);
  const headers = { 'x-api-key': 'sk-p1' };
  const first = fakeResponse(301, '/v1/models/');
  const { calls, fetchImpl } = scripted([first, fakeResponse(200)]);
  const got = await fetchFollowSameOriginOnce(`${A}/v1/models`, { headers, signal }, { fetchImpl });
  assert.equal(got.response?.status, 200, 'p1: 跟随后拿到 200');
  assert.equal(calls.length, 2, 'p1: 恰好两次请求');
  assert.equal(calls[1].url, `${A}/v1/models/`, 'p1: 第二次发往同源的跳转目标');
  for (const c of calls) {
    assert.equal(c.init.redirect, 'manual', 'p1: 每次都不让底层自动跟随');
    assert.equal(c.init.signal, signal, 'p1: 两次共用同一个 signal');
    assert.equal(c.init.headers, headers, 'p1: 请求头相同');
  }
  assert.equal(first.body.cancelled, 1, 'p1: 3xx 的正文被释放');
}

// p2 GET 的 302 / 303 / 307 / 308 同源同样跟 1 跳
for (const status of [302, 303, 307, 308]) {
  const { calls, fetchImpl } = scripted([fakeResponse(status, `${A}/v1/models/`), fakeResponse(200)]);
  const got = await fetchFollowSameOriginOnce(`${A}/v1/models`, {}, { fetchImpl });
  assert.equal(got.response?.status, 200, `p2: GET ${status} 同源跟随`);
  assert.equal(calls.length, 2);
}

// p3 POST 遇同源 302 / 301 / 303 → 不跟,same-origin-stop
for (const status of [301, 302, 303]) {
  const { calls, fetchImpl } = scripted([fakeResponse(status, '/v1/chat/completions/')]);
  const got = await fetchFollowSameOriginOnce(`${A}/v1/chat/completions`, { method: 'POST', body: '{"a":1}' }, { fetchImpl });
  assert.equal(calls.length, 1, `p3: POST ${status} 不发第二次`);
  assert.deepEqual(got.refused, { status, reason: 'same-origin-stop', targetHost: '127.0.0.1:6801', requestUrl: `${A}/v1/chat/completions` });
}

// p4 POST 遇同源 307 / 308 → 跟 1 跳,方法与正文相同
for (const status of [307, 308]) {
  const body = JSON.stringify({ model: 'm', max_tokens: 1 });
  const { calls, fetchImpl } = scripted([fakeResponse(status, '/v1/messages/'), fakeResponse(200)]);
  const got = await fetchFollowSameOriginOnce(`${A}/v1/messages`, { method: 'post', body }, { fetchImpl });
  assert.equal(got.response?.status, 200, `p4: POST ${status} 同源跟随`);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${A}/v1/messages/`);
  assert.equal(calls[1].init.method, 'post', 'p4: 方法原样');
  assert.equal(calls[1].init.body, body, 'p4: 正文原样重发');
}

// p5 第二跳仍是 3xx → 拒绝,不发第三次;报告的请求地址是第一跳的
{
  const { calls, fetchImpl } = scripted([fakeResponse(302, '/x'), fakeResponse(302, '/y')]);
  const got = await fetchFollowSameOriginOnce(`${A}/v1/models`, {}, { fetchImpl });
  assert.equal(calls.length, 2, 'p5: 不发第三次');
  assert.equal(got.refused?.reason, 'same-origin-stop');
  assert.equal(got.refused?.requestUrl, `${A}/v1/models`, 'p5: 请求地址是第一跳的');
}

// p6 跨源各情形的 reason;都只发 1 次
{
  const cases = [
    [`${A}/v1/models`, 'http://127.0.0.1:6802/v1/models', 'cross-host', '127.0.0.1:6802'],
    [`${A}/v1/models`, 'http://evil.example.com/v1/models', 'cross-host', 'evil.example.com'],
    [`${A}/v1/models`, 'https://127.0.0.1:6801/v1/models', 'https-upgrade', '127.0.0.1:6801'],
    [`${A}/v1/models`, 'https://127.0.0.1:6802/v1/models', 'cross-host', '127.0.0.1:6802'],
    ['http://h.example.com/v1/models', 'https://h.example.com/v1/models', 'https-upgrade', 'h.example.com'],
    ['https://h.example.com/v1/models', 'http://h.example.com/v1/models', 'cross-host', 'h.example.com'],
  ];
  for (const [from, loc, reason, host] of cases) {
    const { calls, fetchImpl } = scripted([fakeResponse(302, loc)]);
    const got = await fetchFollowSameOriginOnce(from, {}, { fetchImpl });
    assert.equal(calls.length, 1, `p6: ${from} → ${loc} 只发 1 次`);
    assert.equal(got.refused?.reason, reason, `p6: ${from} → ${loc} 的 reason`);
    assert.equal(got.refused?.targetHost, host, `p6: ${from} → ${loc} 的主机名`);
  }
}

// p7 Location 无效:缺失、空串、javascript:、解析不了、带账号密码 → bad-location,不附目标
{
  const bads = [undefined, '', 'javascript:alert(1)', 'http://[::1', 'http://user:pw@127.0.0.1:6801/v1/models/', 'ftp://127.0.0.1:6801/x'];
  for (const loc of bads) {
    const { calls, fetchImpl } = scripted([fakeResponse(302, loc)]);
    const got = await fetchFollowSameOriginOnce(`${A}/v1/models`, {}, { fetchImpl });
    assert.equal(calls.length, 1, `p7: Location=${JSON.stringify(loc)} 只发 1 次`);
    assert.equal(got.refused?.reason, 'bad-location', `p7: Location=${JSON.stringify(loc)}`);
    assert.equal(got.refused?.targetHost, '', 'p7: 不附目标');
  }
}

// p8 非 3xx 原样返回;网络异常原样抛出
{
  for (const status of [200, 204, 401, 404, 500]) {
    const r = fakeResponse(status);
    const { fetchImpl } = scripted([r]);
    const got = await fetchFollowSameOriginOnce(`${A}/v1/models`, {}, { fetchImpl });
    assert.equal(got.response, r, `p8: ${status} 原样返回`);
  }
  const boom = new Error('connect ECONNREFUSED');
  await assert.rejects(
    fetchFollowSameOriginOnce(`${A}/v1/models`, {}, { fetchImpl: async () => { throw boom; } }),
    (e) => e === boom, 'p8: 网络异常原样抛出',
  );
}

// m1 redirectRefusedMessage 四种 reason
{
  const HEAD = '上游返回了重定向（HTTP 302），已拒绝跟随（防止密钥被带到未校验的地址）。';
  const req = `${A}/v1/models`;
  const cross = redirectRefusedMessage({ status: 302, reason: 'cross-host', targetHost: '127.0.0.1:6802', requestUrl: req });
  assert.ok(cross.startsWith(HEAD), 'm1: 主句逐字在最前');
  assert.ok(cross.includes('127.0.0.1:6802'), 'm1: 跨主机时含主机名');
  assert.ok(!cross.includes('http://127.0.0.1:6802') && !cross.includes('https://127.0.0.1:6802'), 'm1: 主机名不带协议前缀');
  assert.ok(cross.includes('未经核实'), 'm1: 写明未经核实');
  assert.ok(cross.endsWith(`请求的地址：${req}`), 'm1: 末尾附请求的地址');

  const up = redirectRefusedMessage({ status: 301, reason: 'https-upgrade', targetHost: '127.0.0.1:6801', requestUrl: req });
  assert.ok(up.includes('HTTP 301') && up.includes('https') && up.includes('同一主机'), 'm1: https-upgrade');

  const stop = redirectRefusedMessage({ status: 302, reason: 'same-origin-stop', targetHost: '127.0.0.1:6801', requestUrl: req });
  assert.ok(stop.includes('同一主机') && stop.includes('已停止'), 'm1: same-origin-stop');

  const bad = redirectRefusedMessage({ status: 302, reason: 'bad-location', targetHost: '', requestUrl: req });
  assert.ok(bad.includes('没有给出有效的跳转地址') && bad.includes('已停止'), 'm1: bad-location');
}

// m2 请求地址只显示 origin + pathname:不带查询串 / 片段 / userinfo,长于 24 字符的路径段换成「…」
{
  const msg = redirectRefusedMessage({
    status: 302, reason: 'cross-host', targetHost: '127.0.0.1:6802',
    requestUrl: 'http://u:pw@127.0.0.1:6801/abcdefghijklmnopqrstuvwxyz0123/v1/models?token=abc#frag',
  });
  assert.ok(msg.includes('请求的地址：http://127.0.0.1:6801/…/v1/models'), `m2: 显示的地址(${msg})`);
  for (const bad of ['token=abc', 'frag', 'abcdefghijklmnopqrstuvwxyz0123', 'u:pw', 'pw@']) {
    assert.ok(!msg.includes(bad), `m2: 不含 ${bad}`);
  }
  const noUrl = redirectRefusedMessage({ status: 302, reason: 'bad-location', targetHost: '', requestUrl: 'not a url' });
  assert.ok(!noUrl.includes('请求的地址'), 'm2: 地址解析不了就不附');
}

// m3 端到端:跨主机被拒的报错里只有目标主机名,没有 Location 的路径 / 查询串 / 片段
{
  const KEY = 'sk-r181-white-box-key';
  const { fetchImpl } = scripted([fakeResponse(302, `http://127.0.0.1:6802/secret-path-123?key=${KEY}#frag`)]);
  const got = await fetchFollowSameOriginOnce(`${A}/v1/models`, {}, { fetchImpl });
  const msg = redirectRefusedMessage(got.refused);
  assert.ok(msg.includes('127.0.0.1:6802'), 'm3: 含目标主机名');
  for (const bad of ['http://127.0.0.1:6802', 'secret-path-123', 'key=', 'frag', KEY]) {
    assert.ok(!msg.includes(bad), `m3: 不含 ${bad}`);
  }
}

// i1 生图面板的提示表:redirect 一项(否则重定向会落到「拉取失败（HTTP 502）」兜底)。
// 把 FETCH_HINTS 这个对象字面量的「键: '值'」逐项解析成表,按表里的值断言(不求值源码)。
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../client/src/components/ImagePanel.jsx', import.meta.url), 'utf8');
  const m = src.match(/const FETCH_HINTS = \{([\s\S]*?)\n\};/);
  assert.ok(m, 'i1: ImagePanel.jsx 里找得到 FETCH_HINTS');
  const hints = Object.fromEntries([...m[1].matchAll(/^\s*([\w-]+):\s*'([^']*)',/gm)].map((x) => [x[1], x[2]]));
  assert.equal(hints.redirect, '上游要求跳转，已停止拉取。', 'i1: redirect 提示文字逐字');
  assert.ok(!/改成|改填|最终地址/.test(hints.redirect), 'i1: 不引导改填跳转目标');
  for (const k of ['auth', 'network', 'unsupported']) assert.equal(typeof hints[k], 'string', `i1: 原有 ${k} 一项还在`);
}

console.log('✓ check-r181-probe-no-redirect: 全部通过');
