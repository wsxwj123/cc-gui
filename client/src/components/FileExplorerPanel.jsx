import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderOpen, File, RefreshCw, AlertCircle, ChevronRight, ChevronDown, FileText, Image as ImageIcon, ExternalLink, Film, Pencil, Save, Undo2, Redo2, X, Check, Trash2, AtSign, MoreVertical, ListChecks, Square, CheckSquare, Eye, EyeOff, ClipboardCopy } from 'lucide-react';
import { useStore } from '../stores/sessionStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { ArtifactPreview } from './ArtifactPreview.jsx';
import { useResizable, Splitter } from '../hooks/useResizable.jsx';
import { copyText } from '../utils/clipboard.js';
import { copyButtonKind, pickCopySource, canCopyImageBitmap, copyImageBitmap, COPY_TEXT_MAX_BYTES } from '../utils/fileCopy.js';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac']);

function rawUrl(path) {
  return `/api/files/read?path=${encodeURIComponent(path)}&raw=1`;
}

// Open a file with the OS default app (Finder/Explorer double-click behaviour).
async function openWithDefaultApp(path) {
  try {
    await fetch('/api/files/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  } catch {}
}

function ext(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}
function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

// ── 待删除项:模块作用域(刻意不放组件 state)────────────────────────
// 10 秒倒计时是【撤销窗】,它的存活不能取决于面板是否挂载:Esc 关面板、切到别的面板、打开
// ArtifactDock 都会卸载本组件。此前"卸载即 flush(立即真删)"把「点完删除按个 Esc」变成
// 「文件当场永久删除」(服务端 rm -r 不进废纸篓,单文件删除路径又没有确认框),撤销条随面板
// 一起消失 —— 撤销窗静默作废。现在倒计时活在模块态:卸载既不取消也不提前兑现,到点照删;
// 重开面板还能看见剩余秒数并撤销。真正的退出(关窗/退 app)由 beforeunload 兜底立即兑现。
// ⚠️ 定时器回调只碰模块态 + fetch,绝不引用组件 state(触发时组件可能早已卸载);UI 更新
// 走订阅通知,重挂载的实例直接读本表渲染。
const pendingDeletes = new Map(); // path -> { name, parentPath, isRoot, rootPath, deadline, deleting, timer }
// 挂载中的面板实例回调 { onChange, onDone }。StrictMode 双挂载 = 两份订阅,各自增删互不干扰,
// 模块态不受挂载/卸载影响(卸载只摘订阅,绝不清表)。
const panelSubs = new Set();
function notifyPending() {
  for (const h of [...panelSubs]) { try { h.onChange(); } catch {} }
}

function deleteBody(path, item) {
  // 服务端要求显式确认;allowRoot 仅根删除流程带上(已过"删除项目文件夹"危险确认框)
  return JSON.stringify({ path, rootPath: item.rootPath, confirm: true, ...(item.isRoot ? { allowRoot: true } : {}) });
}

// 真删(定时器到点 / beforeunload 兜底共用)。开头从表里取不到 = 已撤销或已执行 → 幂等返回。
async function firePendingDelete(path) {
  const item = pendingDeletes.get(path);
  if (!item || item.deleting) return;
  if (item.timer) { clearTimeout(item.timer); item.timer = null; }
  // 进入真删前先标 deleting:大目录删除要数秒,这期间横条不能再显示"可撤销"
  // (点撤销只会清 UI 而文件照删=假撤销)。deleting 后横条改显"删除中…"并禁用撤销。
  item.deleting = true;
  notifyPending();
  let error = null;
  try {
    const r = await fetch('/api/files/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: deleteBody(path, item),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `${r.status}`);
  } catch (e) { error = e; }
  pendingDeletes.delete(path);
  notifyPending();
  // 挂载中的实例刷新树/清空态;没有实例挂载时什么都不用做 —— 面板重挂载会清 dirs 缓存重拉整棵树。
  for (const h of [...panelSubs]) { try { h.onDone(path, item, error); } catch {} }
  if (error) {
    const { confirmDialog } = await import('../utils/confirmDialog.jsx');
    confirmDialog(`删除失败:${error.message}`, { confirmText: '知道了' });
  }
}

// 撤销:只在定时器还在(未进入真删)时有效。
function undoPendingDelete(path) {
  const item = pendingDeletes.get(path);
  if (!item || !item.timer) return;
  clearTimeout(item.timer);
  pendingDeletes.delete(path);
  notifyPending();
}

// 退出 app / 关窗 / 刷新:已确认的删除意图立即兑现。此刻 fetch 会随页面销毁被中断,
// 用 sendBeacon(浏览器负责把请求送出去)。ponytail:尽力而为 —— 送不出去的最坏结果是
// 文件没删成(失败方向安全),不为此再造重试队列。
function flushPendingDeletesOnExit() {
  for (const [path, item] of pendingDeletes) {
    if (item.deleting) continue; // 请求已在途,别再发一遍
    if (item.timer) { clearTimeout(item.timer); item.timer = null; }
    try {
      navigator.sendBeacon('/api/files/delete', new Blob([deleteBody(path, item)], { type: 'application/json' }));
    } catch {}
  }
  pendingDeletes.clear();
}
window.addEventListener('beforeunload', flushPendingDeletesOnExit);

/**
 * Tree-style file explorer with click-to-preview. Sandboxed to the current
 * session's projectPath (server-side enforced under $HOME).
 *
 * Layout: top half = tree, bottom half = preview pane. Resizable would be
 * nice but cramped right-side panels don't need it.
 */
export function FileExplorerPanel() {
  // Follow the active pane in split mode so the tree reflects whichever
  // session has focus. Falls back to selectedSession / selectedProject in
  // single-pane mode.
  const selectedSession = useStore((s) => s.selectedSession);
  const paneSessions = useStore((s) => s.paneSessions);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const selectedProject = useStore((s) => s.selectedProject);
  // Follow whichever pane has focus (multi-pane: 0..5), falling back to pane 0.
  const activeSession = paneSessions?.[activeTabIndex] || selectedSession;
  const rootPath = activeSession?.projectPath || selectedProject?.path || '';

  // Map<absPath, { entries, loading, error }> — cached so re-expand is instant.
  const [dirs, setDirs] = useState({});
  const [expanded, setExpanded] = useState(() => new Set([rootPath].filter(Boolean)));
  const [selectedFile, setSelectedFile] = useState(null);
  const [preview, setPreview] = useState(null); // { path, content, size, binary, truncated, loading, error }
  // Top tree pane height (px). Bottom preview takes the remainder. Dragable
  // splitter sits between them. Persists across sessions.
  const [treeHeight, onSplitDrag] = useResizable({
    initial: 280, min: 100, max: 600, axis: 'y', storageKey: 'cgui-files-tree-h',
  });

  // 显示隐藏文件(.git/node_modules 等 SKIP_DIRS)。ref 供 fetchDir/watcher 读当前值避免闭包过期。
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem('cgui-files-show-hidden') === '1');
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;

  const fetchDir = useCallback(async (path) => {
    setDirs((prev) => ({ ...prev, [path]: { ...(prev[path] || {}), loading: true, error: null } }));
    try {
      const r = await fetch(`/api/files/list?path=${encodeURIComponent(path)}${showHiddenRef.current ? '&all=1' : ''}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `${r.status}`);
      setDirs((prev) => ({ ...prev, [path]: { entries: d.entries || [], loading: false, error: null } }));
    } catch (e) {
      setDirs((prev) => ({ ...prev, [path]: { entries: [], loading: false, error: e.message } }));
    }
  }, []);

  // Load root + reset when project changes.
  useEffect(() => {
    if (!rootPath) return;
    setDirs({});
    setExpanded(new Set([rootPath]));
    setSelectedFile(null);
    setPreview(null);
    // 面板是常驻单实例,切项目必须复位跨项目危险状态(fable 审查 P1/P2):
    // rootGone 不复位=新项目永远"项目已删除"空态;多选集不复位=在 B 项目树下批量删掉 A 的文件。
    setRootGone(false);
    setSelMode(false);
    setSelected(new Set());
    fetchDir(rootPath);
  }, [rootPath, fetchDir]);

  // ── 实时刷新:订阅项目目录 fs 变动(server 递归 watcher → WS → window 事件)──
  // 只刷"已展开且已缓存"的目录:变动路径的父目录(或路径自身是目录)命中才 refetch,
  // 不做全树刷新。前端再聚合 300ms 去抖(server 侧已按根 500ms 聚合一次)。
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  useEffect(() => {
    if (!rootPath) return;
    // 起 watcher(幂等:server 对已监听的根只刷新 lastUsed)。失败(如平台不支持
    // 递归 watch)静默降级为手动刷新。
    const watch = () => fetch('/api/files/watch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: rootPath }),
    }).catch(() => {});
    watch();
    // 60s 心跳重发:server 重启 / LRU 淘汰(>5 项目)/ watcher error 自删后,原订阅
    // 静默失效且无任何信号 → 周期性重发同一幂等 POST 自愈,顺带刷 lastUsed 降低被踢。
    const heartbeat = setInterval(watch, 60_000);
    const pendingDirs = new Set();
    let timer = null;
    const onChange = (e) => {
      const { root, paths } = e.detail || {};
      if (!root || !Array.isArray(paths)) return;
      const parentOf = (p) => p.replace(/[/\\][^/\\]*$/, ''); // 按 / 和 \ 切,兼容 Windows
      for (const p of paths) {
        // dirs 缓存 key 是混合形态:根 key 用面板的 rootPath(lexical),子目录 key 用
        // /files/list 返回的 realpath 前缀。广播路径带 realpath 前缀 → 原样 + 重定基到
        // rootPath 两种形态都当候选;外项目广播不会命中本面板缓存 key,天然被过滤。
        const cands = [p, parentOf(p)];
        if (root !== rootPath && p.startsWith(root)) {
          const rp = rootPath + p.slice(root.length);
          cands.push(rp, parentOf(rp));
        }
        for (const cand of cands) {
          if (expandedRef.current.has(cand) && dirsRef.current[cand]) pendingDirs.add(cand);
        }
      }
      if (pendingDirs.size && !timer) {
        timer = setTimeout(() => {
          timer = null;
          const dirsToFetch = [...pendingDirs];
          pendingDirs.clear();
          dirsToFetch.forEach((d) => fetchDir(d));
        }, 300);
      }
    };
    window.addEventListener('cgui:project-file-change', onChange);
    return () => {
      window.removeEventListener('cgui:project-file-change', onChange);
      if (timer) clearTimeout(timer);
      clearInterval(heartbeat);
    };
  }, [rootPath, fetchDir]);

  const toggle = (path, isDir) => {
    if (!isDir) return;
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else {
        n.add(path);
        if (!dirs[path]) fetchDir(path);
      }
      return n;
    });
  };

  const openFile = useCallback(async (entry) => {
    setSelectedFile(entry.path);
    setPreview({ path: entry.path, loading: true, name: entry.name, size: entry.size });
    try {
      const r = await fetch(`/api/files/read?path=${encodeURIComponent(entry.path)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `${r.status}`);
      setPreview({ ...d, name: entry.name, loading: false });
    } catch (e) {
      setPreview({ path: entry.path, name: entry.name, loading: false, error: e.message });
    }
  }, []);

  // ── 右键菜单 + 删除(10s 可撤销) ──────────────────────────────
  // 删除 = 前端延迟提交:点删除后条目立即从树里隐藏、出可撤销横条倒计时,10 秒后才真调
  // 后端删除;撤销 = 摘掉队列条目恢复显示。待删表在模块作用域(见文件顶部 pendingDeletes):
  // 关面板/切面板不影响倒计时,退出 app 才由 beforeunload 立即兑现。
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, entry:{path,name,isDir,isRoot,parentPath} }
  const [nowTick, setNowTick] = useState(Date.now());
  const [, bumpPending] = useState(0); // 模块态 pendingDeletes 变更时重渲染
  // 订阅模块级待删表:卸载只摘订阅(倒计时继续跑),重挂载直接读表 → 面板关了再开,
  // 撤销条与剩余秒数原样还在。
  useEffect(() => {
    const h = {
      onChange: () => bumpPending((n) => n + 1),
      onDone: (path, item, error) => {
        if (!error) {
          // 根删成功:清树缓存并进入"项目已删除"空态——否则 pending 清除后根行取消隐藏,
          // 旧 dirs 缓存把整棵已删的树原样渲染回来(幽灵树,点刷新才报错)。
          if (item.isRoot) { setDirs({}); setExpanded(new Set()); setRootGone(true); }
          // 单删成功后从多选集剔除该路径及其子项:否则随后的批量删除对已删路径再发请求,误报"删除失败"
          setSelected((prev) => {
            if (!prev.size) return prev;
            const n = new Set([...prev].filter((x) => !(x === path || x.startsWith(path + '/') || x.startsWith(path + '\\'))));
            return n.size === prev.size ? prev : n;
          });
        }
        if (item.parentPath) fetchDir(item.parentPath);
      },
    };
    panelSubs.add(h);
    setNowTick(Date.now()); // 重挂载时倒计时首帧就用当前时刻,不显示陈旧秒数
    return () => { panelSubs.delete(h); };
  }, [fetchDir]);
  const pendingItems = [...pendingDeletes.entries()];
  useEffect(() => {
    if (!pendingItems.length) return;
    const id = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(id);
  }, [pendingItems.length]);

  // Esc 关闭菜单:与遮罩外部点击共关同一 ctxMenu state,右键/⋮ 两种打开方式行为一致。
  // 捕获阶段拦下 + stopPropagation:阻断冒泡阶段的「双击 Esc 停止流」监听(App 挂在
  // window 冒泡阶段),避免关菜单的 Esc 被计入停止连击。与 App 速查面板 Esc 同款口径。
  useEffect(() => {
    if (!ctxMenu) return;
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setCtxMenu(null);
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [ctxMenu]);

  const onCtx = useCallback((e, entry) => {
    e.preventDefault();
    e.stopPropagation();
    // ÷z:clientX/Y 是视觉 px(整个 UI 已 ×--ui-zoom,默认 1.2),但 portal 到 body 的
    // fixed 菜单 left/top 按布局 px 解释,不除缩放会把菜单渲染到 clientX×z 处飞出视口(=真机"点了没反应")。
    // 与检查点菜单/上下文用量菜单同款范式。z=1 时行为不变。贴边防溢出:菜单约 190x120,留余量。
    const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
    const x = Math.min(e.clientX / z, window.innerWidth / z - 200);
    const y = Math.min(e.clientY / z, window.innerHeight / z - 150);
    setCtxMenu({ x, y, entry });
  }, []);

  // 可传 path 调用(右键菜单 + 预览栏按钮共用)。预览栏按钮是无右键场景的兜底入口。
  const addPathToContext = useCallback((path) => {
    let rel = rootPath && path.startsWith(rootPath) ? path.slice(rootPath.length).replace(/^[/\\]+/, '') : path;
    rel = rel.replace(/\\/g, '/');
    // targetKey 与 SessionDetail 的 sessionQueueKey 同构,分屏时只填活跃 pane 的输入框
    const targetKey = activeSession?.sessionId || `draft-${activeSession?.projectHash || 'none'}`;
    window.dispatchEvent(new CustomEvent('cgui:composer-fill', { detail: { text: `@${rel} `, append: true, targetKey } }));
    setCtxMenu(null);
  }, [rootPath, activeSession?.sessionId, activeSession?.projectHash]);

  const deletePath = useCallback(({ path, name, parentPath, isRoot }) => {
    setCtxMenu(null);
    // 删除的是当前预览的文件(或其所在目录)→ 立即清预览。子路径判定要同时认 / 和 \\ —
    // Windows 的 /api/files/list 返回反斜杠路径,只判 '/' 会让删目录后其内预览/选中态残留。
    const underPath = (x) => x === path || x.startsWith(path + '/') || x.startsWith(path + '\\');
    setPreview((p) => (p && underPath(p.path) ? null : p));
    setSelectedFile((sf) => (sf && underPath(sf) ? null : sf));
    if (pendingDeletes.has(path)) return; // 已在待删队列,不重复排期
    const item = {
      name, parentPath, isRoot: !!isRoot, rootPath,
      deadline: Date.now() + 10_000, deleting: false, timer: null,
    };
    // 定时器与真删逻辑都在模块作用域:面板卸载不取消也不提前兑现(见 pendingDeletes 注释)。
    item.timer = setTimeout(() => firePendingDelete(path), 10_000);
    pendingDeletes.set(path, item);
    setNowTick(Date.now()); // 初显就用当前时刻,避免陈旧 tick 让倒计时首帧显示错误秒数
    notifyPending();
  }, [rootPath]);

  // ── 批量选择删除 ──────────────────────────────────────────────
  // 危险确认后不立即删:所选每项各进单删的 10s pending 撤销窗(与单删语义一致,用户要求)。
  const [selMode, setSelMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [rootGone, setRootGone] = useState(false); // 项目根目录已被删除 → 空态,不再渲染旧缓存"幽灵树"
  const [batchBusy, setBatchBusy] = useState(false); // 批量删除进行中:防二次点击重复触发
  const toggleSel = useCallback((path) => {
    setSelected((prev) => { const n = new Set(prev); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  }, []);
  const exitSelMode = () => { setSelMode(false); setSelected(new Set()); };
  const batchDelete = async () => {
    if (batchBusy) return;
    // 剔除"祖先也被选中"的子项:先删目录再删其内文件必 404,只删顶层所选即可覆盖全部
    const items = [...selected];
    const tops = items.filter((p) => !items.some((q) => q !== p && (p.startsWith(q + '/') || p.startsWith(q + '\\'))));
    if (!tops.length) return;
    const names = tops.map((p) => p.split(/[/\\]/).pop());
    const { confirmDialog } = await import('../utils/confirmDialog.jsx');
    const ok = await confirmDialog(
      `删除所选 ${tops.length} 项?\n\n${names.slice(0, 8).join('\n')}${tops.length > 8 ? `\n…等共 ${tops.length} 项` : ''}\n\n删除后有 10 秒可撤销。`,
      { danger: true, confirmText: `删除 ${tops.length} 项` });
    if (!ok) return;
    setBatchBusy(true);
    // 确认后不立即删:每个顶层项各进单删那套 10s pending 撤销窗(deletePath 已内含
    // 清预览/选中态 + 定时真删 + 父目录刷新 + 失败提示 + 从多选集剔除),批量与单删语义一致。
    for (const p of tops) {
      deletePath({
        path: p,
        name: p.split(/[/\\]/).pop(),
        parentPath: p.replace(/[/\\][^/\\]+$/, '') || rootPath,
      });
    }
    setBatchBusy(false);
    exitSelMode();
  };

  // 撤销走模块级 undoPendingDelete:从 pendingDeletes 摘除条目 = 定时器与 beforeunload
  // 兜底都不会再执行它。已进入删除中(请求在途)不可撤销(见其内注释)。

  if (!rootPath) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-ink-faint font-body">
        请先选择一个会话或项目
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tree pane (height controlled by splitter) */}
      {/* onContextMenu preventDefault:右键点遮罩空白关掉自家菜单后,同手势的 contextmenu 会透到
          遮罩下方元素——落在树区若不压,会弹出系统原生右键菜单("关自家菜单却弹系统菜单"很突兀)。
          只压树区不做全局压制;行上右键不受影响(行的 onCtx 已 stopPropagation,到不了这里)。 */}
      {/* 无预览时树占满全高(预览区整体不存在);有预览时按 splitter 高度分栏。 */}
      <div style={preview ? { height: treeHeight } : undefined}
        className={`overflow-y-auto px-1 py-2 ${preview ? 'shrink-0 border-b border-canvas-deep' : 'flex-1 min-h-0'}`}
        onContextMenu={(e) => e.preventDefault()}>
        <div className="flex items-center justify-between px-3 mb-2">
          <span className="text-[10px] text-ink-faint font-mono truncate" title={rootPath}>
            {rootPath.split(/[/\\]+/).slice(-2).join('/')}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => {
                const next = !showHidden;
                setShowHidden(next);
                showHiddenRef.current = next;               // 同步给 fetchDir(下面立即重拉要读到新值)
                localStorage.setItem('cgui-files-show-hidden', next ? '1' : '0');
                // 隐藏项要重新出现/消失,清缓存并重拉所有已展开目录(展开集不变)。
                setDirs({});
                [...expanded].forEach((p) => fetchDir(p));
              }}
              className={`p-1 rounded ${showHidden ? 'text-accent bg-accent/10' : 'text-ink-faint hover:text-ink'}`}
              title={showHidden ? '隐藏 .git/node_modules 等' : '显示隐藏文件(.git/node_modules 等)'}
            >{showHidden ? <Eye size={11} /> : <EyeOff size={11} />}</button>
            <button
              onClick={() => (selMode ? exitSelMode() : setSelMode(true))}
              className={`p-1 rounded ${selMode ? 'text-accent bg-accent/10' : 'text-ink-faint hover:text-ink'}`}
              title={selMode ? '退出多选' : '多选(批量删除文件/文件夹)'}
            ><ListChecks size={11} /></button>
            <button
              onClick={() => { setRootGone(false); fetchDir(rootPath); }} // 复位空态:从废纸篓恢复文件夹后点刷新即可回来
              className="p-1 text-ink-faint hover:text-ink rounded"
              title="刷新"
            ><RefreshCw size={11} /></button>
          </div>
        </div>
        {selMode && (
          <div className="mx-2 mb-1 px-2 py-1.5 rounded-lg bg-accent/10 border border-accent/20 flex items-center gap-2">
            <span className="text-[11px] font-body text-ink flex-1">已选 {selected.size} 项(点击条目勾选)</span>
            <button onClick={batchDelete} disabled={!selected.size || batchBusy}
              className="text-[11px] px-2 py-0.5 rounded bg-red-600 text-white disabled:opacity-40 hover:bg-red-700">{batchBusy ? '删除中…' : '删除所选'}</button>
            <button onClick={exitSelMode} className="text-[11px] text-ink-muted hover:text-ink">取消</button>
          </div>
        )}
        {/* 待删除横条:每项独立 10s 倒计时,点撤销恢复;进入删除中则禁用撤销 */}
        {pendingItems.map(([p, info]) => (
          <div key={p} className="mx-2 mb-1 px-2 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2">
            <Trash2 size={11} className="text-red-600 shrink-0" />
            <span className="text-[11px] font-mono text-ink truncate flex-1" title={p}>{info.name}</span>
            {info.deleting ? (
              <span className="text-[10px] text-red-600 font-body shrink-0">删除中…</span>
            ) : (
              <>
                <span className="text-[10px] text-ink-faint font-mono shrink-0">
                  {Math.max(0, Math.ceil((info.deadline - nowTick) / 1000))}s
                </span>
                <button onClick={() => undoPendingDelete(p)}
                  className="text-[11px] text-accent hover:underline shrink-0 font-body">撤销</button>
              </>
            )}
          </div>
        ))}
        {rootGone ? (
          <div className="px-4 py-8 text-center text-[12px] text-ink-faint font-body">
            项目文件夹已删除。可在侧栏项目列表移除该条目。
          </div>
        ) : (
        <TreeNode
          path={rootPath}
          name={rootPath.split(/[/\\]+/).slice(-1)[0] || '/'}
          depth={0}
          isDir
          isRoot
          parentPath={null}
          expanded={expanded}
          dirs={dirs}
          toggle={toggle}
          openFile={openFile}
          selectedFile={selectedFile}
          onCtx={onCtx}
          hidden={pendingDeletes}
          selMode={selMode}
          selected={selected}
          onToggleSel={toggleSel}
        />
        )}
      </div>

      {/* 自建右键菜单(Tauri webview 无原生右键):遮罩点击即关。
          portal 到 document.body 逃离面板 animate-glass-rise 残留 transform 的包含块,
          否则 fixed inset-0 遮罩被困在窄面板内、absolute left:clientX 飞出屏幕(真机 WKWebView bug)。 */}
      {ctxMenu && createPortal(
        <div className="fixed inset-0 z-40"
          onMouseDown={() => setCtxMenu(null)}
          // 只压默认菜单,不在这里关闭:行上 mousedown(button2) 兜底先开菜单→React 同步
          // flush 挂上本遮罩→同一手势随后的 contextmenu 落在遮罩上,若在此关闭=开了又关
          // (Chromium/WebView2 右键"没反应"的根因)。关闭已由上面的 onMouseDown(任意键)
          // 负责:右键另一行时 mousedown 关旧遮罩→contextmenu 落回行上开新菜单,天然切换。
          onContextMenu={(e) => e.preventDefault()}>
          <div className="absolute glass-popover py-1 min-w-[180px] shadow-popover"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}>
            <button onClick={() => addPathToContext(ctxMenu.entry.path)}
              className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink hover:bg-accent/10 flex items-center gap-2">
              <AtSign size={12} className="text-accent shrink-0" />添加到上下文
            </button>
            <button onClick={() => { openWithDefaultApp(ctxMenu.entry.path); setCtxMenu(null); }}
              className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink hover:bg-accent/10 flex items-center gap-2">
              <ExternalLink size={12} className="text-ink-faint shrink-0" />用默认 App 打开
            </button>
            {ctxMenu.entry.isRoot ? (
              // 项目根目录:允许删除,但先过危险确认(整个项目从磁盘移除,和删普通子目录不是一个量级)
              <button onClick={async () => {
                  const entry = ctxMenu.entry; setCtxMenu(null);
                  const { confirmDialog } = await import('../utils/confirmDialog.jsx');
                  const ok = await confirmDialog(
                    `将永久删除整个项目文件夹及其全部内容:\n${entry.path}\n\n删除后 10 秒内可在顶部横条撤销;项目条目之后可在侧栏移除。`,
                    { danger: true, confirmText: '删除整个文件夹' });
                  if (ok) deletePath(entry);
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-600 hover:bg-red-500/10 flex items-center gap-2">
                <Trash2 size={12} className="shrink-0" />删除项目文件夹…
              </button>
            ) : (
              <button onClick={() => deletePath(ctxMenu.entry)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-600 hover:bg-red-500/10 flex items-center gap-2">
                <Trash2 size={12} className="shrink-0" />删除(10 秒内可撤销)
              </button>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* 预览区(含分隔条)只在打开了预览时存在;关闭按钮把整个区域收起,树回满高。 */}
      {preview && (
        <>
          <Splitter onMouseDown={onSplitDrag} axis="y" />
          <div className="flex-1 min-h-[80px] flex flex-col bg-canvas-sunken/40">
            <PreviewBody preview={preview} onAddToContext={addPathToContext} onDelete={deletePath} onClose={() => setPreview(null)} />
          </div>
        </>
      )}
    </div>
  );
}

function TreeNode({ path, name, depth, isDir, isRoot, parentPath, expanded, dirs, toggle, openFile, selectedFile, onCtx, hidden, selMode, selected, onToggleSel }) {
  const isOpen = expanded.has(path);
  const dir = dirs[path];
  const isSelected = selectedFile === path;
  const isChecked = selMode && selected?.has(path);
  return (
    <div>
      <div
        // 多选模式:点击=勾选(根目录除外,根仍是展开/收起——批量删根走单独的根删除流程);
        // 普通模式:目录展开/收起,文件打开预览。
        onClick={() => (selMode && !isRoot) ? onToggleSel(path) : isDir ? toggle(path, true) : openFile({ path, name, size: 0 })}
        onContextMenu={(e) => onCtx && onCtx(e, { path, name, isDir, isRoot: !!isRoot, parentPath })}
        // 右键 mousedown(button===2)双保险:比 contextmenu 更早触发,菜单先开、遮罩先挂上,
        // 同手势随后的 contextmenu 落在遮罩上被压掉。(曾归因"macOS WKWebView 对 select-none
        // 不派发 contextmenu",已被同版最小复现推翻——真因是自家手势时序 bug,f2f7a8b 已修。)
        onMouseDown={(e) => { if (e.button === 2 && onCtx) onCtx(e, { path, name, isDir, isRoot: !!isRoot, parentPath }); }}
        className={`group flex items-center gap-1 px-2 py-0.5 rounded cursor-pointer text-[12px] font-body select-none ${
          isChecked ? 'bg-accent/20 text-ink' : isSelected ? 'bg-accent/15 text-accent' : 'hover:bg-canvas-warm text-ink'
        }`}
        style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
        title={path}
      >
        {selMode && !isRoot && (
          isChecked ? <CheckSquare size={12} className="shrink-0 text-accent" /> : <Square size={12} className="shrink-0 text-ink-faint" />
        )}
        {isDir ? (
          <>
            {isOpen ? <ChevronDown size={11} className="shrink-0 text-ink-faint" /> : <ChevronRight size={11} className="shrink-0 text-ink-faint" />}
            {isOpen ? <FolderOpen size={12} className="shrink-0 text-amber-600" /> : <Folder size={12} className="shrink-0 text-amber-600" />}
          </>
        ) : (
          <>
            <span className="w-[11px] shrink-0" />
            <File size={12} className="shrink-0 text-ink-faint" />
          </>
        )}
        <span className="truncate flex-1">{name}</span>
        {/* ⋮ 左键菜单入口:与右键开同一菜单的全平台兜底(触控板/无右键设备也可达)。当年因误判
            "macOS WKWebView 原生吞右键"而加,该结论已被同版最小复现推翻(真因是自家手势时序
            bug,f2f7a8b 已修,mac 右键真机可用),按钮保留作可靠入口。 */}
        {onCtx && (
          <button
            onClick={(e) => { e.stopPropagation(); onCtx(e, { path, name, isDir, isRoot: !!isRoot, parentPath }); }}
            className="shrink-0 p-0.5 rounded text-ink-faint opacity-50 group-hover:opacity-100 hover:text-ink hover:bg-canvas-deep transition-opacity"
            title="操作菜单(添加到上下文 / 打开 / 删除)">
            <MoreVertical size={11} />
          </button>
        )}
      </div>
      {isDir && isOpen && dir && (
        <>
          {dir.loading && (
            <div className="text-[10px] text-ink-faint px-3 py-1" style={{ paddingLeft: `${1.5 + depth * 0.9}rem` }}>
              加载中…
            </div>
          )}
          {dir.error && (
            <div className="text-[10px] text-red-600 px-3 py-1 flex items-center gap-1" style={{ paddingLeft: `${1.5 + depth * 0.9}rem` }}>
              <AlertCircle size={10} />{dir.error}
            </div>
          )}
          {dir.entries?.filter((e) => !hidden?.has(e.path)).map((e) => (
            <TreeNode
              key={e.path}
              path={e.path}
              name={e.name}
              depth={depth + 1}
              isDir={e.isDir}
              parentPath={path}
              expanded={expanded}
              dirs={dirs}
              toggle={toggle}
              openFile={openFile}
              selectedFile={selectedFile}
              onCtx={onCtx}
              hidden={hidden}
              selMode={selMode}
              selected={selected}
              onToggleSel={onToggleSel}
            />
          ))}
        </>
      )}
    </div>
  );
}

function PreviewBody({ preview, onAddToContext, onDelete, onClose }) {
  const e = ext(preview.name || '');
  const isImage = IMAGE_EXT.has(e);
  const isVideo = VIDEO_EXT.has(e);
  const isAudio = AUDIO_EXT.has(e);
  const isPdf = e === 'pdf'; // WKWebView/WebView2 原生渲 PDF,直接 iframe 塞 raw 字节即可
  const isMedia = isImage || isVideo || isAudio || isPdf;
  // Truncated files can't be edited — saving would write back only the first
  // 256KB and silently destroy the tail.
  const editable = !isMedia && !preview.binary && !preview.truncated && !preview.loading && !preview.error;
  const isMarkdown = e === 'md' || e === 'markdown';
  // html 默认渲染预览(带 预览/代码 切换,沙箱 iframe)。svg 已走 isImage 当图片渲染。
  const isHtml = e === 'html' || e === 'htm';

  const [editing, setEditing] = useState(false);
  // Undo/redo history of the textarea value. Bursts within 400ms collapse into
  // one entry so a word's worth of typing isn't 20 undo steps.
  const [hist, setHist] = useState({ stack: [''], ptr: 0 });
  const [savedValue, setSavedValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const lastEditAt = useRef(0);

  const value = hist.stack[hist.ptr];
  const dirty = editing && value !== savedValue;

  // Reset everything when a different file is opened, or content arrives.
  useEffect(() => {
    const c = preview.content || '';
    setEditing(false);
    setHist({ stack: [c], ptr: 0 });
    setSavedValue(c);
    setSaveErr(null);
  }, [preview.path, preview.content]);

  const pushValue = useCallback((next) => {
    setHist((h) => {
      const now = Date.now();
      const coalesce = now - lastEditAt.current < 400 && h.ptr === h.stack.length - 1;
      lastEditAt.current = now;
      if (coalesce) {
        const stack = h.stack.slice(0, h.ptr + 1);
        stack[h.ptr] = next;
        return { stack, ptr: h.ptr };
      }
      const stack = h.stack.slice(0, h.ptr + 1);
      stack.push(next);
      return { stack, ptr: stack.length - 1 };
    });
  }, []);

  const undo = useCallback(() => setHist((h) => h.ptr > 0 ? { ...h, ptr: h.ptr - 1 } : h), []);
  const redo = useCallback(() => setHist((h) => h.ptr < h.stack.length - 1 ? { ...h, ptr: h.ptr + 1 } : h), []);

  // r11-⑦:预览头「复制」——文本=复制全文(截断态回后端 raw 取完整文件,>5MB 拒绝并说明),
  // 图片=复制位图(能力检测,不支持显式提示);pdf/音视频/word 等非文本非图片二进制不显示。
  // 结果走面板内联条(自动消失),不用原生弹窗(Tauri 禁用 alert/confirm)。
  const [copyNotice, setCopyNotice] = useState(null); // { kind:'ok'|'err', text }
  const copyNoticeTimer = useRef(0);
  useEffect(() => () => clearTimeout(copyNoticeTimer.current), []);
  const flashCopy = useCallback((kind, text) => {
    clearTimeout(copyNoticeTimer.current);
    setCopyNotice({ kind, text });
    copyNoticeTimer.current = setTimeout(() => setCopyNotice(null), 2500);
  }, []);
  const copyKind = copyButtonKind({
    isImage, isVideo, isAudio, isPdf,
    binary: preview.binary, loading: preview.loading, error: preview.error, editing,
  });
  const doCopy = useCallback(async () => {
    if (copyKind === 'image') {
      if (!canCopyImageBitmap()) { flashCopy('err', '当前环境不支持复制图片'); return; }
      const r = await copyImageBitmap(rawUrl(preview.path), e);
      flashCopy(r.ok ? 'ok' : 'err', r.ok ? '已复制图片'
        : r.reason === 'unsupported' ? '当前环境不支持复制图片' : `复制失败：${r.reason}`);
      return;
    }
    const src = pickCopySource(preview);
    let text = src.text;
    if (src.from === 'backend') {
      // 截断预览只载了前 256KB —— 复制必须取完整文件;超 5MB 上限直接拒绝并说明。
      if ((preview.size || 0) > COPY_TEXT_MAX_BYTES) {
        flashCopy('err', `文件过大（${fmtSize(preview.size || 0)}），超过 5MB 复制上限，请用系统默认应用打开后复制`);
        return;
      }
      try {
        const r = await fetch(rawUrl(preview.path));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        text = await r.text();
      } catch (err) {
        flashCopy('err', `读取全文失败：${err.message}`);
        return;
      }
    }
    const ok = await copyText(text);
    flashCopy(ok ? 'ok' : 'err', ok ? '已复制' : '复制失败：剪贴板不可用');
  }, [copyKind, preview, e, flashCopy]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await fetch('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: preview.path, content: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `${r.status}`);
      setSavedValue(value);
    } catch (err) {
      setSaveErr(err.message);
    } finally {
      setSaving(false);
    }
  }, [preview.path, value]);

  // 读取中/失败态也给关闭入口(否则出错的预览只能靠点别的文件顶掉,关不掉)。
  const closeBtn = onClose ? (
    <button onClick={onClose} aria-label="关闭预览" title="关闭预览"
      className="absolute top-1 right-1 p-1 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors">
      <X size={12} />
    </button>
  ) : null;
  if (preview.loading) {
    return (
      <div className="relative flex-1 flex items-center justify-center text-[11px] text-ink-faint">
        <RefreshCw size={12} className="animate-spin mr-1.5" /> 读取中…{closeBtn}
      </div>
    );
  }
  if (preview.error) {
    return (
      <div className="relative flex-1 flex items-center justify-center text-[11px] text-red-600 gap-1.5">
        <AlertCircle size={12} />{preview.error}{closeBtn}
      </div>
    );
  }
  const HeaderIcon = isVideo || isAudio ? Film : isImage ? ImageIcon : FileText;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* flex-wrap:面板拖窄时按钮整行下折,不再溢出右缘被裁(宽面板单行无变化)。 */}
      <div className="px-3 py-1.5 border-b border-canvas-deep bg-canvas-warm/60 flex flex-wrap items-center gap-x-2 gap-y-1 shrink-0">
        <HeaderIcon size={11} className="text-ink-faint shrink-0" />
        <span className="text-[11px] font-mono text-ink truncate flex-1 min-w-[80px]" title={preview.path}>
          {preview.name}{dirty ? ' ·' : ''}
        </span>
        <span className="text-[10px] text-ink-faint font-mono shrink-0">
          {fmtSize(preview.size || 0)}{preview.truncated ? ' · 已截断' : ''}
        </span>
        {editing ? (
          <>
            <button onClick={undo} disabled={hist.ptr === 0}
              className="p-1 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep disabled:opacity-30 disabled:hover:bg-transparent shrink-0"
              title="撤回"><Undo2 size={12} /></button>
            <button onClick={redo} disabled={hist.ptr >= hist.stack.length - 1}
              className="p-1 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep disabled:opacity-30 disabled:hover:bg-transparent shrink-0"
              title="重做"><Redo2 size={12} /></button>
            <button onClick={save} disabled={!dirty || saving} aria-label="保存到磁盘"
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-accent hover:bg-accent/10 disabled:opacity-40 disabled:hover:bg-transparent shrink-0"
              title="保存到磁盘">
              {saving ? <RefreshCw size={10} className="animate-spin" /> : <Save size={10} />}<span className="max-md:hidden">保存</span>
            </button>
            <button onClick={() => { setEditing(false); setHist({ stack: [savedValue], ptr: 0 }); }} aria-label="取消编辑"
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep shrink-0"
              title="取消编辑"><X size={10} /><span className="max-md:hidden">取消</span></button>
          </>
        ) : (
          <>
            {/* 预览栏标准左键按钮:任何 webview 都工作的兜底入口(与右键菜单同功能)。 */}
            {/* 手机断点(≤767px)按钮图标化(max-md:hidden 藏文字,title/aria-label 保留语义):
                四个文字按钮固定横排不换行,375px 下「删除」溢出屏幕右缘被裁。桌面空间充裕保留文字。 */}
            {onAddToContext && (
              <button onClick={() => onAddToContext(preview.path)} aria-label="在输入框 @ 引用此文件"
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-accent hover:bg-accent/10 transition-colors shrink-0"
                title="在输入框 @ 引用此文件"><AtSign size={10} /><span className="max-md:hidden">添加到上下文</span></button>
            )}
            {/* r11-⑦:复制 —— 文本复制全文(截断态取完整文件),图片复制位图;
                pdf/音视频/其余二进制不显示(copyButtonKind 判定)。 */}
            {copyKind && (
              <button onClick={doCopy}
                aria-label={copyKind === 'image' ? '复制图片' : '复制全文'}
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors shrink-0"
                title={copyKind === 'image' ? '把图片位图复制到剪贴板' : '复制文件全文到剪贴板（截断预览也复制完整文件）'}>
                <ClipboardCopy size={10} /><span className="max-md:hidden">{copyKind === 'image' ? '复制图片' : '复制全文'}</span>
              </button>
            )}
            {editable && (
              <button onClick={() => setEditing(true)} aria-label="编辑此文件"
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors shrink-0"
                title="编辑此文件"><Pencil size={10} /><span className="max-md:hidden">编辑</span></button>
            )}
            <button
              onClick={() => openWithDefaultApp(preview.path)} aria-label="用系统默认应用打开"
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors shrink-0"
              title="用系统默认应用打开"
            >
              <ExternalLink size={10} /><span className="max-md:hidden">用默认App打开</span>
            </button>
            {/* 删除只留红色垃圾桶图标(语义在 title/aria-label),不占横排宽度。 */}
            {onDelete && (
              <button
                onClick={() => onDelete({ path: preview.path, name: preview.name, parentPath: preview.path.replace(/[/\\][^/\\]*$/, '') })}
                aria-label="删除此文件（10 秒内可撤销）"
                className="p-1 rounded text-red-600 hover:bg-red-500/10 transition-colors shrink-0"
                title="删除此文件（10 秒内可撤销）"
              >
                <Trash2 size={12} />
              </button>
            )}
            {/* 主动关闭预览(此前只能一直开着);编辑态不显示,由「取消」退出防误丢编辑。 */}
            {onClose && (
              <button onClick={onClose} aria-label="关闭预览"
                className="p-1 rounded text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors shrink-0"
                title="关闭预览">
                <X size={12} />
              </button>
            )}
          </>
        )}
      </div>
      {saveErr && (
        <div className="px-3 py-1 text-[10px] text-red-600 bg-red-500/5 border-b border-canvas-deep flex items-center gap-1 shrink-0">
          <AlertCircle size={10} />保存失败：{saveErr}
        </div>
      )}
      {copyNotice && (
        <div className={`px-3 py-1 text-[10px] border-b border-canvas-deep flex items-center gap-1 shrink-0 animate-fade-in ${
          copyNotice.kind === 'ok' ? 'text-emerald-600 bg-emerald-500/5' : 'text-red-600 bg-red-500/5'
        }`}>
          {copyNotice.kind === 'ok' ? <Check size={10} /> : <AlertCircle size={10} />}{copyNotice.text}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {editing ? (
          <textarea
            value={value}
            onChange={(ev) => pushValue(ev.target.value)}
            onKeyDown={(ev) => {
              const mod = ev.metaKey || ev.ctrlKey;
              if (mod && ev.key === 's') { ev.preventDefault(); if (dirty && !saving) save(); }
              else if (mod && !ev.shiftKey && ev.key === 'z') { ev.preventDefault(); undo(); }
              else if (mod && (ev.key === 'y' || (ev.shiftKey && ev.key === 'z'))) { ev.preventDefault(); redo(); }
            }}
            spellCheck={false}
            className="w-full h-full min-h-[200px] px-3 py-2 text-[11px] font-mono leading-5 text-ink bg-canvas resize-none focus:outline-none"
          />
        ) : isImage ? (
          <div className="p-3 flex items-center justify-center">
            <img
              src={rawUrl(preview.path)}
              alt={preview.name}
              className="max-w-full max-h-[400px] object-contain rounded border border-canvas-deep"
            />
          </div>
        ) : isVideo ? (
          <div className="p-3 flex items-center justify-center">
            <video src={rawUrl(preview.path)} controls className="max-w-full max-h-[400px] rounded border border-canvas-deep" />
          </div>
        ) : isAudio ? (
          <div className="p-3">
            <audio src={rawUrl(preview.path)} controls className="w-full" />
          </div>
        ) : isPdf ? (
          <iframe
            src={rawUrl(preview.path)}
            title={preview.name}
            className="w-full h-full min-h-[400px] border-0 bg-white"
          />
        ) : preview.binary ? (
          <div className="px-3 py-4 text-[11px] text-ink-faint">
            二进制文件 · 不渲染预览（点上方「用默认App打开」查看）
          </div>
        ) : isMarkdown ? (
          <div className="px-3 py-2">
            <MarkdownRenderer content={preview.content || ''} basePath={preview.path} />
          </div>
        ) : isHtml ? (
          <div className="px-3 py-2">
            <ArtifactPreview lang="html" code={preview.content || ''} coexist />
          </div>
        ) : (
          (() => {
            // Both columns MUST derive from the SAME normalized line array.
            // A CRLF file leaves a stray `\r` at each line end; the content
            // <pre> renders those `\r` as extra visual breaks while the gutter
            // (plain numbers) does not, so the columns drift and numbers land
            // on the wrong rows. Splitting on /\r?\n/ and re-joining with \n
            // keeps the two columns line-for-line identical.
            const lines = (preview.content || '').split(/\r?\n/);
            return (
              <div className="flex text-[11px] font-mono leading-5 min-w-0">
                {/* Line-number gutter — fixed on the left while the code column
                    scrolls horizontally (VS Code behaviour). */}
                <pre className="px-2 py-2 text-right text-ink-ghost select-none border-r border-canvas-deep bg-canvas-warm/40 shrink-0">
                  {lines.map((_, i) => i + 1).join('\n')}
                </pre>
                <pre className="px-3 py-2 text-ink whitespace-pre overflow-x-auto flex-1">
                  {lines.join('\n')}
                </pre>
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}
