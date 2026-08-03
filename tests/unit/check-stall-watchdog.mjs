#!/usr/bin/env node
// 批A A3 护栏:5 分钟静默看门狗的"还有任务在跑"判据必须带年龄上限。
// 回归对象(用户实报 `Writing ..65m 36s`):本回合派出的子代理丢一条终态通知 →
// liveTasks 永久留一条本 epoch 活条目 → busyNonShell 恒 true → 看门狗永不触发 →
// done 永不发 → isStreaming 永久 true,输入框永久卡"停止"。这是唯一能把状态机
// 真正卡死的路径(其余"卡住"多是主回合确实还没结束,显示是对的)。
// 直接 import chat.js 的真函数(非复刻)。
import assert from 'node:assert/strict';
import { hasFreshNonShellTask, reconcileLiveTasks } from '../../server/routes/chat.js';

const FRESH = 30 * 60 * 1000;
const now = 1_000_000_000;
const old = (ms) => now - ms;

{
  // ① 本回合(epoch 相同)但 40 分钟前建的条目 → 不再算忙
  //    【修前此处为 true】:旧判据 `t.epoch === turnEpoch || 年龄 < FRESH` 的 epoch 支
  //    没有年龄上限,本 epoch 条目无限期豁免 → 看门狗永不触发。
  assert.equal(hasFreshNonShellTask(new Map([['t', { kind: 'subagent', epoch: 3, createdAt: old(40 * 60 * 1000) }]]), now, FRESH),
    false, '本回合但陈旧的条目不再解除看门狗');
  // ② 本回合且新鲜 → 算忙,看门狗不动它(真在跑的子代理不能被误杀)
  assert.equal(hasFreshNonShellTask(new Map([['t', { kind: 'subagent', epoch: 3, createdAt: old(60_000) }]]), now, FRESH),
    true, '新鲜的非 shell 任务仍算忙');
  // ③ shell 永不计入(后台 bash 不阻塞主控,原语义)
  assert.equal(hasFreshNonShellTask(new Map([['t', { kind: 'shell', epoch: 3, createdAt: now }]]), now, FRESH),
    false, 'shell 条目不计入 busyNonShell');
  // ④ 跨回合但新鲜的 teammate 仍算忙(两支合并不得把它误杀 —— abort 会连坐杀宿主进程)
  assert.equal(hasFreshNonShellTask(new Map([['t', { kind: 'subagent', epoch: 1, createdAt: old(60_000) }]]), now, FRESH),
    true, '跨回合但新鲜的后台子代理仍算忙');
  // ⑤ 边界与健壮性
  assert.equal(hasFreshNonShellTask(new Map([['t', { kind: 'subagent', createdAt: old(FRESH) }]]), now, FRESH),
    false, '年龄 = 窗长算陈旧(与 `<` 判据逐字一致,同 partitionStopTasks/idleReclaim)');
  assert.equal(hasFreshNonShellTask(new Map([['t', null]]), now, FRESH), false, 'null 条目不算忙');
  assert.equal(hasFreshNonShellTask(new Map(), now, FRESH), false, '空表不算忙');
  assert.equal(hasFreshNonShellTask(null, now, FRESH), false, '无 liveTasks 不炸');
  assert.equal(hasFreshNonShellTask(new Map([['t', { kind: 'subagent', createdAt: Date.now() }]])), true,
    'now/freshMs 缺省 = Date.now()/30min,默认参数不能把判据废掉');
}

{
  // A3 敢做的前提(方案 B-9):level 信号在任何成员变化时确认真活任务并刷新 createdAt,
  // 所以"真活 30 分钟"的长任务不会因为合并两支而被看门狗误杀。
  const live = new Map([['t', { kind: 'subagent', epoch: 3, createdAt: old(40 * 60 * 1000) }]]);
  assert.equal(hasFreshNonShellTask(live, now, FRESH), false, '前置:陈旧条目本来不算忙');
  reconcileLiveTasks(live, [{ task_id: 't', task_type: 'local_agent' }], now, 1500);
  assert.equal(hasFreshNonShellTask(live, now, FRESH), true,
    'level 信号确认仍活 → createdAt 刷新 → 真在跑的长任务重新算忙,看门狗不碰它');
}

// ── 源码守卫:判据不得被改回去 ──────────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/const busyNonShell = hasFreshNonShellTask\(slot\.liveTasks, now, LIVE_TASK_FRESH_MS\)/.test(src),
    '看门狗判据必须走 hasFreshNonShellTask(带年龄上限)');
  assert.ok(!/t\.epoch === \(slot\.turnEpoch \| 0\) \|\| now - \(t\.createdAt \|\| 0\) < LIVE_TASK_FRESH_MS/.test(src),
    '不得再出现"epoch 支无年龄上限"的旧判据');
  assert.equal(src.match(/const LIVE_TASK_FRESH_MS = 30 \* 60 \* 1000;/g)?.length, 1,
    'LIVE_TASK_FRESH_MS 保持 30 分钟 —— A3 不得趁机调小,那会成倍放大误杀真长任务的概率');
  // 看门狗触发条件的其余部分(idle / turnSubagentSeen / revived)未动
  assert.ok(/if \(!slot\.idle && \(slot\.turnSubagentSeen \|\| slot\.revived\) && !busyNonShell\)/.test(src),
    '看门狗触发条件的其余三项不得被顺手改掉');
  assert.ok(/const STALL_MS = 300_000;/.test(src), '静默阈值 300s 不得改');
}

console.log('✓ check-stall-watchdog: 年龄上限 9 断言 + level 续命 + 源码守卫 全过');
