#!/usr/bin/env node
// r142-附7 —— 层 4(helper 异常退出)的释放边界(0.2.412 delta 审查 第 1/3 条)。
//
// 两件事必须同时成立,缺一个都会在真机上留下"系统里按着一个键/一个鼠标键"或者"把别人的拖拽打断":
//   ① **异常退出也要收尾**(不只是超时):EDR/杀软终止 python.exe 时,helper 的 exit 事件照样会到,
//      而层 2 的 watcher 只在 mcp-server 自己死掉时才醒 ⇒ 这里不抬就没人抬(建议-1)。
//   ② **只抬"属主已经不在了"的那些键,而且只抬凭据里记着的键**:拖拽是唯一长时间持有的动作
//      (hold 文件里记 `MOUSE_LEFT`),同一时刻另一个 helper 可能正按着它;旧实现"读到任何 hold
//      文件就 release-hold 一次 + helper 侧无条件抬 ctrl/shift/alt/win/左右键",会把那个拖拽当场松开。
//
// 判据(全部只看**进程外部可观测**的事实:桩记录的 argv + 磁盘上的 hold 文件):
//   L4-01 属主已死的凭据 + 退出 helper 自己的凭据 ⇒ 都抬、都清;活属主(本测试进程)的凭据**不动**。
//   L4-02 没有任何"属主已死"的凭据时,helper 异常退出**一次 release-hold 都不该发**
//         (否则每个无关 helper 退出都会去扫一遍,还会抬手滑)。
//
// 口径说明(为什么这么写、语义没放宽):新增断言只覆盖"谁该被抬、谁不许被碰",不改既有用例;
// 真机 A8/A9(拖拽中强杀)的目视判据仍在 TEST-PLAN 里。
//
// 跑法:node tests/unit/check-cu-win-hold-layer4.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeReport } from './q8-helpers/report.mjs';
import { GRANTED, grantedWindow, makeWinHome, startWinMcp } from './r142-helpers/win-fixture.mjs';

const report = makeReport('check-cu-win-hold-layer4');
const TARGET = { bundleId: GRANTED.bundleId, pid: GRANTED.pid, windowId: GRANTED.windowId };
// pid 空间上限是 kern.maxproc(本机 16000)⇒ 这个值一定是"属主已死",且不会被回收复用
const DEAD_PID = 9_999_999;

/** 跑一次伪 win32 的 key 调用,scenario 里让 helper 异常退出(exitCode=1、无输出)。 */
async function runAbnormal(name, { withOrphan, helperHolds = true }) {
  const fake = makeWinHome(name);
  fake.setGrants({ apps: [GRANTED.bundleId] });
  fake.setScenario({
    windows: { reply: { ok: true, frontmost: null, windows: [grantedWindow()] } },
    // hold: 让桩像真 helper 那样"先落盘再按下",并把它自己的 pid 写进凭据(退出后就是孤儿凭据)
    key: { exitCode: 1, ...(helperHolds ? { hold: ['SHIFT'] } : {}) },
  });
  // 活属主:本测试进程(还活着)正按着 ALT —— 任何释放都不许碰它
  const liveFile = fake.writeHoldFile(process.pid, ['ALT']);
  const orphanFile = withOrphan ? fake.writeHoldFile(DEAD_PID, ['CTRL']) : null;
  const mcp = await startWinMcp(fake);
  fake.clearLogs();                                  // 只看这次调用之后发生的
  const r = await mcp.call('key', { actionId: `r142l4_${name}`, target: TARGET, keys: 'a' }, 40_000)
    .catch((e) => ({ error: String(e) }));
  const releases = fake.helperCalls('release-hold');
  const holdLeft = fake.holdFiles();
  mcp.kill();
  return { r, releases, holdLeft, liveFile, orphanFile, argv: releases.map((e) => e.args.join(' ')) };
}

// ── L4-01 异常退出 + 存在孤儿凭据:抬孤儿与自己的,不碰活属主(修前红)────────
{
  const run = await runAbnormal('t12-l4-orphan', { withOrphan: true });
  await report.check('L4-01', 'helper 异常退出(非超时):抬"属主已死"与自己的凭据,活属主的凭据不抬不删', 'red', () => {
    assert.equal(run.releases.length >= 1, true,
      `helper 异常退出后没有收尾(EDR 杀 python.exe 就是这条路径):${JSON.stringify(run.argv)}`);
    const line = run.argv.join(' | ');
    assert.ok(/CTRL/.test(line), `没抬孤儿凭据里的键:${line}`);
    assert.ok(/SHIFT/.test(line), `没抬退出 helper 自己凭据里的键(子进程刚退出时句柄可能还在回收,必须按"已知死亡"处理):${line}`);
    assert.ok(!/\bALT\b/.test(line), `抬了活属主(本测试进程)正按着的键 —— 会把别人的拖拽/按键松开:${line}`);
    assert.equal(fs.existsSync(run.orphanFile), false, '孤儿凭据没被清掉(下次启动还会读到)');
    assert.equal(fs.existsSync(run.liveFile), true, '删掉了活属主的凭据(层 2/层 3 之后就不知道要抬什么了)');
  });
}

// ── L4-02 异常退出 + 只有活属主凭据:一次 release-hold 都不许发(修前红)────
{
  const run = await runAbnormal('t12-l4-live-only', { withOrphan: false, helperHolds: false });
  await report.check('L4-02', '没有任何"属主已死"的凭据时,helper 异常退出**不发** release-hold(不许每退一个就扫一遍、还抬手滑)', 'red', () => {
    assert.deepEqual(run.argv, [],
      `本该什么都不做,却发了 release-hold:${JSON.stringify(run.argv)}(活属主的电梯队会被无谓地扫到)`);
    assert.equal(fs.existsSync(run.liveFile), true, '活属主的凭据被动过');
  });
}

process.exit(report.finish());
