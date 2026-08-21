#!/usr/bin/env node
// r26-G2:并行 tool_calls 误插假桩 —— 两路 proxy 共用 collectRealToolResultIds 全局扫描。
// 验收矩阵(PLAN G2):
//   ① tool_use A/B 并行、result 顺序 [B,A] → 不插桩(误插哨兵)
//   ② A 有 result、B 无 → 只给 B 插桩
//   ③ 全缺 → 全插
//   两路 proxy 各跑一遍同矩阵(行为对齐哨兵)。
// 外加 ④ G2 原始场景:assistant(A) → assistant(B) → user(result A) 不插 A 桩
//   (与 tests/acceptance/r26/g2-parallel-tool-calls-stub.mjs 同场景,修前必红)。
// 哨兵:S1 删掉 realResultIds 全局判定(回紧邻段)→ ①④ 红;S2 删掉整个插桩 → ②③ 红。
import assert from 'node:assert/strict';
import { collectRealToolResultIds } from '../../server/utils/tool-result-reconcile.js';
import { anthropicToOpenAIMessages } from '../../server/services/openai-proxy.js';
import { normalizeMessagesForCompat } from '../../server/services/anthropic-proxy.js';

const STUB_TEXT = '(tool result fed via system context)';

// ── 纯函数层:两种线格式都收 ─────────────────────────────────────────────
{
  const ids = collectRealToolResultIds([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'x' }] },
    { role: 'tool', tool_call_id: 'b2', content: 'y' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c3', name: 'T', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', content: '缺 id 不收' }] },
  ]);
  assert.ok(ids.has('a1') && ids.has('b2'), '纯函数: anthropic/openai 两种形态都收集');
  assert.equal(ids.size, 2, '纯函数: tool_use 与缺 id 的 tool_result 不进集');
  assert.equal(collectRealToolResultIds(null).size, 0, '纯函数: 空输入安全');
}

// ── openai 路 ───────────────────────────────────────────────────────────
const toolUse = (id) => ({ type: 'tool_use', id, name: 'Skill', input: {} });
const toolResult = (id, text) => ({ type: 'tool_result', tool_use_id: id, content: text });
const oaToolMsgsFor = (out, id) => out.filter((m) => m.role === 'tool' && m.tool_call_id === id);

{
  // ① 并行 A/B、result 顺序 [B,A] → 一个桩都不插
  const out = anthropicToOpenAIMessages([
    { role: 'user', content: '开始' },
    { role: 'assistant', content: [toolUse('call_A'), toolUse('call_B')] },
    { role: 'user', content: [toolResult('call_B', 'B 结果'), toolResult('call_A', 'A 结果')] },
  ], null);
  assert.equal(oaToolMsgsFor(out, 'call_A').length, 1, 'openai①: A 不插桩(结果真实存在)');
  assert.equal(oaToolMsgsFor(out, 'call_B').length, 1, 'openai①: B 不插桩(乱序也认)');
  assert.ok(!out.some((m) => m.role === 'tool' && m.content === STUB_TEXT), 'openai①: 零假桩');
}
{
  // ② A 有 result、B 无 → 只给 B 插桩
  const out = anthropicToOpenAIMessages([
    { role: 'assistant', content: [toolUse('call_A'), toolUse('call_B')] },
    { role: 'user', content: [toolResult('call_A', 'A 结果')] },
  ], null);
  assert.equal(oaToolMsgsFor(out, 'call_A')[0]?.content, 'A 结果', 'openai②: A 配对真实结果');
  assert.equal(oaToolMsgsFor(out, 'call_B')[0]?.content, STUB_TEXT, 'openai②: 只给 B 插桩');
}
{
  // ③ 全缺 → 全插(防修复把整个补丁机制删掉)
  const out = anthropicToOpenAIMessages([
    { role: 'assistant', content: [toolUse('call_A'), toolUse('call_B')] },
    { role: 'user', content: 'skill body 走 system context,没有 tool_result' },
  ], null);
  assert.equal(oaToolMsgsFor(out, 'call_A')[0]?.content, STUB_TEXT, 'openai③: A 插桩');
  assert.equal(oaToolMsgsFor(out, 'call_B')[0]?.content, STUB_TEXT, 'openai③: B 插桩');
}
{
  // ④ G2 原始场景(修前必红):结果在非紧邻位置
  const out = anthropicToOpenAIMessages([
    { role: 'user', content: '开始' },
    { role: 'assistant', content: [toolUse('call_A')] },
    { role: 'assistant', content: [toolUse('call_B')] },
    { role: 'user', content: [toolResult('call_A', 'A 的真实结果')] },
  ], null);
  const forA = oaToolMsgsFor(out, 'call_A');
  assert.equal(forA.length, 1, 'openai④: call_A 不得被误判缺失再插假桩(同一 id 只许一条)');
  assert.equal(forA[0].content, 'A 的真实结果', 'openai④: 配对的是真实结果不是假桩');
  assert.equal(oaToolMsgsFor(out, 'call_B')[0]?.content, STUB_TEXT, 'openai④: 真缺失的 B 仍补桩');
}

// ── anthropic 路(同矩阵,行为对齐哨兵)───────────────────────────────────
const runAnthropic = (messages) =>
  JSON.parse(normalizeMessagesForCompat(Buffer.from(JSON.stringify({ messages }))).toString('utf-8')).messages;
const anStubsFor = (msgs, id) => {
  const found = [];
  for (const m of msgs) {
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c?.type === 'tool_result' && c.tool_use_id === id) found.push(c);
    }
  }
  return found;
};

{
  // ① 并行 A/B、result [B,A] → 不插桩
  const msgs = runAnthropic([
    { role: 'user', content: '开始' },
    { role: 'assistant', content: [toolUse('call_A'), toolUse('call_B')] },
    { role: 'user', content: [toolResult('call_B', 'B 结果'), toolResult('call_A', 'A 结果')] },
  ]);
  const all = [...anStubsFor(msgs, 'call_A'), ...anStubsFor(msgs, 'call_B')];
  assert.ok(!all.some((c) => c.content === STUB_TEXT), 'anthropic①: 零假桩');
  assert.equal(anStubsFor(msgs, 'call_A').length, 1, 'anthropic①: A 只有真实结果');
}
{
  // ② A 有 B 无 → 只给 B 插桩
  const msgs = runAnthropic([
    { role: 'assistant', content: [toolUse('call_A'), toolUse('call_B')] },
    { role: 'user', content: [toolResult('call_A', 'A 结果')] },
  ]);
  assert.equal(anStubsFor(msgs, 'call_A')[0]?.content, 'A 结果', 'anthropic②: A 配对真实结果');
  assert.equal(anStubsFor(msgs, 'call_B')[0]?.content, STUB_TEXT, 'anthropic②: 只给 B 插桩');
}
{
  // ③ 全缺 → 全插
  const msgs = runAnthropic([
    { role: 'assistant', content: [toolUse('call_A'), toolUse('call_B')] },
    { role: 'user', content: '没有 tool_result' },
  ]);
  assert.equal(anStubsFor(msgs, 'call_A')[0]?.content, STUB_TEXT, 'anthropic③: A 插桩');
  assert.equal(anStubsFor(msgs, 'call_B')[0]?.content, STUB_TEXT, 'anthropic③: B 插桩');
}
{
  // ④ 结果在非紧邻位置 → 不插 A 桩(anthropic 侧既有 realResultIds 行为,换共用函数后不漂移)
  const msgs = runAnthropic([
    { role: 'user', content: '开始' },
    { role: 'assistant', content: [toolUse('call_A')] },
    { role: 'assistant', content: [toolUse('call_B')] },
    { role: 'user', content: [toolResult('call_A', 'A 的真实结果')] },
  ]);
  const forA = anStubsFor(msgs, 'call_A');
  assert.equal(forA.length, 1, 'anthropic④: call_A 只有一条,不插假桩');
  assert.equal(forA[0].content, 'A 的真实结果', 'anthropic④: 配对真实结果');
  assert.equal(anStubsFor(msgs, 'call_B')[0]?.content, STUB_TEXT, 'anthropic④: 真缺失的 B 仍补桩');
}

console.log('check-r26-g2-parallel-tool-calls: all passed');
