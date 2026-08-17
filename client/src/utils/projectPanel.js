// r10-11:单层项目折叠面板的纯函数层(排序/渲染源合成/组内会话排序)。
// UI(UnifiedSidebar)只消费这里的输出;矩阵单测钉住行为(check-project-panel.mjs)。

// worktree 判据与分屏跟随兜底(App.jsx)同款:GUI 建的树在 <repo>-worktrees/ 下,
// CLI agent 自动建的在 <repo>/.claude/worktrees/ 下。
export const WORKTREE_PATH_RE = /-worktrees[\\/]|[\\/]\.claude[\\/]worktrees[\\/]/;

const activityTs = (p) => {
  const t = p?.lastActivity ? new Date(p.lastActivity).getTime() : NaN;
  return Number.isFinite(t) ? t : -1; // 无时间(虚拟节点/空项目)排最后
};

/**
 * 渲染源合成 + 过滤 + 排序。
 *  - projects:服务端列表;hidden/showWorktrees/query(已 lowercase)为过滤条件;
 *  - panes:各窗格会话/draft 的 {projectHash, projectPath}(未落盘 worktree draft 必须可见:
 *    projects.find 落空时构造虚拟行,复用 enterWorktree/分屏跟随的兜底形状,virtual:true);
 *    pane 所在项目豁免 hidden/worktree 过滤(正在用必须可见),但仍受 query 过滤;
 *  - queryMatchHashes:组内有标题命中会话的项目 hash 集(调用方按已加载组预计算),
 *    使"搜会话标题"能带出所属项目行;
 *  - pinned:置顶项目前置;组内按 lastActivity 降序(服务端 mtime 口径),无时间排最后。
 * 返回排好序的行数组(虚拟行带 virtual:true;React key 用 hash,稳定)。
 */
export function composePanelProjects({
  projects = [], hidden, showWorktrees = false, query = '',
  panes = [], pinned, queryMatchHashes,
} = {}) {
  const hiddenSet = hidden instanceof Set ? hidden : new Set(hidden || []);
  const pinnedSet = pinned instanceof Set ? pinned : new Set(pinned || []);
  const matchSet = queryMatchHashes instanceof Set ? queryMatchHashes : new Set(queryMatchHashes || []);
  const q = String(query || '').toLowerCase();
  const rowMatchesQuery = (p) =>
    !q || String(p.path || '').toLowerCase().includes(q) || matchSet.has(p.hash);

  const byHash = new Map();
  for (const p of projects) {
    if (!p || !p.hash || byHash.has(p.hash)) continue;
    if (hiddenSet.has(p.hash)) continue;
    if (!showWorktrees && p.isWorktree) continue;
    if (!rowMatchesQuery(p)) continue;
    byHash.set(p.hash, p);
  }
  // 窗格项目:被 hidden/worktree 过滤掉的真实条目复活;projects 没有的构造虚拟行。
  for (const pane of panes) {
    const hash = pane?.projectHash;
    if (!hash || byHash.has(hash)) continue;
    const real = projects.find((p) => p?.hash === hash);
    const row = real || {
      hash,
      path: pane.projectPath || hash,
      isWorktree: WORKTREE_PATH_RE.test(pane.projectPath || ''),
      sessionCount: 0,
      lastActivity: null,
      virtual: true,
    };
    if (!rowMatchesQuery(row)) continue;
    byHash.set(hash, row);
  }
  return [...byHash.values()].sort((a, b) => {
    const pin = (pinnedSet.has(b.hash) ? 1 : 0) - (pinnedSet.has(a.hash) ? 1 : 0);
    if (pin) return pin;
    return activityTs(b) - activityTs(a);
  });
}

/**
 * 组内会话排序:归档过滤 + 标题搜索(titleOf 由调用方给,与渲染同一取值链)+
 * 置顶前置(稳定排序,组内保持服务端时序)。
 */
export function composePanelSessions({
  sessions = [], pinned, query = '', titleOf = () => '', showArchived = false,
} = {}) {
  const pinnedSet = pinned instanceof Set ? pinned : new Set(pinned || []);
  const q = String(query || '').toLowerCase();
  return sessions
    .filter((s) => !!s.archived === !!showArchived)
    .filter((s) => !q || String(titleOf(s) || '').toLowerCase().includes(q))
    .sort((a, b) => (pinnedSet.has(b.sessionId) ? 1 : 0) - (pinnedSet.has(a.sessionId) ? 1 : 0));
}

/**
 * 置顶广播 reducer:GET /api/prefs/pinned 与 WS 'pinned' 广播共用的载荷守卫,
 * 非法载荷回落空数组(不炸 UI)。返回值直接 set 进 store。
 */
export function reducePinned(data) {
  return {
    pinnedProjects: Array.isArray(data?.projects) ? data.projects.filter((x) => typeof x === 'string') : [],
    pinnedSessions: Array.isArray(data?.sessions) ? data.sessions.filter((x) => typeof x === 'string') : [],
  };
}

// ── r11-①:钻入式两页态(项目页 ⇄ 会话页)────────────────────────────

/**
 * drillProject 初始值解析(含持久化 key 迁移):
 *  - 新 key 'cgui-drill-project' 有值(含显式 null)→ 直接用(非法类型回落 null);
 *  - 新 key 缺失(storedValue===undefined)→ 一次性读旧手风琴 key
 *    'cgui-expanded-projects'(数组),取最后展开(≈最近操作)的项目;
 *  - 都没有 → null(项目页)。
 */
export function initialDrillProject(storedValue, legacyList) {
  if (storedValue !== undefined) {
    return typeof storedValue === 'string' && storedValue ? storedValue : null;
  }
  const arr = Array.isArray(legacyList) ? legacyList.filter((x) => typeof x === 'string' && x) : [];
  return arr.length ? arr[arr.length - 1] : null;
}

/**
 * 两页态解析:drillHash 为空 → 项目页;能在行集中解析到项目 → 该项目的会话页;
 * 解析不到(项目被隐藏/尚未拉到/panes 已关)→ 回落项目页但**不改状态**,
 * fetchProjects 到位后自然恢复(渲染期不许写 store)。
 */
export function resolveDrillView(drillHash, rows) {
  if (!drillHash) return { view: 'projects', project: null };
  const project = (rows || []).find((p) => p && p.hash === drillHash) || null;
  return project ? { view: 'sessions', project } : { view: 'projects', project: null };
}

/** 搜索时带出"组内有标题命中"的项目行:按已加载组预计算 hash 集。 */
export function sessionQueryMatchHashes({ sessionsByProject = {}, query = '', titleOf = () => '' } = {}) {
  const q = String(query || '').toLowerCase();
  const out = new Set();
  if (!q) return out;
  for (const [hash, sessions] of Object.entries(sessionsByProject)) {
    if ((sessions || []).some((s) => String(titleOf(s) || '').toLowerCase().includes(q))) out.add(hash);
  }
  return out;
}
