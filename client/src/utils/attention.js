// app 级"在等你"提示:Dock 角标 + 窗口标题计数 + 坞图标小红点。
//
// 口径:**只数在等你的,不数在跑的**。跑着的任务不需要你做任何事,把它们算进角标只会
// 让角标常亮、失去提示意义。两个来源:
//   ① pendingPermissions —— 界面上待处理的权限/提问/计划卡
//   ② /api/agents/active 里 status==='waiting' 或 state==='blocked' 的条目
//      (后台代理卡在授权、外部 CLI 会话停下来等人)
// 两者会重叠:后台代理卡在授权时,它【既】是一张卡【又】是一个 waiting 条目 —— 那是
// 同一件事,数两遍角标就会显示 2 而实际只有一件事要做。按 sessionId 去重,卡片优先
// (有卡片说明用户点一下就能解决)。
//
// 两个参数都是【逗号连接的字符串】而不是数组,这是刻意的:调用方一边是 zustand 选择器
// (返回新数组会因新引用触发 React #185 整页白屏),一边是 1.5s 轮询写进 React state
// (新数组引用会让 App 根组件每 1.5s 白重渲一次)。字符串是基元,两处都能靠值相等短路。

/** /api/agents/active → 'sid1,sid2'(在等你的条目;无 sessionId 用 ? 占位)。 */
export function waitingSessionKeys(agents) {
  if (!Array.isArray(agents)) return '';
  return agents
    .filter((a) => a && (a.status === 'waiting' || a.state === 'blocked'))
    .map((a) => a.sessionId || '?')
    .join(',');
}

/** 要你处理的事情条数。waitingKeys / pendingKeys 均为 waitingSessionKeys 那种字符串。 */
export function countAttention(waitingKeys, pendingKeys) {
  const pending = pendingKeys ? String(pendingKeys).split(',') : [];
  const carded = new Set(pending.filter(Boolean));
  const waiting = waitingKeys ? String(waitingKeys).split(',') : [];
  return pending.length + waiting.filter((sid) => !carded.has(sid)).length;
}

// 上一次真正下发的计数。防抖:1.5s 轮询下计数多数时候不变,每轮空调一次 Tauri IPC
// 纯属浪费(还会让窗口标题反复重设)。
let lastApplied = null;

/**
 * 计数变化时给出要下发的角标状态,没变返回 null(调用方直接跳过)。
 * count=undefined 是 Tauri setBadgeCount 的"清除角标"约定(传 0 在 macOS 上会显示 "0")。
 * 导出供单测直接跑;reset 仅测试用。
 */
export function nextBadgeState(n) {
  const count = Number(n) > 0 ? Number(n) : 0;
  if (count === lastApplied) return null;
  lastApplied = count;
  return {
    count: count > 0 ? count : undefined,
    title: count > 0 ? `Claude GUI (${count})` : 'Claude GUI',
  };
}

export function resetBadgeState() { lastApplied = null; }

/**
 * 下发到窗口:角标(macOS 的 Dock;Windows 上该 API 是静默 no-op)+ 标题计数(跨平台
 * 兜底,document.title 不同步原生标题,必须走 API)。
 * 非 Tauri 环境(浏览器/手机端)直接静默降级 —— 那里没有 Dock 也没有原生标题栏。
 */
export function applyAttentionBadge(n) {
  const next = nextBadgeState(n);
  if (!next) return;
  import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      w.setBadgeCount(next.count).catch(() => {});
      w.setTitle(next.title).catch(() => {});
    })
    .catch(() => {});
}
