#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { visiblePlanItems } from '../../client/src/utils/plan.js';

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

// JSX 暂无 Node loader；这里只钉住跨组件 prop 名，核心列表行为由上面的真函数覆盖。
const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
assert.match(app, /<ChatInput[\s\S]*?plans=\{currentPlans\}/, 'App 将 currentPlans 交给 ChatInput');
assert.match(chat, /export function ChatInput\(\{[^}]*\bplans = null\b/, 'ChatInput 必须接收 plans prop');
assert.match(chat, /<TodoPanel[^>]*\bplans=\{plans\}/, 'ChatInput 必须把 plans 继续交给 TodoPanel');

console.log('✓ check-r33-plan-prop: App → ChatInput → TodoPanel 复数计划贯通，多卡与旧 singular 兼容全过');
