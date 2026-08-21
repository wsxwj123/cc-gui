#!/usr/bin/env node
// r26-G11:openai-proxy 响应方向必须翻译 delta.reasoning_content → anthropic
// thinking 流(修前无分支,deepseek-reasoner 的思考内容在响应流里被静默丢弃)。
// 真 HTTP 端到端:本地上游桩(6704,按请求分流 SSE/JSON)→ openai proxy(6703)。
// 哨兵:S1 删掉 reasoning_content 分支 → t1/t2/t3 全红;S2 thinking/text 不互斥
//       (交错时后到的 thinking 插进已开 text 块或不关旧块)→ t3 顺序断言红。
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

const { startOpenAIProxy, setOpenAIUpstream } = await import('../../server/services/openai-proxy.js');

// 隔壁 worktree 可能也在跑测试:启动前等端口空闲(EADDRINUSE 退让重试,同
// tests/acceptance/r26/lib.mjs 的 listenWithRetry 口径)。
const waitPortFree = async (port, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const free = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(port, '127.0.0.1');
    });
    if (free) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`端口 ${port} 持续被占用,重试 ${tries} 次后放弃`);
};
await waitPortFree(6704);
await waitPortFree(6703);

// ── 本地上游桩:stream=true → SSE(reasoning 与 content 交错);否则 → JSON ──
const SSE_BODY = [
  'data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}',
  'data: {"choices":[{"delta":{"reasoning_content":"清楚"}}]}',
  'data: {"choices":[{"delta":{"content":"正文"}}]}',
  'data: {"choices":[{"delta":{"reasoning_content":"再补一句思考"}}]}', // 交错:reasoning 又到
  'data: {"choices":[{"delta":{"content":"结束"},"finish_reason":"stop"}]}',
  'data: [DONE]',
  '',
].join('\n');

const upstream = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    const body = JSON.parse(data || '{}');
    if (body.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-x',
        choices: [{ message: { role: 'assistant', reasoning_content: '非流式思考', content: '非流式正文' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(SSE_BODY);
  });
});
await new Promise((r) => upstream.listen(6704, '127.0.0.1', r));

setOpenAIUpstream({ baseURL: 'http://127.0.0.1:6704/v1', apiKey: 'test', model: 'deepseek-reasoner-x' });
const proxyPort = await startOpenAIProxy(6703);
assert.equal(proxyPort, 6703, 'proxy 起在 6703');

const postMessages = (body) => fetch(`http://127.0.0.1:6703/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-reasoner-x', messages: [{ role: 'user', content: 'hi' }], ...body }),
});

// 解析 anthropic SSE 事件流为 [{event, data}]
const parseSSE = (text) => {
  const events = [];
  for (const chunk of text.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(chunk)?.[1];
    const dt = /^data: (.+)$/m.exec(chunk)?.[1];
    if (ev && dt) events.push({ event: ev, data: JSON.parse(dt) });
  }
  return events;
};

// t1(翻译哨兵):流式 reasoning_content → thinking 块事件链,内容完整
{
  const r = await postMessages({ stream: true });
  assert.equal(r.status, 200, 't1: 200');
  const events = parseSSE(await r.text());
  const thinkingDeltas = events.filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta');
  const thinkingText = thinkingDeltas.map((e) => e.data.delta.thinking).join('');
  assert.ok(thinkingDeltas.length >= 2, 't1: 必须出现 thinking_delta 事件(修前一个都没有)');
  assert.equal(thinkingText, '先想清楚再补一句思考', 't1: 思考内容逐字完整(修前被丢弃)');
  const startIdx = events.findIndex((e) => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking');
  assert.ok(startIdx > 0, 't1: thinking content_block_start 存在');
}

// t2(顺序哨兵):thinking 在 content 之前
{
  const r = await postMessages({ stream: true });
  const events = parseSSE(await r.text());
  const firstThinking = events.findIndex((e) => e.data?.delta?.type === 'thinking_delta' || e.data?.content_block?.type === 'thinking');
  const firstText = events.findIndex((e) => e.data?.delta?.type === 'text_delta');
  assert.ok(firstThinking !== -1 && firstText !== -1 && firstThinking < firstText,
    't2: thinking 事件必须出现在 text 正文之前');
  // stop 理由映射不变
  const msgDelta = events.find((e) => e.event === 'message_delta');
  assert.equal(msgDelta?.data?.delta?.stop_reason, 'end_turn', 't2: stop → end_turn 映射不变');
}

// t3(交错相对序哨兵):reasoning → content → reasoning → content 的到达序 =
// 输出 delta 序(thinking A, text x, thinking B, text y),且每个块都合法闭合
{
  const r = await postMessages({ stream: true });
  const events = parseSSE(await r.text());
  const deltas = events.filter((e) => e.event === 'content_block_delta')
    .map((e) => (e.data.delta.type === 'thinking_delta' ? `T:${e.data.delta.thinking}` : `X:${e.data.delta.text}`));
  assert.deepEqual(deltas, ['T:先想', 'T:清楚', 'X:正文', 'T:再补一句思考', 'X:结束'],
    't3: 交错序列保持相对序(thinking 不 prepend 进已发正文,也不丢)');
  // 块开关合法:每个 start 都有对应 stop,且 index 不冲突
  const starts = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.index);
  const stops = events.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);
  assert.deepEqual([...starts].sort(), [...stops].sort(), 't3: 每个内容块都有开有合');
  assert.equal(new Set(starts).size, starts.length, 't3: 块 index 不复用');
}

// t4 非流式:reasoning_content → thinking 块在正文前;空 reasoning 不下发
{
  const r = await postMessages({ stream: false });
  assert.equal(r.status, 200, 't4: 200');
  const j = await r.json();
  assert.equal(j.content[0]?.type, 'thinking', 't4: 非流式首个块是 thinking');
  assert.equal(j.content[0]?.thinking, '非流式思考', 't4: 思考内容完整(修前被丢弃)');
  assert.equal(j.content[1]?.type, 'text', 't4: 正文在 thinking 之后');
  assert.equal(j.stop_reason, 'end_turn', 't4: stop 映射不变');
}

console.log('check-r26-g11-reasoning-content: all passed');
process.exit(0); // proxy/upstream 无 stop 导出,进程退出即释放 6703/6704
