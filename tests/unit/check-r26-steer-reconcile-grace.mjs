#!/usr/bin/env node
// r26-B3:reattach/转后台中途历史刷新把 accepted 未落盘条目误判 needs-review → 落盘宽限。
// 哨兵:①宽限期内 accepted 未命中 → 保留 accepted(误报哨兵,修前必红);
//       ②超过宽限仍缺席 → 翻 needs-review(过期翻案哨兵,宽限不是永久豁免);
//       ③无 acceptedAt 的旧数据(queuedAt 也老旧)→ 立即翻(向后兼容哨兵);
//       ④UUID 正向命中 → 宽限内外都正常出队;
//       ⑤unknown(从未被接纳)不适用宽限;
//       ⑥settleSteer('accepted') 写入 acceptedAt(store 侧锚)。
// Run: node tests/unit/check-r26-steer-reconcile-grace.mjs
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const { reconcileSteered, RECONCILE_GRACE_MS } = await import('../../client/src/utils/steerQueue.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');

const NOW = Date.now();
const landed = new Set(); // JSONL 还没来得及写的那一帧对账

assert.ok(Number.isFinite(RECONCILE_GRACE_MS) && RECONCILE_GRACE_MS >= 10000,
  'B3: 宽限常量导出且量级合理(p90 落盘延迟上方)');

// ① 宽限期内(acceptedAt 1s 前)
{
  const fresh = { queueId: 'q1', text: '刚并入', steerId: 'steer-fresh', steerState: 'accepted', queuedAt: NOW - 60_000, acceptedAt: NOW - 1000 };
  const out = reconcileSteered([fresh], null, landed);
  assert.equal(out[0]?.steerState, 'accepted', 'B3: 宽限期内的 accepted 不得翻 needs-review(reattach 中途刷新即触发)');
  assert.equal(out[0]?.missCount, 1, 'B3: 宽限内未命中记 missCount 供观测');
}
// ①b 宽限锚回落 queuedAt(无 acceptedAt 但刚入队)
{
  const fresh = { queueId: 'q1b', text: '刚并入', steerId: 'steer-fresh-b', steerState: 'accepted', queuedAt: NOW };
  const out = reconcileSteered([fresh], null, landed);
  assert.equal(out[0]?.steerState, 'accepted', 'B3: 无 acceptedAt 时锚回落 queuedAt(验收测试同口径)');
}
// ② 过期翻案(acceptedAt 25s 前 > 20s 宽限)
{
  const stale = { queueId: 'q2', text: '老条目', steerId: 'steer-stale', steerState: 'accepted', queuedAt: NOW - 60_000, acceptedAt: NOW - 25_000 };
  const out = reconcileSteered([stale], null, landed);
  assert.equal(out[0]?.steerState, 'needs-review', 'B3: 超过宽限仍缺席必须翻 needs-review');
  assert.equal(out[0]?.attemptWasAmbiguous, true);
}
// ③ 向后兼容:无 acceptedAt 且 queuedAt 老旧的旧数据 → 立即翻
{
  const legacy = { queueId: 'q3', text: '旧数据', steerId: 'steer-legacy', steerState: 'accepted', queuedAt: NOW - 10 * 60_000 };
  const out = reconcileSteered([legacy], null, landed);
  assert.equal(out[0]?.steerState, 'needs-review', 'B3: 旧数据(两锚都老)立即翻,不吃宽限');
}
// ④ UUID 命中:宽限内外都出队
{
  const hit = { queueId: 'q4', text: '已落盘', steerId: 'steer-hit', steerState: 'accepted', queuedAt: NOW, acceptedAt: NOW };
  const out = reconcileSteered([hit], null, new Set(['steer-hit']));
  assert.equal(out.length, 0, 'B3: UUID 正向命中正常出队');
}
// ⑤ unknown 不适用宽限(从未被接纳,没有「等落盘」的正当性)
{
  const unk = { queueId: 'q5', text: '未决', steerId: 'steer-unk', steerState: 'unknown', queuedAt: NOW };
  const out = reconcileSteered([unk], null, landed);
  assert.equal(out[0]?.steerState, 'needs-review', 'B3: unknown 照旧翻 needs-review');
}
// ⑥ store 侧:settleSteer('accepted') 写 acceptedAt
{
  useStore.setState({ messageQueue: {} });
  const st = useStore.getState();
  const item = st.enqueueMessage('sess-grace', { text: 'x', queuedAt: 1 });
  st.prepareSteer('sess-grace', item.queueId);
  useStore.getState().settleSteer('sess-grace', item.queueId, 'accepted');
  const cur = useStore.getState().messageQueue['sess-grace'][0];
  assert.equal(cur.steerState, 'accepted');
  assert.ok(Number.isFinite(cur.acceptedAt) && Math.abs(Date.now() - cur.acceptedAt) < 5000,
    'B3: settleSteer(accepted) 必须记 acceptedAt 宽限锚点');
}

console.log('PASS check-r26-steer-reconcile-grace');
