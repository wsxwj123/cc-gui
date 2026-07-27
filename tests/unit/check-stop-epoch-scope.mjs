#!/usr/bin/env node
// A1(D1)/A2(D2) 回归护栏:主停止键的停止范围按【回合世代】过滤。
// 回归对象:打断当前回合(主停止键 / Esc / ⚡引导)时,上一回合派出、仍在后台跑的子代理
// (深度调研等)被连带 stopTask + 被 abort 杀整个 CLI 进程连坐死,不可恢复。原生 Esc 只停
// 当前回合;GUI 自己另有「停止后台 N」总闸,那条入口才该全量停(allTasks:true)。
// 直接 import chat.js 的真函数(非复刻):去掉过滤条件时下面的断言必须失败。
import assert from 'node:assert/strict';
import { partitionStopTasks, shouldSuppressAbort } from '../../server/routes/chat.js';

const T = (kind, epoch) => ({ kind, epoch, createdAt: Date.now() });

// ── partitionStopTasks:主停止只停本回合 ─────────────────────────
{
  // 当前回合 epoch=3:本回合子代理 + 上一回合仍活着的后台子代理 + 后台 shell
  const live = new Map([
    ['t-now', T('subagent', 3)],
    ['t-prev', T('subagent', 2)],
    ['t-shell', T('shell', 3)],
    ['t-shell-prev', T('shell', 1)],
  ]);

  const sel = partitionStopTasks(live, 3, false);
  assert.deepEqual(sel.stoppableTasks, ['t-now'], '主停止只对本回合的非 shell 任务发 stopTask');
  assert.deepEqual(sel.keptTasks, ['t-prev'], '跨回合后台子代理保留,不发 stopTask');
  assert.deepEqual(sel.shellTasks, ['t-shell', 't-shell-prev'], 'shell 不分世代,一律保留');

  // 总闸:全量语义不变(改动前行为)
  const all = partitionStopTasks(live, 3, true);
  assert.deepEqual(all.stoppableTasks, ['t-now', 't-prev'], '总闸 allTasks:true → 全部非 shell 任务都停');
  assert.deepEqual(all.keptTasks, [], '总闸下无"保留"分组');
  assert.deepEqual(all.shellTasks, ['t-shell', 't-shell-prev'], '总闸仍不碰 shell');
}

// keptTasks 的口径:必须是条目的 toolUseId(前端 visited 以 tool_use_id 为键),不是 map key
// (task_id)。真机实测过的 bug:推 tid → 响应 ["ab72f652f9155179b"] 而真实键是
// "toolu_01Qqs59U6sA6jFn9WudBPKR" → 排除永不命中。构造 toolUseId ≠ key 才能钉住。
{
  // createdAt 必带:保留分组还要求条目新鲜(见下面的陈旧条目用例),这里测的是 id 口径。
  const at = Date.now();
  const live = new Map([
    ['task_now', { kind: 'subagent', epoch: 3, toolUseId: 'toolu_NOW', createdAt: at }],
    ['task_prev', { kind: 'subagent', epoch: 2, toolUseId: 'toolu_PREV', createdAt: at }],
    ['task_prev2', { kind: 'subagent', epoch: 1, toolUseId: 'toolu_PREV2', createdAt: at }],
    ['task_shell', { kind: 'shell', epoch: 1, toolUseId: 'toolu_SHELL', createdAt: at }],
  ]);
  const r = partitionStopTasks(live, 3, false);
  assert.deepEqual(r.keptTasks, ['toolu_PREV', 'toolu_PREV2'],
    'keptTasks 必须收条目的 toolUseId(回给前端当 keptToolUseIds),不能是 map key/task_id');
  // 另两组仍是 map key —— stopTask(tid) 扇出靠它,改了就把停止弄坏
  assert.deepEqual(r.stoppableTasks, ['task_now'], 'stoppableTasks 仍是 task_id(stopTask 扇出用)');
  assert.deepEqual(r.shellTasks, ['task_shell'], 'shellTasks 仍是 task_id');
  // toolUseId 缺失(旧条目/第三方 provider)回落 tid,不能变成 null/undefined 污染数组
  const r2 = partitionStopTasks(new Map([['task_x', { kind: 'subagent', epoch: 1, toolUseId: null, createdAt: at }]]), 3, false);
  assert.deepEqual(r2.keptTasks, ['task_x'], 'toolUseId 缺失时回落 task_id,不得推入 null');
}

// 缺字段/空条目(第三方 provider 不发 task_type/epoch)保持旧行为:归入可停,防停止失效
{
  const live = new Map([['t-null', null], ['t-nofield', {}]]);
  const r = partitionStopTasks(live, 5, false);
  assert.deepEqual(r.stoppableTasks, ['t-null', 't-nofield'], '空条目/无 kind 一律可停(旧行为)');
  assert.deepEqual(r.keptTasks, [], '空条目不进保留组(否则停止会静默失效)');
}

// epoch 0 / undefined 归一化:`|0` 口径与 chat.js 内部一致
{
  const live = new Map([['t-a', { kind: 'subagent' }], ['t-b', T('subagent', 0)]]);
  const r = partitionStopTasks(live, 0, false);
  assert.deepEqual(r.stoppableTasks, ['t-a', 't-b'], 'epoch 0 == turnEpoch 0 → 本回合;缺 epoch 的条目同样可停');
  assert.deepEqual(r.keptTasks, [], 'epoch 缺失的条目按旧行为可停,不被误留');
}

// 陈旧条目(某子代理终态通知丢失 → 条目永远留在 liveTasks)不得进 keptTasks:
// 进了会让 idle 分支认为"无可停对象"直接 no-op、活跃分支的 abort 兜底被 shouldSuppressAbort
// 永久抑制 = 停止彻底失效。判据 = 年龄 < LIVE_TASK_FRESH_MS(30min),与看门狗/idleReclaim 同款。
{
  const now = Date.now();
  const FRESH = 30 * 60 * 1000;
  const live = new Map([
    ['t-fresh', { kind: 'subagent', epoch: 2, toolUseId: 'toolu_FRESH', createdAt: now - 60_000 }],
    ['t-stale', { kind: 'subagent', epoch: 2, toolUseId: 'toolu_STALE', createdAt: now - FRESH - 1 }],
    ['t-noat', { kind: 'subagent', epoch: 2, toolUseId: 'toolu_NOAT' }], // createdAt 缺失 → 按陈旧处理
  ]);
  const r = partitionStopTasks(live, 3, false, now);
  assert.deepEqual(r.keptTasks, ['toolu_FRESH'], '只有新鲜的跨回合后台子代理才保留');
  assert.deepEqual(r.stoppableTasks, ['t-stale', 't-noat'],
    '陈旧 / 无 createdAt 的跨回合条目归可停(宁可多停,不让停止静默失效)');
  // 边界:年龄正好等于窗长算陈旧(与 chat.js 的 `<` 判据逐字一致)
  const edge = new Map([['t-edge', { kind: 'subagent', epoch: 2, createdAt: now - FRESH }]]);
  assert.deepEqual(partitionStopTasks(edge, 3, false, now).stoppableTasks, ['t-edge'], '年龄 = 窗长算陈旧');
  // 总闸语义不受新鲜度影响
  assert.deepEqual(partitionStopTasks(live, 3, true, now).keptTasks, [], '总闸 allTasks 下仍无保留组');
  // now 缺省 = Date.now():新鲜的跨回合任务照常保留(默认参数不能把保留机制废掉)
  assert.deepEqual(
    partitionStopTasks(new Map([['t-live', { kind: 'subagent', epoch: 2, createdAt: Date.now() }]]), 3, false).keptTasks,
    ['t-live'], 'now 缺省时新鲜跨回合任务仍保留');
}

// 无 liveTasks(未起过任务)不炸
{
  const r = partitionStopTasks(null, 1, false);
  assert.deepEqual([r.shellTasks, r.stoppableTasks, r.keptTasks], [[], [], []]);
}

// ── shouldSuppressAbort(A2):优雅窗超时后的 abort 抑制 ─────────
{
  // 原有:活 shell 一律抑制(abort 杀整个 CLI 进程 → 训练等长任务连坐)
  assert.equal(shouldSuppressAbort({ liveShell: 1 }), true, '活 shell 抑制 abort(原有语义)');
  assert.equal(shouldSuppressAbort({ liveShell: 1, allTasks: true }), true, '总闸下 shell 仍抑制(原有语义)');
  // A2 新增:跨回合后台子代理同样抑制,否则 A1 保留下来的任务被 abort 绕道杀掉
  assert.equal(shouldSuppressAbort({ liveCrossEpoch: 1 }), true, '跨回合后台子代理抑制 abort(A2)');
  // 总闸例外:用户点名停全部后台 → 该 abort 还得 abort
  assert.equal(shouldSuppressAbort({ liveCrossEpoch: 1, allTasks: true }), false, '总闸 allTasks 下不因跨回合任务抑制');
  // 干净场景照旧 abort(停止不能形同虚设)
  assert.equal(shouldSuppressAbort({}), false, '无 shell 无跨回合任务 → 照常 abort 兜底');
  assert.equal(shouldSuppressAbort(), false, '无参调用不炸,默认不抑制');
}

// ── 源码守卫:修复点不得被改回去 ────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'chat.js'),
    'utf8',
  );
  const stopRoute = src.slice(src.indexOf("router.post('/chat/:pid/stop'"), src.indexOf("router.post('/chat/:pid/stop-task'"));
  assert.ok(/partitionStopTasks\(slot\.liveTasks, slot\.turnEpoch, allTasks\)/.test(stopRoute),
    '/stop 必须用 partitionStopTasks 分组(带 turnEpoch)');
  assert.ok(/allTasks = req\.body\?\.allTasks === true/.test(stopRoute),
    'allTasks 只认显式 true(默认=只停本回合)');
  assert.ok(/shouldSuppressAbort\(\{ liveShell, liveCrossEpoch, allTasks \}\)/.test(stopRoute),
    '选择性路径的 abort 抑制必须走 shouldSuppressAbort(带 liveCrossEpoch)');
  // 停止链路核心时序不得被动:interrupt 不 await、优雅窗 3000/2000、abort+input.close 兜底
  assert.ok(/slot\.query\?\.interrupt\?\.\(\)\?\.catch\?\.\(\(\) => \{\}\)/.test(stopRoute), 'interrupt 必须 fire-and-forget');
  assert.ok((stopRoute.match(/hadTasks \? 3000 : 2000/g) || []).length === 2, 'hard/选择性两条优雅窗时长不得改');
  // 保留项必须回给客户端:选择性路径带 kept 的三处响应都要带 keptToolUseIds,否则前端停止
  // 收尾会把服务端刚保留的跨回合后台子代理也乐观标 stopped(进程活着却显示已停止)。
  assert.equal((stopRoute.match(/kept: keptCount, keptToolUseIds: keptTasks/g) || []).length, 3,
    '选择性 /stop 的三处 kept 响应必须回 keptToolUseIds');
  // keptTasks 的元素口径守卫:必须 push toolUseId(回落 tid),不得改回裸 push(tid)
  assert.ok(/keptTasks\.push\(t\.toolUseId \|\| tid\)/.test(src),
    'keptTasks 必须收 t.toolUseId(缺失回落 tid),推裸 tid 会让前端排除永不命中');
  // 陈旧过滤(S2):两处判据都不得被去掉,否则通知丢失的残留条目会让停止静默失效
  assert.ok(/now - \(t\.createdAt \|\| 0\) < LIVE_TASK_FRESH_MS/.test(src),
    'partitionStopTasks 的保留判据必须带新鲜度过滤');
  assert.ok(/Date\.now\(\) - \(t\.createdAt \|\| 0\) < LIVE_TASK_FRESH_MS\) liveCrossEpoch\+\+/.test(stopRoute),
    'liveCrossEpoch 计数必须带新鲜度过滤(否则 abort 兜底被陈旧条目永久抑制)');

  // 客户端:停止收尾必须排除这些 id(预置 visited 同时跳过顶层扫描与级联),两条收尾路径都接。
  const app = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src', 'App.jsx'),
    'utf8',
  );
  assert.ok(/function finalizeSessionAgents\(sessionId, tnStatus = 'stopped', excludeIds\)/.test(app),
    'finalizeSessionAgents 必须接受 excludeIds');
  assert.ok(/const visited = new Set\(Array\.isArray\(excludeIds\) \? excludeIds : \[\]\);/.test(app),
    'excludeIds 必须预置进 visited(顶层+级联同时跳过)');
  assert.equal((app.match(/finalizeSessionAgents\([^)]*'stopped', d\?\.keptToolUseIds\)/g) || []).length, 2,
    '流内 finally 与 backgroundPid 两条停止收尾都必须传 keptToolUseIds');
}

console.log('✓ check-stop-epoch-scope: 分组 4 组 + abort 抑制 6 断言 + 源码守卫 全过');
