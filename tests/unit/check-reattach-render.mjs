#!/usr/bin/env node
// reattach(流式中切走再切回)渲染口径护栏 —— 直接 import 真实实现(client/src/utils/reattach.js),
// 不复刻逻辑,改坏了这里必红。
// 锁住的行为:
//   ① reattach 一律不截断历史(旧的 { sinceTs: detachTs } 按 turn 粒度过滤,对在跑的回合
//      恒失效 → 内容既在历史卡又被重放进流式气泡 = 一条回复被劈成两个气泡);
//   ② 正常发送的截断口径不变({ sinceTs: 起流时刻 }),分屏/普通发送零行为变化;
//   ③ reattach 期间用 SSE 事件节流刷历史(1.5s),回合结束 force 立刻收尾;
//   ④ 非 reattach 永不触发这条刷新(不给正常流加任何额外请求)。
import assert from 'node:assert/strict';
import { REATTACH_REFRESH_MS, resolveStreamHistCutoff, shouldRefreshHist } from '../../client/src/utils/reattach.js';

// ── ① / ② 截断口径 ────────────────────────────────────────────
{
  const now = 1_700_000_000_000;
  assert.equal(resolveStreamHistCutoff(true, now), null, 'reattach:不截断,历史完整显示在跑的 turn');
  assert.deepEqual(resolveStreamHistCutoff(false, now), { sinceTs: now }, '正常发送:仍按起流时刻截断(行为不变)');
}

// ── ③ 节流:够 1.5s 才刷 ───────────────────────────────────────
{
  assert.equal(REATTACH_REFRESH_MS, 1500, '节流窗按 CLI 每条 assistant 记录 1-3s 落盘取 1.5s');
  const base = 10_000;
  const o = (dt, extra) => ({ isReattach: true, now: base + dt, lastAt: base, ...extra });
  assert.equal(shouldRefreshHist(o(0)), false, '刚刷过:不重复请求');
  assert.equal(shouldRefreshHist(o(1499)), false, '未到窗口:不刷');
  assert.equal(shouldRefreshHist(o(1500)), true, '边界即到:刷(>= 而非 >)');
  assert.equal(shouldRefreshHist(o(9000)), true, '超窗:刷');
  assert.equal(shouldRefreshHist(o(0, { force: true })), true, '回合结束 force:无视节流,立刻收尾刷');
  assert.equal(shouldRefreshHist(o(300, { intervalMs: 200 })), true, 'intervalMs 可覆写');
}

// ── ④ 非 reattach 一律不刷(含 force) ─────────────────────────
{
  const o = (extra) => ({ isReattach: false, now: 99_999, lastAt: 0, ...extra });
  assert.equal(shouldRefreshHist(o()), false, '正常发送:流式气泡实时画,不刷历史');
  assert.equal(shouldRefreshHist(o({ force: true })), false, 'force 也不能给正常发送开这条路径');
}

console.log('✅ check-reattach-render: reattach 截断口径 + 刷新节流 全部通过');
