// r196 T3:排队条目的后台排空状态('bg-sending')、状态库新动作、按 queueId 编辑 / 删除。
//   S1 steerQueue 对 'bg-sending':是 barrier(窗格排空、⚡、↑ 召回都不碰,也不越过它)、并入为灰的原因码、对账原样保留;
//      刷新恢复三分支:已收下且不是初始化超时 → 移除;初始化超时 / 没有回音 → 复核(interrupted)。
//   S2 状态库:RUN_ID;入队 / 放回写 runId;markBgSending / settleBgSend / removeFromQueueById 的每个分支(含落盘失败);
//      待删集合。
//   S3 源码守卫:窗格的编辑 / 删除按 queueId 走 removeFromQueueById,删不掉就不往输入框里填;输入框三处传 q.queueId。
// node tests/unit/check-r196-queue-state.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
let failQueueWrites = false;
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => {
    if (failQueueWrites && key === 'cgui-message-queue') throw new Error('QuotaExceededError');
    storage.set(key, String(value));
  },
  removeItem: (key) => { storage.delete(key); },
  key: (i) => [...storage.keys()][i] ?? null,
  get length() { return storage.size; },
};

const {
  isSteerBarrier, firstDrainableIndex, firstSteerableIndex, steerBlockReason, reconcileSteered, stripSteerState,
} = await import('../../client/src/utils/steerQueue.js');
const { useStore, RUN_ID } = await import('../../client/src/stores/sessionStore.js');

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

// ── S1 steerQueue ────────────────────────────────────────────────────────────────────
{
  const bg = { queueId: 'q-bg', text: 'bg', steerState: 'bg-sending', bgTurnId: 't1', bgStartedAt: 1 };
  const plain = { queueId: 'q-plain', text: 'plain' };
  ok(isSteerBarrier(bg), 'S1:bg-sending 是 barrier');
  eq(firstDrainableIndex([bg, plain]), -1, 'S1:队首在自动发出时窗格排空不弹任何一条(不越过它)');
  eq(firstSteerableIndex([bg, plain]), -1, 'S1:⚡ 并入不可用');
  eq(steerBlockReason([bg, plain]), 'bg-sending', 'S1:并入为灰的原因码 bg-sending');
  eq(steerBlockReason([plain]), null, 'S1:普通队首照旧可并入');
  const kept = { queueId: 'q-kept', text: 'k', steerState: 'kept' };
  eq(steerBlockReason([kept, bg]), 'bg-sending', 'S1:跳过「保留不发」后看到的队首是在途条目');
  for (const turnActive of [true, false, undefined]) {
    const list = [bg, plain];
    eq(reconcileSteered(list, null, new Set(), { turnActive }), list, `S1:对账原样保留在途条目(turnActive=${turnActive})`);
  }
  const mixed = [{ queueId: 'q-u', text: 'u', steerState: 'unknown', steerId: 's-u' }, bg];
  const rec = reconcileSteered(mixed, null, new Set(), { turnActive: false });
  eq(rec[1], bg, 'S1:同一次对账里 ⚡ 条目照旧翻复核,在途条目不动');
  eq(rec[0].steerState, 'needs-review', 'S1:⚡ 未定条目照旧翻 needs-review');

  const NOW = 1700000000000;
  const accepted = { queueId: 'a', text: 'a', steerState: 'bg-sending', bgTurnId: 't', bgStartedAt: 1, bgAcceptedPid: '42' };
  const timedOut = { queueId: 'b', text: 'b', steerState: 'bg-sending', bgTurnId: 't', bgStartedAt: 1, bgAcceptedPid: '43', bgStartTimedOut: true };
  const noReply = { queueId: 'c', text: 'c', steerState: 'bg-sending', bgTurnId: 't', bgStartedAt: 1, opts: { x: 1 } };
  const review = { queueId: 'd', text: 'd', steerState: 'needs-review', attemptWasAmbiguous: true, holdReason: { code: 'http', detail: 'x', at: 5 } };
  const out = stripSteerState({ K: [accepted, timedOut, noReply, plain, review] }, NOW);
  eq(out.K.map((it) => it.queueId), ['b', 'c', 'q-plain', 'd'], 'S1 刷新恢复:已收下且不是初始化超时的那条移除,其余留着、顺序不变');
  eq(out.K[0], { queueId: 'b', text: 'b', steerState: 'needs-review', attemptWasAmbiguous: true, holdReason: { code: 'interrupted', at: NOW } },
    'S1 刷新恢复:初始化超时还没等到终态 → 复核(interrupted),去掉 bg 字段');
  eq(out.K[1], { queueId: 'c', text: 'c', opts: { x: 1 }, steerState: 'needs-review', attemptWasAmbiguous: true, holdReason: { code: 'interrupted', at: NOW } },
    'S1 刷新恢复:没有回音 → 复核(interrupted),其余字段原样');
  eq(out.K[2], plain, 'S1 刷新恢复:普通条目原样(同一对象)');
  eq(out.K[3], review, 'S1 刷新恢复:已是复核的条目保留原因');
}

// ── S2 状态库 ─────────────────────────────────────────────────────────────────────────
const st = () => useStore.getState();
const q = (key) => st().messageQueue[key] || [];
const persisted = (key) => JSON.parse(storage.get('cgui-message-queue') || '{}')[key] || [];
ok(typeof RUN_ID === 'string' && RUN_ID.length > 0, 'S2:RUN_ID 是非空字符串');
{
  const K = 'r196-s2-a';
  const a = st().enqueueMessage(K, { text: 'a', queuedAt: 1, runId: 'old-run' });
  eq(a.runId, RUN_ID, 'S2:入队写本次运行号(覆盖传入的旧值)');
  const b = st().requeueMessageFront(K, { text: 'b', queuedAt: 2, runId: 'old-run', busyRetryAt: 0 });
  eq(b.runId, RUN_ID, 'S2:放回写本次运行号(覆盖)');
  eq(q(K).map((it) => it.text), ['b', 'a'], 'S2 前置:放回在最前');
  // markBgSending:只标可排空的队首
  eq(st().markBgSending(K, a.queueId, { bgTurnId: 'bt1', bgStartedAt: 10 }), null, 'S2:不是队首 → 不标');
  const marked = st().markBgSending(K, b.queueId, { bgTurnId: 'bt1', bgStartedAt: 10 });
  eq([marked?.steerState, marked?.bgTurnId, marked?.bgStartedAt], ['bg-sending', 'bt1', 10], 'S2:队首标成 bg-sending');
  eq(persisted(K)[0].steerState, 'bg-sending', 'S2:已落盘');
  eq(st().markBgSending(K, b.queueId, { bgTurnId: 'bt2', bgStartedAt: 11 }), null, 'S2:已在途的不重复标');
  // 在途期间:窗格排空、按下标删、按 queueId 删(用户动作)、⚡ 都碰不到它
  eq(st().shiftMessage(K), null, 'S2:窗格排空弹不出任何一条');
  st().removeFromQueue(K, 0);
  eq(q(K).length, 2, 'S2:按下标删拒删在途条目');
  eq(st().removeFromQueueById(K, b.queueId), false, 'S2:按 queueId 删(用户动作)拒删在途条目');
  eq(st().prepareSteer(K, b.queueId), null, 'S2:⚡ 不取在途条目');
  // settleBgSend 各分支
  eq(st().settleBgSend(K, 'no-such', { kind: 'release' }), false, 'S2:找不到条目 → 什么也不做');
  eq(st().settleBgSend(K, a.queueId, { kind: 'release' }), false, 'S2:不是在途条目 → 什么也不做');
  eq(st().settleBgSend(K, b.queueId, { kind: 'accepted', pid: '' }), false, 'S2:没有 pid 的「收下」不写');
  eq(st().settleBgSend(K, b.queueId, { kind: 'bogus' }), false, 'S2:不认识的结果不写');
  eq(st().settleBgSend(K, b.queueId, { kind: 'accepted', pid: 77 }), true, 'S2:收下 → 写回');
  eq([q(K)[0].steerState, q(K)[0].bgAcceptedPid, q(K)[0].bgStartTimedOut], ['bg-sending', '77', undefined], 'S2:记 bgAcceptedPid(字符串),仍在途');
  eq(st().settleBgSend(K, b.queueId, { kind: 'accepted', pid: '78', startTimedOut: true }), true, 'S2:初始化超时 → 写回');
  eq([q(K)[0].bgAcceptedPid, q(K)[0].bgStartTimedOut, persisted(K)[0].bgStartTimedOut], ['78', true, true], 'S2:记 bgStartTimedOut 并落盘');
  eq(st().settleBgSend(K, b.queueId, { kind: 'release' }), true, 'S2:退回普通态');
  const released = q(K)[0];
  ok(!('steerState' in released) && !('bgTurnId' in released) && !('bgAcceptedPid' in released) && !('bgStartTimedOut' in released) && !('bgStartedAt' in released),
    'S2:退回后去掉 steerState 与全部 bg 字段');
  eq(firstDrainableIndex(q(K)), 0, 'S2:退回后窗格排空又能取它');
  // 再标一次 → 转复核
  ok(st().markBgSending(K, b.queueId, { bgTurnId: 'bt3', bgStartedAt: 12 }), 'S2:再次标在途');
  eq(st().settleBgSend(K, b.queueId, { kind: 'review' }), false, 'S2:复核必须带原因码');
  const before = Date.now();
  eq(st().settleBgSend(K, b.queueId, { kind: 'review', code: 'http', detail: '工作目录不存在' }), true, 'S2:转复核');
  const rv = q(K)[0];
  eq([rv.steerState, rv.attemptWasAmbiguous, rv.holdReason.code, rv.holdReason.detail, 'bgTurnId' in rv], ['needs-review', true, 'http', '工作目录不存在', false],
    'S2:needs-review + holdReason,去掉 bg 字段');
  ok(rv.holdReason.at >= before, 'S2:holdReason.at 是写入时刻');
  eq(st().removeFromQueueById(K, b.queueId), true, 'S2:复核条目用户可删');
  eq(q(K).map((it) => it.queueId), [a.queueId], 'S2:删的是那一条');
}
{
  // 后台排空移除自己在途的那条(expectBgSending);别的状态一律不删
  const K = 'r196-s2-b';
  const a = st().enqueueMessage(K, { text: 'a', queuedAt: 1 });
  eq(st().removeFromQueueById(K, a.queueId, { expectBgSending: true }), false, 'S2:expectBgSending 不删普通条目');
  st().markBgSending(K, a.queueId, { bgTurnId: 'x', bgStartedAt: 1 });
  eq(st().removeFromQueueById(K, a.queueId, { expectBgSending: true }), true, 'S2:expectBgSending 删在途条目');
  eq([q(K), persisted(K)], [[], []], 'S2:删掉并落盘');
  eq(st().removeFromQueueById(K, a.queueId, { expectBgSending: true }), false, 'S2:已删的再删 → false(什么也不做)');
}
{
  // 隐藏项、不是本次运行排的:markBgSending 不标;claimDraft 不删;空 queueId 不删
  const K = 'r196-s2-c';
  const h = st().enqueueMessage(K, { text: 'h', queuedAt: 1, hidden: true });
  eq(st().markBgSending(K, h.queueId, {}), null, 'S2:隐藏项不标');
  st().removeFromQueueById(K, h.queueId);
  useStore.setState((s) => ({ messageQueue: { ...s.messageQueue, [K]: [{ queueId: 'old', text: 'o', runId: 'other-run' }] } }));
  eq(st().markBgSending(K, 'old', {}), null, '不是本次运行排的不标');
  useStore.setState((s) => ({ messageQueue: { ...s.messageQueue, [K]: [{ queueId: 'cd', text: 'c', claimDraft: { queueText: 'c' } }, { queueId: 'p', text: 'p' }] } }));
  eq(st().removeFromQueueById(K, 'cd'), false, 'S2:取回中的不删');
  eq([st().removeFromQueueById(K, ''), st().removeFromQueueById(K, undefined)], [false, false], 'S2:空 queueId 不删');
  eq(st().removeFromQueueById(K, 'p'), true, 'S2:普通条目按 queueId 删');
}
{
  // 落盘失败:三个动作都不改内存态、返回失败
  const K = 'r196-s2-d';
  const a = st().enqueueMessage(K, { text: 'a', queuedAt: 1 });
  const b = st().enqueueMessage(K, { text: 'b', queuedAt: 2 });
  const snapshot = q(K);
  failQueueWrites = true;
  try {
    eq(st().markBgSending(K, a.queueId, { bgTurnId: 'x', bgStartedAt: 1 }), null, 'S2 落盘失败:markBgSending 返回 null');
    eq(q(K), snapshot, 'S2 落盘失败:内存态不变');
    eq(st().removeFromQueueById(K, b.queueId), false, 'S2 落盘失败:removeFromQueueById 返回 false');
    eq(q(K), snapshot, 'S2 落盘失败:没删');
  } finally { failQueueWrites = false; }
  ok(st().markBgSending(K, a.queueId, { bgTurnId: 'x', bgStartedAt: 1 }), 'S2 前置:恢复写入后标上');
  failQueueWrites = true;
  try {
    eq(st().settleBgSend(K, a.queueId, { kind: 'release' }), false, 'S2 落盘失败:settleBgSend 返回 false');
    eq(q(K)[0].steerState, 'bg-sending', 'S2 落盘失败:仍在途');
  } finally { failQueueWrites = false; }
}
{
  // 待删集合
  const s0 = st().pendingDeleteSessions;
  ok(s0 instanceof Set && s0.size === 0, 'S2:待删集合初始为空');
  st().markSessionDeleting('sid-1');
  st().markSessionDeleting(['sid-2', 'sid-3', '', null]);
  eq([...st().pendingDeleteSessions].sort(), ['sid-1', 'sid-2', 'sid-3'], 'S2:单个与数组都能标,空值忽略');
  const s1 = st().pendingDeleteSessions;
  st().markSessionDeleting('sid-1');
  ok(st().pendingDeleteSessions === s1, 'S2:重复标不换引用');
  st().unmarkSessionDeleting(['sid-1', 'sid-3']);
  eq([...st().pendingDeleteSessions], ['sid-2'], 'S2:撤标');
  const s2 = st().pendingDeleteSessions;
  st().unmarkSessionDeleting('nope');
  ok(st().pendingDeleteSessions === s2, 'S2:撤一个不在集合里的不换引用');
  ok(s1 !== s0 && s1.has('sid-1') && !s0.has('sid-1'), 'S2:变更时换新集合(不改旧引用)');
}

// ── S3 源码守卫 ────────────────────────────────────────────────────────────────────────
{
  const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('const removeFromQueueAt = useCallback(');
  ok(start > 0, 'S3:找到 removeFromQueueAt');
  const seg = app.slice(start, app.indexOf("window.dispatchEvent(new CustomEvent('cgui:composer-fill', { detail }));", start));
  ok(/useStore\.getState\(\)\.removeFromQueueById\(sessionQueueKey, queueId\);\s*\}, \[sessionQueueKey\]\);/.test(seg), 'S3:删除按 queueId');
  ok(seg.includes("const item = (useStore.getState().messageQueue[sessionQueueKey] || []).find((q) => q?.queueId === queueId);"), 'S3:编辑按 queueId 找条目');
  const removeAt = seg.indexOf('if (!useStore.getState().removeFromQueueById(sessionQueueKey, queueId)) return;');
  ok(removeAt > 0 && removeAt < seg.indexOf('homeDraftFromOrphan(item)'), 'S3:先删、删不掉就返回,之后才还原并回填输入框');
  ok(!/removeFromQueue\(sessionQueueKey, i\)/.test(app), 'S3:窗格不再按下标删');
  const input = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
  ok(input.includes('onEditFromQueue(queueItems[lastIdx].queueId);'), 'S3:↑ 召回传 queueId');
  ok(input.includes('onClick={() => onEditFromQueue(q.queueId)}'), 'S3:编辑按钮传 queueId');
  ok(input.includes('onRemoveFromQueue(q.queueId);'), 'S3:删除按钮传 queueId');
  ok(!/onEditFromQueue\(i\)|onRemoveFromQueue\(i\)|onEditFromQueue\(lastIdx\)/.test(input), 'S3:不再传下标');
}

console.log(`✓ check-r196-queue-state:${checks} 项断言全部通过`);
