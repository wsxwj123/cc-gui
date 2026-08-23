#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  MAX_HIDDEN_GOAL_IDENTITIES,
  forgetHiddenGoalIdentity,
  isGoalIdentityHidden,
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
const goalA = '目标A|false|true';
const goalB = '目标B|false|true';

// 旧单 fingerprint 无迁移门槛：能直接读；第一次新增身份时自然写成集合。
const storage = new MemoryStorage([[keyA, goalA]]);
assert.deepEqual(readHiddenGoalIdentities(storage, keyA), [goalA], '旧单值兼容');
assert.equal(isGoalIdentityHidden(storage, keyA, goalA), true);
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
