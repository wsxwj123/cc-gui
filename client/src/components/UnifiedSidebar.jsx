// r10-11:单层项目折叠面板 —— ProjectList/SessionList(原 App.jsx 互斥切换)合并为
// 单面板:项目行(默认折叠)→展开显该项目会话。**展开≠选中**:点项目行只展开+懒拉
// (fetchSessionsForPanel→sessionsByProject);点会话才走既有 setSelectedProject+选会话
// 链路(store.sessions 单值槽/selectedProject 语义一字不动,权限卡门禁/@面板/监控照旧)。
// 功能全保留:添加/搜索/置顶/隐藏/清理/新建/worktree/归档/重命名/分叉/删除撤销。
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, Search, FolderOpen, EyeOff, Trash2, Pin, X, GitBranch, GitMerge,
  ChevronDown, ChevronRight, RefreshCw, Archive, Loader2, MoreHorizontal,
  Check, SlidersHorizontal, GripVertical,
} from './Icon.jsx';
import { useStore } from '../stores/sessionStore.js';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { resolveSessionTitle } from '../utils/sessionTitle.js';
import { composePanelProjects, composePanelSessions, sessionQueryMatchHashes, sortProjectRows, flattenSessionRows, reorderManual } from '../utils/projectPanel.js';
import { pickDirectory, isTauri } from '../utils/pickDirectory.js';
import { completionTracker } from '../utils/sessionDots.js';
import { AnchoredPopover } from './SessionSelectors.jsx';
// 循环 import(App.jsx ⇄ 本文件)安全性:这些都是 App.jsx 的模块级 function 声明
// (提升,求值前可用)或组件渲染期才解引用的 live binding;本模块顶层不调用它们。
import {
  newDraftId, formatPath, formatPathShort, finalizeSessionAgents,
  StatusDot, GlobalSearchResults, DeleteButton, SessionItem, FORK_RUNNING_CONFIRM,
  adoptFork, importGitState, GitInitBanner,
} from '../App.jsx';

const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_OBJECT = Object.freeze({});

// 新建会话继承「上一个活跃会话」的思考强度(权限恒 default)——原 SessionList 逻辑。
// r11-②:提为模块级导出,Home(App.jsx)与本面板的 6 处创建点共用同一 seed 链路;
// 全部经 getState() 取值,无组件闭包依赖。
export const seedNewSessionDefaults = (draftProjectHash) => {
  const st = useStore.getState();
  const prev = st.splitMode ? st.paneSessions?.[st.activeTabIndex] : st.selectedSession;
  const prevKey = prev ? (prev.sessionId || `draft-${prev.projectHash || 'none'}`) : null;
  const draftKey = `draft-${draftProjectHash || 'none'}`;
  if (prevKey && prevKey !== draftKey) {
    st.setModelFor(draftKey, ''); // model 跟 provider 默认,不跟上条会话
    st.setEffortFor(draftKey, st.getEffortFor(prevKey));
  }
  st.setActiveAgentFor(draftKey, '');
  st.setPermissionMode('default', draftKey);
};

// r13-①:项目行「⋯」菜单——hover 三枚(文件夹/置顶/隐藏)与原钻入头图标(worktree/归档)
// 全部收纳于此,能力一个不丢。弹层沿 p5-2 口径(gap=4 + 侧栏容器夹紧);
// 虚拟(未落盘)项目不显示「在文件夹中显示」(客户端+服务端双关既有语义)。
function ProjectRowMenu({ project, pinned, showArchived, hasArchiveToggle, archivedCount, rowRef = null, onReveal, onTogglePin, onHide, onWorktree, onToggleArchived }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const item = 'w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink-soft font-body hover:bg-canvas-warm transition-colors';
  const run = (fn) => (e) => { e.stopPropagation(); setOpen(false); fn(e); };
  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={`transition-opacity p-1 hover:bg-canvas-deep/60 rounded-md ${open ? 'opacity-100 bg-canvas-deep/60' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100'}`}
        aria-label="项目操作"
        title="项目操作"
      >
        <MoreHorizontal size={13} className="text-ink-muted" />
      </button>
      <AnchoredPopover anchorRef={btnRef} open={open} onRequestClose={() => setOpen(false)} drop="down" align="right" gap={4} clampSelector=".sidebar-flank" topAlignRef={rowRef} className="w-48 py-1">
        {!project.virtual && (
          <button onClick={run(onReveal)} className={item}>
            <FolderOpen size={12} className="text-ink-faint" />在文件夹中显示
          </button>
        )}
        <button onClick={run(onTogglePin)} className={item}>
          <Pin size={12} className={pinned ? 'text-accent fill-accent' : 'text-ink-faint'} />
          {pinned ? '取消置顶' : '置顶到列表最前'}
        </button>
        <button
          data-cgui="new-worktree-btn"
          data-tour="new-worktree"
          onClick={run(onWorktree)}
          className={item}
          title="在新 git worktree 中开会话（隔离工作树）"
        >
          <GitBranch size={12} className="text-ink-faint" />新建 worktree 会话
        </button>
        {hasArchiveToggle && (
          <button onClick={run(onToggleArchived)} className={item}>
            <Archive size={12} className={showArchived ? 'text-accent' : 'text-ink-faint'} />
            {showArchived ? '回到活跃会话' : `查看已归档会话(${archivedCount})`}
          </button>
        )}
        <button onClick={run(onHide)} className={`${item} border-t border-canvas-deep/40 mt-1 pt-1.5`}
          title="从侧栏隐藏（不删除本地文件，下次按 + 重新添加同路径即可恢复）">
          <EyeOff size={12} className="text-ink-faint" />从侧栏隐藏
        </button>
      </AnchoredPopover>
    </>
  );
}

// r13-②:排序/分组弹层(dsh 图3 同构)。选择存 prefs.sidebarView(多端共享);
// 手动排序在手机端置灰(拖拽为桌面 pointer 交互)。
function SidebarViewMenu() {
  const view = useStore((s) => s.sidebarView);
  const putSidebarView = useStore((s) => s.putSidebarView);
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const desktop = typeof window !== 'undefined' && !!window.matchMedia?.('(min-width: 768px)')?.matches;
  const head = 'px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-widest text-ink-faint font-body';
  const item = (on, disabled) => `w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] font-body transition-colors ${disabled ? 'opacity-40 cursor-default' : 'hover:bg-canvas-warm'} ${on ? 'text-accent' : 'text-ink-soft'}`;
  const pick = (patch) => { putSidebarView(patch); setOpen(false); };
  return (
    <>
      <button ref={btnRef} data-tour="sidebar-view" onClick={() => setOpen((v) => !v)} aria-label="排序与分组" title="排序与分组"
        className={`p-1 rounded transition-colors ${open ? 'bg-canvas-warm' : 'hover:bg-canvas-warm'}`}>
        <SlidersHorizontal size={13} className="text-ink-faint" />
      </button>
      <AnchoredPopover anchorRef={btnRef} open={open} onRequestClose={() => setOpen(false)} drop="down" align="right" gap={4} clampSelector=".sidebar-flank" className="w-52 py-1">
        <div className={head}>分组方式</div>
        <button onClick={() => pick({ groupMode: 'project' })} className={item(view.groupMode === 'project')}>
          {view.groupMode === 'project' ? <Check size={12} className="shrink-0" /> : <span className="w-3 shrink-0" />}按项目
        </button>
        <button onClick={() => pick({ groupMode: 'single' })} className={item(view.groupMode === 'single')}>
          {view.groupMode === 'single' ? <Check size={12} className="shrink-0" /> : <span className="w-3 shrink-0" />}单列表(全部会话按时间)
        </button>
        {/* 单列表模式无项目可排 → 排序段隐藏 */}
        {view.groupMode === 'project' && (
          <>
            <div className={`${head} border-t border-canvas-deep/40 mt-1`}>排序方式</div>
            <button onClick={() => pick({ sortMode: 'recent' })} className={item(view.sortMode === 'recent')}>
              {view.sortMode === 'recent' ? <Check size={12} className="shrink-0" /> : <span className="w-3 shrink-0" />}最近更新
            </button>
            <button
              disabled={!desktop}
              onClick={() => { if (desktop) pick({ sortMode: 'manual' }); }}
              className={item(view.sortMode === 'manual', !desktop)}
              title={desktop ? '项目行出现拖拽柄,可拖动重排(置顶恒最前)' : '手动排序需在桌面端拖拽'}
            >
              {view.sortMode === 'manual' ? <Check size={12} className="shrink-0" /> : <span className="w-3 shrink-0" />}手动排序
              {!desktop && <span className="ml-auto text-[10px] text-ink-faint">桌面端拖拽</span>}
            </button>
          </>
        )}
      </AnchoredPopover>
    </>
  );
}

export function UnifiedSidebar() {
  // r17-4:磁盘访问被系统拒绝时,空列表要说实话 —— 静默的「暂无会话」和真的没有
  // 会话长得一模一样,用户实测的第一反应是「数据被删了」。
  const accessError = useStore((st) => st.sessionsAccessError);
  // ── store(旧槽语义零改动;新面板数据走 sessionsByProject)─────────────────
  const projects = useStore((s) => s.projects);
  const fetchProjects = useStore((s) => s.fetchProjects);
  const searchQuery = useStore((s) => s.searchQuery);
  const setSearchQuery = useStore((s) => s.setSearchQuery);
  const runningCwds = useStore((s) => s.runningCwds);
  const runningSessionIds = useStore((s) => s.runningSessionIds);
  const selectedProject = useStore((s) => s.selectedProject);
  const splitMode = useStore((s) => s.splitMode);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const paneSessions = useStore((s) => s.paneSessions);
  const selectedSession = useStore((s) => s.selectedSession);
  const sessionsByProject = useStore((s) => s.sessionsByProject);
  const expandedProjects = useStore((s) => s.expandedProjects); // r13-①:折叠树展开集(数组,Set 语义)
  const expandedSet = useMemo(() => new Set(expandedProjects), [expandedProjects]);
  const pinnedProjects = useStore((s) => s.pinnedProjects);
  const pinnedSessions = useStore((s) => s.pinnedSessions);
  const customTitles = useStore((s) => s.customTitles);
  const autoTitles = useStore((s) => s.autoTitles);
  const focusSession = (paneSessions && paneSessions[activeTabIndex]) || null;

  const pinnedProjSet = useMemo(() => new Set(pinnedProjects || EMPTY_ARRAY), [pinnedProjects]);
  const pinnedSessSet = useMemo(() => new Set(pinnedSessions || EMPTY_ARRAY), [pinnedSessions]);
  const titleOf = useCallback(
    (s) => resolveSessionTitle(s, customTitles[s.sessionId], autoTitles[s.sessionId]),
    [customTitles, autoTitles],
  );

  // ── 挂载拉取:项目列表 / 置顶(reducer 入位,WS 广播后续收敛)/ 隐藏列表 ─────
  const [hidden, setHidden] = useState(() => new Set());
  useEffect(() => { fetchProjects(); }, []);
  useEffect(() => {
    fetch('/api/prefs/pinned').then((r) => r.json())
      .then((d) => useStore.getState().applyPinned(d))
      .catch(() => {});
  }, []);
  useEffect(() => {
    fetch('/api/prefs/hidden-projects')
      .then((r) => r.json())
      .then((d) => {
        const serverSet = new Set(Array.isArray(d.hidden) ? d.hidden : []);
        let legacy = [];
        try { legacy = JSON.parse(localStorage.getItem('cgui-hidden-projects') || '[]'); } catch {}
        if (serverSet.size === 0 && legacy.length > 0) {
          const merged = new Set(legacy);
          setHidden(merged);
          persistHidden(merged);
        } else {
          setHidden(serverSet);
        }
      })
      .catch(() => {});
  }, []);
  const persistHidden = (set) => {
    fetch('/api/prefs/hidden-projects', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: [...set] }),
    }).catch(() => {});
  };
  const toggleHidden = (hash) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash); else next.add(hash);
      persistHidden(next);
      return next;
    });
  };
  const togglePinProject = (hash) => {
    const st = useStore.getState();
    const willPin = !pinnedProjSet.has(hash);
    st.applyPinned({
      projects: willPin ? [...(st.pinnedProjects || []), hash] : (st.pinnedProjects || []).filter((h) => h !== hash),
      sessions: st.pinnedSessions || [],
    });
    fetch('/api/prefs/pinned', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'project', id: hash, pinned: willPin }),
    }).catch(() => {});
  };
  const togglePinSession = (sid) => {
    if (!sid) return;
    const st = useStore.getState();
    const willPin = !pinnedSessSet.has(sid);
    st.applyPinned({
      projects: st.pinnedProjects || [],
      sessions: willPin ? [...(st.pinnedSessions || []), sid] : (st.pinnedSessions || []).filter((x) => x !== sid),
    });
    fetch('/api/prefs/pinned', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'session', id: sid, pinned: willPin }),
    }).catch(() => {});
  };

  // ── worktree 项目显示开关(设置里控制,localStorage+事件同步,原 ProjectList 逻辑)──
  const [showWorktreeProjects, setShowWorktreeProjects] = useState(() => {
    try { return localStorage.getItem('cgui-show-worktree-projects') === '1'; } catch { return false; }
  });
  useEffect(() => {
    const h = () => { try { setShowWorktreeProjects(localStorage.getItem('cgui-show-worktree-projects') === '1'); } catch {} };
    window.addEventListener('cgui:worktree-visibility', h);
    return () => window.removeEventListener('cgui:worktree-visibility', h);
  }, []);

  // ── r13-①:折叠树切换(dsh 式,项目/会话二合一;钻入两页退役)。收起组时落实
  //    该组待删(撤销条随组收起消失,不落实=看着删了其实没删);展开时懒拉会话。
  const toggleProject = (hash) => {
    const st = useStore.getState();
    const isOpen = st.expandedProjects.includes(hash);
    if (isOpen) flushPendingForProject(hash);
    st.toggleProjectExpanded(hash);
    if (!isOpen && !st.sessionsByProject[hash]) st.fetchSessionsForPanel(hash);
  };
  // 选中项目自动展开(点会话/分屏跟随切过来时组跟随可见);用户手动折叠后不强制
  // 重展,直到 selectedProject 变化(effect deps 语义与旧版一致)。
  useEffect(() => {
    const hash = selectedProject?.hash;
    if (!hash) return;
    useStore.getState().ensureProjectExpanded(hash);
    if (!useStore.getState().sessionsByProject[hash]) useStore.getState().fetchSessionsForPanel(hash);
  }, [selectedProject?.hash]);

  // ── 刷新(watcher 多路,600ms 全局去抖):钻入组刷新 + 旧槽跟刷 + 未知项目冒出 ──
  useEffect(() => {
    let timer = null;
    let projTimer = null;
    const onChange = (e) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const st = useStore.getState();
        // r13-①:全部展开组保鲜(原为单一钻入组)。
        for (const h of st.expandedProjects) st.fetchSessionsForPanel(h);
        // 旧槽保鲜:selectedProject 的 sessions 单值槽仍被权限卡门禁/@面板消费。
        if (st.selectedProject?.hash) st.fetchSessions(st.selectedProject.hash, { silent: true });
      }, 600);
      const ph = e?.detail?.projectHash;
      if (ph && !useStore.getState().projects.some((p) => p.hash === ph)) {
        if (projTimer) clearTimeout(projTimer);
        projTimer = setTimeout(() => useStore.getState().fetchProjects(), 800);
      }
    };
    window.addEventListener('cgui:sessions-changed', onChange);
    window.addEventListener('cgui:ws-reconnected', onChange);
    return () => {
      window.removeEventListener('cgui:sessions-changed', onChange);
      window.removeEventListener('cgui:ws-reconnected', onChange);
      if (timer) clearTimeout(timer);
      if (projTimer) clearTimeout(projTimer);
    };
  }, []);

  // ── 渲染源:projects ∪ 窗格虚拟节点(纯函数,单测钉住)────────────────────────
  const panes = useMemo(() => {
    const list = [];
    for (const p of [...(paneSessions || EMPTY_ARRAY), selectedSession]) {
      if (p?.projectHash) list.push({ projectHash: p.projectHash, projectPath: p.projectPath });
    }
    return list;
  }, [paneSessions, selectedSession]);
  const q = searchQuery.trim().toLowerCase();
  const queryMatchHashes = useMemo(
    () => sessionQueryMatchHashes({ sessionsByProject, query: q, titleOf }),
    [sessionsByProject, q, titleOf],
  );
  const rows = useMemo(() => composePanelProjects({
    projects, hidden, showWorktrees: showWorktreeProjects, query: q,
    panes, pinned: pinnedProjSet, queryMatchHashes,
  }), [projects, hidden, showWorktreeProjects, q, panes, pinnedProjSet, queryMatchHashes]);
  const hiddenOnly = projects.length > 0 && rows.length === 0 && q === '' && hidden.size > 0;
  // ── r13-②:排序(置顶恒前;manual 按 projectOrder 对账)与手动拖拽预览 ──
  const view = useStore((s) => s.sidebarView);
  const [drag, setDrag] = useState(null); // { hash, preview: string[] } | null(拖拽中本地预览,松手才 PUT)
  useEffect(() => {
    if (!drag) return;
    const up = () => { useStore.getState().putSidebarView({ projectOrder: drag.preview }); setDrag(null); };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [drag]);
  const sortedRows = useMemo(() => sortProjectRows(rows, {
    sortMode: view.sortMode, order: drag ? drag.preview : view.projectOrder, pinned: pinnedProjSet,
  }), [rows, view.sortMode, view.projectOrder, drag, pinnedProjSet]);
  const nonPinnedHashes = useMemo(() => sortedRows.filter((p) => !pinnedProjSet.has(p.hash)).map((p) => p.hash), [sortedRows, pinnedProjSet]);
  // 单列表模式:全部项目会话平铺 → 需要各组都已加载(懒拉全量;数据层零改动)
  useEffect(() => {
    if (view.groupMode !== 'single') return;
    const st = useStore.getState();
    for (const p of st.projects) if (!st.sessionsByProject[p.hash]) st.fetchSessionsForPanel(p.hash);
  }, [view.groupMode, projects]);
  const projByHash = useMemo(() => new Map((projects || []).map((p) => [p.hash, p])), [projects]);
  // flatSessions 依赖 pendingIds(声明在删除挂起区,下方)——useMemo 回调与 deps 数组
  // 都在渲染时同步求值,放这里会在 const 初始化前读取(TDZ 崩渲染),故声明移至
  // pendingIds 之后(见删除挂起区尾)。0.2.296 全端崩溃根因,勿回移。

  // ── 面板级刷新:某项目会话变动后同刷 panel 缓存 + (若是选中项目)旧槽 ─────────
  const refreshProjectSessions = (projectHash) => {
    const st = useStore.getState();
    st.fetchSessionsForPanel(projectHash);
    if (st.selectedProject?.hash === projectHash) st.fetchSessions(projectHash, { silent: true });
  };

  // ── 选会话/新建(点会话才走既有 setSelectedProject+选会话链路;展开≠选中)──────
  const selectProjectIfNeeded = (project) => {
    const st = useStore.getState();
    if (st.selectedProject?.hash !== project.hash) {
      st.setSelectedProject(project);
      st.fetchSessions(project.hash, { silent: true }); // 旧槽填充(权限卡门禁读它)
    }
  };
  const handleSelect = (session, project) => {
    selectProjectIfNeeded(project);
    const st = useStore.getState();
    if (splitMode) {
      st.setActiveTabSession(session);
      st.fetchMessages(session.sessionId, session.projectHash, { tab: activeTabIndex });
    } else {
      st.setSelectedSession(session);
      st.fetchMessages(session.sessionId, session.projectHash);
    }
  };
  // seedNewSessionDefaults 已提为模块级导出(r11-②,Home 共用),行为不变。
  // r13-p2-8:新建会话统一进 Home(图标+问候+输入框+项目选择器),不再直接开 draft
  // 会话页。项目经 selectProjectIfNeeded 预设 → Home 的 pickHomeProject 即选中它,
  // 发送时才由 buildHomeDraft 建 draft(档位继承 seedNewSessionDefaults 照旧)。
  const handleNew = (project) => {
    if (!project) return;
    selectProjectIfNeeded(project);
    seedNewSessionDefaults(project.hash);
    const st = useStore.getState();
    if (splitMode) {
      st.setActiveTabSession(null);
      st.setPaneMessages(activeTabIndex, []);
    } else {
      st.setSelectedSession(null);
      useStore.setState({ messages: [] });
      st.setPaneMessages(0, []);
    }
  };

  // ── 归档 / 分叉(原 SessionList 逻辑,刷新改按 session.projectHash 双路)────────
  const [forking, setForking] = useState(null);
  const [archivedOpen, setArchivedOpen] = useState(() => new Set()); // 每项目独立的"已归档"视图
  const toggleArchivedView = (hash) => setArchivedOpen((prev) => {
    const next = new Set(prev);
    if (next.has(hash)) next.delete(hash); else next.add(hash);
    return next;
  });
  const handleArchive = async (session) => {
    try {
      await fetch(`/api/sessions/${session.sessionId}/archive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectHash: session.projectHash, archived: !session.archived }),
      });
      refreshProjectSessions(session.projectHash);
    } catch (err) {
      confirmDialog('归档失败：' + err.message);
    }
  };
  const handleFork = async (session, project) => {
    if (useStore.getState().runningSessionIds.has(session.sessionId)) {
      if (!(await confirmDialog(FORK_RUNNING_CONFIRM, { confirmText: '继续分支' }))) return;
    }
    setForking(session.sessionId);
    try {
      const res = await fetch('/api/fork', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, projectHash: session.projectHash }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.newSessionId) {
        confirmDialog('分支失败：' + (data.error || res.status));
        return;
      }
      const fork = {
        sessionId: data.newSessionId, projectHash: session.projectHash,
        projectPath: session.projectPath, firstPrompt: session.firstPrompt,
        model: session.model, messageCount: session.messageCount,
      };
      const st = useStore.getState();
      adoptFork(st, session, data.newSessionId);
      selectProjectIfNeeded(project);
      refreshProjectSessions(session.projectHash);
      if (st.splitMode) {
        const idx = st.activeTabIndex;
        st.setPaneSession(idx, fork);
        st.fetchMessages(fork.sessionId, fork.projectHash, { tab: idx });
      } else {
        st.setPaneCount(2);
        st.setPaneSession(1, fork);
        st.setActiveTabIndex(1);
        st.fetchMessages(fork.sessionId, fork.projectHash, { tab: 1 });
      }
    } catch (err) {
      confirmDialog('分支失败：' + err.message);
    } finally {
      setForking(null);
    }
  };

  // ── 删除 + 撤销倒计时(原 SessionList 逻辑)。落实时机新语义(G22):
  //    倒计时结束 / 收起该项目(flushPendingForProject) / beforeunload / 卸载兜底。
  //    面板常驻不再随切项目卸载,原"卸载即落实"不够,补前两者;卸载兜底留给手机
  //    抽屉页切走等真卸载场景(幂等:flush 前先从列表摘除)。
  const [pendingDeletes, setPendingDeletes] = useState([]);
  const pendingDeletesRef = useRef([]);
  pendingDeletesRef.current = pendingDeletes;

  const stopSessionProcs = async (sessionId) => {
    try {
      const list = async () => {
        const d = await fetch('/api/agents/active').then((r) => r.json());
        return (d.agents || []).filter((a) => a.kind === 'chat-process' && a.sessionId === sessionId && a.stoppable === true);
      };
      const procs = await list();
      if (!procs.length) return;
      await Promise.allSettled(procs.map((a) => fetch(`/api/chat/${a.pid}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hard: true }) })));
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if ((await list().catch(() => [])).length === 0) break;
      }
      finalizeSessionAgents(sessionId);
    } catch {}
  };
  const reallyDelete = async (session) => {
    try {
      await stopSessionProcs(session.sessionId);
      const r = await fetch(
        `/api/sessions/${session.sessionId}?projectHash=${encodeURIComponent(session.projectHash)}`,
        { method: 'DELETE' },
      );
      if (!r.ok) { const e = await r.json().catch(() => ({})); confirmDialog('删除失败：' + (e.error || r.status)); return; }
      useStore.getState().clearSessionStopped?.(session.sessionId);
      useStore.getState().clearQueue?.(session.sessionId);
      refreshProjectSessions(session.projectHash);
    } catch (err) {
      confirmDialog('删除失败：' + err.message);
    }
  };
  const handleDelete = (session) => {
    const sid = session.sessionId;
    if (pendingDeletesRef.current.some((p) => p.session.sessionId === sid)) return;
    completionTracker.forget(sid); // r11-p2-3b:会话移除即清"完成未读"边沿态(不留孤儿)
    const st = useStore.getState();
    const panes2 = [];
    (st.paneSessions || []).forEach((p, i) => {
      if (p?.sessionId && p.sessionId === sid) {
        panes2.push(i);
        st.setPaneSession(i, null);
        st.setPaneMessages(i, []);
      }
    });
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const cur = pendingDeletesRef.current.find((p) => p.session.sessionId === sid);
      if (!cur) { clearInterval(timer); return; }
      const left = Math.ceil((cur.deadline - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(timer);
        setPendingDeletes((arr) => arr.filter((p) => p.session.sessionId !== sid));
        reallyDelete(cur.session);
      } else if (left !== cur.secondsLeft) {
        setPendingDeletes((arr) => arr.map((p) => (p.session.sessionId === sid ? { ...p, secondsLeft: left } : p)));
      }
    }, 200);
    setPendingDeletes((arr) => [...arr, { session, panes: panes2, timer, deadline, secondsLeft: 5 }]);
  };
  const undoDelete = (sid) => {
    const p = pendingDeletesRef.current.find((x) => x.session.sessionId === sid);
    if (!p) return;
    clearInterval(p.timer);
    setPendingDeletes((arr) => arr.filter((x) => x.session.sessionId !== sid));
    const st = useStore.getState();
    p.panes.forEach((i) => {
      st.setPaneSession(i, p.session);
      st.fetchMessages(p.session.sessionId, p.session.projectHash, { tab: i, silent: true });
    });
  };
  // 收起项目组时立即落实该组的待删(撤销条随组收起消失,不落实=看着删了其实没删)。
  const flushPendingForProject = (projectHash) => {
    const mine = pendingDeletesRef.current.filter((p) => p.session.projectHash === projectHash);
    if (!mine.length) return;
    setPendingDeletes((arr) => arr.filter((p) => p.session.projectHash !== projectHash));
    mine.forEach((p) => { clearInterval(p.timer); reallyDelete(p.session); });
  };
  // beforeunload / 卸载兜底:剩余 pending 全部落实(keepalive fetch,进程随后端退出的
  // 场景由服务端收口)。两处共用同一 flush,先摘列表保证幂等。
  const flushAllPending = () => {
    const all = pendingDeletesRef.current;
    if (!all.length) return;
    pendingDeletesRef.current = [];
    all.forEach((p) => {
      clearInterval(p.timer);
      useStore.getState().clearQueue?.(p.session.sessionId);
      stopSessionProcs(p.session.sessionId).then(() => fetch(
        `/api/sessions/${p.session.sessionId}?projectHash=${encodeURIComponent(p.session.projectHash)}`,
        { method: 'DELETE', keepalive: true },
      )).catch(() => {});
    });
  };
  useEffect(() => {
    window.addEventListener('beforeunload', flushAllPending);
    return () => {
      window.removeEventListener('beforeunload', flushAllPending);
      flushAllPending(); // 卸载兜底(手机抽屉页切走等)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pendingIds = useMemo(() => new Set(pendingDeletes.map((p) => p.session.sessionId)), [pendingDeletes]);

  // ── r13-p2-1:SessionItem 的稳定回调(memo 前提)────────────────────────────
  // 直接写 onSelect={(s) => handleSelect(s, project)} 每次渲染都是新闭包,memo 恒失效。
  // 这里用 ref 锁最新实现 + 按项目 hash 缓存 bound 对象:props 身份跨渲染稳定,
  // 而项目数据经 projRef 每渲染刷新 → 回调拿到的永远是当前 project(不吃 stale 闭包)。
  const cbRef = useRef({});
  cbRef.current = { handleSelect, handleFork, handleArchive, handleDelete, togglePinSession };
  const projRef = useRef(new Map());
  const boundRef = useRef(new Map());
  // 项目行元素 ref(按 hash 缓存,身份稳定):⋯ 菜单顶对齐要读所在行矩形。
  const projRowRefs = useRef(new Map());
  const projectRowRef = useCallback((hash) => {
    let r = projRowRefs.current.get(hash);
    if (!r) { r = { current: null }; projRowRefs.current.set(hash, r); }
    return r;
  }, []);
  const bindRow = useCallback((project) => {
    const hash = project?.hash || '';
    projRef.current.set(hash, project);
    let b = boundRef.current.get(hash);
    if (!b) {
      b = {
        onSelect: (sess) => cbRef.current.handleSelect(sess, projRef.current.get(hash)),
        onFork: (sess) => cbRef.current.handleFork(sess, projRef.current.get(hash)),
        onArchive: (sess) => cbRef.current.handleArchive(sess),
        onDelete: (sess) => cbRef.current.handleDelete(sess),
        onTogglePin: (sid) => cbRef.current.togglePinSession(sid),
      };
      boundRef.current.set(hash, b);
    }
    return b;
  }, []);
  const flatSessions = useMemo(() => (view.groupMode === 'single'
    ? flattenSessionRows(sessionsByProject)
      .filter((s) => !pendingIds.has(s.sessionId) && (!q || String(titleOf(s) || '').toLowerCase().includes(q)))
    : EMPTY_ARRAY), [view.groupMode, sessionsByProject, pendingIds, q, titleOf]);

  // ── 添加项目(系统选择器/路径弹窗/cgui:add-project,原 ProjectList 逻辑原样)────
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addPathInput, setAddPathInput] = useState('');
  const [addError, setAddError] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  const isMobileLayout = typeof window !== 'undefined' && window.innerWidth < 768;
  const registerProjectPath = async (rawPath) => {
    const path = String(rawPath || '').trim();
    if (!path) return;
    setAddingProject(true);
    setAddError('');
    try {
      let r = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _addProject: path }),
      });
      let data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (data.needsCreate) {
        const ok = await confirmDialog(`文件夹不存在：\n${data.addedPath}\n\n是否新建该文件夹并作为项目？`);
        if (!ok) { setAddDialogOpen(false); setAddPathInput(''); return; }
        r = await fetch('/api/settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _addProject: path, _createDir: true }),
        });
        data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      }
      await fetchProjects();
      const fresh = useStore.getState().projects;
      const clean = data.addedPath || path.replace(/\/+$/, '') || '/';
      if (data.addedHash) {
        setHidden((prev) => {
          if (!prev.has(data.addedHash)) return prev;
          const next = new Set(prev);
          next.delete(data.addedHash);
          persistHidden(next);
          return next;
        });
      }
      const proj = (data.addedHash && fresh.find((p) => p.hash === data.addedHash))
        || fresh.find((p) => p.path === clean)
        || { path: clean, hash: data.addedHash || clean.replace(/[^A-Za-z0-9]/g, '-'), sessionCount: 0, lastActivity: null };
      // 单面板语义:添加成功 = 选中 + 展开该项目(旧版是切进其会话列表)。
      useStore.getState().setSelectedProject(proj);
      useStore.getState().fetchSessions(proj.hash, { silent: true });
      useStore.getState().ensureProjectExpanded(proj.hash);
      useStore.getState().fetchSessionsForPanel(proj.hash);
      try {
        const parent = clean.replace(/\/[^/]+\/?$/, '') || '/';
        localStorage.setItem('cgui-picker-last-start', parent);
      } catch {}
      const gitState = data.gitState || (data.noGitHead ? 'legacy' : 'ok');
      if (gitState !== 'ok') {
        if (gitState === 'repoNoCommit') importGitState.set(clean, gitState);
        const reasonText = {
          gitMissing: '未检测到 git',
          timeout: 'git 命令超时',
          ownership: 'git 拒绝访问该仓库（属主与当前用户不一致）',
        }[data.gitCheckReason] || data.gitCheckDetail || '原因未知';
        useStore.getState().pushCompletionToast({
          sessionId: null,
          projectHash: data.addedHash || null,
          session: null,
          title: '已添加项目',
          suffix: '提示',
          summary: gitState === 'repoNoCommit'
            ? '该目录所在的 git 仓库还没有任何提交。worktree 与回滚基线需要至少一个提交，项目栏横幅提供「创建基线提交」。'
            : gitState === 'notRepo'
              ? '该文件夹不是 git 仓库。worktree 与回滚基线不可用，项目栏横幅提供「立即初始化」。'
              : gitState === 'legacy'
                ? '该文件夹不是 git 仓库或没有提交，worktree 与回滚基线不可用，详见项目栏横幅。'
                : `git 检查未能完成（${reasonText}），未能判断该文件夹是否为 git 仓库。导入不受影响。`,
          ts: Date.now(),
        });
      }
      setAddDialogOpen(false);
      setAddPathInput('');
    } catch (err) {
      setAddError(err.message || '添加失败');
    } finally {
      setAddingProject(false);
    }
  };
  const openAddProject = async () => {
    let path = null;
    const lastStart = (() => {
      try { return localStorage.getItem('cgui-picker-last-start') || ''; } catch { return ''; }
    })();
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    if (isTauri() || (isLocalHost && !isMobileLayout)) {
      try {
        const data = await pickDirectory({ prompt: '选择项目目录', startDir: lastStart || undefined });
        if (data.path === null) return;
        path = data.path;
      } catch {
        setAddDialogOpen(true);
        return;
      }
    }
    if (!path) {
      setAddDialogOpen(true);
      return;
    }
    await registerProjectPath(path);
  };
  const openAddProjectRef = useRef(openAddProject);
  openAddProjectRef.current = openAddProject;
  useEffect(() => {
    const f = () => openAddProjectRef.current?.();
    window.addEventListener('cgui:add-project', f);
    return () => window.removeEventListener('cgui:add-project', f);
  }, []);

  // ── 全局搜索命中跳转(原 ProjectList handlePickHit,选中链路走旧槽)────────────
  const handlePickHit = async (hit) => {
    const project = projects.find((p) => p.hash === hit.projectHash);
    if (project) {
      const st = useStore.getState();
      st.setSelectedProject(project);
      await st.fetchSessions(project.hash);
      st.ensureProjectExpanded(project.hash);
      st.fetchSessionsForPanel(project.hash);
      const list = useStore.getState().sessions;
      const target = list.find((s) => s.sessionId === hit.sessionId);
      if (target) {
        useStore.getState().setSelectedSession(target);
        useStore.getState().fetchMessages(target.sessionId, target.projectHash);
      }
    }
    setSearchQuery('');
  };

  // r11-p3-4:「彻底清理项目」前端入口随项目头🗑按钮按用户指令整体移除
  // (原 purgeProject 函数一并删;POST /api/project/purge 端点保留,恢复入口时直接接回)。

  // ── r11-①:项目行「在文件夹中显示」(POST /api/reveal-path,服务端校验 ∈ 已知项目集;
  //    虚拟行(未落盘 draft)无实体目录保证,不显示该按钮)──────────────────────────
  const revealProject = async (project, e) => {
    e?.stopPropagation();
    if (!project?.path || project.virtual) return;
    try {
      const r = await fetch('/api/reveal-path', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: project.path }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        confirmDialog('打开失败：' + (d.error || r.status));
      }
    } catch (err) {
      confirmDialog('打开失败：' + err.message);
    }
  };

  // ── worktree picker(原 SessionList 逻辑,参数化 wtProject:哪个项目组打开的)────
  const [wtProject, setWtProject] = useState(null); // null=关闭;{hash,path,...}=为该项目打开
  const [worktreeList, setWorktreeList] = useState(null);
  const [newWorktreeName, setNewWorktreeName] = useState('');
  const [worktreeBranches, setWorktreeBranches] = useState([]);
  const [newWorktreeBase, setNewWorktreeBase] = useState('');
  const [wtBaseOpen, setWtBaseOpen] = useState(false);
  const wtBaseBtnRef = useRef(null);
  useEffect(() => {
    if (!wtBaseOpen) return;
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setWtBaseOpen(false);
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [wtBaseOpen]);
  const [wtExpand, setWtExpand] = useState(null);
  const [wtAgentOpen, setWtAgentOpen] = useState(false);

  const openWorktreePicker = async (project = wtProject) => {
    if (!project) return;
    setWtProject(project);
    setWorktreeList(null);
    setWtExpand(null);
    setWtBaseOpen(false);
    try {
      const r = await fetch(`/api/worktree?cwd=${encodeURIComponent(project.path)}`);
      const d = await r.json();
      if (r.ok) { setWorktreeList(d.trees || []); setWorktreeBranches(d.branches || []); }
      else setWorktreeList({ error: d.error || `${r.status}` });
    } catch (e) {
      setWorktreeList({ error: e.message });
    }
  };
  const enterWorktree = (tree) => {
    if (!tree?.path || !wtProject) return;
    // projectHash 必须按 worktree 自己的 cwd 编码(CLI 同款 dash 规则)——红线迁移项。
    const wtHash = tree.path.replace(/[^A-Za-z0-9]/g, '-');
    seedNewSessionDefaults(wtHash);
    const st = useStore.getState();
    const wtProj = st.projects.find((p) => p.hash === wtHash) || { hash: wtHash, path: tree.path, isWorktree: true, sessionCount: 0, lastActivity: null };
    st.setSelectedProject(wtProj);
    st.fetchSessions(wtHash);
    st.ensureProjectExpanded(wtHash);
    st.fetchSessionsForPanel(wtHash);
    const draft = {
      draft: true,
      draftId: newDraftId(),
      sessionId: null,
      projectHash: tree.path.replace(/[^A-Za-z0-9]/g, '-'),
      projectPath: tree.path,
      firstPrompt: `新会话 · ${tree.branch || formatPathShort(tree.path)}`,
    };
    if (splitMode) {
      st.setActiveTabSession(draft);
      st.setPaneMessages(activeTabIndex, []);
    } else {
      st.setSelectedSession(draft);
      useStore.setState({ messages: [] });
      st.setPaneMessages(0, []);
    }
    setWtProject(null);
  };
  const createWorktree = async () => {
    if (!wtProject) return;
    const name = (newWorktreeName || '').trim() || `session-${Date.now()}`;
    try {
      const r = await fetch('/api/worktree', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: wtProject.path, name, ...(newWorktreeBase ? { base: newWorktreeBase } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) return confirmDialog('创建 worktree 失败：' + d.error);
      if (d.reusedBranch) {
        confirmDialog(`已复用同名的已有分支 ${d.branch}(可能不是最新代码——是之前删 worktree 时保留下来的)。如需从最新开始,请换一个分支名。`, { confirmText: '知道了' });
      }
      enterWorktree({ path: d.path, branch: d.branch });
      setNewWorktreeName('');
      setNewWorktreeBase('');
    } catch (err) {
      confirmDialog('创建 worktree 失败：' + err.message);
    }
  };
  const revealWorktree = async (tree, e) => {
    e?.stopPropagation();
    if (!tree?.path || !wtProject) return;
    try {
      const r = await fetch('/api/worktree/reveal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: wtProject.path, path: tree.path }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        confirmDialog('打开失败：' + (d.error || r.status));
      }
    } catch (err) {
      confirmDialog('打开失败：' + err.message);
    }
  };
  const wtBaseLabel = (t) => (t.aheadBase === 'upstream' ? '上游' : (t.aheadBase || '主分支'));
  const mergeWorktree = async (tree, e) => {
    e?.stopPropagation();
    if (!tree?.path || !wtProject || tree.isMain) return;
    const mainTree = Array.isArray(worktreeList) ? worktreeList.find((t) => t.isMain) : null;
    const msg = `把分支 ${tree.branch || '(detached)'} 合并到 ${mainTree?.branch || '主工作区当前分支'}？\n\n` +
      `该分支相对${wtBaseLabel(tree)}领先 ${tree.aheadCount || 0} 个提交。合并在主工作树执行；若有冲突会自动取消,不留半合并状态。`;
    if (!(await confirmDialog(msg))) return;
    try {
      const r = await fetch('/api/worktree/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: wtProject.path, path: tree.path }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) {
        const conflicts = d.conflicts || [];
        const note = conflicts.length
          ? `合并冲突（已自动取消合并，主工作区未留下半合并状态）。冲突文件：\n\n${conflicts.slice(0, 20).join('\n')}` +
            (conflicts.length > 20 ? `\n…共 ${conflicts.length} 个` : '') +
            '\n\n请到会话里手动处理这些冲突后再合并。'
          : `合并失败：${d.error || r.status}`;
        return confirmDialog(note, { confirmText: '知道了' });
      }
      let note = `已把 ${d.branch} 合并进 ${d.targetBranch}（${d.mergedCommits} 个提交）。`;
      if (d.warning) note += `\n\n${d.warning}`;
      await confirmDialog(note, { confirmText: '好' });
      openWorktreePicker();
    } catch (err) {
      confirmDialog('合并失败：' + err.message);
    }
  };
  const deleteWorktree = async (tree, e) => {
    e?.stopPropagation();
    if (!tree?.path || !wtProject || tree.isMain) return;
    const dirty = tree.dirtyFileCount > 0;
    const hasBranch = tree.branch && tree.branch !== '(detached)';
    const aheadNote = tree.aheadCount > 0 ? `该工作树领先 ${tree.aheadCount} 个提交，删除后分支保留、提交不丢。\n` : '';
    const msg = dirty
      ? `删除这个 worktree 会丢失 ${tree.dirtyFileCount} 个未提交修改：\n${tree.path}\n\n${aheadNote}默认只删工作树文件夹，分支 ${tree.branch || ''} 保留。确定强制删除？`
      : `删除 worktree：\n${tree.path}\n\n${aheadNote}默认只删工作树文件夹，分支 ${tree.branch || ''} 保留。确定？`;
    const res = await confirmDialog(msg, {
      danger: true,
      checkbox: hasBranch ? { label: `同时删除分支 ${tree.branch}（未合并的提交会一起丢失，不可恢复）` } : null,
    });
    const confirmed = hasBranch ? res?.confirmed : res;
    if (!confirmed) return;
    const deleteBranch = hasBranch ? !!res.checked : false;
    try {
      const r = await fetch('/api/worktree', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: wtProject.path, path: tree.path, force: dirty, deleteBranch }),
      });
      const d = await r.json();
      if (!r.ok) return confirmDialog('删除失败：' + (d.error || ''));
      if (deleteBranch && d.branch && !d.branchDeleted) {
        confirmDialog(`工作树已删除，但分支 ${d.branch} 未能删除：${d.branchError || '未知原因'}`, { confirmText: '知道了' });
      }
      if (useStore.getState().selectedProject?.path === tree.path) useStore.getState().setSelectedProject(null);
      else openWorktreePicker();
    } catch (err) {
      confirmDialog('删除失败：' + err.message);
    }
  };
  const toggleWtCommits = async (t) => {
    if (wtExpand?.path === t.path && wtExpand.mode === 'commits') { setWtExpand(null); return; }
    setWtExpand({ path: t.path, mode: 'commits', loading: true });
    try {
      const qy = `cwd=${encodeURIComponent(wtProject.path)}&path=${encodeURIComponent(t.path)}`;
      const r = await fetch(`/api/worktree/commits?${qy}`);
      const d = await r.json();
      setWtExpand((s) => s && s.path === t.path
        ? (r.ok ? { ...s, loading: false, commits: d.commits || [], base: d.base }
                : { ...s, loading: false, error: d.error || `${r.status}` })
        : s);
    } catch (e) {
      setWtExpand((s) => s && s.path === t.path ? { ...s, loading: false, error: e.message } : s);
    }
  };
  const toggleWtDirty = async (t) => {
    if (wtExpand?.path === t.path && wtExpand.mode === 'dirty') { setWtExpand(null); return; }
    setWtExpand({ path: t.path, mode: 'dirty', loading: true, checked: new Set(), message: '' });
    try {
      const qy = `cwd=${encodeURIComponent(wtProject.path)}&path=${encodeURIComponent(t.path)}`;
      const r = await fetch(`/api/worktree/dirty?${qy}`);
      const d = await r.json();
      setWtExpand((s) => s && s.path === t.path
        ? (r.ok ? { ...s, loading: false, files: d.files || [], checked: new Set((d.files || []).map((f) => f.file)) }
                : { ...s, loading: false, error: d.error || `${r.status}` })
        : s);
    } catch (e) {
      setWtExpand((s) => s && s.path === t.path ? { ...s, loading: false, error: e.message } : s);
    }
  };
  const wtToggleFile = (file) => setWtExpand((s) => {
    if (!s?.checked) return s;
    const checked = new Set(s.checked);
    if (checked.has(file)) checked.delete(file); else checked.add(file);
    return { ...s, checked };
  });
  const wtCommit = async (t) => {
    const s = wtExpand;
    if (!s || s.path !== t.path) return;
    const files = [...(s.checked || [])];
    const message = (s.message || '').trim();
    if (files.length === 0) return confirmDialog('未勾选任何文件。');
    if (!message) return confirmDialog('请填写 commit message。');
    if (!(await confirmDialog(`提交 ${files.length} 个文件到 ${t.branch || t.path}？\n\n${message}`, { danger: false }))) return;
    setWtExpand((x) => x && x.path === t.path ? { ...x, committing: true } : x);
    try {
      const r = await fetch('/api/worktree/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: wtProject.path, path: t.path, files, message }),
      });
      const d = await r.json();
      if (!r.ok) { setWtExpand((x) => x && x.path === t.path ? { ...x, committing: false } : x); return confirmDialog('提交失败：' + (d.error || r.status)); }
      setWtExpand(null);
      openWorktreePicker();
    } catch (err) {
      setWtExpand((x) => x && x.path === t.path ? { ...x, committing: false } : x);
      confirmDialog('提交失败：' + err.message);
    }
  };

  // ── 渲染 ───────────────────────────────────────────────────────────────────
  return (
    <div data-cgui="sidebar" data-tour="sidebar-list" className="relative flex flex-col h-full">
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-ink-faint font-body">
            项目
          </h2>
          <div className="flex items-center gap-0.5">
            <SidebarViewMenu />
            <button
              onClick={openAddProject}
              data-cgui="add-project-btn"
              data-tour="add-project"
              className="p-1 hover:bg-canvas-warm rounded transition-colors"
              title="添加项目（系统文件选择器）"
            >
              <Plus size={14} className="text-ink-faint hover:text-accent" />
            </button>
          </div>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-ghost" />
          <input
            type="text"
            placeholder="搜索项目 / 会话 / 消息 (≥2 字符)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-cgui="sidebar-search"
            className="w-full bg-canvas border border-canvas-sunken rounded-lg pl-8 pr-3 py-1.5 text-xs text-ink placeholder-ink-ghost focus:outline-none focus:border-accent/40 font-body"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 stagger">
        {searchQuery.length >= 2 && (
          <GlobalSearchResults q={searchQuery} onPick={handlePickHit} />
        )}
        {/* ── r13-① dsh 折叠树:项目行(chevron+名称)点击折叠/展开,展开时行下直接列
            该项目会话(两页合一,「返回项目列表」退役)。hover 操作收敛为「+」新建与
            「⋯」菜单(在文件夹中显示/置顶/隐藏/worktree/归档,p5-2 弹层口径),现有能力
            一个不丢。会话行组件原样复用(16px 槽/点体系/⋯菜单/title-only 零回退)。
            WKWebView 禁 button 嵌 button:行是 div role=button,操作键是 absolute
            兄弟按钮组(沿用既有规避)。r10 数据层(sessionsByProject 懒拉/置顶广播/
            虚拟节点)零改动。 ── */}
        {/* r13-② 单列表模式:项目行隐藏,全部会话跨项目平铺按时间(会话行样式不变)。 */}
        {view.groupMode === 'single' && flatSessions.map((session) => {
          const proj = projByHash.get(session.projectHash) || { hash: session.projectHash, path: session.projectPath || '' };
          return (
            <SessionItem
              key={session.sessionId}
              session={session}
              isSelected={focusSession?.sessionId === session.sessionId}
              {...bindRow(proj)}
              forking={forking === session.sessionId}
              running={runningSessionIds.has(session.sessionId)}
              pinned={pinnedSessSet.has(session.sessionId)}
            />
          );
        })}
        {view.groupMode === 'single' && flatSessions.length === 0 && (
          <div className="px-3 py-2.5 text-[11px] text-ink-faint font-body">{q ? '没有匹配的会话' : '暂无会话'}</div>
        )}
        {view.groupMode !== 'single' && sortedRows.map((project) => {
          const hash = project.hash;
          const isSelProj = selectedProject?.hash === hash;
          const isOpen = expandedSet.has(hash);
          const rawSessions = sessionsByProject[hash];
          const showArchived = archivedOpen.has(hash);
          const activeCount = Array.isArray(rawSessions) ? rawSessions.filter((s) => !s.archived).length : null;
          const archivedCount = Array.isArray(rawSessions) ? rawSessions.filter((s) => !!s.archived).length : null;
          const hasArchiveToggle = archivedCount != null && (activeCount > 0 || archivedCount > 0);
          const groupSessions = (isOpen && Array.isArray(rawSessions))
            ? composePanelSessions({ sessions: rawSessions, pinned: pinnedSessSet, query: q, titleOf, showArchived })
              .filter((s) => !pendingIds.has(s.sessionId))
            : EMPTY_ARRAY;
          return (
            <div key={hash} className="border-b border-canvas-deep/25">
              <div className="relative group">
                <div
                  ref={projectRowRef(hash)}
                  role="button"
                  tabIndex={0}
                  data-cgui="project-row"
                  aria-expanded={isOpen}
                  onClick={() => toggleProject(hash)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleProject(hash); } }}
                  onPointerEnter={() => {
                    // r13-②:拖拽中滑过其他非置顶行 → 本地预览重排(松手才落 prefs)
                    if (drag && drag.hash !== hash && !pinnedProjSet.has(hash)) {
                      setDrag((d) => d && ({ ...d, preview: reorderManual(d.preview, d.hash, d.preview.indexOf(hash)) }));
                    }
                  }}
                  title={`${formatPath(project.path)}${project.virtual ? '（未落盘）' : ''}`}
                  className={`w-full text-left pl-2 pr-[54px] py-2 rounded-md cursor-pointer transition-colors flex items-center gap-1.5 min-w-0 ${
                    isSelProj ? 'bg-canvas-warm/50' : 'hover:bg-canvas-warm/35'
                  }`}
                >
                  <ChevronRight size={12} className={`text-ink-faint shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                  <StatusDot running={runningCwds.has(project.path)} lastActivity={project.lastActivity} />
                  <span className="text-[13px] text-ink-soft truncate font-body min-w-0">
                    {formatPathShort(project.path)}
                  </span>
                  {project.isWorktree && (
                    <span className="text-[9px] px-1 py-0.5 bg-canvas-deep/60 text-ink-faint rounded font-mono shrink-0" title="Git worktree(独立工作树,非主仓目录)">⎇</span>
                  )}
                  {pinnedProjSet.has(hash) && <Pin size={9} className="text-accent fill-accent shrink-0" />}
                </div>
                <div className="absolute top-1/2 -translate-y-1/2 right-1 flex items-center gap-0.5">
                  {view.sortMode === 'manual' && !pinnedProjSet.has(hash) && (
                    <button
                      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); setDrag({ hash, preview: nonPinnedHashes }); }}
                      onClick={(e) => e.stopPropagation()}
                      className="hidden md:flex opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md cursor-grab active:cursor-grabbing"
                      aria-label="拖拽排序"
                      title="拖拽重排(置顶项目恒在最前)"
                    >
                      <GripVertical size={12} className="text-ink-faint" />
                    </button>
                  )}
                  <button
                    data-cgui="new-session-btn"
                    data-tour="new-session"
                    onClick={(e) => { e.stopPropagation(); handleNew(project); }}
                    className="opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity p-1 hover:bg-canvas-deep/60 rounded-md"
                    aria-label="新建会话"
                    title="新建会话"
                  >
                    <Plus size={13} className="text-ink-muted" />
                  </button>
                  <ProjectRowMenu
                    project={project}
                    rowRef={projectRowRef(hash)}
                    pinned={pinnedProjSet.has(hash)}
                    showArchived={showArchived}
                    hasArchiveToggle={hasArchiveToggle}
                    archivedCount={archivedCount}
                    onReveal={(e) => revealProject(project, e)}
                    onTogglePin={() => togglePinProject(hash)}
                    onHide={() => toggleHidden(hash)}
                    onWorktree={() => openWorktreePicker(project)}
                    onToggleArchived={() => { if (!expandedSet.has(hash)) toggleProject(hash); toggleArchivedView(hash); }}
                  />
                </div>
              </div>
              {isOpen && (
                <div className="pb-1">
                  <GitInitBanner cwd={project.path} />
                  {rawSessions === undefined ? (
                    <div className="px-3 py-3 text-[11px] text-ink-faint font-body flex items-center gap-1.5">
                      <Loader2 size={11} className="animate-spin" />加载会话…
                    </div>
                  ) : groupSessions.length === 0 ? (
                    <div className="px-3 py-2.5 text-[11px] text-ink-faint font-body">
                      {accessError
                        ? <span className="text-amber-700" title={accessError}>无法读取会话目录（系统拒绝访问），会话文件没有丢失 —— 点此查看处理办法</span>
                        : q ? '没有匹配的会话' : showArchived ? '没有已归档的会话' : '暂无会话,点行尾「+」新建'}
                    </div>
                  ) : groupSessions.map((session) => (
                    <SessionItem
                      key={session.sessionId}
                      session={session}
                      isSelected={focusSession?.sessionId === session.sessionId}
                      {...bindRow(project)}
                      forking={forking === session.sessionId}
                      running={runningSessionIds.has(session.sessionId)}
                      pinned={pinnedSessSet.has(session.sessionId)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {view.groupMode !== 'single' && rows.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-ink-faint font-body">
              {q ? '没有匹配的项目' : hiddenOnly ? '所有项目都已隐藏' : '没有找到项目'}
            </p>
            {!q && !hiddenOnly && (
              <button
                onClick={openAddProject}
                className="mt-3 px-3 py-1.5 rounded-full bg-accent text-on-accent text-[12px] font-body"
              >
                添加项目文件夹
              </button>
            )}
            {hiddenOnly && (
              <button
                onClick={() => { const next = new Set(); setHidden(next); persistHidden(next); }}
                className="mt-3 px-3 py-1.5 rounded-full bg-accent text-on-accent text-[12px] font-body"
              >
                显示全部项目
              </button>
            )}
          </div>
        )}
      </div>
      {/* 删除撤销条(多条叠加,每条独立倒计时;原 SessionList 逻辑) */}
      {pendingDeletes.length > 0 && (
        <div className="absolute bottom-3 left-3 right-3 z-20 flex flex-col gap-1.5 max-h-[45%] overflow-y-auto">
          {pendingDeletes.map((p) => (
            <div key={p.session.sessionId} className="glass-popover px-3 py-2 flex items-center gap-2 animate-fade-in min-w-0">
              <Trash2 size={13} className="text-red-400 shrink-0" />
              <span className="text-[11.5px] text-ink-soft font-body truncate flex-1 min-w-0">
                已删除「{titleOf(p.session).slice(0, 18) || '(空会话)'}」
              </span>
              <span className="text-[11px] text-ink-faint font-mono shrink-0">{p.secondsLeft}s</span>
              <button
                onClick={() => undoDelete(p.session.sessionId)}
                className="shrink-0 px-2 py-0.5 text-[11px] rounded font-body bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
              >撤销</button>
            </div>
          ))}
        </div>
      )}
      {addDialogOpen && createPortal(
        <div className="fixed inset-0 z-[80] bg-black/25 flex items-end md:items-center justify-center p-3">
          <div className="w-full max-w-md rounded-panel bg-canvas border border-canvas-deep shadow-popover overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-canvas-deep">
              <div className="text-[15px] font-display font-semibold text-ink">添加项目</div>
              <button onClick={() => setAddDialogOpen(false)} className="p-1.5 rounded-lg hover:bg-canvas-warm">
                <X size={16} className="text-ink-muted" />
              </button>
            </div>
            <form
              className="p-4"
              onSubmit={(e) => {
                e.preventDefault();
                registerProjectPath(addPathInput);
              }}
            >
              <label className="block text-[12px] text-ink-muted font-body mb-2">项目路径</label>
              <input
                autoFocus
                value={addPathInput}
                onChange={(e) => { setAddPathInput(e.target.value); setAddError(''); }}
                placeholder="~/Desktop/my-project"
                className="w-full bg-canvas-warm border border-canvas-deep rounded-panel px-3 py-3 text-[16px] text-ink font-body focus:outline-none focus:border-accent/50"
              />
              {addError && <div className="mt-2 text-[12px] text-error font-body">{addError}</div>}
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setAddDialogOpen(false)} className="px-3 py-2 rounded-lg text-[13px] text-ink-muted hover:bg-canvas-warm">
                  取消
                </button>
                <button disabled={addingProject || !addPathInput.trim()} className="px-4 py-2 rounded-lg bg-accent text-on-accent text-[13px] disabled:opacity-50">
                  {addingProject ? '添加中...' : '添加'}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body,
      )}
      {wtProject && createPortal((
        <WorktreePickerModal
          wtProject={wtProject}
          worktreeList={worktreeList}
          worktreeBranches={worktreeBranches}
          newWorktreeName={newWorktreeName}
          setNewWorktreeName={setNewWorktreeName}
          newWorktreeBase={newWorktreeBase}
          setNewWorktreeBase={setNewWorktreeBase}
          wtBaseOpen={wtBaseOpen}
          setWtBaseOpen={setWtBaseOpen}
          wtBaseBtnRef={wtBaseBtnRef}
          wtExpand={wtExpand}
          setWtExpand={setWtExpand}
          wtAgentOpen={wtAgentOpen}
          setWtAgentOpen={setWtAgentOpen}
          onClose={() => setWtProject(null)}
          onRefresh={() => openWorktreePicker()}
          enterWorktree={enterWorktree}
          createWorktree={createWorktree}
          revealWorktree={revealWorktree}
          mergeWorktree={mergeWorktree}
          deleteWorktree={deleteWorktree}
          toggleWtCommits={toggleWtCommits}
          toggleWtDirty={toggleWtDirty}
          wtToggleFile={wtToggleFile}
          wtCommit={wtCommit}
          wtBaseLabel={wtBaseLabel}
        />
      ), document.body)}
    </div>
  );
}

// worktree 选择/新建弹窗(原 SessionList 内联 JSX 原样搬出为受控子组件;
// state 与动作全部由 UnifiedSidebar 持有,行为不变)。
function WorktreePickerModal({
  wtProject, worktreeList, worktreeBranches,
  newWorktreeName, setNewWorktreeName, newWorktreeBase, setNewWorktreeBase,
  wtBaseOpen, setWtBaseOpen, wtBaseBtnRef, wtExpand, setWtExpand,
  wtAgentOpen, setWtAgentOpen, onClose, onRefresh,
  enterWorktree, createWorktree, revealWorktree, mergeWorktree, deleteWorktree,
  toggleWtCommits, toggleWtDirty, wtToggleFile, wtCommit, wtBaseLabel,
}) {
  const selProjPath = useStore((s) => s.selectedProject?.path);
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-soft animate-fade-in"
      onClick={onClose}
    >
      <div
        className="glass-popover w-[480px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[min(80vh,calc(var(--app-h,100dvh)-2rem))] flex flex-col py-1 animate-glass-rise"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 text-[11px] text-ink-faint uppercase tracking-wider font-body flex items-center justify-between border-b border-canvas-deep shrink-0">
          <span>选择 / 新建 Git Worktree · {formatPathShort(wtProject.path)}</span>
          <div className="flex items-center gap-1">
            <button onClick={onRefresh} title="刷新列表"
              className="p-1 hover:bg-canvas-warm rounded" disabled={worktreeList === null}>
              <RefreshCw size={12} className={worktreeList === null ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-1 hover:bg-canvas-warm rounded">
              <X size={12} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {worktreeList === null ? (
            <div className="text-[11px] text-ink-faint py-6 text-center font-body">加载中…</div>
          ) : worktreeList.error ? (
            <div className="text-[11px] text-red-600 py-6 text-center font-body px-4">{worktreeList.error}</div>
          ) : worktreeList.length === 0 ? (
            <div className="text-[11px] text-ink-faint py-6 text-center font-body">没有现有 worktree</div>
          ) : (() => {
            const isAgentTree = (t) => /[\\/]\.claude[\\/]worktrees[\\/]agent-/.test(t.path || '');
            const agentTrees = worktreeList.filter(isAgentTree);
            const userTrees = worktreeList.filter((t) => !isAgentTree(t));
            const mainBranchName = worktreeList.find((t) => t.isMain)?.branch;
            const renderTree = (t) => (
              <div key={t.path} className="mb-1">
               <div className="flex items-stretch gap-1">
                {/* 行容器 div role=button:徽章是可点击控件,button 嵌 button 非法(WKWebView) */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (!t.prunable) enterWorktree(t); }}
                  onKeyDown={(e) => { if (!t.prunable && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); enterWorktree(t); } }}
                  title={t.prunable ? '目录已丢失(被手动删除),只能删除此记录' : undefined}
                  className={`flex-1 min-w-0 text-left px-3 py-2 rounded-lg border transition-colors group ${t.prunable ? 'opacity-50 cursor-not-allowed border-canvas-deep' : selProjPath === t.path ? 'border-accent bg-accent/8 cursor-pointer' : 'border-canvas-deep hover:bg-canvas-warm cursor-pointer'}`}
                >
                  <div className="flex items-center gap-2 mb-0.5 min-w-0 flex-wrap">
                    <GitBranch size={12} className="text-accent shrink-0" />
                    <span className="text-xs font-medium font-mono text-ink truncate min-w-0">
                      {t.branch || '(detached)'}
                    </span>
                    {t.isMain && (
                      <span className="text-[9px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono">主</span>
                    )}
                    {selProjPath === t.path && (
                      <span className="text-[9px] px-1.5 py-0.5 bg-accent/15 text-accent rounded font-mono">当前</span>
                    )}
                    {t.prunable && (
                      <span className="text-[9px] px-1.5 py-0.5 bg-red-50 text-red-600 rounded font-mono">目录已丢失</span>
                    )}
                    {t.aheadCount > 0 && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleWtCommits(t); }}
                        title={`领先${wtBaseLabel(t)} ${t.aheadCount} 个提交,点击查看列表`}
                        className={`text-[9px] px-1.5 py-0.5 rounded font-mono transition-colors ${wtExpand?.path === t.path && wtExpand.mode === 'commits' ? 'bg-accent/20 text-accent' : 'bg-sky-50 text-sky-700 hover:bg-sky-100'}`}
                      >
                        领先 {t.aheadCount} 提交
                      </button>
                    )}
                    {t.behindCount > 0 && (
                      <span
                        title={`${wtBaseLabel(t)}有 ${t.behindCount} 个此树没有的提交`}
                        className="text-[9px] px-1.5 py-0.5 rounded font-mono bg-orange-50 text-orange-700"
                      >
                        落后 {t.behindCount}
                      </span>
                    )}
                    {t.dirtyFileCount > 0 && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleWtDirty(t); }}
                        title="未提交的文件,点击勾选提交"
                        className={`text-[9px] px-1.5 py-0.5 rounded font-mono transition-colors ${wtExpand?.path === t.path && wtExpand.mode === 'dirty' ? 'bg-accent/20 text-accent' : 'bg-warning/15 text-warning hover:bg-warning/25'}`}
                      >
                        {t.dirtyFileCount} 未提交文件
                      </button>
                    )}
                  </div>
                  <div className="text-[10.5px] text-ink-faint font-mono truncate">{t.path}</div>
                  {t.lastCommit?.subject && (
                    <div className="text-[10.5px] text-ink-muted font-body truncate mt-0.5">
                      {t.lastCommit.subject}
                      <span className="text-ink-ghost ml-2 font-mono">
                        {t.lastCommit.ts ? new Date(t.lastCommit.ts).toLocaleDateString('zh-CN') : ''}
                      </span>
                    </div>
                  )}
                </div>
                {!t.prunable && (
                  <button
                    onClick={(e) => revealWorktree(t, e)}
                    title="在文件管理器中显示"
                    className="shrink-0 px-2 rounded-lg border border-canvas-deep text-ink-faint hover:text-ink hover:bg-canvas-warm transition-colors flex items-center"
                  >
                    <FolderOpen size={13} />
                  </button>
                )}
                {!t.isMain && !t.prunable && t.aheadCount > 0 && (
                  <button
                    onClick={(e) => mergeWorktree(t, e)}
                    title={`合并到 ${mainBranchName || '主工作区当前分支'}（相对${wtBaseLabel(t)}领先 ${t.aheadCount} 个提交）` + (t.behindCount > 0 ? `。该树落后${wtBaseLabel(t)} ${t.behindCount} 个提交,合并可能产生冲突` : '')}
                    className="shrink-0 px-2 rounded-lg border border-canvas-deep text-ink-faint hover:text-accent hover:border-accent/40 hover:bg-canvas-warm transition-colors flex items-center"
                  >
                    <GitMerge size={13} />
                  </button>
                )}
                {!t.isMain && (
                  <button
                    onClick={(e) => deleteWorktree(t, e)}
                    title="删除此 worktree（弹窗可勾选是否连分支一起删）"
                    className="shrink-0 px-2 rounded-lg border border-canvas-deep text-ink-faint hover:text-error hover:border-error/40 hover:bg-error-subtle transition-colors flex items-center"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
               </div>
               {wtExpand?.path === t.path && (
                 <div
                   style={{ marginRight: 35 * ((t.prunable ? 0 : 1) + (!t.isMain && !t.prunable && t.aheadCount > 0 ? 1 : 0) + (t.isMain ? 0 : 1)) }}
                   className="mt-1 ml-2 rounded-lg border border-canvas-deep bg-canvas-warm/40 p-2 animate-fade-in">
                   {wtExpand.loading ? (
                     <div className="text-[10.5px] text-ink-faint py-2 text-center font-body">加载中…</div>
                   ) : wtExpand.error ? (
                     <div className="text-[10.5px] text-red-600 py-2 text-center font-body px-2">{wtExpand.error}</div>
                   ) : wtExpand.mode === 'commits' ? (
                     (wtExpand.commits || []).length === 0 ? (
                       <div className="text-[10.5px] text-ink-faint py-2 text-center font-body">没有领先的提交</div>
                     ) : (
                       <div className="flex flex-col gap-1">
                         {wtExpand.commits.map((c) => (
                           <div key={c.sha} className="flex items-baseline gap-2 min-w-0">
                             <span className="text-[10px] font-mono text-accent shrink-0">{c.sha.slice(0, 7)}</span>
                             <span className="text-[10.5px] text-ink-soft font-body truncate min-w-0 flex-1">{c.subject}</span>
                             <span className="text-[9.5px] text-ink-ghost font-mono shrink-0">
                               {c.ts ? new Date(c.ts).toLocaleDateString('zh-CN') : ''}
                             </span>
                           </div>
                         ))}
                       </div>
                     )
                   ) : (
                     (wtExpand.files || []).length === 0 ? (
                       <div className="text-[10.5px] text-ink-faint py-2 text-center font-body">没有未提交的文件</div>
                     ) : (
                       <div className="flex flex-col gap-1.5">
                         <div className="max-h-40 overflow-y-auto flex flex-col gap-0.5">
                           {wtExpand.files.map((f) => (
                             <label key={f.file} className="flex items-center gap-2 min-w-0 cursor-pointer hover:bg-canvas-warm rounded px-1 py-0.5">
                               <input
                                 type="checkbox"
                                 checked={wtExpand.checked?.has(f.file) || false}
                                 onChange={() => wtToggleFile(f.file)}
                                 className="shrink-0"
                               />
                               <span className="text-[9.5px] font-mono text-amber-700 shrink-0 w-5">{f.status || '?'}</span>
                               <span className="text-[10.5px] font-mono text-ink-soft truncate min-w-0">{f.file}</span>
                             </label>
                           ))}
                         </div>
                         <input
                           type="text"
                           value={wtExpand.message || ''}
                           onChange={(e) => setWtExpand((s) => s && s.path === t.path ? { ...s, message: e.target.value } : s)}
                           placeholder="commit message"
                           className="w-full bg-canvas border border-canvas-deep rounded px-2 py-1 text-[11px] font-mono text-ink focus:outline-none focus:border-accent/40"
                         />
                         <div className="flex items-center justify-between gap-2">
                           <span className="text-[10px] text-ink-faint font-body">已选 {wtExpand.checked?.size || 0} / {wtExpand.files.length} 个文件</span>
                           <button
                             type="button"
                             disabled={wtExpand.committing}
                             onClick={() => wtCommit(t)}
                             className="btn-accent px-3 py-1 text-[10.5px] font-body disabled:opacity-50"
                           >
                             {wtExpand.committing ? '提交中…' : '提交所选'}
                           </button>
                         </div>
                       </div>
                     )
                   )}
                 </div>
               )}
              </div>
            );
            return (
              <>
                {userTrees.map(renderTree)}
                {agentTrees.length > 0 && (
                  <div className="mt-1">
                    <button
                      type="button"
                      onClick={() => setWtAgentOpen((v) => !v)}
                      className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10.5px] text-ink-faint font-body hover:bg-canvas-warm rounded-lg transition-colors"
                    >
                      <ChevronDown size={11} className={`transition-transform ${wtAgentOpen ? '' : '-rotate-90'}`} />
                      <span>agent 临时工作树</span>
                      <span className="font-mono">×{agentTrees.length}</span>
                    </button>
                    {wtAgentOpen && agentTrees.map(renderTree)}
                  </div>
                )}
              </>
            );
          })()}
        </div>
        <div className="border-t border-canvas-deep p-3 bg-canvas-warm/40 shrink-0">
          <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body mb-1.5">新建 worktree</div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={newWorktreeName}
              onChange={(e) => setNewWorktreeName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createWorktree()}
              placeholder="分支名 (如 feature-X)"
              className="flex-1 min-w-0 bg-canvas border border-canvas-deep rounded px-2 py-1 text-[11px] font-mono text-ink focus:outline-none focus:border-accent/40"
            />
            {worktreeBranches.length > 0 && (
              <div ref={wtBaseBtnRef} className="relative shrink-0 max-w-[38%]">
                <button
                  type="button"
                  onClick={() => setWtBaseOpen((v) => !v)}
                  title="新工作树里的代码从哪条分支的最新提交开始复制。默认=当前分支"
                  className="w-full flex items-center gap-1 bg-canvas border border-canvas-deep rounded px-1.5 py-1 text-[11px] font-mono text-ink focus:outline-none focus:border-accent/40 hover:border-accent/40"
                >
                  <span className="truncate flex-1 text-left">{newWorktreeBase ? `起点：${newWorktreeBase}` : '起点：当前分支'}</span>
                  <ChevronDown size={11} className={`shrink-0 text-ink-faint transition-transform ${wtBaseOpen ? 'rotate-180' : ''}`} />
                </button>
                <AnchoredPopover anchorRef={wtBaseBtnRef} open={wtBaseOpen} onRequestClose={() => setWtBaseOpen(false)}
                  drop="up" align="right"
                  className="w-60 max-w-[calc(var(--app-w,100vw)-1.5rem)] py-1 max-h-56 overflow-y-auto">
                  {['', ...worktreeBranches.slice(0, 50)].map((b) => (
                    <button
                      key={b || '(HEAD)'}
                      type="button"
                      onClick={() => { setNewWorktreeBase(b); setWtBaseOpen(false); }}
                      className={`w-full text-left px-2.5 py-1 text-[11px] font-mono truncate hover:bg-canvas-warm ${newWorktreeBase === b ? 'text-accent' : 'text-ink-soft'}`}
                    >
                      {b ? b : '当前分支（默认）'}
                    </button>
                  ))}
                  {worktreeBranches.length > 50 && (
                    <button type="button" disabled
                      className="w-full text-left px-2.5 py-1 text-[10px] font-body text-ink-faint cursor-default">
                      (仅显示前 50 条,共 {worktreeBranches.length} 条)
                    </button>
                  )}
                </AnchoredPopover>
              </div>
            )}
            <button
              onClick={createWorktree}
              className="btn-accent px-3 py-1 text-[11px] font-body"
            >
              新建
            </button>
          </div>
          <p className="text-[10px] text-ink-faint font-body mt-1.5">
            创建 <code className="font-mono">gui/&lt;name&gt;</code> 分支 + 检出到隔离工作树
          </p>
        </div>
      </div>
    </div>
  );
}
