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
 * r23-①②:单列表(平铺)模式的可见项目集 —— 懒拉与渲染共用同一个来源。
 * 只按 hidden 过滤,**不按 worktree 显示开关过滤**:那个开关管的是"侧栏要不要显示
 * worktree 项目行",而分组模式本来就不显示 worktree 行;平铺再按它裁一刀,worktree
 * 的会话在整个侧栏就没有任何入口了(本仓工作流每轮开一次性 worktree,必踩)。
 * 无 query 参数是刻意的:query 过滤会与"搜会话标题依赖组已加载"成环(组没加载 →
 * 标题不匹配 → 不加载),平铺的 query 过滤落在会话行那一层。
 */
export function singleModeVisibleProjects({ projects = [], hidden, panes = [], pinned } = {}) {
  return composePanelProjects({ projects, hidden, showWorktrees: true, query: '', panes, pinned });
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

// ── r13-①:dsh 折叠树(项目/会话二合一;r11-① 钻入式两页退役)────────

/**
 * 展开集初始值(含持久化 key 一次性迁移,纯函数零 IO):
 *  - 旧钻入键 'cgui-drill-project' 有值 → 该项目初始展开(migrated:true,调用方
 *    随后删旧键并写新键)。钻入态是最近真实状态,优先于可能陈旧的手风琴数组;
 *  - 否则新键 'cgui-expanded-projects'(数组)有存值 → 过滤非法直接用;
 *  - 都没有 → 全部折叠([])。
 */
export function initialExpandedProjects(storedList, legacyDrill) {
  if (typeof legacyDrill === 'string' && legacyDrill) {
    return { list: [legacyDrill], migrated: true };
  }
  if (storedList !== undefined) {
    return { list: Array.isArray(storedList) ? storedList.filter((x) => typeof x === 'string' && x) : [], migrated: false };
  }
  return { list: [], migrated: false };
}

/** 展开集切换(纯函数):返回新数组(Set 语义,保持既有顺序,新增追尾)。 */
export function toggleExpanded(list, hash) {
  const arr = Array.isArray(list) ? list : [];
  if (!hash) return arr;
  return arr.includes(hash) ? arr.filter((h) => h !== hash) : [...arr, hash];
}

// ── r13-②:分组/排序(dsh 图3 同构)────────────────────────────────

const tsOf = (p) => (p?.lastActivity ? new Date(p.lastActivity).getTime() : -1);

/**
 * 项目行排序(纯函数):置顶段恒最前(保持传入相对序);非置顶段按
 *  - 'recent':最新会话活动时间降序;
 *  - 'manual':按 order 数组索引;order 里不存在的(新项目)追加尾部(保持传入
 *    相对序);order 里已删除的项目读时自然出列(无需清理)。
 */
export function sortProjectRows(rows, { sortMode = 'recent', order = [], pinned = new Set() } = {}) {
  const list = Array.isArray(rows) ? [...rows] : [];
  const pin = list.filter((p) => pinned.has(p.hash));
  const rest = list.filter((p) => !pinned.has(p.hash));
  if (sortMode === 'manual') {
    const idx = new Map((Array.isArray(order) ? order : []).map((h, i) => [h, i]));
    const known = rest.filter((p) => idx.has(p.hash)).sort((a, b) => idx.get(a.hash) - idx.get(b.hash));
    const fresh = rest.filter((p) => !idx.has(p.hash));
    return [...pin, ...known, ...fresh];
  }
  rest.sort((a, b) => tsOf(b) - tsOf(a));
  return [...pin, ...rest];
}

// r26-I4:平铺原来每条 `{ ...s, projectHash }` 现铺 —— watcher 每 600ms 刷新一次,
// 每个会话对象都换新身份,下游 SessionItem 的 memo 全失效(整列表重渲)。这里用
// WeakMap<原对象, 包装对象> 缓存:原对象引用没变就复用同一包装身份;mergeSessionList
// 那层本来就保原对象身份(内容没变复用旧引用),两层接力后整条链身份稳定。
// 注:一个会话对象只属于一个项目,WeakMap 键不带 projectHash 不会串。
const flatWrapCache = new WeakMap();
const wrapFlatRow = (s, projectHash) => {
  let w = flatWrapCache.get(s);
  if (!w || w.projectHash !== projectHash) {
    w = { ...s, projectHash };
    flatWrapCache.set(s, w);
  }
  return w;
};

/**
 * 单列表平铺(纯函数):全部已加载项目的会话跨项目合并,按 lastActivity 降序;
 * 每条带 projectHash(点击选中时反查项目)。归档会话不进平铺(与折叠树默认视图一致)。
 * r23-①:visibleHashes(可选,Set/数组)给定时只平铺可见项目的会话 —— sessionsByProject
 * 是"曾经加载过"的缓存,隐藏项目不会被清掉(toggleHidden 不清缓存、expandedProjects 还
 * 持久化在 localStorage、600ms watcher 继续刷),不过滤就等于隐藏对平铺模式无效。
export function flattenSessionRows(sessionsByProject, visibleHashes) {
  const visible = visibleHashes instanceof Set ? visibleHashes
    : (Array.isArray(visibleHashes) ? new Set(visibleHashes) : null); // 不传 = 不过滤(旧调用方语义不变)
  const out = [];
  for (const [projectHash, sessions] of Object.entries(sessionsByProject || {})) {
    if (visible && !visible.has(projectHash)) continue;
    for (const s of sessions || []) {
      if (s && !s.archived) out.push(wrapFlatRow(s, projectHash));
    }
  }
  out.sort((a, b) => (b.lastActivity ? new Date(b.lastActivity).getTime() : -1) - (a.lastActivity ? new Date(a.lastActivity).getTime() : -1));
  return out;
}

// r23-③:空态文案(平铺与分组两处共用)。系统拒绝访问时**绝不能**伪装成"暂无会话"——
// 用户的第一反应是"数据被 GUI 删了"(r17-4 立项根因)。原来只有分组模式那处读
// accessError,平铺模式自己硬编了一句"暂无会话",403 落成空数组后正好走进它。
// r24:原文案结尾是「—— 点此查看处理办法」,而它渲染成一个纯 <span>,点了没有任何反应
// (承诺了交互却没实现)。现在处理办法有两条真实出口:hover 看 title(平台化的 hint),
// 以及 macOS 上紧随其后的「打开系统设置」按钮。文案不再承诺一个不存在的点击。
export const ACCESS_DENIED_HINT = '无法读取会话目录（系统拒绝访问），会话文件没有丢失';

/** 空态文案判定:拒访 > 搜索无果 > 调用方给的兜底(平铺/分组各自的措辞)。 */
export function sessionEmptyHint({ accessError, query, fallback } = {}) {
  if (accessError) return ACCESS_DENIED_HINT;
  return query ? '没有匹配的会话' : fallback;
}

// r24:拒访空态给不给「打开系统设置」按钮。ponytail: 这两行本可以直接写在 JSX 的 && 里,
// 提成纯函数是为了让门控**能被行为单测真调**(组件层没有 JSX 渲染环境,只做正则断言的话,
// 平台门控失效正是那种"断言全绿而 Windows 用户被指去一个不存在的面板"的坑)。
// canOpenSettings 来自后端 canOpenAccessSettings(),目前只有 macOS 为真。
export function showAccessSettingsButton({ accessError, canOpenSettings } = {}) {
  return !!accessError && !!canOpenSettings;
}

/** 手动拖拽落位(纯函数):把 hash 移到 targetIdx(非置顶段内),返回新顺序数组。 */
export function reorderManual(hashes, fromHash, toIdx) {
  const arr = (Array.isArray(hashes) ? hashes : []).filter((h) => h !== fromHash);
  const i = Math.max(0, Math.min(arr.length, toIdx));
  arr.splice(i, 0, fromHash);
  return arr;
}

/**
 * r26-I1:拖拽松手 PUT 前,把「当前不可见(隐藏/被过滤)但在旧 order 里」的 hash
 * 按原相对位次并回 preview(纯函数)。拖拽 preview 只含可见非置顶 hash,直接整体
 * 覆盖 PUT 会把隐藏项目的排位静默抹掉(取消隐藏后掉到队尾)。
 *  - preview:本次拖拽后的可见 hash 序列(用户的新意图,相对序原样保留);
 *  - oldOrder:现存全量 order;
 *  - 每个 missing 插回锚点 = oldOrder 中它前方最近的、已在 result 中的元素
 *    (missing 按 oldOrder 顺序处理,同段后续 missing 的锚可以是刚插入的 missing
 *    自身 → 旧相对序自然保持);无锚(全部前驱都不可见)插头部,headPtr 指针保序;
 *  - preview 已含的 hash(如刚取消隐藏被拖动的项目)不属于 missing,不重复插入。
 */
export function mergeHiddenOrder(preview, oldOrder) {
  const result = [...(Array.isArray(preview) ? preview : [])];
  const old = Array.isArray(oldOrder) ? oldOrder : [];
  const survivors = new Set(result);
  const missing = old.filter((h) => !survivors.has(h));
  let headPtr = 0; // 无锚 missing 的头部插入指针(保持 missing 间相对序)
  for (const h of missing) {
    let anchor = null;
    for (let j = old.indexOf(h) - 1; j >= 0; j--) {
      if (result.includes(old[j])) { anchor = old[j]; break; }
    }
    if (anchor !== null) result.splice(result.indexOf(anchor) + 1, 0, h);
    else { result.splice(headPtr, 0, h); headPtr++; }
  }
  return result;
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

// ── r13-p2-1:列表身份保持(卡顿根治) ──────────────────────────────
// watcher 每 600ms 刷新全部展开组;若回包无论内容变没变都换数组/对象身份,侧栏
// 整棵树跟着重渲(流式期间持续发生)= 按钮迟滞与点击丢失的根因。这里逐条比对
// 侧栏行【实际消费的字段】,未变的条目复用旧对象身份,整组零变化直接返回旧数组
// (调用方据此跳过 set,订阅零通知)。
const SESSION_ROW_FIELDS = ['sessionId', 'firstPrompt', 'archived', 'messageCount', 'model', 'lastActivity', 'projectPath', 'projectHash'];

export function sameSessionRow(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const k of SESSION_ROW_FIELDS) if (a[k] !== b[k]) return false;
  return (a.subagents?.length || 0) === (b.subagents?.length || 0);
}

/** 新回包 next 与现值 prev 合并:内容相同复用旧身份;整组相同返回 prev 本身。 */
export function mergeSessionList(prev, next) {
  const list = Array.isArray(next) ? next : [];
  if (!Array.isArray(prev)) return list;
  const byId = new Map(prev.map((s) => [s?.sessionId, s]));
  const merged = list.map((n) => {
    const old = byId.get(n?.sessionId);
    return old && sameSessionRow(old, n) ? old : n;
  });
  if (merged.length === prev.length && merged.every((s, i) => s === prev[i])) return prev;
  return merged;
}
