#!/usr/bin/env node
// R46 复现:「并入被误判为失败」—— 在途(accepted,UUID 还没进 jsonl)的并入被确认环节判死。
//
// 缺陷:确认只等固定 RECONCILE_GRACE_MS(20s),而并入的落盘时点由 CLI 的下一个
// tool_result 边界决定(诊断报告在隔离实例实测 3.3 / 6.0 / 9.6 / 11.5 / **148** 秒)——
// 「我点了多久」和「什么时候写盘」毫无关系。只要落盘晚于 20s,两条用户命中的路径
// 都会把「还没落盘」当成「结果未知」:
//   A 页面/webview 重载 —— stripSteerState 在模块加载时无条件翻 needs-review(一秒不等);
//   B 切走再切回 / 转后台 —— reattach 每 1.5s 拉一次历史触发对账,20s 一到就翻。
// needs-review 是队列 barrier(firstDrainableIndex/firstSteerableIndex 都跳不过它),
// 所以用户体感不是"一条消息没并入",而是"整个队列哑了"。
//
// 两类哨兵:
//   [修前应红] 在途条目在 A/B 两条路径下都不得被判失败(修前必红 = 真的咬住了缺陷);
//   [修前应绿] **红线:兜底不能删** —— 回合真结束(turnActive=false)且 UUID 仍缺席 →
//              必须翻 needs-review;UUID 正向命中 → 任何情形都出队;
//              不传 turnActive 的旧调用点 → 原 20s 宽限口径不变。
// Run: node tests/unit/check-r46-steer-turn-alive.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const {
  reconcileSteered, stripSteerState, steerStillInFlight, RECONCILE_GRACE_MS,
} = await import('../../client/src/utils/steerQueue.js');
const { useStore } = await import('../../client/src/stores/sessionStore.js');

let PASS = 0; let FAILS = 0; const failed = [];
const check = (name, fn) => {
  try {
    fn();
    PASS++; console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++; failed.push(name);
    console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
};

const NOW = Date.now();
const NO_KEYS = new Set();
// 「在途」样本:已被 server 接纳、jsonl 里还没有它,且早已超出 20s 宽限。
const inflight = (over = {}) => ({
  queueId: 'b1', text: '并入中', steerId: 'steer-b1', steerState: 'accepted',
  queuedAt: NOW - 300_000, acceptedAt: NOW - 300_000, ...over,
});

console.log('— A 路径:页面重载后的状态复位(stripSteerState 是重载唯一复位入口) —');

check('[修前应红] A 重载:accepted(在途)不得被翻成 needs-review', () => {
  const out = stripSteerState({ 'sess-a': [inflight({ queueId: 'a1', steerId: 'steer-a1', acceptedAt: NOW - 2000, queuedAt: NOW - 2000 })] });
  assert.equal(out['sess-a'][0].steerState, 'accepted',
    '重载把在途并入判死 = 用户命中的入口 1(落盘在工具边界,重载几乎必然落在窗口内)');
  assert.equal(out['sess-a'][0].steerId, 'steer-a1', 'steerId 必须保留,否则后续 UUID 对账再也认不出它');
  assert.ok(Number.isFinite(out['sess-a'][0].acceptedAt), 'acceptedAt 必须保留(宽限锚点)');
});

check('[修前应绿] A 重载:unknown 残留照旧复位(不因放宽而漏)', () => {
  const out = stripSteerState({ 'sess-a2': [{ queueId: 'a2', text: 'x', steerId: 'steer-a2', steerState: 'unknown', queuedAt: NOW }] });
  assert.equal(out['sess-a2'][0].steerState, 'needs-review');
  assert.equal(out['sess-a2'][0].attemptWasAmbiguous, true);
});

check('[修前应绿] A 重载:kept(用户已决定保留不发)不复活', () => {
  const out = stripSteerState({ 'sess-a3': [{ queueId: 'a3', text: 'x', steerId: 'steer-a3', steerState: 'kept', attemptWasAmbiguous: false }] });
  assert.equal(out['sess-a3'][0].steerState, 'kept');
});

check('[修前应绿] A 重载:claiming 残留照旧复位为可见 needs-review', () => {
  const out = stripSteerState({
    'sess-a4': [{
      queueId: 'a4', text: '被顶掉的', steerId: 'steer-a4', steerState: 'claiming',
      claimId: 'c1', targetPaneId: 'p1', claimDraft: { queueText: '原文', sourceQueueId: 'a4' },
    }],
  });
  const it = out['sess-a4'][0];
  assert.equal(it.steerState, 'needs-review');
  assert.equal(it.claimId, undefined);
  assert.equal(it.text, '原文');
});

console.log('— B 路径:切走再切回(reattach 1.5s 历史轮询 → 对账) —');

check('[修前应红] B 对账:回合还活着(turnActive)时,不管等多久都不判失败', () => {
  const out = reconcileSteered([inflight()], null, NO_KEYS, { turnActive: true });
  assert.equal(out[0]?.steerState, 'accepted',
    '回合没结束就没有"终局缺席"这回事:落盘要等下一个 tool_result 边界(实测最长 148s)');
  assert.equal(out[0]?.attemptWasAmbiguous, undefined, '不得落 attemptWasAmbiguous 死标记');
  assert.equal(out[0]?.steerId, 'steer-b1', 'steerId 保留,后续 UUID 命中仍能出队');
});

check('[修前应红] B store 路径:reconcileSteerQueue 要把 turnActive 透传给对账', () => {
  useStore.setState({ messageQueue: { 'sess-b': [inflight({ steerId: 'steer-b2' })] } });
  useStore.getState().reconcileSteerQueue('sess-b', NO_KEYS, { turnActive: true });
  assert.equal(useStore.getState().messageQueue['sess-b'][0].steerState, 'accepted',
    'store 不透传则 App.jsx 传什么都没用');
});

console.log('— 红线:兜底不能删(真失败仍必须被拦住) —');

check('[修前应绿] 红线:turnActive=false(回合已结束)+ UUID 仍缺席 → 必须翻 needs-review', () => {
  const out = reconcileSteered([inflight()], null, NO_KEYS, { turnActive: false });
  assert.equal(out[0]?.steerState, 'needs-review', '真丢消息必须停下让用户裁决,不能静默放行');
  assert.equal(out[0]?.attemptWasAmbiguous, true);
});

check('[修前应红] 终局对账(turnActive=false)不吃宽限:刚点的也缺席即翻', () => {
  const fresh = inflight({ queueId: 'b3', steerId: 'steer-b3', queuedAt: NOW, acceptedAt: NOW });
  const out = reconcileSteered([fresh], null, NO_KEYS, { turnActive: false });
  assert.equal(out[0]?.steerState, 'needs-review',
    'finalize 是一次终局对账:回合已结束还缺席 = 真失败,再挂 20s 只会让它永久卡在不可见的 accepted');
});

check('[修前应绿] 红线:UUID 正向命中 → 任何情形都出队(含 turnActive=true)', () => {
  const out = reconcileSteered([inflight()], null, new Set(['steer-b1']), { turnActive: true });
  assert.equal(out.length, 0);
});

check('[修前应绿] 旧调用点(不传 turnActive)保留 20s 宽限口径', () => {
  const fresh = inflight({ queueId: 'b4', steerId: 'steer-b4', acceptedAt: NOW - 1000 });
  assert.equal(reconcileSteered([fresh], null, NO_KEYS)[0]?.steerState, 'accepted');
  const stale = inflight({ queueId: 'b5', steerId: 'steer-b5', acceptedAt: NOW - 25_000 });
  assert.equal(reconcileSteered([stale], null, NO_KEYS)[0]?.steerState, 'needs-review');
});

check('[修前应绿] 红线:kept/needs-review 不被对账复活成其它态', () => {
  const kept = { queueId: 'b6', text: 'x', steerId: 'steer-b6', steerState: 'kept', attemptWasAmbiguous: false };
  assert.equal(reconcileSteered([kept], null, NO_KEYS, { turnActive: false })[0]?.steerState, 'kept');
});

console.log('— C 横幅判据(通知与翻案共用同一口径) —');

check('[修前应红] C 仍在途(accepted 且未超宽限)不算"无法确认"', () => {
  assert.equal(typeof steerStillInFlight, 'function', 'steerStillInFlight 必须导出(横幅与翻案共用判据)');
  assert.equal(steerStillInFlight(inflight({ acceptedAt: NOW - 1000, queuedAt: NOW - 1000 }), NOW), true);
  assert.equal(steerStillInFlight(inflight(), NOW), false, '超宽限仍未命中才算"无法确认"');
  assert.equal(steerStillInFlight({ steerState: 'needs-review' }, NOW), false);
  assert.equal(steerStillInFlight({ steerState: 'kept' }, NOW), false);
  assert.equal(steerStillInFlight(null, NOW), false);
  assert.ok(Number.isFinite(RECONCILE_GRACE_MS) && RECONCILE_GRACE_MS > 0);
});

// App.jsx 的接线锁:三个调用点都在 React 组件体内,单测跑不到 —— 只按源码锚点卡住
// 「必须传什么」,真值语义还得靠真机(见 RESERACH-20260912-steer-fail.md 场景 A/B)。
console.log('— D App.jsx 接线锚点 —');
const appSrc = readFileSync(join(ROOT, 'client/src/App.jsx'), 'utf8');

check('[修前应红] D finalize 收尾对账必须传 turnActive:false(回合确实结束了)', () => {
  assert.match(appSrc, /reconcileSteerQueue\(finalizeSid, keys, \{ turnActive: false \}\)/,
    'finalize 是终局对账:缺席即翻,真失败不漏判');
});

check('[修前应红] D 被动对账(历史变化触发)必须传回合存活判据', () => {
  assert.match(appSrc, /const turnActive = streamingRef\.current \|\| !!backgroundPidRef\.current \|\| !finalizedMessages\.length/,
    'reattach 途中 1.5s 一次的对账:回合活着 / 历史还没拉回来 → 一律不翻');
  assert.match(appSrc, /reconcileSteerQueue\(sessionQueueKey, persistedSteerIds, \{ turnActive \}\)/);
});

check('[修前应红] D 失败横幅必须走共用判据 steerStillInFlight', () => {
  assert.match(appSrc, /const reviewCount = list\.filter\(\(item\) => item\?\.steerId[\s\S]{0,160}?steerStillInFlight\(item\)\)\.length/,
    '横幅只统计确实超宽限仍未落盘的条目');
});

console.log(`\n${PASS} 绿 / ${FAILS} 红`);
if (FAILS) { for (const f of failed) console.log(`  红: ${f}`); process.exit(1); }
console.log('PASS check-r46-steer-turn-alive');
