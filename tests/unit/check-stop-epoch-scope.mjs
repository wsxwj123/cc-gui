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
}

console.log('✓ check-stop-epoch-scope: 分组 4 组 + abort 抑制 6 断言 + 源码守卫 全过');
