// R24:最近一次 API 调用的缓存口径(「最近API命中率」)从会话窗格传到全局顶栏的小总线。
//
// 顶栏(全局,document 里唯一一个 data-cgui=topbar)拿不到窗格内的 ctxUsage;窗格里的
// SessionDetail 又不能在渲染中途写别人的 state。做法:窗格渲染一个只负责上报的空组件
// (useEffect 里 publish),顶栏订阅同一份快照。
//
// 快照形如 { sessionId, read, creation, input, total, hitPct } | null;只有当前焦点会话
// 的数据会被顶栏采用(sessionId 对不上就不显示),避免切窗格时串数。
let snapshot = null;
const listeners = new Set();

export function publishTurnCache(next) {
  snapshot = next || null;
  for (const fn of listeners) fn();
}

export function subscribeTurnCache(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function readTurnCache() {
  return snapshot;
}
