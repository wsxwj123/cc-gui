#!/usr/bin/env node
// 批A A1/A2 护栏:服务端按 CLI 的 level 信号对账在飞任务集 + task_updated 终态翻译 toolUseId。
// 回归对象:边沿事件(task_started/task_notification/task_updated)丢一条,liveTasks 就永久
// 残留"在飞"条目 → 卡片永久转圈、看门狗被解除。level 信号是官方给的全量存活集快照。
// 直接 import chat.js 的真函数(非复刻):判据被改回去时下面的断言必须失败。
//
// A0 真机实样(2026-08-03 / CLI 2.1.220 / headless `claude -p --output-format stream-json`):
//   {"type":"system","subtype":"background_tasks_changed",
//    "tasks":[{"task_id":"bqmaziuib","task_type":"local_bash","description":"…"}],
//    "uuid":"…","session_id":"…"}
// 实测要点(本文件的用例据此设计):
//   1. headless 下确实发,无 env 门控;顶层无 task_id,故必须走独立分支。
//   2. task_type 观测到两种:local_bash(Bash run_in_background)、local_agent(Task 子代理)。
//      前台 Task 子代理【也在集内】(二进制过滤器只排 isBackgrounded===false)。
//   3. 该信号恒在对应边沿事件之前 <1ms 发出:起任务时先于 task_started,结束时先于
//      task_updated/task_notification。所以"补建"是常态路径,补建条目会被随后的
//      task_started 覆盖(那条有 bgBashToolIds 双保险,kind 更准)。
//   4. 空集恒对应任务真结束:sleep 300 一直在集内,直到进程退出被 killed 才出集 ——
//      它不随回合边界抖动,可以放心当存活集用。
import assert from 'node:assert/strict';
import { reconcileLiveTasks, taskUpdatedTerminal, partitionStopTasks } from '../../server/routes/chat.js';

const GRACE = 1500;
const now = 1_000_000_000;
const old = (ms) => now - ms;

// ── A1 reconcileLiveTasks:REPLACE 存活集 ──────────────────────────
{
  // ① 不在存活集且够老 → 剪掉并带出 toolUseId 供 UI 收终态
  const live = new Map([
    ['t-gone', { toolUseId: 'toolu_GONE', kind: 'subagent', epoch: 1, createdAt: old(60_000) }],
    ['t-alive', { toolUseId: 'toolu_ALIVE', kind: 'subagent', epoch: 1, createdAt: old(60_000) }],
  ]);
  const r = reconcileLiveTasks(live, [{ task_id: 't-alive', task_type: 'local_agent' }], now, GRACE);
  assert.deepEqual(r.settled, [{ taskId: 't-gone', toolUseId: 'toolu_GONE' }], '不在存活集的条目被剪并带 toolUseId');
  assert.deepEqual([...live.keys()], ['t-alive'], '被剪的条目真的从 liveTasks 删掉');
  assert.equal(live.get('t-alive').createdAt, now, '仍在集内 = 权威确认还活着 → 刷新新鲜度');
  assert.deepEqual(r.liveIds, ['t-alive'], 'liveIds 是 payload 的 task_id 集');
}
{
  // ② 年龄 < grace → 不剪(防事件乱序把刚起的任务剪掉)
  const live = new Map([['t-new', { toolUseId: 'toolu_NEW', kind: 'subagent', createdAt: old(GRACE - 1) }]]);
  const r = reconcileLiveTasks(live, [], now, GRACE);
  assert.deepEqual(r.settled, [], 'grace 窗内的条目不剪');
  assert.equal(live.size, 1, 'grace 窗内条目留在 liveTasks');
  // 边界:年龄正好等于 grace 就可以剪(与 `<` 判据逐字一致)
  live.get('t-new').createdAt = old(GRACE);
  assert.equal(reconcileLiveTasks(live, [], now, GRACE).settled.length, 1, '年龄 = grace 即可剪');
}
{
  // ③ payload 里的新 task_id → 补建,kind 严格按 task_type;epoch 取调用点传入的回合世代
  //    【turnEpoch 必须用非 0】(审查 R2):原用例传 0,恰好与写死的 epoch:0 相等而掩盖了偏差。
  const TURN = 3;
  const live = new Map();
  const r = reconcileLiveTasks(live, [
    { task_id: 't-bash', task_type: 'local_bash' },
    { task_id: 't-agent', task_type: 'local_agent' },
    { task_id: 't-weird', task_type: 'something_else' },
    { task_id: 't-nokind' },
  ], now, GRACE, TURN);
  assert.deepEqual(r.added, ['t-bash', 't-agent', 't-weird', 't-nokind'], '没见过的 task_id 全部补建');
  assert.equal(live.get('t-bash').kind, 'shell', 'local_bash → shell(错分类会让选择性停止杀掉后台训练任务)');
  assert.equal(live.get('t-agent').kind, 'subagent', 'local_agent → subagent');
  assert.equal(live.get('t-weird').kind, 'unknown', '未知 task_type → unknown(按可停处理,不让停止静默失效)');
  assert.equal(live.get('t-nokind').kind, 'unknown', '缺 task_type → unknown');
  assert.equal(live.get('t-bash').toolUseId, null, '补建条目没有 tool_use_id(level 载荷不带)');
  assert.equal(live.get('t-agent').epoch, TURN, '补建条目的 epoch = 当前回合世代,不得写死 0');

  const part = partitionStopTasks(live, TURN, false, now);
  // R2:补建的非 shell 条目必须归【可停】。写死 epoch:0 时它会被当成跨回合任务归进 keptTasks,
  // 于是选择性停止不发 stopTask,liveCrossEpoch>0 还经 shouldSuppressAbort 抑制 abort 兜底 ——
  // CLI 挂死时停止就失去硬兜底(bookend 被驱逐、task_started 真丢失时的实打实场景)。
  assert.deepEqual(part.keptTasks, [], '本回合补建的条目不得被当成跨回合任务保留(R2)');
  assert.ok(part.stoppableTasks.includes('t-agent'), 'level 补建的子代理条目必须可停');
  // 补建的 shell 条目仍必须被认成 shell(否则总闸会把用户的后台 bash 一起杀)
  assert.ok(part.shellTasks.includes('t-bash'), 'level 补建的 local_bash 条目必须进 shellTasks');
  assert.ok(!part.stoppableTasks.includes('t-bash'), 'level 补建的 shell 绝不能进可停组');
  // epoch 缺省仍是 0(既有调用点位置语义不变)
  const live2 = new Map();
  reconcileLiveTasks(live2, [{ task_id: 'x', task_type: 'local_agent' }], now, GRACE);
  assert.equal(live2.get('x').epoch, 0, 'epoch 参数缺省为 0(排在最后,不动既有调用点)');
}
{
  // ④ 已有条目的 kind 绝不被 payload 覆盖(task_started 的 kind 判据带 bgBashToolIds 双保险,更准)
  const live = new Map([['t-x', { toolUseId: 'toolu_X', kind: 'shell', epoch: 7, createdAt: old(60_000) }]]);
  const r = reconcileLiveTasks(live, [{ task_id: 't-x', task_type: 'local_agent' }], now, GRACE);
  assert.equal(live.get('t-x').kind, 'shell', '已有条目的 kind 不被 payload 改写');
  assert.equal(live.get('t-x').epoch, 7, '已有条目的 epoch 保持(优雅窗判据靠它)');
  assert.equal(live.get('t-x').toolUseId, 'toolu_X', '已有条目的 toolUseId 保持');
  assert.equal(live.get('t-x').createdAt, now, '仍在集内 → createdAt 被刷新');
  assert.deepEqual(r.added, [], '已有条目不算新增');
}
{
  // ⑤ 空 payload → 全剪(grace 内的除外)
  const live = new Map([
    ['t-a', { toolUseId: 'toolu_A', kind: 'subagent', createdAt: old(60_000) }],
    ['t-b', { toolUseId: null, kind: 'shell', createdAt: old(60_000) }],
    ['t-young', { toolUseId: 'toolu_Y', kind: 'subagent', createdAt: now }],
  ]);
  const r = reconcileLiveTasks(live, [], now, GRACE);
  assert.deepEqual(r.settled.map((s) => s.taskId), ['t-a', 't-b'], '空 payload 剪掉所有够老的条目');
  assert.deepEqual(r.settled.map((s) => s.toolUseId), ['toolu_A', null], 'toolUseId 缺失时给 null(广播端自己过滤)');
  assert.deepEqual([...live.keys()], ['t-young'], 'grace 内的条目幸存');
}
{
  // 健壮性:空条目 / 非数组 payload / 无 liveTasks 都不炸
  const live = new Map([['t-null', null]]);
  assert.equal(reconcileLiveTasks(live, [], now, GRACE).settled.length, 1, 'null 条目按无 createdAt 处理,可剪');
  assert.deepEqual(reconcileLiveTasks(new Map(), null, now, GRACE), { settled: [], added: [], liveIds: [] });
  assert.doesNotThrow(() => reconcileLiveTasks(null, [{ task_id: 'x' }], now, GRACE), 'liveTasks 为空不抛');
}

// ── A2 taskUpdatedTerminal:删除前翻译 toolUseId ────────────────────
// task_updated 的类型里没有 tool_use_id(sdk.d.ts:4142-4159),客户端只能靠每条流的
// 局部 map 反查 —— 跨回合/reattach/刷新后那个 map 是空的,于是服务端已删、客户端永不
// 收尾(僵尸"工作中"卡的结构性成因)。映射只有服务端有,必须由服务端翻译后广播。
{
  const mk = () => new Map([['t1', { toolUseId: 'toolu_1', kind: 'subagent', createdAt: now }]]);
  for (const [status, expect] of [['completed', 'completed'], ['failed', 'failed'], ['killed', 'stopped']]) {
    const live = mk();
    const r = taskUpdatedTerminal(live, { task_id: 't1', patch: { status } });
    assert.equal(r.deleted, true, `${status} 是终态 → 删除条目`);
    assert.deepEqual(r.notify, { tool_use_id: 'toolu_1', task_id: 't1', status: expect },
      `${status} → 广播 ${expect}(killed 映射成 stopped,与 SSE 路径同口径)`);
    assert.equal(live.size, 0, '终态后条目必须删掉');
  }
  // 非终态(进度汇报)不删不广播 —— 调用方据此刷新 createdAt
  const live = mk();
  const r = taskUpdatedTerminal(live, { task_id: 't1', patch: { status: 'running' } });
  assert.deepEqual(r, { deleted: false, notify: null }, '非终态 patch 不删不广播');
  assert.equal(live.size, 1, '非终态条目留着');
  // 没有 toolUseId(第三方 provider / 只从 level 信号补建的条目)→ 删但不广播,不能广播 null
  const live2 = new Map([['t2', { toolUseId: null, kind: 'subagent', createdAt: now }]]);
  const r2 = taskUpdatedTerminal(live2, { task_id: 't2', patch: { status: 'completed' } });
  assert.deepEqual(r2, { deleted: true, notify: null }, '无 toolUseId 时 notify 为 null(不广播空键)');
  // 条目根本不在表里(重复到达 / 已被 level 信号先剪掉)→ 幂等,不抛
  assert.deepEqual(taskUpdatedTerminal(new Map(), { task_id: 'nope', patch: { status: 'completed' } }),
    { deleted: true, notify: null }, '不存在的 task_id 幂等');
  assert.deepEqual(taskUpdatedTerminal(new Map(), {}), { deleted: false, notify: null }, '缺 patch 不炸');
}

// ── A0 真机实样固定件:载荷契约不得漂移 ─────────────────────────────
// tests/fixtures/background-tasks-changed.sample.jsonl 是 A0 探测原样抓取的三条(未改一字)。
// CLI 换版本后若字段变形,这里先炸,而不是等真机上任务卡片乱收尾才发现。
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const lines = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures',
    'background-tasks-changed.sample.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3, '固定件三条:local_bash / local_agent / 空集');
  for (const ev of lines) {
    assert.equal(ev.type, 'system');
    assert.equal(ev.subtype, 'background_tasks_changed');
    assert.equal(ev.task_id, undefined, '顶层无 task_id —— 泵里必须走独立分支才收得到');
    assert.ok(Array.isArray(ev.tasks));
    for (const t of ev.tasks) assert.deepEqual(Object.keys(t).sort(), ['description', 'task_id', 'task_type']);
  }
  assert.deepEqual(lines.map((e) => e.tasks[0]?.task_type), ['local_bash', 'local_agent', undefined]);
  // 真载荷喂进对账体:local_bash 判 shell、local_agent 判 subagent、空集把够老的条目剪光
  const live = new Map();
  reconcileLiveTasks(live, lines[0].tasks, now, GRACE);
  reconcileLiveTasks(live, [...lines[0].tasks, ...lines[1].tasks], now, GRACE);
  assert.deepEqual([...live.values()].map((t) => t.kind), ['shell', 'subagent'], '真实载荷的 kind 映射');
  const r = reconcileLiveTasks(live, lines[2].tasks, now + GRACE, GRACE);
  assert.equal(r.settled.length, 2, '空集载荷把两条都剪掉');
  assert.equal(live.size, 0);
}

// ── 源码守卫:接线点不得被改回去 ────────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/else if \(m\.type === 'system' && m\.subtype === 'background_tasks_changed' && Array\.isArray\(m\.tasks\)\)/.test(src),
    'level 信号必须有独立分支(它没有顶层 task_id,进不了 task_id 那个 if)');
  assert.ok(/reconcileLiveTasks\(\s*\n?\s*slot\.liveTasks, m\.tasks, Date\.now\(\), LEVEL_GRACE_MS, slot\.turnEpoch \| 0\)/.test(src),
    '泵里必须调 reconcileLiveTasks 且【透传 turnEpoch】(R2:写死 0 会让补建条目逃过选择性停止)');
  assert.ok(/const LEVEL_GRACE_MS = 1500;/.test(src), 'level 对账的 grace 窗常量必须在');
  // A2 广播:无条件发(SSE 在线时客户端也解不出 tool_use_id,正是本 bug 的核心)
  assert.ok(/const \{ deleted, notify \} = taskUpdatedTerminal\(slot\.liveTasks, m\);/.test(src),
    'task_updated 必须走 taskUpdatedTerminal(删除前取 toolUseId)');
  assert.ok(/broadcast\(\{ type: 'task-notification-bg', sessionId: slot\.sessionId \|\| null, \.\.\.notify \}\)/.test(src),
    'task_updated 终态必须经 task-notification-bg 广播收尾');
  // level 信号只喂簿记与广播,绝不驱动停止链路
  const lvl = src.slice(src.indexOf("m.subtype === 'background_tasks_changed'"));
  const branch = lvl.slice(0, lvl.indexOf('deliverLine(slot, line);'));
  for (const forbidden of ['finalize(', 'abort(', 'input.close(', 'stopTask(']) {
    assert.ok(!branch.includes(forbidden), `level 分支不得调用 ${forbidden} —— 它只喂簿记与 UI`);
  }
}

console.log('✓ check-level-reconcile: A1 对账 6 组 + A2 终态翻译 + A0 实样固定件 + 源码守卫 全过');
