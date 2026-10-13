// 列表读取结果的采纳判定(r150c M1)。纯机制,零依赖,单测:tests/unit/check-r150-fetch-gate.mjs。
//
// 给工具面板(MCPPanel)用。面板的列表读取有两种:
//   强制读取(?fresh=1)—— 后端现读现建,要等健康检查(几秒到几十秒),结果是权威的;
//   缓存读取 —— 读后端缓存,立刻返回,内容可能是旧的。
// 几次读取会同时在路上(挂载时读一次、第 5 秒再静默读一次、用户点「刷新」、切换插件后重读……),
// 回来的先后和发起的先后不一样,所以每次回来都要判一下"这份结果还该不该画到界面上"。
//
// 上一版只有一个序号:谁最后发起谁算数。结果是 —— 面板打开后 5 秒内点「刷新」,第 5 秒的静默读取发起得
// 更晚、回来得更早,「刷新」的结果回来时已经不是"最后发起的",被丢弃,界面停在缓存里的旧列表。
//
// 现在的规则(三条):
//   ① 作废(invalidate):此前发起的读取一律不采纳。界面刚做了乐观更新(切换插件)或刚改完东西时调用 ——
//      那些读取读到的是改之前的状态。
//   ② 强制读取:没被作废、且没有比它更晚发起的强制读取已经落地 → 采纳。缓存读取抢不走它。
//   ③ 缓存读取:没被作废、没有比它更晚发起的读取已经落地、且它发起之后没有强制读取落地 → 采纳。
//      (它读到的可能是旧缓存,不许盖掉比它新的、或比它权威的结果。)

export function makeFetchGate() {
  let epoch = 0;             // 作废一次 +1
  let seq = 0;               // 发起序号
  let landedSeq = 0;         // 已落地的读取里最大的发起序号
  let landedFreshSeq = 0;    // 已落地的强制读取里最大的发起序号
  let freshLanded = 0;       // 落地过几次强制读取

  return {
    /** 读取发起时调:拿一张票,结果回来时交给 accept。 */
    begin({ fresh = false } = {}) {
      seq += 1;
      return { epoch, seq, fresh: !!fresh, freshLanded };
    },
    /** 结果回来时调:该不该采纳。返回 true 即记为"已落地"。 */
    accept(ticket) {
      if (!ticket || ticket.epoch !== epoch) return false;
      if (ticket.fresh) {
        if (ticket.seq < landedFreshSeq) return false;
        landedFreshSeq = ticket.seq;
        freshLanded += 1;
      } else if (ticket.seq < landedSeq || ticket.freshLanded !== freshLanded) {
        return false;
      }
      landedSeq = Math.max(landedSeq, ticket.seq);
      return true;
    },
    /** 作废此前发起的所有读取。 */
    invalidate() { epoch += 1; },
  };
}
