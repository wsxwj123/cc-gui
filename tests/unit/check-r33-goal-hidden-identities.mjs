#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  MAX_HIDDEN_GOAL_IDENTITIES,
  forgetHiddenGoalIdentity,
  goalIdentity,
  isGoalIdentityHidden,
  legacyGoalIdentities,
  migrateHiddenGoalIdentity,
  parseHiddenGoalIdentities,
  readHiddenGoalIdentities,
  rememberHiddenGoalIdentity,
  resolveGoalHiddenState,
} from '../../client/src/utils/goal.js';

class MemoryStorage {
  constructor(entries = []) { this.values = new Map(entries); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const keyA = 'cgui-goal-hidden:session-a';
const keyB = 'cgui-goal-hidden:session-b';
const goalA = goalIdentity({ condition: '目标A', met: false, sentinel: true });
const goalB = goalIdentity({ condition: '目标B', met: false, sentinel: true });
const legacyGoalA = '目标A|false|true';

assert.equal(goalIdentity({ condition: '目标A', met: false, sentinel: true }), goalA);
assert.equal(goalIdentity({ condition: '目标A', met: false, sentinel: false }), goalA, '未达成更新不换身份');
assert.equal(goalIdentity({ condition: '目标A', met: true, sentinel: false }), goalA, '达成更新不换身份');
assert.equal(goalIdentity({ condition: '目标A', met: true, sentinel: true }), goalA, '清除更新不换身份');
assert.notEqual(goalIdentity({ condition: '目标B' }), goalA, '不同 condition 仍是不同目标身份');

// 旧单 fingerprint 无迁移门槛：能直接读；第一次新增身份时自然写成集合。
const storage = new MemoryStorage([[keyA, legacyGoalA]]);
assert.deepEqual(readHiddenGoalIdentities(storage, keyA), [legacyGoalA], '旧单值兼容');
assert.equal(isGoalIdentityHidden(storage, keyA, goalA, legacyGoalIdentities('目标A')), true);
assert.equal(migrateHiddenGoalIdentity(storage, keyA, goalA, legacyGoalIdentities('目标A')), true);
assert.deepEqual(readHiddenGoalIdentities(storage, keyA), [goalA], '旧状态 fingerprint 迁到稳定 condition 身份');
assert.equal(rememberHiddenGoalIdentity(storage, keyA, goalB), true);
assert.deepEqual(JSON.parse(storage.getItem(keyA)), [goalA, goalB], '旧值升级为多身份集合');
assert.equal(isGoalIdentityHidden(storage, keyA, goalA), true, '显示 B 后 A 的隐藏记录仍在');
assert.equal(isGoalIdentityHidden(storage, keyA, goalB), true);

// “显示”只移除当前身份，不影响同会话其他目标或其他会话。
rememberHiddenGoalIdentity(storage, keyB, goalB);
assert.equal(forgetHiddenGoalIdentity(storage, keyA, goalB), true);
assert.equal(isGoalIdentityHidden(storage, keyA, goalA), true, '显示 B 不得顺带清 A');
assert.equal(isGoalIdentityHidden(storage, keyA, goalB), false);
assert.equal(isGoalIdentityHidden(storage, keyB, goalB), true, '会话 B 隔离');
assert.equal(resolveGoalHiddenState({ key: keyA, identity: goalA, hidden: true }, keyA, goalB, false), false,
  '从隐藏 A 切到 B 的首帧不得继承 A 的瞬时 boolean');
assert.equal(resolveGoalHiddenState({ key: keyA, identity: goalA, hidden: true }, keyB, goalA, false), false,
  '切会话首帧不得继承另一会话的瞬时 boolean');
assert.equal(resolveGoalHiddenState({ key: keyA, identity: goalA, hidden: true }, keyA, goalA, false), true);

// 没有贯穿 UUID 时，同 condition 重新设定沿用同一身份/隐藏偏好（明确产品语义）。
assert.equal(goalIdentity({ condition: '目标A', met: false, sentinel: true }), goalA);
assert.equal(isGoalIdentityHidden(storage, keyA, goalA), true, '同 condition 重设仍保持隐藏');

// 最近身份有界；重复隐藏移到最近端但不复制。
for (let index = 0; index < MAX_HIDDEN_GOAL_IDENTITIES + 8; index += 1) {
  rememberHiddenGoalIdentity(storage, keyA, `goal-${index}`);
}
const bounded = readHiddenGoalIdentities(storage, keyA);
assert.equal(bounded.length, MAX_HIDDEN_GOAL_IDENTITIES);
assert.equal(bounded.includes('goal-0'), false, '淘汰最旧身份');
assert.equal(bounded.at(-1), `goal-${MAX_HIDDEN_GOAL_IDENTITIES + 7}`, '保留最近身份');
rememberHiddenGoalIdentity(storage, keyA, 'goal-20');
const deduped = readHiddenGoalIdentities(storage, keyA);
assert.equal(deduped.filter((value) => value === 'goal-20').length, 1);
assert.equal(deduped.at(-1), 'goal-20', '重复隐藏更新最近顺序');

assert.deepEqual(parseHiddenGoalIdentities(JSON.stringify(['', goalA, goalA, goalB])), [goalA, goalB]);

console.log('✓ check-r33-goal-hidden-identities: 旧值兼容 + 会话/身份隔离 + 单项显示 + 最近32项有界全过');
