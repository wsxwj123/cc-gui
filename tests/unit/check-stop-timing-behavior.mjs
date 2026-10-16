#!/usr/bin/env node
// 停止链路核心时序的【行为级】护栏:直接 import chat.js 的真 applyStop(POST /chat/:pid/stop 的
// 实际停止动作),喂假 slot、换假时钟,断言它到底做了什么。
// 为什么要它:check-r114-locks.mjs 的 E1-8 是源码文本锁,只比对原文。计时器段之前插一行早退、
// 提前改写 lastResultAt、起别名再调用,计时器原文一字不差,abort 兜底照样被架空 —— 只有跑起来才看得出。
//   ① interrupt 发出即走:interrupt 永不 resolve,applyStop 照样同步返回、计时器照样挂上、到点照样兜底;
//   ② 优雅窗:无在飞任务 2000ms、有任务 3000ms;到点没收尾就 abort + input.close,差 1ms 不动;
//   ③ 收尾判据:pumpEnded,或【stop 之后】到过 result;hard 还要活任务清零、选择性要本回合可停任务
//      清零,才不 abort;stop 之前的 result 不算收尾;
//   ④ 到点前 turnEpoch 变了(槽位已被下一回合复用)→ 不 abort,不误杀新回合;
//   ⑤ 选择性路径有活 shell / 新鲜的跨回合后台子代理 → abort 被抑制(总闸 allTasks 除外;
//      终态通知丢失的陈旧残留不算活任务,不抑制);
//   ⑥ hard 路径先对全部活任务发 stopTask,再 interrupt;
//   ⑦ idle 槽位的几条早退:没活任务才直接关流,有本回合任务照常 interrupt + 兜底,
//      只剩 shell / 跨回合任务时保活不动;
//   ⑧ 有没有 sessionId(草稿槽位)都走同一套时序。
// 变异验证(2026-10-16,逐个改 chat.js 跑本文件、跑完还原):选择性路径 interrupt 前插
// `if (hadTasks) return { ok: true };`;hard 路径 interrupt 前插 `slot.lastResultAt = Number.MAX_SAFE_INTEGER;`;
// 删 hard / 选择性任一处 interrupt;任一处窗长 2000 改 2500;任一处 abort 挪到计时器外立即执行;
// 清待决卡片那段里插早退;没有 sessionId 时早退;陈旧跨回合条目也计入抑制 —— 都红。
//
// Run: node tests/unit/check-stop-timing-behavior.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// chat.js 及其依赖可能在导入期读家目录:先换成临时空目录再导入(同 check-r12-agent-stop),
// 本测试不碰真实 ~/.claude。
const home = mkdtempSync(join(tmpdir(), 'cgui-stop-timing-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { applyStop } = await import('../../server/routes/chat.js');
assert.equal(typeof applyStop, 'function', 'chat.js 必须导出 applyStop(本测试直接调真函数,不复刻)');

// ── 假时钟 ──────────────────────────────────────────────────────────────
// applyStop 用全局 setTimeout 挂兜底、用 Date.now() 取 stopAt。每条用例开始时整个换掉、结束还原:
// 时间只在 advance() 里走,途中到点的计时器按先后执行。
const T0 = 1_760_000_000_000;
const clock = { now: T0, timers: [] };
const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now, warn: console.warn };
function installFakes() {
  clock.now = T0;
  clock.timers = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    const timer = { fn, args, ms, due: clock.now + ms, fired: false, cleared: false };
    clock.timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { if (timer && typeof timer === 'object') timer.cleared = true; };
  Date.now = () => clock.now;
  console.warn = () => {}; // 选择性路径抑制 abort 时打一行告警,测试输出里不要它
}
function restoreFakes() {
  globalThis.setTimeout = real.setTimeout;
  globalThis.clearTimeout = real.clearTimeout;
  Date.now = real.now;
  console.warn = real.warn;
}
// 推进 ms 毫秒:途中到点的计时器按到点先后执行,执行时 Date.now() 恰为它的到点时刻。
function advance(ms) {
  const end = clock.now + ms;
  for (;;) {
    const next = clock.timers
      .filter((t) => !t.fired && !t.cleared && t.due <= end)
      .sort((a, b) => a.due - b.due)[0];
    if (!next) break;
    clock.now = next.due;
    next.fired = true;
    next.fn(...next.args);
  }
  clock.now = end;
}

// ── 假 slot ─────────────────────────────────────────────────────────────
// 字段名照 chat.js 里的真 slot。log 按发生顺序记每个动作和当时距 stop 的毫秒数,
// 例:['stopTask:t_cur@0', 'interrupt@0', 'abort@3000', 'close@3000']。
// sessionId 默认带上:applyStop 会拿它调真 dropPendingForSession(本进程没有待决卡片 = 空操作),
// 那段分支因此在每条用例的执行路径上 —— 有人在里面插早退,用例照样会红。
const EPOCH = 2; // 本回合世代
const task = (kind, epoch, toolUseId) => ({ kind, epoch, toolUseId, createdAt: T0 - 60_000 }); // 一分钟前起的,新鲜
const CUR = () => task('subagent', EPOCH, 'toolu_cur');       // 本回合派出的子代理
const PREV = () => task('subagent', EPOCH - 1, 'toolu_prev'); // 上一回合派出、仍在后台跑的子代理
const SHELL = () => task('shell', EPOCH, 'toolu_sh');         // Bash run_in_background

function makeSlot({ idle = false, tasks = {}, sessionId = 'sess-stop-timing', interrupt = () => Promise.resolve() } = {}) {
  const log = [];
  const note = (what) => log.push(`${what}@${clock.now - T0}`);
  const slot = {
    sessionId,
    turnEpoch: EPOCH,
    idle,
    pumpEnded: false,
    lastResultAt: null, // 真 slot 初值没有这个字段(undefined)、回合复用时置 null;对 `lastResultAt && …` 判据两者等价
    closing: false,
    stopTimer: null,
    liveTasks: new Map(Object.entries(tasks)),
    query: {
      interrupt: () => { note('interrupt'); return interrupt(); },
      stopTask: (tid) => { note(`stopTask:${tid}`); return Promise.resolve(); },
    },
    abort: { abort: () => note('abort') },
    input: { close: () => note('close') },
  };
  return { slot, log };
}
const killedAt = (ms) => [`abort@${ms}`, `close@${ms}`];

let total = 0;
let failed = 0;
function check(name, fn) {
  total++;
  installFakes();
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ')}`); }
  finally { restoreFakes(); }
}
const PATHS = [['hard', { hard: true }], ['选择性', {}]];

console.log('\n① interrupt 发出即走');
for (const [path, flags] of PATHS) {
  check(`${path}:interrupt 永不 resolve,applyStop 照样同步返回、兜底计时器照样挂上,2000ms 照样强停`, () => {
    const { slot, log } = makeSlot({ interrupt: () => new Promise(() => {}) });
    const res = applyStop(slot, 'p1', flags);
    assert.deepEqual(res, { ok: true }, '必须同步返回响应体,不能等 interrupt 回话');
    assert.deepEqual(log, ['interrupt@0']);
    assert.ok(clock.timers.includes(slot.stopTimer),
      'interrupt 还没回,兜底计时器就得已经挂上,句柄挂在 slot.stopTimer 上(回合复用时靠它 clear)');
    assert.equal(slot.stopTimer.ms, 2000, '无在飞任务的兜底窗长是 2000ms');
    advance(2000);
    assert.deepEqual(log, ['interrupt@0', ...killedAt(2000)], 'interrupt 一直没回,到点照样 abort + input.close');
  });
}

console.log('\n② 优雅窗:无任务 2000ms / 有任务 3000ms,差 1ms 不动');
for (const [path, flags] of PATHS) {
  check(`${path}:无在飞任务 → 1999ms 不动,2000ms abort + input.close`, () => {
    const { slot, log } = makeSlot();
    applyStop(slot, 'p2', flags);
    advance(1999);
    assert.deepEqual(log, ['interrupt@0'], '差 1ms 不得 abort / close');
    advance(1);
    assert.deepEqual(log, ['interrupt@0', ...killedAt(2000)]);
  });
  check(`${path}:本回合子代理一直没停下 → 2999ms 不动,3000ms abort + input.close`, () => {
    const { slot, log } = makeSlot({ tasks: { t_cur: CUR() } });
    applyStop(slot, 'p2', flags);
    advance(2999);
    assert.deepEqual(log, ['stopTask:t_cur@0', 'interrupt@0'], '差 1ms 不得 abort / close');
    advance(1);
    assert.deepEqual(log, ['stopTask:t_cur@0', 'interrupt@0', ...killedAt(3000)]);
  });
}

console.log('\n③ 收尾判据:pumpEnded 或 stop 之后到过 result,且该停的任务已清零 → 不 abort');
const SETTLE = [
  ['消息泵收尾(pumpEnded)', (slot) => { slot.pumpEnded = true; }],
  ['收到 stop 之后的 result', (slot) => { slot.lastResultAt = Date.now(); }],
];
for (const [path, flags] of PATHS) {
  for (const [how, settle] of SETTLE) {
    check(`${path}:窗内${how},本回合子代理也已收到 stopped 通知 → 到点不 abort`, () => {
      const { slot, log } = makeSlot({ tasks: { t_cur: CUR() } });
      applyStop(slot, 'p3', flags);
      advance(1000);
      settle(slot);
      slot.liveTasks.delete('t_cur');
      advance(5000);
      assert.deepEqual(log, ['stopTask:t_cur@0', 'interrupt@0'], '已优雅收尾,不得 abort / close');
    });
    check(`${path}:窗内${how},但本回合子代理还活着 → 3000ms 照样 abort`, () => {
      const { slot, log } = makeSlot({ tasks: { t_cur: CUR() } });
      applyStop(slot, 'p3', flags);
      advance(1000);
      settle(slot);
      advance(2000);
      assert.deepEqual(log, ['stopTask:t_cur@0', 'interrupt@0', ...killedAt(3000)], '没停净就得兜底');
    });
  }
  check(`${path}:stop 之前到过的 result(子代理回合的中间 result)不算收尾 → 2000ms 照样 abort`, () => {
    const { slot, log } = makeSlot();
    slot.lastResultAt = T0 - 1;
    applyStop(slot, 'p3', flags);
    advance(2000);
    assert.deepEqual(log, ['interrupt@0', ...killedAt(2000)]);
  });
  check(`${path}:result 与 stop 落在同一毫秒也算 stop 之后 → 不 abort`, () => {
    const { slot, log } = makeSlot();
    applyStop(slot, 'p3', flags);
    slot.lastResultAt = Date.now(); // 假时钟还没走 = stopAt
    advance(5000);
    assert.deepEqual(log, ['interrupt@0']);
  });
}

console.log('\n④ 到点前 turnEpoch 变了(槽位已被下一回合复用)→ 不 abort');
for (const [path, flags] of PATHS) {
  check(`${path}:兜底属于上一回合,到点不 abort、不 close`, () => {
    const { slot, log } = makeSlot();
    applyStop(slot, 'p4', flags);
    advance(500);
    slot.turnEpoch += 1; // 复用路径推进世代;旧计时器故意不 clear,模拟 clear 没赶上
    advance(5000);
    assert.deepEqual(log, ['interrupt@0'], '上一回合的兜底杀了新回合');
  });
}

console.log('\n⑤ 选择性路径:有活 shell / 跨回合后台子代理 → abort 被抑制');
check('有活 shell:只对本回合子代理发 stopTask;它没停净,到点也不 abort(abort 会连坐杀掉 shell)', () => {
  const { slot, log } = makeSlot({ tasks: { t_cur: CUR(), t_sh: SHELL() } });
  const res = applyStop(slot, 'p5', {});
  assert.deepEqual(res, { ok: true, kept: 1, keptToolUseIds: [] });
  assert.equal(slot.closing, false, '留着 shell 就不能置 closing(回合收尾会顺手关掉进程)');
  advance(10_000);
  assert.deepEqual(log, ['stopTask:t_cur@0', 'interrupt@0'], 'shell 不发 stopTask;到点不得 abort / close');
});
check('有新鲜的跨回合后台子代理:不对它发 stopTask,本回合子代理没停净到点也不 abort', () => {
  const { slot, log } = makeSlot({ tasks: { t_cur: CUR(), t_prev: PREV() } });
  const res = applyStop(slot, 'p5', {});
  assert.deepEqual(res, { ok: true, kept: 1, keptToolUseIds: ['toolu_prev'] });
  assert.equal(slot.closing, false, '留着跨回合子代理就不能置 closing');
  advance(10_000);
  assert.deepEqual(log, ['stopTask:t_cur@0', 'interrupt@0'], '跨回合子代理不发 stopTask;到点不得 abort / close');
});
check('对照:总闸 allTasks 下跨回合子代理照停,没停净到点照样 abort', () => {
  const { slot, log } = makeSlot({ tasks: { t_cur: CUR(), t_prev: PREV() } });
  const res = applyStop(slot, 'p5', { allTasks: true });
  assert.deepEqual(res, { ok: true });
  advance(3000);
  assert.deepEqual(log, ['stopTask:t_cur@0', 'stopTask:t_prev@0', 'interrupt@0', ...killedAt(3000)]);
});
check('对照:陈旧的跨回合条目(31 分钟前起、终态通知丢了的残留)不算活任务,照发 stopTask,到点照样 abort', () => {
  const { slot, log } = makeSlot({ tasks: { t_old: { ...PREV(), createdAt: T0 - 31 * 60_000 } } });
  const res = applyStop(slot, 'p5', {});
  assert.deepEqual(res, { ok: true });
  advance(3000);
  assert.deepEqual(log, ['stopTask:t_old@0', 'interrupt@0', ...killedAt(3000)], '陈旧残留不得让 abort 兜底永久失效');
});

console.log('\n⑥ hard 路径:先对全部活任务发 stopTask,再 interrupt');
check('本回合子代理 + 跨回合子代理 + shell 都先 stopTask,interrupt 在它们之后;没停净 3000ms 照样 abort', () => {
  const { slot, log } = makeSlot({ tasks: { t_cur: CUR(), t_prev: PREV(), t_sh: SHELL() } });
  const res = applyStop(slot, 'p6', { hard: true });
  assert.deepEqual(res, { ok: true });
  assert.equal(slot.closing, true, 'hard 是全杀,必须置 closing(不转 idle)');
  const at = log.indexOf('interrupt@0');
  assert.ok(at >= 0, '没发 interrupt');
  assert.deepEqual(log.slice(0, at).sort(), ['stopTask:t_cur@0', 'stopTask:t_prev@0', 'stopTask:t_sh@0'],
    'interrupt 之前必须已对全部活任务发过 stopTask(共用 stdin,先发 interrupt 会截断 stopTask)');
  assert.equal(log.length, at + 1, 'interrupt 之后、到点之前不得有别的动作');
  advance(3000);
  assert.deepEqual(log.slice(at + 1), killedAt(3000), 'hard 不因 shell / 跨回合任务抑制兜底');
});

console.log('\n⑦ idle 槽位的早退:只有该走的才走');
for (const [path, flags] of PATHS) {
  check(`${path}:idle 且没有活任务 → 直接关流,不 interrupt、不挂计时器`, () => {
    const { slot, log } = makeSlot({ idle: true });
    const res = applyStop(slot, 'p7', flags);
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(log, ['close@0']);
    assert.equal(clock.timers.length, 0);
    assert.equal(slot.closing, true);
  });
  check(`${path}:idle 但本回合子代理还在跑 → 不走直接关流,照常 interrupt + 3000ms 兜底`, () => {
    const { slot, log } = makeSlot({ idle: true, tasks: { t_cur: CUR() } });
    applyStop(slot, 'p7', flags);
    advance(2999);
    assert.deepEqual(log, ['stopTask:t_cur@0', 'interrupt@0'], '差 1ms 不得 abort / close');
    advance(1);
    assert.deepEqual(log, ['stopTask:t_cur@0', 'interrupt@0', ...killedAt(3000)]);
  });
}
check('选择性:idle 只剩 shell / 跨回合子代理 → 什么都不停,保活', () => {
  const { slot, log } = makeSlot({ idle: true, tasks: { t_sh: SHELL(), t_prev: PREV() } });
  const res = applyStop(slot, 'p7', {});
  assert.deepEqual(res, { ok: true, kept: 2, keptToolUseIds: ['toolu_prev'] });
  advance(10_000);
  assert.deepEqual(log, []);
  assert.equal(clock.timers.length, 0);
  assert.equal(slot.closing, false);
});
check('选择性:idle 混合(本回合子代理 + shell)→ 只对子代理发 stopTask,不 interrupt、不兜底、不 closing', () => {
  const { slot, log } = makeSlot({ idle: true, tasks: { t_cur: CUR(), t_sh: SHELL() } });
  const res = applyStop(slot, 'p7', {});
  assert.deepEqual(res, { ok: true, kept: 1, keptToolUseIds: [] });
  advance(10_000);
  assert.deepEqual(log, ['stopTask:t_cur@0']);
  assert.equal(clock.timers.length, 0);
  assert.equal(slot.closing, false);
});

console.log('\n⑧ 有没有 sessionId 都走同一套时序');
for (const [path, flags] of PATHS) {
  check(`${path}:草稿槽位(还没拿到 sessionId)→ 照常 interrupt,2000ms 兜底`, () => {
    const { slot, log } = makeSlot({ sessionId: null });
    applyStop(slot, 'p8', flags);
    advance(1999);
    assert.deepEqual(log, ['interrupt@0'], '差 1ms 不得 abort / close');
    advance(1);
    assert.deepEqual(log, ['interrupt@0', ...killedAt(2000)]);
  });
}

try { rmSync(home, { recursive: true, force: true }); } catch {}
console.log(failed ? `\nFAIL check-stop-timing-behavior(${failed}/${total} 条红)` : `\nPASS check-stop-timing-behavior(${total} 条全绿)`);
process.exit(failed ? 1 : 0);
