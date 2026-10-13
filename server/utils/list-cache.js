// 可作废的列表缓存槽(r150 E3)。纯机制,零依赖,单测:tests/unit/check-r150-list-cache.mjs。
//
// 给 MCP / 插件列表用(server/routes/mcp.js)。那份列表的完整构建要跑 `claude mcp list` 做健康检查,
// 几秒到几十秒;所以读取走"先回缓存、过期了后台刷新",增删改之后把缓存作废。
// 原来的写法是三个模块变量(缓存 / 写入时刻 / 是否在刷新),作废 = 把缓存置空。有两个洞:
//   ① 作废拦不住已经在跑的构建 —— 它跑完照样把"作废之前读到的东西"写回缓存;
//   ② 刷新在跑时,新来的刷新请求被直接丢掉 —— 于是 ① 写回的旧结果没人纠正,一直留到缓存过期(5 分钟)。
// 现场:面板冷读(后台慢刷新开始)→ 停用一个账号同步的插件 → 慢刷新跑完,已停用插件带来的 MCP 又回到列表里。
//
// 这里的做法:每次作废换一代;构建开始时拿当时的代号,写回时代号对不上就不写。
// 刷新在跑时又有人要求刷新:先记着;这一次跑完若结果因为作废而没写进去,就用记着的再跑一次。

/**
 * @param {{ now?: () => number }} [opts]  now 可注入(单测用假时钟)
 */
export function makeListCache({ now = Date.now } = {}) {
  let value = null;      // null = 没有缓存
  let at = 0;            // 写入时刻
  let generation = 0;    // 作废一次 +1
  let running = false;   // 后台刷新是否在跑
  let queued = null;     // 刷新在跑时又来的刷新请求(只留最后一个)

  /** 读缓存:{ value, at },没有则 null。 */
  const peek = () => (value === null ? null : { value, at });
  /** 构建开始时调:拿到的代号在写回时交还。 */
  const begin = () => generation;
  /** 构建完成时调:构建期间没有作废过才写入,返回写没写进。 */
  const commit = (token, next) => {
    if (token !== generation) return false;
    value = next;
    at = now();
    return true;
  };
  /** 作废:清掉缓存,并让所有"此刻之前开始的构建"的结果都不许再写进来。 */
  const invalidate = () => {
    generation += 1;
    value = null;
    at = 0;
  };
  /**
   * 后台刷新(不等待、不抛):同一时刻只跑一次 build()。
   * 跑的过程中又有人调 refresh → 记着;跑完若结果没写进去(期间作废过,或 build 抛了)就用记着的再跑一次。
   * 结果写进去了就不重跑 —— 期间没有作废,它就是当前有效的结果。
   */
  const refresh = (build) => {
    if (running) { queued = build; return; }
    running = true;
    (async () => {
      let job = build;
      while (job) {
        queued = null;
        const token = begin();
        let stored = false;
        try { stored = commit(token, await job()); } catch { stored = false; }
        job = stored ? null : queued;
      }
    })().finally(() => { running = false; queued = null; });
  };
  const isRefreshing = () => running;

  return { peek, begin, commit, invalidate, refresh, isRefreshing };
}
