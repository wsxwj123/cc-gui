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
// r151i 判官整改:shell 的豁免只由 hasFreshShellTask 的 2h 窗口提供,R1 降级支只覆盖
// 非 shell;超过 2h 的 shell 即使 level 信号陈旧也不再算忙 → 2h 是真总上限。
// 直接 import chat.js 的真函数(非复刻)。
import assert from 'node:assert/strict';
import {
  hasFreshNonShellTask, hasFreshShellTask, hasFreshLiveTask, hasCurrentEpochNonShellTask,
  reconcileLiveTasks, resolveStallMs, parseEnvMs, SHELL_TASK_FRESH_MS,
  stallWatchdogBusy, shouldStallWatchdogFire, buildStallNoticeText,
} from '../../server/routes/chat.js';

const FRESH = 30 * 60 * 1000;
const SHELL_FRESH = 2 * 60 * 60 * 1000;
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
  // ⑥ 默认参数可用(now 缺省 = Date.now(),freshMs 缺省 = SHELL_TASK_FRESH_MS=2h)
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

// ── r151i:shell 新鲜度窗口 2h(默认),非 shell 仍 30min ────────────────────
// 修复前 shell 与其它 kind 共用 30min —— 40 分钟的后台全量回归会被看门狗/idle 回收
// 当成陈旧条目拆掉(实测 Bash timeout 见过 3600000ms)。2h 是总上限,不是无限豁免。
{
  assert.equal(SHELL_TASK_FRESH_MS, SHELL_FRESH, 'SHELL_TASK_FRESH_MS 必须是 2 小时');
  // ① 默认窗口:40 分钟 / 60 分钟仍新鲜(H05 的核心;旧 30min 窗口下这里会 false)
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'shell', createdAt: old(40 * 60 * 1000) }]]), now),
    true, 'shell 默认窗口下 40 分钟仍算活');
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'shell', createdAt: old(60 * 60 * 1000) }]]), now),
    true, 'shell 默认窗口覆盖到 60 分钟(实测后台任务寿命)');
  // ② 2 小时边界:年龄 = 窗长算陈旧(与 `<` 判据逐字一致),差 1ms 仍新鲜
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'shell', createdAt: old(SHELL_FRESH) }]]), now),
    false, 'shell 年龄 = 2 小时算陈旧(保留总上限)');
  assert.equal(hasFreshShellTask(new Map([['t', { kind: 'shell', createdAt: old(SHELL_FRESH - 1) }]]), now),
    true, 'shell 差 1ms 到 2 小时仍新鲜');
  // ③ hasFreshNonShellTask 的默认窗口仍是 30 分钟(语义/窗口都不得被这次改动带偏)
  assert.equal(hasFreshNonShellTask(new Map([['t', { kind: 'subagent', createdAt: old(40 * 60 * 1000) }]]), now),
    false, '非 shell 默认窗口仍是 30 分钟:40 分钟算陈旧');
  assert.equal(hasFreshNonShellTask(new Map([['t', { kind: 'subagent', createdAt: old(29 * 60 * 1000) }]]), now),
    true, '非 shell 默认窗口仍是 30 分钟:29 分钟算新鲜');
}

// ── r151i:idleReclaim 按 kind 分窗判活(导出纯函数) ────────────────────────
// idle 回收到点会关 input、连坐关掉进程里的后台命令;判据与看门狗同口径:shell 2h、其它 30min。
{
  const one = (kind, ageMs) => new Map([['t', { kind, createdAt: old(ageMs) }]]);
  // ① shell:40 分钟算活、2 小时算陈旧
  assert.equal(hasFreshLiveTask(one('shell', 40 * 60 * 1000), now), true,
    'idleReclaim:shell 40 分钟算活');
  assert.equal(hasFreshLiveTask(one('shell', SHELL_FRESH), now), false,
    'idleReclaim:shell 2 小时边界算陈旧');
  // ② 非 shell 仍 30 分钟:40 分钟算陈旧、1 分钟算活
  assert.equal(hasFreshLiveTask(one('subagent', 40 * 60 * 1000), now), false,
    'idleReclaim:subagent 40 分钟算陈旧(仍 30min 窗口)');
  assert.equal(hasFreshLiveTask(one('subagent', 60_000), now), true,
    'idleReclaim:subagent 1 分钟算活');
  // ③ 混合条目各取各的窗口:单看 subagent 已陈旧,但 shell 40 分钟仍活 → 整体算活
  assert.equal(hasFreshLiveTask(new Map([
    ['a', { kind: 'subagent', createdAt: old(40 * 60 * 1000) }],
    ['b', { kind: 'shell', createdAt: old(40 * 60 * 1000) }],
  ]), now), true, 'idleReclaim:混合条目取各自窗口(shell 40 分钟撑住)');
  // 反向:shell 已过 2h,但 subagent 1 分钟仍活 → 整体算活
  assert.equal(hasFreshLiveTask(new Map([
    ['a', { kind: 'shell', createdAt: old(SHELL_FRESH + 60_000) }],
    ['b', { kind: 'subagent', createdAt: old(60_000) }],
  ]), now), true, 'idleReclaim:混合条目取各自窗口(subagent 1 分钟撑住)');
  // 全部陈旧 → 回收
  assert.equal(hasFreshLiveTask(new Map([
    ['a', { kind: 'shell', createdAt: old(SHELL_FRESH) }],
    ['b', { kind: 'subagent', createdAt: old(FRESH) }],
  ]), now), false, 'idleReclaim:两类都陈旧 → 可回收');
  // ④ kind 缺省/unknown 按非 shell 窗口处理(与 hasFreshNonShellTask 的 kind 语义一致)
  assert.equal(hasFreshLiveTask(one('unknown', 40 * 60 * 1000), now), false,
    'idleReclaim:unknown 40 分钟算陈旧(30min 窗口)');
  // ⑤ 健壮性:空表 / null / null 条目不炸
  assert.equal(hasFreshLiveTask(new Map(), now), false, 'idleReclaim:空表不豁免');
  assert.equal(hasFreshLiveTask(null, now), false, 'idleReclaim:无 liveTasks 不炸');
  assert.equal(hasFreshLiveTask(new Map([['t', null]]), now), false, 'idleReclaim:null 条目不炸');
  // ⑥ 分窗可注入(单测/未来复用),默认走 2h/30min
  assert.equal(hasFreshLiveTask(one('shell', 40 * 60 * 1000), now, { shell: FRESH }), false,
    'idleReclaim:可注入 shell 窗口(注入 30min 后 40 分钟算陈旧)');
  assert.equal(hasFreshLiveTask(one('subagent', 40 * 60 * 1000), now, { other: SHELL_FRESH }), true,
    'idleReclaim:可注入其它 kind 窗口');
}

// ── r151h:CGUI_STALL_MS 阈值解析(默认 300000,合法正整数且 1000..2147483647) ─
// r151s:签名改为 resolveStallMs(setting, envRaw);下面这组只看环境变量,setting 缺省 = 默认 5m。
{
  assert.equal(resolveStallMs(undefined, undefined), 300_000, '缺省回默认 300000');
  assert.equal(resolveStallMs(undefined, null), 300_000, 'null 回默认 300000');
  assert.equal(resolveStallMs(undefined, ''), 300_000, '空串回默认 300000');
  assert.equal(resolveStallMs(undefined, 'abc'), 300_000, '非数字回默认 300000');
  assert.equal(resolveStallMs(undefined, '999'), 300_000, '小于下限 1000 回默认 300000');
  assert.equal(resolveStallMs(undefined, '1000'), 1000, '下限 1000 生效');
  assert.equal(resolveStallMs(undefined, '1500'), 1500, '合法值生效');
  assert.equal(resolveStallMs(undefined, '1.5'), 300_000, '非整数回默认 300000');
  assert.equal(resolveStallMs(undefined, '0'), 300_000, '0 回默认 300000');
  assert.equal(resolveStallMs(undefined, '-1500'), 300_000, '负数回默认 300000');
  assert.equal(resolveStallMs(undefined, 300_000), 300_000, '数字 300000 原样生效');
  // 上限 = 2^31-1(Node setTimeout 的 delay 上限):超过它的值 Node 会按 1ms 处理,
  // 定时器立刻触发 → 看门狗立刻 abort 拆进程,所以必须夹到上限并回落默认。
  assert.equal(resolveStallMs(undefined, '2147483647'), 2_147_483_647, '上限 2147483647 采用');
  assert.equal(resolveStallMs(undefined, '2147483648'), 300_000, '超上限 2147483648 回默认 300000');
  assert.equal(resolveStallMs(undefined, '1000000000000000'), 300_000, '超大值(1e15)回默认 300000');
  // r151s:设置映射(定时器时长就是这个毫秒数本身,旧套件夹具按"恰为 300000"识别默认档)
  assert.equal(resolveStallMs('5m'), 300_000, '5m → 300000');
  assert.equal(resolveStallMs('10m'), 600_000, '10m → 600000');
  assert.equal(resolveStallMs('20m'), 1_200_000, '20m → 1200000');
  assert.equal(resolveStallMs('never'), 300_000, 'never(只提示)仍按 5 分钟计时');
  for (const bad of [undefined, null, '', 'bogus', '15m', 'constructor', '__proto__', 'toString', 10]) {
    assert.equal(resolveStallMs(bad), 300_000, `设置非法(${String(bad)})回 300000`);
  }
  assert.equal(resolveStallMs('20m', '2000'), 2000, 'CGUI_STALL_MS 合法时压过设置');
  assert.equal(resolveStallMs('never', '2000'), 2000, 'never 也用 CGUI_STALL_MS 的时长(到点动作仍看设置)');
  assert.equal(resolveStallMs('10m', '999'), 600_000, 'CGUI_STALL_MS 非法时按设置');
  assert.equal(resolveStallMs('10m', '2147483648'), 600_000, 'CGUI_STALL_MS 超上限时按设置');
  // r151q 第 7 项:CGUI_STALL_MS 与 CGUI_KEEPALIVE_IDLE_MS 共用 parseEnvMs(合法 → 原值,其余 → null = 当没设)
  assert.equal(parseEnvMs('2000'), 2000, '合法值原样');
  assert.equal(parseEnvMs(2_147_483_647), 2_147_483_647, '上限照用');
  for (const bad of ['2147483648', '99999999999', '999', '1.5', '-1500', '', 'abc', undefined, null]) {
    assert.equal(parseEnvMs(bad), null, `${JSON.stringify(bad)} 当没设`);
  }
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

// ── r151i 判官整改:R1 降级支不含 shell,2h 是 shell 的真总上限 ─────────────
// 判官意见:此前 R1 降级支把【本回合任意年龄的 shell】也算忙 —— lastLevelAt 只在
// background_tasks_changed 时刷新(后台任务起/止各一次),长 shell 超过 30 分钟后 R1 生效、
// 超过 2h 仍不触发看门狗 → 真卡死被永久放过,等于给 shell 无限豁免(回到 #13 输入框永久
// 卡"停止"的老 bug)。修法:把 shell 从 R1 降级支移除,shell 的豁免只由 hasFreshShellTask
// 的 2h 窗口提供,于是 2h 成为真正的总上限。
{
  // 生产组合式(与 chat.js 的 busyLive 同构):严判据 || R1(仅非 shell) || 新鲜 shell
  const busyLive = (live, lastLevelAt) => hasFreshNonShellTask(live, now, FRESH)
    || (now - (lastLevelAt || 0) >= FRESH && hasCurrentEpochNonShellTask(live, 3))
    || hasFreshShellTask(live, now);
  // ① 2h 后的同回合 shell:即使 level 信号陈旧(lastLevelAt=0,R1 会触发),也不再算忙 →
  //    看门狗可正常触发。修前此处为 true(R1 含 shell → 本回合 shell 无限豁免)。
  assert.equal(busyLive(new Map([['t', { kind: 'shell', epoch: 3, createdAt: old(SHELL_FRESH + 60_000) }]]), 0),
    false, '超过 2h 的 shell 不再计入看门狗忙判据(level 信号陈旧也不能豁免)');
  // ② 对照:2h 窗口内的 shell 仍算忙(40 分钟用例 H05 不回归)
  assert.equal(busyLive(new Map([['t', { kind: 'shell', epoch: 3, createdAt: old(40 * 60 * 1000) }]]), 0),
    true, '2h 窗口内的 shell 仍算忙(40 分钟场景不回归)');
}

// ── r151q 第 13 项:看门狗判定改测导出的真函数(行为断言);源码只留"生产确实调用它们"的接线锚 ──
// 原区块逐字正则锁住判据 / 阈值 / 文案的写法,任何等价重构(换行、改名、抽函数)都会误报。判据各组成
// 函数的行为由上面各节覆盖;这里补组合忙判据 stallWatchdogBusy、触发条件 shouldStallWatchdogFire、
// 文案 buildStallNoticeText 的行为,外加宽松的接线锚(删掉接线 = 纯函数测了也白测)。
{
  const slotOf = (entries, extra = {}) => ({
    liveTasks: new Map(entries.map((e, i) => [`t${i}`, e])), turnEpoch: 3, lastLevelAt: 0, ...extra,
  });
  // ① 组合忙判据 = 严判据 || R1 降级支(仅非 shell,按时效) || 新鲜 shell(2h)
  const staleSub = { kind: 'subagent', epoch: 3, createdAt: old(40 * 60 * 1000) };
  assert.equal(stallWatchdogBusy(slotOf([staleSub], { lastLevelAt: old(60_000) }), now), false,
    'level 信号新鲜 → 严判据:本回合但陈旧的子代理不再解除看门狗');
  assert.equal(stallWatchdogBusy(slotOf([staleSub], { lastLevelAt: 0 }), now), true,
    '从没收到 level 信号(旧版 CLI)→ 降级宽判据:本回合子代理仍算忙');
  assert.equal(stallWatchdogBusy(slotOf([staleSub], { lastLevelAt: undefined }), now), true,
    'slot 缺 lastLevelAt 按 0 算(从没收到 → 宽判据)');
  assert.equal(stallWatchdogBusy(slotOf([staleSub], { lastLevelAt: old(FRESH) }), now), true,
    'level 信号年龄 = 窗长即算陈旧(降级条件是时效,>=)');
  assert.equal(stallWatchdogBusy(slotOf([staleSub], { lastLevelAt: old(FRESH - 1) }), now), false,
    'level 信号差 1ms 到窗长仍新鲜 → 严判据');
  assert.equal(stallWatchdogBusy(slotOf([{ kind: 'subagent', epoch: 1, createdAt: old(40 * 60 * 1000) }]), now), false,
    '跨回合的陈旧残留不进降级豁免(否则看门狗被永久解除)');
  assert.equal(stallWatchdogBusy(slotOf([{ kind: 'shell', epoch: 3, createdAt: old(SHELL_FRESH + 60_000) }]), now), false,
    '超过 2h 的本回合 shell 即使 level 信号陈旧也不算忙(R1 不含 shell,2h 是真总上限)');
  assert.equal(stallWatchdogBusy(slotOf([{ kind: 'shell', epoch: 3, createdAt: old(40 * 60 * 1000) }], { lastLevelAt: old(1000) }), now), true,
    '2h 窗口内的 shell 算忙(用 SHELL_TASK_FRESH_MS 默认窗口,不是 30 分钟)');
  assert.equal(stallWatchdogBusy(slotOf([{ kind: 'subagent', epoch: 1, createdAt: old(FRESH - 1) }], { lastLevelAt: old(1000) }), now), true,
    '非 shell 窗口是 30 分钟:差 1ms 仍新鲜(跨回合也算忙,防误杀 teammate)');
  assert.equal(stallWatchdogBusy(slotOf([{ kind: 'subagent', epoch: 1, createdAt: old(FRESH) }], { lastLevelAt: old(1000) }), now), false,
    '非 shell 窗口是 30 分钟:年龄 = 窗长算陈旧(LIVE_TASK_FRESH_MS 不得被调大调小)');
  assert.equal(stallWatchdogBusy({ turnEpoch: 3, lastLevelAt: 0 }, now), false, '没有 liveTasks 不炸、不算忙');
  assert.equal(stallWatchdogBusy(slotOf([{ kind: 'subagent', epoch: 3, createdAt: Date.now() }])), true,
    'now 缺省 = Date.now()');

  // ② 触发条件:没空闲 + (本回合起过子代理 || 续跑) + 不忙
  const quiet = slotOf([], { idle: false, turnSubagentSeen: true, revived: false });
  assert.equal(shouldStallWatchdogFire(quiet, now), true, '起过子代理、没有活任务、没空闲 → 触发');
  assert.equal(shouldStallWatchdogFire({ ...quiet, idle: true }, now), false, '已空闲不触发');
  assert.equal(shouldStallWatchdogFire({ ...quiet, turnSubagentSeen: false }, now), false, '没起过子代理也没续跑不触发');
  assert.equal(shouldStallWatchdogFire({ ...quiet, turnSubagentSeen: false, revived: true }, now), true,
    '无子代理回合的续跑(revived)也要有看门狗兜底(判官 S2)');
  assert.equal(shouldStallWatchdogFire(slotOf([{ kind: 'shell', createdAt: old(60_000) }], { idle: false, turnSubagentSeen: true }), now), false,
    '有新鲜活任务不触发');
  assert.equal(shouldStallWatchdogFire(slotOf([staleSub], { idle: false, turnSubagentSeen: true, lastLevelAt: old(60_000) }), now), true,
    'level 信号新鲜时,本回合陈旧条目挡不住看门狗');

  // ③ 文案:默认 300000 → "5 分钟";分钟数随阈值变化;带子代理前缀的版本只多前缀。
  //    r151s:结束版末尾多一句设置入口;只提示版(endTurn:false)不说已结束本回合,同样以设置入口结尾。
  const SETTING_TAIL = '时长可在 设置 → 会话 → 静默超时 中修改。';
  const tail = `分钟无后续输出,已结束本回合并重置连接(部分第三方 provider 偶发)。已有内容完好,直接重发或继续即可。${SETTING_TAIL}`;
  assert.equal(buildStallNoticeText(300_000, false), `上游超过 5 ${tail}`, '默认阈值文案逐字不变');
  assert.equal(buildStallNoticeText(300_000, true), `子代理已全部结束,但上游超过 5 ${tail}`, '带子代理前缀的默认文案逐字不变');
  assert.equal(buildStallNoticeText(600_000, false), `上游超过 10 ${tail}`, '分钟数随阈值变化(600000 → 10 分钟)');
  const secTail = tail.replace(/^分钟/, '秒');
  assert.equal(buildStallNoticeText(1500, false), `上游超过 2 ${secTail}`, '不到 1 分钟写四舍五入的秒数(1500 → 2 秒)');
  assert.equal(buildStallNoticeText(2000, true), `子代理已全部结束,但上游超过 2 ${secTail}`, '秒数文案带子代理前缀');
  assert.equal(buildStallNoticeText(60_000, false), `上游超过 1 ${tail}`, '满 1 分钟起写分钟数');
  assert.equal(buildStallNoticeText(90_000, false), `上游超过 2 ${tail}`, '分钟数四舍五入(90000 → 2 分钟)');
  assert.equal(buildStallNoticeText(300_000, true, { endTurn: true }), `子代理已全部结束,但上游超过 5 ${tail}`, '显式 endTurn:true 同默认');
  const hintTail = `无后续输出(部分第三方 provider 偶发)。按设置不自动结束本回合,需要时可点停止。${SETTING_TAIL}`;
  assert.equal(buildStallNoticeText(300_000, true, { endTurn: false }), `子代理已全部结束,但上游超过 5 分钟${hintTail}`, '只提示版(起过子代理)');
  assert.equal(buildStallNoticeText(1_200_000, false, { endTurn: false }), `上游超过 20 分钟${hintTail}`, '只提示版(续跑)换开头');
  assert.equal(buildStallNoticeText(2000, false, { endTurn: false }), `上游超过 2 秒${hintTail}`, '只提示版秒数写法同结束版');
  assert.ok(!buildStallNoticeText(600_000, true, { endTurn: false }).includes('已结束本回合'), '只提示版不含"已结束本回合"');

  // ④ 接线锚(宽松,只查生产代码调用了被测函数 / 读了变量,不锁写法)
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/(?<!function )shouldStallWatchdogFire\(slot\b/.test(src), '看门狗定时器必须调用 shouldStallWatchdogFire 判定(不算函数定义本身)');
  assert.ok(/buildStallNoticeText\(stallMs\b/.test(src), 'stall_notice 文案必须按这次实际等待的 stallMs 由 buildStallNoticeText 生成');
  assert.ok(/\}, stallMs\);/.test(src), '看门狗定时器必须使用 stallMs');
  assert.ok(/resolveStallMs\(readStallTimeoutSync\(\)/.test(src), 'r151s:每次开始计时按设置 stallTimeout 现算时长');
  assert.ok(/process\.env\.CGUI_STALL_MS\b/.test(src), 'CGUI_STALL_MS 仍然读取');
  assert.ok(/readStallTimeoutSync\(\) === 'never'/.test(src), 'r151s:到点再读一次设置,never 走只提示');
  assert.ok(/hasFreshLiveTask\(slot\.liveTasks\b/.test(src), 'idleReclaim 的"有活任务"判据必须用分窗函数');
  assert.ok(/slot\.lastLevelAt = Date\.now\(\)/.test(src), 'level 分支必须刷新 lastLevelAt(R1 降级支据此切换)');
}

console.log('✓ check-stall-watchdog: 年龄上限 9 断言 + level 续命 + R1 降级三态(仅非 shell) + 2h 后 shell 不豁免 + shell 2h 窗口 + idleReclaim 分窗 + 新鲜 shell 豁免(busyLive) + CGUI_STALL_MS 解析 + 设置映射(r151s) + 组合忙判据/触发条件/文案两版(真函数) + 接线锚 全过');
