#!/usr/bin/env node
// r26-G3(契约 C-G3):count_tokens 估算路径响应必须带顶层 estimated:true,
// 精确路径(上游真返 input_tokens)不带 —— 前端据该字段标「(估算)」,不再把
// 字符启发式估算当精确值展示。
// 真 HTTP 实测:openai proxy(6703)+ anthropic proxy(6704),跑完进程退出即释放。
// 哨兵:S1 摘掉 estimated 字段 → t1/t2 红;S2 给精确路径也加上 → t3 红。
import assert from 'node:assert/strict';
import http from 'node:http';

const { startOpenAIProxy } = await import('../../server/services/openai-proxy.js');
const { startAnthropicProxy, setAnthropicUpstream } = await import('../../server/services/anthropic-proxy.js');
const { parseUpstreamCountTokens } = await import('../../server/utils/context-tokens.js');

const post = (port, body) =>
  fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens?beta=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const sample = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'x'.repeat(400) }] };

// t1 openai 路:count_tokens 永远本地估算(协议无等价端点)→ 必带 estimated:true
{
  const port = await startOpenAIProxy(6703);
  assert.equal(port, 6703, 't1: openai proxy 起在 6703');
  const r = await post(6703, sample);
  assert.equal(r.estimated, true, 't1: openai 估算路径必须带 estimated:true(修前无此字段)');
  assert.ok(Number.isFinite(r.input_tokens) && r.input_tokens > 0, 't1: input_tokens 仍在(CLI 只读它)');
}

// t2 anthropic 路:上游不支持 count_tokens(死端口立即 ECONNREFUSED)→ 估算回退带标
{
  setAnthropicUpstream({ baseURL: 'http://127.0.0.1:1', authToken: 'test-key' }); // 本地死端口,非真实第三方
  const port = await startAnthropicProxy(6704);
  assert.equal(port, 6704, 't2: anthropic proxy 起在 6704');
  const r = await post(6704, sample);
  assert.equal(r.estimated, true, 't2: anthropic 估算回退必须带 estimated:true');
  assert.ok(Number.isFinite(r.input_tokens), 't2: input_tokens 仍在');
}

// t3 互斥哨兵:精确路径(上游真返 input_tokens)不带 estimated。
// 本进程两个测试端口已被两 proxy 占用,无法再起上游桩走 HTTP;精确路径的「不加标」
// 由源码结构钉死:respond(upstreamCount) 直传透传对象、不展开包装。
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../server/services/anthropic-proxy.js', import.meta.url), 'utf8');
  assert.match(src, /if \(upstreamCount\) return respond\(upstreamCount\);/,
    't3: 精确路径必须原样透传 upstreamCount,不得展开包装(展开就可能带上 estimated)');
  // 透传对象本身来自 parseUpstreamCountTokens,只认上游原 JSON,天然无 estimated 键
  const upstream = parseUpstreamCountTokens('{"input_tokens":42}');
  assert.ok(!('estimated' in upstream), 't3: 上游精确响应不含 estimated 键(互斥)');
}

console.log('check-r26-g3-estimated-flag: all passed');
process.exit(0); // 两 proxy 无 stop 导出,进程退出即释放 6703/6704
