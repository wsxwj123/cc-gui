#!/usr/bin/env node
// 部件① stopSingleTask store action 自检(真 store + fetch 桩)。依据 PLAN/INTERFACE:
//  - 乐观收尾:非终态目标即刻标 stopped(第三方不发 task_notification 也收敛),保留 taskManaged
//    供后续权威终态覆盖;终态目标(done/error/stopped)不被回翻。
//  - 扇出:按 sessionId 过滤 kind:'chat-process' && stoppable,只对属主会话的 slot 发
//    POST stop-task {toolUseId, sessionId},不碰别的会话/已结束/cli-session。
//  - 落空(批A A6):无一命中 → 落终态 + settledBy:'gone',不再回滚成"工作中"(僵尸卡根因)。
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

// 5) S1 落空:非终态目标,所有属主 pid 都返回 stopped:false(查无)→ 落终态,不回滚成"工作中"
//    【语义变更(批A A6)】原来断言的是"回滚为原 working"。落空的真实含义是服务端任务表里
//    已经没有这个 task —— 既不会再有权威 task_notification 来纠正,回滚就造出一张永远转圈
//    的僵尸卡(用户实报)。改为落终态 + settledBy:'gone'(成败未知,UI 显示中性"已结束")。
stopTaskStopped = false;
st().upsertAgent('tu-3', { sessionId: 'sid-A', status: 'working' });
const r3 = await st().stopSingleTask('sid-A', 'tu-3');
assert.equal(st().activeAgents['tu-3'].status, 'done', '无一命中 → 落终态(不回滚成 working 造僵尸卡)');
assert.equal(st().activeAgents['tu-3'].settledBy, 'gone', '标 settledBy:gone —— 成败未知,不冒充绿勾"完成"');
assert.equal(st().activeAgents['tu-3'].optimisticStop, false, '乐观标记清掉');
assert.ok(st().activeAgents['tu-3'].finishedAt > 0, '带 finishedAt,监控按已结束归桶');
assert.deepEqual({ stopped: r3.stopped, noOwner: r3.noOwner }, { stopped: false, noOwner: true },
  'noOwner 回给调用方(两处单卡停止按钮据此弹一次提示)');

// 6) S1 边界:回滚只在仍停于乐观 stopped 时发生——其间到达权威 done 不被回滚覆盖
stopTaskStopped = false;
st().upsertAgent('tu-4', { sessionId: 'sid-A', status: 'working' });
const p = st().stopSingleTask('sid-A', 'tu-4');   // 乐观已标 stopped
st().upsertAgent('tu-4', { status: 'done' });      // 模拟其间权威终态到达
await p;
assert.equal(st().activeAgents['tu-4'].status, 'done', '权威 done 到达后不被落空分支覆盖');

// 7) S1 边界:其间权威 stopped(status 与乐观值同形)到达 → 不被回滚。用显式 optimisticStop
//    标记区分"我们乐观写的 stopped"与"权威 stopped";权威终态到达时 finalizeAgent 清 optimisticStop
//    (此处模拟该清除),回滚够不着。
stopTaskStopped = false;
st().upsertAgent('tu-5', { sessionId: 'sid-A', status: 'working' });
const p2 = st().stopSingleTask('sid-A', 'tu-5');   // 乐观标 stopped + optimisticStop:true
st().upsertAgent('tu-5', { optimisticStop: false }); // 模拟权威 stopped 到达:finalizeAgent 清标记(status 仍 stopped)
await p2;
assert.equal(st().activeAgents['tu-5'].status, 'stopped', '权威 stopped(同形)到达后不被落空分支改写');
assert.equal(st().activeAgents['tu-5'].settledBy, undefined, '权威 stopped 不该被打上 settledBy');

// 8) 误诊文案(批A A6):落空的真实含义是"服务端任务表里没有这个 task",与 provider 无关
// (.jsx 不能被 node 直接 import,改源码守卫)
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const card = readFileSync(join(root, 'client', 'src', 'components', 'tools', 'TaskCard.jsx'), 'utf8');
  const fn = card.slice(card.indexOf('export function stopNoOwnerNotice'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/provider/i.test(body), '文案不得再把落空硬解释成 provider 问题(代码从没判过 provider)');
  assert.equal((body.match(/卡片已标记为已结束/g) || []).length, 2, '两个分支都要说明卡片已按结束处理');
  assert.ok(body.includes('主回合仍在进行'), '有进程时指路到主停止键');
  assert.ok(body.includes('本会话已无运行中的进程'), '无进程时直说没进程');
  // 落空写入点:必须落终态,不得再出现 prevStatus 回滚
  const store = readFileSync(join(root, 'client', 'src', 'stores', 'sessionStore.js'), 'utf8');
  assert.ok(/upsertAgent\(toolUseId, \{ status: 'done', settledBy: 'gone', finishedAt: Date\.now\(\), optimisticStop: false \}\)/.test(store),
    '落空必须落终态 + settledBy:gone');
  assert.ok(!/status: prevStatus, finishedAt: null/.test(store), '不得再回滚成原状态(僵尸卡根因)');
}

console.log('PASS check-stop-single-task');
