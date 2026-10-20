#!/usr/bin/env node
// r151k ①:看门狗判断「本会话还有卡在等用户回答」的计数。
//   countPendingForSession(pendingMap, sessionId) 是纯函数(假 Map 可注入),停表/大小写/空值都覆盖;
//   pendingUserCardCount(sessionId) 用真实 pending 表,权限卡 / elicitation / dialog 三类都算,
//   dropPendingForSession 清卡后归零(用户答复/进程退出走的同一清理路径)。
// node tests/unit/check-r151k-pending-cards.mjs
import assert from 'node:assert/strict';
import {
  countPendingForSession, pendingUserCardCount, requestElicitation, requestPermission, requestUserDialog, dropPendingForSession,
} from '../../server/routes/permissions.js';

let checks = 0;
const eq = (got, want, label) => { assert.equal(got, want, label); checks += 1; };

// ── ① 纯函数:假 pending 表 ───────────────────────────────────────────────────
{
  const map = new Map([
    ['a1', { request: { sessionId: 'Sess-A', toolName: 'Bash' } }],
    ['a2', { request: { sessionId: 'sess-a', toolName: 'AskUserQuestion' } }],
    ['a3', { request: { sessionId: 'SESS-A', toolName: 'ExitPlanMode' }, settled: false }],
    ['b1', { request: { sessionId: 'sess-b', kind: 'elicitation' } }],
    ['n1', { request: { sessionId: null, toolName: 'Bash' } }],
    ['n2', { request: { toolName: 'Bash' } }],
    ['n3', { request: null }],
    ['n4', null],
    ['s1', { request: { sessionId: 'sess-a' }, settled: true }],
  ]);
  eq(countPendingForSession(map, 'sess-a'), 3, '同会话(不分大小写)、未 settle 的条目都算');
  eq(countPendingForSession(map, 'SESS-A'), 3, '传入大写同样匹配');
  eq(countPendingForSession(map, 'sess-b'), 1, '其它 kind 卡(elicitation)也算');
  eq(countPendingForSession(map, 'sess-c'), 0, '没有该会话 → 0');
  eq(countPendingForSession(map, null), 0, 'sessionId=null → 0');
  eq(countPendingForSession(map, ''), 0, 'sessionId 空串 → 0');
  eq(countPendingForSession(map, 42), 0, 'sessionId 不是字符串 → 0');
  eq(countPendingForSession(null, 'sess-a'), 0, 'pendingMap=null → 0');
  eq(countPendingForSession({}, 'sess-a'), 0, 'pendingMap 不是 Map → 0');
  eq(countPendingForSession(new Map(), 'sess-a'), 0, '空表 → 0');
  eq(countPendingForSession(new Map([['x', { request: { sessionId: 'X' } }]]), 'x'), 1, '只有一条也算');
}

// ── ② 真实 pending 表:三类卡都进同一张表,清卡后归零 ─────────────────────────
{
  const id = `r151k-pending-${process.pid}-${Date.now()}`;
  eq(pendingUserCardCount(id), 0, '起始为 0');
  const p1 = requestPermission({ toolName: 'AskUserQuestion', toolInput: {}, sessionId: id });
  const p2 = requestElicitation({ serverName: 'test-mcp', message: '填表', requestedSchema: {}, sessionId: id });
  const p3 = requestUserDialog({ dialogKind: 'refusal_fallback_prompt', payload: {}, sessionId: id });
  eq(pendingUserCardCount(id), 3, '权限卡 / elicitation / dialog 都算');
  eq(pendingUserCardCount(id.toUpperCase()), 3, '真实表计数也不分大小写');
  eq(pendingUserCardCount('other-session'), 0, '不串会话');
  dropPendingForSession(id);
  eq(pendingUserCardCount(id), 0, '清卡后归零(用户答复/进程退出走同一路径)');
  // drop 会 settle 成 deny,三个 Promise 都拿到终态,不会悬挂(kind 卡按各自协议翻译)
  const results = await Promise.all([p1, p2, p3]);
  eq(results[0].decision, 'deny', '权限卡拿到 deny');
  eq(results[1].action, 'cancel', 'elicitation 拿到 cancel(未作答)');
  eq(results[2].behavior, 'cancelled', 'dialog 拿到 cancelled');
}

console.log(`✓ r151k 提问卡计数单测全部通过(${checks} 项断言)`);
