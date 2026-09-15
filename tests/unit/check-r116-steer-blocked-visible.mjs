#!/usr/bin/env node
// r116 复现:「消息队列里的『⚡ 并入』按钮有时候点不了」(用户实报)。
//
// 缺陷:队首是 accepted(已送进当前回合、CLI 还没把它写进 jsonl)+ 后面还有排队消息时,
// firstSteerableIndex 返 -1 → 按钮恒为灰。而这条把它挡住的消息在队列条里【完全不显示】
// (R7-3 的 isSteered 过滤),hover 又只按 canSteer 分句、写着"把队列里的下一条消息并入
// 当前回合" —— 三重坏:看不到原因、文案说能点、又没有出路。
//
// 本次修的是【解释与可见性】,不动对账:闸门(BARRIER_STATES/firstSteerableIndex)、
// 拒删在途条目、reconcileSteered/stripSteerState 全部原样(那三条是 R46 的哨兵)。
//
// 两类哨兵:
//   [修前应红] 队首被占的原因码 + 队列条上的可见状态行(修前 steerBlockReason 不存在);
//   [修前应绿] 红线:闸门不得被放松(accepted 队首仍不可并入)、在途条目仍不可删。
// Run: node tests/unit/check-r116-steer-blocked-visible.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};

const {
  firstSteerableIndex, steerBlockReason, isSteerBarrier,
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
// 用户踩的那一格:队首 accepted(在途、等落盘),后面还有一条普通排队消息。
const inflight = (over = {}) => ({
  queueId: 'q-inflight', text: '已送进回合的', steerId: 'steer-1', steerState: 'accepted',
  queuedAt: NOW - 3000, acceptedAt: NOW - 2000, ...over,
});
const queued = (over = {}) => ({ queueId: 'q-2', text: '后面排队的', queuedAt: NOW, ...over });

console.log('— A 队首为什么不能并入(steerBlockReason 真值表) —');

check('[修前应红] 队首 accepted + 后面有可见条目 → 原因码 accepted(不是笼统的"不能并入")', () => {
  const list = [inflight(), queued()];
  assert.equal(firstSteerableIndex(list), -1, '前提:闸门确实拦着(这是设计,不许放松)');
  assert.equal(steerBlockReason(list), 'accepted',
    '用户看到的灰按钮必须能归因到"队首那条在等模型读到",否则又是"按钮灰得没头没脑"');
});

check('[修前应红] 其余在途/未决态各自有原因码,不能被笼统吞掉', () => {
  assert.equal(steerBlockReason([inflight({ steerState: 'needs-review', attemptWasAmbiguous: true })]), 'review');
  assert.equal(steerBlockReason([inflight({ steerState: 'claiming' })]), 'claiming');
  assert.equal(steerBlockReason([inflight({ steerState: 'unknown' })]), 'unknown');
  assert.equal(steerBlockReason([{ queueId: 'h', text: '计划续跑', hidden: true }]), 'hidden');
  assert.equal(steerBlockReason([]), 'none');
});

check('[修前应绿] 能并入时原因码必须是 null(可点态不许被误报成被挡)', () => {
  assert.equal(steerBlockReason([queued()]), null);
  assert.equal(steerBlockReason([{ ...queued(), steerState: 'kept' }, queued()]), null,
    'kept 是 resolved(用户决定不发),不拦后项,也不算"按钮为什么灰"的理由');
});

console.log('— B 红线:闸门与拒删都不得被放松(本次只修解释,不修对账) —');

check('[修前应绿] 红线:accepted 队首仍然不可并入(无序越过在途条目 = 乱序/双发)', () => {
  assert.equal(firstSteerableIndex([inflight(), queued()]), -1);
  assert.equal(isSteerBarrier(inflight()), true);
});

check('[修前应绿] 红线:在途(accepted)条目仍然不可删(删了与对账竞态)', () => {
  useStore.setState({ messageQueue: { 'sess-r116': [inflight()] } });
  useStore.getState().removeFromQueue('sess-r116', 0);
  assert.equal(useStore.getState().messageQueue['sess-r116'].length, 1,
    '结果未定的条目只能等(回合结束未命中会翻成 needs-review,那时才有取回/删除入口)');
});

// ── 源码守卫(ChatInput.jsx 是 JSX,进不了 node;钉住"看得懂"的三个点) ──
console.log('— C ChatInput 接线锚点(可见性 / 文案 / 秒表) —');
const input = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');

check('[修前应红] 队列条不得再用 isSteered 把在途条目整个藏掉', () => {
  assert.doesNotMatch(input, /q\.hidden \|\| isSteered\(q\) \? null :/,
    'R7-3 的过滤是这一格的病根:藏掉它 = 用户看不到按钮为什么灰');
  assert.match(input, /\{isSteered\(q\) && \(/, '在途条目必须有它自己的行内状态');
  assert.match(input, /已并入当前回合，等待模型读到它/);
});

check('[修前应红] 状态行必须带秒表(看得出是在等,不是卡住)', () => {
  assert.match(input, /<ElapsedTime startedAt=\{q\.acceptedAt \?\? q\.queuedAt\} \/>/,
    '等了多久是用户判断"要不要等下去"的唯一依据');
});

check('[修前应红] 并入按钮的 hover 必须按真实原因分句(不许再说"把队列里的下一条并入")', () => {
  assert.match(input, /title=\{steerBlockTitle\(canSteer, queueItems\)\}/,
    '文案若仍只按 canSteer 分句:按钮灰着、文字说能点(用户实报的体验)');
  assert.match(input, /case 'accepted': return `队列最前面的消息\$\{STEER_WAIT_NOTE\}`/);
  assert.match(input, /if \(!reason\) return '把队列里的下一条消息并入当前回合/,
    '能点时的说明照旧保留(别把正常态也改成"原因"文案)');
});

check('[修前应绿] 红线:按钮的 disabled 判据一个字都不许动', () => {
  assert.match(input, /disabled=\{!canSteer \|\| firstSteerableIndex\(queueItems\) < 0\}/,
    'connecting 窗口(canSteer=false)与队首闸门都是设计,本次只改"说给人听的那部分"');
});

console.log(`\n${PASS} 绿 / ${FAILS} 红`);
if (FAILS) { for (const f of failed) console.log(`  红: ${f}`); process.exit(1); }
console.log('PASS check-r116-steer-blocked-visible');
