// r96 P1 自测:normalizeOpenAIUsage 的候选表/边界 + 流式与非流式两个调用点确实共用它。
// 假上游 listen(0)、零外网、用完即关。跑法:node tests/unit/check-r96-dev-usage.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { normalizeOpenAIUsage } from '../../server/utils/openai-usage.js';
import { startOpenAIProxy, setOpenAIUpstream } from '../../server/services/openai-proxy.js';

const K = ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens'];
const triple = (r) => [r.input_tokens, r.cache_read_input_tokens, r.cache_creation_input_tokens];

// ── 1. 换算矩阵(9 行,输入侧一律带 completion_tokens:20) ────────────────────
const MATRIX = [
  [{ prompt_tokens: 1000, prompt_cache_hit_tokens: 896, prompt_cache_miss_tokens: 104 }, [104, 896, 0], 'DeepSeek'],
  [{ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 896 } }, [104, 896, 0], 'OpenAI/GLM'],
  [{ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 896 }, [104, 896, 0], '显式 0 不短路'],
  [{ prompt_tokens: 1000, cached_tokens: 896 }, [104, 896, 0], 'Kimi/Moonshot 顶层'],
  [{ prompt_tokens: 1000, cache_read_input_tokens: 896, cache_creation_input_tokens: 50 }, [54, 896, 50], 'anthropic 命名顶层'],
  [{ prompt_tokens: 1000, prompt_tokens_details: { cache_read_input_tokens: 896 } }, [104, 896, 0], 'anthropic 命名嵌套'],
  [{ prompt_tokens: 1000, cached_tokens: 700, cache_creation_input_tokens: 200 }, [100, 700, 200], 'creation 透传'],
  [{ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 700, cache_creation_input_tokens: 200 } }, [100, 700, 200], 'creation 嵌套'],
  [{ prompt_tokens: 1000 }, [1000, 0, 0], '无缓存字段 → creation 必须 0'],
].map(([u, out, name]) => [{ ...u, completion_tokens: 20 }, out, name]);

for (const [u, want, name] of MATRIX) {
  const frozen = JSON.stringify(u);
  const r = normalizeOpenAIUsage(u);
  assert.deepEqual(Object.keys(r).sort(), K, `${name}: 必须恒含且仅含 4 键`);
  assert.deepEqual(triple(r), want, `${name}: [input, read, creation] 不符`);
  assert.equal(r.output_tokens, 20, `${name}: output`);
  assert.equal(r.input_tokens + r.cache_read_input_tokens + r.cache_creation_input_tokens, u.prompt_tokens, `${name}: 恒等式 input+read+creation === prompt_tokens`);
  assert.equal(JSON.stringify(u), frozen, `${name}: 不得改入参`);
  assert.deepEqual(normalizeOpenAIUsage(u), r, `${name}: 纯函数,多次调用同结果`);
}

// ── 2. 边界与不变式 ──────────────────────────────────────────────────────────
for (const bad of [null, undefined, 'x', 0, [], {}, { prompt_tokens_details: null }, { prompt_tokens_details: 'x' }]) {
  const r = normalizeOpenAIUsage(bad);
  assert.deepEqual(Object.keys(r).sort(), K);
  assert.deepEqual([r.input_tokens, r.output_tokens, ...triple(r).slice(1)], [0, 0, 0, 0], `${JSON.stringify(bad)} → 全 0`);
}
const noPrompt = normalizeOpenAIUsage({ input_tokens: 300, cache_read_input_tokens: 700, output_tokens: 9 });
assert.deepEqual([noPrompt.input_tokens, noPrompt.cache_read_input_tokens, noPrompt.output_tokens], [300, 700, 9], '无 prompt_tokens 时 input 不再减 read');
assert.equal(normalizeOpenAIUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 900 }).input_tokens, 0, 'read > prompt 必须钳位到 0');
assert.equal(normalizeOpenAIUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 100 }, prompt_cache_hit_tokens: 896 }).cache_read_input_tokens, 100, '候选冲突按顺序先到先得');
assert.deepEqual(triple(normalizeOpenAIUsage({ prompt_tokens: '1000', cached_tokens: '896' })), [0, 0, 0], '字符串数字不算候选');
assert.equal(normalizeOpenAIUsage({ prompt_tokens: 1000, cached_tokens: -5, prompt_cache_hit_tokens: 896 }).cache_read_input_tokens, 896, '负数不算候选');
assert.equal(normalizeOpenAIUsage({ prompt_tokens: 1000, cached_tokens: NaN, prompt_cache_hit_tokens: 896 }).cache_read_input_tokens, 896, 'NaN 不算候选');
assert.equal(normalizeOpenAIUsage({ completion_tokens: 0, output_tokens: 7 }).output_tokens, 7, 'completion 显式 0 时回落 output_tokens');
assert.equal(normalizeOpenAIUsage({ completion_tokens: 5, output_tokens: 99 }).output_tokens, 5, 'completion 优先');
for (const r of [normalizeOpenAIUsage({ prompt_tokens: -1 }), normalizeOpenAIUsage({ prompt_tokens: Infinity, cached_tokens: 5 })]) {
  for (const k of K) assert.ok(Number.isFinite(r[k]) && r[k] >= 0, `${k} 必须是有限非负数`);
}

// ── 3. 零依赖(模块不得有 import/require/process/fetch) ──────────────────────
const U = readFileSync(new URL('../../server/utils/openai-usage.js', import.meta.url), 'utf8');
for (const re of [/^import /m, /require\(/, /process\./, /fetch\(/]) assert.ok(!re.test(U), `openai-usage.js 不得出现 ${re}`);

// ── 4. 接线:流式与非流式两条路都过同一个函数 ────────────────────────────────
let nextUsage = null;
const upstreamSrv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const stream = JSON.parse(b).stream;
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n'
        + `data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":${JSON.stringify(nextUsage)}}\n\n`
        + 'data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: nextUsage }));
    }
  });
});
await new Promise((r) => upstreamSrv.listen(0, '127.0.0.1', r));
const upPort = upstreamSrv.address().port;
const proxyPort = await startOpenAIProxy(0);
setOpenAIUpstream({ baseURL: `http://127.0.0.1:${upPort}/v1`, apiKey: 'k' });

const send = async (stream) => {
  const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream, max_tokens: 100 }),
  });
  const txt = await resp.text();
  if (!stream) return JSON.parse(txt);
  const line = txt.split('\n').find((l) => l.startsWith('data: ') && l.includes('message_delta'));
  return JSON.parse(line.slice(6));
};

for (const [u, want, name] of MATRIX) {
  nextUsage = u;
  const sd = await send(true);
  assert.deepEqual(sd.usage, normalizeOpenAIUsage(u), `流式 ${name}: message_delta.usage 与纯函数不一致`);
  assert.deepEqual(triple(sd.usage), want, `流式 ${name}`);
  const ns = await send(false);
  assert.deepEqual(ns.usage, normalizeOpenAIUsage(u), `非流式 ${name}: usage 与纯函数不一致`);
  assert.deepEqual(triple(ns.usage), want, `非流式 ${name}`);
  assert.equal(sd.delta.stop_reason, 'end_turn');
  assert.equal(ns.stop_reason, 'end_turn');
}
// R3 / R4 的正脸断言(修前分别是 0 与 undefined)
nextUsage = { prompt_tokens: 1000, cached_tokens: 896, completion_tokens: 20 };
assert.equal((await send(true)).usage.cache_read_input_tokens, 896, 'R3 Kimi 顶层 cached_tokens 流式必须读出');
nextUsage = { prompt_tokens: 1000, cached_tokens: 700, cache_creation_input_tokens: 200, completion_tokens: 20 };
assert.equal((await send(false)).usage.cache_creation_input_tokens, 200, 'R4 非流式 creation 必须透出');

// 上游 chunk 不带 usage → message_delta 走既有兜底 { output_tokens: 0 }
nextUsage = undefined;
const noUsage = await send(true);
assert.deepEqual(noUsage.usage, { output_tokens: 0 }, '无 usage 的 chunk 不得覆写,保留既有兜底');

// ── 5. 源码锁:两个调用点都换了,候选表整体搬进 util ──────────────────────────
const OP = readFileSync(new URL('../../server/services/openai-proxy.js', import.meta.url), 'utf8');
assert.ok(/import \{ normalizeOpenAIUsage \} from '\.\.\/utils\/openai-usage\.js'/.test(OP), '缺 import');
assert.ok((OP.match(/normalizeOpenAIUsage\(/g) || []).length >= 2, '流式+非流式两个调用点都要换');
assert.ok(/if \(json\.usage\)/.test(OP), '流式 usage 守卫必须保留');
assert.ok(/usage: \{ input_tokens: 0, output_tokens: 0 \}/.test(OP), 'message_start 恒 0 不得动');
assert.ok(/usage: usage \|\| \{ output_tokens: 0 \}/.test(OP), 'message_delta 兜底不得动');
assert.ok(/for \(const tr of toolResults\) out\.push\(tr\);/.test(OP), 'tool_result 先行不得动');
// r101:判据改成「非 assistant 一律 user」(中途 system 会让上游作废整个前缀,含 tools)
assert.ok(/=== 'assistant' \? 'assistant' : 'user'/.test(OP), 'r101 role 判据');
assert.ok(!/'system' \? 'system'/.test(OP), 'r96 的中途 system 白名单必须已被撤掉');
assert.ok(/故意不发/.test(OP), 'P2 反向约束注释');
for (const re of [/prompt_tokens_details/, /prompt_cache_hit_tokens/, /cached_tokens/, /body\.metadata/, /req\.user\s*=/]) {
  assert.ok(!re.test(OP), `openai-proxy.js 不得再出现 ${re}`);
}
for (const re of [/out\.push\(\{ role: 'user', content: \[/, /out\.push\(\{ role: 'user', content: txt \}\)/]) {
  assert.ok(!re.test(OP), `硬写 user 的 push 必须消失: ${re}`);
}

await new Promise((r) => upstreamSrv.close(r));   // 代理的临时口由 process.exit(0) 释放
console.log('✅ r96-dev-usage: 9 行矩阵 + 边界 + 流式/非流式接线 + 源码锁 全部通过');
process.exit(0);
