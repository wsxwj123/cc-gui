#!/usr/bin/env node
// 部件① stopSingleTask store action 自检(真 store + fetch 桩)。依据 PLAN/INTERFACE:
//  - 乐观收尾:非终态目标即刻标 stopped(第三方不发 task_notification 也收敛),保留 taskManaged
//    供后续权威终态覆盖;终态目标(done/error/stopped)不被回翻。
//  - 扇出:按 sessionId 过滤 kind:'chat-process' && stoppable,只对属主会话的 slot 发
//    POST stop-task {toolUseId, sessionId},不碰别的会话/已结束/cli-session。
import assert from 'node:assert/strict';

const { useStore } = await import('../../client/src/stores/sessionStore.js');
const st = () => useStore.getState();

// fetch 桩:记录调用;/agents/active 返回混合列表(属主/别的会话/已结束/非 chat-process)。
const calls = [];
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
  return { json: async () => ({ ok: true, stopped: true }) };
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

console.log('PASS check-stop-single-task');
