#!/usr/bin/env node
// 批A A4/A5 护栏:客户端按服务端广播的存活集剪僵尸卡 + 双键收终态 + task_started 补 sessionId。
// 回归对象:子代理跑完了卡片还在转圈(#3)、「停止后台 N」计数与服务端脱钩(#10)。
// 剪枝体是纯函数,这里真 import;接线点用源码守卫。
import assert from 'node:assert/strict';
import { pruneByLiveSet, LEVEL_PRUNE_MIN_AGE_MS } from '../../client/src/utils/levelPrune.js';

const SID = 'sess-A';
const ts = 1_000_000_000;
const started = ts - LEVEL_PRUNE_MIN_AGE_MS - 1; // 够老
const A = (patch) => ({ sessionId: SID, taskManaged: true, status: 'working', startedAt: started, ...patch });
const payload = (patch) => ({ sessionId: SID, taskIds: [], toolUseIds: [], settled: [], ts, ...patch });

// ① 不在活集且够老 → 收
{
  const ids = pruneByLiveSet({ toolu_1: A({}) }, payload());
  assert.deepEqual(ids, ['toolu_1'], '本会话 taskManaged 条目不在活集 → 剪');
}
// ② 在活集 → 不收(两把钥匙各测一次)
{
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({}) }, payload({ toolUseIds: ['toolu_1'] })), [],
    'toolUseIds 命中 → 不剪');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ taskId: 'tk1' }) }, payload({ taskIds: ['tk1'] })), [],
    'taskIds 命中(条目上钉的 taskId)→ 不剪');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ taskId: 'tk9' }) }, payload({ taskIds: ['tk1'] })), ['toolu_1'],
    'taskId 不在集里照剪');
}
// ③ 刚起的不剪(与服务端 grace 对称,防乱序误收)
{
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ startedAt: ts - LEVEL_PRUNE_MIN_AGE_MS }) }, payload()), [],
    '年龄 = 门槛 → 不剪(判据是严格小于)');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ startedAt: ts }) }, payload()), [], '刚起 → 不剪');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ startedAt: null }) }, payload()), [],
    'startedAt 缺失 → 判不出年龄,不剪');
}
// ④ 不受 level 管辖的条目一律不剪
{
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ taskManaged: false }) }, payload()), [],
    '非 taskManaged(没发过 task_started)不在 CLI 的 tasks 表里,剪它必然误收');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ hydrated: true }) }, payload()), [],
    'hydrated(翻历史现补的条目)不剪');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ workflow: true }) }, payload()), [],
    'workflow 内层不进 CLI 的 tasks 集,不剪');
}
// ⑤ 已终态 → 不收(幂等,不刷新 finishedAt)
{
  for (const status of ['done', 'error', 'stopped']) {
    assert.deepEqual(pruneByLiveSet({ toolu_1: A({ status }) }, payload()), [], `已是 ${status} 不重复收`);
  }
}
// ⑥ 别的会话 / 无归属 → 不收(分屏隔离)
{
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ sessionId: 'sess-B' }) }, payload()), [],
    '别的会话的条目绝不碰');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({ sessionId: null }) }, payload()), [],
    'sessionId 为空的条目保守不动');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({}) }, payload({ sessionId: null })), [],
    '广播没带 sessionId → 一条都不剪(宁可漏收不可误收)');
}
// 健壮性
{
  assert.deepEqual(pruneByLiveSet(null, payload()), [], '无 agents 不炸');
  assert.deepEqual(pruneByLiveSet({ x: null }, payload()), [], 'null 条目不炸');
  assert.deepEqual(pruneByLiveSet({ toolu_1: A({}) }, null), [], '无载荷不剪');
  // 多条混合:只挑该剪的
  const agents = {
    a: A({}), b: A({ taskId: 'tk-b' }), c: A({ status: 'done' }), d: A({ sessionId: 'other' }),
    e: A({ workflow: true }), f: A({}),
  };
  assert.deepEqual(pruneByLiveSet(agents, payload({ toolUseIds: ['f'] })), ['a', 'b'], '混合场景只剪该剪的');
}

// ── 源码守卫:接线点 ────────────────────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const app = readFileSync(join(root, 'client', 'src', 'App.jsx'), 'utf8');
  const ws = readFileSync(join(root, 'client', 'src', 'hooks', 'useWebSocket.js'), 'utf8');

  // A5:task_started 存在性分支必须同时补 taskManaged / taskId / sessionId,且 sessionId 保留既有值
  assert.ok(/_s0\.upsertAgent\(event\.tool_use_id, \{\s*taskManaged: true,\s*taskId: event\.task_id,\s*sessionId: _s0\.activeAgents\[event\.tool_use_id\]\.sessionId \|\| streamOwnerSid\(\),/.test(app),
    'task_started 存在性分支必须补 taskManaged + taskId + sessionId(已有 sessionId 不覆盖)');
  // 三处建条目的路径都要钉 taskId(local_agent / local_workflow / 存在性分支)
  assert.equal((app.match(/taskId: event\.task_id,/g) || []).length, 3,
    'task_started 的三处 upsertAgent 都必须钉 taskId(跨回合反查的唯一钥匙)');

  // A4:双键反查
  assert.ok(/function findAgentIdByTaskId\(st, taskId\)/.test(app), 'findAgentIdByTaskId 必须存在');
  assert.ok(/\|\| findAgentIdByTaskId\(_st, event\.task_id\)/.test(app),
    'task_updated 解析必须有第三条路(本流 map 跨回合即失效)');
  assert.ok(/const id = \(tool_use_id && st\.activeAgents\[tool_use_id\]\) \? tool_use_id : findAgentIdByTaskId\(st, task_id\);/.test(app),
    'WS 兜底必须放宽成 tool_use_id || task_id 双键');

  // A4:level 消费链路 WS → window 事件 → 剪枝
  assert.ok(/case 'background-tasks':/.test(ws), 'useWebSocket 必须转发 background-tasks');
  assert.ok(/new CustomEvent\('cgui:background-tasks', \{ detail: data \}\)/.test(ws), 'WS 必须派发 cgui:background-tasks');
  assert.ok(/window\.addEventListener\('cgui:background-tasks', onBackgroundTasks\)/.test(app), 'App 必须监听 cgui:background-tasks');
  assert.ok(/window\.removeEventListener\('cgui:background-tasks', onBackgroundTasks\)/.test(app), '监听必须配对移除');
  assert.ok(/pruneByLiveSet\(useStore\.getState\(\)\.activeAgents, d\)/.test(app), '剪枝必须走纯函数 pruneByLiveSet');
  // 剪枝出来的终态必须带 settledBy(成败未知),且【绝不】驱动流/进程动作
  const h = app.slice(app.indexOf('const settleByLevel ='));
  const body = h.slice(0, h.indexOf('const onSessionProcsKilled'));
  assert.ok(/if \(!a \|\| \['done', 'error', 'stopped'\]\.includes\(a\.status\)\) return;/.test(body),
    '已终态条目不得被 level 覆盖(可能是刚到的权威终态,盖上 settledBy 会把绿勾降级)');
  assert.ok(/st\.upsertAgent\(id, \{ settledBy: 'level' \}\);\s*\n\s*finalizeAgent\(st, id, 'completed'\);/.test(body),
    '先标 settledBy 再走 finalizeAgent(拿到级联收尾 + 悬空 toolCall 合成结果)');
  assert.ok(!/finalizeAgent\(st, id, 'completed', undefined, true\)/.test(body),
    'level 收尾不得声明 authoritative —— 它是推断不是权威');
  assert.equal((body.match(/settledBy: 'level'/g) || []).length, 1, 'settled 与剪枝两条路共用同一个收尾函数');
  for (const forbidden of ['abort(', 'fetch(', '/stop', 'finalizeSessionAgents', 'updateStreaming']) {
    assert.ok(!body.includes(forbidden), `level 消费不得触碰 ${forbidden} —— 它只做 UI 收敛`);
  }

  // settledBy 的终态必须可被权威事件覆盖:A0 实测 level 信号恒【早于】权威终态 <1ms 到达,
  // 不可覆盖就等于每个任务的真实状态都被"猜的 done"吞掉。
  assert.ok(/const canOverride = !!authoritative\s*&& \(!!ag\.settledBy \|\| \(ag\.status === 'stopped' && \(!!ag\.taskManaged \|\| !!ag\.optimisticStop\)\)\);/.test(app),
    'canOverride 必须放行 settledBy 条目');
  assert.ok(/const patch = ag\.settledBy \? \{ settledBy: null \} : \{\};/.test(app),
    '权威覆盖时必须清 settledBy(哪怕 status 同值,否则卡片一直显示中性"已结束")');

  // local_bash 不建 agent 条目 → level 剪枝天然碰不到后台 shell 卡
  assert.ok(/else if \(event\.task_type === 'local_agent'\)/.test(app),
    'task_started 建条目仍只对 local_agent(local_bash 建条目会在监控里冒出假子代理卡)');

  // TaskCard:settledBy 不给绿勾
  const card = readFileSync(join(root, 'client', 'src', 'components', 'tools', 'TaskCard.jsx'), 'utf8');
  assert.ok(/const isSettledUnknown = isDone && !isError && !isStopped && !!agent\?\.settledBy;/.test(card),
    'TaskCard 必须区分"对账猜出来的结束"');
  assert.ok(/isSettledUnknown \? \([\s\S]{0,200}aria-label="子代理已结束"/.test(card),
    'settledBy 条目显示中性"已结束",不冒充绿勾"完成"');
}

console.log('✓ check-level-prune: 剪枝 6 组 + 混合场景 + 接线源码守卫 全过');
