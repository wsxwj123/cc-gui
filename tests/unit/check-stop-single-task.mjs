#!/usr/bin/env node
// 部件① stopSingleTask store action 自检(真 store + fetch 桩)。依据 PLAN/INTERFACE:
//  - 乐观收尾:非终态目标即刻标 stopped(第三方不发 task_notification 也收敛),保留 taskManaged
//    供后续权威终态覆盖;终态目标(done/error/stopped)不被回翻。
//  - 扇出:按 sessionId 过滤 kind:'chat-process' && stoppable,只对属主会话的 slot 发
//    POST stop-task {toolUseId, sessionId},不碰别的会话/已结束/cli-session。
import assert from 'node:assert/strict';

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();

// fetch 桩:记录调用;/agents/active 返回混合列表(属主/别的会话/已结束/非 chat-process);
// stop-task 的 stopped 结果可切换(S1 回滚用例)。
const calls = [];
let stopTaskStopped = true; // 属主 slot 是否命中
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  if (String(url) === '/api/agents/active') {
    return { json: async () => ({ agents: [
      { kind: 'chat-process', pid: 'sdk-1', sessionId: 'sid-A', stoppable: true },   // 属主,应发
      { kind: 'chat-process', pid: 'sdk-2', sessionId: 'sid-B', stoppable: true },   // 别的会话,不发
      { kind: 'chat-process', pid: 'sdk-3', sessionId: 'sid-A', stoppable: false },  // 已结束,不发
      { kind: 'cli-session',  pid: '999',   sessionId: 'sid-A', stoppable: true },   // 非 chat-process,不发
    ] }) };
  }
  return { json: async () => ({ ok: true, stopped: stopTaskStopped }) };
};

// 1) 非终态目标 → 乐观标 stopped,taskManaged 保留
st().upsertAgent('tu-1', { sessionId: 'sid-A', status: 'working', taskManaged: true });
await st().stopSingleTask('sid-A', 'tu-1');
assert.equal(st().activeAgents['tu-1'].status, 'stopped', '非终态目标乐观收敛为 stopped');
assert.ok(st().activeAgents['tu-1'].taskManaged, 'taskManaged 保留(供权威终态覆盖)');

// 2) 只扇出到 sid-A 的可停 chat-process(sdk-1),带 toolUseId+sessionId
const stopTaskCalls = calls.filter((c) => c.url.includes('/stop-task'));
assert.equal(stopTaskCalls.length, 1, '只对 sid-A 的一个可停 chat-process 扇出,不碰别的会话/已结束/cli-session');
assert.ok(stopTaskCalls[0].url.includes('/chat/sdk-1/stop-task'), '发到属主 slot pid');
const body = JSON.parse(stopTaskCalls[0].opts.body);
assert.equal(body.toolUseId, 'tu-1', 'body 带 toolUseId');
assert.equal(body.sessionId, 'sid-A', 'body 带 sessionId 供会话归属守卫');

// 3) 终态目标不被回翻
st().upsertAgent('tu-2', { sessionId: 'sid-A', status: 'done' });
await st().stopSingleTask('sid-A', 'tu-2');
assert.equal(st().activeAgents['tu-2'].status, 'done', '已 done 的目标不被乐观回翻为 stopped');

// 4) 空 toolUseId → 直接返回,不发任何请求
calls.length = 0;
await st().stopSingleTask('sid-A', '');
assert.equal(calls.length, 0, '空 toolUseId 不发请求');

// 5) S1 回滚:非终态目标,所有属主 pid 都返回 stopped:false(查无)→ 乐观 stopped 回滚为原状态
stopTaskStopped = false;
st().upsertAgent('tu-3', { sessionId: 'sid-A', status: 'working' });
await st().stopSingleTask('sid-A', 'tu-3');
assert.equal(st().activeAgents['tu-3'].status, 'working', '无一命中 → 乐观 stopped 回滚为原 working(不假「已停」)');

// 6) S1 边界:回滚只在仍停于乐观 stopped 时发生——其间到达权威 done 不被回滚覆盖
stopTaskStopped = false;
st().upsertAgent('tu-4', { sessionId: 'sid-A', status: 'working' });
const p = st().stopSingleTask('sid-A', 'tu-4');   // 乐观已标 stopped
st().upsertAgent('tu-4', { status: 'done' });      // 模拟其间权威终态到达
await p;
assert.equal(st().activeAgents['tu-4'].status, 'done', '权威 done 到达后不被回滚覆盖');

// 7) S1 边界:其间权威 stopped(status 与乐观值同形)到达 → 不被回滚。用显式 optimisticStop
//    标记区分"我们乐观写的 stopped"与"权威 stopped";权威终态到达时 finalizeAgent 清 optimisticStop
//    (此处模拟该清除),回滚够不着。
stopTaskStopped = false;
st().upsertAgent('tu-5', { sessionId: 'sid-A', status: 'working' });
const p2 = st().stopSingleTask('sid-A', 'tu-5');   // 乐观标 stopped + optimisticStop:true
st().upsertAgent('tu-5', { optimisticStop: false }); // 模拟权威 stopped 到达:finalizeAgent 清标记(status 仍 stopped)
await p2;
assert.equal(st().activeAgents['tu-5'].status, 'stopped', '权威 stopped(同形)到达后不被回滚翻回 working');

console.log('PASS check-stop-single-task');
