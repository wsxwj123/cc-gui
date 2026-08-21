#!/usr/bin/env node
// r26-G2【复现+错误路径】:openai-proxy 并行 tool_calls 误插假桩。
// 场景(anthropic-proxy 已在 realResultIds 上踩过并修复,openai-proxy 没移植):
//   assistant(tool_use A) → assistant(tool_use B) → user(tool_result A)
// A 的真实 tool_result 存在,只是不在「紧邻的连续 tool 段」里 —— openai-proxy 只扫紧邻段,
// 把 A 判成缺失,补一条 content='(tool result fed via system context)' 的假桩 →
// 同一个 tool_call_id 出现两条 tool 消息,严格端点(Kimi/DeepSeek)报
// "tool call id is not found" 或语义错乱。
// 修复后期望:补丁前全局扫描所有真实存在的 tool_result id,存在的一律不插假桩;
// 真缺失的(如 B)仍要补(否则 DeepSeek 400「tool_calls 后必须跟 tool 消息」)。
// Run: node tests/acceptance/r26/g2-parallel-tool-calls-stub.mjs
import assert from 'node:assert/strict';

const { anthropicToOpenAIMessages } = await import('../../../server/services/openai-proxy.js');

const STUB_TEXT = '(tool result fed via system context)';
const messages = [
  { role: 'user', content: '开始' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_A', name: 'Skill', input: { skill: 'x' } }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_B', name: 'Skill', input: { skill: 'y' } }] },
  // A 的真实结果在两轮 assistant 之后才出现(并行 tool_calls 的真实形态)
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_A', content: 'A 的真实结果' }] },
];

const out = anthropicToOpenAIMessages(messages, null);

// ① 核心(修前必红):call_A 有真实结果,不许再插假桩 —— 同一 id 只许出现一次
const forA = out.filter((m) => m.role === 'tool' && m.tool_call_id === 'call_A');
assert.equal(forA.length, 1,
  `G2: call_A 的真实 tool_result 存在却被误判缺失,多插了假桩(同一 id 出现 ${forA.length} 条 tool 消息)`);
assert.equal(forA[0].content, 'A 的真实结果',
  'G2: call_A 配对的必须是真实结果,不是假桩文本');
assert.ok(!out.some((m) => m.role === 'tool' && m.tool_call_id === 'call_A' && m.content === STUB_TEXT),
  'G2: 假桩文本不得挂在已有真实结果的 id 上');

// ② 反向钉:call_B 真缺失 → 假桩仍必须补(防修复把整个补丁机制删掉)
const forB = out.filter((m) => m.role === 'tool' && m.tool_call_id === 'call_B');
assert.equal(forB.length, 1, 'G2: 真缺失的 call_B 仍要补一条桩(否则严格端点 400)');
assert.equal(forB[0].content, STUB_TEXT, 'G2: 桩文本保持不变');

console.log('PASS r26-g2-parallel-tool-calls-stub');
