// 渐进挂载(W-C)的挂载集合纯逻辑 —— 零 DOM、零高度概念。
//
// 目的:长会话(几百轮、几万节点)里把"常驻 DOM 行数"压下来。成本 ≈ 常驻节点数 × resize 次数
// (实测 8~12µs/节点,JS 只占 1.2%),所以唯一有效的杠杆是少挂 DOM。
//
// ⚠️ 本模块**故意没有**任何高度/占位/估算概念(W-A 才需要,W-B 已否决):
//   未挂载的行在几何上**不存在** —— 已挂部分 100% 真实。仓里有 5 处读 scrollHeight/offsetTop
//   做滚动静默补偿的机制(吸底 / 回到底部 / away 判据 / 宽度比例搬迁 / 进度条刻度),
//   它们读到的永远是"已挂内容的真实几何",语义不变。谁要往这里加 height/offsets/estimate,
//   就是走错了路线。
//
// 单测:tests/unit/check-mount-window.mjs

/** 默认只挂最近 K 行。total < K 时整段挂上(不越界)。 */
export function initialSpan(total, K) {
  const n = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const k = Number.isFinite(K) && K > 0 ? Math.floor(K) : 0;
  return { from: Math.max(0, n - k), to: n };
}

/** 向上补齐一批(K 行)。新的 from 不小于 0;from === 0 时原样返回 0(幂等,不越界)。 */
export function extendUp(from, K, total) {
  const n = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const k = Number.isFinite(K) && K > 0 ? Math.floor(K) : 0;
  const cur = Number.isFinite(from) ? Math.max(0, Math.min(Math.floor(from), n)) : 0;
  if (cur === 0 || k === 0) return cur;
  return Math.max(0, cur - k);
}

/** 该不该补齐:滚到顶(留一屏余量)就该补。补齐是幂等的,重复触发只会把批次合并。 */
export function needsExtend({ scrollTop, padPx }) {
  const top = Number.isFinite(scrollTop) ? scrollTop : 0;
  const pad = Number.isFinite(padPx) ? padPx : 0;
  return top <= pad;
}

/** 取要渲染的那一段(不改入参;越界的 from/to 按 0..length 钳住)。 */
export function sliceRows(rows, { from, to } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const lo = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
  const hi = Number.isFinite(to) ? Math.min(list.length, Math.floor(to)) : list.length;
  return list.slice(lo, Math.max(lo, hi));
}
