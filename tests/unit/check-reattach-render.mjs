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
import { readFileSync } from 'node:fs';
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

// ── ⑤ 源码守卫:finally 的复位必须被"无新回合"条件包住 ────────────
// turn-1 的 finalize 落盘轮询含 await(~2.4s),期间 auto-reattach 可能已起 turn-2 并置好
// 自己的标记;无条件复位会把 turn-2 的截断/reattach 标记倒打回去 → 双气泡在该窗口复现。
// 判据用现成的 activeProcRef(finally 开头置 null,新回合起流时置 pid),与 newRoundStarted 同源。
{
  const src = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  assert.match(
    src,
    /if \(activeProcRef\.current == null\) \{\s*setStreamHistCutoff\(null\);\s*setReattachStream\(false\);\s*\}/,
    'finally 里的 setStreamHistCutoff(null) + setReattachStream(false) 必须包在 activeProcRef.current == null 内,否则会覆盖已开始的下一回合的标记',
  );
  assert.equal((src.match(/setReattachStream\(false\)/g) || []).length, 1,
    'reattachStream 只应有 finally 那一处复位:多一处裸复位就绕开了新回合守卫');
  assert.equal((src.match(/setReattachStream\(/g) || []).length, 2,
    'setReattachStream 全仓只应有 2 个调用点(起流置位 + finally 复位)');
  assert.match(src, /if \(histRefreshInFlight\) return;/,
    'reattach 历史刷新必须有 in-flight 去重,慢盘时别把 /messages 请求叠罗汉');
}

console.log('✅ check-reattach-render: reattach 截断口径 + 刷新节流 + finally 复位守卫 全部通过');
