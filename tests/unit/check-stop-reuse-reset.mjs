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

// ---- 场景 4:冷启等待循环遇到"为后台 shell 保活"的 lingering slot → 不 abort ----
// 复刻 chat.js 冷启前 lingering 收尾块的 H1 判据:超时未收尾时,有活 shell 就放弃强制
// abort(abort 杀整个 CLI = 连坐杀后台训练 shell,不可恢复),容忍双 resume。
function lingeringAbortDecision(lingering) {
  const hasLiveShell = [...(lingering.liveTasks?.values() ?? [])].some(t => t && t.kind === 'shell');
  let aborted = false;
  if (!hasLiveShell) { aborted = true; } // 代表 lingering.abort.abort()
  return { hasLiveShell, aborted };
}
{
  // 有活 shell 的 lingering:必须不 abort
  const withShell = { liveTasks: new Map([['t-shell', { kind: 'shell' }], ['t-sub', { kind: 'subagent' }]]) };
  const r1 = lingeringAbortDecision(withShell);
  assert.strictEqual(r1.hasLiveShell, true, '应识别到活 shell');
  assert.strictEqual(r1.aborted, false, '有活 shell 时绝不强制 abort(否则连坐杀后台训练)');

  // 无 shell 的 lingering(纯停止中/被弃用进程):走原有强制 abort 兜底
  const noShell = { liveTasks: new Map([['t-sub', { kind: 'subagent' }]]) };
  const r2 = lingeringAbortDecision(noShell);
  assert.strictEqual(r2.hasLiveShell, false, '无 shell');
  assert.strictEqual(r2.aborted, true, '无 shell 时保留强制 abort 兜底(避免同 sid 双进程)');

  // liveTasks 为空/未定义:视作无 shell,正常 abort
  const empty = {};
  assert.strictEqual(lingeringAbortDecision(empty).aborted, true, 'liveTasks 缺失时按无 shell 处理');
}

console.log('check-stop-reuse-reset: all assertions passed');
