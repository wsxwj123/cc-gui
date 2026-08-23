#!/usr/bin/env node
// r31-goal-optimistic:/goal 常驻条的发送侧乐观显示。
// 覆盖(行为 + 静态接线哨兵):
//   · /goal 发出即亮 —— 真实 parseGoalCommand 把 /goal <cond> 解析为 set{condition};
//   · 记录到达后无缝 —— App 侧 optimisticLanded(历史出现同 condition 且 met:false)切换历史驱动,
//     乐观态随即清除(effectiveGoal 回落到 activeGoal);
//   · /goal clear 即隐 —— parseGoalCommand 返回 clear,App 侧 setOptimisticGoal(null);
//   · 普通消息不误亮 —— 非 /goal 文本返回 null(不发乐观态);
//   · 排队中不亮 —— App 里 setOptimisticGoal 出现在排队门(streamingRef 直接 return)之后,
//     即只有真正起流(非排队/reattach)才亮。
// 达成/判定的 reason 更新仍走历史 —— 乐观态只带 condition(断言乐观对象不含 reason)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  migrateOptimisticGoalOwner,
  optimisticGoalForOwner,
  parseGoalCommand,
} from '../../client/src/utils/goal.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
const goal = readFileSync(join(root, 'client/src/utils/goal.js'), 'utf8');

// ── 1. parseGoalCommand 真实行为 ──────────────────────────────────────
assert.deepEqual(parseGoalCommand('/goal 用中文写出任务完成'),
  { type: 'set', condition: '用中文写出任务完成' }, '/goal <cond> → set(条件原样带出)');
assert.deepEqual(parseGoalCommand('/goal clear'),
  { type: 'clear' }, '/goal clear → clear');
assert.deepEqual(parseGoalCommand('/goal clear 别的工作'),
  { type: 'clear' }, '/goal clear 前缀(含尾随字符)视为清除 —— 保守隐条,避免误设目标');
assert.deepEqual(parseGoalCommand('/goal'), null, '裸 /goal(用法提示)不设目标');
assert.deepEqual(parseGoalCommand('帮我写点东西'), null, '普通文本不误判为 /goal');
assert.deepEqual(parseGoalCommand('GOAL 大写也能识别'), null, '非行首/无斜杠不算 /goal');
assert.equal(parseGoalCommand('/GOAL 任务大写成设置').type, 'set', '/goal 大小写不敏感');
assert.deepEqual(parseGoalCommand(' /goal  trim 前后空格 '), { type: 'set', condition: 'trim 前后空格' },
  '/goal 前后空白应被忽略,条件取 trim 后的余下文本');

// ── 2. 显式 owner 与 draft→real 原子迁移 ───────────────────────────
const goalState = {
  ownerKey: 'draft-project-a-d1',
  goal: { met: false, sentinel: true, condition: '只属于 A' },
};
assert.equal(optimisticGoalForOwner(goalState, 'draft-project-a-d1'), goalState.goal,
  '当前 owner 同步读到自己的乐观目标');
assert.equal(optimisticGoalForOwner(goalState, 'session-b'), null,
  '切到 B 的首帧即拒绝 A 的目标，不等待 effect 清理');
const migrated = migrateOptimisticGoalOwner(goalState, 'draft-project-a-d1', 'session-a');
assert.equal(migrated.ownerKey, 'session-a', 'draft→real 迁移 owner');
assert.equal(migrated.goal, goalState.goal, '迁移保持同一目标对象，换绑时不闪失');
assert.equal(optimisticGoalForOwner(migrated, 'session-a'), goalState.goal,
  '真实 session 换绑后的同一帧继续显示目标');
assert.equal(migrateOptimisticGoalOwner(goalState, 'draft-other', 'session-other'), goalState,
  '不属于该 draft 的异步 init 不得抢迁目标');

// ── 3. App 侧接线哨兵 ────────────────────────────────────────────────
assert.ok(app.includes('optimisticGoal'), 'App 要持有发送侧乐观 activeGoal 状态');
assert.ok(app.includes('setOptimisticGoalState'), 'App 要能写带 owner 的乐观态(setter)');
assert.ok(app.includes('optimisticLanded'), 'App 要判定"历史记录到达"(切换历史驱动的开关)');
assert.ok(app.includes('effectiveGoal'), 'App 要用 effectiveGoal 合并乐观态与历史 activeGoal');
assert.ok(/goal=\{effectiveGoal\}/.test(app), 'GoalBar 接 effectiveGoal(activeGoal 叠加乐观态)');

// 乐观对象只带 condition,不带 reason/iterations —— reason 更新仍走历史,不在乐观态里造。
assert.ok(app.includes('condition: _gc.condition'), '乐观对象写入 condition');
assert.ok(!/condition: _gc\.condition[^}]*reason/.test(app), '乐观态不造 reason');
assert.ok(app.includes('ownerKey: sessionQueueKey'), '乐观目标显式记录发送时 owner');
assert.ok(app.includes('goal: { met: false, sentinel: true, condition: _gc.condition }'),
  '/goal set 写入目标载荷，clear 分支写 null');

// 排队中不亮:setOptimisticGoal 必须出现在排队门(流式中直接 return)之后 ——
// 即"真正起流"路径才亮,排队/reattach 不回。门里调 enqueueMessage,门后才写乐观态。
const gateIdx = app.indexOf('if (!reattachPid && !opts.forceSend && (streamingRef.current');
const enqIdx = app.indexOf('enqueueMessage');
const sendSetIdx = app.indexOf('if (_gc) setOptimisticGoalState(');
assert.ok(gateIdx >= 0 && enqIdx >= 0 && enqIdx < gateIdx, '排队门含 enqueueMessage(排队确实走此分支)');
assert.ok(sendSetIdx > gateIdx, 'setOptimisticGoal 在排队门之后(排队中不亮,真正发出才亮)');

// 记录到达后无缝:optimisticLanded 以"历史出现同 condition 且 !met"为切换开关。
assert.ok(/optimisticLanded[\s\S]{0,240}messages\.some\(\(m\) => m\?\.type === 'goal' && m\.condition === optimisticGoal\.condition && !m\.met\)/.test(app),
  'optimisticLanded 判定历史已到达本目标的生效记录(同 condition 且 met:false)');

// effectiveGoal:乐观未落榜或历史尚未持有 activeGoal 时继续显示乐观态。
assert.ok(/const effectiveGoal = \(optimisticGoal && \(!optimisticLanded \|\| !activeGoal\)\) \? optimisticGoal : activeGoal/.test(app),
  'effectiveGoal:乐观未落榜或历史尚未持有 activeGoal 时继续显示乐观态');

assert.ok(app.includes('migrateOptimisticGoalOwner('), 'draft init 换绑必须迁移乐观目标 owner');
assert.ok(app.includes('optimisticGoalForOwner(optimisticGoalState, sessionQueueKey)'),
  '渲染期必须同步按当前会话 owner 门控，不能等 effect');

console.log('✓ check-r31-goal-optimistic: /goal 发出即亮 + 记录到达无缝 + clear 即隐 + 普通消息不误亮 + 排队中不亮 全过');
