#!/usr/bin/env node
// 批A A3 护栏:5 分钟静默看门狗的"还有任务在跑"判据必须带年龄上限。
// 回归对象(用户实报 `Writing ..65m 36s`):本回合派出的子代理丢一条终态通知 →
// liveTasks 永久留一条本 epoch 活条目 → busyNonShell 恒 true → 看门狗永不触发 →
// done 永不发 → isStreaming 永久 true,输入框永久卡"停止"。这是唯一能把状态机
// 真正卡死的路径(其余"卡住"多是主回合确实还没结束,显示是对的)。
// r151h 前提变化:CLI 新版后台工作 pending 时会话不空闲、可长时间无输出,旧前提
// "shell 永不计入看门狗忙判据"已不成立。hasFreshNonShellTask 仍只统计非 shell(语义
// 不变,供其它判据用);看门狗改用 busyLive = busyNonShell || hasFreshShellTask(新鲜 shell
// 算忙,陈旧 shell 仍不算 —— 防终态通知丢失的残留永久解除看门狗)。
// 直接 import chat.js 的真函数(非复刻)。
import assert from 'node:assert/strict';
import {
  hasFreshNonShellTask, hasFreshShellTask, hasCurrentEpochNonShellTask, reconcileLiveTasks, resolveStallMs,
} from '../../server/routes/chat.js';

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
  // ③ shell 不计入 hasFreshNonShellTask(其 kind 语义不变;看门狗的 shell 豁免见下方
  //    hasFreshShellTask 用例,组合判据才是看门狗真正用的忙碌口径)
  assert.equal(hasFreshNonShellTask(new Map([['t', { kind: 'shell', epoch: 3, createdAt: now }]]), now, FRESH),
    false, 'shell 条目不计入 hasFreshNonShellTask(kind 语义不变)');
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

// ── r151h:新鲜后台 shell 任务也解除看门狗(强拆进程会连坐杀后台命令) ──────
{
  // ① 新鲜 shell → 算忙:CLI 新版后台工作 pending 时会话不空闲、可长时间无输出,
  //    看门狗若 5 分钟拆进程,进程里的后台命令会被连带杀掉且不可恢复。
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'shell', epoch: 3, createdAt: old(60_000) }]]), now, FRESH),
    true, '新鲜 shell 任务算忙(看门狗不拆进程)');
  // ② 陈旧 shell → 不算忙:终态通知丢失的残留不能永久解除看门狗
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'shell', epoch: 3, createdAt: old(40 * 60 * 1000) }]]), now, FRESH),
    false, '陈旧 shell 条目不解除看门狗');
  // ③ 边界:年龄 = 窗长算陈旧(与 `<` 判据逐字一致,同 hasFreshNonShellTask)
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'shell', createdAt: old(FRESH) }]]), now, FRESH),
    false, 'shell 年龄 = 窗长算陈旧');
  // ④ 只有 shell 算 shell;subagent / unknown 不算
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'subagent', createdAt: now }]]), now, FRESH),
    false, 'subagent 不算 shell');
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'unknown', createdAt: now }]]), now, FRESH),
    false, 'unknown 不算 shell');
  // ⑤ 健壮性:空表 / null / null 条目 / 缺 createdAt(按 0 算陈旧)都不炸
  assert.equal(hasFreshShellTask(new Map(), now, FRESH), false, '空表不算忙');
  assert.equal(hasFreshShellTask(null, now, FRESH), false, '无 liveTasks 不炸');
  assert.equal(hasFreshShellTask(new Map([['t', null]]), now, FRESH), false, 'null 条目不炸');
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'shell' }]]), now, FRESH),
    false, '缺 createdAt 按 0 算陈旧,不算忙');
  // ⑥ 默认参数可用(now/freshMs 缺省 = Date.now()/30min)
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'shell', createdAt: Date.now() }]])), true,
    '默认参数不能把 shell 判据废掉');
  // ⑦ 组合判据(busyLive)逐条对照:非 shell 新鲜任务或新鲜 shell 任务才算忙
  const busyLive = (liveTasks) => hasFreshNonShellTask(liveTasks, now, FRESH)
    || hasFreshShellTask(liveTasks, now, FRESH);
  assert.equal(busyLive(new Map([['t', { kind: 'shell', createdAt: now }]])), true,
    '组合判据:新鲜 shell 算忙');
  assert.equal(busyLive(new Map([['t', { kind: 'shell', createdAt: old(FRESH) }]])), false,
    '组合判据:陈旧 shell 不豁免');
  assert.equal(busyLive(new Map([['t', { kind: 'subagent', createdAt: now }]])), true,
    '组合判据:新鲜非 shell 仍算忙(原有防误杀语义不变)');
}

// ── r151h:CGUI_STALL_MS 阈值解析(默认 300000,合法正整数且 1000..2147483647) ─
{
  assert.equal(resolveStallMs(undefined), 300_000, '缺省回默认 300000');
  assert.equal(resolveStallMs(null), 300_000, 'null 回默认 300000');
  assert.equal(resolveStallMs(''), 300_000, '空串回默认 300000');
  assert.equal(resolveStallMs('abc'), 300_000, '非数字回默认 300000');
  assert.equal(resolveStallMs('999'), 300_000, '小于下限 1000 回默认 300000');
  assert.equal(resolveStallMs('1000'), 1000, '下限 1000 生效');
  assert.equal(resolveStallMs('1500'), 1500, '合法值生效');
  assert.equal(resolveStallMs('1.5'), 300_000, '非整数回默认 300000');
  assert.equal(resolveStallMs('0'), 300_000, '0 回默认 300000');
  assert.equal(resolveStallMs('-1500'), 300_000, '负数回默认 300000');
  assert.equal(resolveStallMs(300_000), 300_000, '数字 300000 原样生效');
  // 上限 = 2^31-1(Node setTimeout 的 delay 上限):超过它的值 Node 会按 1ms 处理,
  // 定时器立刻触发 → 看门狗立刻 abort 拆进程,所以必须夹到上限并回落默认。
  assert.equal(resolveStallMs('2147483647'), 2_147_483_647, '上限 2147483647 采用');
  assert.equal(resolveStallMs('2147483648'), 300_000, '超上限 2147483648 回默认 300000');
  assert.equal(resolveStallMs('1000000000000000'), 300_000, '超大值(1e15)回默认 300000');
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

// ── R1 降级守卫:level 信号【不新鲜】时回落宽判据 ────────────────────
// 严判据的续命全靠 level 信号刷新 createdAt,而它是【成员变化才发】的边沿信号、不是心跳。
// 判据取时效而非"收到过没有":单个子代理独自长跑时,起它那一刻发过一条、之后一条都不来,
// 只判"收到过"照样会在 40 分钟后把它 abort 连坐杀掉(强拆进程,不可恢复)。
// 失败方向由此翻转成"终态事件 + level 信号双丢失(极罕见)时看门狗被挡",而僵尸条目的清理
// 本来就由 A1 的 level 对账负责 —— 宁漏标,不误杀。
{
  const live = new Map([['t', { kind: 'subagent', epoch: 3, createdAt: old(40 * 60 * 1000) }]]);
  // 泵里的合成判据:hasFresh || (level 信号超窗 && hasCurrentEpoch)
  const busy = (lastLevelAt) => hasFreshNonShellTask(live, now, FRESH)
    || (now - (lastLevelAt || 0) >= FRESH && hasCurrentEpochNonShellTask(live, 3));

  // 三态:
  // ① 旧版 CLI(<2.1.220)从不发该信号 → lastLevelAt 恒 0 → 宽判据
  assert.equal(busy(0), true, '旧版 CLI 无 level 信号 → 回落宽判据,本回合条目仍算忙(不被 abort 误杀)');
  // ② 信号新鲜(窗内确认过)→ 严判据,陈旧条目不再解除看门狗
  assert.equal(busy(old(60_000)), false, 'level 信号新鲜 → 启用严判据,陈旧条目不再解除看门狗');
  // ③ 信号陈旧(超出 FRESH 窗,即单个子代理独自长跑期间无任务起停)→ 回落宽判据
  assert.equal(busy(old(40 * 60 * 1000)), true,
    'level 信号超窗 → 回落宽判据(只判"收到过"会在这里把真活的长任务误杀)');
  // 边界:年龄正好等于窗长算超窗(与 `>=` 判据逐字一致)
  assert.equal(busy(old(FRESH)), true, 'level 信号年龄 = 窗长即算陈旧');
  assert.equal(busy(old(FRESH - 1)), false, '差 1ms 仍算新鲜 → 严判据');

  // 降级支只豁免【本回合】,跨回合的陈旧残留照样不算忙(否则看门狗又被永久解除)
  const prev = new Map([['t', { kind: 'subagent', epoch: 1, createdAt: old(40 * 60 * 1000) }]]);
  assert.equal(hasCurrentEpochNonShellTask(prev, 3), false, '跨回合陈旧条目不进降级豁免');
  // shell 永不计入降级支
  assert.equal(hasCurrentEpochNonShellTask(new Map([['t', { kind: 'shell', epoch: 3 }]]), 3), false,
    'shell 不计入降级判据');
  // epoch 归一化与 `|0` 口径一致;缺 epoch 的条目按 0 算
  assert.equal(hasCurrentEpochNonShellTask(new Map([['t', { kind: 'subagent' }]]), 0), true, '缺 epoch 按 0 算');
  assert.equal(hasCurrentEpochNonShellTask(null, 0), false, '无 liveTasks 不炸');
}

// ── 源码守卫:判据不得被改回去 ──────────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/const busyNonShell = hasFreshNonShellTask\(slot\.liveTasks, now, LIVE_TASK_FRESH_MS\)\s*\n\s*\|\| \(now - \(slot\.lastLevelAt \|\| 0\) >= LIVE_TASK_FRESH_MS\s*\n\s*&& hasCurrentEpochNonShellTask\(slot\.liveTasks, slot\.turnEpoch\)\);/.test(src),
    '看门狗判据 = 严判据 || 降级守卫(R1);降级条件必须是【时效】,只判"收到过"覆盖不到独自长跑的子代理');
  assert.ok(/slot\.lastLevelAt = Date\.now\(\);/.test(src), 'level 分支必须刷新 lastLevelAt');
  assert.ok(/lastLevelAt: 0,/.test(src), 'slot 字面量必须声明 lastLevelAt(0 = 从没收到过 → 宽判据)');
  assert.ok(!/sawLevel/.test(src), '旧的 sawLevel 一次性开关必须删干净,不留双份判据');
  // 复用同一个常量,不新造数字
  assert.ok(!/>= 30 \* 60 \* 1000/.test(src), '降级判据必须复用 LIVE_TASK_FRESH_MS,不得写裸数字');
  assert.ok(!/t\.epoch === \(slot\.turnEpoch \| 0\) \|\| now - \(t\.createdAt \|\| 0\) < LIVE_TASK_FRESH_MS/.test(src),
    '不得再出现"epoch 支无年龄上限"的旧判据');
  assert.equal(src.match(/const LIVE_TASK_FRESH_MS = 30 \* 60 \* 1000;/g)?.length, 1,
    'LIVE_TASK_FRESH_MS 保持 30 分钟 —— A3 不得趁机调小,那会成倍放大误杀真长任务的概率');
  // r151h:新鲜后台 shell 任务也豁免看门狗(CLI 新版后台工作 pending 时会话不空闲)
  assert.ok(/export function hasFreshShellTask\(liveTasks, now = Date\.now\(\), freshMs = LIVE_TASK_FRESH_MS\)/.test(src),
    '必须导出 hasFreshShellTask(纯函数,供看门狗与单测使用)');
  assert.ok(/t\.kind === 'shell' && now - \(t\.createdAt \|\| 0\) < freshMs/.test(src),
    'hasFreshShellTask 必须只认 kind=shell 且年龄 < freshMs');
  assert.ok(/t\.kind !== 'shell' && now - \(t\.createdAt \|\| 0\) < freshMs/.test(src),
    'hasFreshNonShellTask 的 kind 语义不得被改(shell 仍不计入该判据)');
  assert.ok(/const busyLive = busyNonShell \|\| hasFreshShellTask\(slot\.liveTasks, now, LIVE_TASK_FRESH_MS\);/.test(src),
    '看门狗忙判据必须并入新鲜 shell:busyLive = busyNonShell || hasFreshShellTask(...)');
  // 看门狗触发条件的其余部分(idle / turnSubagentSeen / revived)未动,忙判据改用 busyLive
  assert.ok(/if \(!slot\.idle && \(slot\.turnSubagentSeen \|\| slot\.revived\) && !busyLive\)/.test(src),
    '看门狗触发条件的其余三项不得被顺手改掉');
  // r151h:STALL_MS 启动时读 CGUI_STALL_MS(通用可调阈值,缺省/非法 = 300000)
  assert.ok(/const STALL_MS = resolveStallMs\(process\.env\.CGUI_STALL_MS\);/.test(src),
    'STALL_MS 必须在启动时读取 CGUI_STALL_MS,不得写死');
  assert.ok(/const STALL_MS_DEFAULT = 300_000;/.test(src), '静默阈值默认必须是 300000');
  assert.ok(/Number\.isInteger\(ms\) && ms >= 1000 && ms <= 2_147_483_647 \? ms : STALL_MS_DEFAULT/.test(src),
    'CGUI_STALL_MS 只接受 1000..2147483647(Node setTimeout 上限)的整数,其余回落默认 300000');
  assert.ok(!/const STALL_MS = \d/.test(src), 'STALL_MS 不得被改回裸数字');
  assert.equal(src.match(/\b300_000\b/g)?.length, 1,
    '默认阈值只保留一个 300_000(不得另写裸 300000 之外的阈值)');
  assert.ok(/\}, STALL_MS\);/.test(src), '看门狗定时器必须使用 STALL_MS');
}

console.log('✓ check-stall-watchdog: 年龄上限 9 断言 + level 续命 + R1 降级三态 + 新鲜 shell 豁免(busyLive) + CGUI_STALL_MS 解析 + 源码守卫 全过');
