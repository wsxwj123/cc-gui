#!/usr/bin/env node
// 同步 outbox 连拨竞态护栏(sessionStore.js trackPending/clearPending)。
// 回归对象:clearPending 无值/序号校验时,先发的旧请求的 ok 会把新 pending 一并删掉 ——
// 1M 开→关连拨,"开"的 PUT 后回 ok 清了记账,"关"的 PUT 失败就没人重放,水合按服务端
// 旧值把 UI 打回"开"(outbox 本身要根治的写丢,在竞态窗口里复活)。
// 无框架,纯 assert;复刻 sessionStore.js:60-92 的记账逻辑(localStorage 用普通对象替身)。
import assert from 'node:assert/strict';

function makeOutbox() {
  let store = {};                 // 替身 localStorage 'cgui-sync-pending'
  const pendingSeq = new Map();
  const trackPending = (kind, sessionId, value) => {
    if (!sessionId) return null;
    const tag = `${kind}:${sessionId}`;
    const seq = (pendingSeq.get(tag) || 0) + 1;
    pendingSeq.set(tag, seq);
    store = { ...store, [tag]: value };
    return seq;
  };
  const clearPending = (kind, sessionId, seq) => {
    const tag = `${kind}:${sessionId}`;
    if (pendingSeq.get(tag) !== seq) return;   // 过期响应,不清
    if (tag in store) { const n = { ...store }; delete n[tag]; store = n; }
    // 刻意不删 pendingSeq 条目(计数器需单调)
  };
  return {
    trackPending, clearPending,
    seqOf: (tag) => pendingSeq.get(tag),
    pending: () => store,
    restore: (snapshot) => { store = { ...snapshot }; }, // 模拟重启后从 localStorage 恢复
  };
}
const TAG = 'context1m:s1';

// ── 场景 1(本次修复的 bug):连拨 开→关,旧"开"的 ok 迟到 ──────────
{
  const o = makeOutbox();
  const seqOn = o.trackPending('context1m', 's1', true);    // 拨"开",PUT#1 发出
  const seqOff = o.trackPending('context1m', 's1', false);  // 立刻拨"关",PUT#2 发出
  assert.notEqual(seqOn, seqOff, '两次记账 seq 必须不同');
  o.clearPending('context1m', 's1', seqOn);                 // PUT#1 ok 迟到
  assert.equal(o.pending()[TAG], false, '旧请求的 ok 不得清掉新 pending(值仍是"关")');
  // PUT#2 失败 → pending 保留 → 水合时可重放,UI 不会被服务端旧值打回
  assert.ok(TAG in o.pending(), '"关"的写丢仍有记账可重放');
}

// ── 场景 2:正常单拨,ok 必须能清干净 ────────────────────────────
{
  const o = makeOutbox();
  const seq = o.trackPending('context1m', 's1', true);
  o.clearPending('context1m', 's1', seq);
  assert.equal(TAG in o.pending(), false, '自己那次的 ok 照常清除记账');
}

// ── 场景 3:清除后再写入,迟到的旧响应仍不得误清(seq 不复位)────────
{
  const o = makeOutbox();
  const seq1 = o.trackPending('context1m', 's1', true);
  o.clearPending('context1m', 's1', seq1);                 // 第一次正常清掉
  const seq2 = o.trackPending('context1m', 's1', false);   // 新一次写入
  assert.notEqual(seq1, seq2, '清除后计数器不复位');
  o.clearPending('context1m', 's1', seq1);                 // 再有一条 seq1 的迟到响应
  assert.equal(o.pending()[TAG], false, '迟到旧响应不得清掉新记账');
  o.clearPending('context1m', 's1', seq2);
  assert.equal(TAG in o.pending(), false, '本次的 ok 照常清除');
}

// ── 场景 4:启动重放。localStorage 恢复的 pending 无 seq,重放 ok 照常清 ──
{
  const o = makeOutbox();
  o.restore({ [TAG]: true });
  const seqAtRequest = o.seqOf(TAG);                        // undefined
  o.clearPending('context1m', 's1', seqAtRequest);
  assert.equal(TAG in o.pending(), false, '重启后重放成功照常清除(不回归)');
}

// ── 场景 5:重放期间用户又改值 → 重放的 ok 不得清掉新值 ─────────────
{
  const o = makeOutbox();
  o.restore({ [TAG]: true });
  const seqAtRequest = o.seqOf(TAG);                        // undefined
  o.trackPending('context1m', 's1', false);                 // 重放在途,用户拨"关"
  o.clearPending('context1m', 's1', seqAtRequest);          // 重放的 ok 回来
  assert.equal(o.pending()[TAG], false, '重放的 ok 不得清掉重放期间产生的新记账');
}

console.log('✓ check-sync-outbox-seq: 5 个场景全过');
