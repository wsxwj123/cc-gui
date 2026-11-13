#!/usr/bin/env node
// r178b:openai 协议代理里「上游按 200 返回了根本不是回复的东西」时用到的三个纯函数(白盒)。
//   · summarizeUpstreamBody:字段取值顺序、去网页标签、清理控制字符、截断、限时。
//   · maskSecret:Key 打码(靠前、跨截断点、中间夹控制字符、不足 8 个字符、多处重叠)。
//   · isStreamChunkShape:流里「认得的数据块」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// 隔离:导入代理模块之前把 HOME / USERPROFILE 指到临时目录,清掉 ANTHROPIC_* 与代理环境变量
const unitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'r178b-unit-home-'));
process.env.HOME = unitHome;
process.env.USERPROFILE = unitHome;
for (const name of Object.keys(process.env)) if (name.startsWith('ANTHROPIC_')) delete process.env[name];
for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete process.env[name];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

const {
  summarizeUpstreamBody, maskSecret, isStreamChunkShape, pickUnrecognizedSource, startOpenAIProxy, setOpenAIUpstream,
} = await import('../../server/services/openai-proxy.js');

const KEY = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012'; // 32 个字符的假 Key
assert.equal(KEY.length, 32);
const noKeyRun = (s, label) => {
  for (let i = 0; i + 8 <= KEY.length; i++) {
    assert.ok(!s.includes(KEY.slice(i, i + 8)), `${label}:摘要里出现了 Key 的 8 字符片段 ${i}`);
  }
};
let n = 0;
const ok = () => { n++; };

// ── 字段取值顺序与「不是字符串的跳过」 ─────────────────────────────────────────
assert.equal(summarizeUpstreamBody({ error: 'E', msg: 'M', message: 'G', detail: 'D', error_msg: 'X' }), 'E'); ok();
assert.equal(summarizeUpstreamBody({ error: { code: 1 }, msg: 'M', message: 'G' }), 'M', 'error 不是字符串时跳过'); ok();
assert.equal(summarizeUpstreamBody({ msg: '   ', message: 'G', detail: 'D' }), 'G', '空白字符串跳过'); ok();
assert.equal(summarizeUpstreamBody({ msg: 42, message: null, detail: 'D', error_msg: 'X' }), 'D'); ok();
assert.equal(summarizeUpstreamBody({ msg: ['a'], error_msg: 'X' }), 'X'); ok();
assert.equal(summarizeUpstreamBody({ code: 429 }), '{"code":429}', '都没有就用整段原文'); ok();
assert.equal(summarizeUpstreamBody('{"code":429,"msg":"余额不足,请充值"}'), '余额不足,请充值', '字符串形式的 JSON 同样取字段'); ok();
assert.equal(summarizeUpstreamBody('{"code":429}'), '{"code":429}'); ok();
assert.equal(summarizeUpstreamBody('{"success":false,"message":"model not found: x"}'), 'model not found: x'); ok();
assert.equal(summarizeUpstreamBody({ id: 'c1', choices: [] }), '{"id":"c1","choices":[]}'); ok();
assert.equal(summarizeUpstreamBody([1, 2]), '[1,2]', '数组按原文'); ok();

// ── 空与无文字 ────────────────────────────────────────────────────────────────
assert.equal(summarizeUpstreamBody(''), '响应体为空'); ok();
assert.equal(summarizeUpstreamBody('  \n\t '), '响应体为空'); ok();
assert.equal(summarizeUpstreamBody('<html><body></body></html>'), '响应体没有可读文字'); ok();
assert.equal(summarizeUpstreamBody('\u0001\u0002\u200B'), '响应体没有可读文字'); ok();

// ── 去网页标签、script / style / 注释 ─────────────────────────────────────────
assert.equal(summarizeUpstreamBody('<html><body><h1>504 Gateway Time-out</h1></body></html>'), '504 Gateway Time-out'); ok();
{
  const s = summarizeUpstreamBody('<html><head><style>body{color:red}</style><SCRIPT type="x">alert("坏")</SCRIPT></head><body><!-- 注释 <b>x</b> --><p>网关&nbsp;错误</p></body></html>');
  assert.equal(s, '网关 错误'); ok();
}
{
  const s = summarizeUpstreamBody('<p>前</p><img src="data:image/png;base64,AAAA"> 网关错误 a < b > c');
  assert.ok(!s.includes('<') && !s.includes('>'), `不含尖括号:${s}`);
  assert.ok(s.includes('网关错误') && s.startsWith('前'), s); ok();
}
assert.equal(summarizeUpstreamBody('<p>保留</p><script>x'), '保留', '没有闭合的 script 删到末尾'); ok();
assert.equal(summarizeUpstreamBody('upstream busy, please retry later'), 'upstream busy, please retry later', '纯文本原样'); ok();

// ── 清理:控制字符、双向控制符、压空白 ──────────────────────────────────────────
assert.equal(summarizeUpstreamBody('a\u0001b\u007Fc\u0085d\u202Ee\u2066f\u200Bg\uFEFFh'), 'abcdefgh'); ok();
assert.equal(summarizeUpstreamBody('  a \n\n\t b\r\n  c  '), 'a b c'); ok();

// ── 截断到 300 个码点 ──────────────────────────────────────────────────────────
{
  const s = summarizeUpstreamBody('x'.repeat(5000));
  assert.equal(Array.from(s).length, 301); assert.ok(s.endsWith('…')); ok();
  const e = summarizeUpstreamBody('😀'.repeat(400));
  assert.equal(Array.from(e).length, 301, '按码点数,不按码元'); assert.ok(e.endsWith('…')); ok();
  assert.equal(summarizeUpstreamBody('y'.repeat(300)), 'y'.repeat(300), '恰好 300 不加省略号'); ok();
}

// ── Key 打码 ──────────────────────────────────────────────────────────────────
{
  const a = summarizeUpstreamBody('error for key ' + KEY + ' please check', KEY); // 靠前
  assert.ok(a.includes('***'), a); noKeyRun(a, '靠前'); assert.equal(a, 'error for key *** please check'); ok();

  const b = summarizeUpstreamBody('a'.repeat(290) + KEY + 'tail', KEY); // 跨截断点
  noKeyRun(b, '跨截断点'); ok();
  // 打码在截断之前:截断点前的 10 个 Key 字符也不会漏出来
  const b2 = summarizeUpstreamBody('a'.repeat(290) + KEY + 'b'.repeat(300), KEY);
  noKeyRun(b2, '跨截断点 2'); assert.ok(b2.includes('***')); ok();

  const c = summarizeUpstreamBody('key=' + KEY.slice(0, 16) + '\u0001' + KEY.slice(16) + ' end', KEY); // 中间夹控制字符
  assert.ok(c.includes('***'), c); noKeyRun(c, '夹控制字符'); assert.equal(c, 'key=*** end'); ok();

  assert.equal(maskSecret('abc1234 abc1234', 'abc1234'), 'abc1234 abc1234', 'Key 不足 8 个字符不打码'); ok();
  assert.equal(maskSecret('abc', ''), 'abc'); ok();
  assert.equal(maskSecret('abc', undefined), 'abc'); ok();
  // 多处重叠:Key 的两段重叠片段与多次出现
  assert.equal(maskSecret('[' + KEY.slice(0, 12) + '][' + KEY.slice(5, 20) + ']' + KEY + KEY, KEY), '[***][***]***'); ok();
  assert.equal(maskSecret('x' + KEY.slice(3, 10) + 'y', KEY), 'x' + KEY.slice(3, 10) + 'y', '7 个字符的片段不打码'); ok();
  assert.equal(maskSecret('aaaaaaaaaaa', 'aaaaaaaa'), '***', '自重叠'); ok();
  assert.equal(maskSecret(KEY.toLowerCase(), KEY), KEY.toLowerCase(), '区分大小写'); ok();
}

// ── isStreamChunkShape ────────────────────────────────────────────────────────
for (const [v, want] of [
  [{ choices: [] }, true],
  [{ choices: [{ delta: {} }] }, true],
  [{ choices: [{ code: 429 }] }, true],
  [{ usage: { prompt_tokens: 1 } }, true],
  [{ choices: [], usage: {} }, true],
  [{ code: 429, msg: '余额不足' }, false],
  [{ choices: null }, false],
  [{ choices: {} }, false],
  [{ usage: null }, false],
  [{ usage: [] }, false],
  [{ usage: 3 }, false],
  [[], false],
  [null, false],
  [undefined, false],
  ['{"choices":[]}', false],
  [42, false],
]) { assert.equal(isStreamChunkShape(v), want, JSON.stringify(v)); ok(); }

// ── 限时:不得平方级 ──────────────────────────────────────────────────────────
{
  const big = '<a'.repeat(32768); // 65536 个码元,没有 >
  assert.equal(big.length, 65536);
  let t0 = performance.now();
  const s1 = summarizeUpstreamBody(big, KEY);
  let ms = performance.now() - t0;
  assert.ok(ms < 200, `<a 重复耗时 ${ms.toFixed(1)}ms`);
  // 没有一个完整标签,不像网页,按纯文本原样(截断到 300 码点)
  assert.equal(s1, '<a'.repeat(150) + '…'); ok();

  const bigHtml = '<p>' + '<a'.repeat(32766); // 像网页,标签正则在每个 <a 上都要尝试
  t0 = performance.now();
  const sh = summarizeUpstreamBody(bigHtml, KEY);
  ms = performance.now() - t0;
  assert.ok(ms < 200, `网页里 <a 重复耗时 ${ms.toFixed(1)}ms`);
  assert.ok(!sh.includes('<') && !sh.includes('>'), '网页里剩下的尖括号换成空格'); ok();

  const big2 = '<script' + 'x'.repeat(65529);
  t0 = performance.now();
  const s2 = summarizeUpstreamBody(big2, KEY);
  ms = performance.now() - t0;
  assert.ok(ms < 200, `只有 <script 耗时 ${ms.toFixed(1)}ms`);
  assert.equal(s2, '响应体没有可读文字'); ok();

  const big3 = '<!--'.repeat(20000) + '<script'.repeat(5000) + '<style'.repeat(5000);
  t0 = performance.now();
  summarizeUpstreamBody(big3, KEY);
  ms = performance.now() - t0;
  assert.ok(ms < 200, `大量未闭合开始标记耗时 ${ms.toFixed(1)}ms`); ok();
}

// ── pickUnrecognizedSource:回放那一支的摘要来源 ─────────────────────────────────
{
  const u1 = '{"code":429,"msg":"余额不足,请充值"}';
  const raw1 = 'data: ' + u1 + '\n\n';
  assert.equal(pickUnrecognizedSource(u1, raw1), u1, '1 unrec 取得到字段 → 用 unrec');
  assert.equal(summarizeUpstreamBody(pickUnrecognizedSource(u1, raw1), KEY), '余额不足,请充值'); ok();
  const raw2 = 'Error: quota exceeded\ndata: see the billing page\n';
  assert.equal(pickUnrecognizedSource('Error: quota exceeded', raw2), raw2, '2 unrec 不是 JSON → 整段'); ok();
  assert.equal(pickUnrecognizedSource('{"code":429}', 'RAW3'), 'RAW3', '3 没有可用字段 → 整段'); ok();
  assert.equal(pickUnrecognizedSource('U4', undefined), 'U4', '4 replayRaw 为 undefined'); ok();
  assert.equal(pickUnrecognizedSource('U4', null), 'U4', '4 replayRaw 为 null'); ok();
  assert.equal(pickUnrecognizedSource('{"error":{"message":"x"}}', 'RAW5'), 'RAW5', '5 error 是对象 → 整段'); ok();
}

// ── 读上游响应体中途失败:保持改之前的行为(200 空消息,不带 x-should-retry) ─────────
{
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"id":"c1","object":"chat.completion","ch');
      setTimeout(() => res.socket.destroy(), 20);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const proxyPort = await startOpenAIProxy(0);
  setOpenAIUpstream({ baseURL: `http://127.0.0.1:${upPort}/v1`, apiKey: KEY, model: 'test-model' });
  for (const stream of [false, true]) {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'test-model', max_tokens: 16, stream, messages: [{ role: 'user', content: '你好' }] }),
    });
    const label = `读失败(stream=${stream})`;
    assert.equal(r.status, 200, `${label}:状态码`);
    assert.equal(r.headers.get('x-should-retry'), null, `${label}:不带 x-should-retry`);
    const body = await r.json();
    assert.equal(body.type, 'message', `${label}:是消息`);
    assert.deepEqual(body.content, [], `${label}:内容数组为空`);
    ok();
  }
  await new Promise((r) => upstream.close(r));
}

// ── 流那一支累积不认识的内容(多行非 SSE 正文不只剩第一行) ───────────────────────
{
  const PREFIX = '上游返回了无法识别的响应(HTTP 200):';
  let cur = { ct: 'text/event-stream', body: '' };
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': cur.ct }); res.end(cur.body); });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxyPort = await startOpenAIProxy(0);
  setOpenAIUpstream({ baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: KEY, model: 'test-model' });
  const call = async (ct, body) => {
    cur = { ct, body };
    const t0 = performance.now();
    const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'test-model', max_tokens: 16, stream: true, messages: [{ role: 'user', content: '你好' }] }),
    });
    const j = await r.json();
    return { status: r.status, retry: r.headers.get('x-should-retry'), message: j?.error?.message ?? '', ms: performance.now() - t0 };
  };
  const ES = 'text/event-stream';
  const is502 = (r, label) => {
    assert.equal(r.status, 502, `${label}:状态码`);
    assert.equal(r.retry, 'false', `${label}:x-should-retry`);
    assert.ok(r.message.startsWith(PREFIX), `${label}:前缀,实际 ${r.message}`);
  };
  let r = await call(ES, '{\n  "code": 429,\n  "msg": "余额不足,请充值"\n}\n');
  is502(r, 'D1 多行 JSON'); assert.equal(r.message, PREFIX + '余额不足,请充值'); ok();
  r = await call(ES, 'upstream busy\ntry again later\n');
  is502(r, 'D2 两行纯文本'); assert.ok(r.message.includes('upstream busy') && r.message.includes('try again later'), r.message); ok();
  r = await call(ES, '<!DOCTYPE html>\n<html><body>\n<h1>504 Gateway Time-out</h1>\n</body></html>\n');
  is502(r, 'D3 多行网页');
  assert.ok(r.message.includes('504 Gateway Time-out') && !r.message.includes('<') && !r.message.includes('>'), r.message); ok();
  r = await call(ES, 'data: {"code":429,"msg":"余额不足,请充值"}\n\n');
  is502(r, 'D4a 单行数据'); assert.equal(r.message, PREFIX + '余额不足,请充值'); ok();
  r = await call('text/plain', 'Error: quota exceeded\ndata: see the billing page\n');
  is502(r, 'D4b 回放整段'); assert.ok(r.message.includes('Error: quota exceeded') && r.message.includes('data: see the billing page'), r.message); ok();
  r = await call(ES, 'x\n'.repeat(30000));
  is502(r, 'D5 三万行');
  assert.ok(r.ms < 500, `D5 耗时 ${r.ms.toFixed(1)}ms`);
  assert.ok(Array.from(r.message).length <= 330, `D5 长度 ${Array.from(r.message).length}`); ok();
  await new Promise((res) => upstream.close(res));
}

// ── 清理先于打码:Key 每 7 个字符夹一个控制字符(先打码后清理的实现在这条上会失败) ──
{
  const ctl = String.fromCodePoint(1);
  let spaced = '';
  for (let i = 0; i < KEY.length; i += 7) spaced += (i ? ctl : '') + KEY.slice(i, i + 7);
  const s = summarizeUpstreamBody('token=' + spaced + ' end', KEY);
  noKeyRun(s, '每 7 个字符夹控制字符');
  assert.ok(s.includes('***'), `应含 ***,实际 ${s}`); ok();
}

// ── 看守:源码里不得出现零宽字符、双向控制符、BOM 的字面字符(一律写转义) ──────────
{
  const { readFileSync } = await import('node:fs');
  const invisibleRanges = [[0x200B, 0x200F], [0x202A, 0x202E], [0x2066, 0x2069], [0xFEFF, 0xFEFF]];
  for (const rel of ['../../server/services/openai-proxy.js', './check-r178b-proxy-unrecognized.mjs']) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const hits = [];
    let line = 1;
    for (const ch of src) {
      const cp = ch.codePointAt(0);
      if (cp === 10) line++;
      if (invisibleRanges.some(([a, b]) => cp >= a && cp <= b)) hits.push(`第 ${line} 行 U+${cp.toString(16).toUpperCase()}`);
    }
    assert.deepEqual(hits, [], `${rel} 里有看不见的字面字符,改用转义写法`); ok();
  }
}

console.log(`check-r178b-proxy-unrecognized: ${n} 项通过`);
process.exit(0); // 代理没有停止用的导出,监听会让进程挂着
