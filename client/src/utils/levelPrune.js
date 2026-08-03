// 按服务端广播的存活集剪掉僵尸卡(批A A4)。
//
// 为什么需要:子代理卡片的状态只由【边沿事件】驱动(task_started 建、task_notification /
// task_updated 收),没有轮询也没有对账。任一终态事件丢失(CLI 事件队列 1000 上限驱逐
// bookend、宿主进程在终态前被杀、跨回合 reattach 后本流 map 为空)卡片就永久转圈。
// 服务端接了 CLI 的 background_tasks_changed(全量存活集快照)后经 WS 广播过来,这里
// 做"不在集内 = 已结束"的剪枝。
//
// 【只剪枝收尾,永不据此 finalize/abort】—— 这是一个纯 UI 收敛动作,不碰任何进程。
//
// 纯函数,tests/unit/check-level-prune.mjs 真 import。返回要收尾的 agent id 列表。
export const LEVEL_PRUNE_MIN_AGE_MS = 1500; // 与服务端 LEVEL_GRACE_MS 对称的第二道门槛

const TERMINAL = ['done', 'error', 'stopped'];

export function pruneByLiveSet(agents, payload) {
  const { sessionId, taskIds = [], toolUseIds = [], ts = Date.now() } = payload || {};
  if (!sessionId) return []; // 无归属的广播不剪任何东西(宁可漏收,不可误收别的会话)
  const out = [];
  for (const [id, a] of Object.entries(agents || {})) {
    if (!a || a.sessionId !== sessionId) continue;
    // taskManaged:只有真发过 task_started 的条目才受 level 集管辖。没有这个标记的
    // (前台子代理的 message_start 建出来的、第三方 provider 不发 task 事件的)不在
    // CLI 的 tasks 表里,拿存活集去剪它们必然全剪 = 灾难。
    if (!a.taskManaged) continue;
    if (TERMINAL.includes(a.status)) continue;
    // hydrated:翻历史时 TaskCard 现补的条目,本就不是在跑的任务。
    // workflow:Workflow 起的独立 runtime,不进 CLI 的 tasks 集,剪它必然误收。
    if (a.hydrated || a.workflow) continue;
    if (toolUseIds.includes(id)) continue;
    if (a.taskId && taskIds.includes(a.taskId)) continue;
    // 刚起的不剪:与服务端 grace 对称,防"卡片先建、level 载荷后到"的乱序误收。
    // startedAt 缺失同样不剪(判不出年龄就别动它)。
    // 跨设备钟差(手机/平板远程访问 GUI,浏览器时钟 vs 服务端时钟):ts 是服务端 Date.now()、
    // startedAt 是本机 Date.now(),两方向都不会误收 —— 本机钟快 → 卡片看着更年轻 → 只是这轮
    // 不剪(漏剪,等下一次广播或真终态事件);本机钟慢 → 这道门槛形同虚设,但真正的防线是服务端
    // 那道 LEVEL_GRACE_MS(now 与 createdAt 都取服务端时钟,与本机钟差无关),这里只是第二道。
    if (!(a.startedAt && a.startedAt < ts - LEVEL_PRUNE_MIN_AGE_MS)) continue;
    out.push(id);
  }
  return out;
}
