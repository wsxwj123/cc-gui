#!/usr/bin/env node
// 输入框上方的常驻计划卡【只收已批准的计划】。
// 回归形状:currentPlans 曾收全部 ExitPlanMode 调用,未决与被驳回的都画成「计划待审查」——
// 一轮计划协商改 4~5 版就是 4~5 张永久叠在输入框上的卡(r32 修掉的"计划卡洪水"换个形状回来);
// 且未决那份与 PlanReviewCard 审批弹窗同时显示同一段文本 = 一份内容出两遍。
// 语义:未决 → 审批弹窗负责;驳回 → 不留卡;已批准 → 常驻卡(可展开收起,本轮验收项)。
// Run: node tests/unit/check-r33-plan-approved-only.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedPlanItems } from '../../client/src/utils/plan.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const plan = (id, text, result) => ({ id, name: 'ExitPlanMode', input: { plan: text }, ...(result ? { result } : {}) });
const APPROVED = { isError: false, content: 'ok' };
// CLI 驳回时把"用户拒绝"写成 is_error 的 tool_result;批准走 is_error + 「用户已批准此计划」。
const REJECTED = { isError: true, content: 'The user doesn\'t want to proceed with this tool use.' };
const APPROVED_VIA_ERROR = { isError: true, content: '用户已批准此计划，可以开始执行' };

// ── ① 一轮协商 5 版:只有最后被批准的那版留卡 ──────────────────────────────
{
  const items = approvedPlanItems([
    plan('t1', '# 方案 v1', REJECTED),
    plan('t2', '# 方案 v2', REJECTED),
    plan('t3', '# 方案 v3', REJECTED),
    plan('t4', '# 方案 v4', REJECTED),
    plan('t5', '# 方案 v5', APPROVED),
  ]);
  assert.deepEqual(items.map((i) => i.plan), ['# 方案 v5'],
    `4 版被驳回 + 1 版批准 → 只留 1 张已批准卡(实得 ${items.length} 张)`);
  assert.equal(items[0].approved, true, '常驻卡恒为已批准态');
}

// ── ② 未决计划(还没结果 = 审批弹窗正开着)不出常驻卡 ────────────────────────
{
  assert.deepEqual(approvedPlanItems([plan('p1', '# 待审查的方案')]), [],
    '未决计划归 PlanReviewCard,常驻区不重复画同一份内容');
  // 中断 / 合成结果都不算批准。
  assert.deepEqual(approvedPlanItems([plan('p2', '# 被打断', { isError: false, interrupted: true })]), []);
  assert.deepEqual(approvedPlanItems([plan('p3', '# 合成结果', { isError: false, synthetic: true })]), []);
}

// ── ③ 批准后仍是一张:同一份计划的 persisted/local/streaming 三副本先折叠再过滤 ──
{
  const text = '# 唯一方案\n- 步骤一';
  const items = approvedPlanItems([
    plan('s1', text),                       // 历史里还是未决态
    plan('s1', text, APPROVED_VIA_ERROR),   // 本地完成的同一次调用带上批准结果
    plan('s1', `${text}\n`, APPROVED),      // 流式副本(尾部换行归一后同签名)
  ]);
  assert.equal(items.length, 1, '同签名三副本折叠成一张,不因"先未决后批准"漏掉或翻倍');
  assert.equal(items[0].plan, text, '计划全文归一(\\r\\n / 首尾空白)后保留');
}

// ── ④ 不同的已批准计划各自保留(不是"只留最后一张"的粗暴单例) ────────────────
{
  const items = approvedPlanItems([
    plan('a', '# 计划 A', APPROVED),
    plan('b', '# 计划 B', APPROVED),
    { id: 'x', name: 'Bash', input: { command: 'ls' }, result: APPROVED },
  ]);
  assert.deepEqual(items.map((i) => i.plan), ['# 计划 A', '# 计划 B'], '多份已批准计划按首次出现顺序各留一张');
}

// ── ⑤ 源码守卫:App 的 currentPlans 走这个纯函数,不得在组件里另写一套过滤 ──────
{
  const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  const memo = app.slice(app.indexOf('const currentPlans = useMemo('));
  assert.match(memo.slice(0, memo.indexOf('}, [')), /return approvedPlanItems\(toolCalls\);/,
    'currentPlans 必须直接返回 approvedPlanItems(toolCalls)');
  assert.doesNotMatch(memo.slice(0, memo.indexOf('}, [')), /approved:\s*isApprovedPlanToolCall/,
    '不得回到"未批准也进常驻卡、只把 approved 当状态位"的老形状');
}

console.log('✓ check-r33-plan-approved-only: 常驻计划卡只收已批准计划;未决归弹窗、驳回不留卡');
