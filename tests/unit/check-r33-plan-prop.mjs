#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_HIDDEN_PLAN_IDENTITIES, pruneHiddenPlanIdentities, visiblePlanItems } from '../../client/src/utils/plan.js';

// 真实复数输入行为：不同计划全部保留，空项剔除，批准态不丢；旧 singular 仍兼容。
const plans = [
  { signature: 'A', plan: '# A', approved: false },
  { signature: 'B', plan: '# B', approved: true },
  { signature: 'empty', plan: '  ', approved: true },
];
assert.deepEqual(visiblePlanItems(plans, '# legacy'), plans.slice(0, 2), '复数 plans 必须优先且保留多卡/批准态');
assert.deepEqual(visiblePlanItems(null, '  # Legacy\r\n'), [
  { signature: '# Legacy', plan: '# Legacy', approved: true },
], '旧 singular plan 保持兼容');
assert.deepEqual(visiblePlanItems([], '# stale'), [], '显式空复数列表不得回退成旧幽灵卡');

// 隐藏计划的 localStorage 键必须有上界。每隐藏一份就留一个键、value 是【计划全文】,
// 无上界时长会话会把 5MB 配额吃掉;而入队现在"写不进就硬拒"→ 配额一满连消息都发不出去。
{
  const map = new Map();
  const storage = {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  const owner = 'sess-A';
  for (let i = 0; i < 50; i += 1) {
    const key = `cgui-plan-hidden:${owner}:h${i}`;
    storage.setItem(key, `# 计划 ${i}`);
    pruneHiddenPlanIdentities(storage, owner, key);
    assert.ok(map.size <= MAX_HIDDEN_PLAN_IDENTITIES,
      `隐藏第 ${i + 1} 份计划后不得超过 ${MAX_HIDDEN_PLAN_IDENTITIES} 条(实得 ${map.size})`);
  }
  assert.equal(map.size, MAX_HIDDEN_PLAN_IDENTITIES, '稳定在上界,不是"清空重来"');
  assert.ok(map.has(`cgui-plan-hidden:${owner}:h49`), '刚隐藏的那份必须留下(淘汰最旧,不淘汰当前)');
  assert.ok(!map.has(`cgui-plan-hidden:${owner}:h0`), '最旧的已被淘汰');

  // 别的会话 / 别的键前缀不受牵连(prune 按 owner 前缀圈定范围)。
  map.clear();
  storage.setItem('cgui-goal-hidden:sess-A', '["condition:x"]');
  storage.setItem('cgui-plan-hidden:sess-B:keep', '# 另一个会话的计划');
  for (let i = 0; i < 40; i += 1) storage.setItem(`cgui-plan-hidden:sess-A:k${i}`, `# ${i}`);
  pruneHiddenPlanIdentities(storage, 'sess-A', 'cgui-plan-hidden:sess-A:k39');
  assert.equal(map.get('cgui-goal-hidden:sess-A'), '["condition:x"]', 'goal 的隐藏键不被误删');
  assert.equal(map.get('cgui-plan-hidden:sess-B:keep'), '# 另一个会话的计划', '别的会话的计划隐藏键不被误删');
  assert.equal([...map.keys()].filter((k) => k.startsWith('cgui-plan-hidden:sess-A:')).length,
    MAX_HIDDEN_PLAN_IDENTITIES, '只在本 owner 的前缀内淘汰');
}

// JSX 暂无 Node loader；这里只钉住跨组件 prop 名，核心列表行为由上面的真函数覆盖。
const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
assert.match(app, /<ChatInput[\s\S]*?plans=\{currentPlans\}/, 'App 将 currentPlans 交给 ChatInput');
assert.match(chat, /export function ChatInput\(\{[^}]*\bplans = null\b/, 'ChatInput 必须接收 plans prop');
assert.match(chat, /<TodoPanel[^>]*\bplans=\{plans\}/, 'ChatInput 必须把 plans 继续交给 TodoPanel');
// 隐藏动作必须触发淘汰,否则上界函数写了也白写。
const todoPanel = readFileSync(new URL('../../client/src/components/TodoPanel.jsx', import.meta.url), 'utf8');
const hidePlanFn = todoPanel.slice(todoPanel.indexOf('const hidePlan = ()'));
assert.match(hidePlanFn.slice(0, hidePlanFn.indexOf('};')), /pruneHiddenPlanIdentities\(localStorage,/,
  'hidePlan 写入隐藏键后必须调 pruneHiddenPlanIdentities');
// GUI 文案禁 emoji(项目规范)。
assert.doesNotMatch(todoPanel, /[✀-➿\u{1f300}-\u{1faff}✅⭐⚡]/u,
  'TodoPanel 文案不得含 emoji');

console.log('✓ check-r33-plan-prop: App → ChatInput → TodoPanel 复数计划贯通，多卡/旧 singular 兼容 + 隐藏键有上界');
