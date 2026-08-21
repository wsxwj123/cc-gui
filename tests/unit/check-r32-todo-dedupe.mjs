#!/usr/bin/env node
// r32-plan-flood 修复3:待办同族去重。
// 根因:rebuildTodosFromTaskCalls 里 TaskCreate 的 result 解析不出 "Task #N"(真 id)时,
// 旧实现落 autoId 自增 → Stop 钩子强制续跑每轮重提同一任务(same subject)会建出 N 条
// 同内容条目。
// 修复:无真 id 的 TaskCreate 按 subject 去重(保留最新状态),有真 id 的路径完全不动。
// 本文件是对纯函数 rebuildTodosFromTaskCalls 的直调单测。
import assert from 'node:assert/strict';
import { rebuildTodosFromTaskCalls } from '../../client/src/utils/todos.js';

// 无真 id(result 为空 content)
const noId = (subject, activeForm = '') => ({ name: 'TaskCreate', input: { subject, activeForm }, result: { content: '' } });
// 有真 id(result 解析出 "Task #N")
const withId = (subject, id) => ({ name: 'TaskCreate', input: { subject }, result: { content: `Task #${id} created` } });
// result 是纯字符串(非对象)时也要能解析出真 id
const withIdStr = (subject, id) => ({ name: 'TaskCreate', input: { subject }, result: `Task #${id} created` });

// ── 场景A(修复目标):同 subject 无真 id 重复 5 次 → 去重成 1 条,保留最新状态 ──
{
  const calls = ['写测试', '写测试', '写测试', '写测试', '写测试']
    .map((s, i) => noId(s, i === 4 ? 'advanced' : ''));
  const todos = rebuildTodosFromTaskCalls(calls);
  assert.ok(Array.isArray(todos), '返回数组');
  assert.equal(todos.length, 1, `同 subject 无真 id 的 5 条 TaskCreate 应去重成 1 条(实得 ${todos.length})`);
  assert.equal(todos[0].content, '写测试', '保留 subject');
  assert.equal(todos[0].activeForm, 'advanced', '保留最新一轮状态');
  assert.equal(todos[0].status, 'pending', 'TaskCreate 语义恒 pending');
}

// ── 场景B(反向):不同 subject 无真 id → 各自建项,不过度折叠 ──
{
  const todos = rebuildTodosFromTaskCalls([noId('写测试'), noId('读代码'), noId('提交评论')]);
  assert.equal(todos.length, 3, `3 个不同 subject 各建 1 条(实得 ${todos.length})`);
  assert.deepEqual(todos.map((t) => t.content).sort(), ['写测试', '读代码', '提交评论'].sort());
}

// ── 场景C(路径不动):有真 id 的 TaskCreate 完全按真 id 建项 ──
{
  // 同 subject 但真 id 不同 = 两个真实任务,不得被 subject 去重合并
  const todos = rebuildTodosFromTaskCalls([withId('写测试', 7), withId('写测试', 8)]);
  assert.equal(todos.length, 2, `不同真 id 的同 subject = 2 条真任务,不去重(实得 ${todos.length})`);
  // 同一真 id 重复 = last-wins(原有行为不变)
  const sameId = rebuildTodosFromTaskCalls([withId('写测试', 7), withId('读代码', 7)]);
  assert.equal(sameId.length, 1, '同一真 id 重复 TaskCreate 仍 last-wins');
  assert.equal(sameId[0].content, '读代码');
  // result 为纯字符串也能解析出真 id(路径不动)
  const strId = rebuildTodosFromTaskCalls([withIdStr('提交评论', 42)]);
  assert.equal(strId.length, 1);
  assert.equal(strId[0].content, '提交评论');
}

// ── 场景D:TaskUpdate 仍按 taskId 更新(不受 subject 去重影响) ──
{
  // 先无真 id 建 subject X(得 auto 键),再 TaskUpdate 按该 taskId 改 status 到 completed
  // —— 这种情况下 taskId 匹配 auto 键是旧行为的边界;至少保证 TaskUpdate 分支没被破坏。
  const calls = [
    noId('写测试'),
    { name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },  // 恰好命中 auto 键"1"
  ];
  const todos = rebuildTodosFromTaskCalls(calls);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].status, 'completed', 'TaskUpdate 分支仍按 taskId 更新状态');
}

// ── 场景E:空/无 task 调用 → null 或 TodoWrite 快照优先 ──
{
  assert.equal(rebuildTodosFromTaskCalls([]), null, '无调用返回 null');
  assert.equal(rebuildTodosFromTaskCalls(undefined), null, 'undefined 返回 null');
  const snap = rebuildTodosFromTaskCalls([
    { name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending' }] } },
    noId('写测试'),
  ]);
  assert.ok(snap && snap.length === 1 && snap[0].content === 'x', 'TodoWrite 覆盖式快照仍优先');
}

console.log('✓ check-r32-todo-dedupe: 同 subject 无真 id 去重成 1 条 + 不同 subject/有真 id 路径不动');
