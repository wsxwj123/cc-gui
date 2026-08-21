#!/usr/bin/env node
// r26-B3【复现+边界】:reattach/转后台中途历史刷新,把「已 accepted 但还没落盘」的并入
// 误判成 needs-review。
// 场景:steer 已被 server 接纳(accepted),JSONL 落盘有延迟;此时 reattach/后台恢复触发
// 一次历史刷新,reconcile 用落盘 UUID 对账 —— 未命中即翻 needs-review,用户看到一条
// 「其实已经成功并入」的消息被标成待人工复核(且 needs-review 是 barrier,卡死后续队列)。
// 修复后期望:accepted 且仍在落盘宽限期内的条目给 grace —— 本轮对账未命中不翻
// needs-review(下一次刷新仍缺席才翻);超过宽限期的老条目照旧翻(防永久豁免)。
// Run: node tests/acceptance/r26/b3-reconcile-grace.mjs
import assert from 'node:assert/strict';
import { stubLocalStorage, stubWindowNoop } from './lib.mjs';

stubWindowNoop();
stubLocalStorage();

const { reconcileSteered } = await import('../../../client/src/utils/steerQueue.js');

const NOW = Date.now();
// 落盘 UUID 集为空:模拟「JSONL 还没来得及写」的那一帧对账。
const landed = new Set();

// ① 宽限期内的 accepted:本轮不许翻 needs-review(修复前会被翻 → 本断言修前必红)
{
  const fresh = { queueId: 'q1', text: '刚并入', steerId: 'steer-fresh', steerState: 'accepted', queuedAt: NOW };
  const out = reconcileSteered([fresh], null, landed);
  assert.equal(out[0]?.steerState, 'accepted',
    'B3: accepted 且仍在落盘宽限期内的条目被误判成 needs-review(reattach 中途刷新即触发)');
}

// ② 超过宽限期的 accepted:下一次刷新仍缺席 → 必须翻 needs-review(宽限不是永久豁免)
{
  const stale = { queueId: 'q2', text: '老条目', steerId: 'steer-stale', steerState: 'accepted', queuedAt: NOW - 10 * 60 * 1000 };
  const out = reconcileSteered([stale], null, landed);
  assert.equal(out[0]?.steerState, 'needs-review',
    'B3: 超过落盘宽限期仍未见 UUID 的 accepted 必须翻 needs-review');
}

// ③ UUID 正向命中:不论新旧都直接清掉(既有正确行为,防回归)
{
  const hit = { queueId: 'q3', text: '已落盘', steerId: 'steer-hit', steerState: 'accepted', queuedAt: NOW };
  const out = reconcileSteered([hit], null, new Set(['steer-hit']));
  assert.equal(out.length, 0, 'B3: UUID 正向命中的条目必须被清掉');
}

// ④ unknown(从未被 server 接纳)不适用宽限:照旧翻 needs-review
{
  const unk = { queueId: 'q4', text: '未决', steerId: 'steer-unk', steerState: 'unknown', queuedAt: NOW };
  const out = reconcileSteered([unk], null, landed);
  assert.equal(out[0]?.steerState, 'needs-review',
    'B3: unknown 不在宽限范围(它从未被接纳,没有「等落盘」的正当性)');
}

console.log('PASS r26-b3-reconcile-grace');
