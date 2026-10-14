#!/usr/bin/env node
// r151a T-Y1:openai 协议代理 buildOpenAIRequest 的 stream 判定与 stop 转发(INTERFACE Y.3.2 前半)。
//   · 输入 stream === true 才流式(带 stream_options);缺失 / false / 其它任何值 → stream:false 且没有 stream_options。
//     根因:Anthropic 协议缺省就是非流式;CLI 的 auto 审核请求不带 stream 字段,旧判定 `!== false`
//     把它当流式转发,CLI 收到事件流判"审核不可用"并拒绝(验证 G 的 g2a)。
//   · 只在 stream:false 时把 stop_sequences 里的非空字符串按序取前 4 个转成 stop;流式一律没有 stop。
//   · 其余键与改动前逐项相同(流式逐字节基线另见 check-r151a-baseline.mjs)。
import assert from 'node:assert/strict';
import { buildOpenAIRequest } from '../../server/services/openai-proxy.js';

const BASE = {
  model: 'r151-audit', max_tokens: 2112, system: '审核系统提示',
  messages: [{ role: 'user', content: '<transcript>x</transcript>' }],
  metadata: { user_id: 'u' },
};
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const build = (patch, drop = []) => {
  const input = structuredClone({ ...BASE, ...patch });
  for (const k of drop) delete input[k];
  return buildOpenAIRequest(input);
};

// ── stream 判定 ──────────────────────────────────────────────────────────────
{
  const r = build({ stream: true });
  assert.equal(r.stream, true, 'stream:true → 流式');
  assert.deepEqual(r.stream_options, { include_usage: true }, 'stream:true → 带 stream_options');
}
for (const [label, patch, drop] of [
  ['stream 缺失', {}, ['stream']],
  ['stream:false', { stream: false }, []],
  ['stream:"true"', { stream: 'true' }, []],
  ['stream:1', { stream: 1 }, []],
  ['stream:null', { stream: null }, []],
  ['stream:{}', { stream: {} }, []],
]) {
  const r = build(patch, drop);
  assert.equal(r.stream, false, `${label} → stream:false`);
  assert.ok(!('stream_options' in r), `${label} → 没有 stream_options 键`);
}

// ── stop_sequences → stop(只在非流式) ──────────────────────────────────────
for (const [label, seqs, want] of [
  ['单个', ['</block>'], ['</block>']],
  ['夹空串且超过 4 个', ['', 'a', 'b', '', 'c', 'd', 'e'], ['a', 'b', 'c', 'd']],
  ['非字符串项被跳过', [1, null, 'x', {}, ['y'], undefined], ['x']],
  ['中文与表情', ['</块>', '😀'], ['</块>', '😀']],
  ['只有空白的串也算非空', [' '], [' ']],
  ['恰好 4 个', ['1', '2', '3', '4'], ['1', '2', '3', '4']],
]) {
  const r = build({ stop_sequences: seqs }, ['stream']);
  assert.deepEqual(r.stop, want, `stop_sequences ${label}`);
}
for (const [label, seqs] of [
  ['缺失', undefined],
  ['空数组', []],
  ['不是数组(字符串)', '</block>'],
  ['不是数组(对象)', { 0: 'a' }],
  ['全是空串', ['', '']],
  ['没有任何非空字符串', [0, null, false]],
]) {
  const input = { ...BASE };
  if (seqs !== undefined) input.stop_sequences = seqs;
  const r = buildOpenAIRequest(structuredClone(input));
  assert.ok(!('stop' in r), `stop_sequences ${label} → 没有 stop 键`);
}
{
  const r = build({ stream: true, stop_sequences: ['</block>'] });
  assert.ok(!('stop' in r), '流式请求即使带 stop_sequences 也没有 stop 键');
}
{
  const r = build({ stream: false, stop_sequences: ['</block>'] });
  assert.deepEqual(r.stop, ['</block>'], 'stream:false 同样转 stop');
}
{
  const seqs = ['a', 'b'];
  const input = { ...BASE, stop_sequences: seqs };
  const r = buildOpenAIRequest(input);
  assert.notEqual(r.stop, seqs, 'stop 是新数组,不与输入共用引用');
  assert.deepEqual(input.stop_sequences, ['a', 'b'], '不改写输入');
}

// ── 其余键与改动前相同:非流式与流式输出去掉 stream / stream_options / stop 后逐项相等 ──
{
  const TOOLS = [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: {} } }];
  const rich = { ...BASE, temperature: 0.2, top_p: 0.5, effort: 'high', tools: TOOLS, tool_choice: { type: 'auto' }, stop_sequences: ['</block>'] };
  const nonStream = buildOpenAIRequest(structuredClone(rich));
  const stream = buildOpenAIRequest(structuredClone({ ...rich, stream: true }));
  const KEYS = ['stream', 'stream_options', 'stop'];
  assert.deepEqual(without(nonStream, KEYS), without(stream, KEYS), '非流式输出的其余键与流式(= 改动前)逐项相同');
}

console.log('PASS check-r151a-proxy');
