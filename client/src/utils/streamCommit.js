// 流式状态提交合并器(r119)—— 纯机制,零 React/store 依赖,可单测。
//
// 病灶:流式期间【每个 SSE 事件】都往 state 里写一次累积正文(streamingText/streamingBlocks),
// 而每次 state 变化都要把【整份累积正文】重渲染一遍(含整份 markdown 重解析)。单次成本随正文
// 长度线性增长、次数又等于事件数 ⇒ O(n²)。实测:200KB/s 的吐字下主线程被 2~8 秒的长任务占满,
// 用户点「停止」/按 Esc 的输入事件只能排在后面(6~11 秒才有反应)。
//
// 改法:事件只改【闭包里的累积值】(不碰 state),提交由本合并器负责 —— 每个动画帧最多提交一次
// (schedule 时若已排了帧就不重复排),提交时读的仍是累积值(所以同一帧里合并掉多少次事件,
// 内容一个字都不丢,只是中间态不画)。
//   schedule() 标脏 + 排一帧(同一帧内多次调用只提交最后一次的内容)
//   flush()    立刻提交一次。**回合终止路径必须调**(收到 result/done/error/中止之前),
//              否则最后一批内容还停在闭包里没进 state。
//   cancel()   丢掉挂起的那一帧、不提交。卸载/切会话/收尾清空 stream* 之后调 ——
//              既避免对已卸载组件 setState,也避免陈旧提交把刚清空的内容又写回去。
//
// 代价与边界:主线程被单帧成本(整份重解析)占着时帧率自然下降,提交次数随之下降 ——
// 这是刻意的:主线程要么在渲染、要么能受理输入,不再出现"渲染排队排到几秒之后"。
// rAF 在窗口不可见时会被节流;此时没人看画面,挂起的那一帧会在重新可见时照常补上,
// 终止路径的 flush 也不依赖它(所以不留定时器兜底)。
export function createStreamCommit(commit, opts = {}) {
  const raf = opts.raf || ((fn) => requestAnimationFrame(fn));
  const cancelRaf = opts.cancelRaf || ((h) => cancelAnimationFrame(h));
  let handle = null;
  let pending = false;
  const fire = () => {
    handle = null;
    if (!pending) return;
    pending = false;
    commit();
  };
  return {
    /** 这一帧还有没有没提交的内容(诊断/测试用)。 */
    get pending() { return pending; },
    schedule() {
      pending = true;
      if (handle === null) handle = raf(fire);
    },
    flush() {
      if (handle !== null) { cancelRaf(handle); handle = null; }
      if (!pending) return;
      pending = false;
      commit();
    },
    cancel() {
      pending = false;
      if (handle !== null) { cancelRaf(handle); handle = null; }
    },
  };
}
