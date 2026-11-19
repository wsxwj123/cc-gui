// H2 回归护栏:复用一个 idle slot 时,上一回合停止链路武装的 stopTimer 必须被 clear、
// turnEpoch 必须自增、lastResultAt 清空;即便 stopTimer 没赶上被 clear,其回调进门比对
// capturedEpoch 失败也必须 no-op(绝不 abort 已被复用成新回合的 slot)。
// 无框架,纯 assert。这里复刻 chat.js 复用重置块 + /stop 兜底回调的关键逻辑并断言其不变式。
import assert from 'node:assert';

// —— 复刻 chat.js 复用重置块对 slot 的操作(H2 相关行) ——
function reuseReset(s) {
  s.idle = false;
  if (s.stopTimer) { clearTimeout(s.stopTimer); s.stopTimer = null; }
  s.turnEpoch = (s.turnEpoch | 0) + 1;
  s.lastResultAt = null;
  if (s.liveTasks) for (const [tid, t] of s.liveTasks) { if (!t || t.kind !== 'shell') s.liveTasks.delete(tid); }
}

// —— 复刻 /stop 兜底 setTimeout 回调的世代门控(核心:epoch 变了就 no-op) ——
function makeStopCallback(slot) {
  const capturedEpoch = slot.turnEpoch | 0;
  return () => {
    if ((slot.turnEpoch | 0) !== capturedEpoch) return false; // no-op:回合已复用推进
    slot.stopTimer = null;
    slot.aborted = true; // 代表 slot.abort.abort()
    return true;
  };
}

// ---- 场景 1:复用重置正确清 stopTimer + lastResultAt,turnEpoch 自增 ----
{
  let cleared = false;
  const slot = {
    idle: true, closing: false, pumpEnded: false,
    stopTimer: setTimeout(() => {}, 9999),
    turnEpoch: 0, lastResultAt: 12345,
    liveTasks: new Map([
      ['t-sub', { kind: 'subagent' }],   // 陈旧子代理,应被清
      ['t-shell', { kind: 'shell' }],    // 后台 shell,应保留
    ]),
  };
  const origTimer = slot.stopTimer;
  // 用 monkeypatch 观测 clearTimeout 是否命中该句柄
  const realClear = global.clearTimeout;
  global.clearTimeout = (h) => { if (h === origTimer) cleared = true; return realClear(h); };
  reuseReset(slot);
  global.clearTimeout = realClear;

  assert.strictEqual(cleared, true, 'stopTimer 应被 clearTimeout');
  assert.strictEqual(slot.stopTimer, null, 'stopTimer 应置空');
  assert.strictEqual(slot.turnEpoch, 1, 'turnEpoch 应自增到 1');
  assert.strictEqual(slot.lastResultAt, null, 'lastResultAt 应清空');
  assert.strictEqual(slot.liveTasks.has('t-sub'), false, '陈旧非 shell 任务应被清');
  assert.strictEqual(slot.liveTasks.has('t-shell'), true, 'shell 后台任务应保留(不误伤保活)');
}

// ---- 场景 2:旧回合 stopTimer 回调在复用后触发 → 世代门控使其 no-op,不 abort 新回合 ----
{
  const slot = { turnEpoch: 3, stopTimer: 'x', aborted: false };
  const cb = makeStopCallback(slot); // 捕获 epoch=3
  // 用户停止后立刻 resend → 复用重置推进世代
  reuseReset(slot); // turnEpoch → 4
  const ran = cb();  // 旧兜底到点触发
  assert.strictEqual(ran, false, '世代变更后旧兜底回调必须 no-op');
  assert.strictEqual(slot.aborted, false, '绝不 abort 已被复用成新回合的 slot');
}

// ---- 场景 3:同一回合内(世代未变)兜底回调正常生效 ----
{
  const slot = { turnEpoch: 5, stopTimer: 'x', aborted: false };
  const cb = makeStopCallback(slot); // 捕获 epoch=5
  const ran = cb();                  // 未复用,世代不变
  assert.strictEqual(ran, true, '同一回合兜底应正常执行');
  assert.strictEqual(slot.aborted, true, '未被复用时应 abort');
  assert.strictEqual(slot.stopTimer, null, '执行后 stopTimer 置空');
}

// ---- 场景 4:冷启前 lingering 收尾循环(r199 起的规则) ----
// 复刻 chat.js settleSessionSlots 第一遍的结构:不再接消息(关闭中或输入已关)、带活 shell、没被中止的旧进程直接跳过
// (不白等、不 abort —— abort 杀整个 CLI = 连坐杀后台训练 shell,不可恢复);还能接消息的在忙进程照常等满上限:
// 带活 shell 的到点也不中止(交给建进程前的硬闸回 409,不另起第二个进程),不带的到点强制 abort 兜底;
// 已发起中止、带活 shell 的不放行,照旧等满再强制兜底。
const slotHasLiveShell = (s) => [...(s?.liveTasks?.values() ?? [])].some(t => t && t.kind === 'shell');
const sparedLiveShell = (s) => !s.usable && slotHasLiveShell(s) && !s.abortSignaled;
// 复刻循环:返回 {waited(轮次), aborted}。slot 一直没收尾(pumpEnded 永假);usable = 能接新消息,abortSignaled = 已发起中止。
function lingeringLoop(slot) {
  let waited = 0, aborted = false;
  const tearingDown = () => (sparedLiveShell(slot) ? null : slot); // 放行的旧进程 tearingDown 直接跳过
  let lingering;
  const MAX = 3;        // 代表 4s 上限(缩短为 3 轮,只验行为)
  while ((lingering = tearingDown()) && waited < MAX) waited++;
  if (lingering && slotHasLiveShell(lingering) && !lingering.abortSignaled) lingering = null; // 到点:活 shell 且未中止 → 不杀
  if (lingering) { aborted = true; } // 代表 lingering.abort.abort()
  return { waited, aborted };
}
{
  const shells = () => new Map([['t-shell', { kind: 'shell' }], ['t-sub', { kind: 'subagent' }]]);
  // 关闭中 + 活 shell + 没被中止:直接放行 → 不白等(waited===0)、不 abort
  const r1 = lingeringLoop({ usable: false, liveTasks: shells() });
  assert.strictEqual(r1.waited, 0, '关闭中、为活 shell 挂着的旧进程应直接放行,绝不白等');
  assert.strictEqual(r1.aborted, false, '为活 shell 挂着的旧进程绝不强制 abort(否则连坐杀后台训练)');

  // 能接消息 + 活 shell(这一轮在跑):等满上限,到点也不 abort
  const r2 = lingeringLoop({ usable: true, liveTasks: shells() });
  assert.strictEqual(r2.waited, 3, '能接消息、在忙、带活 shell:照常等满上限(4 秒内收尾就交给它)');
  assert.strictEqual(r2.aborted, false, '到点仍在忙也不 abort(交给硬闸回 409)');

  // 无 shell:等满上限后强制 abort 兜底(能接消息的在忙进程、关闭中的旧进程都一样)
  const r3 = lingeringLoop({ usable: true, liveTasks: new Map([['t-sub', { kind: 'subagent' }]]) });
  assert.strictEqual(r3.waited, 3, '无 shell 时行为不变:等满超时');
  assert.strictEqual(r3.aborted, true, '无 shell 时保留强制 abort 兜底(避免同 sid 双进程)');
  assert.strictEqual(lingeringLoop({ usable: false, liveTasks: new Map() }).aborted, true, '关闭中、无 shell:等满后强制兜底');

  // 已发起中止 + 活 shell:不放行,等满后照旧强制兜底(r151g 项5)
  const r5 = lingeringLoop({ usable: false, abortSignaled: true, liveTasks: shells() });
  assert.strictEqual(r5.waited, 3, '已发起中止的带 shell 槽照常等它退出');
  assert.strictEqual(r5.aborted, true, '到点仍在就强制兜底');

  // liveTasks 缺失:视作无 shell,正常等待+abort
  assert.strictEqual(lingeringLoop({ usable: true }).aborted, true, 'liveTasks 缺失时按无 shell 处理');
}

console.log('check-stop-reuse-reset: all assertions passed');
