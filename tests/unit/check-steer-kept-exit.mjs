#!/usr/bin/env node
// 判官必修-1(①):needs-review 死路补出口。
//   · "保留不发"从假按钮变真:置 'kept'(resolved,非 barrier,不自动发送,不拦队列);
//   · needs-review / kept 可删除(ChatInput 带确认弹窗;store 侧放行 needs-review);
//   · kept 可编辑(非 barrier,走既有 onEditFromQueue 出队+回填)。
// 变异哨兵(每条都实际红过一次):
//   · 删掉 steerQueue.firstNonKeptIndex 的跳过逻辑 → "kept 队首不拦后项"两条断言红;
//   · 把 'kept' 加回 BARRIER_STATES(或删 settleSteer 'kept' 分支) → barrier 矩阵/store 段红;
//   · 还原 removeFromQueue 的 isSteerBarrier 整类拒删 → "needs-review 可删"断言红;
//   · 删 ChatInput 保留不发 onClick → 源码守卫红。
// Run: node tests/unit/check-steer-kept-exit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const {
  firstDrainableIndex,
  firstSteerableIndex,
  isSteerBarrier,
  reconcileSteered,
  stripSteerState,
} = await import('../../client/src/utils/steerQueue.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');

// ── barrier 判定矩阵:kept 是 resolved,不是 barrier ──
assert.equal(isSteerBarrier({ steerState: 'kept' }), false, 'kept 不是 barrier');
for (const state of ['unknown', 'accepted', 'needs-review', 'claiming']) {
  assert.equal(isSteerBarrier({ steerState: state }), true, `${state} 仍是 barrier`);
}
assert.equal(isSteerBarrier({ attemptWasAmbiguous: true }), true, 'attemptWasAmbiguous 单独也是 barrier');
assert.equal(isSteerBarrier({ steerState: 'kept', attemptWasAmbiguous: true }), true,
  'kept 若残留 attemptWasAmbiguous 仍算 barrier —— 所以 settleSteer(kept) 必须清它(下面 store 段验证)');

// ── drain / steer:kept 不自动发送、不拦后项 ──
const kept = { queueId: 'k-1', text: '保留的', steerId: 'steer-k', steerState: 'kept', queuedAt: 1 };
const queued = { queueId: 'q-1', text: '后项', queuedAt: 2 };
const review = { queueId: 'r-1', text: '待复核', steerId: 'steer-r', steerState: 'needs-review', attemptWasAmbiguous: true };
assert.equal(firstDrainableIndex([kept, queued]), 1, 'kept 队首不拦后项:drain 落到下一条');
assert.equal(firstDrainableIndex([kept]), -1, 'kept 自身永不被 drain');
assert.equal(firstDrainableIndex([kept, review, queued]), -1, 'kept 之后的 needs-review 仍是 barrier');
assert.equal(firstDrainableIndex([queued, kept]), 0, '正常队首不受影响');
assert.equal(firstSteerableIndex([kept, queued]), 1, 'kept 队首不拦 ⚡ 并入下一条');
assert.equal(firstSteerableIndex([kept, { ...queued, hidden: true }]), -1, 'hidden 头仍不可 steer');
assert.equal(firstSteerableIndex([kept]), -1, 'kept 自身不可 ⚡ 并入');

// ── 对账/恢复:kept 是用户决定,不得翻回 needs-review;UUID 正向命中则清掉 ──
const reconciled = reconcileSteered([kept, queued], null, new Set());
assert.equal(reconciled[0].steerState, 'kept', '未命中时 kept 保持 kept(不复活 barrier)');
assert.deepEqual(reconcileSteered([kept, queued], null, new Set(['steer-k'])), [queued],
  'kept 的 UUID 落盘命中 = 其实已送达,条目清掉');
const restored = stripSteerState({ a: [kept, review] });
assert.equal(restored.a[0].steerState, 'kept', '跨重启 kept 保持 kept');
assert.equal(restored.a[1].steerState, 'needs-review', '其余 unresolved 仍转 needs-review');

// ── store:settleSteer('kept') 语义 + removeFromQueue 出口 ──
useStore.setState({ messageQueue: {} });
const st = useStore.getState();
const item = st.enqueueMessage('session-kept', { text: '原文', queuedAt: 10 });
st.prepareSteer('session-kept', item.queueId);
useStore.getState().settleSteer('session-kept', item.queueId, 'ambiguous');
let cur = useStore.getState().messageQueue['session-kept'][0];
assert.equal(cur.steerState, 'needs-review');
assert.equal(cur.attemptWasAmbiguous, true);
useStore.getState().settleSteer('session-kept', item.queueId, 'kept');
cur = useStore.getState().messageQueue['session-kept'][0];
assert.equal(cur.steerState, 'kept', '保留不发 → kept');
assert.equal(cur.attemptWasAmbiguous, false, 'kept 必须清 attemptWasAmbiguous,否则仍是 barrier');
assert.equal(firstDrainableIndex(useStore.getState().messageQueue['session-kept']), -1, 'kept 不被自动发送');

// kept 可删除(非 barrier,store 本就放行)
useStore.getState().removeFromQueue('session-kept', 0);
assert.equal((useStore.getState().messageQueue['session-kept'] || []).length, 0, 'kept 可删除');

// needs-review 可删除;unknown / accepted / claiming 仍拒删
const mkQueue = (state) => {
  useStore.setState({ messageQueue: { s: [{ queueId: 'x', text: 't', steerId: 'steer-x', steerState: state }] } });
  useStore.getState().removeFromQueue('s', 0);
  return (useStore.getState().messageQueue.s || []).length;
};
assert.equal(mkQueue('needs-review'), 0, 'needs-review 必须可删(死路的逃生口)');
assert.equal(mkQueue('unknown'), 1, 'unknown(在途确认)仍拒删');
assert.equal(mkQueue('accepted'), 1, 'accepted(已注入)仍拒删');
assert.equal(mkQueue('claiming'), 1, 'claiming(取回中)仍拒删');

// shiftMessage(真实 drain 调用点)跳过 kept 且不弄丢它
useStore.setState({ messageQueue: { s2: [{ queueId: 'k2', text: '保留', steerState: 'kept' }, { queueId: 'q2', text: '要发的', queuedAt: 1 }] } });
const popped = useStore.getState().shiftMessage('s2');
assert.equal(popped.queueId, 'q2', 'drain 弹出的是 kept 之后的可发条目');
assert.deepEqual(useStore.getState().messageQueue.s2.map((x) => x.queueId), ['k2'], 'kept 原位保留');

// ── 源码守卫(JSX 进不了 node,钉关键判据)──
const input = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
assert.match(input, /onClick=\{\(\) => useStore\.getState\(\)\.settleSteer\(permKey, q\.queueId, 'kept'\)\}/,
  '"保留不发"必须有真 onClick(判官抓到的假按钮不许回归)');
assert.match(input, /已保留，不会自动发送/, 'kept chip 必须有"已保留"标注');
assert.match(input, /onRemoveFromQueue && \(!isSteerBarrier\(q\) \|\| q\.steerState === 'needs-review'\)/,
  '删除按钮必须对 needs-review 开放');
assert.match(input, /删除后不可恢复。若这条消息其实已被模型接收，删除不影响已进行的回合。确认删除？/,
  'needs-review/kept 删除必须带说明性确认文案');

console.log('PASS check-steer-kept-exit');
