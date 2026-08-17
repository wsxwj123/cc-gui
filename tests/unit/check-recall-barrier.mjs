#!/usr/bin/env node
// 判官必修-3(③):↑ 召回绕过 barrier 保护。
// 旧判据只有 !hidden && !isSteered → needs-review/unknown/claiming 会被 ↑ 无确认回填
// 重发(双发),且旧 removeFromQueue 拒删使队列还残留第三份。
// 修法:召回过滤加 !isSteerBarrier(q) && steerState!=='kept'(kept=用户决定不发)。
// 变异哨兵(已实际验证红过一次):把 ChatInput 召回判据还原为旧两条件 → 源码守卫红;
// 判定矩阵用真 import 的 isSteerBarrier/isSteered 复算同款扫描,删掉修复则矩阵断言红。
// Run: node tests/unit/check-recall-barrier.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isSteerBarrier, isSteered } from '../../client/src/utils/steerQueue.js';

// 与 ChatInput ↑ 召回相同的扫描判据(从队尾向前找第一条可召回项)。
const recallIndex = (queueItems) => {
  for (let i = queueItems.length - 1; i >= 0; i--) {
    const q = queueItems[i];
    if (!q?.hidden && !isSteered(q) && !isSteerBarrier(q) && q?.steerState !== 'kept') return i;
  }
  return -1;
};

const plainA = { queueId: 'a', text: '普通A' };
const plainB = { queueId: 'b', text: '普通B' };
const review = { queueId: 'r', text: '待复核', steerId: 'steer-r', steerState: 'needs-review', attemptWasAmbiguous: true };
const unknown = { queueId: 'u', text: '未决', steerId: 'steer-u', steerState: 'unknown' };
const claiming = { queueId: 'c', text: '取回中', steerId: 'steer-c', steerState: 'claiming' };
const accepted = { queueId: 's', text: '已注入', steerId: 'steer-s', steerState: 'accepted' };
const kept = { queueId: 'k', text: '已保留', steerId: 'steer-k', steerState: 'kept' };
const hidden = { queueId: 'h', text: '隐藏续跑', hidden: true };

// 队尾是 needs-review:召回必须落到它前面最近的普通条目(规格点名场景)
assert.equal(recallIndex([plainA, plainB, review]), 1, '队尾 needs-review 被跳过,召回前一条普通项');
// 各 barrier 态与 kept/hidden 都不可召回
for (const [name, item] of [['needs-review', review], ['unknown', unknown], ['claiming', claiming], ['accepted', accepted], ['kept', kept], ['hidden', hidden]]) {
  assert.equal(recallIndex([item]), -1, `${name} 不可被 ↑ 召回`);
}
// 全是 barrier/kept 时召回落空(不许退回旧行为召回 barrier)
assert.equal(recallIndex([review, unknown, kept]), -1, '无普通条目时 ↑ 不召回任何 barrier');
// 普通条目照常从队尾召回
assert.equal(recallIndex([plainA, plainB]), 1, '普通条目仍按最近入队优先召回');

// ── 源码守卫:ChatInput 的 ↑ 召回扫描必须带 barrier/kept 排除 ──
const input = readFileSync(new URL('../../client/src/components/ChatInput.jsx', import.meta.url), 'utf8');
const arrowUpBlock = input.slice(input.indexOf("e.key === 'ArrowUp' && !e.shiftKey"), input.indexOf('if (lastIdx >= 0 && onEditFromQueue)'));
assert.ok(arrowUpBlock.length > 0, '↑ 召回代码块不见了(重构后同步本守卫)');
assert.match(arrowUpBlock, /!isSteerBarrier\(q\)/, '召回判据必须排除 barrier(判官必修-3 不许回归)');
assert.match(arrowUpBlock, /steerState !== 'kept'/, "召回判据必须排除 'kept'(用户决定不发)");

console.log('PASS check-recall-barrier');
