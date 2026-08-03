import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';

// Stable empty array reference for zustand selectors — prevents React error
// #185 (Maximum update depth exceeded) caused by returning fresh `[]` on
// every selector call. Any selector with `|| []` fallback must point here.
const EMPTY_ARRAY = Object.freeze([]);
// 已尝试过自动生成标题的 sessionId(无论成功失败),防止失败时每轮重复 spawn 标题进程。
const titleAttempted = new Set();
// Draft 会话唯一标识。draft key(`draft-<projectHash>`)按项目生成,同项目先后两个 draft
// 完全同构无法区分 → 会话A(draft)流式中 init 在途时用户新建 draft B,init 到达会把 A 的
// session_id 绑到 B 的 pane(getLocalSession() 只判"是 draft"),B 首条消息就 --resume 进
// 会话A(用户实报串扰)。每个 draft 发一个 nonce,init 绑定前比对"发起流的 draft"===当前。
let _draftSeq = 0;
const newDraftId = () => `d${Date.now()}-${++_draftSeq}`;
// CQ-15:被用户停止的 chat 进程 pid,跨所有 SessionDetail 实例(分屏多 pane)共享。
// 原来是每个 pane 私有的 useRef(new Set()),pane A 停的 pid,pane B 的 backgroundPid 轮询
// 感知不到 → 可能把 B 自己仍在跑的进程当成「需要 reattach」,reattach 的 finally 又清空 B
// 的流式状态,外观上像「停一个把两个都停了」。改成模块级共享集合即可让停止全局可见。
const stoppedChatPids = new Set();
import { useStore, THEME_FAMILIES, FONT_OPTIONS, systemPrefersDark } from './stores/sessionStore.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { MessageBubble } from './components/MessageBubble.jsx';
import { MarkdownRenderer } from './components/MarkdownRenderer.jsx';
import { TurnBubble } from './components/TurnBubble.jsx';
import TurnScrubber from './components/TurnScrubber.jsx';
import { LoadingMark, useCyclingVerb, ElapsedTime } from './components/LoadingBits.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { useMultiSelect, SelModeToggle, BatchBar, SelCheckbox } from './components/MultiSelect.jsx';
import { pickDirectory, isTauri } from './utils/pickDirectory.js';
import ChatSearch from './components/ChatSearch.jsx';
import { confirmDialog } from './utils/confirmDialog.jsx';
import { ChatInput, EffortSelector, EFFORT_LEVELS, markAutoUnavailable } from './components/ChatInput.jsx';
import { ModelBadge, ProviderAvatar } from './components/ModelBadge.jsx';
import { RemoteControlButton, ProviderSwitcher, ModelSelector, ProviderSourceBadge, AnchoredPopover } from './components/SessionSelectors.jsx';
import { mergeProviderLists, rowIsCurrent } from './utils/providerList.js';
import { UsagePanel } from './components/UsagePanel.jsx';
import { ProcessPanel } from './components/ProcessPanel.jsx';
import { SettingsPanel, ChatBackgroundCard } from './components/SettingsPanel.jsx';
import { FileExplorerPanel } from './components/FileExplorerPanel.jsx';
import { SkillsPanel } from './components/SkillsPanel.jsx';
import { GuideTour } from './components/GuideTour.jsx';
import { useResizable as useResizableHook, Splitter as SplitterCmp } from './hooks/useResizable.jsx';
import { MCPPanel } from './components/MCPPanel.jsx';
import { FileReviewPanel } from './components/FileChangesPanel.jsx';
import { MemoryPanel } from './components/MemoryPanel.jsx';
import { AgentsPanel } from './components/AgentsPanel.jsx';
import { AgentMonitorPanel } from './components/AgentMonitorPanel.jsx';
import { SubagentView } from './components/SubagentView.jsx';
import BtwWindow from './components/BtwWindow.jsx';
import EnvCheckPanel from './components/EnvCheckPanel.jsx';
import { ArtifactDock } from './components/ArtifactPreview.jsx';
import { FullDiskAccessModal } from './components/FullDiskAccessModal.jsx';
import { BUILTIN_PROVIDERS, findBuiltin } from './utils/builtinProviders.js';
import { computeCost, formatCost } from './utils/pricing.js';
import { extractToolResultText, finalizePendingToolCalls, applyFinalizedToBlocks } from './utils/toolResult.js';
import { rebuildTodosFromTaskCalls } from './utils/todos.js';
import { isInitBindingOrigin, migrateDraftQueue, paneMessagesOwned, resolveHistModel, resolveSendModel } from './utils/routing.js';
import { nativeContextWindow, isBareClaudeAlias } from './utils/contextWindow.js';
import {
  FolderOpen, MessageSquare, ChevronLeft, ChevronRight, ChevronDown,
  Search, Hash, Layers, BarChart3, ArrowLeft, Plus,
  RefreshCw, Activity, Settings, Server, GitBranch, GitMerge, FileDiff, Check, Wrench, X,
  Sun, Moon, Monitor, Bot, Camera, History, Loader2, Shield, FolderTree,
  Archive, ArchiveRestore, Trash2, EyeOff, Columns2, Smartphone, Pencil, Type, Palette,
  Menu, SquarePen, Gauge, Cpu, CheckCircle2, BookText, Sparkles, HelpCircle, Pin,
  Download, ClipboardCopy, LayoutGrid, MoreHorizontal, Star,
} from 'lucide-react';
import { buildFontEntries, groupFonts, detectFonts, platformCandidates, queryLocalFontFamilies } from './utils/systemFonts.js';
import { copyText } from './utils/clipboard.js';
import { escRoute, idleEscAction, escYieldCardId, isEditableTarget } from './utils/escAction.js';
import { isCurrentStreamTurn, resolveStreamHistCutoff, shouldRefreshHist } from './utils/reattach.js';
import { pruneByLiveSet } from './utils/levelPrune.js';
import { classifyStopTargets } from './utils/stopTargets.js';

// ── Per-session shadow-git checkpoints ──────────────────────────
// Session title with inline rename (click pencil → edit → Enter/blur saves,
// Esc cancels). Empty value reverts to the auto firstPrompt. Drafts (no stable
// sessionId yet) can't be renamed — the pencil is hidden until the first send.
function EditableSessionTitle({ session }) {
  const customTitles = useStore((s) => s.customTitles);
  const autoTitles = useStore((s) => s.autoTitles);
  const setCustomTitle = useStore((s) => s.setCustomTitle);
  const sid = session?.sessionId;
  const auto = session?.firstPrompt?.slice(0, 80) || '会话详情';
  const display = (sid && (customTitles[sid] || autoTitles[sid])) || auto;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const start = () => {
    if (!sid) return;
    setDraft((customTitles[sid] || autoTitles[sid] || session.firstPrompt || '').slice(0, 200));
    setEditing(true);
  };
  const save = () => { setCustomTitle(sid, draft); setEditing(false); };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          // 取消重命名的 Esc 已被消费,挡住 window 上的会话级监听(生成中单击即停)。
          else if (e.key === 'Escape') { e.preventDefault(); e.nativeEvent?.stopImmediatePropagation?.(); setEditing(false); }
        }}
        onBlur={save}
        maxLength={200}
        placeholder="自定义标题（留空恢复默认）"
        className="text-sm text-ink font-display font-medium bg-canvas-warm border border-accent/40 rounded px-1.5 py-0.5 w-full focus:outline-none"
      />
    );
  }
  return (
    <div className="group/title flex items-center gap-1.5 min-w-0">
      <span className="text-sm text-ink font-display font-medium truncate" title={display}>{display}</span>
      <button
        onClick={start}
        disabled={!sid}
        className="shrink-0 opacity-0 group-hover/title:opacity-100 transition-opacity p-0.5 rounded hover:bg-canvas-deep disabled:hidden"
        title="重命名会话"
      >
        <Pencil size={11} className="text-ink-faint" />
      </button>
    </div>
  );
}

function CheckpointButton({ sessionId, cwd, projectHash, onRestored, openSignal = 0 }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!sessionId) return;
    try {
      const r = await fetch(`/api/checkpoints/${sessionId}`);
      const d = await r.json();
      setEntries(d.entries || []);
    } catch {}
  };
  useEffect(() => { if (open) load(); }, [open, sessionId]);

  const snapshot = async () => {
    if (!sessionId || !cwd) return;
    setBusy(true);
    try {
      await fetch('/api/checkpoints', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, cwd, label: `checkpoint ${new Date().toLocaleTimeString()}` }),
      });
      await load();
    } catch (err) { confirmDialog('快照失败：' + err.message); }
    setBusy(false);
  };

  const restore = async (entry) => {
    const sha = typeof entry === 'string' ? entry : entry.sha;
    const ts = typeof entry === 'string' ? null : entry.ts;
    if (!(await confirmDialog(`回到该 checkpoint？\n${sha.slice(0, 7)}\n· 工作目录文件还原到此快照(覆盖未提交修改)\n· 会话消息回退到该时刻之后的内容会被裁掉`, { danger: true }))) return;
    try {
      const r = await fetch(`/api/checkpoints/${sessionId}/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha, cwd }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        confirmDialog(d.code === 'restore_failed'
          ? `还原过程出错，工作区可能已部分还原，请检查改动：${d.error || r.status}`
          : '恢复失败：' + (d.error || r.status));
        return;
      }
      // #1:checkpoint 只是 git 文件快照,不含对话锚点。用快照时间戳把会话裁剪到该时刻,
      // 消息页随之回退(否则用户点了恢复但消息页一动不动,以为"无反应")。
      // trim 结果必须检查:失败时文件已还原会话没裁,不能谎报"已裁剪";sessionReset
      // (裁空整个会话)必须切 draft,否则旧 sessionId 变僵尸、下次发送 CLI 报
      // "No conversation found" 静默失败(对齐 handleRollback 的处理)。
      let trimOk = false;
      if (projectHash && ts) {
        try {
          const tr = await fetch(`/api/sessions/${sessionId}/trim`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectHash, fromTimestamp: new Date(ts).toISOString() }),
          });
          const trData = await tr.json().catch(() => ({}));
          trimOk = tr.ok;
          if (trData?.sessionReset) {
            // 扫全部 pane(不只 selectedSession=pane0 镜像):检查点按钮可能开在 1-5 号
            // pane,或同会话开多 pane。漏扫 → 那些 pane 留僵尸 sessionId,下次发送 CLI
            // 报 "No conversation found"(本项目"按 sessionId 清理必扫全 paneSessions"惯性坑)。
            const st = useStore.getState();
            (st.paneSessions || []).forEach((p, i) => {
              if (p?.sessionId === sessionId) {
                const draftKey = `draft-${p.projectHash || 'none'}`;
                st.migrateSessionKey(sessionId, draftKey, true);
                st.setPaneSession(i, { ...p, sessionId: null, draft: true, draftId: newDraftId() });
              }
            });
          }
        } catch {}
      }
      setOpen(false);
      onRestored?.();
      confirmDialog(trimOk
        ? `已回到 checkpoint ${sha.slice(0, 7)}：文件已还原，会话已裁剪到该时刻`
        : `已回到 checkpoint ${sha.slice(0, 7)}：文件已还原，但会话消息未能裁剪（记录保持原样）`);
    } catch (err) { confirmDialog('恢复失败：' + err.message); }
  };

  // Anchor the dropdown to the button but render it in a body portal with fixed
  // positioning, so a narrow split pane's overflow:hidden can't clip it and it
  // never spills past the pane boundary (#10). Position is clamped to viewport.
  const btnRef = useRef(null);
  const [pos, setPos] = useState(null);
  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      // getBoundingClientRect 返回视觉px(×zoom),而 fixed 的 top/left 按布局px 解释。
      // 原代码把视觉px 的 r.right 和布局px 的 innerWidth 混用 → zoom>1 时钳制按错误尺度算,
      // 浮层横向偏移/溢出(与回滚菜单同根因)。统一除以 z 折算到布局px。
      const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
      const visW = window.innerWidth / z;
      const W = 288; // w-72
      let left = r.right / z - W;
      left = Math.max(8, Math.min(left, visW - 8 - W));
      setPos({ top: r.bottom / z + 8, left });
    }
    setOpen(true);
  };

  // 键盘入口(空手双击 Esc = CLI 的 Rewind):复用上面同一个 toggle,不另造面板。
  // openSignal 是时间戳:本组件挂在会话头 ⋮ 里,⋮ 收起时整个组件卸载 —— 父级会先把 ⋮ 展开,
  // 我们在挂载后的这一帧才拿到 openSignal。用"1.5s 内算新鲜"过滤掉之后用户手动展开 ⋮
  // 导致的重挂载(那时 openSignal 还是旧值,不该再自动弹)。
  const escOpenedRef = useRef(0);
  useEffect(() => {
    if (!openSignal || openSignal === escOpenedRef.current) return;
    escOpenedRef.current = openSignal;
    if (Date.now() - openSignal > 1500) return;
    if (!open) toggle();
  }, [openSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative">
      <button ref={btnRef} onClick={toggle}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-body transition-colors ${open ? 'bg-accent/15 text-accent' : 'bg-canvas-warm text-ink-faint hover:text-ink-muted'}`}
        title="Checkpoint 时间线">
        <History size={12} />检查点
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[55]" onClick={() => setOpen(false)} />
          <div className="glass-popover fixed w-72 max-w-[calc(var(--app-w,100vw)-1rem)] z-[56] py-1 animate-glass-rise"
            style={{ top: pos.top, left: pos.left }}>
            <div className="px-3 py-2 flex items-center justify-between border-b border-white/10">
              <span className="text-[10px] uppercase tracking-wider text-ink-muted font-body">Checkpoints</span>
              <button onClick={snapshot} disabled={busy} className="btn-accent flex items-center gap-1 text-[10px] px-2 py-0.5">
                <Camera size={10} />{busy ? '快照中…' : '新快照'}
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {entries.length === 0 ? (
                <p className="px-3 py-4 text-[11px] text-ink-faint text-center font-body">还没有 checkpoint</p>
              ) : entries.map((e) => (
                <button key={e.sha} onClick={() => restore(e)}
                  className="w-full text-left px-3 py-2 hover:bg-black/5 border-b border-white/5">
                  <div className="text-[11px] font-mono text-ink-soft truncate">{e.label}</div>
                  <div className="text-[9px] text-ink-faint font-mono mt-0.5">
                    {e.sha.slice(0, 7)} · {new Date(e.ts).toLocaleString('zh-CN')}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

// ── Theme popover (tone + font size + color family picker) ────────
// Theme is a (family, tone) pair. tone ∈ {light, dark, auto}; family maps to a
// data-cgui-theme variant. The follow-system option lives in the tone control;
// the font-size slider and family grid moved here from the old Settings 外观 tab.
const TONES = [
  { id: 'light', label: '浅色', Icon: Sun },
  { id: 'dark', label: '深色', Icon: Moon },
  { id: 'auto', label: '跟随系统', Icon: Monitor },
];

// Shared reading-font picker (同源体,桌面弹层 + 手机页共用)。枚举本设备可用字体
// (挂载时白名单 canvas 探测,永远可用;可选点按走 queryLocalFonts 拉全量,仅
// Chromium 桌面支持且需授权),追加在内置预设之后;收藏(per-device)置顶,带搜索、
// 滚动、每项以自身字体渲染预览。跨设备:各端枚举各自的字体(手机看手机的)。
function FontPicker() {
  const readingFont = useStore((s) => s.readingFont);
  const setReadingFont = useStore((s) => s.setReadingFont);
  const favorites = useStore((s) => s.favoriteFonts);
  const toggleFav = useStore((s) => s.toggleFavoriteFont);
  const [systemFamilies, setSystemFamilies] = useState([]);
  const [query, setQuery] = useState('');
  const [enumerating, setEnumerating] = useState(false);
  const [enumerated, setEnumerated] = useState(false);
  const [enumNote, setEnumNote] = useState('');

  // Whitelist probe on mount — cheap, works in every webview incl. WKWebView.
  useEffect(() => {
    try { setSystemFamilies(detectFonts(platformCandidates())); } catch { /* keep builtins only */ }
  }, []);

  // Optional full enumeration (this click is the required user gesture). Graceful:
  // 成功才隐藏按钮;null(不支持,如 WKWebView)/拒绝(WebView2 权限被拒)时保留白名单
  // 探测的列表并显示一行提示(W1:别静默移除按钮让用户以为点了失效)。
  const enumerateAll = async () => {
    setEnumerating(true);
    try {
      const fams = await queryLocalFontFamilies();
      if (fams && fams.length) { setSystemFamilies(fams); setEnumerated(true); setEnumNote(''); }
      else setEnumNote('此设备不支持或未授权全量枚举,已按内置字体库探测系统字体');
    } catch {
      setEnumNote('全量枚举被拒绝,已按内置字体库探测系统字体');
    } finally { setEnumerating(false); }
  };

  const entries = useMemo(() => buildFontEntries(systemFamilies), [systemFamilies]);
  const groups = useMemo(() => groupFonts(entries, favorites, query), [entries, favorites, query]);
  const canEnumerate = typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';
  const nothing = !groups.favorites.length && !groups.builtins.length && !groups.systems.length;

  const renderRow = (e) => {
    const selected = readingFont === e.key;
    const faved = favorites.includes(e.key);
    return (
      <div key={e.key} onClick={() => setReadingFont(e.key)}
        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors ${selected ? 'bg-accent/12' : 'hover:bg-canvas-warm'}`}>
        <span className="flex-1 min-w-0 truncate text-[13px] text-ink" style={{ fontFamily: e.css }} title={e.name}>{e.name}</span>
        {selected && <Check size={14} className="text-accent shrink-0" />}
        <button onClick={(ev) => { ev.stopPropagation(); toggleFav(e.key); }}
          className="shrink-0 p-0.5 text-ink-faint hover:text-amber-500" title={faved ? '取消收藏' : '收藏（置顶）'}>
          <Star size={14} className={faved ? 'fill-amber-400 text-amber-400' : ''} />
        </button>
      </div>
    );
  };
  const label = (text) => <div key={`l-${text}`} className="px-2 pt-2 pb-0.5 text-[9px] uppercase tracking-wider text-ink-faint font-body">{text}</div>;

  return (
    <div className="space-y-1.5">
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索字体…"
        className="w-full text-[11px] font-body rounded-lg border border-canvas-deep bg-canvas px-2.5 py-1.5 text-ink placeholder-ink-ghost focus:outline-none focus:border-accent" />
      <div className="max-h-[240px] overflow-y-auto -mx-0.5 px-0.5">
        {groups.favorites.length > 0 && [label('收藏'), ...groups.favorites.map(renderRow)]}
        {groups.builtins.length > 0 && [label('内置字体'), ...groups.builtins.map(renderRow)]}
        {groups.systems.length > 0 && [label('系统字体（本设备）'), ...groups.systems.map(renderRow)]}
        {nothing && <div className="px-2 py-4 text-[11px] text-ink-faint text-center font-body">没有匹配的字体</div>}
      </div>
      {canEnumerate && !enumerated && (
        <button onClick={enumerateAll} disabled={enumerating}
          className="w-full text-[10px] font-body rounded-lg border border-canvas-deep bg-canvas-warm px-2 py-1.5 text-ink-muted hover:text-ink disabled:opacity-50">
          {enumerating ? '正在枚举…' : '枚举本设备全部系统字体'}
        </button>
      )}
      {enumNote && <div className="px-2 pt-0.5 text-[10px] text-ink-faint text-center font-body leading-snug">{enumNote}</div>}
      <div className="text-[13px] text-ink-muted leading-snug px-0.5 font-reading">
        示例 The quick brown fox · 敏捷的棕色狐狸
      </div>
    </div>
  );
}

// P1.4 外观控件同源体(双入口):顶栏 ThemeToggle 弹层与 设置→外观 tab 共用这一个组件。
// 状态单一数据源 —— 全部走 sessionStore(setTheme/setUiFontScale/…/localStorage),
// 两处只是同一 store 的两个 view,不各自为政。
function ThemeAppearanceBody() {
  const themeFamily = useStore((s) => s.themeFamily);
  const themeTone = useStore((s) => s.themeTone);
  const setTheme = useStore((s) => s.setTheme);
  const extraThemeFamilies = useStore((s) => s.extraThemeFamilies);
  const uiFontScale = useStore((s) => s.uiFontScale);
  const setUiFontScale = useStore((s) => s.setUiFontScale);
  const effDark = themeTone === 'auto' ? systemPrefersDark() : themeTone === 'dark';
  const toneKey = effDark ? 'dark' : 'light';
  return (
    <>
      {/* ── Tone (light / dark / follow-system) ───────────── */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-black/5">
            {TONES.map(({ id, label, Icon }) => (
              <button key={id} onClick={() => setTheme(themeFamily, id)}
                className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11px] font-body transition-colors ${
                  themeTone === id ? 'bg-accent text-on-accent shadow-sm' : 'text-ink-muted hover:text-ink'}`}>
                <Icon size={12} /> {label}
              </button>
            ))}
          </div>

          {/* ── Font scale ────────────────────────────────────── */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Type size={12} className="text-ink-muted" />
              <span className="text-[11px] text-ink font-body font-medium">界面字体大小</span>
            </div>
            <div className="flex items-center gap-1 rounded-xl bg-canvas-warm p-0.5">
              {[
                { label: '小', value: 0.9 },
                { label: '中', value: 1 },
                { label: '大', value: 1.2 },
                { label: '超大', value: 1.45 },
              ].map(({ label, value }) => (
                <button key={label} onClick={() => setUiFontScale(value)}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] font-body transition-colors ${
                    Math.abs(uiFontScale - value) < 0.03
                      ? 'bg-accent text-on-accent shadow-sm'
                      : 'text-ink-muted hover:text-ink'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Reading font (Claude message prose) ───────────── */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Type size={12} className="text-ink-muted" />
              <span className="text-[11px] text-ink font-body font-medium">对话正文字体</span>
            </div>
            <FontPicker />
          </div>

          {/* ── Color family ──────────────────────────────────── */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Palette size={12} className="text-ink-muted" />
              <span className="text-[11px] text-ink font-body font-medium">配色外观</span>
              <span className="ml-auto text-[9px] text-ink-faint font-body">当前 {toneKey === 'dark' ? '深色' : '浅色'}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 max-h-[300px] overflow-y-auto pr-0.5">
              {[...THEME_FAMILIES, ...extraThemeFamilies].map((fam) => {
                const sw = fam[toneKey];
                const active = themeFamily === fam.id;
                return (
                  <button key={fam.id} onClick={() => setTheme(fam.id, themeTone)}
                    style={{
                      backgroundColor: sw.bg, color: sw.fg,
                      borderColor: active ? sw.accent : sw.bg2,
                      borderWidth: active ? 2 : 1,
                      boxShadow: active ? `0 0 0 3px ${sw.accent}22` : 'none',
                    }}
                    className="text-left px-2 py-2 rounded-lg border flex items-center gap-2 transition-all hover:brightness-110">
                    <div className="flex gap-0.5 shrink-0 items-stretch">
                      <div className="w-3 h-6 rounded-sm" style={{ background: sw.accent }} />
                      <div className="w-1.5 h-6 rounded-sm" style={{ background: sw.bg2 }} />
                      <div className="w-1.5 h-6 rounded-sm" style={{ background: sw.fg, opacity: 0.85 }} />
                    </div>
                    <span style={{ color: sw.fg }} className="text-[10px] font-body font-medium leading-tight flex-1 min-w-0 truncate">{fam.name}</span>
                    {active && <Check size={12} style={{ color: sw.accent }} className="shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

      {/* 聊天模式:折叠思考/工具/子代理/技能,消息流只留对话文本 */}
      <ChatModeToggle />

      {/* ── Loading 动画样式(仅挂载时渲染,30 个动画不常驻) ── */}
      <LoadingStylePicker />

      {/* ── 对话区背景(P2.3:随设置「外观」tab 删除迁入,主题弹层为外观唯一入口) ── */}
      <ChatBackgroundCard />

      {/* P3 皮肤系统落位:皮肤包选择器/管理(--skin-bg-image 等)计划挂在本弹层
          「配色外观」下方,与 THEME_FAMILIES 同级呈现(见 PLAN-skin-system.md)。 */}
    </>
  );
}

function ThemeToggle() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const themeTone = useStore((s) => s.themeTone);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    // 修正批#3:补 Esc 关闭(所有弹层统一)。stopPropagation:关弹层的 Esc 不冒到 window 上的会话级监听(生成中单击即停)。
    // R1:keydown 挂 window 捕获(与灯箱/预览/文件树等 12 处浮层同款相位)。原来挂 document
    // 冒泡 → 晚于面板监听的 document 捕获,面板开着时这一击先关面板、弹层留着(层级颠倒)。
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, [open]);

  const ToneIcon = themeTone === 'light' ? Sun : themeTone === 'dark' ? Moon : Monitor;

  return (
    <div ref={wrapRef} className="relative">
      <button onClick={() => setOpen((v) => !v)}
        data-tour="theme-toggle"
        className="px-1.5 py-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 transition-colors flex flex-col items-center gap-0.5"
        title="主题与外观">
        <ToneIcon size={15} />
        <span className="text-[9px] leading-none font-body">主题</span>
      </button>

      {/* CJ-2:桌面端也要限高+整体滚动。此前只有移动端有 max-h,桌面端弹窗内容
          (配色网格+动画网格)在大字号 zoom 下总高超过视口,动画网格的内部滚动窗口
          有一截伸到屏幕外 → 用户把内部滚动条拖到底也看不全(实报)。 */}
      {/* 修正批#3:限高单位改 --app-h(zoom 折算后的真实视口)。dvh 在 Chromium 系
          (dev/Windows WebView2)是布局px,大字号 zoom 下 ×1.45 视觉超屏(实测 976>800)。 */}
      {open && (
        <div className="absolute right-0 top-full mt-2 z-[60] w-[300px] glass-popover rounded-2xl border border-canvas-deep shadow-xl p-3 space-y-3 max-h-[calc(var(--app-h,100dvh)-6rem)] overflow-y-auto max-md:fixed max-md:left-3 max-md:right-3 max-md:top-16 max-md:w-auto max-md:mt-0 max-md:max-h-[calc(var(--app-h,100dvh)*0.78)]">
          <ThemeAppearanceBody />
        </div>
      )}
    </div>
  );
}

// 聊天模式开关:折叠 AI 的思考/工具/子代理/技能调用,消息流只留对话文本,像微信聊天。
// 全局 store.chatMode,配合「微信」主题最像微信对话。
function ChatModeToggle() {
  const chatMode = useStore((s) => s.chatMode);
  const setChatMode = useStore((s) => s.setChatMode);
  return (
    <button onClick={() => setChatMode(!chatMode)} className="w-full flex items-center gap-2 py-1 text-left">
      <MessageSquare size={12} className="text-ink-muted shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-ink font-body font-medium">聊天模式</div>
        <div className="text-[9px] text-ink-faint font-body leading-tight">折叠思考/工具/子代理/技能,只看对话文本</div>
      </div>
      <span className={`shrink-0 w-8 h-[18px] rounded-full transition-colors relative ${chatMode ? 'bg-accent' : 'bg-canvas-sunken'}`}>
        <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${chatMode ? 'left-[16px]' : 'left-[2px]'}`} />
      </span>
    </button>
  );
}

// 加载动画选择网格:每格实时跑对应动画,点击即选(存 store.loadingStyle)。
// 独立组件而非内联,避免主题弹窗其它交互(选色)时重渲整片动画网格。
function LoadingStylePicker() {
  const loadingStyle = useStore((s) => s.loadingStyle) || 'cli';
  const setLoadingStyle = useStore((s) => s.setLoadingStyle);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Loader2 size={12} className="text-ink-muted" />
        <span className="text-[11px] text-ink font-body font-medium">加载动画</span>
        <span className="ml-auto text-[9px] text-ink-faint font-body">AI 思考时的指示样式</span>
      </div>
      <div className="grid grid-cols-4 gap-1.5 max-h-[220px] overflow-y-auto pr-0.5">
        {LOADING_OPTIONS.map((opt) => {
          const active = loadingStyle === opt.id;
          return (
            <button key={opt.id} onClick={() => setLoadingStyle(opt.id)} title={opt.label}
              className={`flex flex-col items-center gap-1 px-1 py-2 rounded-lg border transition-all hover:bg-canvas-warm ${active ? 'border-accent ring-1 ring-accent/40 bg-accent/8' : 'border-canvas-deep'}`}>
              <span className="h-6 flex items-center justify-center"><LoadingMark size={20} variant={opt.id} /></span>
              <span className="text-[8.5px] text-ink-faint font-body leading-none truncate max-w-full">{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function formatPath(path) {
  if (!path) return '';
  // 家目录缩写为 ~:同时处理 macOS(/Users/x)、Linux(/home/x)、Windows(C:\Users\x)
  return path
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i, '~');
}

function formatPathShort(path) {
  if (!path) return '';
  // 取最后一段文件夹名。必须同时按 / 和 \ 切分——Windows 路径用反斜杠,
  // 只按 / 切会切不开,整条路径被当成"最后一段"返回(Win 上显示全路径的根因)。
  const parts = String(path).split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

// 模型的"原生上下文窗口"——用于顶部 x/窗口 徽章。
// 策略(用户要求):**默认按 1M 估算**,已知小于 1M 的模型显式回落到真实窗口。
// 优先级:① [1m] 后缀 / 名字里的 -Nm 标注 → N×1M;② -Nk 标注(moonshot-v1-128k)→ N×1K;
// ③ 已知更小的具体系列(见下,含 U3 实测:deepseek/mimo/GLM=200K、Kimi=256K)→ 其真实窗口;
// ④ 其余(gemini/gpt-5.x/minimax/grok-4 及未知第三方)→ 默认 1M。默认 1M 只是初始估算,
// /context 实测(优先级更高)或显式 [1m] 会进一步校正,不会因估大而误判(有超窗提示与 sane-ceiling)。
// 后端解析窗口缓存(与压缩联动同源:server /api/model-window → resolveModelWindow,
// 含 [1m]/实抓/模型名规则表/provider 手填)。key=模型名;provider 切换清空(同名模型
// 在不同 provider 窗口可能不同)。值:number=解析到;null=后端明确无解析(官方/未知,
// 前端走 nativeContextWindow 兜底);无 key=未查过。
const resolvedWindowCache = new Map();
if (typeof window !== 'undefined') {
  window.addEventListener('cgui:provider-change', () => resolvedWindowCache.clear());
}
function useResolvedWindow(model) {
  const [win, setWin] = useState(() => (model && resolvedWindowCache.has(model) ? resolvedWindowCache.get(model) : undefined));
  // provider 切换计数:同名模型跨 provider(如两家都叫 gpt-5 且被 pin)时 model 字符串不变、
  // effect 不重跑 → 清缓存也拿不到新值(判官建议2)。epoch 入 deps 强制重取。
  const [pvEpoch, setPvEpoch] = useState(0);
  useEffect(() => {
    const bump = () => setPvEpoch((n) => n + 1);
    window.addEventListener('cgui:provider-change', bump);
    return () => window.removeEventListener('cgui:provider-change', bump);
  }, []);
  useEffect(() => {
    if (!model) { setWin(undefined); return; }
    if (resolvedWindowCache.has(model)) { setWin(resolvedWindowCache.get(model)); return; }
    let dead = false;
    fetch(`/api/model-window?model=${encodeURIComponent(model)}`)
      .then((r) => r.json())
      .then((d) => {
        const v = Number.isFinite(d?.window) ? d.window : null;
        resolvedWindowCache.set(model, v);
        if (!dead) setWin(v);
      })
      .catch(() => { if (!dead) setWin(undefined); });
    return () => { dead = true; };
  }, [model, pvEpoch]);
  return win;
}

// nativeContextWindow 抽到 utils/contextWindow.js(纯函数,tests/unit/check-context-window.mjs 单测)。

// ─── Right Panel (overlay) ────────────────────────────────────
// 子代理终态收口的公共动作:标 done/error/stopped + 合成仍 pending 的子工具(U7:有些
// provider 不发子工具 tool_result,否则监控/展开视图永久转圈)+【级联收尾嵌套子代理】。
// tnStatus 来自 task_notification.status('completed'|'failed'|'stopped')或收口调用方语义。
// 级联(fable 评估):能起 Task 的自定义 agent(orchestrator 等)会再起嵌套子代理 B,B 被建成
// 独立 activeAgents 条目(无 status/无 sessionId),既不在 currentToolCalls 也不发以 B 为
// tool_use_id 的 task_notification → 三条收尾路径都够不着 → 监控永久"工作中"(用户实报)。
// B 一定是 A 的一个 toolCall(appendAgentTool(A,{id:B})),且 activeAgents[B] 存在 → 顺 toolCalls
// 找 activeAgents 里的后代递归收尾即可精确定位、仅限本流后代、天然不跨窗格。visited 防环。
// stopped 语义:tnStatus='stopped' 时,该 agent 若已 resultSeen(成功返回过)标 done,否则 stopped。
// teammate/子代理被 SendMessage 唤醒后,会有新的带 parent_tool_use_id 的 assistant 活动到达,
// 但此时 agent 可能已是终态(done/stopped/error)——append 路径只追加内容、不翻状态,监控就卡在
// 「已完成」不显示重新运行(用户报的 bug)。新活动到达且处于终态时复活为 working(清 finishedAt)。
// 只在 assistant 侧(message_start / 整条 assistant 消息)调用,不在 user/tool_result 侧,否则
// 完成后迟到的 tool_result 对账会误复活。终态判断做门控,避免每 token 抖动。
const AGENT_TERMINAL_STATUS = ['done', 'error', 'stopped'];
function reviveAgentIfTerminal(store, agentId) {
  if (!agentId) return;
  const ag = store.activeAgents?.[agentId];
  if (!ag) return;
  if (AGENT_TERMINAL_STATUS.includes(ag.status)) store.upsertAgent(agentId, { status: 'working', finishedAt: null });
}

// 按 task_id 反查 agent id(批A A4)。task_updated 的类型里没有 tool_use_id,原来只能查
// taskIdToToolUse —— 那是【每条 SSE 流的局部变量】,跨回合/reattach/刷新后为空。task_started
// 时把 taskId 钉在条目上后,这条线性扫描就是跨回合可用的第二把钥匙(条目数 <100,O(n) 够用)。
function findAgentIdByTaskId(st, taskId) {
  if (!taskId) return null;
  for (const [id, a] of Object.entries(st.activeAgents || {})) if (a?.taskId === taskId) return id;
  return null;
}

function finalizeAgent(st, agentId, tnStatus, visited, authoritative) {
  visited = visited || new Set();
  if (visited.has(agentId)) return;
  visited.add(agentId);
  const ag = st.activeAgents[agentId];
  if (!ag) return;
  // S1:权威终态一到就清 stopSingleTask 的乐观停止标记——即便 status 与乐观 stopped 同值(下面
  // 是 no-op),也必须清,否则 stopSingleTask 的假阳性回滚会把这次真终态误翻回 working。仅
  // authoritative 清:非权威的猜测性收尾不代表"确认",不解除待回滚保护。
  if (authoritative && ag.optimisticStop) st.upsertAgent(agentId, { optimisticStop: false });
  const terminal = ['done', 'error', 'stopped'].includes(ag.status);
  // 停止链路 #1(UI 侧):taskManaged 条目的 'stopped' 只是猜测——interrupt 后前端假定
  // 进程已被杀(killedRef)/流外杀点批量收尾,但 /stop 的 2s 优雅窗可能被 interrupt 秒回的
  // interrupted result 骗过而跳过 abort,后台化子代理实际还在跑。真 task_notification
  // (authoritative=true,仅两条 task_notification 路径与 task_updated 终态传入)才是权威
  // 终态,允许覆盖 stopped 为真实状态。done/error 不覆盖(那是真终态,不回翻)。
  // 乐观 stopped(optimisticStop,stopSingleTask 打在非 taskManaged 前台子代理上的)同样
  // 可覆盖:停的瞬间子代理恰好真完成、权威 completed 到达时,不应永显「已停止」(判官 S3)。
  // settledBy(批A):终态是【我们猜出来的】—— level 存活集剪枝 / 单卡停止落空。A0 实测
  // level 信号恒在权威终态事件之前 <1ms 到达,若不许覆盖,每个任务都会先被猜成"已结束",
  // 紧随其后的真状态(failed/stopped)反而被终态幂等守卫吞掉 = 状态保真度倒退。故凡带
  // settledBy 的终态一律可被权威事件覆盖,覆盖时清掉标记。
  const canOverride = !!authoritative
    && (!!ag.settledBy || (ag.status === 'stopped' && (!!ag.taskManaged || !!ag.optimisticStop)));
  if (!terminal) {
    // stopped 语义(fable A 实测修正):用户主动停止时,CLI 给顶层 agent 发的是 is_error 的
    // "interrupted"回执(resultSeen+resultIsError),那不是真失败——只有【确实成功返回过】
    // (resultSeen 且非 error)才标 done,其余一律 stopped(而非把 interrupt 回执误报成红色"错误")。
    const status = tnStatus === 'failed' ? 'error'
      : tnStatus === 'stopped'
        // 停止:仅【确实成功返回过】才 done。但 taskManaged agent 的 resultSeen 是"已派发提前回执"
        // (非真完成,真完成只认 task_notification;能走到这说明 notification 未到=仍在跑)→ stopped。
        ? (ag.resultSeen && !ag.resultIsError && !ag.taskManaged ? 'done' : 'stopped')
      : (ag.resultIsError ? 'error' : 'done');
    const patch = { status, finishedAt: Date.now() };
    if (ag.toolCalls?.some((t) => !t.result)) {
      patch.toolCalls = ag.toolCalls.map((t) => t.result ? t : { ...t, result: { content: '', isError: false, synthetic: true } });
    }
    st.upsertAgent(agentId, patch);
  } else if (canOverride) {
    // 覆盖路径直接按通知 status 映射,不掺 resultIsError——interrupt 回执会把
    // resultIsError 置真,若沿用上面的 completed→(resultIsError?error:done) 逻辑,
    // 真完成会被误标 error。状态没变(stopped→stopped)不写,避免无谓刷新 finishedAt。
    const status = tnStatus === 'failed' ? 'error' : tnStatus === 'completed' ? 'done' : 'stopped';
    // settledBy 必须清 —— 哪怕 status 恰好同值(猜的 done 撞上真 completed),留着标记
    // 卡片就会一直显示中性的"已结束"而不是绿勾"完成"。
    const patch = ag.settledBy ? { settledBy: null } : {};
    if (status !== ag.status) { patch.status = status; patch.finishedAt = Date.now(); }
    if (Object.keys(patch).length) st.upsertAgent(agentId, patch);
  }
  // 级联:本 agent 的 toolCalls 里 id 也是 activeAgents 条目的 = 它起的嵌套子代理,一并收尾。
  // 只收【还没有终态】的后代:2026-07-27 实测(P4 probe)推翻了原来"嵌套子代理永远等不到
  // 自己的 task_notification(v0.2.211)"的前提 —— 嵌套 Agent 在父流发自己的 task_started +
  // task_notification(带自己的 tool_use_id),有独立的权威终态。所以父的终态不该再往下透传
  // 覆盖:父被停而子已完成时会把子从 done/自己的权威 stopped 误翻成父的状态。子条目若是被
  // 猜出来的 stopped,由它自己的 task_notification 经上面的 canOverride 纠正(A4b 让嵌套条目
  // 在 task_started 时就带上 taskManaged,那条路走得通)。
  // 保留的这半:父终态时把【没有自己 task 事件、仍非终态】的后代一并收尾,否则监控永久转圈。
  const ag2 = st.activeAgents[agentId];
  for (const tc of (ag2?.toolCalls || [])) {
    if (tc?.id && st.activeAgents[tc.id] && !visited.has(tc.id)) {
      const child = st.activeAgents[tc.id];
      const childTerminal = ['done', 'error', 'stopped'].includes(child.status);
      if (!childTerminal) {
        finalizeAgent(st, tc.id, tnStatus, visited, authoritative);
      }
    }
  }
}

// 停止链路 #2:流外杀点(转后台后停止 handleStop backgroundPid 分支 / 监控面板停
// Claude 子进程 / 删会话 stopSessionProcs)杀掉进程后,该会话的 activeAgents 非终态
// 条目不会再收到任何流内信号(本地流 finally / 顶层 result / task_notification 都到
// 不了)→ 按 sessionId 精确扫描级联收尾为 stopped。sessionId 严格相等:分屏下不碰
// 其他会话;sessionId 为空的条目(draft 阶段/旧条目)保守不动。共享 visited:先收的
// 级联已把后代标终态,后续根条目经 visited 去重不会重复处理。
// excludeIds:服务端 /stop 选择性路径回的 keptToolUseIds —— 跨回合后台子代理本次【没被停】,
// 进程还活着,乐观标 stopped 会让监控卡片显示"已停止"、单卡停止按钮消失(终态不显),与
// 「停止后台 N」徽章(读服务端真值)互相矛盾。预置进 visited 即可同时跳过顶层扫描与级联,
// 且不碰它们的 optimisticStop / 停止按钮可用性。宁可漏标(留 working 等权威终态纠正)。
function finalizeSessionAgents(sessionId, tnStatus = 'stopped', excludeIds) {
  if (!sessionId) return;
  const st = useStore.getState();
  // 三个调用方(前台停止/删会话/杀进程)全是"该会话前台活动被终止"语义 → 记入已停表,
  // 供监控页把 workflow 内层 agent(服务端 mtime 推断、无 stopped 态)覆盖显示为已停止。
  st.markSessionStopped?.(sessionId);
  const visited = new Set(Array.isArray(excludeIds) ? excludeIds : []);
  for (const [id, ag] of Object.entries(st.activeAgents || {})) {
    if (!ag || ag.sessionId !== sessionId) continue;
    if (['done', 'error', 'stopped'].includes(ag.status)) continue;
    finalizeAgent(st, id, tnStatus, visited);
  }
}

// 修正批#7:SettingsPanelHost 已删——ProviderManager 迁出设置(providerSlot 注入不再
// 需要),PANEL_MAP 直用 SettingsPanel。

// Top-right panels — each key auto-wires a header icon (desktop + mobile menu)
// and its RightPanel body. Adding a key here is all the wiring needed.
const PANEL_MAP = {
  files: { label: '文件浏览器', icon: FolderTree, component: FileExplorerPanel },
  changes: { label: '文件审查', icon: FileDiff, component: FileReviewPanel },
  monitor: { label: 'Subagent 监控', icon: Bot, component: AgentMonitorPanel },
  agents: { label: '自定义 Agent（写入 ~/.claude/agents）', icon: SquarePen, component: AgentsPanel },
  usage: { label: '用量统计', icon: BarChart3, component: UsagePanel },
  processes: { label: '进程管理 / 停止', icon: Activity, component: ProcessPanel },
  mcp: { label: '工具（MCP 服务器 · 插件）', icon: Server, component: MCPPanel },
  skills: { label: 'Skill 市场（导入官方技能）', icon: Sparkles, component: SkillsPanel },
  memory: { label: 'CLAUDE.md 指令', icon: BookText, component: MemoryPanel },
  // 文案改名(用户指定,仅显示名,id/组件/事件不动):坞入口叫「设置」,本面板入口叫「通用」。
  settings: { label: '通用', icon: Settings, component: SettingsPanel },
};

// useResizable + Splitter live in hooks/useResizable.js — kept aliased for
// the in-file callsites below.
const useResizable = useResizableHook;
const Splitter = SplitterCmp;

// Three-column resizable layout. Sidebar | main | optional right panel.
// Widths persist to localStorage. Main has a min-width floor to stop the
// chat from collapsing when both sides are stretched.
//
// Split mode: when splitMode=true, the main column splits into two equal
// SessionDetail panes with a vertical Splitter between them. Pane widths
// are managed by a single useResizable on the left pane (right pane = 1fr).
// Clicking inside a pane focuses it (sets activeTabIndex) which drives
// sidebar clicks and right-panel data sources.
// Top-bar split toggle. Same shape as the right-panel icon buttons so it
// visually fits inline. Active state mirrors splitMode.
function PaneCountPicker() {
  const paneCount = useStore((s) => s.paneCount);
  const setPaneCount = useStore((s) => s.setPaneCount);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    // R1:window 捕获(同 ThemeToggle,详见那里注释);stopPropagation 仍挡住会话级停止监听。
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onEsc, true);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onEsc, true); };
  }, [open]);
  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title="分屏数量（1–6）"
        className={`px-1.5 py-1 rounded-lg transition-all flex flex-col items-center gap-0.5 ${
          paneCount > 1 ? 'bg-accent-subtle text-accent' : 'text-ink-muted hover:text-ink hover:bg-black/5'
        }`}
      >
        <Columns2 size={15} />
        <span className="text-[9px] leading-none font-body">分屏{paneCount > 1 ? ` ${paneCount}` : ''}</span>
      </button>
      {open && (
        <div className="glass-popover absolute right-0 top-full mt-2 w-44 z-50 py-1 animate-glass-rise">
          <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider font-body">分屏数量</div>
          <div className="grid grid-cols-3 gap-1 px-2 pb-2">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                onClick={() => { setPaneCount(n); setOpen(false); }}
                className={`py-1.5 rounded text-[12px] font-mono transition-colors ${
                  paneCount === n ? 'bg-accent text-on-accent' : 'hover:bg-canvas-warm text-ink'
                }`}
              >{n}</button>
            ))}
          </div>
          <div className="px-3 pb-2 text-[10px] text-ink-faint font-body leading-snug">
            点格选数量，再点左侧会话填入当前高亮分屏。关闭分屏用每栏右上角 ✕（不结束会话/进程）。
          </div>
        </div>
      )}
    </div>
  );
}

// P1.1 面板坞:顶栏 10 个面板按钮收纳为 1 个坞图标(Mac 折叠菜单栏式)。
// 常态只显坞图标;点击原位展开成横向图标条(rail,含原 10 个面板按钮),再点某图标开
// 对应面板;rail 持久展开 —— 再点坞图标才收起,点外部不收。rightPanel 状态机不变,rail 只是入口层。
// 更新提醒并入坞:入口红点常驻 + rail 内条件「更新」按钮(跳设置更新区)。
// 点 rail 图标后不收起:方便连续切换面板。持久展开也根治了导引 panel 步骤间 rail 被点暗区/外部收起反复开合的闪烁。
const PANEL_SHORT = {
  files: '文件', monitor: '监控', agents: 'Agent', usage: '用量', processes: '进程',
  changes: '审查', mcp: '工具', skills: '技能', memory: '指令', settings: '通用',
};
function PanelDock({ rightPanel, setRightPanel, updateNotice, jumpToUpdate }) {
  const [railOpen, setRailOpen] = useState(false);
  // 持久展开:点外部不收(用户要「展开项常驻,再点坞按钮才收起」)。
  // Esc 已让位给停会话(Esc 的全局语义归会话:生成中停回合、空闲双击清输入/开检查点,dock 不抢);收起只保留再点坞图标
  // 和 cgui:dock-rail-close 事件。
  // 导引联动:tour 的面板步骤经此事件展开 rail 做演示(GuideTour 只 dispatch,不直接碰状态)。
  useEffect(() => {
    const onOpen = () => setRailOpen(true);
    const onClose = () => setRailOpen(false); // 导引结束时收起(持久化删了点外部自动收,否则 rail 残留占顶栏)
    window.addEventListener('cgui:dock-rail-open', onOpen);
    window.addEventListener('cgui:dock-rail-close', onClose);
    return () => { window.removeEventListener('cgui:dock-rail-open', onOpen); window.removeEventListener('cgui:dock-rail-close', onClose); };
  }, []);
  const activeMeta = rightPanel ? PANEL_MAP[rightPanel] : null;
  const DockIcon = activeMeta ? activeMeta.icon : LayoutGrid;
  return (
    <span data-tour="panel-dock" className="inline-flex items-center gap-1">
      {railOpen && (
        <span className="cgui-dock-rail inline-flex items-center gap-1 rounded-xl bg-black/5 px-1 py-0.5">
          {/* P2.3:分屏迁入坞 rail 首位(窗口级操作,与面板同属"工作区"语义)。 */}
          <span data-tour="dock-pane" className="inline-flex"><PaneCountPicker /></span>
          <span className="w-px h-4 bg-ink-ghost/30 mx-0.5" />
          {Object.entries(PANEL_MAP).map(([id, { icon: Icon, label }]) => (
            <button key={id} data-tour={`panel-${id}`} onClick={() => setRightPanel(rightPanel === id ? null : id)}
              className={`px-1.5 py-1 rounded-lg transition-all flex flex-col items-center gap-0.5 ${rightPanel === id ? 'bg-accent-subtle text-accent' : 'text-ink-muted hover:text-ink hover:bg-black/5'}`}
              title={label}>
              <Icon size={15} />
              <span className="text-[9px] leading-none font-body">{PANEL_SHORT[id] || label}</span>
            </button>
          ))}
          {/* CJ-2 更新提醒(原顶栏常驻按钮收进 rail;坞图标红点常驻提示) */}
          {updateNotice && (
            <button
              onClick={() => { setRailOpen(false); jumpToUpdate(updateNotice.gui ? 'gui-update' : 'cc-update'); }}
              title={`有可用更新${updateNotice.gui ? ` · GUI v${updateNotice.gui}` : ''}${updateNotice.cc ? ` · Claude Code v${updateNotice.cc}` : ''} — 点击前往更新`}
              className="flex items-center gap-1 px-1.5 py-1 rounded-lg text-red-500 hover:bg-red-500/10 transition-colors animate-pulse">
              <RefreshCw size={15} />
              <span className="text-[11px] leading-none font-body">更新</span>
            </button>
          )}
        </span>
      )}
      <button
        onClick={() => setRailOpen((v) => !v)}
        title={`设置${activeMeta ? ` — 当前:${activeMeta.label}` : ''}（分屏 + 文件 / 审查 / 监控 / Agent / 用量 / 进程 / 工具 / 技能 / 指令 / 通用。Cmd/Ctrl+1..9、0 直达）`}
        className={`relative px-1.5 py-1 rounded-lg transition-all flex flex-col items-center gap-0.5 ${
          railOpen || activeMeta ? 'bg-accent-subtle text-accent' : 'text-ink-muted hover:text-ink hover:bg-black/5'
        }`}
      >
        <DockIcon size={15} />
        <span className="text-[9px] leading-none font-body">{activeMeta ? PANEL_SHORT[rightPanel] : '设置'}</span>
        {updateNotice && (
          <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" title="有可用更新" />
        )}
      </button>
    </span>
  );
}

// Tracks whether the viewport is phone-sized (≤767px). Drives the mobile
// layout: sidebar/right-panel become full-height overlays instead of inline
// columns, and split mode collapses to a single pane (no room to tile).
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return isMobile;
}

function MainLayout({ sidebarCollapsed, selectedProject, rightPanel, setRightPanel, isMobile, updateNotice = null }) {
  const [sidebarWidth, onSidebarDrag] = useResizable({
    initial: 268, min: 200, max: 480, axis: 'x', storageKey: 'cgui-sidebar-width',
  });
  const [rightPanelWidth, onRightDrag] = useResizable({
    initial: 340, min: 280, max: 600, axis: 'x', invert: true, storageKey: 'cgui-right-panel-width',
  });
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const setActiveTabIndex = useStore((s) => s.setActiveTabIndex);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  // BH-1b: dock 态。桌面端 dock 优先占右栏(rightPanel 让位);移动端不渲 dock(走全屏遮罩)。
  const artifactDock = useStore((s) => s.artifactDock);
  const closeArtifactDock = useStore((s) => s.closeArtifactDock);
  const paneSessions = useStore((s) => s.paneSessions);
  const selectedSession = useStore((s) => s.selectedSession);
  // 聚焦窗格的会话 id 变化 → 旧 artifact 不再相关,自动关 dock(首挂载也触发一次,无害)。
  const focusedSessionId = (paneSessions?.[activeTabIndex]?.sessionId) || selectedSession?.sessionId || null;
  useEffect(() => { closeArtifactDock(); }, [focusedSessionId, closeArtifactDock]);

  // ── Mobile: single column; sidebar + right panel are tap-away overlays ──
  if (isMobile) {
    return (
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        <main className="flex-1 flex flex-col relative overflow-hidden min-w-0">
          {/* Split mode has no room on a phone — always show one pane. */}
          <ErrorBoundary label="会话区"><SessionDetail tabIndex={0} mobileChrome /></ErrorBoundary>
        </main>

        {/* Sidebar drawer — Claude-app style multi-level menu */}
        {!sidebarCollapsed && (
          <>
            <div className="fixed inset-0 z-40 bg-black/40 animate-fade-in" onClick={toggleSidebar} />
            {/* 审计批B3:几何(定位/宽高)统一由 .mobile-drawer CSS 负责(zoom 不变量+减 --kb),
                删掉与之打架的 inset-y-0 / w-[86vw](vh/vw 不折算 zoom 的旧写法)。 */}
            <aside className="mobile-drawer z-50 glass-thick flex flex-col overflow-hidden animate-glass-rise">
              <MobileMenu setRightPanel={setRightPanel} onClose={toggleSidebar} updateNotice={updateNotice} />
            </aside>
          </>
        )}

        {/* Right panel — full-screen overlay。外层必须 flex:普通块级下 RightPanel(高度 auto)
            被内容撑开超出屏幕、其内部 flex-1 滚动区拿不到有限高度 → 面板内容溢出被裁、触摸
            滚不动(#18 手机文件浏览器等页面无法上下滑动的根因;桌面父容器是 flex 行天然拉伸
            无此问题)。flex 默认 stretch 把 RightPanel 高度钉成屏高,内部滚动恢复。 */}
        {rightPanel && (
          <div className="fixed inset-0 z-50 bg-canvas animate-glass-rise flex">
            <ErrorBoundary label="面板"><RightPanel panelId={rightPanel} onClose={() => setRightPanel(null)} width="100%" /></ErrorBoundary>
          </div>
        )}
      </div>
    );
  }

  // ── Desktop / tablet: resizable inline columns ──
  return (
    <div className="flex-1 flex min-h-0 gap-0 p-0 overflow-hidden">
      {!sidebarCollapsed && (
        <>
          <aside
            style={{ width: sidebarWidth }}
            className="glass-thick shrink-0 flex flex-col m-3 mr-0 rounded-2xl overflow-hidden animate-glass-rise"
          >
            <div className="flex-1 min-h-0 overflow-hidden">
              {selectedProject ? <SessionList /> : <ProjectList />}
            </div>
          </aside>
          <Splitter onMouseDown={onSidebarDrag} axis="x" />
        </>
      )}
      {/* 始终走 SplitMain(单屏=paneCount 1,内部渲成无分屏头的单栏)。这样切换
          1↔分屏不会在 SplitMain 与单独 <SessionDetail> 两套树之间 unmount/remount
          那棵 2 万节点的会话树——配合 React.memo(SessionDetail),分屏切换不再卡。 */}
      <SplitMain
        activeTabIndex={activeTabIndex}
        setActiveTabIndex={setActiveTabIndex}
      />
      {/* BH-1b: dock 打开时占右栏(优先于 RightPanel,后者状态保留只是暂时让位)。
          ArtifactDock 自带左缘 Splitter,故此处不再额外包一个。
          CK-5: coexist(从文件浏览器停靠 html/svg)时,文件浏览器右栏 + dock 并存为
          两列,dock 在最右,不遮挡文件树。 */}
      {artifactDock?.coexist && rightPanel ? (
        <>
          <Splitter onMouseDown={onRightDrag} axis="x" />
          <ErrorBoundary label="面板"><RightPanel panelId={rightPanel} onClose={() => setRightPanel(null)} width={rightPanelWidth} /></ErrorBoundary>
          <ArtifactDock />
        </>
      ) : artifactDock ? (
        <ArtifactDock />
      ) : rightPanel && (
        <>
          <Splitter onMouseDown={onRightDrag} axis="x" />
          <ErrorBoundary label="面板"><RightPanel panelId={rightPanel} onClose={() => setRightPanel(null)} width={rightPanelWidth} /></ErrorBoundary>
        </>
      )}
    </div>
  );
}

// Renders `paneCount` (1..6) SessionDetail panes side-by-side. The active pane
// gets an accent ring so the user knows which one a sidebar click fills. Each
// pane carries a slim chrome bar (pane # + close ✕). Closing only removes the
// pane from view (closePane) — it never kills the CLI process or the session.
//
// Adaptive: min-width is `em` (scales with font + zoom). 26em ≈ 416px keeps a
// pane's chrome usable; the row scrolls horizontally when N panes exceed the
// viewport instead of crushing each pane.
// 关窗格前的守卫:被关窗格的会话正在运行(runningCwds)或有待处理授权(pendingPermissions)时先确认。
// 授权卡只在该窗格的 SessionDetail 里渲染,关掉窗格 = 卡片随之 unmount,后端进程不被杀、会一直
// 挂着等授权 → 会话卡住(用户实报 Bug4)。这里让用户知情:关闭后可在左侧列表重开该会话继续处理。
// keydown(Delete)与 UI 关闭按钮两处共用,避免逻辑漂移。
async function closePaneGuarded(i) {
  const st = useStore.getState();
  if ((st.paneCount || 1) <= 1) return;
  const sess = st.paneSessions?.[i];
  const busy = sess && ((sess.projectPath && st.runningCwds?.has(sess.projectPath))
    || st.pendingPermissions.some((p) => p.sessionId === sess.sessionId));
  if (!busy) { st.closePane(i); return; }   // 不忙:同步直接关,无 await 无竞态
  const paneId = st.paneIds?.[i];           // 稳定身份,await 期间 index 可能左移
  if (!(await confirmDialog(
    '该窗格的会话正在运行或等待授权。关闭窗格后，它的授权请求将无处显示、会话可能卡在等待（进程不会被杀）。关闭后可在左侧会话列表重新打开它继续。确定关闭？',
    { danger: true }))) return;
  // 确认期间别处可能关了窗格使 index 左移 → 按稳定 paneId 重新定位再关,避免关错窗格(判官指双击竞态)。
  const st2 = useStore.getState();
  const idx = paneId != null ? (st2.paneIds || []).indexOf(paneId) : i;
  if (idx >= 0 && (st2.paneCount || 1) > 1) st2.closePane(idx);
}

function SplitMain({ activeTabIndex, setActiveTabIndex }) {
  const paneCount = useStore((s) => s.paneCount);
  const paneSessions = useStore((s) => s.paneSessions);
  const paneIds = useStore((s) => s.paneIds);
  const artifactDock = useStore((s) => s.artifactDock);
  const rowRef = useRef(null);
  const MIN_PANE_PX = 280;
  // Per-pane width in px. Each pane keeps its own fixed width; the row scrolls
  // horizontally when their sum exceeds the viewport. Default = half the
  // viewport so 2 panes fill the screen and 3+ overflow into a scroll (rather
  // than crushing every pane to fit). Reset on paneCount change.
  const [widths, setWidths] = useState([]);
  // Persist per-pane widths per paneCount so a refresh keeps your split layout
  // (#15). Restore saved widths if they match the current pane count; else fall
  // back to the half-viewport default.
  const widthsKey = `cgui-pane-widths-${paneCount}`;
  useEffect(() => {
    const cw = rowRef.current?.getBoundingClientRect().width || 0;
    // Subtract per-pane margins + splitter so 2 panes fit without a scrollbar.
    const def = cw > 0 ? Math.max(MIN_PANE_PX, Math.round(cw / 2) - 18) : 480;
    let restored = null;
    try {
      const saved = JSON.parse(localStorage.getItem(widthsKey) || 'null');
      if (Array.isArray(saved) && saved.length === paneCount
          && saved.every((n) => typeof n === 'number' && n >= MIN_PANE_PX)) {
        restored = saved;
      }
    } catch {}
    setWidths(restored || Array(paneCount).fill(def));
  }, [paneCount, widthsKey]);

  // Splitter drag: resize ONLY the pane left of the handle (independent sizing).
  // Panes to the right just shift along; the row scrolls if the total grows.
  const startResize = (idx) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[idx] ?? 480;
    const onMove = (ev) => {
      const w = Math.max(MIN_PANE_PX, startW + (ev.clientX - startX));
      setWidths((prev) => {
        const n = [...prev];
        while (n.length < paneCount) n.push(startW);
        n[idx] = w;
        return n;
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Save the final widths so they survive a page refresh.
      setWidths((prev) => {
        try { localStorage.setItem(widthsKey, JSON.stringify(prev)); } catch {}
        return prev;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // BH-1b: dock 打开且分屏时,只渲染聚焦窗格(纯渲染层过滤,绝不改 paneCount/paneSessions)。
  // 关闭 dock 后 panes 恢复全量。
  // BK-4:门控必须用 dock 打开时锁定的窗格 artifactDock.tabIndex,而非实时 activeTabIndex。
  // 否则开 dock 后切聚焦,单显窗格变了 → artifact 配错会话。tabIndex 可能越界(锁定
  // 的窗格已被关闭),做 Math.min 兜底到末窗格。
  const dockPane = (artifactDock && Number.isInteger(artifactDock.tabIndex))
    ? Math.min(paneCount - 1, Math.max(0, artifactDock.tabIndex))
    : activeTabIndex;
  // CK-5: coexist dock(文件浏览器侧停靠)是独立侧列,不替换焦点,故不折叠分屏。
  const panes = (artifactDock && !artifactDock.coexist && paneCount > 1)
    ? [dockPane]
    : Array.from({ length: paneCount }, (_, i) => i);
  // 唯一窗格时(单屏 或 dock 单显聚焦窗格)用单屏那套填满样式 + 不渲分屏头/手柄。
  const soloPane = panes.length === 1;
  return (
    <div ref={rowRef} className="flex-1 flex min-w-0 overflow-x-auto">
      {panes.map((i) => {
        const focused = activeTabIndex === i;
        const paneSession = paneSessions && paneSessions[i];
        const hasSession = !!paneSession;
        // Key by the STABLE pane id (which splices alongside paneSessions in
        // closePane), NOT position. A positional key would make React reuse the
        // closed pane's SessionDetail instance (and its live streaming state)
        // for whatever pane shifted into its slot. The pane id survives the
        // draft→real sessionId transition (unlike keying by sessionId), so a
        // brand-new session's in-progress stream isn't remounted away.
        const paneKey = (paneIds && paneIds[i]) ?? `pane-${i}`;
        return (
          <React.Fragment key={paneKey}>
            <div
              onMouseDown={!soloPane ? () => setActiveTabIndex(i) : undefined}
              style={soloPane
                // 唯一窗格:填满,无需固定宽
                ? { flexGrow: 1, flexShrink: 1, minWidth: '26em' }
                : i === paneCount - 1
                  // 最后一个窗格 flex 填满剩余宽度:行永远正好占满,不会有手柄贴 GUI 右边界,
                  // 也不留空白。前面的窗格固定宽 + 右缘手柄调整,最后一个吸收余量。
                  ? { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: '26em' }
                  : { width: widths[i] ?? 480, flexShrink: 0, flexGrow: 0 }}
              className={soloPane
                // 唯一窗格:无分屏头/边框,样式同旧单栏(始终走 SplitMain 以避免 1↔分屏切换
                // 时整棵会话树 unmount/remount 卡顿)。
                ? 'flex-1 flex flex-col relative m-3 rounded-2xl overflow-hidden min-w-0'
                : `flex flex-col relative my-3 mx-1.5 rounded-2xl overflow-hidden transition-shadow ${
                    focused ? 'ring-2 ring-accent/40 shadow-lg' : 'ring-1 ring-canvas-deep/40'
                  }`}
            >
              {!soloPane && (
                <div className="flex items-center justify-between px-2.5 py-1 bg-canvas-warm/70 border-b border-canvas-deep shrink-0 z-20">
                  <span className={`text-[10px] font-mono ${focused ? 'text-accent' : 'text-ink-faint'}`}>
                    分屏 {i + 1}{focused ? ' · 当前' : ''}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); closePaneGuarded(i); }}
                    className="w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors"
                    title="关闭此分屏（不结束会话 / 不杀进程）"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
              {(soloPane || hasSession) ? (
                <ErrorBoundary label="会话区"><SessionDetail tabIndex={i} /></ErrorBoundary>
              ) : (
                <div className="flex-1 flex items-center justify-center glass-base">
                  <div className="text-center px-4">
                    <div className="w-12 h-12 rounded-2xl glass-thin flex items-center justify-center mx-auto mb-3">
                      <Layers size={20} className="text-accent" />
                    </div>
                    <p className="text-[12px] text-ink-muted font-body">点左侧任一会话填入本分屏</p>
                    <p className="text-[10px] text-ink-faint font-body mt-1">（此栏已高亮为当前）</p>
                  </div>
                </div>
              )}
            </div>
            {/* 手柄只放在窗格【之间】(最后一个窗格右缘不放,否则会贴 GUI 右边界难抓)。
                拖第 i 个手柄=调整第 i 个窗格宽,最后一个窗格 flex 吸收余量。 */}
            {!soloPane && i < paneCount - 1 && <SplitterCmp onMouseDown={startResize(i)} axis="x" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function RightPanel({ panelId, onClose, width }) {
  if (!panelId || !PANEL_MAP[panelId]) return null;
  const { label, icon: Icon, component: PanelComponent } = PANEL_MAP[panelId];

  // data-cgui-panel:面板容器标识。App 的 Esc 监听靠它判断「这一击落在面板里」
  // (面板内输入框的 Esc 不得外泄到会话级停止监听)。别删。
  return (
    <div data-cgui-panel style={{ width }} className="glass-thick shrink-0 flex flex-col m-3 ml-0 rounded-2xl overflow-hidden animate-glass-rise">
      <div className="flex items-center justify-between px-4 py-3 border-b border-canvas-deep shrink-0">
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-accent" />
          <span className="text-sm font-medium text-ink font-body">{label}</span>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-canvas-warm rounded transition-colors">
          <X size={14} className="text-ink-faint" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <PanelComponent />
      </div>
    </div>
  );
}

// ─── Global search results (full-text across all session jsonl) ─
function GlobalSearchResults({ q, onPick }) {
  const [hits, setHits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!q || q.length < 2) { setHits([]); return; }
    setLoading(true);
    const ctl = new AbortController();
    // Debounce so we don't spam the disk on every keystroke
    const id = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        .then((r) => r.json())
        .then((d) => { setHits(d.hits || []); setTruncated(!!d.truncated); })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 220);
    return () => { clearTimeout(id); ctl.abort(); };
  }, [q]);

  if (q.length < 2) return null;
  return (
    <div className="px-2 stagger">
      <div className="px-2 py-1.5 text-[10px] text-ink-faint uppercase tracking-widest font-body flex items-center justify-between">
        <span>消息匹配</span>
        <span className="text-ink-ghost font-mono">{loading ? '…' : hits.length}{truncated ? '+' : ''}</span>
      </div>
      {hits.map((h, i) => (
        <button key={i} onClick={() => onPick(h)}
          className="sidebar-item w-full text-left px-3 py-2 rounded-lg mb-0.5 animate-slide-in">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`chip ${h.role === 'user' ? 'chip-accent' : ''}`}>{h.role}</span>
            <span className="text-[10px] text-ink-ghost font-mono truncate">{h.sessionId.slice(0, 8)}</span>
          </div>
          <p className="text-[12px] text-ink-soft font-body leading-snug line-clamp-2">{h.snippet}</p>
        </button>
      ))}
      {!loading && hits.length === 0 && (
        <p className="px-3 py-4 text-[12px] text-ink-faint text-center font-body">没有匹配</p>
      )}
    </div>
  );
}

// ─── Project List ──────────────────────────────────────────────
// 侧栏运行状态符号:正在回复=旋转环;30min 内刚跑完=圈中对勾;更久的闲置=无符号。
const RUNNING_DONE_WINDOW_MS = 30 * 60 * 1000;
function StatusDot({ running, lastActivity, className = '' }) {
  if (running) return <Loader2 size={11} className={`text-accent animate-spin shrink-0 ${className}`} />;
  const t = lastActivity ? new Date(lastActivity).getTime() : NaN;
  if (Number.isFinite(t) && Date.now() - t < RUNNING_DONE_WINDOW_MS)
    return <CheckCircle2 size={11} className={`text-success shrink-0 ${className}`} />;
  return null;
}

function ProjectList() {
  const { projects, selectedProject, setSelectedProject, fetchProjects, fetchSessions, searchQuery, setSearchQuery } = useStore();
  const runningCwds = useStore((s) => s.runningCwds);
  const isMobile = useIsMobile();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addPathInput, setAddPathInput] = useState('');
  const [addError, setAddError] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  // Per-project hide, now SERVER-BACKED so the list is identical on every device
  // (phone + Mac). Previously this lived in each browser's localStorage, so a
  // phone showed every project the user had hidden on the Mac. Hidden projects
  // vanish from this sidebar but stay on disk — restore via the + button.
  const [hidden, setHidden] = useState(new Set());
  // 置顶项目(服务端共享)。置顶项排到列表最前。
  const [pinned, setPinned] = useState(new Set());
  const togglePin = (hash) => {
    setPinned((prev) => {
      const next = new Set(prev);
      const willPin = !next.has(hash);
      if (willPin) next.add(hash); else next.delete(hash);
      fetch('/api/prefs/pinned', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'project', id: hash, pinned: willPin }),
      }).catch(() => {});
      return next;
    });
  };
  const persistHidden = (set) => {
    fetch('/api/prefs/hidden-projects', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
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

  // 危险操作:调用 CLI `claude project purge` 删除该项目在 Claude 的全部本地状态
  // (会话历史 / 记忆 / 文件历史等),不影响项目源码。成功后刷新列表。
  const purgeProject = async (project) => {
    const ok = await confirmDialog(
      `彻底清理该项目的 Claude 本地状态？\n\n${project.path}\n\n将删除该项目的全部会话历史、记忆、文件历史等 Claude 本地状态。不影响项目代码，操作不可恢复。`,
      { danger: true },
    );
    if (!ok) return;
    try {
      const r = await fetch('/api/project/purge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: project.path }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || data.stderr || `HTTP ${r.status}`);
      if (selectedProject?.hash === project.hash) setSelectedProject(null);
      fetchProjects();
    } catch (e) {
      await confirmDialog(`清理失败：${e.message}`, { danger: false });
    }
  };

  useEffect(() => { fetchProjects(); }, []);
  useEffect(() => {
    fetch('/api/prefs/pinned').then((r) => r.json())
      .then((d) => setPinned(new Set(Array.isArray(d.projects) ? d.projects : [])))
      .catch(() => {});
  }, []);
  // Load the shared hidden list; one-time migration of any legacy localStorage
  // entries so the user doesn't lose hides from before the server move.
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

  // #1 worktree 项目默认不混进顶层项目列表(跑过会话的 worktree 会作为独立项目平级冒出来、
  // 干扰主项目)。设置里「显示 worktree 项目」开关控制,默认关;开关写 localStorage + 广播
  // 事件,此处监听同步。worktree 仍可从「文件→worktree」弹窗进入(enterWorktree 会切过去)。
  const [showWorktreeProjects, setShowWorktreeProjects] = useState(() => {
    try { return localStorage.getItem('cgui-show-worktree-projects') === '1'; } catch { return false; }
  });
  useEffect(() => {
    const h = () => { try { setShowWorktreeProjects(localStorage.getItem('cgui-show-worktree-projects') === '1'); } catch {} };
    window.addEventListener('cgui:worktree-visibility', h);
    return () => window.removeEventListener('cgui:worktree-visibility', h);
  }, []);
  const filtered = projects.filter((p) =>
    !hidden.has(p.hash) && (showWorktreeProjects || !p.isWorktree) && p.path.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const hiddenOnly = projects.length > 0 && filtered.length === 0 && searchQuery.length === 0 && hidden.size > 0;
  // 置顶项排最前(稳定排序保各组内原顺序)。
  const sortedProjects = [...filtered].sort((a, b) => (pinned.has(b.hash) ? 1 : 0) - (pinned.has(a.hash) ? 1 : 0));

  const registerProjectPath = async (rawPath) => {
    const path = String(rawPath || '').trim();
    if (!path) return;
    setAddingProject(true);
    setAddError('');
    try {
      let r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _addProject: path }),
      });
      let data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      // Folder doesn't exist → ask whether to create it. Decline = close dialog.
      if (data.needsCreate) {
        const ok = await confirmDialog(`文件夹不存在：\n${data.addedPath}\n\n是否新建该文件夹并作为项目？`);
        if (!ok) { setAddDialogOpen(false); setAddPathInput(''); return; }
        r = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _addProject: path, _createDir: true }),
        });
        data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      }
      await fetchProjects();
      const fresh = useStore.getState().projects;
      const clean = data.addedPath || path.replace(/\/+$/, '') || '/';
      // ALWAYS un-hide the added hash. A folder the user explicitly adds MUST be
      // visible — even if it was hidden before, or its (lossy CLI) hash collides
      // with a hidden sibling. Previously we only un-hid when `proj` was found AND
      // already hidden, so a re-added/colliding folder stayed invisible: the exact
      // "I add a folder but it never shows up" bug.
      if (data.addedHash) {
        setHidden((prev) => {
          if (!prev.has(data.addedHash)) return prev;
          const next = new Set(prev);
          next.delete(data.addedHash);
          persistHidden(next);
          return next;
        });
      }
      // Prefer hash match (exact) over path-string equality.
      const proj = (data.addedHash && fresh.find((p) => p.hash === data.addedHash))
        || fresh.find((p) => p.path === clean);
      if (proj) {
        useStore.getState().setSelectedProject(proj);
        useStore.getState().fetchSessions(proj.hash, { silent: true });
      } else {
        // Created on disk but absent from the refreshed list — still usable (the
        // hash dir exists), so enter it; the next refresh will surface it.
        useStore.getState().setSelectedProject({
          path: clean,
          hash: data.addedHash || clean.replace(/[^A-Za-z0-9]/g, '-'),
          sessionCount: 0,
          lastActivity: null,
        });
      }
      try {
        const parent = clean.replace(/\/[^/]+\/?$/, '') || '/';
        localStorage.setItem('cgui-picker-last-start', parent);
      } catch {}
      // A6:服务端在导入时检测 git HEAD,无则提示(不阻断导入)。复用顶部悬浮
      // 提醒条(CompletionToasts,10s 自动消失);sessionId 为 null 时点击仅关闭。
      if (data.noGitHead) {
        useStore.getState().pushCompletionToast({
          sessionId: null,
          projectHash: data.addedHash || null,
          session: null,
          title: '已添加项目',
          suffix: '提示',
          summary: '该文件夹不是 git 仓库或没有提交，worktree 与子代理隔离功能不可用。',
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

  // 添加项目入口(顶部 + 按钮 / 空态主按钮 / EmptyState 经事件触发共用):
  // Tauri 或本机浏览器走系统文件夹选择器,远程/手机落到路径输入弹窗。
  const openAddProject = async () => {
    let path = null;
    // Remember where the user picked last — open the dialog at the
    // parent of that dir so they don't have to navigate from
    // ~/Desktop every time. Falls back to Desktop on first run.
    const lastStart = (() => {
      try { return localStorage.getItem('cgui-picker-last-start') || ''; } catch { return ''; }
    })();
    // The native folder picker (osascript `choose folder`) opens on the
    // SERVER's Mac screen — a phone/remote client never sees it and the
    // fetch hangs, so the "+" looks dead. Only use it when the browser is
    // on the same machine as the server; remote/phone falls through to the
    // path prompt below.
    // Tauri 环境走 pickDirectory(官方 dialog 插件,进程内 NSOpenPanel,秒开);
    // 本地浏览器回退后端 picker;远程/手机不弹本地选择器(会开在服务器屏幕、
    // 客户端 hang),落到下方路径输入框。
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    if (isTauri() || (isLocalHost && !isMobile)) {
      try {
        const data = await pickDirectory({ prompt: '选择项目目录', startDir: lastStart || undefined });
        if (data.path === null) return;  // user cancelled
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
  // 主区 EmptyState 的「添加项目」按钮经事件触达这里(该按钮渲染在另一棵子树,
  // 拿不到本组件的弹窗/选择器状态)。ref 取最新闭包,避免陈旧 state。
  const openAddProjectRef = useRef(openAddProject);
  openAddProjectRef.current = openAddProject;
  useEffect(() => {
    const f = () => openAddProjectRef.current?.();
    window.addEventListener('cgui:add-project', f);
    return () => window.removeEventListener('cgui:add-project', f);
  }, []);

  const handlePickHit = async (hit) => {
    const project = projects.find((p) => p.hash === hit.projectHash);
    if (project) {
      setSelectedProject(project);
      await fetchSessions(project.hash);
      // Then select the matching session
      const list = useStore.getState().sessions;
      const target = list.find((s) => s.sessionId === hit.sessionId);
      if (target) {
        useStore.getState().setSelectedSession(target);
        useStore.getState().fetchMessages(target.sessionId, target.projectHash);
      }
    }
    setSearchQuery('');
  };

  return (
    <div data-tour="sidebar-list" className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-ink-faint font-body">
            项目
          </h2>
          <button
            onClick={openAddProject}
            data-tour="add-project"
            className="p-1 hover:bg-canvas-warm rounded transition-colors"
            title="添加项目（系统文件选择器）"
          >
            <Plus size={14} className="text-ink-faint hover:text-accent" />
          </button>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-ghost" />
          <input
            type="text"
            placeholder="搜索项目 / 消息 (≥2 字符)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-canvas border border-canvas-sunken rounded-lg pl-8 pr-3 py-1.5 text-xs text-ink placeholder-ink-ghost focus:outline-none focus:border-accent/40 font-body"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 stagger">
        {searchQuery.length >= 2 && (
          <GlobalSearchResults q={searchQuery} onPick={handlePickHit} />
        )}
        {sortedProjects.map((project) => (
          <div key={project.hash} className="relative group">
            <button
              onClick={() => {
                setSelectedProject(project);
                fetchSessions(project.hash);
              }}
              className={`sidebar-item w-full text-left px-3 py-2.5 rounded-lg mb-0.5 transition-all animate-slide-in ${
                selectedProject?.hash === project.hash
                  ? 'active bg-canvas-warm'
                  : 'hover:bg-canvas-warm/60'
              }`}
            >
              <div className="flex items-center gap-2">
                <FolderOpen size={13} className="text-warning/70 shrink-0" />
                <StatusDot running={runningCwds.has(project.path)} lastActivity={project.lastActivity} />
                <span className="text-[13px] text-ink-soft truncate font-body font-medium">
                  {formatPathShort(project.path)}
                </span>
                {project.isWorktree && (
                  <span className="text-[9px] px-1 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono shrink-0" title="Git worktree(独立工作树,非主仓目录)">⎇</span>
                )}
              </div>
              {/* 路径小字放名字下方:同名最终文件夹靠完整路径区分 */}
              <div className="text-[10px] text-ink-faint font-mono truncate ml-[21px] mt-0.5" title={formatPath(project.path)}>
                {formatPath(project.path)}
              </div>
              <div className="flex items-center gap-3 mt-0.5 ml-[21px]">
                <span className="text-[10px] text-ink-faint font-mono">
                  {project.sessionCount} 会话
                </span>
                <span className="text-[10px] text-ink-ghost">
                  {formatDate(project.lastActivity)}
                </span>
              </div>
            </button>
            <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
              <button
                onClick={(e) => { e.stopPropagation(); togglePin(project.hash); }}
                className={`transition-opacity p-1 hover:bg-canvas-deep rounded ${pinned.has(project.hash) ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100'}`}
                title={pinned.has(project.hash) ? '取消置顶' : '置顶到列表最前'}
              >
                <Pin size={12} className={pinned.has(project.hash) ? 'text-accent fill-accent' : 'text-ink-faint'} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); toggleHidden(project.hash); }}
                className="opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity p-1 hover:bg-canvas-deep rounded"
                title="从侧栏隐藏（不删除本地文件，下次按 + 重新添加同路径即可恢复）"
              >
                <EyeOff size={12} className="text-ink-faint" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); purgeProject(project); }}
                className="opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity p-1 hover:bg-red-50 rounded"
                title="彻底清理该项目的 Claude 本地状态（会话历史/记忆等，不影响项目代码，不可恢复）"
              >
                <Trash2 size={12} className="text-ink-faint hover:text-red-600" />
              </button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-ink-faint font-body">
              {searchQuery ? '没有匹配的项目' : hiddenOnly ? '所有项目都已隐藏' : '没有找到项目'}
            </p>
            {!searchQuery && !hiddenOnly && (
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
      {/* 审计批E3:portal 到 body —— 手机抽屉/侧栏祖先带 transform 时 fixed 遮罩被困在
          抽屉内(弹窗被裁、遮罩盖不满),portal 后恒真全屏;state 仍在 ProjectList 本组件。 */}
      {addDialogOpen && createPortal(
        <div className="fixed inset-0 z-[80] bg-black/25 flex items-end md:items-center justify-center p-3">
          <div className="w-full max-w-md rounded-2xl bg-canvas border border-canvas-deep shadow-2xl overflow-hidden">
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
                className="w-full bg-canvas-warm border border-canvas-deep rounded-xl px-3 py-3 text-[16px] text-ink font-body focus:outline-none focus:border-accent/50"
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
    </div>
  );
}

// ─── Session List ──────────────────────────────────────────────
// 二次确认删除按钮(内联,无弹窗):第一次点 🗑 → 原地morph 成红色"确认"按钮,
// 同一位置再点即删,3 秒内不点自动复位。比弹窗省一次"鼠标换位置点确认"。
// armed 时通过 onArmedChange 让父级把整组操作按钮强制保持可见(opacity-100),
// 避免鼠标移出 group-hover 区后"确认"按钮消失点不到(以前 inline 失败的根因)。
function DeleteButton({ onConfirm, onArmedChange }) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const disarm = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setArmed(false); onArmedChange?.(false);
  };
  if (armed) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); disarm(); onConfirm(); }}
        className="px-1.5 py-1 rounded bg-red-600 text-white text-[10px] font-body leading-none hover:bg-red-700"
        title="再次点击确认删除"
      >确认</button>
    );
  }
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setArmed(true); onArmedChange?.(true);
        timerRef.current = setTimeout(() => { setArmed(false); onArmedChange?.(false); timerRef.current = null; }, 3000);
      }}
      className="p-1 rounded hover:bg-red-50"
      title="删除本地会话历史（点击后再点确认）"
    >
      <Trash2 size={12} className="text-ink-faint hover:text-red-600" />
    </button>
  );
}

function SessionItem({ session, isSelected, onSelect, onFork, onArchive, onDelete, forking, running, pinned, onTogglePin }) {
  const [expanded, setExpanded] = useState(false);
  const customTitle = useStore((s) => s.customTitles[session.sessionId]);
  const autoTitle = useStore((s) => s.autoTitles[session.sessionId]);
  const setCustomTitle = useStore((s) => s.setCustomTitle);
  // 会话列表 model 徽章:优先当前 pin(用户在该会话切了 model/provider 即时生效),回落 session.model
  // (后端已取 jsonl 最后一条 assistant 的 model 非首条;但「切了还没发新消息」时它仍是旧值)。
  // primitive selector 只订阅本条 pin,不因 setModelFor 换整个 map 引用而触发全列表重渲。
  const pinModel = useStore((s) => s.modelBySession[session.sessionId]);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [deleteArmed, setDeleteArmed] = useState(false); // #2 删除二次确认中 → 强制操作组可见
  const hasSubagents = session.subagents?.length > 0;
  const isArchived = !!session.archived;
  const isDraft = !!session.draft || !session.sessionId;

  const startRename = (e) => {
    e?.stopPropagation();
    if (isDraft) return;
    setDraft((customTitle || autoTitle || session.firstPrompt || '').slice(0, 200));
    setRenaming(true);
  };
  const saveRename = () => { setCustomTitle(session.sessionId, draft); setRenaming(false); };

  return (
    <div className="relative group">
      {renaming ? (
        <div className="px-3 py-3 mb-0.5">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); saveRename(); }
              // 取消重命名的 Esc 已被消费,挡住 window 上的会话级监听(生成中单击即停)。
              else if (e.key === 'Escape') { e.preventDefault(); e.nativeEvent?.stopImmediatePropagation?.(); setRenaming(false); }
            }}
            onBlur={saveRename}
            placeholder="自定义标题（清空恢复默认）"
            className="w-full bg-canvas border border-accent/40 rounded-md px-2 py-1 text-[13px] text-ink font-body focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(session)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(session); } }}
          className={`sidebar-item w-full text-left px-3 py-3 rounded-lg mb-0.5 transition-all cursor-pointer ${
            isSelected ? 'active bg-canvas-warm' : 'hover:bg-canvas-warm/60'
          }`}
        >
          <div className="flex items-start gap-2">
            {hasSubagents ? (
              <button
                onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                className="shrink-0 mt-0.5 p-0.5 hover:bg-canvas-deep rounded"
              >
                <ChevronRight size={12} className={`text-ink-faint transition-transform ${expanded ? 'rotate-90' : ''}`} />
              </button>
            ) : (
              <MessageSquare size={13} className="text-accent/40 shrink-0 mt-0.5" />
            )}
            <StatusDot running={running} lastActivity={session.lastActivity} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink-soft line-clamp-2 font-body leading-snug pr-1">
                {customTitle || autoTitle || session.firstPrompt || '(空会话)'}
              </div>
              {/* Bottom row leaves space on the right for the hover action bar. */}
              <div className="flex items-center gap-2 gap-y-1 flex-wrap mt-1.5 pr-20">
                {pinned && <Pin size={9} className="text-accent fill-accent shrink-0" />}
                {(pinModel || session.model) && <ModelBadge model={(pinModel || session.model).replace(/\[1m\]/i, '')} compact />}
                <span className="text-[10px] text-ink-faint font-mono shrink-0 whitespace-nowrap">{session.messageCount}</span>
                {hasSubagents && (
                  <span className="text-[10px] text-accent/60 font-mono shrink-0 whitespace-nowrap">+{session.subagents.length} 子任务</span>
                )}
                <span className="text-[10px] text-ink-ghost shrink-0 whitespace-nowrap">{formatDate(session.lastActivity)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      {!renaming && (
      <div className={`absolute bottom-1.5 right-1.5 transition-opacity flex items-center gap-0.5 ${deleteArmed ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100'}`}>
        <button
          onClick={(e) => { e.stopPropagation(); onTogglePin?.(session.sessionId); }}
          disabled={isDraft}
          className="p-1 hover:bg-canvas-deep rounded disabled:opacity-30"
          title={pinned ? '取消置顶' : '置顶到列表最前'}
        >
          <Pin size={12} className={pinned ? 'text-accent fill-accent' : 'text-ink-faint'} />
        </button>
        <button
          onClick={startRename}
          disabled={isDraft}
          className="p-1 hover:bg-canvas-deep rounded disabled:opacity-30"
          title="重命名（自定义标题）"
        >
          <Pencil size={12} className="text-ink-faint" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onFork(session); }}
          disabled={forking}
          className="p-1 hover:bg-canvas-deep rounded"
          title="分支会话（复制完整上下文为新会话）"
        >
          <GitBranch size={12} className={forking ? 'text-accent animate-spin' : 'text-ink-faint'} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onArchive(session); }}
          className="p-1 hover:bg-canvas-deep rounded"
          title={isArchived ? '取消归档' : '收纳（折叠到归档页）'}
        >
          {isArchived
            ? <ArchiveRestore size={12} className="text-accent" />
            : <Archive size={12} className="text-ink-faint" />}
        </button>
        <DeleteButton onConfirm={() => onDelete(session)} onArmedChange={setDeleteArmed} />
      </div>
      )}
      {expanded && hasSubagents && (
        <div className="ml-5 pl-2 border-l border-canvas-deep space-y-0.5 mb-1">
          {session.subagents.map((sub) => (
            <button
              key={sub.sessionId}
              onClick={() => onSelect(sub)}
              className={`w-full text-left px-2.5 py-2 rounded-md transition-colors text-[11px] ${
                isSelected ? 'bg-accent-subtle/30' : 'hover:bg-canvas-warm/40'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Wrench size={10} className="text-ink-ghost shrink-0" />
                <span className="text-ink-muted font-body truncate flex-1">{sub.firstPrompt || '子任务'}</span>
                <span className="text-[9px] text-ink-ghost font-mono shrink-0">{sub.messageCount}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// fork 命名+配置继承(侧栏分支按钮与消息级分叉共用)。标题「<源标题>分支N」:
// 洗掉已有分支后缀使分支的分支同族;N=现有自定义标题中同族最大+1。配置继承(AZ7):
// 源会话显式 pin > 侧栏元数据 model > 全局兜底;effort/权限模式照搬。
function adoptFork(st, srcSession, newSessionId) {
  const srcId = srcSession.sessionId;
  const baseTitle = (st.customTitles[srcId] || st.autoTitles?.[srcId] || srcSession.firstPrompt || '会话')
    .slice(0, 60).trim().replace(/分支\d+$/, '').trim();
  const reBranch = new RegExp('^' + baseTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '分支(\\d+)$');
  let maxN = 0;
  for (const t of Object.values(st.customTitles)) {
    const m = reBranch.exec(t);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  st.setCustomTitle(newSessionId, `${baseTitle}分支${maxN + 1}`);
  st.setModelFor(newSessionId, st.modelBySession[srcId] || srcSession.model || st.getModelFor(srcId));
  st.setEffortFor(newSessionId, st.getEffortFor(srcId));
  st.setPermissionMode(st.getPermissionModeFor(srcId), newSessionId);
}

// 部件②总闸:停本会话所有后台子代理/teammate(选择性 /stop,hard=false,保留 shell 长任务)。
// 复用 stopSessionProcs 的 pid 解析(按 sessionId 扇出到该会话全部 slot);hard 不传 = 选择性停止,
// 不改 /stop 内部。分屏隔离:严格按 sessionId 过滤,不波及其它窗格。
// A1:allTasks:true —— 主停止键改成只停【本回合】任务后,总闸是唯一"跨回合后台任务也停"的入口
// (这正是它的语义),故显式声明全量范围;不传的调用方(主停止/Esc/⚡引导)自动只停本回合。
// 模块级:SessionDetail 的 ChatInput 用(曾误定义在 SessionList 内,跨组件不可见→白屏)。
async function stopSessionBackground(sessionId) {
  if (!sessionId) return;
  try {
    const d = await fetch('/api/agents/active').then((r) => r.json());
    // 只停 idle 槽位(判官 M2):busy(streaming/starting)槽位说明该会话主回合在跑——
    // 含「子代理刚完、主 agent 续跑、前端尚未 reattach」的秒级窗口,此时选择性 /stop
    // 会把续跑的主回合正文一并 interrupt 掉,与按钮文案「只停后台」不符。跳过即可,
    // reattach 后按钮随 working 态消失,用户要停主回合有专属停止键。
    const { procs, busy } = classifyStopTargets(d.agents, sessionId);
    // 原来这里是静默 return —— 用户点了「停止后台 N」什么都不发生,而按钮上的 N 读的是
    // 前端 store(与服务端真值脱钩),僵尸卡让它显示"停止后台 3"而服务端一个进程都没有。
    // 两种落空分开处理:
    if (!procs.length) {
      if (busy) {
        // 主回合在跑(含"子代理刚完、主 agent 续跑、前端尚未 reattach"的秒级窗口)。
        // 此时选择性 /stop 会把续跑的正文一并 interrupt,与按钮文案不符,故仍不发请求,
        // 但要说清楚为什么没反应。【不清卡片】:进程活着,卡片可能是真的。
        confirmDialog('主回合仍在进行中,后台子代理无法单独停止。请用输入框旁的停止键停止当前回合。', { confirmText: '知道了' });
        return;
      }
      // 服务端已无本会话的任何可停对象 = 这些卡片是残留状态,顺手清掉(它们再也等不到
      // 任何终态事件了)。下一次 task 事件到达会重新建条目,不会把真在跑的任务盖掉。
      finalizeSessionAgents(sessionId);
      confirmDialog('服务端已没有本会话的后台进程,这些卡片是残留状态,已为你清理。', { confirmText: '知道了' });
      return;
    }
    await Promise.allSettled(procs.map((a) => fetch(`/api/chat/${a.pid}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allTasks: true }),
    })));
  } catch {}
}

function SessionList() {
  const { sessions, selectedSession, setSelectedSession, fetchMessages, selectedProject } = useStore();
  const runningSessionIds = useStore((s) => s.runningSessionIds);
  // In split mode, sidebar clicks fill the focused pane (tab 0 or 1).
  // Outside split mode the call collapses to setSelectedSession + tab-0
  // fetch — i.e. identical to the legacy single-pane behavior.
  const splitMode = useStore((s) => s.splitMode);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const setActiveTabSession = useStore((s) => s.setActiveTabSession);
  const paneSessions = useStore((s) => s.paneSessions);
  // 焦点 pane 当前的 session,决定本列表里哪条强高亮(按当前活跃 tab 取,N-pane 下只高亮焦点)。
  const focusSession = (paneSessions && paneSessions[activeTabIndex]) || null;
  const [forking, setForking] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  // 置顶会话(服务端共享),置顶项排最前。
  const [pinnedSessions, setPinnedSessions] = useState(new Set());
  const customTitles = useStore((s) => s.customTitles);
  const autoTitles = useStore((s) => s.autoTitles);
  const togglePinSession = (sid) => {
    if (!sid) return;
    setPinnedSessions((prev) => {
      const next = new Set(prev);
      const willPin = !next.has(sid);
      if (willPin) next.add(sid); else next.delete(sid);
      fetch('/api/prefs/pinned', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'session', id: sid, pinned: willPin }),
      }).catch(() => {});
      return next;
    });
  };
  useEffect(() => {
    fetch('/api/prefs/pinned').then((r) => r.json())
      .then((d) => setPinnedSessions(new Set(Array.isArray(d.sessions) ? d.sessions : [])))
      .catch(() => {});
  }, []);

  // 标题取值与 SessionItem 渲染一致:自定义 > 自动 > 首条消息。搜索按它过滤。
  const titleOf = (s) => (customTitles[s.sessionId] || autoTitles[s.sessionId] || s.firstPrompt || '');
  const q = query.trim().toLowerCase();
  const visible = sessions
    .filter((s) => !!s.archived === showArchived)
    .filter((s) => q === '' || titleOf(s).toLowerCase().includes(q))
    .sort((a, b) => (pinnedSessions.has(b.sessionId) ? 1 : 0) - (pinnedSessions.has(a.sessionId) ? 1 : 0));
  const activeCount = sessions.filter((s) => !s.archived).length;
  const archivedCount = sessions.filter((s) => !!s.archived).length;

  const handleArchive = async (session) => {
    try {
      await fetch(`/api/sessions/${session.sessionId}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectHash: session.projectHash, archived: !session.archived }),
      });
      useStore.getState().fetchSessions(selectedProject.hash, { silent: true });
    } catch (err) {
      confirmDialog('归档失败：' + err.message);
    }
  };

  // 删除撤销窗:确认删除后先从列表隐藏 + 清掉所有显示该会话的 pane(不止 pane0
  // mirror——分屏聚焦被删会话时窗口残留的根因),5 秒倒计时到点才真删 jsonl;
  // 点撤销则恢复列表并把会话塞回原 pane。倒计时内文件没动过,失败方向 = 没删成
  // (关 app 会话回来),不会误删。多条叠加(同 CompletionToasts):每条独立倒计时
  // 独立撤销,互不覆盖——单条版删多个会话时只能撤销最后一个(用户实报)。
  const [pendingDeletes, setPendingDeletes] = useState([]); // [{ session, panes, timer, deadline, secondsLeft }]
  const pendingDeletesRef = useRef([]);
  pendingDeletesRef.current = pendingDeletes;

  // 真删前先停掉该会话的活跃 CLI 进程(服务端停止链路会连带杀子代理,v0.2.131),
  // 并等进程退净——不等就删 jsonl,进程残余落盘写入会把刚删的文件"复活"成半截会话。
  // 倒计时期间进程全程没动:点撤销回来看到的仍是运行中的会话(含子代理),符合预期。
  const stopSessionProcs = async (sessionId) => {
    try {
      const list = async () => {
        const d = await fetch('/api/agents/active').then((r) => r.json());
        return (d.agents || []).filter((a) => a.kind === 'chat-process' && a.sessionId === sessionId && a.stoppable === true);
      };
      const procs = await list();
      if (!procs.length) return;
      // 删会话=全杀(hard):后台 shell 长任务也停,不留孤儿进程复活刚删的 jsonl。
      await Promise.allSettled(procs.map((a) => fetch(`/api/chat/${a.pid}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hard: true }) })));
      for (let i = 0; i < 12; i++) { // 最多 ~6s:stop 有 2s 优雅窗 + SIGTERM→KILL 兜底
        await new Promise((r) => setTimeout(r, 500));
        if ((await list().catch(() => [])).length === 0) break;
      }
      // 停止链路 #2:删会话杀点。进程已杀,该会话 activeAgents 非终态条目(taskManaged
      // 等)不会再有信号,就地级联收尾,防监控面板残留"工作中"。
      finalizeSessionAgents(sessionId);
    } catch {}
  };

  const reallyDelete = async (session) => {
    try {
      await stopSessionProcs(session.sessionId);
      const r = await fetch(
        `/api/sessions/${session.sessionId}?projectHash=${encodeURIComponent(session.projectHash)}`,
        { method: 'DELETE' }
      );
      if (!r.ok) { const e = await r.json().catch(() => ({})); confirmDialog('删除失败：' + (e.error || r.status)); return; }
      useStore.getState().clearSessionStopped?.(session.sessionId); // 会话已删,已停表条目一并收口(判官建议)
      // 排队消息同清:messageQueue 镜像进 localStorage(cgui-message-queue),会话删了队列还在 →
      // 下次有窗格用到同一 sessionId 键(reattach / 同名恢复)就把孤儿消息发出去。
      // 只清 sessionId 键:draft-<projectHash> 是该项目【当前未落盘 draft】的队列,不属于本会话。
      useStore.getState().clearQueue?.(session.sessionId);
      useStore.getState().fetchSessions(selectedProject.hash, { silent: true });
    } catch (err) {
      confirmDialog('删除失败：' + err.message);
    }
  };

  const handleDelete = (session) => {
    const sid = session.sessionId;
    if (pendingDeletesRef.current.some((p) => p.session.sessionId === sid)) return; // 已在倒计时
    const st = useStore.getState();
    const panes = [];
    (st.paneSessions || []).forEach((p, i) => {
      if (p?.sessionId && p.sessionId === sid) {
        panes.push(i);
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
    setPendingDeletes((arr) => [...arr, { session, panes, timer, deadline, secondsLeft: 5 }]);
  };

  const undoDelete = (sid) => {
    const p = pendingDeletesRef.current.find((x) => x.session.sessionId === sid);
    if (!p) return;
    clearInterval(p.timer);
    setPendingDeletes((arr) => arr.filter((x) => x.session.sessionId !== sid));
    // 文件从未动过:列表恢复 = 去掉过滤;原 pane 塞回会话并重拉消息
    const st = useStore.getState();
    p.panes.forEach((i) => {
      st.setPaneSession(i, p.session);
      st.fetchMessages(p.session.sessionId, p.session.projectHash, { tab: i, silent: true });
    });
  };

  // 卸载(切项目/返回)时立即落实全部 pending,防止倒计时僵尸化导致"看着删了其实没删"。
  // 同样先停进程再删(页面还活着,异步链能跑完;真正关 app 的场景进程随后端一起退)。
  useEffect(() => () => {
    pendingDeletesRef.current.forEach((p) => {
      clearInterval(p.timer);
      useStore.getState().clearQueue?.(p.session.sessionId); // 同 reallyDelete:不留孤儿队列
      stopSessionProcs(p.session.sessionId).then(() => fetch(
        `/api/sessions/${p.session.sessionId}?projectHash=${encodeURIComponent(p.session.projectHash)}`,
        { method: 'DELETE', keepalive: true }
      )).catch(() => {});
    });
  }, []);

  // Auto-refresh the session list when any .jsonl in ~/.claude/projects/
  // changes (file watcher dispatches via useWebSocket). Debounced so a busy
  // stream doesn't spam fetches. This fixes the "new session A → new session B
  // → A missing from history" race: the moment claude appends to A's jsonl,
  // sidebar refetches and A shows up.
  useEffect(() => {
    if (!selectedProject?.hash) return;
    let timer = null;
    let projTimer = null;
    const onChange = (e) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        useStore.getState().fetchSessions(selectedProject.hash, { silent: true });
      }, 600);
      // 未知 projectHash(如 worktree 首条消息落盘的新目录)→ 刷新项目列表让它冒出来。
      // 已知 hash 直接跳过 + 800ms 去抖,busy stream 不会风暴。
      const ph = e?.detail?.projectHash;
      if (ph && !useStore.getState().projects.some((p) => p.hash === ph)) {
        if (projTimer) clearTimeout(projTimer);
        projTimer = setTimeout(() => useStore.getState().fetchProjects(), 800);
      }
    };
    window.addEventListener('cgui:sessions-changed', onChange);
    // WS 重连成功 → 断线期间的 file-change 广播已丢,补拉一次列表对账(复用同一去抖)。
    window.addEventListener('cgui:ws-reconnected', onChange);
    return () => {
      window.removeEventListener('cgui:sessions-changed', onChange);
      window.removeEventListener('cgui:ws-reconnected', onChange);
      if (timer) clearTimeout(timer);
      if (projTimer) clearTimeout(projTimer);
    };
  }, [selectedProject?.hash]);

  // 新建会话时继承「上一个活跃会话」的思考强度(免得每次重选),
  // 但权限模式恒为 default(用户要求:新会话别带上一次的宽松权限)。draft key = `draft-<hash>`
  // (与 sessionQueueKey 对齐);migrateSessionKey 在 init 后会把这些随真 sid 迁移,所以链条
  // 能一直顺延:下一次新建读到的「上一个会话」就是刚发的那个真会话。
  const seedNewSessionDefaults = (draftProjectHash) => {
    const st = useStore.getState();
    const prev = splitMode ? st.paneSessions?.[activeTabIndex] : st.selectedSession;
    const prevKey = prev ? (prev.sessionId || `draft-${prev.projectHash || 'none'}`) : null;
    const draftKey = `draft-${draftProjectHash || 'none'}`;
    if (prevKey && prevKey !== draftKey) {
      // model 不继承上一个会话:新会话应跟随当前 provider 的默认模型(currentModel,
      // 由 provider 切换/默认模型设置决定)。继承旧会话 model 会盖掉用户刚设的 provider
      // 默认(且跨 provider 时会串到旧 provider 的模型 id)。effort/agent 是工作流偏好,
      // 与 provider 无关,继续继承。  // ponytail: model 跟 provider 默认,不跟上条会话
      st.setModelFor(draftKey, ''); // 清掉 draftKey 可能残留的旧 pin → getModelFor 回落 currentModel
      st.setEffortFor(draftKey, st.getEffortFor(prevKey));
    }
    // 修正批#2:主控 agent 前端入口已删,新会话必须清掉 draftKey 残留——否则历史上
    // 选过 agent 的用户会"隐形"带 agent 起新会话,界面上无处可见/可改。发送链保留。
    // 放在 if 外:prevKey 为空或与 draftKey 相同(同项目重复新建)时残留同样要清。
    st.setActiveAgentFor(draftKey, '');
    st.setPermissionMode('default', draftKey);
  };

  const handleNew = () => {
    if (!selectedProject) return;
    seedNewSessionDefaults(selectedProject.hash);
    // A "draft" session has no sessionId yet; the real one is captured from the
    // first stream-json system/init event and patched into the active session
    // slot (split or single).
    const draft = {
      draft: true,
      draftId: newDraftId(),
      sessionId: null,
      projectHash: selectedProject.hash,
      projectPath: selectedProject.path,
      firstPrompt: '新会话',
    };
    if (splitMode) {
      setActiveTabSession(draft);
      useStore.getState().setPaneMessages(activeTabIndex, []);
    } else {
      setSelectedSession(draft);
      useStore.setState({ messages: [] });
      useStore.getState().setPaneMessages(0, []);
    }
  };

  // Worktree picker modal — opens with list of existing worktrees (each
  // showing branch / last commit / dirty file count) so user can pick one,
  // OR create a new one by filling a name input.
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [worktreeList, setWorktreeList] = useState(null);
  const [newWorktreeName, setNewWorktreeName] = useState('');
  // 新建的可选基点:'' = 当前 HEAD(保持既有行为);候选来自 GET /api/worktree 的 branches。
  const [worktreeBranches, setWorktreeBranches] = useState([]);
  const [newWorktreeBase, setNewWorktreeBase] = useState('');
  // "基于分支"下拉展开态。原生 <select> 的弹出菜单由 OS 渲染、无法限高,本地分支
  // 几百个时列表过长 → 换自绘弹层(限高+内部滚动,不截断数据)。
  const [wtBaseOpen, setWtBaseOpen] = useState(false);
  // 审计批E4:基点下拉换 AnchoredPopover(body portal)。原自绘 absolute 弹层配
  // fixed inset-0 遮罩,遮罩被模态卡 glassRise 残留 transform 困在卡内 → 点卡外
  // 关不掉下拉(点到的是模态遮罩直接整窗关闭)。
  const wtBaseBtnRef = useRef(null);
  // Esc 关闭该下拉:捕获阶段拦下 + stopPropagation,阻断冒泡阶段的「双击 Esc 停止流」
  // 监听(App 挂在 window 冒泡阶段),避免关弹层的 Esc 被计入停止连击。
  // 与 FileExplorerPanel 右键菜单的 Esc 同款口径。
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
  // 行内展开态:{ path, mode:'commits'|'dirty', loading, commits?, files?, error?,
  // checked?:Set, message?, committing? } —— 一次只展开一行,再点同项收起。
  const [wtExpand, setWtExpand] = useState(null);
  // agent 临时工作树分组(CLI 子代理自动建的 .claude/worktrees/agent-*)是否展开,默认收起。
  const [wtAgentOpen, setWtAgentOpen] = useState(false);

  // 展开某树的领先 commit 列表(点"领先 N"徽章)。
  const toggleWtCommits = async (t) => {
    if (wtExpand?.path === t.path && wtExpand.mode === 'commits') { setWtExpand(null); return; }
    setWtExpand({ path: t.path, mode: 'commits', loading: true });
    try {
      const q = `cwd=${encodeURIComponent(selectedProject.path)}&path=${encodeURIComponent(t.path)}`;
      const r = await fetch(`/api/worktree/commits?${q}`);
      const d = await r.json();
      setWtExpand((s) => s && s.path === t.path
        ? (r.ok ? { ...s, loading: false, commits: d.commits || [], base: d.base }
                : { ...s, loading: false, error: d.error || `${r.status}` })
        : s);
    } catch (e) {
      setWtExpand((s) => s && s.path === t.path ? { ...s, loading: false, error: e.message } : s);
    }
  };

  // 展开某树的脏文件勾选提交面板(点"N 未提交文件"徽章)。
  const toggleWtDirty = async (t) => {
    if (wtExpand?.path === t.path && wtExpand.mode === 'dirty') { setWtExpand(null); return; }
    setWtExpand({ path: t.path, mode: 'dirty', loading: true, checked: new Set(), message: '' });
    try {
      const q = `cwd=${encodeURIComponent(selectedProject.path)}&path=${encodeURIComponent(t.path)}`;
      const r = await fetch(`/api/worktree/dirty?${q}`);
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
        body: JSON.stringify({ cwd: selectedProject.path, path: t.path, files, message }),
      });
      const d = await r.json();
      if (!r.ok) { setWtExpand((x) => x && x.path === t.path ? { ...x, committing: false } : x); return confirmDialog('提交失败：' + (d.error || r.status)); }
      setWtExpand(null);
      openWorktreePicker(); // 刷新脏文件数/领先数
    } catch (err) {
      setWtExpand((x) => x && x.path === t.path ? { ...x, committing: false } : x);
      confirmDialog('提交失败：' + err.message);
    }
  };

  const openWorktreePicker = async () => {
    if (!selectedProject) return;
    setWorktreeOpen(true);
    setWorktreeList(null);
    setWtExpand(null);
    setWtBaseOpen(false);
    try {
      const r = await fetch(`/api/worktree?cwd=${encodeURIComponent(selectedProject.path)}`);
      const d = await r.json();
      // 错误如实显示(非 git 仓库/门禁拒绝等):吞成空列表会显示"没有现有 worktree"
      // 并把用户引去新建,新建才报真实错误。
      if (r.ok) { setWorktreeList(d.trees || []); setWorktreeBranches(d.branches || []); }
      else setWorktreeList({ error: d.error || `${r.status}` });
    } catch (e) {
      setWorktreeList({ error: e.message });
    }
  };

  const enterWorktree = (tree) => {
    if (!tree?.path || !selectedProject) return;
    // 种子必须种在 worktree 自己的 draft 键上(与下方 draft.projectHash 同一 dash 算法)。
    // 曾传 selectedProject.hash(主项目):worktree draft 无权限条目 → getPermissionModeFor
    // 回退全局上次模式,上次开的 bypassPermissions 会直接泄进 worktree 新会话。
    const wtHash = tree.path.replace(/[^A-Za-z0-9]/g, '-');
    seedNewSessionDefaults(wtHash);
    // #9 左侧会话列表切到该 worktree(否则点了 worktree、左侧仍停在原项目分支)。已跑过会话的
    // worktree 用 projects 里的真实条目;首次进入无条目则构造最小对象(fetchSessions 返回空,正常)。
    // 注意:本函数作用域没有解构 projects/setSelectedProject/fetchSessions,必须走 getState()——
    // 直接引用会抛 "Can't find variable: projects",createWorktree 完进入与点击切换都会炸。
    const st = useStore.getState();
    const wtProject = st.projects.find((p) => p.hash === wtHash) || { hash: wtHash, path: tree.path, isWorktree: true, sessionCount: 0, lastActivity: null };
    st.setSelectedProject(wtProject);
    st.fetchSessions(wtHash);
    const draft = {
      draft: true,
      draftId: newDraftId(),
      sessionId: null,
      // projectHash 必须按 worktree 自己的 cwd 编码(CLI 同款 dash 规则):CLI 按
      // 进程 cwd 落盘 jsonl,若沿用主项目 hash,重进后 fetchMessages/回滚/checkpoints
      // 全部对错目录(会话显示空白、只以独立 worktrees 项目冒出)。
      projectHash: tree.path.replace(/[^A-Za-z0-9]/g, '-'),
      projectPath: tree.path,
      firstPrompt: `新会话 · ${tree.branch || formatPathShort(tree.path)}`,
    };
    if (splitMode) {
      setActiveTabSession(draft);
      useStore.getState().setPaneMessages(activeTabIndex, []);
    } else {
      setSelectedSession(draft);
      useStore.setState({ messages: [] });
      useStore.getState().setPaneMessages(0, []);
    }
    setWorktreeOpen(false);
  };

  const createWorktree = async () => {
    if (!selectedProject) return;
    const name = (newWorktreeName || '').trim() || `session-${Date.now()}`;
    try {
      const r = await fetch('/api/worktree', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: selectedProject.path, name, ...(newWorktreeBase ? { base: newWorktreeBase } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) return confirmDialog('创建 worktree 失败：' + d.error);
      // 复用了已存在的同名分支(删 worktree 时分支保留,同名重建会检出旧分支)——
      // 该分支可能落后当前 HEAD 很久,提示用户,别让他以为拿到的是最新代码。
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

  // 在 Finder/资源管理器中显示该树目录(远程访问时打开的是服务器本机,预期行为)。
  const revealWorktree = async (tree, e) => {
    e?.stopPropagation();
    if (!tree?.path || !selectedProject) return;
    try {
      const r = await fetch('/api/worktree/reveal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: selectedProject.path, path: tree.path }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        confirmDialog('打开失败：' + (d.error || r.status));
      }
    } catch (err) {
      confirmDialog('打开失败：' + err.message);
    }
  };

  // 领先/落后计数的基准名(与 server 的 aheadBase 同口径):分支有 upstream 时
  // 相对上游计数,否则相对主工作区分支——文案必须注明基准,别一律写"主分支"。
  const wtBaseLabel = (t) => (t.aheadBase === 'upstream' ? '上游' : (t.aheadBase || '主分支'));

  // 一键把 worktree 分支 merge 进主工作区当前分支。冲突时服务端已自动 abort,这里只负责
  // 把冲突文件清单如实呈现;成功后刷新列表(领先数归零)。
  const mergeWorktree = async (tree, e) => {
    e?.stopPropagation();
    if (!tree?.path || !selectedProject || tree.isMain) return;
    const mainTree = Array.isArray(worktreeList) ? worktreeList.find((t) => t.isMain) : null;
    const msg = `把分支 ${tree.branch || '(detached)'} 合并到 ${mainTree?.branch || '主工作区当前分支'}？\n\n` +
      `该分支相对${wtBaseLabel(tree)}领先 ${tree.aheadCount || 0} 个提交。合并在主工作树执行；若有冲突会自动取消,不留半合并状态。`;
    if (!(await confirmDialog(msg))) return;
    try {
      const r = await fetch('/api/worktree/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: selectedProject.path, path: tree.path }),
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
      openWorktreePicker(); // 刷新领先/落后计数
    } catch (err) {
      confirmDialog('合并失败：' + err.message);
    }
  };

  const deleteWorktree = async (tree, e) => {
    e?.stopPropagation();
    if (!tree?.path || !selectedProject || tree.isMain) return;
    const dirty = tree.dirtyFileCount > 0;
    const hasBranch = tree.branch && tree.branch !== '(detached)';
    // 领先提交提示:分支保留所以 commit 不丢,明说免得用户误以为删树=丢工作。
    const aheadNote = tree.aheadCount > 0 ? `该工作树领先 ${tree.aheadCount} 个提交，删除后分支保留、提交不丢。\n` : '';
    const msg = dirty
      ? `删除这个 worktree 会丢失 ${tree.dirtyFileCount} 个未提交修改：\n${tree.path}\n\n${aheadNote}默认只删工作树文件夹，分支 ${tree.branch || ''} 保留。确定强制删除？`
      : `删除 worktree：\n${tree.path}\n\n${aheadNote}默认只删工作树文件夹，分支 ${tree.branch || ''} 保留。确定？`;
    // 分支存在时给勾选项「同时删除分支」(#3)。返回 { confirmed, checked };无分支(detached)退回布尔。
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
        body: JSON.stringify({ cwd: selectedProject.path, path: tree.path, force: dirty, deleteBranch }),
      });
      const d = await r.json();
      if (!r.ok) return confirmDialog('删除失败：' + (d.error || ''));
      // 树删成功但分支没删掉(如被别处检出):不算整体失败,单独提示,列表照常刷新。
      if (deleteBranch && d.branch && !d.branchDeleted) {
        confirmDialog(`工作树已删除，但分支 ${d.branch} 未能删除：${d.branchError || '未知原因'}`, { confirmText: '知道了' });
      }
      // #9 副作用兜底:若删掉的正是当前选中的 worktree(enterWorktree 后 selectedProject 指向它),
      // 删后 selectedProject 悬空指向已删路径(会话列表刷空、picker 依赖该 cwd 会拉取失败)→ 切回
      // 项目列表。否则(在主仓里删别的 worktree)照常刷新弹窗。
      if (selectedProject.path === tree.path) useStore.getState().setSelectedProject(null);
      else openWorktreePicker(); // 刷新列表
    } catch (err) {
      confirmDialog('删除失败：' + err.message);
    }
  };

  // Back-compat: keep handleNewWorktree name pointing at the new picker.
  const handleNewWorktree = openWorktreePicker;

  const handleFork = async (session) => {
    setForking(session.sessionId);
    try {
      const res = await fetch('/api/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, projectHash: session.projectHash }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.newSessionId) {
        confirmDialog('分支失败：' + (data.error || res.status));
        return;
      }
      // The fork is a full-context copy under a new id. Open it: no split → add
      // a pane beside the current one; already split → replace the active pane.
      const fork = {
        sessionId: data.newSessionId,
        projectHash: session.projectHash,
        projectPath: session.projectPath,
        firstPrompt: session.firstPrompt,
        model: session.model,
        messageCount: session.messageCount,
      };
      const st = useStore.getState();
      adoptFork(st, session, data.newSessionId); // 命名「分支N」+ 继承 model/effort/权限(AZ7)
      if (selectedProject) st.fetchSessions(selectedProject.hash, { silent: true });
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

  const handleSelect = (session) => {
    if (splitMode) {
      setActiveTabSession(session);
      // Pass tab index so messages land in the correct slot (tab 1 stays
      // silent so it never flashes the global loader on tab 0).
      fetchMessages(session.sessionId, session.projectHash, { tab: activeTabIndex });
    } else {
      setSelectedSession(session);
      fetchMessages(session.sessionId, session.projectHash);
    }
  };

  // 倒计时期间从列表隐藏待删会话(文件还在,refetch 也会带回来,靠 sessionId 过滤)
  const pendingIds = new Set(pendingDeletes.map((p) => p.session.sessionId));
  const shown = pendingIds.size ? visible.filter((s) => !pendingIds.has(s.sessionId)) : visible;

  return (
    <div data-tour="sidebar-list" className="relative flex flex-col h-full">
      <div className="px-4 pt-4 pb-3 border-b border-canvas-deep">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <button onClick={() => useStore.getState().setSelectedProject(null)} className="p-0.5 hover:bg-canvas-deep rounded transition-colors shrink-0">
            <ArrowLeft size={14} className="text-ink-faint" />
          </button>
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-ink-faint font-body shrink-0">会话</h2>
          <span className="text-[10px] text-ink-ghost font-mono shrink-0">{sessions.length}</span>
          {/* 两个动作钮成组 + 父行 flex-wrap：侧栏窄到放不下时整组掉到第二行，
              不再被 aside 的 overflow-hidden 横向裁掉（CK-1）。 */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <button
              data-tour="new-worktree"
              onClick={handleNewWorktree}
              className="btn-glass flex items-center gap-1 px-2 py-1 text-[11px] font-body text-ink-soft whitespace-nowrap"
              title="在新 git worktree 中开会话（隔离）"
            >
              <GitBranch size={11} />worktree
            </button>
            <button
              data-tour="new-session"
              onClick={handleNew}
              className="btn-accent flex items-center gap-1 px-2 py-1 text-[11px] font-body whitespace-nowrap"
              title="新建会话"
            >
              <Plus size={11} />新建
            </button>
          </div>
        </div>
        <p className="text-xs text-ink-muted font-body truncate ml-6" title={formatPath(selectedProject?.path)}>{formatPathShort(selectedProject?.path)}</p>
        {/* Git status check at project level — fires immediately on project
            selection, doesn't wait for a session to be opened. This was the
            missing piece behind "新建项目文件夹不再自动检测 git 仓库"; the banner
            previously only mounted inside SessionDetail. */}
        <div className="-mx-4 mt-2">
          <GitInitBanner cwd={selectedProject?.path} />
        </div>
        <div className="relative mt-2">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-ghost" />
          <input
            type="text"
            placeholder="搜索会话标题…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-canvas border border-canvas-sunken rounded-lg pl-7 pr-3 py-1 text-[11px] text-ink placeholder-ink-ghost focus:outline-none focus:border-accent/40 font-body"
          />
        </div>
        <div className="flex items-center gap-1 mt-2 -mb-1">
          <button
            onClick={() => setShowArchived(false)}
            className={`px-2 py-0.5 text-[10.5px] rounded font-body transition-colors ${
              !showArchived ? 'bg-accent/15 text-accent' : 'text-ink-faint hover:text-ink-muted'
            }`}
          >活跃 <span className="font-mono opacity-70">{activeCount}</span></button>
          <button
            onClick={() => setShowArchived(true)}
            className={`px-2 py-0.5 text-[10.5px] rounded font-body transition-colors ${
              showArchived ? 'bg-accent/15 text-accent' : 'text-ink-faint hover:text-ink-muted'
            }`}
          >已归档 <span className="font-mono opacity-70">{archivedCount}</span></button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 stagger">
        {shown.map((session) => (
          <SessionItem
            key={session.sessionId}
            session={session}
            isSelected={focusSession?.sessionId === session.sessionId}
            onSelect={handleSelect}
            onFork={handleFork}
            onArchive={handleArchive}
            onDelete={handleDelete}
            forking={forking === session.sessionId}
            running={runningSessionIds.has(session.sessionId)}
            pinned={pinnedSessions.has(session.sessionId)}
            onTogglePin={togglePinSession}
          />
        ))}
        {shown.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-ink-faint font-body">
              {q ? '没有匹配的会话' : showArchived ? '没有已归档的会话' : '该项目没有活跃会话'}
            </p>
          </div>
        )}
      </div>

      {/* 删除撤销条:多条叠加,每条独立倒计时;倒计时结束前点撤销原样恢复(列表 +
          原分屏窗格)。max-h+滚动防批量删除时堆出侧栏边界。 */}
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

      {/* Worktree picker modal */}
      {worktreeOpen && createPortal((
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in"
          onClick={() => setWorktreeOpen(false)}
        >
          <div
            className="glass-popover w-[480px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[min(80vh,calc(var(--app-h,100dvh)-2rem))] flex flex-col py-1 animate-glass-rise"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 text-[11px] text-ink-faint uppercase tracking-wider font-body flex items-center justify-between border-b border-canvas-deep shrink-0">
              <span>选择 / 新建 Git Worktree</span>
              <div className="flex items-center gap-1">
                {/* 刷新:重跑 openWorktreePicker(它已 setWorktreeList(null)+重拉),看到别处新建的 worktree */}
                <button onClick={openWorktreePicker} title="刷新列表"
                  className="p-1 hover:bg-canvas-warm rounded" disabled={worktreeList === null}>
                  <RefreshCw size={12} className={worktreeList === null ? 'animate-spin' : ''} />
                </button>
                <button onClick={() => setWorktreeOpen(false)} className="p-1 hover:bg-canvas-warm rounded">
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
                // agent 临时工作树(CLI 子代理在 .claude/worktrees/agent-* 自动创建)归入
                // 折叠分组:默认收起但不隐藏(仍可进入/删除回收);用户自建树照常平铺。
                const isAgentTree = (t) => /[\\/]\.claude[\\/]worktrees[\\/]agent-/.test(t.path || '');
                const agentTrees = worktreeList.filter(isAgentTree);
                const userTrees = worktreeList.filter((t) => !isAgentTree(t));
                // merge 的真实目标 = 主工作区当前检出的分支(主项目本身是 worktree 时未必叫"主分支")
                const mainBranchName = worktreeList.find((t) => t.isMain)?.branch;
                const renderTree = (t) => (
                  <div key={t.path} className="mb-1">
                   <div className="flex items-stretch gap-1">
                    {/* 行容器改 div role=button:徽章是可点击控件,button 嵌 button 非法(WKWebView 行为不可预测) */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => { if (!t.prunable) enterWorktree(t); }}
                      onKeyDown={(e) => { /* target===currentTarget:徽章上按 Enter 冒泡不误触进入 */ if (!t.prunable && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); enterWorktree(t); } }}
                      title={t.prunable ? '目录已丢失(被手动删除),只能删除此记录' : undefined}
                      className={`flex-1 min-w-0 text-left px-3 py-2 rounded-lg border transition-colors group ${t.prunable ? 'opacity-50 cursor-not-allowed border-canvas-deep' : selectedProject?.path === t.path ? 'border-accent bg-accent/8 cursor-pointer' : 'border-canvas-deep hover:bg-canvas-warm cursor-pointer'}`}
                    >
                      <div className="flex items-center gap-2 mb-0.5 min-w-0 flex-wrap">
                        <GitBranch size={12} className="text-accent shrink-0" />
                        <span className="text-xs font-medium font-mono text-ink truncate min-w-0">
                          {t.branch || '(detached)'}
                        </span>
                        {t.isMain && (
                          <span className="text-[9px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono">主</span>
                        )}
                        {selectedProject?.path === t.path && (
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
                    {/* 侧栏操作键与行按钮并列(button 嵌 button 非法):打开目录 / 合并 / 删除 */}
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
                   {/* 行内展开:领先 commit 列表 / 脏文件勾选提交。
                       右边距按该行实际渲染的侧按钮数对齐(打开目录/合并/删除,与上方渲染条件
                       一致,每键 31px 宽 + gap-1 4px ≈ 35px),原 mr-9 只按 1 个按钮估的。 */}
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
                         // dirty 勾选提交
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
                {/* 可选基点:默认当前 HEAD;选了分支则新分支从它出发(复用旧分支时无效) */}
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
                    {/* 审计批E4:AnchoredPopover(body portal + 越界翻转/夹紧 + 点外/Esc 关闭)。
                        本地分支可达数百条:限高 + 内部滚动,截断到前 50 条(需要更靠后的
                        分支可在左侧输入框直接填名字)。 */}
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
      ), document.body)}
    </div>
  );
}

// ─── Empty State ───────────────────────────────────────────────
// 按是否已有项目分支:无项目给「添加项目」(否则提示"从左侧开始"而左侧也是空的,
// 新用户没有下一步);有项目未选会话给「新建会话」。tabIndex = 所在窗格,新会话
// 写进该窗格自身(分屏下别的窗格不动)。
function EmptyState({ tabIndex = 0 }) {
  const hasProject = useStore((s) => !!s.selectedProject);
  const addProject = () => {
    // 「添加项目」流程(系统选择器/路径弹窗)在侧栏 ProjectList 内,经事件触达;
    // 侧栏收起时先展开,让 ProjectList 挂载后再派发。
    const st = useStore.getState();
    if (st.sidebarCollapsed) st.toggleSidebar();
    if (st.selectedProject) st.setSelectedProject(null); // 侧栏可能停在会话列表
    setTimeout(() => window.dispatchEvent(new CustomEvent('cgui:add-project')), 60);
  };
  const newSession = () => {
    const st = useStore.getState();
    const proj = st.selectedProject;
    if (!proj) return;
    st.setPaneSession(tabIndex, { draft: true, draftId: newDraftId(), sessionId: null, projectHash: proj.hash, projectPath: proj.path, firstPrompt: '新会话' });
    st.setPaneMessages(tabIndex, []);
  };
  return (
    <div className="mobile-empty-state flex-1 flex items-center justify-center glass-base m-3 rounded-2xl relative animate-glass-rise">
      <div className="text-center relative z-10">
        <div className="w-20 h-20 rounded-3xl glass-thin flex items-center justify-center mx-auto mb-6">
          <Layers size={32} className="text-accent" />
        </div>
        {hasProject ? (
          <>
            <h3 className="text-[22px] font-display font-semibold text-ink mb-1.5 tracking-tight">选择一个会话</h3>
            <p className="text-[13px] text-ink-muted font-body">从左侧会话列表选一条历史记录，或直接开始新会话</p>
            <button onClick={newSession}
              className="mt-5 px-4 py-2 rounded-full bg-accent text-on-accent text-[13px] font-body hover:bg-accent/90 transition-colors">
              新建会话
            </button>
          </>
        ) : (
          <>
            <h3 className="text-[22px] font-display font-semibold text-ink mb-1.5 tracking-tight">添加一个项目开始</h3>
            <p className="text-[13px] text-ink-muted font-body">选择一个本地文件夹作为项目，会话将在其中进行</p>
            <button onClick={addProject}
              className="mt-5 px-4 py-2 rounded-full bg-accent text-on-accent text-[13px] font-body hover:bg-accent/90 transition-colors">
              添加项目文件夹
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── CLI-style spinner ─────────────────────────────────────────
// Mimics claude-code terminal: a 6-point asterisk that cycles through Unicode
// frames every ~100ms, paired with a verb that changes every ~3s.

// Loading 动画样式库(选项 id 对应 index.css 的 .loading-<id>,移植自 clawd-station)。
// 'cli' = 原 ASCII spinner,保持默认外观不变。主题弹窗里选,存 store.loadingStyle。
export const LOADING_OPTIONS = [
  { id: 'cli', label: 'CLI(默认)' },
  { id: 'ring', label: 'Ring' }, { id: 'ring-dual', label: 'Dual Ring' },
  { id: 'ring-dash', label: 'Dash Ring' }, { id: 'ring-thin', label: 'Thin Ring' },
  { id: 'ring-bold', label: 'Bold Ring' }, { id: 'ring-reverse', label: 'Reverse' },
  { id: 'orbit', label: 'Orbit' }, { id: 'orbit-double', label: 'Double Orbit' },
  { id: 'orbit-slow', label: 'Slow Orbit' }, { id: 'orbit-fast', label: 'Fast Orbit' },
  { id: 'pulse', label: 'Pulse' }, { id: 'pulse-soft', label: 'Soft Pulse' },
  { id: 'pulse-ring', label: 'Pulse Ring' }, { id: 'dots', label: 'Dots' },
  { id: 'dots-wave', label: 'Dot Wave' }, { id: 'dots-chase', label: 'Dot Chase' },
  { id: 'bars', label: 'Bars' }, { id: 'bars-wave', label: 'Bar Wave' },
  { id: 'bars-rise', label: 'Bar Rise' }, { id: 'square', label: 'Square' },
  { id: 'square-flip', label: 'Flip' }, { id: 'diamond', label: 'Diamond' },
  { id: 'typing', label: 'Typing' }, { id: 'scan', label: 'Scan' },
  { id: 'radar', label: 'Radar' }, { id: 'breath', label: 'Breath' },
  { id: 'spark', label: 'Spark' }, { id: 'flower', label: 'Flower' },
  { id: 'clock', label: 'Clock' }, { id: 'pinwheel', label: 'Pinwheel' },
];

// 统一加载指示:按用户选的样式渲染;variant 传入时强制该样式(预览网格用)。
// ③ 全局自定义背景层(设置→外观→界面背景)。绝对定位铺满 app 根节点,-z-10 垫在
// 所有面板之下(根节点 relative isolate 建立独立层叠上下文,把 -z-10 限定在 app 内、
// 不掉到 body 之后)。各面板(侧栏/顶栏/会话区/输入框)用半透明玻璃透出此层;弹层
// (.glass-popover)恒不透底。遮罩 = 主题底色(--color-canvas)按 maskOpacity 盖在背景上,
// 深浅主题都保证文字可读。未设置背景时返回 null,与改动前外观完全一致(此时透出的是
// body 的主题底色/晴空天空渐变,无需内置任何图片)。数据沿用 chatBackground 字段,老用户
// 已设的背景无缝升级为全局,无迁移。
function GlobalBackgroundLayer() {
  const bg = useStore((s) => s.chatBackground);
  if (!bg || !bg.kind) return null;
  const mask = Math.min(100, Math.max(0, Number(bg.maskOpacity ?? 40)));
  const veil = `color-mix(in srgb, var(--color-canvas) ${mask}%, transparent)`;
  const src = bg.file ? `/api/backgrounds/${encodeURIComponent(bg.file)}` : '';
  return (
    <div className="absolute inset-0 -z-10 pointer-events-none overflow-hidden" aria-hidden="true">
      {bg.kind === 'color' && (
        <div className="absolute inset-0" style={{ backgroundColor: bg.color || 'transparent' }} />
      )}
      {bg.kind === 'image' && src && (
        <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${src}")` }} />
      )}
      {bg.kind === 'video' && src && (
        <video className="absolute inset-0 w-full h-full object-cover" src={src} autoPlay loop muted playsInline />
      )}
      <div className="absolute inset-0" style={{ background: veil }} />
    </div>
  );
}


// ─── 压缩进度条 ────────────────────────────────────────────────
// SDK 不流式发压缩百分比(只在完成后给 compact_boundary 的 pre/post_tokens),终端里
// 那个 % 是 CLI 自画的估算动画。GUI 拿不到真实进度 → 做不确定态动画条(视觉对齐终端),
// 诚实表达"进行中"而不假装精确百分比。
function CompactProgressBar() {
  return (
    <div className="mt-2 w-full max-w-[280px]">
      <div className="h-1.5 rounded-full bg-canvas-deep/50 overflow-hidden relative">
        <div className="cgui-compact-sweep absolute inset-y-0 w-1/3 rounded-full" style={{ background: '#D97757' }} />
      </div>
    </div>
  );
}

// ─── Streaming status line ─────────────────────────────────────
// Inline status that mirrors the CLI's "✻ Frolicking…" prompt — spinner
// char + verb + optional tool/phase detail. Updates live as the model
// moves through phases inside one turn.

function StreamingStatusLine({ thinking, text, toolCalls, streamStart }) {
  const verb = useCyclingVerb();
  let label = null;
  // Latest unresolved tool call (no result yet) → "Bash(ls)"
  const pendingTool = [...toolCalls].reverse().find((tc) => !tc.result);
  if (pendingTool) {
    const preview =
      pendingTool.input?.command ||
      pendingTool.input?.file_path?.split(/[/\\]+/).pop() ||
      pendingTool.input?.pattern ||
      pendingTool.input?.query || '';
    const previewStr = String(preview).slice(0, 60);
    label = `${pendingTool.name}${previewStr ? `(${previewStr})` : ''}`;
  } else if (text) {
    label = 'Writing';
  } else if (thinking) {
    label = verb;
  } else {
    // 不再 return null:不发 partial stream_event 的第三方(mimo/kimi/glm)只走整条
    // assistant 消息路径,工具结果全回来后、下一条整消息到达前的空窗期 text/thinking/
    // pendingTool 全空 → 原来这里隐藏整行,用户看到"橙色动态文本时有时无"(#10)。
    // 官方靠 delta 立即填充故无感。回退显示动态词,与官方观感一致;回合结束(isStreaming
    // false)整块卸载,不会滞留。
    label = verb;
  }
  // 统一动效(用户反馈"跳动动画→静态头像"割裂):动画载体收敛到回复气泡的
  // ✻ 头像位(TurnBubble 的 ProviderAvatar thinking 态),状态行只保留纯文字,
  // 缩进 50px(34px 头像 + 16px gap)与气泡正文列对齐,渲染在气泡下方。
  return (
    <div className="px-6 -mt-2 pb-3 animate-fade-in">
      <div className="max-w-[var(--content-max)] mx-auto flex items-center gap-2 pl-[50px] text-[13px] text-ink-soft font-body" style={{ color: '#D97757' }}>
        {/* 状态行指示器用主题选的加载动画(与下方 Connecting 行一致);LoadingMark 继承
            currentColor,外层 style 已置橙 #D97757 —— cli 默认帧与其它 30 种样式同色。 */}
        <span className="shrink-0 inline-flex items-center"><LoadingMark size={13} /></span>
        <span className="font-mono truncate font-medium" style={{ color: '#D97757' }}>{label}</span>
        <span style={{ color: '#D97757' }}>…</span>
        <ElapsedTime startedAt={streamStart} className="ml-1" />
      </div>
    </div>
  );
}

// ─── Git Init Banner ───────────────────────────────────────────
// Non-blocking replacement for the native confirm() git preflight (which got
// silently suppressed by browsers / hidden behind modals, leaving sends stuck).
// Shows an orange bar above the chat when cwd isn't a git repo. User can
// either click "立即初始化" or dismiss ("本会话忽略" → sessionStorage).
// Permission-mode hint — sits below the session title when in `default`
// mode. Originally warned the CLI couldn't prompt for permissions in -p
// mode; that's no longer true after the PreToolUse bridge ships the popup.
// The banner now just nudges users who'd prefer a faster mode, with quick
// switches + a one-click "永久忽略" stored in localStorage.
function PermissionModeHintBanner({ permKey }) {
  // banner 只在 plan 模式显示:解释模式特性 + 给快捷切走。默认已是 default
  // (见 store.permissionMode),所以这条只在用户主动切到 plan 时才出现,不再误导。
  const permissionMode = useStore((s) => (permKey ? (s.permissionModeBySession[permKey] || s.permissionMode) : s.permissionMode));
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('cgui-perm-hint-dismissed') === '1'; }
    catch { return false; }
  });
  if (permissionMode !== 'plan' || dismissed) return null;
  const dismiss = () => {
    try { localStorage.setItem('cgui-perm-hint-dismissed', '1'); } catch {}
    setDismissed(true);
  };
  return (
    <div className="shrink-0 mx-6 mt-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 flex items-center gap-2 gap-y-1.5 flex-wrap text-[11px] font-body animate-fade-up">
      <Shield size={13} className="text-amber-600 shrink-0" />
      <span className="text-amber-800 flex-1 min-w-[12rem]">
        当前是<b>规划模式</b>:AI 会先生成执行计划,你审批后再动手。
        纯问答(不调工具)不会弹窗;想直接干活可切"逐步确认"或"接受编辑"。
      </span>
      <button
        onClick={() => setPermissionMode('default', permKey)}
        className="px-2 py-0.5 rounded bg-amber-100 hover:bg-amber-200 text-amber-900 text-[10px] font-medium shrink-0"
        title="每次工具调用都弹窗征求你同意"
      >切逐步确认</button>
      <button
        onClick={() => setPermissionMode('acceptEdits', permKey)}
        className="px-2 py-0.5 rounded bg-amber-100 hover:bg-amber-200 text-amber-900 text-[10px] font-medium shrink-0"
        title="只读类自动允许,写入类弹窗"
      >接受编辑</button>
      <button
        onClick={dismiss}
        className="px-2 py-0.5 rounded hover:bg-amber-100 text-amber-700 text-[10px] shrink-0"
        title="永久隐藏此提示(仍可通过权限模式选择器手动切换)"
      >忽略</button>
    </div>
  );
}

function GitInitBanner({ cwd }) {
  // 'unknown' | 'repo' | 'norepo' | 'dismissed' | 'busy' | 'done' | 'partial'
  const [status, setStatus] = useState(null);
  const [warning, setWarning] = useState(null);
  // Recheck git status whenever `cwd` changes OR a kick counter ticks (so we
  // can re-run the check after a successful init without remounting).
  const [kick, setKick] = useState(0);
  useEffect(() => {
    if (!cwd) return;
    const skipKey = `cgui-git-skip-${cwd}`;
    if (sessionStorage.getItem(skipKey)) { setStatus('dismissed'); return; }
    setStatus('unknown');
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      // T3: permissionDenied = macOS 没给本 app 磁盘权限(git 在 Desktop 等目录
      // 被 TCC 拒)。此时既不是 repo 也不该引导 init —— 显示权限引导横幅。
      .then((s) => setStatus(s?.gitMissing ? 'nogit' : (s?.permissionDenied ? 'tcc' : (s?.isRepo === false ? 'norepo' : 'repo'))))
      .catch(() => setStatus('repo'));  // network err → silent
  }, [cwd, kick]);

  if (status === 'tcc') {
    return (
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-[12px] font-body text-amber-900 flex items-center gap-2 flex-wrap">
        <Shield size={13} className="text-amber-600 shrink-0" />
        <span className="flex-1 min-w-[12rem]">
          macOS 拒绝了对该文件夹的访问(重装/升级后授权会失效)。请到 系统设置 → 隐私与安全性 → <b>完全磁盘访问</b>,将 Claude GUI 的开关<b>关掉再打开</b>(或重新添加),然后重启 GUI。
        </span>
        <button
          onClick={() => { fetch('/api/system/open-fda-settings', { method: 'POST' }).catch(() => {}); }}
          className="px-2 py-0.5 rounded bg-amber-100 hover:bg-amber-200 text-amber-900 text-[10px] font-medium shrink-0"
        >打开系统设置</button>
        <button
          onClick={() => setKick((k) => k + 1)}
          className="px-2 py-0.5 rounded hover:bg-amber-100 text-amber-700 text-[10px] shrink-0"
        >重新检测</button>
      </div>
    );
  }

  if (status === 'nogit') {
    return (
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-[12px] font-body text-amber-900 flex items-center gap-2 flex-wrap">
        <GitBranch size={13} className="text-amber-600 shrink-0" />
        <span className="flex-1 min-w-[12rem]">
          未检测到 <b>git</b>。装上 git 才能初始化仓库 / 回滚 AI 的修改。可在 通用 → 环境 里安装，或到 <b>git-scm.com</b> 下载。
        </span>
        <button
          onClick={() => setKick((k) => k + 1)}
          className="px-2 py-0.5 rounded hover:bg-amber-100 text-amber-700 text-[10px] shrink-0"
        >重新检测</button>
      </div>
    );
  }

  if (status !== 'norepo' && status !== 'busy' && status !== 'done' && status !== 'partial') return null;

  const init = async () => {
    setStatus('busy');
    setWarning(null);
    try {
      const r = await fetch('/api/git/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        // Re-check status from the server — banner hides if isRepo flipped.
        setKick((k) => k + 1);
        if (data.baselineWarning) {
          setWarning(data.baselineWarning);
          setStatus('partial');
        } else {
          setStatus('done');
        }
      } else {
        confirmDialog('git init 失败：' + (data.error || r.status));
        setStatus('norepo');
      }
    } catch (err) { confirmDialog('git init 失败：' + err.message); setStatus('norepo'); }
  };

  const dismiss = () => {
    try { sessionStorage.setItem(`cgui-git-skip-${cwd}`, '1'); } catch {}
    setStatus('dismissed');
  };

  if (status === 'done') {
    return (
      <div className="bg-green-50 border-b border-green-200 px-4 py-2 text-[12px] font-body text-green-800 flex items-center gap-2">
        <GitBranch size={13} className="text-green-700 shrink-0" />
        <span className="flex-1">已 <code className="font-mono">git init</code> + 基线提交，AI 修改可随时回滚。</span>
      </div>
    );
  }

  if (status === 'partial') {
    return (
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-[12px] font-body text-amber-900 flex items-start gap-2">
        <GitBranch size={13} className="text-amber-700 shrink-0 mt-0.5" />
        <span className="flex-1">
          <b>已 <code className="font-mono">git init</code>，基线提交跳过</b>
          ：目录里含嵌入式 git 仓库无法 <code className="font-mono">add -A</code>。回滚仍可用（基于发送前的 checkpoint），但全量基线提交不会被记录。
          {warning && <span className="block text-[10.5px] text-amber-700 mt-1 font-mono truncate">{warning.slice(0, 200)}</span>}
        </span>
        <button onClick={dismiss} className="text-amber-700 hover:text-amber-900 underline text-[11px] shrink-0">本会话忽略</button>
      </div>
    );
  }

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-[12px] font-body text-amber-900 flex items-center gap-2">
      <GitBranch size={13} className="text-amber-700 shrink-0" />
      <span className="flex-1">
        <b>这个目录不是 git 仓库</b>。建议先 init + 基线提交，方便回滚 AI 的修改。
      </span>
      <button
        onClick={init}
        disabled={status === 'busy'}
        className="px-2.5 py-1 rounded bg-amber-700 text-white text-[11px] font-medium hover:bg-amber-800 disabled:opacity-50 shrink-0"
      >
        {status === 'busy' ? '初始化中…' : '立即初始化'}
      </button>
      <button
        onClick={dismiss}
        className="px-2 py-1 rounded text-amber-800 text-[11px] hover:bg-amber-100 shrink-0"
      >
        本会话忽略
      </button>
    </div>
  );
}

// Collapsed marker shown where the CLI compacted the conversation (/compact).
// The full summary lives in the JSONL; we deliberately don't render it.

function CompactDivider() {
  return (
    <div className="max-w-[var(--content-max)] mx-auto px-4 py-3 flex items-center gap-3">
      <div className="flex-1 h-px bg-canvas-deep/60" />
      <span className="text-[10px] text-ink-faint font-body uppercase tracking-wider whitespace-nowrap">
        上下文已压缩
      </span>
      <div className="flex-1 h-px bg-canvas-deep/60" />
    </div>
  );
}

// AZ11/AZ2 性能根治:历史消息列表抽成 memo 子组件。流式只更新 chatMessages/
// streamingText(不动 messages),memo 命中 → 2万节点的历史列表在每个 token 不再
// 重渲染;点功能按钮使 SessionDetail 重渲时同样跳过(根治"流式时/点按钮全局卡、
// 分屏等 A 回复时 B 卡")。前提:传入回调必须引用稳定(见 stableRetry*/stableRollback)。
const MessageList = React.memo(function MessageList({ messages, onRetryTurn, onRetryTool, onRollback, onFork, retryActiveUuid }) {
  // BK-6:此前每行内联 `(toolCall) => onRetryTool(msg, toolCall)` 每次渲染新建箭头
  // 函数 → TurnBubble(自身 React.memo)的 onRetryTool prop 身份每次变 → memo 失效,
  // retryActiveUuid 一变(进/出"重做"态)就整表 2万节点重渲。改为按 msg.uuid 记忆化:
  // 每个 uuid 复用同一个包装函数(缓存在 ref 的 Map),包装内部走 onRetryToolRef 读
  // 最新父回调 → 身份恒定且 deps 不含 messages(遵循 long-session-memo-stable-callbacks)。
  const onRetryToolRef = useRef(onRetryTool);
  onRetryToolRef.current = onRetryTool;
  const toolCbCacheRef = useRef(new Map());
  const getToolCb = (msg) => {
    const cache = toolCbCacheRef.current;
    let cb = cache.get(msg.uuid);
    if (!cb) {
      cb = (toolCall) => onRetryToolRef.current?.(msg, toolCall);
      cache.set(msg.uuid, cb);
    }
    return cb;
  };
  return messages.map((msg, i) => (
    <div key={msg.uuid || i} data-turn-uuid={msg.uuid} data-turn-role={msg.type}>
      {msg.type === 'compact'
        ? <CompactDivider />
        : msg.type === 'turn'
        ? <TurnBubble turn={msg} onRetry={onRetryTurn} onRetryTool={getToolCb(msg)} onFork={onFork} retryActive={retryActiveUuid === msg.uuid} />
        : <MessageBubble message={{ ...msg, role: msg.type }}
            onRollback={msg.type === 'user' ? onRollback : undefined}
            onFork={msg.type === 'user' ? onFork : undefined} />}
    </div>
  ));
});

// 上下文达到此占比(%)时，GUI 侧弹出压缩建议横幅。
// 第一方(anthropic)由 CLI 原生 auto-compact 负责(约 92%)；第三方 provider 不支持
// count_tokens、上下文窗口被 CLI 当兜底源 → 原生 auto-compact 不可靠/不触发，由本横幅提示。
const AUTO_COMPACT_THRESHOLD = 80;

// GUI 侧压缩建议横幅(仅第三方 provider 启用)。idle 且占比越过阈值时弹出，由用户点击
// 「立即压缩」才发 /compact —— GUI 绝不自动触发压缩(原 10s 倒计时自动 /compact 会在
// 用户没看着时静默改写历史，且"曾用 1M 模型切回 200k"这类分母变化会让占比瞬间爆表、
// 直接误压，已改为显式确认)；"取消"则本"轮次"内不再提示(占比降回阈值下才重新武装)。
// 作为 SessionDetail 的子组件接收 contextPct —— 占比在父组件渲染末尾才算出、其后已无
// hook 位，放子组件可避免 hook 顺序问题。按 sessionId key，切会话自动重置内部状态。
function AutoCompactBanner({ contextPct, idle, enabled, onCompact }) {
  const [armed, setArmed] = useState(false);
  const dismissedRef = useRef(false);

  useEffect(() => {
    if (!enabled || contextPct < AUTO_COMPACT_THRESHOLD) {
      dismissedRef.current = false;        // 降回阈值下 → 重新武装下次
      if (armed) setArmed(false);
      return;
    }
    if (!idle || dismissedRef.current || armed) return;
    setArmed(true);
  }, [enabled, contextPct, idle, armed]);

  if (!armed) return null;
  return (
    <div className="shrink-0 mx-6 mt-2 px-3 py-2.5 rounded-md bg-amber-50 border border-amber-200 animate-fade-up">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-amber-800 text-[12px] font-body leading-snug">
          上下文已达 <b>{contextPct}%</b>，当前 provider 不会自动压缩 —— 建议手动压缩(/compact)后再继续。
        </span>
        <button
          onClick={() => { setArmed(false); dismissedRef.current = true; onCompact(); }}
          className="px-2.5 py-1 rounded text-[12px] font-medium text-white bg-amber-600 hover:bg-amber-700"
        >立即压缩</button>
        <button
          onClick={() => { setArmed(false); dismissedRef.current = true; }}
          className="px-2.5 py-1 rounded text-[12px] font-medium text-amber-800 border border-amber-300 hover:bg-amber-100"
          title="本轮不再提示，上下文占比降回阈值下后才会重新提醒"
        >取消</button>
      </div>
    </div>
  );
}

// ─── 会话导出 Markdown ──────────────────────────────────────────
// 纯前端:把已加载的消息(persisted messages + 本轮 chatMessages)转成 Markdown。
// 用户/助手正文原样;工具调用压成一行 `> 工具:名称(参数摘要)`;compact 分隔等噪音跳过。
function toolArgSummary(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.file_path || input.path || input.pattern
    || input.query || input.url || input.prompt || input.description || '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

function buildSessionMarkdown(msgs, title) {
  const lines = [`# ${title || '会话'}`, ''];
  for (const m of msgs) {
    if (!m || m.type === 'compact') continue;
    if (m.type === 'user') {
      const text = String(m.text || '').trim();
      if (!text) continue;
      lines.push('## 你', '', text, '');
    } else if (m.type === 'turn') {
      const text = (Array.isArray(m.text) ? m.text.join('\n') : (m.text || '')).trim();
      const tools = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      if (!text && tools.length === 0) continue;
      lines.push('## Claude', '');
      if (text) lines.push(text, '');
      for (const tc of tools) {
        const arg = toolArgSummary(tc.input);
        lines.push(`> 工具:${tc.name || '未知'}${arg ? `(${arg})` : ''}`);
      }
      if (tools.length) lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// 导出入口:一个按钮展开两个动作(下载 .md / 复制剪贴板)。照现有 header 按钮样式。
function ExportSessionButton({ messages, title }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const disabled = !messages || messages.length === 0;
  const safeTitle = (title || '会话').replace(/[\\/:*?"<>|\n]+/g, ' ').trim().slice(0, 40) || '会话';
  const fileName = `${safeTitle}-${new Date().toISOString().slice(0, 10)}.md`;

  const download = async () => {
    const md = buildSessionMarkdown(messages, title);
    // Tauri WKWebView 拦 blob 下载(点了没反应)→ 系统"保存"对话框选路径(用户要求),
    // 后端写到所选位置;对话框异常时回落旧行为(写 ~/Downloads)。浏览器用 blob。
    if (isTauri()) {
      try {
        let targetPath = null;
        try {
          const { save } = await import('@tauri-apps/plugin-dialog');
          targetPath = await save({
            title: '导出会话 Markdown',
            defaultPath: fileName,
            filters: [{ name: 'Markdown', extensions: ['md'] }],
          });
          if (targetPath === null) { setOpen(false); return; } // 用户取消,不导出
        } catch { /* 对话框不可用(capability 漂移)→ targetPath 留 null 回落 Downloads */ }
        const r = await fetch('/api/export-session', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ md, fileName, ...(targetPath ? { targetPath } : {}) }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || r.status);
        await confirmDialog('已导出到:\n' + d.path, { danger: false });
      } catch (e) {
        await confirmDialog('导出失败:' + String(e.message || e));
      }
    } else {
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    setOpen(false);
  };
  const copy = async () => {
    const md = buildSessionMarkdown(messages, title);
    const ok = await copyText(md);
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
    else { await confirmDialog('复制失败:浏览器拒绝了剪贴板访问，请改用"下载 Markdown"。', { danger: false }); }
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title="导出当前会话为 Markdown"
        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-ink-muted hover:text-ink hover:bg-canvas-warm font-body transition-colors disabled:opacity-40"
      >
        {copied ? <Check size={12} className="text-success" /> : <Download size={12} />}
        导出
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-40 rounded-lg bg-canvas border border-canvas-deep shadow-xl overflow-hidden">
          <button onClick={download}
            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-ink-soft hover:bg-canvas-warm font-body text-left">
            <Download size={12} />下载 Markdown
          </button>
          <button onClick={copy}
            className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-ink-soft hover:bg-canvas-warm font-body text-left">
            <ClipboardCopy size={12} />复制到剪贴板
          </button>
        </div>
      )}
    </div>
  );
}

// P1.2 会话头 ⋮:导出 / Checkpoint 收纳于此(点击原位展开原按钮组,再点外部/Esc 收起,
// 与面板坞同一交互)。按钮组件原样复用(各自的下拉/portal 弹层逻辑不动),零功能删除。
function SessionHeaderMore({ children, forceOpenSignal = 0 }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  // 空手双击 Esc 要弹 Checkpoint 时间线,而它就在本组下 —— 收起时组件根本没挂载。
  // 先把这一组展开,让 CheckpointButton 挂上去自己弹(见其 openSignal)。
  useEffect(() => { if (forceOpenSignal) setOpen(true); }, [forceOpenSignal]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      // Checkpoint 的弹层是 body portal(不在 wrap 内):点它不能收起本组,否则按钮先卸载、
      // 弹层随之消失,mousedown→click 之间条目点击直接失效。
      if (e.target?.closest?.('.glass-popover')) return;
      setOpen(false);
    };
    // R1:window 捕获(同 ThemeToggle,详见那里注释);stopPropagation 仍挡住会话级停止监听。
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onEsc, true);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onEsc, true); };
  }, [open]);
  return (
    <span ref={wrapRef} data-tour="session-menu" className="inline-flex items-center gap-1">
      {open && <span className="cgui-dock-rail inline-flex items-center gap-1 rounded-xl bg-black/5 px-1 py-0.5">{children}</span>}
      <button
        onClick={() => setOpen((v) => !v)}
        title="更多会话操作（导出 Markdown / Checkpoint 时间线）"
        className={`p-1.5 rounded-lg transition-colors ${open ? 'bg-accent-subtle text-accent' : 'text-ink-muted hover:text-ink hover:bg-canvas-warm'}`}
      >
        <MoreHorizontal size={14} />
      </button>
    </span>
  );
}

// ─── Session Detail ────────────────────────────────────────────
// React.memo:props 只有 tabIndex/mobileChrome(基元,稳定)。App 级状态变化(开面板、
// 分屏数变化等)导致父组件重渲染时,同 props 直接跳过,不再 reconcile 这棵巨大的消息树
// (重会话可达 2 万+ DOM 节点)——这是"点功能按钮卡、分屏更卡"的根因。组件内部 useStore
// 订阅的数据变化仍会正常重渲染,不影响功能。
const SessionDetail = React.memo(function SessionDetail({ tabIndex = 0, mobileChrome = false }) {
  // Split-mode tab routing: when tabIndex===1 we render the SECOND pane and
  // read from secondary{Session,Messages} + write back via setSecondarySession
  // / setSecondaryMessages. tabIndex===0 keeps the legacy globals untouched
  // so single-pane behavior is identical. EVERY downstream selectedSession
  // reference reads the local alias below, so the rest of this 700-line
  // component is unchanged.
  const { selectedProject, loading } = useStore();
  // Pane routing generalized to N panes (0..5). Each SessionDetail reads/writes
  // its own slot in paneSessions/paneMessages. setPaneSession/setPaneMessages
  // keep the legacy selectedSession/messages (pane 0) + secondary* (pane 1)
  // mirrors in sync, so the rest of this component is unchanged.
  const paneSessions = useStore((s) => s.paneSessions);
  const paneMessages = useStore((s) => s.paneMessages);
  const paneMessagesSid = useStore((s) => s.paneMessagesSid);
  const selectedSession = (paneSessions && paneSessions[tabIndex]) || null;
  // 空窗格时 paneMessages[tabIndex] 为 undefined,`|| []` 每次渲染造新数组 → 进下方多个
  // useMemo/useEffect deps 致每帧重跑。复用模块级冻结空数组保持引用稳定。
  // 串扰窗口1守卫(主诉根因):切会话只换 paneSessions,paneMessages 要等 fetch 异步
  // 回来才被覆盖 —— 这几十~几百 ms 里旧会话的历史会以新会话名义渲染(代办/计划/费用/
  // 模型徽章全部派生自 messages,一处守卫全治)。渲染期同步判归属,不属于当前会话就当
  // 空数组(模块级 EMPTY_ARRAY,引用稳定,防 zustand 新引用白屏 #185)。
  const messagesOwned = paneMessagesOwned(paneMessagesSid && paneMessagesSid[tabIndex], selectedSession?.sessionId);
  const messages = messagesOwned ? ((paneMessages && paneMessages[tabIndex]) || EMPTY_ARRAY) : EMPTY_ARRAY;
  // 本会话的队列/pin/owner key(草稿用 draft-<hash>)。必须在所有引用它的 effect 之前声明,
  // 否则 effect 依赖数组在渲染期先求值会命中 TDZ(Cannot access before initialization)。
  const sessionQueueKey = selectedSession?.sessionId || `draft-${selectedSession?.projectHash || 'none'}`;
  // C2:用于把 AutoCompactBanner 限定在「当前聚焦的 pane」——分屏下非聚焦 pane 不应
  // 在你没看着时静默 /compact 改写历史。单窗格时 activeTabIndex 恒为 0 = 本 pane。
  const paneIsActive = useStore((s) => s.activeTabIndex) === tabIndex;
  const paneCount = useStore((s) => s.paneCount);
  // 交互工具(AskUserQuestion/授权/计划审查)挂起时,徽章旁给"等待你回应"提示。
  // 实测(opus 调研):挂起前该次调用的 usage 已全部送达、徽章数据没漏;静止是因为
  // 你的答案要到模型下一次 API 调用的 message_start 才计入 —— 提示替代静止的误解。
  // 严格按本 pane 会话 id 门控(per-pane 纪律),布尔原始值选择器引用稳定。
  const _pendingSid = (paneSessions && paneSessions[tabIndex])?.sessionId || null;
  // 归属口径对齐 PermissionPrompt(:640-668):卡片显示了 btw 就必须让路,否则展开态 z-46
  // 盖住居中授权/计划卡右对齐的提交按钮、吃掉点击(#3 回归根因)。故认领两类请求:
  //  ① p.sessionId 命中本窗格会话;② 无 sessionId 的孤儿请求(draft 首个工具调用 / plan
  // 回合 CLI 尚未回 id)——孤儿只算在活动窗格,免得 A 窗格的挂起把 B 的浮窗一并收起。
  const hasPendingInteraction = useStore((s) =>
    s.pendingPermissions.some((p) =>
      (p.sessionId && p.sessionId === _pendingSid) || (!p.sessionId && paneIsActive)));
  // 窗内检索(Cmd/Ctrl+F)开关 —— 仅当前聚焦 pane 响应。
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    if (!paneIsActive) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 分屏下选中窗格按 Delete/Backspace = 从分屏移除该窗格(closePane 只隐藏窗格,绝不删会话/
        // 不杀进程;真删会话仍须去左侧列表手点)。守卫:①输入框/可编辑元素聚焦时放行(那是删字符)
        // ②分屏数>1 才有意义(单屏不关)。
        // Mac 笔记本的「delete」键就是 Backspace(无独立 Forward Delete),故两键都收;为防误触,
        // 排除【所有可交互/可编辑控件】聚焦态(输入框/按钮/下拉/链接/富文本)——只有真正点了窗格
        // 空白(body/div 聚焦)才关窗格,避免"点过按钮后焦点在按钮/body 时误按 Backspace 静默关窗"。
        const t = e.target;
        if (t && (/^(INPUT|TEXTAREA|BUTTON|SELECT|A)$/.test(t.tagName) || t.isContentEditable)) return;
        const st = useStore.getState();
        if ((st.paneCount || 1) <= 1) return;
        e.preventDefault();
        closePaneGuarded(tabIndex); // 正在运行/等授权时先确认(见 closePaneGuarded)
      }
    };
    // 审计批C1:手机无 Cmd+F,MobileMenu「会话内检索」行派发此事件;仅活动窗格响应
    // (与 Cmd+F 同门控),桌面不受影响。
    const onOpenSearch = () => setSearchOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('cgui:open-search', onOpenSearch);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('cgui:open-search', onOpenSearch);
    };
  }, [paneIsActive, tabIndex]);
  const setSelectedSession = useCallback((s) => {
    useStore.getState().setPaneSession(tabIndex, s);
  }, [tabIndex]);
  const setLocalMessages = useCallback((msgs) => {
    const st = useStore.getState();
    // 归属 = 写入时刻本 pane 的会话(回滚裁剪/工具重做等都是对当前显示内容的改写)。
    st.setPaneMessages(tabIndex, Array.isArray(msgs) ? msgs : [], st.paneSessions[tabIndex]?.sessionId || null);
  }, [tabIndex]);
  const getLocalMessages = useCallback(() => {
    return useStore.getState().paneMessages[tabIndex] || [];
  }, [tabIndex]);
  // Latest session for the local tab — used inside async callbacks where
  // closure'd `selectedSession` would be stale.
  const getLocalSession = useCallback(() => {
    return useStore.getState().paneSessions[tabIndex] || null;
  }, [tabIndex]);
  // Tab-aware fetchMessages wrapper: forwards tabIndex so the store writes
  // into the correct messages slot.
  const fetchMessagesForTab = useCallback((sid, ph, opts = {}) => {
    return useStore.getState().fetchMessages(sid, ph, { ...opts, tab: tabIndex });
  }, [tabIndex]);
  // Subscribe to these EARLY (before any conditional return) so React's hook
  // order stays stable. After a session-load transition we'd otherwise add a
  // hook below the early return → React #310 → blank page.
  const currentProvider = useStore((s) => s.currentProvider);
  // 整会话用量聚合(服务端随 /messages 端点算好,keyed by sessionId)。取到则顶部
  // 用量条不再对全量历史消息逐帧 reduce。map 里的对象引用稳定,null 兜底不造新引用。
  const serverUsageTotals = useStore((s) => (selectedSession?.sessionId && s.usageTotalsBySession[selectedSession.sessionId]) || null);
  // #9/AZ6 子代理会话窗口:每个 pane 读自己 tab 的 viewing id(原 viewingAgentId 是
  // 全局单值 → 分屏下 A 的子代理会同时显示在 B 窗格)。per-tab 天然隔离,不再按
  // sessionId 匹配。点 A 的子代理只替换 A 窗格,点 A 母会话标题(返回)恢复 A 会话。
  const viewingAgentId = useStore((s) => s.viewingAgentByTab[tabIndex] || null);
  const viewingAgent = useStore((s) => {
    const id = s.viewingAgentByTab[tabIndex];
    return id ? s.activeAgents[id] : null;
  });
  const showAgentView = !!viewingAgentId && !!viewingAgent;
  // 模型解析优先级(#8 修复模型总回退到默认):
  //   1. 本会话显式 pin(modelBySession[key]) —— 用户主动切的,最权威
  //   2. 本会话历史里最近一条带 model 的消息 —— 让会话"记住"自己用过的模型,
  //      避免全局 currentModel 被 WS 'model' 事件重置成 settings.json 默认(haiku)后,
  //      没 pin 的会话(含回滚后新建的)统统掉回默认
  //   3. 全局 currentModel —— 最后兜底(草稿、全新会话)
  const pinnedModel = useStore((s) => {
    const k = selectedSession?.sessionId || `draft-${selectedSession?.projectHash || 'none'}`;
    return s.modelBySession[k] || null;
  });
  const globalModel = useStore((s) => s.currentModel);
  // 历史模型:优先用侧栏会话元数据里的 model(切入会话时立即可用、稳定),只有它缺失
  // 时才扫 messages。否则 messages 异步加载前为空 → 先显示全局默认、加载后跳到历史模型,
  // 造成"切走切回模型闪变"(用户报告 #3)。selectedSession.model 在选中瞬间就有值。
  // U1/U4:provider 切换(providerEpoch)之前的历史模型不再信任 —— 否则切走 provider
  // 后,老会话徽章/发送都沿用旧 provider 的模型 id,上游报"无可用渠道/para error"。
  // 显示与发送解析保持一致(同样的 epoch 门控)。
  const providerEpoch = useStore((s) => s.providerEpoch);
  const measuredCtx = useStore((s) => (selectedSession?.sessionId && s.ctxMeasuredBySession[selectedSession.sessionId]) || null);
  const historyModel = useMemo(() => {
    const fresh = (m) => !providerEpoch || (m?.timestamp && Date.parse(m.timestamp) > providerEpoch);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!messages[i]?.model) continue;
      if (/^</.test(messages[i].model)) continue; // 跳过 <synthetic> 等伪模型 id
      return fresh(messages[i]) ? messages[i].model : null;
    }
    // 会话元数据 model 无时间戳:仅在从未切换过 provider 时可信。
    if (selectedSession?.model && !providerEpoch) return selectedSession.model;
    return null;
  }, [selectedSession?.model, messages, providerEpoch]);
  // 服务端持久化的 1M 标记兜底:重装丢 localStorage 后 pin 没了,historyModel 恢复的是
  // 不带 [1m] 的 API 模型 id → 若该会话标记过 1M 且解析结果没带后缀,补回。pin 存在且
  // 不带 [1m](用户显式关掉)时 setModelFor 的 syncContext1m 已把标记清掉,不会误补。
  const context1mFlag = useStore((s) => !!(selectedSession?.sessionId && s.context1mBySession[selectedSession.sessionId]));
  const resolvedModelBase = pinnedModel || historyModel || globalModel;
  const currentModel = (context1mFlag && resolvedModelBase && !/\[1m\]/i.test(resolvedModelBase))
    ? resolvedModelBase + '[1m]' : resolvedModelBase;
  // 徽章分母:后端解析的真实窗口(与压缩联动同源;官方/无解析=null 走本地兜底表)。
  const resolvedWindow = useResolvedWindow(currentModel);
  // Desktop/CLI 1M 会话首开继承:jsonl 的 model 永远是裸 id(API 回包不带 [1m],1M 只是
  // 请求侧 beta 后缀),历史解析恢复不出 1M → 徽章分母/下一条发送都按 200K 走,爆红
  // 389k/200k(194%) 且发送真会超窗(用户实报:Desktop 用 opus 1M 跑的会话在 GUI 打开即爆红)。
  // 唯一可靠证据:单次 API 调用的 ctxUsage(input+cache_read+cache_creation)物理上不可能
  // 超过窗口,若超过名义窗口则该会话必然运行在 1M 上。仅官方 anthropic + claude 系裸模型 +
  // 无用户显式 pin(pin 裸模型 = 显式关 1m,尊重不复活)时推断;命中即走 syncContext1m
  // 落到与手动开关同一持久层(localStorage 镜像 + 服务端 prefs + WS 广播),徽章分母与
  // 发送([1m] 兜底补回,4422)自动一致。第三方([1m] 对自定义模型名无效 #68522)不推断,
  // 真超窗时徽章照实爆红(诚实警告,BG2)。上限 1_050_000 挡整轮累加的爆表脏值。
  useEffect(() => {
    const sid = selectedSession?.sessionId;
    if (!sid || pinnedModel || context1mFlag || !messages.length) return;
    const hint = currentProvider?.providerHint;
    if (hint && hint !== 'anthropic') return;
    const base = resolvedModelBase || '';
    if (/\[1m\]/i.test(base) || !/claude|opus|sonnet|haiku/i.test(base)) return;
    const nominal = nativeContextWindow(base);
    if (nominal >= 1_000_000) return;
    const over = messages.some((m) => {
      const u = m.ctxUsage; // 只认单次调用口径;m.usage 是整轮累加,200K 窗口也能合法超 200K
      const s = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0;
      return s > nominal * 1.05 && s <= 1_050_000;
    });
    if (over) useStore.getState().syncContext1m(sid, base + '[1m]');
  }, [selectedSession?.sessionId, messages, pinnedModel, context1mFlag, resolvedModelBase, currentProvider]);
  const modelBySession = useStore((s) => s.modelBySession);
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // AZ3:用户是否主动滚离底部(自动吸底的权威闸门)。原本吸底只看几何阈值 → 流式
  // 内容增长 + setAutoScroll 异步,导致"刚上滚就被弹回 + 边界抖动闪烁"。改用 ref
  // 意图锁(不触发渲染),带迟滞;autoScroll state 仅留给「回到底部」按钮显隐。
  const userScrolledAwayRef = useRef(false);
  // 区分"程序触发的吸底写入"与"用户手势":吸底自己写 scrollTop 会触发 scroll 事件,
  // 不打这个标记就会被 handleScroll 误判成用户滚动。
  const programmaticScrollRef = useRef(false);
  const [chatMessages, setChatMessages] = useState([]);
  // Mirror of chatMessages. handleSend is a useCallback whose deps don't include
  // chatMessages, so its closure lags — a /btw answer arriving via async
  // setChatMessages doesn't recreate the callback, and the next /btw would read
  // stale history (continuous-btw thread would break). Read the ref for the
  // freshest btw transcript. Updated every render below.
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;
  const [isStreaming, setIsStreaming] = useState(false);
  // Mirror of isStreaming in a ref. Used by handleSend's gate instead of the
  // closure'd state — closures lag one render behind, so a rapid rollback →
  // updateStreaming(false) → setTimeout(handleSend, 50) chain would see stale
  // `true` and enqueue the message instead of sending it. The ref is updated
  // synchronously alongside every setIsStreaming call.
  const streamingRef = useRef(false);
  const updateStreaming = (v) => { streamingRef.current = v; setIsStreaming(v); };
  const [streamingText, setStreamingText] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [streamingModel, setStreamingModel] = useState(null);
  const [streamingToolCalls, setStreamingToolCalls] = useState([]);
  // Ordered blocks for in-order rendering (text → tool → text → tool → write).
  const [streamingBlocks, setStreamingBlocks] = useState([]);
  // CJ-4:本回合发起时间戳,驱动流式/connecting 的实时耗时计数(ElapsedTime)。
  const streamStartRef = useRef(null);
  // "重做此工具"进行中的 turn uuid——只控制转圈指示器的显示。截断由 turn 上的
  // _retryTrimToolId 标记负责(回退状态需一直保持),指示器在重跑流式内容出现后清掉,
  // 否则会一直转(用户报告:AI 回复完成后仍显示"正在重做")。
  const [retryActiveUuid, setRetryActiveUuid] = useState(null);
  const [compacting, setCompacting] = useState(false); // /compact 进行中 → 显示压缩动画
  // 输入预测(A):回合末 SDK 的 prompt_suggestion。{ sid, text } —— sid=产生建议的会话
  // (streamSid/owner key),渲染时必须与当前查看会话匹配,防止切会话后建议串窗。
  const [promptSuggestion, setPromptSuggestion] = useState(null);
  // 等待状态行(G):SDK system status(auto-compact 压缩中)/api_retry(限流、5xx 自动
  // 重试)/rate_limit_event 的即时文案。{ text } —— message_start(新内容开始流)与回合
  // 收尾时清空。与 StreamingStatusLine 并存:那个描述"正在产出什么",这个描述"为什么在等"。
  const [liveStatus, setLiveStatus] = useState(null);
  // 流式 result 事件携带本轮真实 usage(input+cache)。直接据此即时更新上下文徽章,
  // 不必等 jsonl refetch——修复"压缩后/每轮要等几轮才更新"的延迟(#5)。切换会话时清空。
  const [liveContextUsage, setLiveContextUsage] = useState(null);
  // I4 会话隔离:流式缓冲(chatMessages/streaming*)属于"发起这次流的会话",不属于窗格。
  // 记录归属会话 key;切到别的会话时这些缓冲在渲染层隐藏(流继续在服务端跑,回来 reattach),
  // 不再串到当前查看的会话。streamOwnerKeyRef 供异步闭包读最新值。
  const [streamOwnerKey, setStreamOwnerKey] = useState(null);
  const streamOwnerKeyRef = useRef(null);
  const setStreamOwner = useCallback((k) => { streamOwnerKeyRef.current = k; setStreamOwnerKey(k); }, []);
  // BF-1:流式期间的历史截断点。CLI 边流边写 jsonl,流式中途任何历史重拉(侧栏 handleSelect
  // 切走切回 / 刷新后 rehydrate+reattach / 搜索跳转)都会把本回合的【半成品】拉进 messages,
  // 与流式气泡同屏 → 同一回合渲染两遍(用户截图:上块 jsonl 半成品带 usage,下块 Writing… 流式)。
  // 现有 tkey 去重只清 chatMessages,管不到 messages 侧。据此在渲染层把历史截断到本回合起点之前:
  //   { sinceTs }        正常发送:丢弃 timestamp ≥ 流起点的历史条目(本地已有用户气泡副本)
  //   { afterLastUser }  仅剩历史分支保留(reattach 已改为 null,见 resolveStreamHistCutoff)。
  // finalize 提交整轮落盘 + 清空本地副本时同步清空,历史交还 jsonl。
  const [streamHistCutoff, setStreamHistCutoff] = useState(null);
  // reattach 双气泡根治:本次流是否 reattach(接管已在跑的进程)。为 true 时本窗格不画
  // 自己的流式气泡/Connecting 占位 —— 内容由历史卡(jsonl)单一来源负责,重放事件只当
  // 刷新触发器。口径与理由见 utils/reattach.js。
  const [reattachStream, setReattachStream] = useState(false);
  const loadedSidRef = useRef(null); // I4:本窗格已加载历史的 sessionId,切会话时据此强制重载
  // 编辑重发待回滚(#4):点击「重新编辑并发送」时只回填输入框、记录目标消息,不做
  // 任何破坏性操作;真正发送时才回退,ESC 取消则原样保留。ref 供 handleSend 读取
  // (handleSend 定义早于 handleRollback,且需避免闭包读到旧值)。
  const [pendingEditRollback, setPendingEditRollbackState] = useState(null);
  const pendingEditRef = useRef(null);
  // L4: 当 handleSend 时还是 draft(没真 sessionId),先把待写 sidecar 暂存,init 拿到 sid 后落盘。
  const pendingAttachmentRef = useRef(null);
  const setPendingEditRollback = useCallback((v) => { pendingEditRef.current = v; setPendingEditRollbackState(v); }, []);
  const handleRollbackRef = useRef(null);
  const activeProcRef = useRef(null);
  // 每次真正进入发送/reattach 起流前同步递增。旧 finally 的异步轮询只认自己的 token，
  // 不再等 /api/chat 返回 pid 才判断新回合是否已经开始。
  const streamTurnTokenRef = useRef(0);
  const abortRef = useRef(null);
  // killedRef:本回合的 abort 是否【真杀了服务端进程】(POST /chat/:pid/stop)。用户主动停止/加速/
  // 编辑重发才置 true;后台化(backgroundify)与切会话(detach)只 abort 客户端流、进程继续跑,保持
  // false。供 finally 区分:真杀进程才把后台化子代理(taskManaged)收 stopped,否则留 working 等
  // 它自己的 task_notification(fable 复审 P1:turnAborted 不能只看 AbortError,detach 会误收)。
  const killedRef = useRef(false);
  // 最近一次【选择性】POST /stop 的响应 promise(hard 路径不设:hard 全停,没有保留项)。
  // 服务端选择性停止会保留跨回合后台子代理(keptToolUseIds),finally 的穷举收尾必须跳过它们,
  // 否则进程活着却显示"已停止"。abort() 只是排队 reject,handleStop / ⚡引导 整段同步跑完才
  // 轮到 finally,所以 finally 读得到这个 ref;读完即清,避免跨回合复用陈旧结果。
  // 响应本身是异步的(finally 早于它到达)→ 收尾挂在 promise 上,晚几毫秒,失败回落全量收尾。
  const stopKeptRef = useRef(null);
  // pid 集合:被用户主动「停止」过的 chat 进程。停止后进程要等 close 才设 exitCode
  // (SIGTERM→SIGKILL 最多 5s),这期间 /agents/active 仍报 stoppable=true → backgroundPid
  // poll 会把它误判成「后台运行中」并闪黄条,甚至触发 auto-reattach 重连。记下已停的
  // pid,poll 与 reattach 都跳过它。CQ-15:指向模块级共享集合,使分屏各 pane 互相感知停止。
  const stoppedPidsRef = useRef(stoppedChatPids);
  // Set by "⚡ 引导": tells the aborted in-flight send's finally to skip its own
  // queue drain so we don't double-send — handleAccelerate drains directly, which
  // also covers reattach streams (whose finally never drains).
  const acceleratingRef = useRef(false);
  // H 转后台:用户主动把前台回合转后台(只断本端 SSE,进程照跑)。被 abort 的
  // handleSend finally 读它跳过排队消息外发——回合还在服务端跑,此刻外发会对同一
  // jsonl 双写。finally 末尾复位。
  const backgroundedRef = useRef(false);
  // C1:本 pane 有一条流正在走 handleSend 的 finally 收尾(内含 fetch + 最多 11×200ms 的
  // 落盘等待,真实 await 窗口 ~2.4s)。窗口内 streamingRef 已是 false、服务端进程也没了,
  // poll 的排队排空分支(:4112)条件全满足会抢跑 shift 队首,finally 走到末尾又 shift 一条,
  // 后者撞 :4377 的门被重新入队到队尾 → 排队消息乱序发出。收尾期间压住 poll 排空,
  // 队列一律由 finally 逐条弹。目标场景(切走再回来)本地没有 finally 在途,不受影响。
  // 用计数而非布尔:被 abort 的流 A 的 finally 会与新起的流 B 重叠(⚡引导/reattach 场景),
  // 布尔会被 A 的收尾提前清成 false,B 自己的收尾窗口又敞开了。
  const finalizeInFlightRef = useRef(0);

  // C1/CQ-5:流式缓冲的归属门控(与消息渲染/统计同源)。原定义在早返回之后,上移到
  // currentTodos/currentPlan 之前,让代办/计划重建共用同一门控(串扰窗口2:A 正在流式
  // 建代办时切到 B,detach effect 清空前的首帧,A 的 TaskCreate 会闪进 B 的清单)。
  // CQ-5:不加 `streamOwnerKey == null ||` 子句 —— owner=null 时恒 true 会把上个会话
  // 残留的 chatMessages 显示到当前会话(串内容根因),handleSend 写用户气泡前已
  // setStreamOwner,该显示的本地缓冲 owner 必等于 sessionQueueKey。
  const liveVisible = streamOwnerKey === sessionQueueKey;
  // v0.2.192 泛化:凡带 ownerKey 的本地条目(btw 旁问、AbortError 半截回复、error turn)
  // 一律按归属门控——属于当前会话就显示、不属于就藏,与 liveVisible(流归属)解耦。
  // 无 ownerKey 的条目(流式 turn/user 回显/compact)维持 liveVisible 门控。
  const visibleChat = useMemo(() => chatMessages.filter(
    (m) => (m.ownerKey ? m.ownerKey === sessionQueueKey : liveVisible)
  ), [chatMessages, sessionQueueKey, liveVisible]);

  // Latest TodoWrite snapshot for the composer's checklist panel. TodoWrite
  // calls REPLACE the full list each time, so the newest call wins. Search
  // freshest-first: streaming blocks → chatMessages → persisted messages.
  // DECLARED HERE (above any conditional early return) so hook order stays
  // stable when selectedSession flips from null → set → null (React #310).
  const currentTodos = useMemo(() => {
    // BK-8a:输入框上方清单与气泡内清单(TurnBubble)共用同一份重建算法
    // (../utils/todos.js),消除两处口径差异。这里负责把全局所有 turn 的 toolCalls
    // 按"老→新"摊平成单数组(messages → visibleChat → streamingBlocks),交给共享
    // 函数;TurnBubble 传单 turn 的 toolCalls。算法内部:最新 TodoWrite 快照优先
    // (摊平末尾的 streaming 最新),否则回放 TaskCreate/TaskUpdate 序列。
    // 串扰窗口2:流式缓冲只在归属当前会话时计入(visibleChat/liveVisible 门控),
    // 与消息渲染同一体系 —— 否则切会话首帧 A 的 TaskCreate 闪进 B 的清单。
    const flat = [];
    for (const m of messages) { if (m?.type === 'turn' && Array.isArray(m.toolCalls)) flat.push(...m.toolCalls); }
    for (const m of visibleChat) { if (m?.type === 'turn' && Array.isArray(m.toolCalls)) flat.push(...m.toolCalls); }
    for (const b of (liveVisible ? streamingBlocks : EMPTY_ARRAY)) {
      if (b?.type === 'tool_use' && b.toolCall) flat.push(b.toolCall);
    }
    return rebuildTodosFromTaskCalls(flat);
  }, [streamingBlocks, visibleChat, messages, liveVisible]);

  // 最近一份【已批准】的 ExitPlanMode 计划全文,常驻在任务清单条顶部(默认折叠一行,
  // 展开可随时回看批准了什么)。与 G1/G2 收口不冲突:未批准/被拒的计划仍只在审批弹窗
  // (PlanReviewCard)出现,这里只认批准信号——SDK 引擎批准=allow → result 非错误;
  // 旧 hook 路径批准=deny 收尾但 result 文案含"用户已批准此计划"(同 TurnBubble O1)。
  const currentPlan = useMemo(() => {
    const readApprovedPlan = (toolCall) => {
      if (toolCall?.name !== 'ExitPlanMode') return '';
      const r = toolCall.result;
      if (!r) return '';
      const text = typeof r.content === 'string'
        ? r.content
        : (Array.isArray(r.content) ? r.content.map((c) => c?.text || '').join('') : '');
      if (r.isError && !/用户已批准此计划/.test(text)) return '';
      const plan = toolCall.input?.plan ?? toolCall.input?.content ?? '';
      return typeof plan === 'string' ? plan.trim() : '';
    };
    const scanToolCalls = (toolCalls) => {
      if (!Array.isArray(toolCalls)) return '';
      for (let j = toolCalls.length - 1; j >= 0; j--) {
        const plan = readApprovedPlan(toolCalls[j]);
        if (plan) return plan;
      }
      return '';
    };
    // 串扰窗口2:流式缓冲按归属门控(同 currentTodos),不属于当前会话就不扫。
    const liveBlocks = liveVisible ? streamingBlocks : EMPTY_ARRAY;
    for (let i = liveBlocks.length - 1; i >= 0; i--) {
      const b = liveBlocks[i];
      if (b?.type === 'tool_use') {
        const plan = readApprovedPlan(b.toolCall);
        if (plan) return plan;
      }
    }
    for (let i = visibleChat.length - 1; i >= 0; i--) {
      const plan = scanToolCalls(visibleChat[i]?.toolCalls);
      if (plan) return plan;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const plan = scanToolCalls(messages[i]?.toolCalls);
      if (plan) return plan;
    }
    return '';
  }, [streamingBlocks, visibleChat, messages, liveVisible]);

  // When the file watcher reports a write to THIS session's jsonl (e.g. a
  // detached background stream from another tab/session is still writing),
  // silently re-pull messages so the UI catches up.
  //
  // ALSO clear local chatMessages once the jsonl-derived messages have the
  // user prompt that's currently sitting in chatMessages. Otherwise the same
  // turn would render twice — once from `messages` (persisted, from jsonl)
  // and once from `chatMessages` (the in-memory copy from the just-finished
  // local stream).
  // Load THIS pane's messages on mount / session change when we don't have them
  // yet. paneMessages is in-memory only, so after a page refresh every pane's
  // session is restored from localStorage but its message list is empty — without
  // this, non-active split panes showed "该会话没有可显示的消息" until clicked.
  // Guard on empty + not-streaming so we never clobber a live turn or refetch.
  useEffect(() => {
    const sid = selectedSession?.sessionId;
    const ph = selectedSession?.projectHash;
    if (!sid || !ph) return;
    // 流正在跑且就是当前会话 → 本地流是真相源,别用磁盘 clobber。
    if (streamingRef.current && streamOwnerKeyRef.current === sessionQueueKey) return;
    // I4:切到了和上次加载不同的会话(可能是从一个正在流式的会话切走)→ 强制重载该会话历史,
    // 否则 paneMessages 仍是上个会话的、加上被隐藏的流式缓冲 → 新会话空白或串旧内容。
    if (loadedSidRef.current === sid) {
      const have = useStore.getState().paneMessages[tabIndex];
      if (Array.isArray(have) && have.length > 0) return;
    }
    loadedSidRef.current = sid;
    fetchMessagesForTab(sid, ph, { silent: true });
  }, [selectedSession?.sessionId, selectedSession?.projectHash, tabIndex, sessionQueueKey]);

  // I4/#6:切到【非当前流】的会话时,清掉上个会话遗留的即时上下文 usage,让上下文徽章
  // 立刻反映本会话(由本会话 jsonl 的 lastUsage 计算),不再闪烁/显示上个会话的数字。
  useEffect(() => {
    if (streamOwnerKeyRef.current !== sessionQueueKey) setLiveContextUsage(null);
  }, [sessionQueueKey]);

  // X2/I6:打开会话时后台对齐一次 /context(每会话每次运行只测一次)。覆盖两类
  // 徽章空窗:①重启后内存实测为空;②会话以 /compact 收尾,compact 之后没有任何
  // 带 usage 的回合(jsonl 路径无值可取,用户截图场景)。/context 不走主对话模型,
  // 但会打多次 count_tokens(免费、有网络往返);回写后徽章与点开明细一致,且明细
  // 缓存进 store 供弹层秒开(AA1)。
  useEffect(() => {
    const sid = selectedSession?.sessionId;
    if (!sid || streamingRef.current) return;
    const st = useStore.getState();
    if (st.ctxMeasuredBySession[sid]) return;
    const once = (window.__cguiCtxProbeOnce ||= new Set());
    if (once.has(sid)) return;
    once.add(sid);
    const qs = new URLSearchParams({
      cwd: selectedSession.projectPath || '',
      projectHash: selectedSession.projectHash || '',
      model: st.modelBySession[sid] || st.currentModel || '',
    });
    fetch(`/api/context/${sid}?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.totalTokens > 0 && d?.windowTokens > 0) {
          useStore.getState().setCtxMeasured(sid, { totalTokens: d.totalTokens, windowTokens: d.windowTokens });
        }
        useStore.getState().setCtxBreakdown(sid, d); // AA1:缓存明细供弹层秒开
      })
      // C3:失败要把 sid 从 once 集合删掉,否则首次探测失败(网络/500)后永不重试,
      // "无 usage 回合 + compact 收尾"场景徽章永久空窗到刷新。与 __cguiCtxProbe 的
      // finally 清理对齐。
      .catch(() => { once.delete(sid); });
  }, [selectedSession?.sessionId]);

  useEffect(() => {
    if (!selectedSession?.sessionId || !selectedSession?.projectHash) return;
    const onChange = async (e) => {
      const p = e?.detail?.path || '';
      if (!p.endsWith(`/${selectedSession.sessionId}.jsonl`)) return;
      // If a stream is running RIGHT NOW for this session, skip the disk
      // refresh — local streamingBlocks is the source of truth during the
      // turn. Otherwise the partial jsonl renders alongside the live
      // streaming bubble and the user sees the reply twice.
      if (streamingRef.current) return;
      await fetchMessagesForTab(
        selectedSession.sessionId,
        selectedSession.projectHash,
        { silent: true },
      );
      // After re-fetch, if any chatMessages entry shares timestamp+text with
      // a freshly-pulled message, the persisted copy now owns it — drop the
      // local one to avoid double rendering.
      setChatMessages((prev) => {
        if (!prev.length) return prev;
        const persisted = getLocalMessages();
        // text may be a string (user msg) or array of strings (assistant turn).
        const tkey = (m) => {
          const t = Array.isArray(m.text) ? m.text.join('') : (m.text || '');
          return `${m.type}|${(t || '').slice(0, 80)}`;
        };
        const known = new Set(persisted.map(tkey));
        // If this round's user prompt is already persisted, the whole round
        // landed in jsonl — drop ALL local copies even when the assistant text
        // didn't byte-match (streaming-accumulated vs final jsonl can differ).
        // Fixes the "reply rendered twice" race (jsonl turn + local turn both show).
        const lastUser = [...prev].reverse().find((m) => m.type === 'user');
        // 保留旁问气泡(btw 无 jsonl 孪生)与未落盘的停止半截回复(interrupted:停止场景
        // "末条用户消息已落盘"≠"整轮落盘",半截 assistant 可能没写进 jsonl,整清=丢内容;
        // 已落盘的(tkey 命中)照清防双渲染)。审计#7。
        if (lastUser && known.has(tkey(lastUser))) return prev.filter((m) => m.type === 'btw' || (m.interrupted && !known.has(tkey(m))));
        return prev.filter((m) => !known.has(tkey(m)));
      });
    };
    // WS 重连成功 → 断线期间本会话的 file-change 可能已丢,合成一个命中自己 sid 的
    // 事件走同一条 refetch+去重链(streamingRef 守卫原样生效,不打断流式)。per-pane
    // 多实例:每个 SessionDetail 只对账自己的 selectedSession,互不越界。
    const onReconnect = () => onChange({ detail: { path: `/${selectedSession.sessionId}.jsonl` } });
    window.addEventListener('cgui:sessions-changed', onChange);
    window.addEventListener('cgui:ws-reconnected', onReconnect);
    return () => {
      window.removeEventListener('cgui:sessions-changed', onChange);
      window.removeEventListener('cgui:ws-reconnected', onReconnect);
    };
  }, [selectedSession?.sessionId, selectedSession?.projectHash]);

  // 兜底去重(图1「频繁切换会话时同一条回复渲染两次」根治):每当本会话持久化 messages 变化
  // (挂载加载 / 列表刷新 / 文件监听 / finally 提交),只要当前没有正在跑的本会话流,就把已落盘
  // 的回合从 chatMessages 里清掉。根因:快速切走切回时,handleSend 的 finally 因 nav-away 提前
  // break(getLocalSession 不再等于 finalizeSid),setChatMessages([]) 被跳过 → messages 与
  // chatMessages 同时含该回合 → 渲染两遍。上面那条 reconcile 只在"文件事件命中当前会话"时触发,
  // 切走切回会漏;这条以 messages 为依赖,覆盖所有提交路径。流式中(本会话)跳过——此时流式
  // 缓冲才是真相源。判定复用同一套 tkey:整轮(末条用户消息)已落盘 → 清空全部本地副本。
  useEffect(() => {
    if (streamingRef.current && streamOwnerKeyRef.current === sessionQueueKey) return;
    setChatMessages((prev) => {
      if (!prev.length) return prev;
      const tkey = (m) => {
        const t = Array.isArray(m.text) ? m.text.join('') : (m.text || '');
        return `${m.type}|${(t || '').slice(0, 80)}`;
      };
      const known = new Set(messages.map(tkey));
      const lastUser = [...prev].reverse().find((m) => m.type === 'user');
      // 保留 btw 与未落盘的停止半截回复(同上面 reconcile,审计#7)。
      if (lastUser && known.has(tkey(lastUser))) return prev.filter((m) => m.type === 'btw' || (m.interrupted && !known.has(tkey(m))));
      const next = prev.filter((m) => !known.has(tkey(m)));
      return next.length === prev.length ? prev : next;
    });
  }, [messages, sessionQueueKey]);

  // BF-1:渲染用的历史列表。活跃流归属本会话且截断点存在时,过滤掉本回合的半成品条目;
  // 其余情况原样返回 messages(同一引用,不打穿 MessageList 的 memo)。useMemo 依赖里
  // 没有每 token 变化的值,流式期间只有 messages 真被重拉时才重算。
  const visibleMessages = useMemo(() => {
    const cut = streamHistCutoff;
    if (!cut || streamOwnerKey !== sessionQueueKey) return messages;
    if (cut.afterLastUser) {
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.type === 'user') { lastUserIdx = i; break; }
      }
      // 没有用户消息 / 用户消息就是末条(回合内容还没落盘)→ 无需截断。
      if (lastUserIdx === -1 || lastUserIdx === messages.length - 1) return messages;
      return messages.slice(0, lastUserIdx + 1);
    }
    // 正常发送:jsonl 里本回合所有条目(含用户消息回显)时间戳都晚于客户端发送时刻
    // (同机时钟,CLI 在 POST 之后才写盘)。无时间戳的条目一律保留,绝不误杀。
    const next = messages.filter((m) => !m?.timestamp || Date.parse(m.timestamp) < cut.sinceTs);
    return next.length === messages.length ? messages : next;
  }, [messages, streamHistCutoff, streamOwnerKey, sessionQueueKey]);

  // Detect "this session has a background CLI proc still running" — happens
  // when the user navigated away while it was streaming. We poll the active-
  // agents endpoint and look for a chat-process with our sessionId. If found,
  // expose `backgroundPid` so the composer can render the stop button + a
  // "正在继续工作…" indicator, matching how multi-terminal CLI sessions feel.
  const [backgroundPid, setBackgroundPid] = useState(null);
  // H:上一轮 poll 看到的后台 pid。pid 从有到无=后台回合刚跑完,据此补一次历史拉取。
  const lastSeenPidRef = useRef(null);
  // 判官建议7(实测代码确认会回归):jsonl 解析层(session-reader getSessionMessages)
  // 对未回执 tool_use 给 result:null 且无中断标记 → 停止(abort 兜底杀进程时 CLI 没机会
  // 写 tool_result)后 refetch 用持久化 turn 替换本地气泡,专用卡又拿 result:null 永久
  // 转圈。server 由另一路在改,修在渲染前的数据层(仅本 pane,不影响 SubagentView):
  //   · 非末条消息的 turn:对话已推进,回合必已结束 → 未回执工具补中断态;
  //   · 末条 turn:仅当本会话既无活跃流也无后台进程时才补 —— 有进程在跑说明工具可能
  //     真在执行,保留转圈(结果落盘后 refetch 自然补上;reattach 起流后 isStreaming
  //     翻 true 也会让这里重算收手)。
  // finalize 复用 finalizePendingToolCalls(Task/Agent 不碰)并回写 blocks(主渲染路径)。
  // 无需修补时返回原引用,不打穿 MessageList 的 memo。
  const finalizedMessages = useMemo(() => {
    const lastIdx = visibleMessages.length - 1;
    const sessionBusy = !!backgroundPid || (isStreaming && streamOwnerKey === sessionQueueKey);
    const needsFix = (m, i) => m?.type === 'turn'
      && (i < lastIdx || !sessionBusy)
      && Array.isArray(m.toolCalls)
      && m.toolCalls.some((tc) => tc && !tc.result && tc.name !== 'Task' && tc.name !== 'Agent');
    if (!visibleMessages.some(needsFix)) return visibleMessages;
    return visibleMessages.map((m, i) => {
      if (!needsFix(m, i)) return m;
      const fin = finalizePendingToolCalls(m.toolCalls, true);
      return { ...m, toolCalls: fin, blocks: applyFinalizedToBlocks(m.blocks, fin) };
    });
  }, [visibleMessages, backgroundPid, isStreaming, streamOwnerKey, sessionQueueKey]);
  // Transient toast for "auto-stripped thinking blocks after provider switch".
  // { text, expires } — set by handleSend's pre-flight check, auto-cleared.
  const [providerSwitchNotice, setProviderSwitchNotice] = useState(null);
  useEffect(() => {
    if (!providerSwitchNotice) return;
    const id = setTimeout(() => setProviderSwitchNotice(null), 5000);
    return () => clearTimeout(id);
  }, [providerSwitchNotice]);
  // G4:上下文超模型窗口时 /compact 失败(整段发上去做摘要→请求体也超限→413)。
  // 这种错不能自动重试,弹一个带操作按钮的横幅引导用户:切 1M / 新建 / 回滚裁剪。
  const [ctxOverflow, setCtxOverflow] = useState(null);
  useEffect(() => {
    const pollSid = selectedSession?.sessionId;
    // 僵尸 draft 修复(fable 审计第5项):draft 发出后 init 前切走再切回,原来这里因无
    // sid 直接 return → 永不 reattach,pane 卡成僵尸。现在 draft 按 draftId 匹配后台
    // 进程(POST /chat 已把它存进 slot),reattach 回放 earlyLines 里的 init 完成绑定。
    const pollDraftId = !pollSid ? selectedSession?.draftId : null;
    if (!pollSid && !pollDraftId) { setBackgroundPid(null); return; }
    // 切会话瞬间先清上个会话残留的 pid(首轮 poll 返回前最长 ~1.5s):否则 B 里短暂显示
    // A 的"后台工作中",此刻点停止会 POST /chat/<A-pid>/stop 杀错 A 的后台回合(审计#5,
    // 停止不可逆)。lastSeenPidRef 一并清,防 B 首轮 poll 误触"pid 有→无"的排空分支。
    setBackgroundPid(null);
    backgroundPidRef.current = null;
    lastSeenPidRef.current = null;
    let cancelled = false;
    let drainScheduled = false; // 排队消息排空的在途标记(见下方 drain 分支)
    const poll = async () => {
      try {
        const r = await fetch('/api/agents/active');
        const d = await r.json();
        if (cancelled) return;
        // Use `stoppable` (= server's !finished), NOT `exitCode`: the
        // /agents/active payload has no exitCode field, so `a.exitCode == null`
        // was always true and kept finished procs (lingering in the 60s grace
        // window) flagged as "still working" → the stop→banner→stop infinite loop.
        const hit = (d.agents || []).find(
          (a) => a.kind === 'chat-process'
            && (pollSid ? a.sessionId === pollSid : (a.draftId && a.draftId === pollDraftId))
            && a.stoppable === true
            && a.status !== 'idle' // #26:常驻进程回合间保活 ≠ 后台在跑,不出横幅
            && !stoppedPidsRef.current.has(String(a.pid))
        );
        // Only show "background working" if we're NOT actively streaming
        // locally — otherwise the local stream UI is already showing it.
        const next = hit && !streamingRef.current ? String(hit.pid) : null;
        // H 转后台:后台回合跑完(pid 消失)且本 pane 没在流(auto-reattach 被主动转后台
        // 抑制,没有 reattach 流的 finally 替我们收尾)→ 静默拉一次历史,最终回复即刻上屏。
        // 打包版没有文件 watcher,缺这步要等用户切走切回才看得到结果。
        if (!next && lastSeenPidRef.current && !streamingRef.current && pollSid && selectedSession?.projectHash) {
          fetchMessagesForTab(pollSid, selectedSession.projectHash, { silent: true });
        }
        // 排队消息自动排空(原「pid 有→无」分支的推广)。原分支要求本 pane 亲眼看到 pid
        // 从有变无,于是用户实报的场景漏网:A 生成中排队 → 切到 B → A 在后台跑完 → 回到 A
        // 时既没有本地流、也没有进程可见,pid 的那次「有→无」发生在 B 里,A 的队列就永远挂着,
        // 横幅却写着「当前回复完成后自动发出」。判据改为状态式:本 pane 当前会话【无在跑进程
        // + 无本地流 + 队列非空】即排空队首,进入会话后的首轮 poll 自然覆盖「切走期间跑完」。
        // 归属守卫(不复活 F1 跨会话串扰):只弹本 pane 当前会话的队,消费端 handleSendRef
        // 也恒发进本 pane 当前会话,key 构造与入队侧 sessionQueueKey 逐字同口径;并要求它
        // 等于本 effect 轮询的那个会话,防 effect 清理与切会话之间的竞态错弹别人的队。
        // 隐藏项(计划续跑等)只在【本 pane 亲眼看到 pid 有→无】时才发 —— 那是原分支就有的
        // 行为,一字不改;新推广出来的「回来才发现已跑完」场景保守跳过隐藏项:它们不是用户
        // 可见的排队消息,没有「回复完成后自动发出」这条 UI 承诺,留给 finally / ⚡ 路径。
        // 必须同步清 backgroundPidRef(它靠 effect 异步更新,出队消息的 handleSend 撞到旧 pid
        // 会把消息塞回空队列→死锁);pid 已消失,清了语义也对。
        // C1:本地流的 finally 正在收尾(streamingRef 已 false 但它自己马上要排空队列)→
        // 这里绝不能抢跑,否则两边各弹一条 = 乱序(详见 finalizeInFlightRef 定义处)。
        if (!next && !streamingRef.current && !acceleratingRef.current && finalizeInFlightRef.current === 0) {
          const _sel = getLocalSession();
          const drainKey = _sel?.sessionId || `draft-${_sel?.projectHash || 'none'}`;
          const sameSession = pollSid ? drainKey === pollSid : _sel?.draftId === pollDraftId;
          const head = (useStore.getState().messageQueue[drainKey] || [])[0];
          const sawPidFinish = !!lastSeenPidRef.current; // 本 pane 看着这个回合跑完的
          if (sameSession && head?.text && (!head.hidden || sawPidFinish) && !drainScheduled) {
            backgroundPidRef.current = null;
            drainScheduled = true; // 1.5s 的下一轮 poll 不许在这 50ms 里重复弹队(会打乱顺序)
            setTimeout(() => {
              drainScheduled = false;
              // 落地前复查:这 50ms 里可能切了会话 / 新流起来了 —— 那就把消息留在队列里,
              // 交给该会话下一次进入或流收尾的排空,绝不错发进别的会话。
              if (cancelled || streamingRef.current || backgroundPidRef.current || acceleratingRef.current) return;
              if (finalizeInFlightRef.current > 0) return; // C1:这 50ms 里有流开始收尾 → 让它自己排空
              const s2 = getLocalSession();
              if ((s2?.sessionId || `draft-${s2?.projectHash || 'none'}`) !== drainKey) return;
              const q = useStore.getState().shiftMessage(drainKey);
              if (q?.text) handleSendRef.current?.(q.text, q.opts || (q.hidden ? { hiddenUserMessage: true } : {}));
            }, 50);
          }
        }
        lastSeenPidRef.current = next;
        setBackgroundPid(next);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedSession?.sessionId, selectedSession?.draftId]);

  // Auto-scroll: coalesce frequent stream deltas into a single rAF tick so the
  // page doesn't visibly "flicker" with smooth-scroll animations on every
  // token. Use direct scrollTop write (cheaper than scrollIntoView + smooth,
  // which forces synchronous layout and animation engine each call).
  useEffect(() => {
    if (userScrolledAwayRef.current) return;  // AZ3:用户在看历史时不抢滚
    const id = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) { programmaticScrollRef.current = true; el.scrollTop = el.scrollHeight; }
    });
    return () => cancelAnimationFrame(id);
  }, [messages, chatMessages, streamingText, streamingThinking, streamingToolCalls]);

  // 重做工具的转圈指示器:一旦重跑的流式内容(文本/思考/工具)出现,就关掉指示器
  // ——此时重跑已就地以流式气泡呈现,指示器再转就是多余且会"完成后仍在转"。
  useEffect(() => {
    if (!retryActiveUuid) return;
    const hasContent = !!(streamingText || streamingThinking || streamingToolCalls.length > 0
      || streamingBlocks.some((b) => (b?.content?.length > 0) || b?.toolCall));
    if (hasContent) setRetryActiveUuid(null);
  }, [retryActiveUuid, streamingText, streamingThinking, streamingToolCalls, streamingBlocks]);

  // Persist scroll position per session so refresh keeps the user where they
  // were (not at top, not at bottom — wherever they were reading).
  const scrollPersistKey = selectedSession?.sessionId
    ? `cgui-scroll-${selectedSession.sessionId}`
    : null;

  const handleScroll = () => {
    if (!containerRef.current) return;
    // AZ3:程序触发的吸底写入会回弹一个 scroll 事件 → 跳过判定,别误判成用户滚动。
    if (programmaticScrollRef.current) { programmaticScrollRef.current = false; return; }
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const distFromBottom = scrollHeight - scrollTop - clientHeight;
    // 迟滞:滚离 >200 上锁(暂停自动吸底),滚回贴底 <40 解锁;两阈值拉开消除边界抖动。
    if (distFromBottom > 200) userScrolledAwayRef.current = true;
    else if (distFromBottom < 40) userScrolledAwayRef.current = false;
    setAutoScroll(distFromBottom < 120);  // 仅驱动「回到底部」按钮显隐
    if (scrollPersistKey) {
      try { localStorage.setItem(scrollPersistKey, String(scrollTop)); } catch {}
    }
  };

  // Restore the saved scroll position when messages first load (or session changes).
  // Only runs once per "session messages loaded" — autoScroll/streaming effect
  // handles live updates without overwriting the restored position.
  const scrollRestoredRef = useRef(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !scrollPersistKey) return;
    // Only attempt restore once per session's messages-loaded state.
    if (scrollRestoredRef.current === selectedSession?.sessionId) return;
    if (messages.length === 0 && chatMessages.length === 0) return;
    const saved = localStorage.getItem(scrollPersistKey);
    if (saved !== null) {
      const top = Number(saved);
      // Defer to next frame so DOM is laid out
      requestAnimationFrame(() => {
        if (el) {
          programmaticScrollRef.current = true;
          el.scrollTop = top;
          const away = el.scrollHeight - el.scrollTop - el.clientHeight >= 120;
          userScrolledAwayRef.current = away;  // AZ3:恢复的位置若不在底部则保持暂停吸底
          setAutoScroll(!away);
        }
      });
    }
    scrollRestoredRef.current = selectedSession?.sessionId;
  }, [messages.length, chatMessages.length, selectedSession?.sessionId, scrollPersistKey]);

  // Message queue plumbing (#3) — when user types during streaming, the message
  // is queued and dispatched after the current chat finishes (or when the user
  // clicks "⚡ 引导" to abort + send the queue immediately).
  // CRITICAL: never use `|| []` inside a zustand selector — that returns a
  // fresh array reference on every render and triggers React error #185
  // "Maximum update depth exceeded" (which blanks the whole page).
  // (sessionQueueKey 已上移到组件顶部声明,避免 effect 依赖数组 TDZ)
  // Model shown in THIS pane's header — the session's own pick, else default.
  const headerModel = modelBySession[sessionQueueKey] || currentModel;
  const messageQueueRaw = useStore((s) => s.messageQueue[sessionQueueKey]);
  const messageQueue = messageQueueRaw || EMPTY_ARRAY;

  // 旁问浮窗展开信号:每次发起旁问 +1,BtwWindow 监听后展开(主输入框 /btw 次入口也走它)。
  const [btwOpenSignal, setBtwOpenSignal] = useState(0);
  // 旁问未读数:BtwWindow(收起态无 UI)上报,显示在输入框工具行「旁问」按钮的角标上(方案A)。
  const [btwUnread, setBtwUnread] = useState(0);
  // 旁问 toggle:输入框「旁问」按钮 +1,BtwWindow 内部函数式切换 collapsed(无 open/close 时序 race)。
  const [btwToggleSignal, setBtwToggleSignal] = useState(0);
  // 旁问共享发送:窗口内输入框(主入口,免 /btw 前缀)与主输入框 /btw(次入口)共用。
  // 从原 handleSend 的 /btw 分支整段抽出,逻辑零变化。三条回归守卫逐字保留:
  // ①流式中不改 owner(!streamingRef.current 才 setStreamOwner);
  // ②history 读 chatMessagesRef.current(不读闭包 chatMessages,连续旁问才不读旧值);
  // ③ownerKey/btwSid 发起时闭包捕获(sessionQueueKey/btwSid),不在 fetch 回调里现取。
  const sendBtw = useCallback((rawQ) => {
    const q = String(rawQ || '').trim().replace(/^\/btw\s*/i, '');
    if (!q) return;
    setBtwOpenSignal((n) => n + 1);
    const sel = getLocalSession();
    const btwSid = sel?.sessionId || null;
    const btwCwd = sel?.projectPath || selectedProject?.path;
    const st = useStore.getState();
    const btwModel = String((btwSid && st.modelBySession[btwSid]) || st.currentModel || '').replace(/\[1m\]/i, '');
    const btwUuid = 'btw-' + Date.now();
    // 守卫①:liveVisible 门控——空闲态 owner 为 null 会藏掉气泡,需认领;流式中不动 owner。
    if (!streamingRef.current) setStreamOwner(sessionQueueKey);
    // 守卫②③:读 ref 拿最新 transcript,发起时闭包捕获 sessionQueueKey 做 ownerKey 过滤。
    const btwHistory = chatMessagesRef.current
      .filter((m) => m.type === 'btw' && m.ownerKey === sessionQueueKey && !m.pending && !m.error)
      .map((m) => ({ q: m.question, a: m.text }));
    setChatMessages((prev) => [...prev, {
      uuid: btwUuid, type: 'btw', question: q, text: '', pending: true,
      ownerKey: sessionQueueKey,
      timestamp: new Date().toISOString(),
    }]);
    fetch('/api/chat/btw', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, sessionId: btwSid || undefined, cwd: btwCwd, model: btwModel || undefined, history: btwHistory }),
    }).then(async (r) => {
      // 服务端已改 NDJSON 流式({delta}/{done}/{error} 行):逐 delta 追加渲染,对齐主会话
      // 逐块出字;spawn 前失败仍是 500 JSON,统一走 !r.ok 分支。
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let got = false;
      const handleLine = (line) => {
        if (!line.trim()) return;
        let ev; try { ev = JSON.parse(line); } catch { return; }
        if (ev.delta) {
          got = true;
          setChatMessages((prev) => prev.map((m) => m.uuid === btwUuid
            ? { ...m, text: m.text + ev.delta, pending: false } : m));
        } else if (ev.error) throw new Error(ev.error);
      };
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (value) {
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, idx)); buf = buf.slice(idx + 1); }
        }
        if (eof) break;
      }
      handleLine(buf);
      if (!got) throw new Error('模型无回答');
    }).catch((e) => {
      // 已有部分输出时保留半截回答,错误缀在其后(超时/断流不清空已渲染内容)。
      setChatMessages((prev) => prev.map((m) => m.uuid === btwUuid
        ? { ...m, text: (m.text ? m.text + '\n\n' : '') + '旁问失败：' + e.message, pending: false, error: true } : m));
    });
  }, [getLocalSession, selectedProject, sessionQueueKey, setChatMessages, setStreamOwner]);

  const handleSend = useCallback(async (prompt, opts = {}) => {
    const { reattachPid, appendSystemPrompt, hiddenUserMessage = false, meta } = opts;
    // AZ3:真实发送(非 reattach)恢复自动吸底——满足"回车发送后无手动滚动则吸底到最新"。
    if (!reattachPid) userScrolledAwayRef.current = false;
    // Intercept the /remote-control (alias /rc) command. It CANNOT be sent
    // through `claude -p` — slash commands are interactive-only and the CLI
    // rejects them ("isn't available in this environment"). Instead we launch
    // `claude --remote-control --resume <id>` in a real terminal (TTY required)
    // so the Claude mobile app can take over; the GUI keeps syncing via jsonl.
    let checkpointPromise = Promise.resolve(null);
    // 提升到 handleSend 顶层:init 事件里的"首条消息补拍 checkpoint"(流式循环内、
    // 本 if 块外)要引用它们,声明在块内会 ReferenceError 炸掉整轮流式(v0.2.175 回归)。
    let userMsgUuid = null;
    let userMsgTimestamp = null;
    if (!reattachPid && !hiddenUserMessage) {
      const cmd = (prompt || '').trim().toLowerCase();
      if (cmd === '/remote-control' || cmd === '/rc' || cmd === 'remote-control') {
        const sel = getLocalSession();
        const rcCwd = sel?.projectPath || selectedProject?.path;
        if (!sel?.sessionId) {
          confirmDialog('请先发送至少一条消息以创建会话，然后再输入 /remote-control 开启手机远程控制。');
          return;
        }
        try {
          const r = await fetch('/api/remote-control', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sel.sessionId, cwd: rcCwd }),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || r.status);
          useStore.getState().setRemoteControl(sel.sessionId, true);
          confirmDialog('远程控制已激活（后台运行，无终端窗口）。\n手机用 Claude App 接管此会话；电脑端 GUI 会自动同步消息。\n输入框已锁定，避免双写——点输入框上方的「收回控制」按钮（或顶栏的「已激活」按钮）可收回。\n（需 Claude 账号登录，且当前未切到 deepseek/mimo 等三方模型）');
        } catch (e) {
          confirmDialog('开启远程控制失败：' + e.message);
        }
        return;
      }
      // /btw 旁问:CLI 的 /btw 是交互式专属(stream-json 通道实测被回 "isn't
      // available in this environment")。GUI 拦截后走 /api/chat/btw(headless
      // fork:--resume+--fork-session+--no-session-persistence),回答带会话上下文
      // 但零污染主会话。答案以"旁问"气泡插入本地视图,不进历史;不占用主流式通道,
      // 主回合进行中也可旁问(这正是 /btw 的用途)。
      if (cmd === '/btw' || cmd.startsWith('/btw ')) {
        const q = String(prompt || '').trim().replace(/^\/btw\s*/i, '');
        if (!q) {
          confirmDialog('用法：/btw <问题>\n旁问一个问题——不打断当前工作、不写入会话历史。');
          return;
        }
        // 次入口:走共享 sendBtw(展开浮窗 + 发起旁问);逻辑与窗口内输入框一致。
        sendBtw(q);
        return;
      }
      // Defense-in-depth: ChatInput already locks the composer when the session
      // is under remote control, but handleSend can be reached by other paths.
      // A new `-p` turn here would double-write the RC pty's session jsonl.
      const lockedSid = getLocalSession()?.sessionId;
      if (lockedSid && useStore.getState().remoteControlled[lockedSid]) {
        confirmDialog('此会话已交给手机远程控制，输入框已锁定。点输入框上方的「收回控制」按钮收回后再发送。');
        return;
      }
    }
    // 编辑重发(#4):若存在待回滚目标,此刻才执行破坏性回退——还原文件 + 裁剪历史,
    // 然后把(可能已编辑过的)文本作为新一轮发出。复用 handleRollback('both') 的成熟
    // 路径(trim/文件还原/重发),避免重复逻辑。必须先清待回滚再调用,防止重发递归。
    if (!reattachPid && !hiddenUserMessage && pendingEditRef.current && handleRollbackRef.current) {
      const pending = pendingEditRef.current;
      setPendingEditRollback(null);
      handleRollbackRef.current(pending.msg, { mode: 'both', resendText: { prompt, options: opts } });
      return;
    }
    // handleRollbackRef 尚未就绪(极短的首渲窗口):清掉待回滚,继续走正常发送兜底,
    // 避免静默吞掉这次发送。
    if (pendingEditRef.current && !handleRollbackRef.current) setPendingEditRollback(null);
    // On a normal send, gate against duplicate streams and enqueue overflow.
    // On reattach, the caller is the backgroundPid effect — we WANT it to take
    // over the stream, so skip the gate and the prep work (no user bubble,
    // no checkpoint, no provider-mismatch strip, no POST /api/chat).
    // H 转后台:backgroundPid 有值=本会话回合仍在服务端跑(streamingRef 已被 detach 置 false)。
    // 也要入队——否则直发会 --resume 同一 jsonl 与后台回合双写(server 只复用 idle slot,
    // busy slot 会另起进程)。队列在后台回合完成时由 backgroundPid 轮询分支排空(见 poll)。
    if (!reattachPid && (streamingRef.current || backgroundPidRef.current)) {
      useStore.getState().enqueueMessage(sessionQueueKey, { text: prompt, queuedAt: Date.now(), hidden: !!hiddenUserMessage, opts });
      return;
    }

    // 本次真正起流的 generation。必须在任何 await、updateStreaming(true) 和用户消息写入前
    // 同步抢占；否则旧回合 finally 的落盘轮询会在本回合尚未拿到 pid 时误判为“没有新回合”。
    const streamTurnToken = ++streamTurnTokenRef.current;
    const isCurrentTurn = () => isCurrentStreamTurn(streamTurnTokenRef.current, streamTurnToken);

    const cwd = selectedSession?.projectPath || selectedProject?.path;
    // Note: previously this function had a blocking `confirm()` for git preflight.
    // That dialog could appear behind other modals or get auto-suppressed by
    // browsers, leaving sends silently stuck. Git preflight is now opportunistic
    // and non-blocking — kicked off in the background, never gates the send.
    // (User can still run git init manually anytime.)

    const isCompact = /^\/compact\b/.test(String(prompt || '').trim());
    const isClear = /^\/clear\b/.test(String(prompt || '').trim());
    streamStartRef.current = Date.now(); // CJ-4:本回合计时起点
    updateStreaming(true);
    // I4:本次流的归属会话(draft 时是 draft-key,init 收到真 id 后会在下面升级)。
    setStreamOwner(sessionQueueKey);
    // 新回合开始必清上一次 /stop 的响应 ref:上轮 finally 若因异常没读到就清,陈旧 promise
    // 会被本回合 finally 当成"本次停止的保留项",按上一轮的 keptToolUseIds 排除收尾。
    stopKeptRef.current = null;
    // BF-1:记录历史截断点 —— 流式期间任何历史重拉都会拉到本回合半成品,渲染层据此丢弃。
    // reattach 改为不截断(resolveStreamHistCutoff):{ sinceTs: detachTs } 是按 turn 粒度过滤的,
    // 而一条 turn 的时间戳取本回合【第一条】assistant 记录的时间(必早于 detach)⇒ 在跑的整个
    // turn 从来没被截掉,再叠加 earlyLines 重放出的流式气泡 = 同一段内容画成两个气泡。改为
    // 「历史(jsonl)单一来源画、reattach 不画自己的气泡」(下面 setReattachStream + 渲染门)。
    setReattachStream(!!reattachPid);
    setStreamHistCutoff(resolveStreamHistCutoff(!!reattachPid, Date.now()));
    setCompacting(isCompact);
    setStreamingText('');
    setStreamingThinking('');
    setStreamingToolCalls([]);
    setStreamingBlocks([]);
    setLiveStatus(null);
    // 输入预测(A):新回合开始,上一回合的建议作废(reattach 是同一回合的续播,不清)。
    if (!reattachPid) setPromptSuggestion(null);
    // 本回合是否开启输入预测(A):随全局开关。server 在 result 后留 3s 等待窗收建议。
    const suggestOnClient = useStore.getState().promptSuggestions !== false;

    if (!reattachPid && !hiddenUserMessage) {
    // Push the user bubble IMMEDIATELY so multi-turn sends don't appear to
    // "swallow" the user's message while waiting on git checkpoint I/O. The
    // checkpoint runs in parallel and back-fills `checkpointSha` on the same
    // chatMessages entry when ready (rollback menu reads it from there).
    userMsgUuid = 'chat-user-' + Date.now();
    userMsgTimestamp = new Date().toISOString();
    setChatMessages((prev) => [...prev, {
      uuid: userMsgUuid, type: 'user',
      timestamp: userMsgTimestamp, text: prompt,
      checkpointSha: null,
      // L3: 附件卡片渲染数据。displayText 是去附件标签后的纯文本(气泡显示用),
      // attachments 用于渲染缩略图/文件名卡片。prompt(text)仍是给 CLI 的完整 outbound。
      attachments: meta?.attachments,
      displayText: meta?.displayText,
    }]);
    // L4: 持久化 attachments 到 sidecar (按 textHash 索引)。已有真 sid 立即写;
    // draft 状态暂存到 ref,init 事件拿到 sid 后由那里 flush。
    if (meta?.attachments?.length > 0) {
      const payload = { text: prompt, attachments: meta.attachments, displayText: meta.displayText || '' };
      const sid = selectedSession?.sessionId;
      if (sid) {
        fetch(`/api/sessions/${sid}/attachments`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      } else {
        pendingAttachmentRef.current = payload;
      }
    }

    // Fire-and-forget git checkpoint. Failures (not a git repo etc.) are
    // silent — no checkpointSha just means the rollback menu's "files only"
    // option will be disabled for this message.
    checkpointPromise = (async () => {
      try {
        const sel = selectedSession;
        if (!sel?.sessionId || !cwd) return;
        const cr = await fetch('/api/checkpoints', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sel.sessionId,
            cwd,
            label: `before: ${prompt.slice(0, 60)}`,
            clientMessageId: userMsgUuid,
            messageTimestamp: userMsgTimestamp,
            promptPreview: prompt,
          }),
        });
        if (!cr.ok) return;
        const data = await cr.json().catch(() => ({}));
        const sha = data.sha || null;
        if (!sha) return;
        setChatMessages((prev) =>
          prev.map((m) => (m.uuid === userMsgUuid ? { ...m, checkpointSha: sha } : m))
        );
        return sha;
      } catch {}
    })();

    // Provider-switch guard: when cc switch routes the backend to a different
    // provider than what generated the last assistant turn's thinking block,
    // the new backend rejects the resumed history with `400 Invalid signature
    // in thinking block`. Strip thinking blocks from the on-disk jsonl before
    // the CLI calls --resume so the conversation continues seamlessly.
    try {
      const sid0 = selectedSession?.sessionId;
      if (sid0 && selectedSession?.projectHash) {
        // Does the on-disk history actually carry thinking blocks worth stripping?
        const persisted = getLocalMessages();
        const hasAnyThinking = persisted.some((m) => m.type === 'turn' && (
          (Array.isArray(m.thinking) && m.thinking.length > 0)
          || (Array.isArray(m.blocks) && m.blocks.some((b) => b?.type === 'thinking'))
        ));
        // histProv = the provider those turns were RECORDED under (NOT inferred
        // from the model name — mimo relays claude-* names and would be misread as
        // 'anthropic', so a mimo→official switch silently skipped the strip and the
        // CLI hit "400 Invalid signature in thinking block" on --resume).
        const histProv = useStore.getState().lastProviderBySession?.[sid0] || null;
        const currProv = useStore.getState().currentProvider?.providerHint || 'anthropic';
        if (hasAnyThinking && histProv && histProv !== currProv) {
          try {
            const r = await fetch(`/api/sessions/${sid0}/strip-thinking`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectHash: selectedSession.projectHash }),
            });
            if (r.ok) {
              const d = await r.json().catch(() => ({}));
              await fetchMessagesForTab(
                sid0, selectedSession.projectHash, { silent: true },
              );
              // Only surface the banner when we actually stripped something —
              // otherwise the user sees "已剥离 0 条" which is misleading
              // (the call was an idempotent no-op against an already-clean file).
              if (d.strippedBlocks > 0) {
                setProviderSwitchNotice({
                  text: `切换到 ${currProv}：已剥离 ${d.strippedBlocks} 条历史思考块（${histProv} 签名，新后端不认）。备份在 ${sid0.slice(0, 8)}…jsonl.bak`,
                });
              }
            }
          } catch {}
        }
      }
    } catch {}
    } // end if (!reattachPid && !hiddenUserMessage)

    // Did this turn actually emit assistant content? Declared out here (not in
    // the try) so the finally can read it: gates the post-stream poll so an
    // empty/errored turn — which never gets a jsonl twin — neither waits on one
    // nor has its local ⚠️/❌ notice cleared.
    let producedReply = false;
    // Count of assistant turns already in the persisted jsonl BEFORE this round.
    // The finally uses this (not a text match on the prompt) to detect when THIS
    // round's reply has landed: a repeated prompt (e.g. "继续") would make a
    // text-based check match a PRIOR round's turn and clear the new reply early.
    let turnsBefore = 0;
    try { turnsBefore = (getLocalMessages() || []).filter((m) => m.type === 'turn').length; } catch {}
    // 提升到 try 外:用户中途按停止(AbortError)时,catch 需要读到已流式累积的内容
    // 才能把它保留成气泡,而不是连同用户消息一起丢弃(#6)。
    let accumulatedText = '';
    let accumulatedThinking = '';
    let currentToolCalls = [];
    let orderedBlocks = [];  // [{ type, blockIndex, content?, toolCall? }, ...]
    let streamClosedNoticed = false; // CG-2:子代理打穿 canUseTool 通道的兜底提示,每轮只提示一次
    const taskIdToToolUse = {};  // task_started 建立 task_id→tool_use_id 映射,供只带 task_id 的 task_updated 用
    let turnAborted = false;     // 用户主动停止(catch 到 AbortError)才 true;供 finally 区分"正常完成"(不收后台化子代理)与"停止"(收 stopped)
    let resultUsage = null;      // result 事件携带的本轮 usage(CLI 聚合口径)
    let resultCostUsd = null;    // result 事件携带的 total_cost_usd(CLI 权威成本)
    // 本次流真正归属的 sessionId:发起于真会话=闭包 sid;发起于 draft=init 事件里的新 sid。
    // result 后的标题兜底等"归属敏感"逻辑一律用它,绝不摸 getLocalSession()(用户可能已切走)。
    let streamSid = selectedSession?.sessionId || null;
    // 发起时的 projectHash 闭包(判官盲审重要1):finally 拉历史必须用它,不能现取
    // getLocalSession()?.projectHash —— 流式期间用户切到另一个项目的会话时两者对不上,
    // 会拉错项目历史/404。draft 会话也带 projectHash,全程有效。
    const streamOwnerPh = selectedSession?.projectHash || null;
    // 归属解析(子代理/后台任务/workflow 条目的 sessionId):本流归属优先 ——
    // streamSid(init 后必有)> ownerKey。读 getLocalSession() 会在用户切会话后把条目
    // 挂到别人头上(判官盲审#4)。draft 阶段(ownerKey 还是 draft-<hash>)也返回该 draft
    // 键而非 null(判官盲审重要2):null 条目在 init 后 migrateSessionKey 无法迁移 →
    // finalizeSessionAgents 按真 sid 扫不到 → 残留 + 监控幽灵;draft 键则可随迁移转正。
    const streamOwnerSid = () => streamSid || streamOwnerKeyRef.current || null;
    // C1:置在 try 的第一行(不是更早的 updateStreaming(true) 处),这样 +1 与下面 finally
    // 的 -1 严格配对 —— try 之前抛错就根本没加过,不会把 poll 排空永久压死。
    // 正常/reattach 两条起流路径共用这同一个 try/finally,一处覆盖两条。
    finalizeInFlightRef.current += 1;
    try {
      let pid;
      if (reattachPid) {
        // Re-attach path: the CLI process is already running in the background
        // (user navigated away mid-stream, then came back). Skip POST /api/chat
        // and connect straight to the existing stream so the user sees the
        // live tokens flow as if they never left.
        pid = reattachPid;
        activeProcRef.current = pid;
      } else {
      if (!reattachPid) {
        try { await checkpointPromise; } catch {}
      }
      const { addDirs, globalRead } = useStore.getState();
      // Permission mode / model / effort are all per-session: read THIS
      // session's stored value (keyed by sessionQueueKey) so each pane/session
      // sends with its own settings, not whatever was last globally selected.
      let permissionMode = useStore.getState().getPermissionModeFor(sessionQueueKey);
      // 修正批#5/判官①:auto 档仅官方 Anthropic 可用(SDK 安全分类器)。切到第三方后
      // 静态过滤只是藏选项、不清已 pin 的 auto → 会原样发出;第三方的报错大概率不含
      // "auto",运行时回退(报错文案正则)接不住,用户卡死。发送前就地降为 default
      // 并回写 pin 闭环,附切换通知横幅。
      if (permissionMode === 'auto' && (useStore.getState().currentProvider?.providerHint || 'anthropic') !== 'anthropic') {
        permissionMode = 'default';
        useStore.getState().setPermissionMode('default', sessionQueueKey);
        setProviderSwitchNotice({ text: '「自动」权限档仅官方 Anthropic 端点支持,本会话已自动切回「逐步确认」。' });
      }
      // 模型解析与徽章一致(#8):pin → 历史模型 → 全局默认。否则发送时只读 pin||全局,
      // 全局被 WS 重置成默认后,没 pin 的会话(尤其回滚后)会用默认模型发出,与徽章不符。
      // 模型解析(#8/U1/U4/BK-0 四轮 bug 聚集地)→ 纯逻辑抽到 utils/routing.js,
      // 语义不变,详细注释与测试见那里(npm run test:routing)。
      const _pin = useStore.getState().modelBySession[sessionQueueKey];
      const _hist = resolveHistModel(getLocalMessages(), useStore.getState().providerEpoch || 0);
      const _stM = useStore.getState();
      let currentModel = resolveSendModel({
        pin: _pin,
        hist: _hist,
        globalModel: _stM.currentModel,
        availableModels: _stM.availableModels,
        customModels: _stM.customModels,
        officialAnthropic: (_stM.currentProvider?.providerHint || 'anthropic') === 'anthropic',
      });
      // 1M 标记兜底(与徽章显示解析同一规则):重装丢 pin 后,发送也要带回 [1m],
      // 否则显示 1M 而实际按 200K 发。用 selectedSession?.sessionId(勿用下方 const sid,
      // TDZ)。pin 显式关 1m 时 syncContext1m 已清标记,不会误补。
      const _c1m = selectedSession?.sessionId && _stM.context1mBySession?.[selectedSession.sessionId];
      if (_c1m && currentModel && !/\[1m\]/i.test(currentModel)) currentModel = currentModel + '[1m]';
      const effort = useStore.getState().getEffortFor(sessionQueueKey);
      // When resuming an existing session, cwd MUST be the EXACT string the
      // CLI was launched with — including Unicode chars (e.g. `/foo/肠骨轴`).
      // Reconstructing from the hash dir name is lossy: CLI maps every non-
      // ASCII char to `-`, so `肠骨轴` → `----` is one-way. The server now
      // reads the real cwd out of the jsonl's first system record and ships
      // it as `projectPath` on the session object — always trust that first.
      const sid = selectedSession?.sessionId;
      // BG5:活跃 Agent / 模式 —— 仅新会话(无 sid)注入 --agent(server 也只在无 sessionId 时传)。
      // 必须放在 `sid` 声明之后:之前放在前面引用了 TDZ 中的 const sid → WebKit 报
      // "Cannot access uninitialized variable.",每次发送都炸(普通/agent 模式皆然)。
      const activeAgent = !sid ? useStore.getState().getActiveAgentFor(sessionQueueKey) : '';
      const chatCwd = (sid && selectedSession?.projectPath)
        ? selectedSession.projectPath
        : (selectedSession?.projectPath || selectedProject?.path);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          // Omit sessionId for a draft so the CLI creates a fresh session.
          sessionId: sid || undefined,
          // draft 流带 draftId(存进 server slot):init 前切走再切回时轮询按它找回
          // 本进程 reattach,earlyLines 回放的 init 经归属校验正确绑定(僵尸 draft 修复)。
          draftId: (!sid && selectedSession?.draftId) ? selectedSession.draftId : undefined,
          cwd: chatCwd,
          // /compact 用标准上下文压缩:剥掉 [1m]。否则 Anthropic 上压缩会用 1M 上下文,
          // 触发 "Usage credits required for 1M context" 报错(用户报告)。压缩只是摘要,
          // 不需要 1M 窗口;对原生 1M 的 provider 去掉也无害。
          model: isCompact ? String(currentModel || '').replace(/\[1m\]/i, '') : currentModel,
          effort: effort || undefined,
          appendSystemPrompt: appendSystemPrompt || undefined,
          addDirs: addDirs && addDirs.length ? addDirs : undefined,
          permissionMode: permissionMode || 'default',
          globalRead: globalRead !== false,
          agent: activeAgent || undefined,
          // 三态原样传:true/false=用户显式;'auto'=server 按 provider 决定(第三方开/官方关)
          excludeDynamicSystemPrompt: useStore.getState().excludeDynamicSystemPrompt,
          // #26 会话常驻:false 时 server 回合结束即关进程(逐回合冷启,旧行为)
          keepAlive: useStore.getState().persistentChat !== false,
          // 花费上限(美元):>0 时透传 SDK maxBudgetUsd,进程累计花费达到上限即停。
          maxBudgetUsd: useStore.getState().maxBudgetUsd || undefined,
          // 输入预测(A):server 据此启用 SDK promptSuggestions 并在 result 后留等待窗。
          promptSuggestions: suggestOnClient,
        }),
      });
      const respJson = await res.json();
      // Surface server rejections (e.g. invalid project dir → 400) instead of
      // streaming a non-existent pid — that would hang forever as a stuck
      // "connecting" with no reply (the catch below renders the message).
      if (!res.ok || !respJson.pid) throw new Error(respJson.error || `发送失败 (${res.status})`);
      pid = respJson.pid;
      activeProcRef.current = pid;
      setStreamingModel(respJson.model);
      }

      const controller = new AbortController();
      abortRef.current = controller;
      killedRef.current = false; // 本回合起始重置:除非随后真 POST /stop,否则 abort 不算杀进程
      // 新回合开始 = 会话复活:清除"已停"标记(监控页 wf 内层 agent 的 stopped 覆盖失效,
      // 新 workflow 可正常显示 running)。draft 首发 sid 在 init 事件才确定,那里再清一次。
      if (streamSid) useStore.getState().clearSessionStopped?.(streamSid);
      const streamRes = await fetch(`/api/chat/${pid}/stream`, { signal: controller.signal });
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Aggregated per-message turn state (matches what gets pushed to chatMessages on done).
      // 声明已提升到 try 外(见上),这里仅复位。**ORDERED** orderedBlocks 保留 text/
      // thinking/tool_use 内容块的时间顺序,让 UI 按模型输出的真实顺序渲染。
      accumulatedText = '';
      accumulatedThinking = '';
      currentToolCalls = [];
      orderedBlocks = [];  // [{ type, blockIndex, content?, toolCall? }, ...]
      // Did we already render a visible error turn? Guards the empty-output
      // fallback below so we don't double-report.
      let sawError = false;
      // Per-content-block scratch indexed by Anthropic SDK's block `index` field.
      // Each entry: { type: 'text'|'thinking'|'tool_use', toolId?, name?, jsonBuf?, orderIdx? }
      const blocks = {};
      // Bug #5:CLI 在多 message 场景(调工具→AI 继续生成)下偶尔重复发同一个
      // stream_event(原因未明,可能 CLI 内部 backpressure 或 retry),前端无保护
      // 累加两次导致"先先更新更新"字符级双写。
      // 用 ring buffer 缓存最近 N 个 SSE 行的内容,完全相同跳过(每条 SSE 行的
      // JSON 至少含 ev.uuid / index / delta.text 之一,合法重复的概率为 0)。
      const recentLines = [];
      const RECENT_MAX = 16;
      // reattach 期间的历史刷新器:本流不画气泡,内容全靠历史卡,所以要让历史卡随 jsonl
      // 增长。用收到的 SSE 事件当心跳做节流(1.5s),**不能**依赖 file watcher —— 打包版
      // 的 jsonl watcher 是关的(server/index.js "file-watcher disabled for packaged
      // Tauri backend"),否则整个 reattach 期间历史卡纹丝不动。
      // 归属敏感:只刷本流归属的 sid+ph(streamSid/streamOwnerPh 闭包),绝不读
      // getLocalSession() —— 流式期间用户可能已切到别的会话/项目(store 的 fetchMessages
      // 还有一层 paneSessions[tab] 乱序守卫,响应落地时切走了会整条丢弃)。
      let lastHistRefreshAt = Date.now();
      let histRefreshInFlight = false; // 上一次还没落地就不再发:慢盘/大会话时避免请求叠罗汉
      const refreshHistIfDue = (force) => {
        if (histRefreshInFlight) return;
        if (!shouldRefreshHist({ isReattach: !!reattachPid, now: Date.now(), lastAt: lastHistRefreshAt, force })) return;
        const _sid = streamSid, _ph = streamOwnerPh;
        if (!_sid || !_ph) return;
        lastHistRefreshAt = Date.now();
        histRefreshInFlight = true;
        // fire-and-forget:刷新失败不影响流本身。force 撞上在途请求时被跳过也无妨 ——
        // finally 的落盘轮询本来就会再拉一次收尾。
        try {
          Promise.resolve(fetchMessagesForTab(_sid, _ph, { silent: true }))
            .catch(() => {})
            .finally(() => { histRefreshInFlight = false; });
        } catch { histRefreshInFlight = false; }
      };
      const isDuplicate = (line) => {
        if (recentLines.includes(line)) return true;
        recentLines.push(line);
        if (recentLines.length > RECENT_MAX) recentLines.shift();
        return false;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          // 跳过 message_start / message_stop / done / heartbeat 类不带数据的事件,
          // 这些可能因 CLI 心跳合法重复;只 dedup 含 delta 内容的 stream_event。
          if (line.includes('"content_block_delta"') || line.includes('"text_delta"') || line.includes('"input_json_delta"') || line.includes('"thinking_delta"')) {
            if (isDuplicate(line)) {
              if (typeof window !== 'undefined' && window.__cguiDebug) console.log('[cgui-dedup] skip dup', line.slice(0, 120));
              continue;
            }
          }
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          // Capture the new session id when starting from a draft.
          // IMPORTANT: go through `setSelectedSession` setter so the new id is
          // persisted to localStorage. Bypassing it (raw `useStore.setState`)
          // leaves localStorage with the old draft (sessionId=null), so a
          // page refresh forgets the session even though it exists on disk.
          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            streamSid = event.session_id; // 本次流归属的真 sid(draft 发起时在此确定)
            useStore.getState().clearSessionStopped?.(event.session_id); // draft 首发:真 sid 此刻才知道
            // Record the provider this turn ran under so a later switch can strip
            // now-invalid thinking-block signatures. Model name can't tell a mimo
            // relay (claude-* names) from official, so we key off the live hint.
            useStore.getState().setLastProvider(
              event.session_id,
              useStore.getState().currentProvider?.providerHint || 'anthropic',
            );
            const sel = getLocalSession();
            // 归属校验(用户实报串扰:会话A运行时新建会话B,B 首条消息 --resume 进了A):
            // init 到达时当前选中可能已不是发起这次流的会话——只判"sel 是 draft"会把 A 的
            // session_id 抢绑到无辜的新 draft B 上,B 的下一条消息就串进 A。两个泄漏路径都堵:
            // 判定逻辑在 utils/routing.js(纯函数,test:routing 覆盖串扰家族全部场景)。
            const startedAsDraft = !selectedSession?.sessionId;
            const selIsOrigin = isInitBindingOrigin(startedAsDraft, selectedSession?.draftId, sel);
            if (selIsOrigin) {
              // Carry the draft's per-session model/permission pins to the real
              // session id so a model picked for a brand-new chat doesn't revert.
              useStore.getState().migrateSessionKey(`draft-${sel.projectHash || 'none'}`, event.session_id);
              // I4:草稿流拿到真 sessionId,把流归属 key 一并升级,否则 setSelectedSession
              // 把当前会话 key 变成真 id 后,渲染层会判定"流不属于当前会话"而误隐藏本条流。
              if (streamOwnerKeyRef.current === `draft-${sel.projectHash || 'none'}`) {
                setStreamOwner(event.session_id);
              }
              // opus/sonnet 双审计:draft-key 升级成真 sid 后,两处本地态还挂着旧键,必须一并迁:
              // ①chatMessages 里 ownerKey=draft-key 的本地注记(draft 里发的 /btw 气泡等)——
              // visibleChat 按 ownerKey===sessionQueueKey 门控,不迁则键永不匹配、气泡凭空消失
              // (btw 无 jsonl 孪生=内容丢失);②ChatInput 的 localStorage 草稿(cgui-draft:<key>)——
              // draftKey 变更 effect 会读新键(必空)把正在打的下一条消息清掉,先把旧值复制过去。
              {
                const _dk0 = `draft-${sel.projectHash || 'none'}`;
                setChatMessages((prev) => (prev.some((m) => m.ownerKey === _dk0)
                  ? prev.map((m) => (m.ownerKey === _dk0 ? { ...m, ownerKey: event.session_id } : m))
                  : prev));
                try {
                  const _dv = localStorage.getItem(`cgui-draft:${_dk0}`);
                  if (_dv) { localStorage.setItem(`cgui-draft:${event.session_id}`, _dv); localStorage.removeItem(`cgui-draft:${_dk0}`); }
                } catch {}
                // 输入历史同迁:draft 期 saveHistoryEntry 写的是 cgui-input-history:draft-<hash> 旧键,
                // 不迁则首条历史滞留旧键、且会污染该项目下一个 draft 的历史列表。幂等(旧键空则不动)。
                try {
                  const _hv = localStorage.getItem(`cgui-input-history:${_dk0}`);
                  if (_hv && _hv !== '[]') { localStorage.setItem(`cgui-input-history:${event.session_id}`, _hv); localStorage.removeItem(`cgui-input-history:${_dk0}`); }
                } catch {}
              }
              // 串扰窗口1守卫的 draft→真 sid 升级:pane 历史(draft 期为空)的归属标记
              // 同步升级成真 sid,否则绑定后、首次 fetch 回来前守卫会误藏活会话。
              useStore.getState().claimPaneMessages(tabIndex, event.session_id);
              setSelectedSession({
                ...sel,
                draft: false,
                sessionId: event.session_id,
              });
              // L4: draft 期间暂存的 attachments 元数据现在能写到正确 sessionId 的 sidecar
              if (pendingAttachmentRef.current) {
                const payload = pendingAttachmentRef.current;
                pendingAttachmentRef.current = null;
                fetch(`/api/sessions/${event.session_id}/attachments`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                }).catch(() => {});
              }
            }
            // 以下两件事是"会话 A 已真实诞生"的事实处理,与"当前选中是谁"无关——用户已切走
            // (selIsOrigin=false)时也照做:标题该生成、列表该出现 A。数据全取发起时闭包
            // (prompt/cwd/selectedSession),不碰 getLocalSession()。
            if (startedAsDraft) {
              // 队列迁移(fable 审计,逻辑在 utils/routing.js):selIsOrigin=false 时
              // migrateSessionKey 不执行,残留队列会被下一个同项目 draft 继承串发;
              // selIsOrigin=true 时已迁空,此处 no-op。pin 不迁(见 routing.js 注释)。
              try {
                const _dk = `draft-${selectedSession?.projectHash || 'none'}`;
                const _next = migrateDraftQueue(useStore.getState().messageQueue, _dk, event.session_id);
                if (_next) useStore.setState({ messageQueue: _next });
              } catch {}
              // 输入历史同迁(用户已切走时 selIsOrigin=false,上面 origin 块不执行,在此兜底):
              // draft 期历史存旧键,不迁则首条历史滞留旧键且污染该项目下一个 draft。取发起时闭包
              // selectedSession(sel 是当前选中,用户已切走时会错迁别的项目)。selIsOrigin=true 时旧键已删,此处幂等 no-op。
              try {
                const _hk = `draft-${selectedSession?.projectHash || 'none'}`;
                const _hv = localStorage.getItem(`cgui-input-history:${_hk}`);
                if (_hv && _hv !== '[]') { localStorage.setItem(`cgui-input-history:${event.session_id}`, _hv); localStorage.removeItem(`cgui-input-history:${_hk}`); }
              } catch {}
              // Q3 标题提速:新会话拿到真 sid 就立刻并行生成标题(只用首条用户消息,
              // 不等回复完成)。失败时 result 后的兜底逻辑(带 firstAssistant)会重试。
              try {
                const _sid = event.session_id;
                const _st = useStore.getState();
                if (!titleAttempted.has(_sid) && !_st.customTitles[_sid] && !_st.autoTitles[_sid] && prompt && !hiddenUserMessage) {
                  titleAttempted.add(_sid);
                  const _m = String(_st.modelBySession[_sid] || _st.currentModel || '').replace(/\[1m\]/i, '');
                  fetch('/api/chat/title', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ firstUser: prompt, firstAssistant: '', cwd, model: _m }),
                  }).then((r) => r.json()).then((d) => {
                    if (d?.title) useStore.getState().setAutoTitle(_sid, d.title);
                    else titleAttempted.delete(_sid);
                  }).catch(() => { titleAttempted.delete(_sid); });
                }
              } catch {}
              const hash = selectedSession?.projectHash;
              // Retry triple — jsonl write timing varies. First attempt may
              // hit the brief window before the CLI flushes; later ones catch
              // up. silent so loading flag doesn't flicker.
              if (hash) {
                [400, 1200, 3000].forEach((ms) =>
                  setTimeout(() => useStore.getState().fetchSessions(hash, { silent: true }), ms)
                );
              }
              // 首条消息补拍 checkpoint:handleSend 的 checkpointPromise 在 draft 态
              // (无 sessionId)直接 return → 首轮 AI 改动无回滚锚点(resolve 还可能
              // 错选之后的快照)。此处 sid 刚诞生,数据全取发起时闭包(cwd/prompt/
              // userMsgUuid),归属安全。快照内容=AI 动手前的工作区(AI 还没开始改)。
              if (cwd && userMsgUuid) {
                fetch('/api/checkpoints', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    sessionId: event.session_id,
                    cwd,
                    label: `before: ${prompt.slice(0, 60)}`,
                    clientMessageId: userMsgUuid,
                    messageTimestamp: userMsgTimestamp,
                    promptPreview: prompt,
                  }),
                }).then((r) => (r.ok ? r.json() : null)).then((d) => {
                  if (d?.sha) {
                    setChatMessages((prev) =>
                      prev.map((m) => (m.uuid === userMsgUuid ? { ...m, checkpointSha: d.sha } : m)));
                  }
                }).catch(() => {});
              }
            }
          }

          // 压缩边界(原生 auto-compact 或手动 /compact 都会发):立即插一条压缩分隔,
          // 用户当场看到上下文被压缩,不必等回合结束 refetch。回合结束 chatMessages 被清空,
          // 换成 jsonl 里的 isCompactSummary divider(同一条),不会重复。(#5)
          if (event.type === 'system' && event.subtype === 'compact_boundary') {
            setChatMessages((prev) => {
              if (prev.some((m) => m.type === 'compact' && m._live)) return prev;
              return [...prev, { type: 'compact', uuid: 'live-compact', _live: true }];
            });
            // U8:压缩边界后,压缩前写入的即时 usage 已是旧值,清掉 —— 否则它优先级
            // 高于 jsonl 的 lastUsage,徽章在压缩后纹丝不动(用户报告)。
            setLiveContextUsage(null);
          }

          // 等待状态(G):SDK system status —— sdk.d.ts 实测结构
          // { type:'system', subtype:'status', status:'compacting'|'requesting'|null,
          //   compact_result?, compact_error? }。compacting 覆盖 auto-compact(非用户
          // /compact 触发,原来只有 compact_boundary 一条分隔、压缩过程零反馈)。
          // requesting 每次 API 调用都发,太噪,不渲染;status:null=阶段结束,清行。
          if (event.type === 'system' && event.subtype === 'status') {
            if (event.status === 'compacting') setLiveStatus({ text: '正在压缩上下文…' });
            else setLiveStatus(null);
            if (event.compact_result === 'failed' && event.compact_error) {
              setProviderSwitchNotice({ text: `上下文压缩失败:${String(event.compact_error).slice(0, 120)}` });
            }
          }
          // 等待状态(G):API 可重试错误(限流/5xx/超时),SDK 自动退避重试 ——
          // { type:'system', subtype:'api_retry', attempt, max_retries, retry_delay_ms,
          //   error_status: number|null }(null=无 HTTP 响应的连接错误)。
          // 子代理"勾号过早"根治(v0.2.210,实测+opencode 调研定案):CLI/SDK 为每个 Task 子代理
          // 发【权威终态事件】——{type:'system', subtype:'task_notification', tool_use_id, status:
          // completed|failed|stopped}(实测恒在子代理真正结束那刻、带我们的卡片键 tool_use_id)。
          // 据此精确标 done,不再靠 tool_result(124ms 提前回执,竞态)也不靠 5s 猜时长。
          // task_started 建立 task_id↔tool_use_id 映射,供只带 task_id 的 task_updated 兜底。
          if (event.type === 'system' && event.subtype === 'task_started' && event.task_id && event.tool_use_id) {
            taskIdToToolUse[event.task_id] = event.tool_use_id;
            // taskManaged:该 agent 有 task_notification 权威终态事件收尾,持久钉在条目上(跨回合/
            // reattach 存活,不像 per-stream Set 重连即丢)。顶层 result 兜底一律不碰它;finally 仅在
            // 【用户主动停止】时才收(进程被杀)。根治"后台化子代理(run_in_background,如深度调研)派发后
            // 顶层 result / 回合 done 的 finally 把它误标 done,而它其实还在后台跑"(用户实报)。
            // D4b:条目不存在时最小化建一条(仅 local_agent —— local_bash 建条目会在监控里
            // 冒出假子代理卡,local_workflow 由下面自己的分支建)。嵌套子代理的条目原本要等它
            // 自己的 message_start 才由 upsertAgent 顺带建出来,task_started 这刻还没有 →
            // 存在性守卫落空 → 拿不到 taskManaged(被顶层 result 提前标 done)、也没有
            // sessionId(停止时 finalizeSessionAgents 扫不到)。
            {
              const _s0 = useStore.getState();
              // taskId 钉在条目上(批A A4):task_updated 没有 tool_use_id,原来只能靠本流的
              // taskIdToToolUse 反查,跨回合/reattach/刷新即失效 → 客户端永不收尾。
              // sessionId 补齐(批A A5):先 message_start 后 task_started 的顺序下,这条存在性
              // 分支原来只补 taskManaged —— 条目没有 sessionId 就不计入「停止后台 N」,也逃过
              // finalizeSessionAgents(App.jsx:747 continue)。【已有值不覆盖】:归属敏感。
              if (_s0.activeAgents[event.tool_use_id]) {
                _s0.upsertAgent(event.tool_use_id, {
                  taskManaged: true,
                  taskId: event.task_id,
                  sessionId: _s0.activeAgents[event.tool_use_id].sessionId || streamOwnerSid(),
                });
              } else if (event.task_type === 'local_agent') {
                _s0.upsertAgent(event.tool_use_id, {
                  name: event.subagent_type || 'Agent',
                  description: event.description || '',
                  status: 'working',
                  startedAt: Date.now(),
                  taskManaged: true,
                  taskId: event.task_id,
                  sessionId: streamOwnerSid(),
                });
              }
            }
            // workflow 实时可见性(v0.2.212,实测定档):Workflow 工具起的独立 runtime agent 不发
            // 带 parent_tool_use_id 的 stream 增量,所以现有 activeAgents 对它建 0 条目、监控看不见;
            // 但父流【实时发】task_started(task_type:'local_workflow', workflow_name, tool_use_id)
            // + task_progress + 权威 task_notification(全带同一 tool_use_id)。这里为 workflow 单元
            // 建一个 activeAgents 条目(tool_use_id 为键),后续 task_progress 滚动描述、task_notification
            // 走现有 finalizeAgent 自动收尾——纯客户端小改,复用已建的 task_notification 架构。
            if (event.task_type === 'local_workflow') {
              const _st = useStore.getState();
              if (!_st.activeAgents[event.tool_use_id]) {
                _st.upsertAgent(event.tool_use_id, {
                  workflow: true,
                  taskManaged: true,
                  name: event.workflow_name || 'workflow',
                  description: event.description || '',
                  status: 'working',
                  startedAt: Date.now(),
                  taskId: event.task_id,
                  sessionId: streamOwnerSid(),
                });
              }
            }
          }
          // workflow 进度:滚动更新描述(同 tool_use_id),不改状态。
          if (event.type === 'system' && event.subtype === 'task_progress' && event.tool_use_id) {
            const _st = useStore.getState();
            if (_st.activeAgents[event.tool_use_id]?.workflow && event.description) {
              _st.upsertAgent(event.tool_use_id, { description: event.description });
            }
          }
          if (event.type === 'system' && event.subtype === 'task_notification') {
            const tuid = event.tool_use_id || (event.task_id ? taskIdToToolUse[event.task_id] : null);
            // authoritative=true:权威终态,允许覆盖 taskManaged 的猜测性 stopped(停止链路 #1 UI 侧)。
            if (tuid) { const _st = useStore.getState(); if (_st.activeAgents[tuid]) finalizeAgent(_st, tuid, event.status, undefined, true); }
          }
          if (event.type === 'system' && event.subtype === 'task_updated'
              && ['completed', 'failed', 'killed'].includes(event.patch?.status)) {
            const _st = useStore.getState();
            // 第三条路(批A A4):taskIdToToolUse 是本流的局部 map,跨回合/reattach/刷新后为空。
            // task_started 已把 taskId 钉在条目上,扫 activeAgents 反查即可。
            const tuid = event.tool_use_id || (event.task_id ? taskIdToToolUse[event.task_id] : null)
              || findAgentIdByTaskId(_st, event.task_id);
            if (tuid && _st.activeAgents[tuid]) finalizeAgent(_st, tuid, event.patch.status === 'killed' ? 'stopped' : event.patch.status, undefined, true);
          }
          if (event.type === 'system' && event.subtype === 'api_retry') {
            const waitS = Math.ceil((event.retry_delay_ms || 0) / 1000);
            const cause = event.error_status ? `HTTP ${event.error_status}` : '连接失败';
            setLiveStatus({ text: `API 请求失败(${cause}),${waitS ? `${waitS}s 后` : ''}自动重试 第 ${event.attempt}/${event.max_retries} 次…` });
          }
          // 等待状态(G):限流信息(顶层事件,非 system subtype —— sdk.d.ts 实测)。
          // { type:'rate_limit_event', rate_limit_info:{ status, resetsAt?, utilization? } }
          // 仅 rejected/allowed_warning 值得打扰;allowed 恢复时清行。
          if (event.type === 'rate_limit_event' && event.rate_limit_info) {
            const ri = event.rate_limit_info;
            if (ri.status === 'rejected' || ri.status === 'allowed_warning') {
              const reset = ri.resetsAt ? new Date(ri.resetsAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
              setLiveStatus({ text: ri.status === 'rejected'
                ? `已达用量限额${reset ? `,${reset} 重置` : ''},等待中…`
                : `用量接近限额${typeof ri.utilization === 'number' ? `(${Math.round(ri.utilization)}%)` : ''}${reset ? `,${reset} 重置` : ''}` });
            } else if (ri.status === 'allowed') {
              setLiveStatus((prev) => (prev ? null : prev));
            }
          }

          // 输入预测(A):回合末建议(在 result 之后到达,server 留了等待窗)。
          // { type:'prompt_suggestion', suggestion, session_id } —— 归属取本次流的
          // streamSid(发起时闭包/init 确定),渲染时与当前查看会话比对,不串窗。
          if (event.type === 'prompt_suggestion') {
            const sTxt = typeof event.suggestion === 'string' ? event.suggestion.trim() : '';
            if (sTxt) setPromptSuggestion({ sid: streamSid || streamOwnerKeyRef.current, text: sTxt });
            setLiveStatus(null);
          }

          // Token-level deltas (--include-partial-messages). This is the path that
          // makes the GUI feel like the CLI terminal: text appears as it's generated.
          if (event.type === 'stream_event' && event.event) {
            const ev = event.event;
            // When parent_tool_use_id is set, this delta belongs to a subagent
            // spawned via the Task tool — not the main turn. Route it to the
            // store's activeAgents map instead of the main streaming buffers,
            // and TaskCard / AgentMonitorPanel will render it.
            const parentToolUseId = event.parent_tool_use_id || null;
            const store = useStore.getState();
            if (parentToolUseId) {
              // 子代理被 SendMessage 唤醒后新流式活动到达,若已是终态则复活为 working(监控重显运行中)。
              if (ev.type === 'message_start') reviveAgentIfTerminal(store, parentToolUseId);
              // M2(Q6): 子代理回合的 message_start 携带其实际模型 id,记到卡片上显示。
              if (ev.type === 'message_start' && ev.message?.model) {
                store.upsertAgent(parentToolUseId, { model: ev.message.model });
              }
              if (ev.type === 'content_block_start') {
                const cb = ev.content_block || {};
                if (cb.type === 'tool_use') {
                  store.appendAgentTool(parentToolUseId, { id: cb.id, name: cb.name, input: {}, result: null });
                }
                blocks[`a:${parentToolUseId}:${ev.index}`] = { type: cb.type, toolId: cb.id, name: cb.name, jsonBuf: '' };
              } else if (ev.type === 'content_block_delta') {
                const blkKey = `a:${parentToolUseId}:${ev.index}`;
                const block = blocks[blkKey];
                const delta = ev.delta || {};
                if (!block) {
                  // 孤儿 delta:reattach 重放的首批 delta 属于 detach 那一刻正在写的块,它的
                  // content_block_start 早被消费、不在 earlyLines 里 ⇒ 这里查不到 block。
                  // 原来整段静默丢弃 → 子代理卡片里这段输出永远看不到。按 delta 类型直接
                  // 追加到子代理缓冲(tool_use 的 input_json 无 toolId,仍只能丢)。
                  if (delta.type === 'text_delta') store.appendAgentText(parentToolUseId, delta.text || '');
                  else if (delta.type === 'thinking_delta') store.appendAgentThinking(parentToolUseId, delta.thinking || '');
                  continue;
                }
                if (delta.type === 'text_delta' && block.type === 'text') {
                  store.appendAgentText(parentToolUseId, delta.text || '');
                } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
                  store.appendAgentThinking(parentToolUseId, delta.thinking || '');
                } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
                  block.jsonBuf += delta.partial_json || '';
                  try {
                    const parsed = JSON.parse(block.jsonBuf);
                    store.updateAgentTool(parentToolUseId, block.toolId, { input: parsed });
                  } catch {}
                }
              }
              continue;
            }

            // Main turn — top-level model output
            // 等待状态(G):新一次 API 调用的内容开始到达 → 之前的重试/限流等待已结束,清行。
            if (ev.type === 'message_start') setLiveStatus(null);
            if (ev.type === 'message_start' && ev.message?.model) {
              setStreamingModel(ev.message.model);
              // #3:message_start 已携带输入侧 usage(input + cache_read/creation = 当前上下文占用),
              // 立刻据此更新上下文徽章 —— 不必等回合结束的 result 事件,显示/更新都更快。
              const u = ev.message.usage;
              if (u && ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)) > 0) {
                // V1:带时间戳,供徽章与 /context 实测结果比新鲜度。
                setLiveContextUsage({ ...u, _ts: Date.now() });
              }
            } else if (ev.type === 'message_delta' && ev.usage
              && ((ev.usage.input_tokens || 0) + (ev.usage.cache_read_input_tokens || 0) + (ev.usage.cache_creation_input_tokens || 0)) > 0) {
              // W6:message_delta 携带该次 API 调用的最终 usage(官方 statusline 同款
              // 时机)。工具循环的每次调用结束即刷新徽章,不必等整轮 result。
              setLiveContextUsage({ ...ev.usage, _ts: Date.now() });
            } else if (ev.type === 'content_block_start') {
              const cb = ev.content_block || {};
              if (cb.type === 'text') {
                const orderIdx = orderedBlocks.length;
                orderedBlocks.push({ type: 'text', content: '' });
                blocks[ev.index] = { type: 'text', orderIdx };
                setStreamingBlocks([...orderedBlocks]);
              } else if (cb.type === 'thinking') {
                const orderIdx = orderedBlocks.length;
                orderedBlocks.push({ type: 'thinking', content: '' });
                blocks[ev.index] = { type: 'thinking', orderIdx };
                setStreamingBlocks([...orderedBlocks]);
              } else if (cb.type === 'tool_use') {
                const orderIdx = orderedBlocks.length;
                const newTc = { id: cb.id, name: cb.name, input: {}, result: null };
                orderedBlocks.push({ type: 'tool_use', toolCall: newTc });
                blocks[ev.index] = { type: 'tool_use', toolId: cb.id, name: cb.name, jsonBuf: '', orderIdx };
                currentToolCalls.push(newTc);
                setStreamingToolCalls([...currentToolCalls]);
                setStreamingBlocks([...orderedBlocks]);
                if (cb.name === 'Task' || cb.name === 'Agent') {
                  store.upsertAgent(cb.id, {
                    name: cb.name,
                    description: '',
                    status: 'starting',
                    startedAt: Date.now(),
                    sessionId: streamOwnerSid(),  // #9 归属会话(本流归属,不读当前 pane)
                  });
                }
              }
            } else if (ev.type === 'content_block_delta') {
              const block = blocks[ev.index];
              const delta = ev.delta || {};
              if (!block) continue;
              if (delta.type === 'text_delta' && block.type === 'text') {
                accumulatedText += delta.text || '';
                if (block.orderIdx != null && orderedBlocks[block.orderIdx]) {
                  orderedBlocks[block.orderIdx] = {
                    ...orderedBlocks[block.orderIdx],
                    content: orderedBlocks[block.orderIdx].content + (delta.text || ''),
                  };
                  setStreamingBlocks([...orderedBlocks]);
                }
                setStreamingText(accumulatedText);
              } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
                accumulatedThinking += delta.thinking || '';
                if (block.orderIdx != null && orderedBlocks[block.orderIdx]) {
                  orderedBlocks[block.orderIdx] = {
                    ...orderedBlocks[block.orderIdx],
                    content: orderedBlocks[block.orderIdx].content + (delta.thinking || ''),
                  };
                  setStreamingBlocks([...orderedBlocks]);
                }
                setStreamingThinking(accumulatedThinking);
              } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
                block.jsonBuf += delta.partial_json || '';
                try {
                  const parsed = JSON.parse(block.jsonBuf);
                  const idx = currentToolCalls.findIndex((tc) => tc.id === block.toolId);
                  if (idx !== -1) {
                    currentToolCalls[idx] = { ...currentToolCalls[idx], input: parsed };
                    setStreamingToolCalls([...currentToolCalls]);
                  }
                  if (block.orderIdx != null && orderedBlocks[block.orderIdx]) {
                    orderedBlocks[block.orderIdx] = {
                      ...orderedBlocks[block.orderIdx],
                      toolCall: { ...orderedBlocks[block.orderIdx].toolCall, input: parsed },
                    };
                    setStreamingBlocks([...orderedBlocks]);
                  }
                  if ((block.name === 'Task' || block.name === 'Agent') && parsed) {
                    store.upsertAgent(block.toolId, {
                      name: parsed.subagent_type || parsed.agent || parsed.name || block.name,
                      // 可寻址实例名(SendMessage({to}) 用的那个)单独存一份:上面的 .name 会被
                      // subagent_type 抢占,显示真名必须用这份未被抢占的。
                      teammateName: parsed.name || null,
                      description: parsed.description || parsed.prompt?.slice(0, 80) || '',
                      status: 'working',
                      prompt: parsed.prompt || '',  // #9 子代理派发 prompt
                      sessionId: streamOwnerSid(),
                    });
                  }
                } catch {}
              }
            }
            continue;
          }

          // Snapshot events (non-partial mode, or final reconciliation):
          // when --include-partial-messages is on, the CLI still emits a final
          // `assistant` message after the deltas. Use it to backfill anything
          // we might have missed (e.g. tool_use input that didn't stream cleanly).
          if (event.type === 'assistant' && event.message?.content) {
            // P2: 子代理的整条 assistant 消息(parent_tool_use_id 标记)分流到 activeAgents,
            // 不进主回合气泡。顺带记录该子代理实际使用的模型(message.model)——之前这条
            // 路径完全没分流,model 徽章在"整条消息到达"的 provider 下永远不显示。
            if (event.parent_tool_use_id) {
              const aStore = useStore.getState();
              const aid = event.parent_tool_use_id;
              reviveAgentIfTerminal(aStore, aid); // 唤醒后整条 assistant 消息到达,终态则复活为运行中
              if (event.message.model) aStore.upsertAgent(aid, { model: event.message.model });
              for (const block of (Array.isArray(event.message.content) ? event.message.content : [])) {
                if (block.type === 'text' && block.text) aStore.appendAgentText(aid, block.text);
                else if (block.type === 'thinking' && block.thinking) aStore.appendAgentThinking(aid, block.thinking);
                else if (block.type === 'tool_use') {
                  aStore.appendAgentTool(aid, { id: block.id, name: block.name, input: block.input || {}, result: null });
                  // D7:子代理内部起的 Bash run_in_background 此前只在顶层分支登记 → 进程管理区
                  // 看不见、不能 tail、不能停(服务端却把它记为 shell 刻意保留 = 看不见也停不掉的
                  // 常驻进程)。同款登记,附 agentId 标注归属。
                  if (block.name === 'Bash' && block.input?.run_in_background === true) {
                    aStore.upsertBgTask(block.id, {
                      command: block.input.command || '',
                      description: block.input.description || '',
                      status: 'running',
                      startedAt: Date.now(),
                      sessionId: streamOwnerSid(),
                      agentId: aid,
                    });
                  }
                }
              }
              continue;
            }
            for (const block of (Array.isArray(event.message.content) ? event.message.content : [])) {
              if (block.type === 'text') {
                // Only replace if we haven't been streaming this block already.
                if (!accumulatedText) {
                  accumulatedText = block.text;
                  setStreamingText(accumulatedText);
                }
              }
              if (block.type === 'thinking') {
                if (!accumulatedThinking) {
                  accumulatedThinking = block.thinking || '';
                  setStreamingThinking(accumulatedThinking);
                }
              }
              if (block.type === 'tool_use') {
                const idx = currentToolCalls.findIndex((tc) => tc.id === block.id);
                if (idx === -1) {
                  currentToolCalls.push({ id: block.id, name: block.name, input: block.input, result: null });
                } else {
                  // Reconcile final tool input from the snapshot.
                  currentToolCalls[idx] = { ...currentToolCalls[idx], input: block.input };
                }
                setStreamingToolCalls([...currentToolCalls]);
                // 子代理捕获(关键修复):有些 provider(mimo 等)不发 partial stream_event,
                // Task 工具只以整条 assistant 消息到达,于是 stream_event 路径里的 upsertAgent
                // 永不触发 → activeAgents 为空 → 监控里"看不见子代理活动"。这里在整条消息
                // 路径也为 Task 注册子代理,subagent 的最终输出由后面的 tool_result 补上。
                if (block.name === 'Task' || block.name === 'Agent') {
                  const inp = block.input || {};
                  useStore.getState().upsertAgent(block.id, {
                    name: inp.subagent_type || inp.agent || inp.name || block.name,
                    // 同上,可寻址实例名(SendMessage 寻址用)单独存,不被 subagent_type 抢占。
                    teammateName: inp.name || null,
                    description: inp.description || (inp.prompt ? String(inp.prompt).slice(0, 80) : ''),
                    prompt: inp.prompt || '',
                    status: 'working',
                    startedAt: Date.now(),
                    sessionId: streamOwnerSid(),
                  });
                }
                // 后台任务:Bash run_in_background:true(python 等长进程也归此类)。实时输出
                // 不进 stream,落盘到 outputPath(由后续 tool_result 文本给出 shellId+路径)。
                if (block.name === 'Bash' && block.input?.run_in_background === true) {
                  useStore.getState().upsertBgTask(block.id, {
                    command: block.input.command || '',
                    description: block.input.description || '',
                    status: 'running',
                    startedAt: Date.now(),
                    sessionId: streamOwnerSid(),
                  });
                }
              }
            }
            if (event.message.model) setStreamingModel(event.message.model);
          }
          if (event.type === 'user' && event.message?.content) {
            // U7:带 parent_tool_use_id 的 user 事件是【子代理内部工具】的 tool_result。
            // 之前这条分支不存在 → 子工具的 result 永远是 null → TaskCard/SubagentView
            // 里的子工具永远转圈(即使监控显示子代理已完成)。路由到 agent store 配对。
            if (event.parent_tool_use_id) {
              const aStore = useStore.getState();
              for (const block of (Array.isArray(event.message.content) ? event.message.content : [])) {
                if (block.type === 'tool_result') {
                  aStore.updateAgentTool(event.parent_tool_use_id, block.tool_use_id, {
                    result: {
                      toolUseId: block.tool_use_id,
                      content: extractToolResultText(block.content),
                      isError: block.is_error || false,
                    },
                  });
                  // D7:子代理内部后台任务的 shellId / .output 路径也在这条回执里(与顶层同格式)。
                  // 不取就没有 outputPath → 监控区的 bgList 过滤掉它 → 依旧看不见也停不掉。
                  if (aStore.bgTasks[block.tool_use_id]) {
                    const txt = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                    const idm = txt.match(/ID:\s*([A-Za-z0-9_-]+)/);
                    const pm = txt.match(/written to:\s*(.+?\.output)/);
                    aStore.upsertBgTask(block.tool_use_id, {
                      ...(idm ? { shellId: idm[1] } : {}),
                      ...(pm ? { outputPath: pm[1] } : {}),
                    });
                  }
                }
              }
              continue;
            }
            for (const block of (Array.isArray(event.message.content) ? event.message.content : [])) {
              if (block.type === 'tool_result') {
                // CG-2 兜底:本回合先委派了子代理 → SDK 的 canUseTool 通道被打穿 → 之后的
                // ExitPlanMode/AskUserQuestion/授权请求会报 "Tool permission request failed:
                // Stream closed"(卡片弹不出)。给一条清晰温和提示,免得用户对着正文里
                // 一串报错发懵。每轮只提示一次。
                if (block.is_error && !streamClosedNoticed) {
                  const _et = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
                  if (/permission request failed[\s\S]*stream closed/i.test(_et)) {
                    streamClosedNoticed = true;
                    setProviderSwitchNotice({ text: '本回合先委派了子代理,SDK 的授权弹窗通道被打断(已知限制),计划/提问卡片这次弹不出。新开一条消息重做该操作即可正常。' });
                  }
                }
                // 子代理"勾号过早"根治(v0.2.210 重构为 task_notification 权威信号):这条 tool_result
                // 是"已派发"提前回执(实测开工 124ms 就返回,与子代理内容 flush 竞态)——【不标 done】,
                // 只记结果文本 + resultSeen(供展示与错误路径判定),状态保持 working。真正标 done 由
                // task_notification(带 tool_use_id、恒在子代理真正结束那刻,见 system 事件段)精确触发;
                // 顶层 result 作粗粒度兜底(covers 不发 task_notification 的第三方 provider)。绝不回翻。
                const store = useStore.getState();
                if (store.activeAgents[block.tool_use_id]) {
                  store.upsertAgent(block.tool_use_id, {
                    result: extractToolResultText(block.content),
                    resultSeen: true,
                    resultIsError: !!block.is_error,
                  });
                }
                // 后台任务:result 文本含 "ID: <shellId>" 和 "written to: <path>.output"。
                // 提取后供 AgentMonitorPanel 直接 tail 那个文件(优先用返回的绝对路径原文)。
                if (store.bgTasks[block.tool_use_id]) {
                  const txt = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                  const idm = txt.match(/ID:\s*([A-Za-z0-9_-]+)/);
                  // \S+? 遇第一个空格即停 → Windows 含空格用户名(C:\Users\John Doe\...)路径被截断 →
                  // 拿不到 outputPath → 后台任务卡"运行中"。改非贪婪匹配到首个 .output,允许路径含空格。
                  const pm = txt.match(/written to:\s*(.+?\.output)/);
                  store.upsertBgTask(block.tool_use_id, {
                    ...(idm ? { shellId: idm[1] } : {}),
                    ...(pm ? { outputPath: pm[1] } : {}),
                  });
                }
                // Also patch the ordered blocks list so the in-place card shows result.
                const resultPayload = {
                  toolUseId: block.tool_use_id,
                  content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                  isError: block.is_error || false,
                };
                orderedBlocks = orderedBlocks.map((b) =>
                  b.type === 'tool_use' && b.toolCall?.id === block.tool_use_id
                    ? { ...b, toolCall: { ...b.toolCall, result: resultPayload } }
                    : b
                );
                setStreamingBlocks([...orderedBlocks]);
                const idx = currentToolCalls.findIndex((tc) => tc.id === block.tool_use_id);
                if (idx !== -1) {
                  currentToolCalls[idx] = { ...currentToolCalls[idx], result: {
                    toolUseId: block.tool_use_id,
                    content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                    isError: block.is_error || false,
                  }};
                  setStreamingToolCalls([...currentToolCalls]);
                }
              }
            }
          }
          // #13 看门狗提示:服务端 stall-watchdog 收尾回合时发的中性系统提示(上游长时间
          // 无输出被主动收尾)。渲染成普通提示 turn(⏸ 前缀),不走红色错误分支不吓人;
          // 随后的 done 事件正常收尾本轮。
          if (event.type === 'stall_notice') {
            setChatMessages((prev) => [...prev, {
              uuid: 'stall-' + Date.now(),
              type: 'turn',
              timestamp: new Date().toISOString(),
              model: streamingModel,
              text: [`⏸ ${event.text || '上游长时间无输出,本回合已自动收尾。'}`],
              thinking: [], toolCalls: [],
              blocks: [{ type: 'text', content: `⏸ ${event.text || '上游长时间无输出,本回合已自动收尾。'}` }],
              usage: null,
            }]);
            continue;
          }
          // Surface CLI-side errors that previously got silently dropped:
          //   - type:"error"  (our server's stderr/spawn fail wrapper)
          //   - type:"result" with is_error:true (CLI's own error envelope,
          //     e.g. "No conversation found with session ID: ...")
          if (event.type === 'error' || (event.type === 'result' && (event.is_error || /^error_/.test(event.subtype || '')))) {
            // P1-1:服务端把 CLI stdout 里任意非 JSON 行(banner/调试/ANSI 噪声)包成
            // {type:'error',error:'bad-line'}。这类是良性噪声,绝不能当致命错误弹❌+break
            // 中止整轮(否则后续有效事件含 result 全丢,进程其实还在跑)。直接跳过。
            if (event.error === 'bad-line') continue;
            // 花费上限(设置→对话花费上限):进程累计花费达到 maxBudgetUsd 时 CLI 返回
            // error_max_budget_usd。给出明确提示而非通用报错;不自动重试(重试会立即再超)。
            if (event.subtype === 'error_max_budget_usd') {
              const _cap = useStore.getState().maxBudgetUsd;
              setChatMessages((prev) => [...prev, {
                uuid: 'chat-budget-' + Date.now(),
                type: 'turn',
                timestamp: new Date().toISOString(),
                model: streamingModel,
                text: [`已达到设置的对话花费上限${_cap ? `($${_cap})` : ''},本轮已停止。若需继续,请在 通用 → 会话 里调高或清除「对话花费上限」后重发。`],
                thinking: [], toolCalls: [],
                blocks: [{ type: 'text', content: `已达到设置的对话花费上限${_cap ? `($${_cap})` : ''},本轮已停止。` }],
                usage: null,
              }]);
              sawError = true;
              break;
            }
            const msg = (event.errors && event.errors.join('; '))
              || event.error
              // API 错误(如签名失效)经 result 事件返回:subtype 是误导性的 "success",
              // 真正的报错文案在 event.result(伴随 is_error:true / api_error_status:400)。
              // 必须纳入提取,否则下面的签名/会话自愈永远匹配不到(只会拿到 "success")。
              || (typeof event.result === 'string' ? event.result : '')
              || event.subtype
              || 'CLI 报错（无消息体）';
            // Reactive provider-switch recovery: a resumed session whose history
            // carries thinking blocks signed by a DIFFERENT backend (e.g. an old
            // mimo session reopened under official, with no recorded provider for
            // the predictive strip) returns "400 Invalid signature in thinking
            // block" here. Strip the thinking blocks and resend ONCE — the
            // signatureRetry flag guards against an infinite loop if it persists.
            // 订阅未开 1M 按量额度:官方订阅带 [1m] 后缀的请求被 API 拒
            // ("Usage credits required for 1M context",1M 是按量计费 beta 不含在订阅内)。
            // [1m] 钉在会话 pin 里持久生效,不剥则之后每条消息都失败 → 剥掉 pin/全局的
            // [1m] 切回标准上下文并自动重发一次(oneMRetry 防循环),同 /compact 3606 与
            // 签名自愈同款套路。要用 1M 的用户按提示开 usage credits 后再开 1M 开关即可。
            // 两种文案同一处置(2026-07 实测官方订阅):sonnet[1m]→"Usage credits required
            // for 1M context"(1M 按量计费);haiku[1m]→"The long context beta is not yet
            // available for this subscription"(不支持 1M)。opus-4.8/fable-5 的 [1m] 订阅
            // 内可用(/context 实测真 1M 窗口),不会走到这。
            if (/usage credits required for 1m context|long context beta is not (yet )?available/i.test(msg) && !opts.oneMRetry && prompt) {
              const _st = useStore.getState();
              const _base = String(currentModel || '').replace(/\[1m\]/i, '');
              if (_base) _st.setModelFor(sessionQueueKey, _base);
              if (/\[1m\]/i.test(_st.currentModel || '')) _st.setModel(String(_st.currentModel).replace(/\[1m\]/i, ''));
              setProviderSwitchNotice({ text: '订阅未开通 1M 上下文按量额度（usage credits），已自动切回标准上下文并重发本条。如需 1M：先到 claude.ai/settings/usage 开启 usage credits，再打开模型菜单的 1M 开关。' });
              setTimeout(() => handleSendRef.current?.(prompt, { ...opts, oneMRetry: true }), 80);
              accumulatedText = ''; accumulatedThinking = ''; currentToolCalls = [];
              sawError = true;
              break;
            }
            if (/invalid signature in thinking/i.test(msg) && !opts.signatureRetry && prompt) {
              const _s = getLocalSession();
              if (_s?.sessionId && _s?.projectHash) {
                try {
                  await fetch(`/api/sessions/${_s.sessionId}/strip-thinking`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectHash: _s.projectHash }),
                  });
                  await fetchMessagesForTab(_s.sessionId, _s.projectHash, { silent: true });
                } catch {}
                setProviderSwitchNotice({ text: '历史思考块签名不被当前 provider 接受，已自动剥离并重发本条。' });
                // 透传原 opts(工具重做带的 appendSystemPrompt/hiddenUserMessage 必须保留),
                // 只追加守卫位防无限重试。
                setTimeout(() => handleSendRef.current?.(prompt, { ...opts, signatureRetry: true }), 80);
                // 本次失败的产物正是 "API Error: ...Invalid signature..." 文案,它也作为
                // assistant text 落进了 accumulatedText。清空,否则循环结束后会被当成正常
                // 回复气泡再插一条,用户就会看到那条报错(即用户报告的现象)。
                accumulatedText = ''; accumulatedThinking = ''; currentToolCalls = [];
                sawError = true;
                break;
              }
            }
            // 会话 jsonl 已失效/被删(回退清空、外部删除等)→ CLI 报 "No conversation
            // found"。自动转 draft + 重发本条:下次不带 --resume = 在同项目新建会话,
            // 用户不必手动处理僵尸会话。freshRetry 守卫防无限循环。
            if (/No conversation found/i.test(msg) && !opts.freshRetry && prompt) {
              const _s = getLocalSession();
              if (_s?.sessionId) {
                const draftKey = `draft-${_s.projectHash || 'none'}`;
                useStore.getState().migrateSessionKey?.(_s.sessionId, draftKey);
                setSelectedSession({ ..._s, sessionId: null, draft: true, draftId: newDraftId() });
              }
              setProviderSwitchNotice({ text: '原会话历史已失效，已自动新建会话并重发本条。' });
              setTimeout(() => handleSendRef.current?.(prompt, { ...opts, freshRetry: true }), 80);
              accumulatedText = ''; accumulatedThinking = ''; currentToolCalls = [];
              sawError = true;
              break;
            }
            // P2.2 auto 档运行时回退(T3 第二层门控):静态过滤放过但账户/模型/CLI 实际
            // 不支持 auto → 报错。记 auto-unavailable(provider+model 键,本地存储,换
            // provider/模型自动重试)→ 该组合下「自动」项隐藏;本会话切回逐步确认并
            // 自动重发本条(autoRetry 防循环)。
            if (useStore.getState().getPermissionModeFor(sessionQueueKey) === 'auto' && !opts.autoRetry && prompt
              && /auto/i.test(msg) && /support|avail|invalid|eligib|permission|denied|mode/i.test(msg)) {
              const _st = useStore.getState();
              markAutoUnavailable(_st.currentProvider?.providerHint || 'anthropic',
                _st.modelBySession[sessionQueueKey] || _st.currentModel || '');
              _st.setPermissionMode('default', sessionQueueKey);
              setProviderSwitchNotice({ text: '当前模型 / 账户不支持「自动」权限档，已回退「逐步确认」并重发本条。' });
              setTimeout(() => handleSendRef.current?.(prompt, { ...opts, autoRetry: true }), 80);
              accumulatedText = ''; accumulatedThinking = ''; currentToolCalls = [];
              sawError = true;
              break;
            }
            // G4:上下文超窗 → 413 / prompt too long。/compact 也会因此失败(摘要请求本身超限)。
            // 不自动重试,弹引导横幅让用户选恢复方式。
            if (/\b413\b|payload too large|prompt is too long|too many tokens|input (?:is )?too long|exceed[a-z ]*context|context[a-z ]*exceed|maximum context/i.test(msg)) {
              // 串扰#8:横幅打归属 key(流的 owner,draft→init 后已升级为真 sid),渲染
              // 按 ownerKey===sessionQueueKey 门控 —— 否则 set 后只有手点才清,A 的超窗
              // 横幅持久挂在 B 下,内嵌按钮还作用于 B(语义错位)。
              // 从报错抽真实窗口(如 kimi "prompt is too long: 131072 tokens > 65536 maximum"):
              // 小窗第三方(64k 等)下 CLI 仍按自认 200k 估算,自动压缩永不提前触发 → 回合中途
              // 超限;横幅要把真实窗口亮给用户并给对建议(压缩摘要请求自身也会超小窗,难自救)。
              const _lim = /(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)\s*maximum/i.exec(msg);
              setCtxOverflow({
                has1m: /\[1m\]/i.test(currentModel || ''), wasCompact: isCompact, ownerKey: streamOwnerKeyRef.current,
                used: _lim ? Number(_lim[1].replace(/,/g, '')) : null,
                limit: _lim ? Number(_lim[2].replace(/,/g, '')) : null,
              });
              accumulatedText = ''; accumulatedThinking = ''; currentToolCalls = [];
              sawError = true;
              break;
            }
            // 鉴权类报错(401 / api key 无效等)大概率是 provider 的 key 配错/过期,
            // 给错误块挂「检查 Provider 设置」动作(渲染在 visibleChat 的 turn 分支)。
            const isAuthError = /\b401\b|unauthorized|authenticat|api[ -_]?key|x-api-key/i.test(msg);
            // 低危#4:1M 推断被拒的显式提示。6bfc207 对「单次 ctxUsage 超名义窗口」的
            // 会话推断补 [1m] 发送;账户 1M 资格不足时该请求被 API 拒,落到这里显示裸
            // 报错。上方 5127 已自动切回捕获两种已知文案;其余含 1M/长上下文关键词的
            // 拒绝(第三方/新文案)补一行引导:关掉模型弹层的 1M 开关再重试。纯文案层,
            // 不动重试逻辑。
            // (?<![$￥]) 排除 "$1m budget" 这类金额文案的误命中(判官次要项)
            const isOneMReject = /(?<![$￥])\b1m\b|\[1m\]|long context|context length|1000000|1,000,000/i.test(msg);
            const oneMHint = isOneMReject
              ? '\n\n> 该会话被识别为 1M 上下文；若账户不支持,请在模型弹层关闭 1M 后重试。'
              : '';
            setChatMessages((prev) => [...prev, {
              uuid: 'chat-error-' + Date.now(),
              type: 'turn',
              timestamp: new Date().toISOString(),
              model: streamingModel,
              text: [`❌ **${msg}**\n\n常见原因：\n- session 不在当前 cwd 对应的项目目录 → 新建会话\n- jsonl 被 trim 后损坏 → 新建会话\n- CLI 版本异常 → 终端跑 \`claude --help\` 验证${oneMHint}`],
              thinking: [],
              toolCalls: [],
              blocks: [{ type: 'text', content: `❌ **${msg}**${oneMHint}` }],
              usage: null,
              ...(isAuthError ? { errorAction: 'provider' } : {}),
            }]);
            sawError = true;
            break;
          }
          // 成本/落库用本轮 result.usage,但**不写徽章 live usage**:result.usage 是
          // CLI「整轮 N 次底层 API 调用」的累加口径(cache_read 被加 N 遍),写进徽章会让
          // 占用瞬间虚高爆表(实测第三方可冲到 500k/200k)→ 误触发 auto-compact。徽章的
          // 「当前上下文占用」应取单次调用口径,已由 message_start/message_delta(2962-2975)
          // 实时提供(末次调用 = 当前真实上下文)。compact 回合的 usage 也是旧大上下文,同样不取。
          if (event.type === 'result' && !isCompact && event.usage) {
            resultUsage = event.usage;
          }
          // 输入预测(A):result 之后 server 留 3s 等待窗收 prompt_suggestion,期间流
          // 还没结束。如实标注在等什么(建议到达/超时收尾/中间 result 后新内容都会清)。
          if (event.type === 'result' && !event.is_error && suggestOnClient && !isCompact && !isClear) {
            setLiveStatus({ text: '正在预测下一步输入…' });
          }
          // Z1:CLI 在 result 事件上报本轮实际成本 total_cost_usd,比单价表估算
          // 权威。compact 回合除外(其成本属压缩开销,且 usage 是压缩前旧上下文)。
          if (event.type === 'result' && !isCompact && typeof event.total_cost_usd === 'number' && event.total_cost_usd > 0) {
            resultCostUsd = event.total_cost_usd;
          }
          // 粗粒度兜底收口:主收口是 task_notification(精确、按 tool_use_id)。但不发 task_notification
          // 的第三方 provider 靠这里——顶层成功 result 把本回合还在跑的 Task/Agent 一次性标 done。
          // ⚠️【taskManaged 的 agent(收到过 task_started)绝不在此收尾】(v0.2.214 根治用户实报"子代理
          // 还在跑却显示已完成"):后台化子代理(run_in_background,如深度调研)派发后顶层 result 先返回、
          // 子代理仍在后台跑,它真正的 task_notification 要几分钟后(甚至跨回合)才到——若在这里被顶层
          // result 兜底标 done 就是【正在工作却显示已完成】。凡 taskManaged 交给 task_notification 权威
          // 收尾(哪怕迟来),兜底只兜"根本不发 task 事件的第三方 provider"(其 agent 无 taskManaged)。
          if (event.type === 'result' && !event.is_error && !isCompact && !event.parent_tool_use_id) {
            const _st = useStore.getState();
            for (const tc of currentToolCalls) {
              if (!tc || (tc.name !== 'Task' && tc.name !== 'Agent')) continue;
              const _ag = _st.activeAgents[tc.id];
              if (!_ag) continue;
              if (_ag.taskManaged) continue; // 有 task_notification 收尾 → 等它自己(后台化子代理迟来),别兜底误标
              if (['working', 'streaming', 'running', 'starting'].includes(_ag.status)) finalizeAgent(_st, tc.id, 'completed');
            }
          }
          if (event.type === 'done') break;
        }
        // reattach:每读到一批 SSE 行就考虑刷一次历史(内部节流,非 reattach 直接返回)。
        refreshHistIfDue(false);
      }
      // 回合结束(流关闭/done):立刻收尾刷一次,不等下一个节流窗,也不等 finally 的落盘轮询。
      refreshHistIfDue(true);

      if (accumulatedText || accumulatedThinking || currentToolCalls.length > 0) {
        producedReply = true;
        // reattach 不 push 本地副本:accumulatedText 只是 detach 之后被重放的那半截,
        // 与历史卡里的完整回合重叠 —— push 了会在 finalize 清本地副本前闪一帧双气泡。
        // producedReply 仍置 true,finalize 的落盘轮询/清理语义原样不变。
        if (!reattachPid) setChatMessages((prev) => [...prev, {
          uuid: 'chat-assistant-' + Date.now(), type: 'turn',
          timestamp: new Date().toISOString(), model: streamingModel,
          text: accumulatedText ? [accumulatedText] : [],
          thinking: accumulatedThinking ? [accumulatedThinking] : [],
          toolCalls: currentToolCalls.map((tc) => ({ ...tc, category: tc.category || 'call' })),
          // The canonical ordered view used by TurnBubble for in-order rendering.
          blocks: orderedBlocks,
          usage: resultUsage,
          costUsd: resultCostUsd,
        }]);
        // M3(Q9)→T2 重构:完成悬浮提醒改由服务端 WS 'turn-complete' 广播驱动
        // (见 useWebSocket)。这里的流闭包在用户切走会话时会被切会话 effect
        // abort,完成代码根本执行不到 —— 挂在这里的 toast 从未生效过。
      } else if ((isClear || isCompact) && !sawError && !reattachPid) {
        // /clear 与 /compact 在 headless 下都返回空 result(无 assistant 文本),不是
        // 错误:/clear 清空、/compact 只发 compact_boundary。给出明确提示,而不是误报
        // "provider 没有返回任何内容"(#4 / U8)。
        producedReply = true;
        setLiveContextUsage(null);
        const okText = isClear ? '✅ 会话已清空，请发送新的消息。' : '✅ 上下文已压缩，可继续对话。';
        setChatMessages((prev) => [...prev, {
          uuid: 'chat-cleared-' + Date.now(),
          type: 'turn',
          timestamp: new Date().toISOString(),
          model: streamingModel,
          text: [okText],
          thinking: [],
          toolCalls: [],
          blocks: [{ type: 'text', content: okText }],
          usage: null,
        }]);
      } else if (!sawError && !reattachPid) {
        // Stream ended with NOTHING — no text, no tools, no error envelope.
        // Long first-token latency on big sessions is handled by the server's SSE
        // heartbeat (keeps the connection alive), so reaching here means the turn
        // genuinely produced nothing — context full / auth / bad model.
        //
        // EXCLUDE reattaches (`reattachPid`): the background-pid poll keeps a
        // just-finished proc flagged "stoppable" through its 60s grace window,
        // so after a normal reply the auto-reattach can re-open that finished
        // stream, get nothing left to replay, and land here. An empty REATTACH
        // is "nothing left to stream" (the reply is already in jsonl), NOT
        // "provider returned nothing" — warning there is a false positive (the
        // ⚠️ that intermittently appeared at the end of a good reply).
        const msg = 'provider 没有返回任何内容。常见原因：① 会话上下文已满（看顶部 token 占比，接近/超过上限时上游会拒绝整个请求 → 用 /compact 压缩或新建会话）；② 认证失败 401 或模型不存在（检查 key 与模型，或切换其它 provider）。';
        setChatMessages((prev) => [...prev, {
          uuid: 'chat-empty-' + Date.now(),
          type: 'turn',
          timestamp: new Date().toISOString(),
          model: streamingModel,
          text: [`⚠️ ${msg}`],
          thinking: [],
          toolCalls: [],
          blocks: [{ type: 'text', content: `⚠️ ${msg}` }],
          usage: null,
        }]);
      }
    } catch (err) {
      // A dropped SSE connection (network blip, phone sleep/lock, wifi↔cellular
      // handoff) surfaces as a TypeError — Safari: "Load failed", Chrome: "Failed
      // to fetch". The CLI keeps running and writing its jsonl in the background,
      // and backgroundPid auto-reattach resumes the live stream — so the red ❌
      // "load failed" that only cleared on refresh was misleading noise. Stay
      // silent for network drops (the finally pulls the persisted jsonl and
      // reattach takes over); only render a hard error for genuine failures.
      const isNetworkDrop = err instanceof TypeError
        && /load failed|failed to fetch|network|connection/i.test(err.message || '');
      // 迟到的 catch 照常保留半截回复/错误气泡,但打 ownerKey(归属发起时的会话),渲染层
      // visibleChat 按 ownerKey 门控——孤儿只在它归属的会话显示。此前 v0.2.190 用 stillHere
      // 抑制 push 修 fable ② 是方向错了:切走场景不 push=半截回复(思考/工具调用,未落盘)
      // 永久丢失,切回 A 只剩 connecting 等新 delta(用户实报);且草稿豁免仍让 A 的孤儿在
      // 新建草稿 C 里串显。归属标记既保数据又断串扰,与 btw 的 ownerKey 同一机制。
      if (err.name === 'AbortError') {
        // 仅【真杀进程】(POST /stop:停止/加速/编辑重发)才让 finally 收后台化子代理为 stopped;
        // 后台化(backgroundify)与切会话(detach)只 abort 客户端流、进程继续跑 → killedRef=false →
        // taskManaged 子代理留 working 等它自己的 task_notification(fable 复审 P1 根治)。
        if (killedRef.current) turnAborted = true;
        // 用户主动「停止」:把已经流式显示的文本/思考/工具调用保留成一条气泡(标记
        // 已停止),而不是连同用户消息一起丢弃——以前这里静默清空,用户辛苦看到的半截
        // 回复+工具调用全没了,只剩刚发的消息(#6)。producedReply=true 让 finally 的
        // 落盘轮询把它当正常产出处理(jsonl 若已写入半截会 refetch 覆盖,否则保留本地副本)。
        if (accumulatedText || accumulatedThinking || currentToolCalls.length > 0) {
          producedReply = true;
          // 停止时给未回执的普通工具补合成终态,Skill/Bash/Read 等卡片不再永久转圈
          // (Task/Agent 状态由 activeAgents 驱动,合成 result 对其无害)。gate=turnAborted。
          // ⚠️ 必须同步回写 blocks(fable 判官阻断项):官方 provider 恒发 partial →
          // tool_use 进 orderedBlocks → TurnBubble 有 blocks 时只渲染 blocks,只 finalize
          // toolCalls 的话主路径卡片仍拿 result:null 永久转圈。
          const finalizedCalls = finalizePendingToolCalls(currentToolCalls, turnAborted);
          setChatMessages((prev) => [...prev, {
            uuid: 'chat-stopped-' + Date.now(), type: 'turn',
            ownerKey: streamSid || sessionQueueKey,
            timestamp: new Date().toISOString(), model: streamingModel,
            text: accumulatedText ? [accumulatedText] : [],
            thinking: accumulatedThinking ? [accumulatedThinking] : [],
            toolCalls: finalizedCalls,
            blocks: applyFinalizedToBlocks(orderedBlocks, finalizedCalls),
            usage: null,
            interrupted: true,
          }]);
        }
      } else if (!isNetworkDrop) {
        // P2.2 auto 档 spawn 失败回退:旧 SDK/CLI 不接受 permissionMode:'auto' 时
        // POST /chat 直接 500(query() failed)落到这里 —— 同 result 错误路径处置。
        if (useStore.getState().getPermissionModeFor(sessionQueueKey) === 'auto' && !opts.autoRetry && prompt
          && /auto|permission/i.test(String(err.message || ''))) {
          const _st = useStore.getState();
          markAutoUnavailable(_st.currentProvider?.providerHint || 'anthropic',
            _st.modelBySession[sessionQueueKey] || _st.currentModel || '');
          _st.setPermissionMode('default', sessionQueueKey);
          setProviderSwitchNotice({ text: '当前 CLI / 账户不支持「自动」权限档，已回退「逐步确认」并重发本条。' });
          setTimeout(() => handleSendRef.current?.(prompt, { ...opts, autoRetry: true }), 80);
        } else {
        console.error('Chat error:', err);
        // Render the failure as a visible turn so the user isn't left staring at
        // a frozen "connecting" with no explanation (e.g. invalid project dir).
        setChatMessages((prev) => [...prev, {
          uuid: 'chat-error-' + Date.now(),
          type: 'turn',
          ownerKey: streamSid || sessionQueueKey,
          timestamp: new Date().toISOString(),
          model: null,
          text: [`❌ ${err.message || '发送失败'}`],
          thinking: [],
          toolCalls: [],
          blocks: [{ type: 'text', content: `❌ ${err.message || '发送失败'}` }],
          usage: null,
        }]);
        }
      }
    } finally {
      // C1:整个收尾体裹一层 try/finally,末尾无条件把 finalizeInFlightRef 减回去 —— 收尾
      // 中途抛错(setState/shiftMessage 等未被局部 catch 的调用)时计数若不减,poll 的排队
      // 排空就永久哑掉。下面的收尾体【沿用原缩进不动】:重排 280 行只为对齐空白,既会淹没
      // 审查视线,也会碰到明令不许动的 F1 drain 本体(:5946-5956)。
      try {
      // 停止/断流兜底:本回合派出的子代理若仍在运行态(中断后 tool_result 永不到达,
      // 状态没人更新),统一标 stopped —— 否则卡片/监控永远转圈"运行中"(用户实报
      // "停止后子代理还在跑"的 UI 侧成因;进程侧由 stop 端点的 abort 兜底真杀)。
      // 扫 currentToolCalls 而非 orderedBlocks(fable 审计):不发 partial stream_event
      // 的 provider(mimo 等)Task 只走整条 assistant 消息路径、reattach 后 orderedBlocks
      // 也拿不到断连前的 Task —— currentToolCalls 是两路径的并集。只动本流出现过的
      // Task/Agent id,不误伤其他 pane;已被 task_notification/顶层 result 标终态的此处 no-op。
      try {
        const _st = useStore.getState();
        const _visited = new Set();
        for (const tc of currentToolCalls) {
          if (tc && (tc.name === 'Task' || tc.name === 'Agent') && _st.activeAgents[tc.id]) {
            // 【正常完成(非用户停止)时,taskManaged 的 agent 一律不在此收尾】(fable 审计 P0 根治):
            // finally 每回合结束都跑(done-break 也走这里,非仅停止)——后台化子代理派发后本回合正常
            // 结束,它还在后台跑、task_notification 几分钟后才到,若这里收尾就是"工作中却显示已完成"。
            // 有 task_notification 收尾的(taskManaged)交给它自己;仅【用户主动停止 turnAborted】时进程被
            // 杀,才把后台 agent 也收 stopped。不发 task 事件的第三方(无 taskManaged)照常兜底收尾。
            if (!turnAborted && _st.activeAgents[tc.id].taskManaged) continue;
            // finalizeAgent('stopped')级联:顶层 agent 若 resultSeen 标 done 否则 stopped,
            // 并顺 toolCalls 递归收尾嵌套子代理(未 resultSeen→stopped)——修"嵌套子代理停止后
            // 监控永久工作中"(fable 评估:嵌套 B 是独立 activeAgents 条目,不在 currentToolCalls)。
            finalizeAgent(_st, tc.id, 'stopped', _visited);
          }
        }
        // 前台停止的穷举兜底(调研钉死的唯一漏网入口):上面只遍历本回合 currentToolCalls
        // 树,不在树里的 activeAgents 条目(上一回合派的/reattach 后树重建丢失的)收不到
        // stopped → 监控页永久"工作中"。删会话/转后台/杀进程三个兄弟入口早已接
        // finalizeSessionAgents 穷举,唯独这里没接。turnAborted 仅真 POST /stop 时为 true
        // (killedRef),后台化/切会话不误伤;函数幂等且只碰 activeAgents,不动 bgTasks。
        // draft 阶段(未拿到真 sid)回落 ownerKey 的 draft-<hash> 键 —— 判官重要2 后 draft
        // 期派出的子代理条目 sessionId 即该键,只传真 sid 会扫不到。
        // 排除服务端本次保留的跨回合后台子代理(keptToolUseIds):它们没被 stopTask、进程还活着。
        const _fsid = streamSid || streamOwnerKeyRef.current;
        if (turnAborted && _fsid) {
          const _keptP = stopKeptRef.current;
          stopKeptRef.current = null;
          if (_keptP) _keptP.then((d) => finalizeSessionAgents(_fsid, 'stopped', d?.keptToolUseIds));
          else finalizeSessionAgents(_fsid); // hard 停止 / 无 /stop 响应可用 → 全量收尾(原行为)
        }
      } catch {}
      updateStreaming(false);
      setStreamingText('');
      setStreamingThinking('');
      setStreamingToolCalls([]);
      setStreamingBlocks([]);
      activeProcRef.current = null;
      abortRef.current = null;
      // 重做工具的转圈指示器兜底:重跑流结束(成功/报错/零内容)一律关掉,
      // 避免重跑没产出内容时 effect 不触发 → 指示器一直转。
      setRetryActiveUuid(null);
      setCompacting(false);
      setLiveStatus(null); // 等待状态(G):回合收尾一律清,不留残行
      // After the stream ends locally, hand the displayed history back to the
      // persisted jsonl. The catch: jsonl flushes the user prompt BEFORE the
      // assistant reply, and that flush races the stream's `result`. A single
      // fetch can catch jsonl mid-round (user written, assistant not) — and
      // because the render is a naive [...persisted, ...chatMessages] concat
      // with no dedup, clearing the local copies then leaves a gap where the
      // reply VANISHES until the next fetch, then REAPPEARS ("output disappears
      // then comes back like a refresh", worse on slow disks). So when we
      // actually produced a reply, poll briefly until the assistant turn has
      // landed in jsonl; only THEN clear local. Empty/errored turns (no jsonl
      // twin) skip the wait and keep their local ⚠️/❌ notice.
      // 归属敏感(判官盲审#1):finalize 必须收尾【发起这次流的会话】,不能读
      // getLocalSession() —— 流式期间用户已切到别的会话时,会把新会话当本流归属,
      // fetch/清空错会话的本地消息。streamSid > ownerKey(非 draft)> 当前 pane 兜底。
      // sid 与 projectHash 必须同源(判官重要#4):回落到当前会话的 sid 却仍用 owner 的
      // projectHash,会拿"当前 sid + 别的项目 ph"去轮询/拉历史 → 404 空转 12 次(~2.4s)。
      // 且旧代码有 `_sel?.sessionId && _sel?.projectHash` 双守卫,ph 为空整段跳过(空 ph
      // 打到服务端同样是空转),这里恢复。
      const _ok1 = streamOwnerKeyRef.current;
      const ownerSid = streamSid || ((_ok1 && !String(_ok1).startsWith('draft-')) ? _ok1 : null);
      const _fallbackSel = ownerSid ? null : getLocalSession();
      const finalizeSid = ownerSid || _fallbackSel?.sessionId || null;
      const finalizePh = (ownerSid ? streamOwnerPh : _fallbackSel?.projectHash) || '';
      if (finalizeSid && finalizePh) {
        // 同会话 stop→resend 守卫:本 finally 属于 turn-1,轮询期间(~2.4s)用户可能已对
        // 同一会话发出 turn-2。只认 handleSend 入口同步抢占的 generation；不能再看 pid，
        // 因为 turn-2 会先起流、写用户消息，再等 checkpoint/provider 和 /api/chat 返回 pid。
        const tkey = (m) => {
          const t = Array.isArray(m.text) ? m.text.join('') : (m.text || '');
          return `${m.type}|${(t || '').slice(0, 80)}`;
        };
        // 一轮回复可能跨多条 assistant 消息(text → 工具 → text):jsonl 先写
        // assistant[text+tool],turn COUNT 此刻就 +1,但工具之后的尾部文本是更晚的
        // 另一条 assistant 消息。只按 count 判定会在尾部文本落盘前就判"已落盘"→ 清掉
        // 本地完整副本(含尾部文本)→ 持久化版此刻只有 text+tool → 末条消息永久丢失。
        // 所以除了 count,还要求持久化末轮文本包含我们流式输出的结尾(tail),确认整轮
        // (含尾部)落盘后再清。等待足够久后(尾部可能因 provider 文本规整化对不上)回退
        // 到纯 count 判定,避免极端情况下本地副本永不清除导致重复渲染。
        // 重复 prompt 仍安全:count 必须先增长,tail 取本轮流式文本结尾,不会误匹配旧轮。
        const tail = (accumulatedText || '').replace(/\s+/g, ' ').trim().slice(-50);
        const roundLanded = (persisted, attempt) => {
          // reattach 豁免计数检查(调研根因①):reattach 的 turnsBefore 基准会被污染——
          // 切回时历史重拉已把在途回合计入(或残留上一会话的列表),持久化计数永远
          // ≤ 基准 → 本地副本永不清 → 持久化版+本地版双渲染。回放内容来自同一进程,
          // done 到达即意味着该回合 jsonl 已写;保留 tail 匹配确认整轮(含尾部)落盘。
          if (!reattachPid && persisted.filter((m) => m.type === 'turn').length <= turnsBefore) return false;
          if (!tail || attempt >= 9) return true; // 纯工具轮 / 已等够久 → count 足矣
          const lastTurn = [...persisted].reverse().find((m) => m.type === 'turn');
          const ptext = lastTurn
            ? (Array.isArray(lastTurn.text) ? lastTurn.text.join(' ') : (lastTurn.text || '')).replace(/\s+/g, ' ')
            : '';
          return ptext.includes(tail);
        };
        for (let i = 0; i < 12; i++) {
          // Bail if the user navigated THIS pane to another session mid-finalize:
          // otherwise we'd fetch the old session into the now-current tab and clear
          // the wrong session's local messages.
          if (getLocalSession()?.sessionId !== finalizeSid) break;
          if (!isCurrentTurn()) break; // 同会话已开新回合:保护 turn-2 在途本地消息
          // PEEK persisted WITHOUT committing to the store. A mid-round jsonl
          // (text+tool written, trailing text C not yet) must NEVER render — if we
          // committed it, the naive [...persisted, ...local] concat + coarse tkey
          // dedup would show the partial turn and drop the complete local copy →
          // the trailing message C vanishes. So we only commit once the FULL round
          // (incl trailing text) has landed.
          let peeked = [];
          try {
            const r = await fetch(`/api/sessions/${finalizeSid}/messages?projectHash=${encodeURIComponent(finalizePh)}`);
            // 该端点直接返回数组(res.json(messages)),不是 {messages:[]}。原来取 .messages
            // 永远是 undefined→peeked 恒为 []→roundLanded 恒 false→每轮空跑满 12 次(~2.4s)
            // 才回退,尾部落盘检测形同虚设。兼容两种形态。
            if (r.ok) { const d = await r.json(); peeked = Array.isArray(d) ? d : (d?.messages || []); }
          } catch {}
          if (getLocalSession()?.sessionId !== finalizeSid || !isCurrentTurn()) break;
          if (!producedReply) {
            // Empty/errored turn — no jsonl twin to wait for. Commit persisted and
            // drop matched NON-turn locals (the user prompt); keep the local ⚠️/❌
            // turn visible.
            try { await fetchMessagesForTab(finalizeSid, finalizePh, { silent: true }); } catch {}
            const known = new Set(getLocalMessages().map(tkey));
            setChatMessages((prev) => {
              if (!isCurrentTurn()) return prev; // await 期间开了新回合 → 不清在途消息
              return prev.length ? prev.filter((m) => m.type === 'turn' || !known.has(tkey(m))) : prev;
            });
            break;
          }
          if (roundLanded(peeked, i)) {
            // Full round (incl trailing text) persisted → commit it to the store,
            // then drop ALL local copies (streamed text rarely byte-matches final
            // jsonl, so clearing avoids a doubled turn).
            // 例外:type==='btw' 旁问气泡只活在本地(永远没有 jsonl 孪生),整清会让它
            // 在回合结束时凭空消失;保留,切会话/刷新时自然清掉。
            try { await fetchMessagesForTab(finalizeSid, finalizePh, { silent: true }); } catch {}
            setChatMessages((prev) => {
              if (!isCurrentTurn()) return prev; // await 期间开了新回合 → 不清在途消息
              return prev.some((m) => m.type === 'btw') ? prev.filter((m) => m.type === 'btw') : [];
            });
            break;
          }
          if (i < 11) await new Promise((r) => setTimeout(r, 200));
        }
      }
      // BF-1:回合收尾清历史截断,历史渲染交还 jsonl。放在 finalize 循环之后:break 与
      // 此处同一同步续体,React 合批 —— 与循环内 setChatMessages([]) 同帧提交,不会闪现
      // "本地已清、截断还在 → 该回合一帧不可见"。nav-away 提前 break / 无 sid 路径也覆盖。
      // 流正常结束也记时刻(调研根因②):复活守卫(d3d747a)让 reattach 首次可在无 detach
      // 时发生(子代理完→4s去抖发done→主agent续跑→轮询再reattach),无时刻就回落
      // afterLastUser,把刚提交的上一轮正文切掉只剩 Connecting,重放又补不回来(实时流
      // 走的从未进 earlyLines)。记结束时刻后 reattach 走 sinceTs 只藏会被重放的段落。
      // 取 max 防与 detach 写入互相回拨;detach 的 AbortError 也走本 finally,值仅晚毫秒级。
      if (streamSid) {
        const prevTs = detachTsBySidRef.current[streamSid] || 0;
        detachTsBySidRef.current[streamSid] = Math.max(prevTs, Date.now());
      }
      // 复位只归当前 generation 所有:上面的 finalize 轮询含 await(最长 ~2.4s),这期间
      // 新回合会在任何异步准备前同步抢占 token。旧 finally 即使看到新回合尚未拿到 pid，
      // 也不能再清它的截断/reattach 标记。
      if (isCurrentTurn()) {
        setStreamHistCutoff(null);
        setReattachStream(false);
      }
      // Background refresh of sidebar session list. `silent:true` means the
      // global loading flag is NOT toggled, so SessionDetail doesn't swap to
      // a loading screen and wipe out the user's scroll position.
      const sel = getLocalSession();
      const hash = sel?.projectHash;
      if (hash) {
        [500, 1500, 3500].forEach((ms) =>
          setTimeout(() => useStore.getState().fetchSessions(hash, { silent: true }), ms)
        );
      }
      // Notify panels (UsagePanel) to refresh their stats.
      window.dispatchEvent(new CustomEvent('cgui:chat-done'));

      // V1:回合结束后台自动跑一次 /context(fork 不落盘、纯本地计算),把实测的
      // 分子/分母回写徽章 —— usage 事件只反映"上次 API 调用收到的输入",与 /context
      // 的"下次发送的真实上下文"存在系统性差值(用户实测 117k vs 138k)。实测对齐后
      // 徽章与点开的明细一致。best-effort、不阻塞;同会话并发探测去重。
      try {
        const _ok2 = streamOwnerKeyRef.current;
        const probeSid = (_ok2 && !String(_ok2).startsWith('draft-')) ? _ok2 : getLocalSession()?.sessionId;
        if (probeSid && (producedReply || isCompact) && !isClear && !window.__cguiCtxProbe?.[probeSid]) {
          (window.__cguiCtxProbe ||= {})[probeSid] = true;
          const _st3 = useStore.getState();
          const probeModel = _st3.modelBySession[probeSid] || _st3.currentModel || '';
          // projectHash/cwd 同样取归属会话元数据:selectedSession 是发起时闭包(= owner
          // 会话),不摸 getLocalSession()(用户切走后会把探测打到别的项目目录,判官盲审#5)。
          const probePh = selectedSession?.projectHash || '';
          const probeCwd = selectedSession?.projectPath || selectedProject?.path || '';
          const qs2 = new URLSearchParams({ cwd: probeCwd, projectHash: probePh, model: probeModel });
          fetch(`/api/context/${probeSid}?${qs2.toString()}`)
            .then((r) => r.json())
            .then((d) => {
              if (d?.totalTokens > 0 && d?.windowTokens > 0) {
                useStore.getState().setCtxMeasured(probeSid, { totalTokens: d.totalTokens, windowTokens: d.windowTokens });
              }
              useStore.getState().setCtxBreakdown(probeSid, d); // AA1:缓存明细供弹层秒开
            })
            .catch(() => {})
            .finally(() => { delete window.__cguiCtxProbe[probeSid]; });
        }
      } catch {}

      // 首轮后自动生成会话标题(B):一次性隔离 claude 调用,best-effort、不阻塞。
      // 仅当会话已有真实 sessionId、且既无自定义标题也无已生成的自动标题时触发,
      // 所以每个会话最多生成一次。失败/空标题静默回退到第一条消息。
      try {
        // I4 标题串扰修复:标题必须归属【发起这次流的会话】,而不是当前查看的会话。
        // 用户在 AI 回复时切到别的会话,getLocalSession() 会返回新会话 → 旧对话的内容
        // 被用来给新会话生成标题(用户报告:其他会话标题被改)。首选本次流的 streamSid
        // (发起时闭包 sid 或 init 记下的新 sid);owner key 兜底;绝不回落 getLocalSession()
        // ——用户已切到会话 C 时那会拿 A 的内容给 C 起标题(串扰第二现场)。
        const _ownerKey = streamOwnerKeyRef.current;
        const titleSid = streamSid || ((_ownerKey && !_ownerKey.startsWith('draft-')) ? _ownerKey : null);
        const st = useStore.getState();
        if (titleSid && !titleAttempted.has(titleSid) && !st.customTitles[titleSid] && !st.autoTitles[titleSid] && prompt) {
          // 标记"已尝试"——无论成功失败都不再重试,避免 provider 失败时每轮 spawn。
          titleAttempted.add(titleSid);
          // 标题用【当前 provider 有效】的模型:本会话 pin 或当前选中模型,去掉 [1m]。
          // 不要用 jsonl 历史模型回退 —— 老会话历史里可能是别的 provider 的模型(如官方
          // provider 下读到旧 mimo-v2.5-pro),传给 --model 会"模型不存在"→标题永远生成不出来
          // (用户报告 #2)。pin/currentModel 在切 provider 时会被清,始终对应当前 provider。
          const titleModel = String(st.modelBySession[titleSid] || st.currentModel || '').replace(/\[1m\]/i, '');
          fetch('/api/chat/title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firstUser: prompt, firstAssistant: accumulatedText || '', cwd, model: titleModel }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (d?.title) useStore.getState().setAutoTitle(titleSid, d.title);
              else titleAttempted.delete(titleSid); // 空标题(失败)→ 允许下一轮重试,不要永久放弃
            })
            .catch(() => { titleAttempted.delete(titleSid); });
        }
      } catch {}

      // After the chat fully finishes, drain the queue: pop the head and send
      // it. This runs once per chat — if more were queued, the next send's
      // finally block will pop again. setTimeout 0 gets us out of this finally
      // first so React commits isStreaming=false before the next send starts.
      // AZ10:reattach 流结束也要排空。原本 skip-on-reattach 导致:分屏非焦点 pane 的
      // 本地流被 detach 后由 backgroundPid 轮询接管成 reattach 流,结束时跳过排空 →
      // 排队消息永不自动发出(分屏几乎必现)。排空用本流归属会话 key(streamSid/ownerKey),
      // reattach 回来时正是该会话;shiftMessage 原子 pop + reattach 串行(reattachedPidRef
      // 守卫)→ 不会与原 finally 双发。仍与 ⚡引导(acceleratingRef)互斥。
      // H 转后台:回合还在服务端跑,此刻外发排队消息会对同一会话双写(server 只复用
      // idle slot,busy slot 会另起进程 --resume 同一 jsonl)。跳过;回来 reattach 的
      // 流收尾时照常排空。
      // queueKey 归属(判官盲审#1):排【发起这次流的会话】的队,不读本 pane 当前会话 ——
      // 流式期间切会话时会把 A 的排队消息从 B 的队列里 pop(或漏 pop A 的)。
      // 消费端归属校验(判官致命#1):drain 弹的是 owner 队列,但 handleSendRef 永远发进
      // 【本窗格当前会话】—— 流式中切走会话时弹 A 的队 + 发进 B = 跨会话消息泄漏(A 的
      // 排队消息进了 B,A 的队还少了一条)。owner ≠ 当前会话时整段跳过,留给该会话
      // reattach 流的收尾排空(AZ10 原设计)。
      if (!acceleratingRef.current && !backgroundedRef.current) {
        const _ls = getLocalSession();
        const curKey = _ls?.sessionId || `draft-${_ls?.projectHash || 'none'}`;
        const queueKey = streamSid || streamOwnerKeyRef.current || curKey;
        const next = queueKey === curKey ? useStore.getState().shiftMessage(queueKey) : null;
        if (next?.text) {
          // 透传入队时的 opts(尤其 hiddenUserMessage)——否则计划执行这种隐藏续跑消息
          // 出队重发时会变成可见的用户气泡(#5)。
          setTimeout(() => handleSendRef.current?.(next.text, next.opts || (next.hidden ? { hiddenUserMessage: true } : {})), 50);
        }
      }
      acceleratingRef.current = false;
      backgroundedRef.current = false;
      // 流归属 ref 生命周期收口:本流已结束,ref 不再代表任何在跑的流。不清会让非流式
      // 期间的读点(⚡/异步回调)拿到上一个流的会话 = 串扰。只清 ref 不动 streamOwnerKey
      // state —— state 驱动 liveVisible(CQ-5),此刻本地缓冲还没交还 jsonl,清了会让刚
      // 产出的回复先隐藏再从历史冒出来(闪一下)。下一次发送/reattach 在 4333 重新认领。
      // 只在 ref 仍是【本流认领的那个 key】时清:本 finally 可能迟到(被 abort 的流收尾时
      // 新流已经起来并认领了 ref),无脑清会把新流的归属抹掉 = 新流的异步回调读不到归属会话。
      // 本流认领过的 key 有两个形态:发起时的 sessionQueueKey、init 拿到真 id 后升级的 streamSid。
      if (isCurrentTurn() && (streamOwnerKeyRef.current === sessionQueueKey
          || (streamSid && streamOwnerKeyRef.current === streamSid))) {
        streamOwnerKeyRef.current = null;
      }
      } finally {
        // C1:收尾结束(含中途抛错)一律解锁;归零后 poll 的排队排空恢复接管。
        finalizeInFlightRef.current = Math.max(0, finalizeInFlightRef.current - 1);
      }
    }
  }, [selectedSession, selectedProject, streamingModel, isStreaming, sessionQueueKey, sendBtw]);

  // Ref to handleSend so the finally-block drain doesn't form a circular closure dep.
  const handleSendRef = useRef(null);
  useEffect(() => { handleSendRef.current = handleSend; }, [handleSend]);

  // Auto-reattach: when the backgroundPid poll finds this session has a live
  // CLI proc that nobody's listening to (user navigated away mid-stream),
  // re-open the SSE stream so the live tokens render again in this tab.
  // Without this the user would only see the static "still working in background"
  // banner — exactly what they complained about.
  const reattachedPidRef = useRef(null);
  useEffect(() => {
    if (!backgroundPid) { reattachedPidRef.current = null; return; }
    if (streamingRef.current) return;
    if (reattachedPidRef.current === backgroundPid) return; // already reattached
    reattachedPidRef.current = backgroundPid;
    handleSendRef.current?.(null, { reattachPid: backgroundPid });
  }, [backgroundPid]);

  // H 转后台(用户主动):复用切走会话的 detach 路径 —— 只 abort 本端 SSE,进程照常
  // 在服务端跑、jsonl 继续落盘。与切走的区别:留在本会话,所以要 ① 预置 reattachedPidRef
  // 抑制 backgroundPid 轮询发现后的立即 auto-reattach(否则点了等于没点);② 标记
  // backgroundedRef 让被 abort 的 finally 跳过排队消息外发(回合还在跑,外发=双写)。
  // 已流式的半截内容由 AbortError catch 保留成气泡;后续内容经 jsonl 追加/回合完成刷新。
  // 切走再切回会清 reattach 守卫,届时照常续播。
  const handleBackgroundify = useCallback(() => {
    const pid = activeProcRef.current;
    if (!pid) return;
    reattachedPidRef.current = String(pid);
    backgroundedRef.current = true;
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch {}
      abortRef.current = null;
    }
    activeProcRef.current = null;
    // 记 detach 时刻(与切走会话一致)。截断口径已不再读它,见 detachTsBySidRef 声明处。
    if (selectedSession?.sessionId) detachTsBySidRef.current[selectedSession.sessionId] = Date.now();
    setBackgroundPid(String(pid)); // 立即出「后台工作中」横幅,不等下一轮 poll
  }, [selectedSession?.sessionId]);

  const handleStop = useCallback(() => {
    // 记下要停的 pid → poll/reattach 不再把它当「还在后台跑」(它在服务端 60s grace 内
    // 仍 stoppable)。持 SSE 的 activeProc 与不持 SSE 的 background 两条路径都要记。
    const pid = activeProcRef.current || backgroundPid;
    if (pid) stoppedPidsRef.current.add(String(pid));
    killedRef.current = true; // 真杀进程 → finally 收后台化子代理为 stopped
    abortRef.current?.abort();
    if (activeProcRef.current) {
      // 响应存 ref 供 finally 排除服务端保留的跨回合后台子代理(见 stopKeptRef 注释)。
      // 超时兜底:服务端挂死时 fetch 永不 settle → 挂在它上面的收尾永不跑,会话卡在"工作中"。
      // 超时走 catch → null → 回落全量收尾(原行为)。
      stopKeptRef.current = fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST', signal: AbortSignal.timeout(8000) })
        .then((r) => r.json()).catch(() => null);
    } else if (backgroundPid) {
      // 停止链路 #2:转后台后无本地流,finally 的 killedRef 收尾路径不存在 → 杀点
      // 就地按 sessionId 收尾本会话 taskManaged 等非终态子代理(进程死了不会再有信号)。
      // draft 会话(未拿到真 sid)用 draft-<hash> 键 —— 判官重要2 后 draft 阶段派出的
      // 子代理条目 sessionId 就是该键,不补会扫不到残留。
      // 收尾挂到 /stop 响应上(晚几毫秒):选择性停止会保留跨回合后台子代理,它们没被停、
      // 进程还活着,标 stopped 就是假终态。请求失败/无字段 → 回落全量收尾(原行为)。
      const _bsid = selectedSession?.sessionId || (selectedSession?.projectHash ? `draft-${selectedSession.projectHash}` : null);
      fetch(`/api/chat/${backgroundPid}/stop`, { method: 'POST', signal: AbortSignal.timeout(8000) })
        .then((r) => r.json()).catch(() => null)
        .then((d) => finalizeSessionAgents(_bsid, 'stopped', d?.keptToolUseIds));
    }
    // 两种情况都立即清掉本地「后台运行中」标记,不等下一轮 poll(那一轮还会误报)。
    setBackgroundPid(null);
  }, [backgroundPid, selectedSession?.sessionId]);
  // CQ-15:把 handleStop / backgroundPid 包成 ref,供 ESC 监听读最新值而不必进 effect deps。
  // 原来 ESC effect 依赖 [isStreaming, backgroundPid, handleStop],而 backgroundPid 每 1.5s
  // poll 抖动、handleStop 随之重建 → effect 频繁 cleanup+register,切焦点同帧有「两个 pane
  // 都短暂挂着 listener」的竞态(双击 ESC 误停其它 pane 的根因之一)。
  const handleStopRef = useRef(handleStop);
  useEffect(() => { handleStopRef.current = handleStop; }, [handleStop]);
  const backgroundPidRef = useRef(backgroundPid);
  useEffect(() => { backgroundPidRef.current = backgroundPid; }, [backgroundPid]);

  // 空闲态双击 Esc 的副作用(判定在 utils/escAction.js,纯函数有单测)。
  // 被 Esc 清掉的输入文本记在这里:壳层没有输入框撤销栈,⌘Z 撤不回受控组件的 setText,
  // 所以"再双击一次 Esc"就是后悔药(和 CLI 一样只清不问,但比 CLI 多给一次找回机会)。
  // 必须带会话身份:SessionDetail 切会话不重挂,裸存字符串会让 A 会话清掉的文字在 B
  // 会话双击 Esc 时填进 B(串扰)。存 { key, text },key 不匹配当没有。
  const escClearedTextRef = useRef({ key: null, text: '' });
  // 时间戳信号:空手双击 Esc → 展开会话头 ⋮ 并自动弹开 Checkpoint 时间线(GUI 侧的 Rewind)。
  const [rewindSignal, setRewindSignal] = useState(0);
  const handleIdleDoubleEsc = useCallback(() => {
    const key = sessionQueueKey;
    // 输入框文本的真实来源:ChatInput 每次变更都持久化到 cgui-draft:<permKey>(permKey 即
    // sessionQueueKey)。直接读它,免得为一个快捷键把 text 状态提到父组件。
    let draft = '';
    try { draft = localStorage.getItem(`cgui-draft:${key}`) || ''; } catch {}
    // 只认本会话清掉的文字;别的会话留下的一律按"没有"处理(落 rewind 分支)。
    const cleared = escClearedTextRef.current?.key === key ? (escClearedTextRef.current.text || '') : '';
    const action = idleEscAction({
      draftText: draft,
      clearedText: cleared,
      hasSession: !!selectedSession?.sessionId,
    });
    if (action === 'clear-input') {
      escClearedTextRef.current = { key, text: draft };
      window.dispatchEvent(new CustomEvent('cgui:composer-clear', { detail: { targetKey: key } }));
      setProviderSwitchNotice({ text: '输入框已清空。再连按两次 Esc 可把刚才的文字放回来。' });
      return;
    }
    if (action === 'restore-input') {
      window.dispatchEvent(new CustomEvent('cgui:composer-fill', { detail: { targetKey: key, text: cleared } }));
      escClearedTextRef.current = { key: null, text: '' };
      return;
    }
    if (action === 'rewind-empty') {
      setProviderSwitchNotice({ text: '本会话还没有发送过消息，没有可回退的检查点。' });
      return;
    }
    setRewindSignal(Date.now());
  }, [sessionQueueKey, selectedSession?.sessionId]);
  const handleIdleDoubleEscRef = useRef(handleIdleDoubleEsc);
  useEffect(() => { handleIdleDoubleEscRef.current = handleIdleDoubleEsc; }, [handleIdleDoubleEsc]);

  // Esc 的会话级语义(对齐 CLI 原生,pty 实测):
  //   生成中          → 单击即中断(原来要 600ms 内双击,是 GUI 自造差异)
  //   空闲 + 有文字   → 双击(800ms 窗)清空输入框
  //   空闲 + 输入框空 → 双击打开 Checkpoint 时间线(GUI 侧的 Rewind)
  // 前提是浮层各自吃掉自己的 Esc(见 E1:斜杠菜单/@面板/取消编辑重发/权限卡都已
  // stopImmediatePropagation),否则"关个菜单"会连带停掉整回合。
  // 刻意 NOT gated on textarea/input focus:回复期间光标就在输入框里,加焦点守卫等于永不生效。
  useEffect(() => {
    // AZ1:分屏下 esc 语义只作用于【焦点窗格】。effect 挂 window 级,每个 pane 各注册一个
    // listener;不加这道守卫则一次 esc 广播到所有 pane → 中断/清空全部会话。
    // 与上方 Cmd+F effect 的 paneIsActive 守卫同构。单屏 activeTabIndex 恒 0,无回归。
    if (!paneIsActive) return;
    // 只在「焦点 pane」注册一次(deps 仅 paneIsActive)。是否有可停的流改为在按键时用 ref
    // 实时判断,不再让 isStreaming/backgroundPid 抖动驱动 effect 反复重注册(CQ-15 竞态根因)。
    let lastEsc = 0;
    // 已经为哪张卡让过行(卡片 id)。让行只给一击:卡片吃下这击就 deny 并消失,下一击
    // 自然落停止分支;若这张卡根本不吃 Esc(如 AskUserQuestion 选择卡)或压根没渲染,
    // 第二击也不再让行,Esc 不会变成哑键。
    let yieldedForId = null;
    const onKey = (e) => {
      // 输入法组字中按 Esc = 取消候选词,不是"停这一回合"。少了这道守卫,中文输入时
      // 撤个候选就把整轮生成停了(判据同 ChatInput.jsx:694;原生 keydown 上 isComposing
      // 在 event 本身,keyCode 229 兜底老 webview)。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== 'Escape' || e.repeat) return; // ignore held-key repeats
      // 本窗格挂着权限/计划/越界卡时,这一击让给卡片(它的监听同挂 window 冒泡,见
      // PermissionPrompt 顶部注释:捕获相位已被 8 个浮层占着,抢相位会互相误伤)。
      // 焦点在输入框/下拉里时卡片自己会跳过(TEXTAREA/INPUT/SELECT 守卫),那种情况不让行,
      // 否则 Esc 两边都没人接 = 哑键。
      // 判定内核抽在 utils/escAction.js(纯函数,tests/unit/check-esc-action.mjs 锁);
      // 归属口径同 hasPendingInteraction(:3534)。
      const st = useStore.getState();
      const yieldId = escYieldCardId({
        targetTag: e.target, // 传元素本身:只给 tagName 时 contentEditable 永远测不到(富文本焦点+卡片=哑键)
        pendingList: st.pendingPermissions,
        psid: (st.paneSessions && st.paneSessions[tabIndex])?.sessionId || null,
        yieldedForId,
      });
      if (yieldId) { yieldedForId = yieldId; return; }
      const now = e.timeStamp || performance.now();
      const route = escRoute({
        hasStream: !!(streamingRef.current || backgroundPidRef.current),
        lastEscAt: lastEsc,
        now,
      });
      if (route === 'arm') { lastEsc = now; return; } // 空闲首击:什么都不做,等第二击
      lastEsc = 0;
      e.preventDefault();
      // pending 卡片那一击已在上面让行 = 单击只 deny;卡片消失后再按 Esc 才停整轮
      // (/stop 会 dropPendingForSession 连带清残留卡片)。
      if (route === 'stop') handleStopRef.current?.();
      else handleIdleDoubleEscRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneIsActive, tabIndex]);

  // "⚡ 引导" — abort the in-flight chat and immediately fire the queued message.
  const handleAccelerate = useCallback(() => {
    // 两个 flag 只在【真有在跑的流】时置:它们都是给"本流的 finally"看的
    // (killedRef=这次 abort 真杀了进程、acceleratingRef=队列已被我弹过别再弹)。空闲态点 ⚡
    // 没有 finally 会来读它们、更不会重置 → acceleratingRef 一直挂着 true,下一条流收尾时
    // 整段 drain 被跳过,队列里的第 2 条永远不接力。
    if (streamingRef.current) {
      killedRef.current = true; // 引导=停当前回合(POST /stop)→ finally 收后台化子代理
      // Drain the queue head ourselves instead of relying on the aborted send's
      // finally: that finally SKIPS drain on a reattach stream (App enters reattach
      // when you revisit a still-generating session), so on mobile "⚡ 引导" did
      // nothing. Flag it so the finally doesn't also pop (double-send).
      acceleratingRef.current = true;
    }
    if (abortRef.current) try { abortRef.current.abort(); } catch {}
    if (activeProcRef.current) {
      // 同 handleStop:响应存 ref,finally 据此跳过服务端保留的跨回合后台子代理(超时兜底同上)。
      stopKeptRef.current = fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST', signal: AbortSignal.timeout(8000) })
        .then((r) => r.json()).catch(() => null);
    }
    // queueKey 与流收尾 drain 同口径(F1):消费端 handleSendRef 恒发进【本窗格当前会话】,
    // 所以只能弹当前会话的队列 —— 入队侧(enqueueMessage)用的也正是这个 pane key,两端对称。
    // 原来用 streamOwnerKeyRef:该 ref 流结束后从不清 → 非流式点 ⚡ 弹的是上一个流的队列
    // (上个队列空=点了没反应,当前会话的排队消息永不发出;非空=上个会话的消息被发进当前会话)。
    const sel = getLocalSession();
    const queueKey = sel?.sessionId || `draft-${sel?.projectHash || 'none'}`;
    const next = useStore.getState().shiftMessage(queueKey);
    if (next?.text) setTimeout(() => handleSendRef.current?.(next.text, next.opts || (next.hidden ? { hiddenUserMessage: true } : {})), 80);
  }, []);

  // Reset per-session UI state when the selectedSession object changes.
  // KEY DIFFERENCE FROM PREVIOUS IMPL: depend on the selectedSession reference,
  // not just sessionId. Otherwise: draft1 (sessionId=null) → real → click 新建 →
  // draft2 (sessionId=null) leaves sessionId unchanged, useEffect doesn't fire,
  // and the old chatMessages bleed into the new draft.
  //
  // The exception is the "draft promotion" — when the same draft acquires a
  // real sessionId mid-stream via the system/init event. We don't want to wipe
  // the user's just-sent message in that case.
  const prevSessionRef = useRef(selectedSession);
  // #4:{ [sessionId]: detach时刻 }。原用途是 reattach 的历史截断口径,现已废弃(turn 粒度
  // 时间戳让它恒失效,见 utils/reattach.js)——保留写入点,不再有读取点。
  const detachTsBySidRef = useRef({});
  useEffect(() => {
    const prev = prevSessionRef.current;
    const curr = selectedSession;
    if (prev !== curr) {
      const isPromotion =
        prev && curr &&
        !prev.sessionId && curr.sessionId &&
        prev.projectHash === curr.projectHash;
      if (!isPromotion) {
        // Detach (NOT kill) any in-flight stream. Aborting the client-side
        // fetch closes our SSE connection — the server now keeps the CLI
        // process running and the jsonl on disk continues to grow. When the
        // user navigates back to the original session, fetchMessages reads
        // whatever has been persisted so far. This trades live-streaming
        // continuity for the user's actual ask: "don't kill my reply just
        // because I clicked elsewhere."
        if (abortRef.current) {
          try { abortRef.current.abort(); } catch {}
          abortRef.current = null;
        }
        // Do NOT POST /api/chat/:pid/stop here — that would kill the proc.
        // Just forget the ref so we don't accidentally stop it later.
        activeProcRef.current = null;
        // #4:记录本会话 detach 时刻(按 sessionId 键,不跨会话共享)。切回后 reattach 用它做
        // sinceTs 截断,只藏"detach 之后落盘、且会被 earlyLines 重放"的内容;detach 之前已产出
        // 的助手回复(在 jsonl、不在 earlyLines 回放里)照常从历史显示,不再凭空消失。
        if (prev?.sessionId) detachTsBySidRef.current[prev.sessionId] = Date.now();
        updateStreaming(false);
        // 保留旁问气泡(本地注记,ownerKey 门控):切会话不清 btw,使浮窗线程"切走隐藏、切回还在"。
        // 非 btw(turn/error/interrupted 半截回复)照旧清空——它们无 ownerKey 隔离,留着会串进新会话。
        // btw 由 visibleChat 的 ownerKey===sessionQueueKey 过滤,永不在别的会话渲染,留着安全。
        setChatMessages((prev) => prev.filter((m) => m.type === 'btw'));
        setStreamingText('');
        setStreamingThinking('');
        setStreamingToolCalls([]);
        setStreamingBlocks([]);
        // Clear reattach guard so navigating back to a session with the same
        // backgroundPid triggers a fresh reattach attempt.
        reattachedPidRef.current = null;
      }
      prevSessionRef.current = curr;
    }
  }, [selectedSession]);

  // Roll back a user message. Modes:
  //   'message' — trim on-disk jsonl + trim UI only. Files stay untouched.
  //   'both'    — restore git checkpoint + trim jsonl + auto re-send original text.
  //   'edit'    — restore git checkpoint + trim jsonl + put original text in composer.
  //   'files'   — legacy compatibility: git restore only; conversation untouched.
  //
  // We MUST trim the on-disk jsonl too. Claude CLI resumes a session by
  // reading the jsonl; without trimming it, the next prompt sees the rolled-
  // back AI reply as still-valid history, which defeats the whole rollback.
  //
  // Declared BEFORE the early returns below to keep hook order stable across
  // renders (React #310).
  const handleRollback = useCallback(async (msg, { mode, resendText = null, softFiles = false } = {}) => {
    const sel = getLocalSession();
    const proj = useStore.getState().selectedProject;
    // 会话优先于全局项目:setSelectedProject 支持"浏览别的项目、右侧会话不动",
    // 且 worktree 会话的 projectPath 与主项目不同。取全局项目会把 A 会话的快照写进
    // B 目录、trim 用错 hash(对齐 handleSend/FileReviewPanel 的会话优先口径)。
    const cwd = sel?.projectPath || proj?.path;
    const projectHash = sel?.projectHash || proj?.hash;
    let idxInChat = chatMessages.findIndex((m) => m.uuid === msg.uuid);
    let idxInStore = messages.findIndex((m) => m.uuid === msg.uuid);
    // uuid 失配兜底:流式期间点"重新编辑"拿到的是 chat-user-<ts> 临时气泡,回合
    // finalize 后 chatMessages 被清、历史换成 CLI uuid → 两处 findIndex 均 -1 →
    // 原来直接 return 把用户已改的文本吞掉(输入框已清)。按时间戳回落匹配。
    if (idxInChat === -1 && idxInStore === -1 && msg.timestamp) {
      idxInStore = messages.findIndex((m) => m.type === 'user' && m.timestamp === msg.timestamp);
      idxInChat = chatMessages.findIndex((m) => m.type === 'user' && m.timestamp === msg.timestamp);
    }
    const resolveCheckpointSha = async () => {
      if (msg.checkpointSha) return msg.checkpointSha;
      if (!sel?.sessionId) return null;
      const params = new URLSearchParams();
      if (msg.timestamp) params.set('timestamp', msg.timestamp);
      if (msg.text) params.set('text', msg.text);
      // before=true:回滚语义是"回到这条消息之前",最近邻(Math.abs)在该消息自己的
      // checkpoint 缺失时会选到之后的快照 → 文件没回退 UI 却报成功。
      params.set('before', 'true');
      try {
        const r = await fetch(`/api/checkpoints/${sel.sessionId}/resolve?${params.toString()}`);
        if (!r.ok) return null;
        const d = await r.json().catch(() => ({}));
        return d.sha || null;
      } catch {
        return null;
      }
    };

    const truncateUi = () => {
      if (idxInStore !== -1) {
        setLocalMessages(messages.slice(0, idxInStore));
        setChatMessages((prev) => prev.filter((m) => m.type === 'btw')); // 保留旁问气泡(本地注记)
      } else if (idxInChat !== -1) {
        // 保留旁问:回滚首条(draft,消息还在 chatMessages)走此支,原 slice 会连 btw 一起切掉。
        // 对齐 CLI 原生语义 —— /btw 是不落盘的临时 fork,主会话回滚与旁问物理无关,任何回滚都保留旁问(#6)。
        setChatMessages((prev) => prev.filter((m, i) => i < idxInChat || m.type === 'btw'));
      }
    };

    // ── 定向压缩(summarize-before / summarize-after)────────────────────
    // before:锚点之前的对话替换为 AI 摘要(原始记录保留在 jsonl,不再计入上下文);
    // after:回退到锚点之前,锚点及之后压缩为摘要保留。服务端生成摘要 + 改写 jsonl
    // (自动 .bak 备份)。见 server/routes/sessions.js compact-segment。
    if (mode === 'summarize-before' || mode === 'summarize-after') {
      const direction = mode === 'summarize-before' ? 'before' : 'after';
      if (!sel?.sessionId || !projectHash) { confirmDialog('会话尚未创建,无法压缩。'); return; }
      if (!msg.uuid || msg.uuid.startsWith('chat-')) { confirmDialog('该消息尚未写入会话记录,请稍后重试。'); return; }
      if (activeProcRef.current || backgroundPidRef.current) { confirmDialog('当前回合仍在进行,请先停止或等待完成后再压缩。'); return; }
      const okGo = await confirmDialog(direction === 'before'
        ? '将把这条消息之前的全部对话替换为一段 AI 生成的摘要。原始记录仍保留在会话文件中并可见,但不再计入上下文;改写前会写入 .bak 备份。摘要生成需要一到两分钟。是否继续?'
        : '将回退到这条消息之前,并把这条消息及之后的对话压缩为一段摘要保留在上下文中。改写前会写入 .bak 备份。摘要生成需要一到两分钟。是否继续?', { danger: true });
      if (!okGo) return;
      const compactModel = String(useStore.getState().modelBySession[sel.sessionId] || useStore.getState().currentModel || '');
      setProviderSwitchNotice({ text: '正在生成摘要并压缩会话,请勿在此期间发送消息…' });
      try {
        const r = await fetch(`/api/sessions/${sel.sessionId}/compact-segment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectHash, uuid: msg.uuid, direction, model: compactModel }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { setProviderSwitchNotice({ text: '压缩失败:' + (d.error || r.status) + '(会话未改动)' }); return; }
        if (direction === 'after') setChatMessages((prev) => prev.filter((m) => m.type === 'btw')); // 尾段已被移除,清掉本地未落盘气泡(旁问除外)
        try { await fetchMessagesForTab(sel.sessionId, projectHash, { silent: true }); } catch {}
        setProviderSwitchNotice({ text: direction === 'before' ? '已把此前对话压缩为摘要,上下文占用已降低。' : '已回退并把后续对话保留为摘要。' });
      } catch (e) {
        setProviderSwitchNotice({ text: '压缩失败:' + e.message });
      }
      return;
    }

    // ── files only ────────────────────────────────────────────
    if (mode === 'files') {
      if (!sel?.sessionId || !cwd) { confirmDialog('缺少 sessionId 或工作目录，无法还原文件。'); return; }
      const checkpointSha = await resolveCheckpointSha();
      if (!checkpointSha) { confirmDialog('找不到这条消息发送前的文件快照，无法还原文件。'); return; }
      try {
        const r = await fetch(`/api/checkpoints/${sel.sessionId}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha: checkpointSha, cwd }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          confirmDialog('文件还原失败：' + (e.error || r.status));
        }
      } catch (err) {
        confirmDialog('文件还原失败：' + err.message);
      }
      return;
    }

    // ── message / both / edit ─────────────────────────────────
    // For edit mode, fill the composer FIRST — before any state lookups,
    // index checks, or awaits. Even if idx lookup fails or the message has
    // already been removed from both arrays (re-fetch raced ahead, etc.),
    // the user still gets the original text in the input box, which is the
    // primary visible signal they expect from "重新编辑".
    // 附件消息:回填纯文本(displayText,去掉 @path 附件标签)而非含 @path 的 outbound(msg.text),
    // 并把原附件卡片数据一并带回,让输入框恢复成缩略图/文件名卡片(可删可再加),不再显示裸路径。
    const hasAttach = Array.isArray(msg.attachments) && msg.attachments.length > 0;
    const originalText = (hasAttach && msg.displayText !== undefined) ? msg.displayText : (msg.text || '');
    if (mode === 'edit' && (originalText || hasAttach)) {
      // Target THIS pane's composer only (key == its sessionQueueKey). The old
      // untargeted store write + broadcast filled EVERY split pane's input box.
      const targetKey = sel?.sessionId || `draft-${sel?.projectHash || 'none'}`;
      window.dispatchEvent(new CustomEvent('cgui:composer-fill', { detail: { text: originalText, targetKey, editMode: true, attachments: hasAttach ? msg.attachments : undefined } }));
      // 非破坏式(#4):只回填输入框 + 记录待回滚目标,绝不在此刻 trim/截断/还原文件。
      // 等用户真正点发送时(handleSend 拦截)才回退;按 Esc 取消则历史毫发无损。
      setPendingEditRollback({ msg, targetKey });
      return;
    }

    if (idxInChat === -1 && idxInStore === -1) {
      // 仍找不到目标消息:不能静默丢弃用户已编辑的重发文本(输入框已被 handleSend 清空)。
      // 有重发文本就当普通消息发出去,别让它凭空消失。透传 options(附件 meta 等)。
      const txt = typeof resendText === 'object' ? (resendText?.prompt) : resendText;
      const opts = typeof resendText === 'object' ? (resendText?.options || {}) : {};
      if (txt && handleSendRef.current) {
        setProviderSwitchNotice({ text: '未能定位原消息位置,已作为新消息发送(未裁剪历史)。' });
        setTimeout(() => handleSendRef.current(txt, opts), 50);
      }
      return;
    }

    // 1) git restore only for modes that explicitly include files.
    const shouldRestoreFiles = mode === 'both' || mode === 'edit';
    const checkpointSha = shouldRestoreFiles && sel?.sessionId && cwd ? await resolveCheckpointSha() : null;
    if (shouldRestoreFiles && !checkpointSha && !softFiles) {
      // 没有文件快照(非 git 项目 / 旧消息 / 快照丢失)不该让整个回退"没反应"——以前这里
      // alert + return,既不裁剪也不重发,用户关掉弹窗后什么都没发生。降级处理:跳过文件
      // 还原,继续裁剪会话并按 mode 重发 / 回填输入框,只用一条提示告知文件未动。
      setProviderSwitchNotice({ text: '未找到该消息的文件快照，已仅回退会话记录（项目文件未改动）。' });
    }
    if (shouldRestoreFiles && checkpointSha && sel?.sessionId && cwd) {
      // 还原失败最常见的就是这条消息发送前后没有任何被跟踪文件改动:shadow 仓库里
      // 那个 commit 是空树,`git checkout <sha> -- .` 报 pathspec 不匹配。这属于"本来
      // 就没文件要还原"而非真错,不该 alert+return 中断整个回退。降级:跳过文件还原,
      // 继续裁剪会话/重发,只用一条提示告知项目文件未动。
      const softDegrade = () => setProviderSwitchNotice({ text: '未找到该消息的文件快照，已仅回退会话记录（项目文件未改动）。' });
      try {
        const r = await fetch(`/api/checkpoints/${sel.sessionId}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha: checkpointSha, cwd }),
        });
        if (!r.ok) {
          // empty_checkpoint(快照本来就没文件)才说"文件未改动";restore_failed
          // (超时把 checkout 杀在半路等)可能已部分还原,如实提示别撒谎。
          const d = await r.json().catch(() => ({}));
          if (d.code === 'restore_failed') {
            setProviderSwitchNotice({ text: '文件还原过程出错，工作区可能已部分还原，请检查改动（会话已回退）。' });
          } else softDegrade();
        }
      } catch {
        softDegrade();
      }
    }

    // 2) trim on-disk jsonl so the resumed CLI doesn't see stale history.
    //    Strategy: prefer uuid match (historical store messages); fall back to
    //    timestamp for freshly-sent messages whose chat-user-<ts> uuid never
    //    landed in the jsonl (the CLI persists its own uuid but keeps the ts).
    let sessionWasReset = false;
    let trimFailed = false;
    if (sel?.sessionId && projectHash) {
      const body = msg.uuid && !msg.uuid.startsWith('chat-')
        ? { projectHash, uuid: msg.uuid }
        : { projectHash, fromTimestamp: msg.timestamp };
      try {
        const tr = await fetch(`/api/sessions/${sel.sessionId}/trim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const trData = await tr.json().catch(() => ({}));
        if (!tr.ok) trimFailed = true;
        // If trim wiped the session (no real messages would remain), we must
        // drop the sessionId locally — otherwise the next /api/chat would
        // try --resume on a deleted jsonl and CLI silently exits with
        // "No conversation found".
        if (trData?.sessionReset) {
          sessionWasReset = true;
          // sessionId 失效 → 切到 draft 态。但 permissionMode / model 的 per-session
          // pin 还在 modelBySession[oldSid] / permissionModeBySession[oldSid] 下,
          // 下一轮 getModelFor / getPermissionModeFor(`draft-...`) 会回退到全局默认
          // → 用户切到"接受编辑"后回滚到首条 → 模式被重置为"默认"(Bug #8)。
          // 把 pin 迁移到 draft key,保留用户的会话级设置。
          const draftKey = `draft-${sel.projectHash || 'none'}`;
          // force=true:当前会话的模型/模式选择必须覆盖 draft 残留,否则回滚首条后
          // 模型被重置(#5)。
          useStore.getState().migrateSessionKey(sel.sessionId, draftKey, true);
          setSelectedSession({
            ...sel,
            sessionId: null,
            draft: true,
            draftId: newDraftId(),
          });
        }
      } catch { trimFailed = true; }
    }
    // trim 失败(磁盘 jsonl 没裁)但 UI 已裁+即将重发 → 重发会落在未裁历史上、且
    // step5 refetch 把旧消息全拉回。如实告知,不再静默(对齐 CheckpointsPanel)。
    if (trimFailed && !sessionWasReset) {
      setProviderSwitchNotice({ text: '会话记录裁剪失败,回退可能不完整(磁盘历史未改动),建议新建会话继续。' });
    }

    // 3) abort any in-flight stream from this session so the resend doesn't
    //    collide with it.
    killedRef.current = true; // 编辑重发=停当前回合(POST /stop)→ finally 收后台化子代理
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
    if (activeProcRef.current) {
      // 编辑重发=全杀(hard):进程内存上下文与改写后的 jsonl 已分叉,留活任务会答非所问。
      fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hard: true }) }).catch(() => {});
      activeProcRef.current = null;
    }
    updateStreaming(false);
    setStreamingText('');
    setStreamingThinking('');
    setStreamingToolCalls([]);
    setStreamingBlocks([]);
    setStreamHistCutoff(null); // BF-1:流已中止,截断随之作废(重发会设新的)

    // 4) trim UI
    truncateUi();

    // 5) Re-fetch the (now-trimmed) message list so the UI mirrors disk —
    //    avoids any drift between in-memory slice and what the CLI will see.
    //    Skip when the session was reset: its jsonl is deleted, so re-fetching
    //    the now-stale sessionId 404s and blanks the (correctly draft) pane —
    //    that 404→empty is exactly the "回滚后所有消息消失" the user hit.
    if (!sessionWasReset && sel?.sessionId && projectHash) {
      try { await fetchMessagesForTab(sel.sessionId, projectHash, { silent: true }); } catch {}
    }

    // 6) act per mode
    if (mode === 'edit') return; // composer was filled at the top of this branch
    // mode === 'message' | 'both': 直接重发原文,等价于"重做本轮"。只有"编辑后重发"(edit)
    // 才回输入框等用户手改。两者区别仅在文件:'both' 已在上面还原快照,'message' 不动文件。
    if (originalText && handleSendRef.current) {
      setTimeout(() => {
        if (typeof resendText === 'object' && resendText) {
          handleSendRef.current(resendText.prompt || originalText, resendText.options || {});
        } else {
          handleSendRef.current(resendText || originalText);
        }
      }, 50);
    }
  }, [chatMessages, messages, fetchMessagesForTab, setLocalMessages, setSelectedSession, getLocalSession]);
  useEffect(() => { handleRollbackRef.current = handleRollback; }, [handleRollback]);
  // 切换会话时清掉待回滚 + 即时上下文用量 + 打开的子代理视图,避免泄漏到另一会话。
  useEffect(() => {
    setPendingEditRollback(null);
    // U2:draft→真 sessionId 的同会话升级也会触发本 effect(sessionId null→真 id),
    // 且 init/message_start 常在同一批 setState 里到达 —— 无守卫会把新会话首轮刚写入
    // 的 usage 又清掉(新会话徽章不显示的根因)。流归属仍是本会话时不清。
    if (streamOwnerKeyRef.current !== sessionQueueKey) setLiveContextUsage(null);
    useStore.getState().setViewingAgent(tabIndex, null);  // AZ6:只清本 tab,不动其它 pane
  }, [selectedSession?.sessionId, setPendingEditRollback, tabIndex]);

  // 编辑重发取消(#4):ChatInput 里按 Esc → 撤销待回滚(历史本就没动,纯清状态)。
  useEffect(() => {
    const onCancel = (e) => {
      const targetKey = e?.detail?.targetKey;
      const myKey = selectedSession?.sessionId || `draft-${selectedSession?.projectHash || 'none'}`;
      if (targetKey && targetKey !== myKey) return;
      setPendingEditRollback(null);
    };
    window.addEventListener('cgui:composer-cancel-edit', onCancel);
    return () => window.removeEventListener('cgui:composer-cancel-edit', onCancel);
  }, [selectedSession?.sessionId, selectedSession?.projectHash, setPendingEditRollback]);

  // Bug #6:重做一整轮 AI 回复。找 turn 之前最近的 user message,触发 handleRollback
  // (mode: 'message') — 等于 trim 到 user 之后 + 重发同一 prompt,让 AI 重新生成
  // (含重选/重调工具)。LLM 有随机性,不保证重做出"一模一样的工具序列",这是
  // 设计的:用户的诉求一般是"这轮回复(含工具调用)有问题,让 AI 换条路再试"。
  const handleRetryTurn = useCallback((turn) => {
    if (!turn || !turn.uuid) return;
    const all = [...messages, ...chatMessages];
    const turnIdx = all.findIndex((m) => m.uuid === turn.uuid);
    if (turnIdx === -1) return;
    let userMsg = null;
    for (let i = turnIdx - 1; i >= 0; i--) {
      if (all[i].type === 'user') { userMsg = all[i]; break; }
    }
    if (!userMsg) {
      confirmDialog('找不到该 AI 回复对应的用户消息,无法重做');
      return;
    }
    // 重做整轮:有文件快照就还原+重做;没有(非 git 项目/旧会话)则降级为只裁剪
    // 会话再重做,不能因为缺快照就 alert 中止(softFiles)。
    handleRollback(userMsg, { mode: 'both', softFiles: true });
  }, [messages, chatMessages, handleRollback]);

  const handleRetryTool = useCallback((turn, toolCall) => {
    if (!turn?.uuid || !toolCall?.id || !toolCall?.name) {
      confirmDialog('找不到该工具调用的 id，无法局部重做');
      return;
    }
    const sel = getLocalSession();
    const projectHash = sel?.projectHash || useStore.getState().selectedProject?.hash;
    if (!sel?.sessionId || !projectHash) {
      confirmDialog('缺少 sessionId 或 projectHash，无法局部重做工具');
      return;
    }

    // 乐观即时回退显示(只动显示,不动文件——按用户选择):立刻把展示内容裁到该
    // 工具调用之前,并给该 turn 打 _retryTrimToolId 标记,让 TurnBubble 在该工具处
    // 截断渲染 + 显示"正在重做此工具…"。随后服务端 trim + refetch 用真实裁剪结果
    // 覆盖,重跑以流式气泡出现在同一位置 → 读起来是"该工具在原位重跑",而非新发消息。
    {
      const curMsgs = getLocalMessages();
      const mi = curMsgs.findIndex((m) => m.uuid === turn.uuid);
      if (mi >= 0) {
        setLocalMessages([...curMsgs.slice(0, mi), { ...curMsgs[mi], _retryTrimToolId: toolCall.id }]);
        setChatMessages((prev) => prev.filter((m) => m.type === 'btw')); // 保留旁问气泡(本地注记)
      } else {
        setChatMessages((prev) => {
          const ci = prev.findIndex((m) => m.uuid === turn.uuid);
          return ci < 0 ? prev : [...prev.slice(0, ci), { ...prev[ci], _retryTrimToolId: toolCall.id }];
        });
      }
      setRetryActiveUuid(turn.uuid);  // 转圈指示器开;重跑内容一出现就清(下方 effect)
    }

    const input = JSON.stringify(toolCall.input || {}, null, 2).slice(0, 4000);
    const appendSystemPrompt = [
      'GUI 已把会话裁剪到某个工具调用之前。',
      `现在请重新执行 ${toolCall.name} 工具调用，并基于新的工具结果从当前位置继续。`,
      '不要重复已经保留在历史里的正文或更早的工具调用。',
      '如果原工具选择不合适，可以改用更合适的工具，但不要丢失原任务上下文。',
      '原工具输入如下：',
      '```json',
      input,
      '```',
    ].join('\n');
    (async () => {
      try {
        const tr = await fetch(`/api/sessions/${sel.sessionId}/trim-before-tool`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectHash, toolUseId: toolCall.id }),
        });
        const trData = await tr.json().catch(() => ({}));
        if (!tr.ok) throw new Error(trData.error || tr.status);

        killedRef.current = true; // 编辑重发(trim 分支)=停当前回合(POST /stop)→ finally 收后台化子代理
        if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
        if (activeProcRef.current) {
          // 编辑重发=全杀(hard):进程内存上下文与改写后的 jsonl 已分叉,留活任务会答非所问。
          fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hard: true }) }).catch(() => {});
          activeProcRef.current = null;
        }
        updateStreaming(false);
        setStreamingText('');
        setStreamingThinking('');
        setStreamingToolCalls([]);
        setStreamingBlocks([]);
        setStreamHistCutoff(null); // BF-1:同上,截断随中止的流作废
        try { await fetchMessagesForTab(sel.sessionId, projectHash, { silent: true }); } catch {}

        setTimeout(() => {
          handleSendRef.current?.(
            `<cgui-tool-retry tool="${toolCall.name}">继续</cgui-tool-retry>`,
            { appendSystemPrompt, hiddenUserMessage: true },
          );
        }, 50);
      } catch (err) {
        confirmDialog('工具局部重做失败：' + err.message);
        setRetryActiveUuid(null);  // 关指示器,避免失败后一直转
        // 乐观截断已改了显示;失败则刷新回真实状态,避免停在半截视图。
        try { await fetchMessagesForTab(sel.sessionId, projectHash, { silent: true }); } catch {}
      }
    })();
  }, [getLocalSession, fetchMessagesForTab, getLocalMessages, setLocalMessages]);

  // AZ11:给 memo 的 MessageList 传【引用稳定】的回调。原始 handleRollback/handleRetryTurn
  // 的 deps 含 messages/chatMessages → 流式中每 token 都会换新身份 → 直接传会让 memo
  // 每帧失效(=没 memo)。用 ref 包一层:身份恒定,内部调最新实现。
  const handleRetryTurnRef = useRef(null);
  useEffect(() => { handleRetryTurnRef.current = handleRetryTurn; }, [handleRetryTurn]);
  const handleRetryToolRef = useRef(null);
  useEffect(() => { handleRetryToolRef.current = handleRetryTool; }, [handleRetryTool]);
  const stableRetryTurn = useCallback((turn) => handleRetryTurnRef.current?.(turn), []);

  // /branch 分叉:从当前会话 fork 出一条新线,打开到本窗格,原会话不动。
  // 传 upToUuid(某条消息的 jsonl uuid)则【精确分叉】——新会话只保留到该消息所在回合
  // 为止的上下文,丢弃其后的对话,便于从中途换个方向重试。不传则整会话复制(在最后一条
  // 分叉即等价)。live/流式气泡的 uuid(streaming / chat-*)不在 jsonl 里,一律当整会话分叉。
  const forkCurrentSession = useCallback(async (upToUuid) => {
    const st = useStore.getState();
    const sess = st.paneSessions?.[tabIndex];
    if (!sess?.sessionId) { await confirmDialog('草稿会话尚未开始,无法分叉'); return; }
    const anchor = (typeof upToUuid === 'string' && !upToUuid.startsWith('chat-') && upToUuid !== 'streaming') ? upToUuid : null;
    try {
      const res = await fetch('/api/fork', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sess.sessionId, projectHash: sess.projectHash, ...(anchor ? { upToUuid: anchor } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.newSessionId) { await confirmDialog('分叉失败：' + (data.error || res.status)); return; }
      const fork = { sessionId: data.newSessionId, projectHash: sess.projectHash, projectPath: sess.projectPath, firstPrompt: sess.firstPrompt, model: sess.model };
      // 与侧栏分支按钮同待遇:标题「分支N」标识 + 继承 model/effort/权限。之前这里
      // 三样全缺 → 用户分不清窗口里是不是 fork(标题一模一样),列表也迟迟不出现。
      adoptFork(st, sess, data.newSessionId);
      if (tabIndex === 0 && st.paneCount === 1) st.setSelectedSession(fork);
      else st.setPaneSession(tabIndex, fork);
      // 锚点分叉的历史被截断,必须重拉;不拉的话窗格还挂着源会话的完整消息列表
      st.fetchMessages(data.newSessionId, sess.projectHash, { tab: tabIndex, silent: true });
      // 列表立刻可见:打包版禁用了文件 watcher,新 jsonl 不会自动触发侧栏刷新
      if (st.selectedProject?.hash === sess.projectHash) st.fetchSessions(sess.projectHash, { silent: true });
    } catch (e) { await confirmDialog('分叉失败：' + String(e.message || e)); }
  }, [tabIndex]);
  const stableRetryTool = useCallback((turn, toolCall) => handleRetryToolRef.current?.(turn, toolCall), []);
  const stableRollback = useCallback((msg, opts) => handleRollbackRef.current?.(msg, opts), []);

  // In split mode, tab 0's `loading` would otherwise blank out tab 1 too.
  // We only let the loading screen short-circuit the primary tab — tab 1
  // fetches with silent:true so it never sets the global flag, and tab 0
  // remains the one that owns the spinner.
  if (!selectedSession) return <EmptyState tabIndex={tabIndex} />;
  if (loading && tabIndex === 0) return (
    <div className="flex-1 flex items-center justify-center bg-canvas">
      <div className="flex gap-1.5">
        {[0, 0.2, 0.4].map((d) => (
          <div key={d} className="w-2 h-2 rounded-full bg-accent/40" style={{ animation: `breathe 1.4s ease-in-out infinite ${d}s` }} />
        ))}
      </div>
    </div>
  );

  // C1:流式缓冲(chatMessages)只在它归属当前查看的会话时才计入统计/渲染 —— liveVisible
  // 与 visibleChat 已上移到 currentTodos 之前(串扰窗口2,hook 区),这里直接使用。
  // BF-1:展示口径统一走 finalizedMessages(=visibleMessages 再补历史中断态,活跃流
  // 期间剔除本回合半成品),回合进度条/成本等派生统计与消息列表同源。
  const allMessages = [...finalizedMessages, ...visibleChat];
  // 右侧回合进度条数据:每个用户回合一个点(摘要取去附件后的显示文本)。
  // 注意:必须是普通计算,不能用 useMemo —— 这里在 SessionDetail 的早返回
  // (if loading && tabIndex===0 return)之后,加 hook 会导致切换会话(loading 切换)时
  // "Rendered fewer hooks than expected" 崩溃白屏。TurnScrubber 的 measure 已用 turnsRef
  // 稳定,不依赖 userTurns 引用,所以这里每帧新建数组无性能问题。
  const userTurns = allMessages
    .filter((m) => m.type === 'user' && m.uuid)
    .map((m) => ({ uuid: m.uuid, text: m.displayText || m.text || '', ts: m.timestamp }));
  // 用量汇总:优先取服务端聚合(usageTotals,jsonl 全文件按 message.id 去重逐条求和的
  // 地面真值口径),前端只叠加尚未落盘的流式回合(chatMessages,条数很小)——避免几千条
  // 历史消息每帧全量 reduce。无服务端聚合时(端点旧形态/加载失败)回退全量 reduce。
  // 注意:流式回合的 m.usage 来自 result 事件(整轮消耗累加口径),对"累计消耗"求和是
  // 对的口径;回合落盘 refetch 后即被服务端聚合替换。上下文徽章仍走单次调用口径,别混。
  const totalTokens = (() => {
    const acc = serverUsageTotals
      ? { ...serverUsageTotals }
      : messages.reduce((a, m) => {
          if (m.usage) {
            a.input += m.usage.input_tokens || 0; a.output += m.usage.output_tokens || 0;
            a.cacheRead += m.usage.cache_read_input_tokens || 0; a.cacheCreation += m.usage.cache_creation_input_tokens || 0;
          }
          return a;
        }, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    for (const m of (liveVisible ? chatMessages : [])) {
      if (m.usage) {
        acc.input += m.usage.input_tokens || 0; acc.output += m.usage.output_tokens || 0;
        acc.cacheRead += m.usage.cache_read_input_tokens || 0; acc.cacheCreation += m.usage.cache_creation_input_tokens || 0;
      }
    }
    return acc;
  })();
  // 总 token = 四字段之和;命中率 = 缓存命中 / 提示侧总量(输入+缓存命中+缓存写入)。
  const totalAllTokens = totalTokens.input + totalTokens.output + totalTokens.cacheRead + (totalTokens.cacheCreation || 0);
  const promptSideTokens = totalTokens.input + totalTokens.cacheRead + (totalTokens.cacheCreation || 0);
  const cacheHitPct = promptSideTokens > 0 ? (totalTokens.cacheRead / promptSideTokens) * 100 : 0;
  const usageDetailTitle = `输入 ${totalTokens.input.toLocaleString()} · 输出 ${totalTokens.output.toLocaleString()} · 缓存命中 ${totalTokens.cacheRead.toLocaleString()} · 缓存写入 ${(totalTokens.cacheCreation || 0).toLocaleString()}
总 token = 四项之和;命中率 = 缓存命中 / (输入 + 缓存命中 + 缓存写入)`;
  // Sum per-message cost. Skipping models we don't have prices for. Uses
  // currentProvider (subscribed above, before early returns) so cc switch
  // redirects (Claude → DeepSeek/MiMo) get the right backend price table.
  const totalCostUsd = allMessages.reduce((acc, m) => {
    if (m.usage && (m.model || currentProvider?.model)) {
      const c = computeCost(m.model, m.usage, currentProvider);
      if (c) acc += c.totalUsd;
    }
    return acc;
  }, 0);
  const toolCallCount = allMessages.reduce((acc, m) => acc + (m.toolCalls?.length || 0), 0);
  const models = [...new Set(allMessages.filter((m) => m.model).map((m) => m.model))];

  // Context-window fill of the LATEST turn (= what the next send carries), so
  // you can see how full the context is and when to /compact (#13). The prompt
  // size = input + cache_read + cache_creation of the most recent message that
  // has usage. Window is 1M when the active model has the [1m] beta suffix.
  // After /compact the jsonl keeps the PRE-compact turns (with their large
  // usage) — only their context is dropped on the next --resume. So scope the
  // "current context" lookup to messages AFTER the last compact divider;
  // otherwise reverse().find keeps returning the stale pre-compact usage for
  // several turns until enough new turns push it out (#2 的延迟根因).
  let lastCompactIdx = -1;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i]?.type === 'compact') { lastCompactIdx = i; break; }
  }
  const ctxScope = lastCompactIdx >= 0 ? allMessages.slice(lastCompactIdx + 1) : allMessages;
  // W8:server 现在区分两个口径 —— m.usage 是整轮累加(消耗口径,气泡用),
  // m.ctxUsage 是末次 API 调用的原始 usage(上下文口径,徽章必须用这个,
  // 否则 N 次调用的 cache_read 被累加 N 遍,徽章爆表)。
  // X2:ctxUsage 可能是【全零对象】(truthy!)——`ctxUsage || usage` 会被它短路,
  // 徽章恒 0。改为"ctxUsage 有效(非全零)才用,否则回退 usage",且有效性判断
  // 把 cache_creation 也计入(新会话首轮 usage 常常只有缓存写入)。
  const _usableCtx = (u) => u && ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)) > 0;
  const lastUsageMsg = [...ctxScope].reverse().find((m) => _usableCtx(m.ctxUsage) || _usableCtx(m.usage));
  const lastUsage = lastUsageMsg ? (_usableCtx(lastUsageMsg.ctxUsage) ? lastUsageMsg.ctxUsage : lastUsageMsg.usage) : null;
  // 优先用流式 result 的即时 usage(本轮刚结束就有,不等 jsonl refetch);没有则回退到
  // jsonl 解析出的最近一条 usage(加载历史会话时走这条)。(#5)
  const effectiveUsage = liveContextUsage || lastUsage;
  // V1:/context 实测值是权威分子 —— usage 是"上一次 API 调用收到的输入",会系统性
  // 低于"下一次发送的真实上下文"(工具结果/系统区增量等)。回合结束后台自动探测一次,
  // 实测比 live/jsonl 都新时直接用实测;之后有更新的流式 usage(新回合)再让位。
  const _liveTs = liveContextUsage?._ts || 0;
  const _jsonlTs = lastUsageMsg?.timestamp ? (Date.parse(lastUsageMsg.timestamp) || 0) : 0;
  // U3:分母 = 下一次发送将使用的模型(currentModel = pin → 代际戳之后的历史 → 全局,
  // 与发送解析完全一致)。[1m] 开关写入 pin,因此切换立即反映到徽章;
  // /context 实测过的窗口(ctxWindowBySession)是权威值,优先于按模型名猜测 ——
  // 之前"徽章显示 1M、点开 /context 却是 200k"的矛盾根因就是两套来源各算各的。
  // 显式 [1m] 后缀 > /context 实测缓存(实测可能是开 1m 之前测的) > 按名猜测。
  // (上移到分子之前,供下面的"usage 超窗 = 异常"健全性判断复用。)
  // 优先级:[1m] 显式 > 后端解析 resolvedWindow(与压缩联动同源;第三方按实抓/规则表/
  // 手填,盖 128K/256K/400K/1M 非两档谱系)> /context 实测 > 本地按名猜测(兜底)。
  // 【resolvedWindow 必须在 measuredCtx 之前】(判官抓):measuredCtx.windowTokens 来自
  // CLI /context 自报窗口,对第三方恰是它的 200K 默认假设(每会话首回合后台探测就会填充,
  // 常态路径),放前面会把更准的解析值压回 200K。官方场景 resolvedWindow 恒 null,自动
  // 落到 measuredCtx(CLI 对官方准确),无回归。
  const contextWindow = /\[1m\]/i.test(currentModel || '')
    ? 1_000_000
    : (resolvedWindow || measuredCtx?.windowTokens || nativeContextWindow(currentModel));
  const measuredFresh = measuredCtx && measuredCtx.totalTokens > 0 && measuredCtx.ts >= Math.max(_liveTs, _jsonlTs);
  // 单次调用的输入侧上下文(input+cache_read+cache_creation)物理上不可能超过上下文窗口
  // (一次能发的就是这么多)。若 usage 之和超窗,说明这条 usage 是异常累加/口径错误(实测
  // 部分第三方 provider 会冲到 200k 窗口的 2.5 倍)→ 判为不可信,不让它进徽章/触发 compact。
  const _usageSum = effectiveUsage
    ? (effectiveUsage.input_tokens || 0) + (effectiveUsage.cache_read_input_tokens || 0) + (effectiveUsage.cache_creation_input_tokens || 0)
    : 0;
  // Z1:官方端点单次调用物理上装不下超过名义窗口 → 超窗即累加错误,严守 1.05 天花板回退。
  // 第三方中转(providerHint≠anthropic)把模型名透传成 claude-* 但真实窗口更大(实测名义
  // 200k 可收 386k+),单次 ctxUsage 超名义窗口是【真·超窗】非 bug → 放宽到 ~1.2M 绝对上限
  // (覆盖所有真实窗口,仍挡得住整轮累加的爆表值),让徽章诚实显示 193% 而非回退到旧值。
  const _isThirdParty = !!(currentProvider?.providerHint && currentProvider.providerHint !== 'anthropic');
  const _saneCeil = _isThirdParty ? Math.max(contextWindow, 1_200_000) : contextWindow * 1.05;
  const _usageSane = _usageSum > 0 && _usageSum <= _saneCeil;
  const contextTokens = measuredFresh
    ? measuredCtx.totalTokens
    : (_usageSane
      ? _usageSum
      // usage 不可信或缺失(含 compact 收尾后本回合无 usage、后台 /context 探测要 5~30s 的空窗):
      // 回退到上次实测值(哪怕略旧),避免徽章爆表或整条消失(用户报告 #3),探测完成即刷新。
      : (measuredCtx?.totalTokens || 0));
  // I4:流式缓冲(chatMessages/streaming 气泡)只在它归属当前会话时显示。切到别的会话时
  // 隐藏(流仍在服务端跑,回到原会话或刷新后由 jsonl/reattach 呈现),不串到当前视图。
  // (liveVisible 已在上方 allMessages 处定义,统计与渲染同源,这里不再重复。)
  // BG2:不再把百分比截断到 100。第三方端点(模型名透传成 claude-* 但不强制该名义窗口)
  // 会让上下文真涨到 200k 窗口的 1.5~2.5 倍,CLI 自己的 /context 也照实报(如 386.7k/200k=193%)。
  // 截断成 100% 会和分子分母(387k/200k)自相矛盾、误导用户;直接显示真实占比更诚实,>100%
  // 即"已超出该模型名义窗口"的明确信号。tone(≥80 红)与 AutoCompactBanner(≥阈值)行为不变。
  const contextPct = contextTokens > 0 ? Math.round((contextTokens / contextWindow) * 100) : 0;
  const fmtTok = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
  const winLabel = contextWindow >= 1_000_000 ? '1M' : `${Math.round(contextWindow / 1000)}k`;

  // P1.2:会话头被收纳信息 → 徽章弹层。provider hint 文案与原行内 chip 同逻辑
  // (unknown 显 baseUrl hostname 而非丑的 "Unknown")。
  const providerHintLabel = currentProvider?.providerHint && currentProvider.providerHint !== 'anthropic'
    ? (currentProvider.providerHint === 'unknown'
      ? (() => { try { return new URL(currentProvider.baseUrl).hostname; } catch { return '自定义'; } })()
      : currentProvider.providerHint.charAt(0).toUpperCase() + currentProvider.providerHint.slice(1))
    : null;
  // 低危#3:第三方 provider + claude 系裸别名(sonnet/opus)→ 分母是本地默认猜测,
  // 真实窗口由中转服务商映射的后端模型决定。徽章追加提示,避免用户把 1M 分母当准数。
  const bareAliasWindowUnknown = _isThirdParty && isBareClaudeAlias(currentModel);
  const badgeInfo = {
    headerModel, models, toolCallCount,
    providerHintLabel, providerBaseUrl: currentProvider?.baseUrl || '',
    totalAllTokens, totalCostUsd, cacheRead: totalTokens.cacheRead, cacheHitPct, usageDetailTitle,
    bareAliasWindowUnknown,
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 glass-base relative">
      {/* ③ 背景层已升级为全局(见 App 根节点的 GlobalBackgroundLayer),此处不再各 pane
          单独渲染;pane 的 glass-base 半透明即透出全局背景。 */}
      {/* #9 子代理对话视图:覆盖在本 pane 之上,顶部面包屑可返回母会话。 */}
      {showAgentView && (
        <div className="absolute inset-0 z-40 flex flex-col bg-canvas">
          <SubagentView
            agentId={viewingAgentId}
            parentSessionId={selectedSession?.sessionId || null}
            parentTitle={(selectedSession?.sessionId
              && (useStore.getState().customTitles[selectedSession.sessionId]
                || useStore.getState().autoTitles[selectedSession.sessionId]))
              || selectedSession?.firstPrompt || '母会话'}
            onBack={() => useStore.getState().setViewingAgent(tabIndex, null)}
          />
        </div>
      )}
      {/* 窗内检索浮层(Cmd/Ctrl+F)+ 右侧回合进度条(子代理视图打开时不显示)。 */}
      {!showAgentView && searchOpen && (
        <ChatSearch containerRef={containerRef} onClose={() => setSearchOpen(false)} />
      )}
      {!showAgentView && (
        <TurnScrubber containerRef={containerRef} turns={userTurns} />
      )}
      {/* 旁问浮窗:右下角浮动小窗,把本会话 /btw 线程聚合成连续对话。z-46 高于子代理面板
          (z-40)故与之共存;suppressed=hasPendingInteraction 时让路授权/问题卡(收成浮标)。 */}
      <BtwWindow
        thread={visibleChat.filter((m) => m.type === 'btw')}
        onSend={sendBtw}
        onClearThread={() => setChatMessages((prev) => prev.filter((m) => !(m.type === 'btw' && m.ownerKey === sessionQueueKey)))}
        sessionKey={sessionQueueKey}
        paneIsActive={paneIsActive}
        suppressed={hasPendingInteraction}
        mobile={mobileChrome}
        openSignal={btwOpenSignal}
        toggleSignal={btwToggleSignal}
        onUnreadChange={setBtwUnread}
      />
      {!mobileChrome && <div className="glass-bar shrink-0 px-6 py-3 relative z-30">
        {/* Title row wraps when the pane is narrow or font is scaled up so
            the right-side stats/buttons drop to a second line instead of
            clipping the title. */}
        <div className="max-w-[var(--content-max)] mx-auto flex items-center justify-between gap-y-2 flex-wrap">
          <div className="min-w-0 flex-1">
            <EditableSessionTitle session={selectedSession} />
            <div className="flex items-center gap-3 mt-0.5 flex-wrap max-md:hidden">
              <span className="text-[10px] text-ink-faint font-mono flex items-center gap-1 shrink-0 whitespace-nowrap">
                <Hash size={10} />{selectedSession.sessionId?.slice(0, 8) || '新会话'}
              </span>
              <span className="text-[10px] text-ink-faint font-mono shrink-0 whitespace-nowrap">{messages.length + chatMessages.filter((m) => m.type !== 'btw').length} 条消息</span>
              {/* P1.2 徽章零态壳:有会话即渲染(不再 contextTokens>0 门控);统计/provider
                  hint/曾用模型收进弹层(badgeInfo),行内不再重复。 */}
              <span data-tour="ctx-badge" className="inline-flex shrink-0">
                <ContextBreakdownButton
                  contextTokens={contextTokens}
                  contextWindow={contextWindow}
                  contextPct={contextPct}
                  fmtTok={fmtTok}
                  winLabel={winLabel}
                  sessionId={selectedSession.sessionId}
                  projectHash={selectedSession.projectHash}
                  cwd={selectedSession.projectPath}
                  model={currentModel}
                  info={badgeInfo}
                />
              </span>
              {/* 活动告警:需要用户立即注意,保留行内不进弹层(收进"点开才见"=告警不可见)。 */}
              {hasPendingInteraction && (
                <span className="text-[10px] text-violet-600 font-body shrink-0 whitespace-nowrap animate-pulse"
                  title="存在等待你回应的选择/授权。token 已实时计入;你的答复将在模型下一次调用时计入上下文占用">
                  等待回应 · 答复后占用刷新
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 min-w-0 flex-wrap justify-end">
            {/* P1.2:导出 / Checkpoint 收进 ⋮(点击展开,组件原样复用)。 */}
            <SessionHeaderMore forceOpenSignal={rewindSignal}>
              <ExportSessionButton
                messages={[...messages, ...chatMessages]}
                title={(selectedSession?.sessionId
                  && (useStore.getState().customTitles[selectedSession.sessionId]
                    || useStore.getState().autoTitles[selectedSession.sessionId]))
                  || selectedSession?.firstPrompt || '会话'}
              />
              <CheckpointButton
                openSignal={rewindSignal}
                sessionId={selectedSession?.sessionId}
                cwd={selectedSession?.projectPath || selectedProject?.path}
                projectHash={selectedSession?.projectHash}
                onRestored={() => {
                  // #1:恢复 checkpoint 后重载本会话消息,让消息页跟着回到该时刻(裁剪在 restore 内做)。
                  const s = getLocalSession();
                  if (s?.sessionId && s?.projectHash) fetchMessagesForTab(s.sessionId, s.projectHash, { silent: true });
                }}
              />
            </SessionHeaderMore>
          </div>
        </div>
      </div>}

      {/* Mobile: compact stats strip (model · context · cost). The desktop title
          block above is skipped on phones (!mobileChrome), so surface the key
          numbers here — same data the desktop header shows beside the title. */}
      {mobileChrome && (headerModel || contextTokens > 0 || totalCostUsd > 0) && (
        <div className="glass-bar shrink-0 px-3 py-1.5 flex items-center gap-x-2 gap-y-1 flex-wrap text-[10px] font-mono border-b border-canvas-deep/40 relative z-30">
          {headerModel && <ModelBadge model={headerModel} compact />}
          {contextTokens > 0 && (
            <ContextBreakdownButton
              contextTokens={contextTokens}
              contextWindow={contextWindow}
              contextPct={contextPct}
              fmtTok={fmtTok}
              winLabel={winLabel}
              sessionId={selectedSession.sessionId}
              projectHash={selectedSession.projectHash}
              cwd={selectedSession.projectPath}
              model={currentModel}
            />
          )}
          <span className="text-ink-faint" title={usageDetailTitle}>{totalAllTokens.toLocaleString()} tok</span>
          {totalTokens.cacheRead > 0 && (
            <span className="text-ink-ghost" title={usageDetailTitle}>命中率 {cacheHitPct.toFixed(1)}%</span>
          )}
          {totalCostUsd > 0 && <span className="text-accent/80">· {formatCost(totalCostUsd)}</span>}
        </div>
      )}

      {/* P2.5 横幅单条化(降级预案:三横幅保持独立组件,只做同帧单显仲裁)——
          同一时刻最多渲染一条,优先级:超窗恢复(错误) > 切换通知(5s 自消) > 规划
          模式提示(常驻可关)。低优先级横幅被压制期间条件仍在则待高优先级消失后自然
          回显;providerSwitchNotice 的 5s 计时独立运行,压制期间到期即清(可接受)。 */}
      {/* Permission-mode hint banner — moved here from ChatInput so it sits
          directly under the session title. Banner is dismissible per-user. */}
      {!(ctxOverflow && ctxOverflow.ownerKey === sessionQueueKey) && !providerSwitchNotice && (
        <PermissionModeHintBanner permKey={sessionQueueKey} />
      )}

      {/* git-init 提示只在「项目头部」(侧栏)渲染一处(见 GitInitBanner @ 项目面板),
          这里不再重复挂载——两处同时显示同一提示且状态不同步(忽略/init 后只更新
          自己那份),造成重复+脱节。项目头部那处触发更早(选中项目即检测,空状态也覆盖)。 */}

      {/* Provider-switch notice — fades after 5s. Tells the user we just
          stripped thinking blocks from on-disk jsonl so cc switch's new
          backend won't reject the resumed history. */}
      {!(ctxOverflow && ctxOverflow.ownerKey === sessionQueueKey) && providerSwitchNotice && (
        <div className="shrink-0 mx-6 mt-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 flex items-start gap-2 animate-fade-up">
          <span className="text-amber-700 text-[12px] font-body leading-snug flex-1">
            🔄 {providerSwitchNotice.text}
          </span>
          <button
            onClick={() => setProviderSwitchNotice(null)}
            className="text-amber-600 hover:text-amber-800 text-[14px] leading-none px-1"
            title="关闭"
          >×</button>
        </div>
      )}

      {/* 第三方 provider 上下文达阈值时的 GUI 侧压缩建议横幅(原生 auto-compact 对第三方
          不可靠;GUI 只提示,由用户点击确认才 /compact,绝不自动触发)。 */}
      <AutoCompactBanner
        key={selectedSession.sessionId || 'draft'}
        contextPct={contextPct}
        idle={!isStreaming && !compacting}
        enabled={paneIsActive && !!(currentProvider?.providerHint && currentProvider.providerHint !== 'anthropic') && !!selectedSession.sessionId}
        onCompact={() => handleSend('/compact')}
      />

      {/* G4:上下文超窗 / compact 失败(413) 的恢复引导。带操作按钮,不自动重试。
          串扰#8:按归属门控,只在触发它的会话下显示(切会话不残留,不搞异步清理)。 */}
      {ctxOverflow && ctxOverflow.ownerKey === sessionQueueKey && (
        <div className="shrink-0 mx-6 mt-2 px-3 py-2.5 rounded-md bg-red-50 border border-red-200 animate-fade-up">
          <div className="text-red-700 text-[12px] font-body leading-snug mb-2">
            ⚠️ {ctxOverflow.wasCompact ? '/compact 失败' : '上下文超出模型窗口'}：
            {ctxOverflow.limit
              ? `当前对话 ${Math.round(ctxOverflow.used / 1000)}k tokens，已超过该模型的真实上下文窗口 ${Math.round(ctxOverflow.limit / 1000)}k。`
              : '当前对话已超过模型上下文上限，'}
            {ctxOverflow.wasCompact ? '压缩需要把整段对话发给模型做摘要，请求本身也超限，所以压缩无法执行。' : '上游拒绝了整个请求。'}
            {ctxOverflow.limit && ctxOverflow.limit < 190000 ? (
              <span className="block mt-1">
                该第三方模型窗口（{Math.round(ctxOverflow.limit / 1000)}k）远小于官方 200k——CLI 按 200k 估算，自动压缩不会提前触发，长对话或多工具回合会在中途突然超限，且此时压缩多半也救不回。长任务建议换窗口更大的模型或档位；用这个模型时尽量勤开新会话。
              </span>
            ) : null}
            选择下面任一方式恢复：
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!ctxOverflow.has1m && (
              <button
                onClick={() => {
                  const base = String(currentModel || '').replace(/\[1m\]/i, '');
                  if (base) useStore.getState().setModelFor(sessionQueueKey, base + '[1m]');
                  setCtxOverflow(null);
                  setProviderSwitchNotice({ text: '已切到 1M 上下文模型，可继续对话或重试 /compact。' });
                }}
                className="px-2.5 py-1 rounded text-[12px] font-medium text-white bg-red-600 hover:bg-red-700"
                title="给当前模型加 [1m] 后缀，窗口扩到 1M（需 provider 支持）"
              >切 1M 上下文模型</button>
            )}
            <button
              onClick={() => {
                const _s = getLocalSession();
                if (_s) {
                  useStore.getState().migrateSessionKey?.(_s.sessionId || '', `draft-${_s.projectHash || 'none'}`);
                  setSelectedSession({ ..._s, sessionId: null, draft: true, draftId: newDraftId() });
                }
                setChatMessages([]);
                // 转 draft 必清 pane 历史归属(claimPaneMessages 契约自守是兜底,这里是正路)
                useStore.getState().setPaneMessages(tabIndex, []);
                setCtxOverflow(null);
              }}
              className="px-2.5 py-1 rounded text-[12px] font-medium text-red-700 border border-red-300 hover:bg-red-100"
              title="在同项目新建一个空会话"
            >新建会话</button>
            <span className="text-[11px] text-red-600/80">或：把鼠标悬停到较早的消息上 → 回滚，删除最旧的对话轮次后再继续。</span>
            <button onClick={() => setCtxOverflow(null)} className="ml-auto text-red-500 hover:text-red-700 text-[14px] leading-none px-1" title="关闭">×</button>
          </div>
        </div>
      )}

      {/* wrapper:让"回到底部"按钮锚定消息区底部(而非猜输入框高度的 bottom-24)——
          输入框高度可变(多行/任务清单/附件),固定偏移总有挡住输入框的时候 */}
      <div className="flex-1 min-h-0 relative">
      <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto relative z-10">
          {visibleMessages.length === 0 && visibleChat.filter((m) => m.type !== 'btw').length === 0 ? (
            <div className="mobile-draft-empty flex items-center justify-center h-full text-ink-muted text-sm font-body">
              {selectedSession?.draft ? '开始你的第一条消息 ↓' : '该会话没有可显示的消息'}
            </div>
          ) : (
            <>
              <MessageList
                messages={finalizedMessages}
                onRetryTurn={stableRetryTurn}
                onRetryTool={stableRetryTool}
                onRollback={stableRollback}
                onFork={forkCurrentSession}
                retryActiveUuid={retryActiveUuid}
              />
              {/* btw 旁问不再进主流内联渲染 —— 改由右下角 BtwWindow 浮窗聚合成连续线程。 */}
              {visibleChat.filter((msg) => msg.type !== 'btw').map((msg, i) => (
                <div key={msg.uuid || i} data-turn-uuid={msg.uuid} data-turn-role={msg.type}>
                  {msg.type === 'compact'
                    ? <CompactDivider />
                    : msg.type === 'turn'
                    ? <>
                        <TurnBubble turn={msg} onRetry={handleRetryTurn} onRetryTool={(toolCall) => handleRetryTool(msg, toolCall)} retryActive={retryActiveUuid === msg.uuid} />
                        {/* 鉴权类错误 turn 的动作链接:打开顶栏 Provider 弹层核对 key/渠道
                            (cgui:open-provider → 顶栏 ProviderSwitcher 单实例)。
                            手机布局无该弹层(走 MobileMenu Provider 分页),隐藏按钮避免死点。 */}
                        {msg.errorAction === 'provider' && !mobileChrome && (
                          <div className="px-4 pb-2 -mt-1">
                            <button
                              onClick={() => window.dispatchEvent(new CustomEvent('cgui:open-provider'))}
                              className="px-3 py-1.5 rounded-lg border border-canvas-deep bg-canvas-warm text-[12px] text-accent font-body hover:border-accent/40 transition-colors">
                              检查 Provider 设置
                            </button>
                          </div>
                        )}
                      </>
                    : <MessageBubble message={{ ...msg, role: msg.type }}
                        onRollback={msg.type === 'user' ? handleRollback : undefined} />}
                </div>
              ))}
              {/* reattach(切走再切回)不画流式气泡:同一段内容已经完整留在上面的历史卡里,
                  再画一遍就是用户看到的"一条回复被拆成两个气泡 + 中间内容重复"。改由历史卡
                  单一来源渲染(流式事件降级成历史刷新触发器,见 refreshHistIfDue)。 */}
              {liveVisible && isStreaming && !reattachStream && (streamingText || streamingThinking || streamingToolCalls.length > 0 || streamingBlocks.some((b) => (b?.content?.length > 0) || b?.toolCall)) && (
                <>
                  {/* 动效统一:气泡在前(头像 ✻ 呼吸),状态文字行随内容之后,
                      不再让独立的 LoadingMark 与完成后的静态头像形成两套视觉物 */}
                  <TurnBubble turn={{
                    uuid: 'streaming', type: 'turn', timestamp: new Date().toISOString(), model: streamingModel,
                    text: streamingText ? [streamingText] : [],
                    thinking: streamingThinking ? [streamingThinking] : [],
                    toolCalls: streamingToolCalls.map((tc) => ({ ...tc, category: 'call' })),
                    blocks: streamingBlocks,
                    usage: null,
                  }} />
                  <StreamingStatusLine
                    thinking={streamingThinking}
                    text={streamingText}
                    toolCalls={streamingToolCalls}
                    streamStart={streamStartRef.current}
                  />
                </>
              )}
              {/* Connecting 占位:仅在「没有任何可见内容」时显示(空占位 block 不算)。
                  之前误用 streamingBlocks.length===0,而 content_block_start 一开始就
                  push 空 block→占位符消失但内容又没来→空白无动画(回归)。改用 .some
                  判断真正有内容的 block,和上面的回复气泡严格互斥,不再跳位也不再空白。*/}
              {/* reattach 同样不显示 Connecting:重放的首批 content_block_delta 找不到
                  detach 前就被消费掉的 content_block_start,会被丢弃 → 占位一直挂着,
                  就是用户看到的"切回先闪一段 Connecting"。 */}
              {liveVisible && isStreaming && !reattachStream && !streamingText && !streamingThinking && streamingToolCalls.length === 0 && !streamingBlocks.some((b) => (b?.content?.length > 0) || b?.toolCall) && (
                // 头像位统一用官方 Claude logo(ProviderAvatar,与完成后气泡头像同一视觉物),
                // 加载时 thinking 呼吸、完成静止 —— 一致不割裂(用户明确"用左上角 logo 做头像")。
                // 主题里选的加载动画作为状态行的小指示器(下面 Connecting 前),选择仍可见。
                <div className="px-6 py-4 animate-fade-in">
                  <div className="max-w-[var(--content-max)] mx-auto flex items-start gap-4">
                    <ProviderAvatar model={streamingModel} size={34} thinking />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-h-[34px] text-[13px] font-body" style={{ color: '#D97757' }}>
                        <LoadingMark size={15} />
                        <span className="font-mono font-medium">{compacting ? 'Compacting' : 'Connecting'}</span>
                        <span>…</span>
                        <ElapsedTime startedAt={streamStartRef.current} className="ml-1" />
                      </div>
                      {/* 压缩进行中:不确定态动画条(SDK 无真实百分比)。 */}
                      {compacting && <CompactProgressBar />}
                      {contextTokens > 100_000 && (
                        <div className="text-[11px] text-ink-faint font-body mt-1">
                          上下文较大({Math.round(contextTokens / 1000)}k)，首字可能较慢；若长时间无响应,可点停止后 <code className="font-mono">/compact</code> 压缩或换 provider。
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {/* reattach 唯一的活体指示:气泡与 Connecting 都关掉了,只留这一行状态
                  (在做什么 + 已用时长),否则历史卡两次刷新之间界面完全静止,像卡死。 */}
              {liveVisible && isStreaming && reattachStream && (
                <StreamingStatusLine
                  thinking={streamingThinking}
                  text={streamingText}
                  toolCalls={streamingToolCalls}
                  streamStart={streamStartRef.current}
                />
              )}
              {/* 等待状态行(G):压缩中/API 重试/限流等待的明确说明。与 StreamingStatusLine
                  并存不互斥:那行说"正在产出什么",这行说"为什么在等"。缩进对齐正文列。 */}
              {liveVisible && isStreaming && liveStatus && (
                <div className="px-6 -mt-1 pb-3 animate-fade-in">
                  <div className="max-w-[var(--content-max)] mx-auto flex items-center gap-2 pl-[50px] text-[12px] text-ink-faint font-body">
                    <Loader2 size={11} className="animate-spin shrink-0 text-amber-600" />
                    <span>{liveStatus.text}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

      {!autoScroll && (
        // 居中悬在消息区底沿 = 输入框正上方,由 wrapper 锚定,不再依赖输入框高度猜测
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20">
          <button onClick={() => {
              // Scroll ONLY the messages container — scrollIntoView would scroll
              // every scrollable ancestor (incl. the root flex), shoving the
              // header off-screen and leaving a blank gap at the bottom (#16).
              const el = containerRef.current;
              if (el) { programmaticScrollRef.current = true; el.scrollTop = el.scrollHeight; }
              userScrolledAwayRef.current = false;  // AZ3:显式回到底部 → 恢复跟随
              setAutoScroll(true);
            }}
            className="bg-canvas border border-canvas-deep hover:bg-canvas-warm rounded-full p-2 shadow-sm transition-colors">
            <ChevronRight size={14} className="text-ink-muted rotate-90" />
          </button>
        </div>
      )}
      </div>

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        onStopBackground={stopSessionBackground}
        onAccelerate={messageQueue.length > 0 ? handleAccelerate : undefined}
        // H 转后台:仅本地前台流式时提供(backgroundPid-only 态已在后台,无意义)。
        onBackground={isStreaming ? handleBackgroundify : undefined}
        // A 输入预测:建议归属会话与当前查看会话匹配才显示,防切会话串窗;流式中不显示。
        suggestion={(!isStreaming && !backgroundPid && promptSuggestion
          && (promptSuggestion.sid === selectedSession?.sessionId || promptSuggestion.sid === sessionQueueKey))
          ? promptSuggestion.text : null}
        onDismissSuggestion={() => setPromptSuggestion(null)}
        disabled={false}
        // Composer treats "background CLI still running" the same as local
        // streaming for UI purposes: send button becomes the small rounded-
        // rect stop, banner shows "继续工作中…".
        isStreaming={isStreaming || !!backgroundPid}
        backgroundWorking={!isStreaming && !!backgroundPid}
        queueLength={messageQueue.length}
        queueItems={messageQueue}
        onRemoveFromQueue={(i) => useStore.getState().removeFromQueue(sessionQueueKey, i)}
        onEditFromQueue={(i) => {
          const item = messageQueue[i];
          if (!item) return;
          useStore.getState().removeFromQueue(sessionQueueKey, i);
          window.dispatchEvent(new CustomEvent('cgui:composer-fill', { detail: { text: item.text, targetKey: sessionQueueKey } }));
        }}
        todos={currentTodos}
        plan={currentPlan}
        permKey={sessionQueueKey}
        sessionId={selectedSession?.sessionId || null}
        tabIndex={tabIndex}
        onBtwOpen={(messages.length > 0 || selectedSession?.sessionId || paneCount <= 1) ? () => setBtwToggleSignal((n) => n + 1) : undefined}
        btwUnread={btwUnread}
      />
    </div>
  );
});

// (P2.0) ModelSelector / ProviderSwitcher / RemoteControlButton 已抽离到
// components/SessionSelectors.jsx(消循环 import,composer 与 App 共用)。

// P1.4 Provider 管理(设置→Provider tab)。原顶栏 ProviderSwitcher 弹层的管理段整体
// 迁到这里:增删改/测试/隐藏/批量删除/cc-switch 导入/默认模型·档位映射/OpenAI 模型多选,
// 一项不少;点行仍可切换。顶栏 ProviderSwitcher 瘦身为纯切换列表(见下),底部链到本页。
// Switching overwrites ~/.claude/settings.json with the chosen provider snapshot
// (server backs it up first); the file-watcher then broadcasts provider-change.
function ProviderManager({ initialEditId = null }) {
  const ms = useMultiSelect();
  const [providers, setProviders] = useState([]);
  // OpenAI-format providers (codex/opencode) — routed through the embedded
  // Anthropic↔OpenAI proxy on switch so the claude CLI can use them.
  const [openaiProviders, setOpenaiProviders] = useState([]);
  const [customProviders, setCustomProviders] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [switching, setSwitching] = useState(false);
  // Optimistic current id: the CC Switch db's is_current isn't updated by us
  // (we never write that db), so after a switch we mark the active one locally.
  const [activeId, setActiveId] = useState(null);
  // cc-switch providers can't be deleted from the read-only db, so "hiding" them
  // (server-persisted set of ids) is how a removal sticks. Custom providers are
  // truly deleted instead.
  const [hiddenProviders, setHiddenProviders] = useState(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const currentProvider = useStore((s) => s.currentProvider);

  const [importStatus, setImportStatus] = useState({ imported: true, ccSwitchAvailable: false, ccSwitchCount: 0 });
  const [importing, setImporting] = useState(false);
  const load = () => {
    fetch('/api/providers').then((r) => r.json()).then((d) => {
      setProviders(Array.isArray(d.providers) ? d.providers : []);
      setOpenaiProviders(Array.isArray(d.openaiProviders) ? d.openaiProviders : []);
      setCustomProviders(Array.isArray(d.customProviders) ? d.customProviders : []);
      setOverrides(d.overrides && typeof d.overrides === 'object' ? d.overrides : {});
    }).catch(() => {});
    fetch('/api/providers/import-status').then((r) => r.json())
      .then((d) => setImportStatus(d || {})).catch(() => {});
    fetch('/api/prefs/hidden-providers').then((r) => r.json())
      .then((d) => setHiddenProviders(new Set(Array.isArray(d.hidden) ? d.hidden : [])))
      .catch(() => {});
  };
  const importFromCCSwitch = async () => {
    setImporting(true);
    try {
      const r = await fetch('/api/providers/import-from-ccswitch', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '导入失败');
      load();
    } catch (e) { confirmDialog(`导入失败: ${e.message}`); }
    finally { setImporting(false); }
  };
  const persistHiddenProviders = (set) => {
    fetch('/api/prefs/hidden-providers', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: [...set] }),
    }).catch(() => {});
  };
  const toggleHideProvider = (id) => {
    setHiddenProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      persistHiddenProviders(next);
      return next;
    });
  };
  const removeCustom = async (id, name) => {
    if (!(await confirmDialog(`删除自定义 Provider「${name}」?`, { danger: true, confirmText: '删除' }))) return;
    // If this provider is open in the edit form, close it first — otherwise the
    // form lingers on a now-deleted target ("更新" would 404).
    setEditingProvider((cur) => (cur?.id === id ? null : cur));
    await fetch(`/api/custom-providers/${id}`, { method: 'DELETE' }).catch(() => {});
    load();
  };
  const [editingProvider, setEditingProvider] = useState(null);
  // 行内编辑直达(顶栏切换卡片每行的铅笔按钮):自定义项在列表加载后自动进编辑态;
  // 导入项(ccswitch/openai)的编辑内容(档位映射/模型管理)本就在行内展开,无需定位。
  // 每个 editId 只处理一次:列表刷新(import/provider-change 后的 load)会换 customProviders
  // 引用,不设闸会把用户正在编辑的表单反复重置(判官 S3)。
  const handledEditIdRef = useRef(null);
  useEffect(() => {
    // editId 清空(弹窗关闭)时复位闸:之后再次点同一行铅笔才能再进编辑态(判官 delta)。
    if (!initialEditId) { handledEditIdRef.current = null; return; }
    if (handledEditIdRef.current === initialEditId) return;
    const p = customProviders.find((x) => x.id === initialEditId);
    if (p) { handledEditIdRef.current = initialEditId; setEditingProvider(p); }
  }, [initialEditId, customProviders]);
  useEffect(() => {
    load();
    const onCh = () => load();
    window.addEventListener('cgui:provider-change', onCh);
    return () => window.removeEventListener('cgui:provider-change', onCh);
  }, []);

  // Always render — even with zero providers the panel still hosts the
  // "添加 Provider" form, so a fresh machine (no CC Switch, nothing added yet)
  // can set up its first provider.

  // 审计批挂账:isCur 兼配 dupOf 里的 id(raw 数组无 dupOf 时退化为原判定)。
  const isCur = (p) => rowIsCurrent(p, activeId);
  const cur = providers.find(isCur) || openaiProviders.find(isCur) || customProviders.find(isCur);
  // providerHint is lowercase server-side (pricing/compare logic depends on it),
  // so capitalize only for display.
  const capHint = (h) => (h ? h.charAt(0).toUpperCase() + h.slice(1) : h);

  const switchTo = async (id, model) => {
    setSwitching(true);
    try {
      const r = await fetch('/api/provider/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model ? { id, model } : { id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '切换失败');
      setActiveId(id);
      useStore.getState().clearModelOverrides?.();
      useStore.getState().fetchProvider?.();
      useStore.getState().fetchModel?.();
      // Notify ModelSelector et al. so their live-fetched catalogue re-keys to the
      // new provider instead of showing the previous provider's fetched models.
      window.dispatchEvent(new CustomEvent('cgui:provider-change'));
    } catch (e) {
      confirmDialog('切换 provider 失败：' + e.message);
    }
    setSwitching(false);
  };

  return (
    <div className="border border-canvas-deep rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-canvas-warm border-b border-canvas-deep">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body">Provider 管理 · 当前:{cur?.name || capHint(currentProvider?.providerHint) || '—'}</div>
            <p className="text-[10px] text-ink-faint font-body mt-1 leading-snug">
              借鉴 <a href="https://github.com/farion1231/cc-switch" target="_blank" rel="noreferrer" className="text-accent hover:underline">CC Switch</a>。切换会改写 <code className="font-mono">~/.claude/settings.json</code>（自动备份），<b>对新发的消息生效</b>。
            </p>
            <p className="text-[10px] text-ink-faint font-body mt-1 leading-snug border-t border-canvas-deep/40 pt-1">
              <b>原理(协议路由)</b>：和 <a href="https://github.com/farion1231/cc-switch" target="_blank" rel="noreferrer" className="text-accent hover:underline">cc-switch</a> 一样把 Claude 模型名映射到第三方。OpenAI 格式经本地代理 <code className="font-mono">8788</code> 做协议翻译、Anthropic 格式经 <code className="font-mono">8789</code> 透传换 token —— 都是<b>本机中转</b>，非直连官方。
            </p>
          </div>
          {/* 新增/编辑表单挂列表顶部:打开新增无需滚到底,点编辑也统一定位到顶部表单。 */}
          <CustomProviderForm
            editing={editingProvider}
            customCount={customProviders.length}
            onCancel={() => setEditingProvider(null)}
            onSaved={() => { setEditingProvider(null); load(); }}
            onDirtyChange={(d) => { window.__cguiProviderFormDirty = d; }}
          />
          {/* 修正批#6:单一列表(mergeProviderLists,与顶栏切换卡片同一数据选择器)——
              官方置顶、其余按名称序;来源(导入/自定义/代理)降为行内小徽章,不再分组。
              行内操作按来源:cc-switch/openai 导入项=隐藏;自定义=编辑/删除(+批量)。 */}
          {(() => {
            // 审计批挂账:非 showHidden 时 hidden 传入选择器在合并前过滤(隐藏项不参与
            // 吞并/不进「含导入」徽章);showHidden 时不过滤,隐藏行以半透明展示可恢复。
            const rows = mergeProviderLists({ providers, openaiProviders, customProviders, hidden: showHidden ? null : hiddenProviders });
            const hasCustom = customProviders.length > 0;
            return (<>
              <div className="px-3 pt-2 pb-1 border-t border-canvas-deep flex items-center gap-1">
                <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body flex-1">
                  全部 Provider <span className="text-ink-ghost normal-case tracking-normal">· 点击即切换</span>
                </div>
                {hasCustom && <SelModeToggle selMode={ms.selMode} onToggle={() => (ms.selMode ? ms.exit() : ms.enter())} size={12} />}
              </div>
              {ms.selMode && hasCustom && (
                <BatchBar count={ms.count} busy={ms.busy} noun="个 Provider" onExit={ms.exit}
                  allIds={customProviders.map((p) => p.id)} onSetAll={ms.setAll} selectedSet={ms.selected}
                  onDelete={async () => {
                    const res = await ms.runDelete(
                      (id) => fetch(`/api/custom-providers/${id}`, { method: 'DELETE' }).then((r) => { if (!r.ok) throw new Error('删除失败'); }),
                      { noun: '个 Provider', nameOf: (id) => customProviders.find((p) => p.id === id)?.name || id });
                    if (res) load();
                  }} />
              )}
              {rows.map((p) => (
                <div key={p.id} className={`px-3 py-1.5 ${isCur(p) ? 'bg-accent-subtle' : ''} ${hiddenProviders.has(p.id) ? 'opacity-50' : ''}`}>
                  <div className="flex items-center gap-1.5 group/prov">
                    {ms.selMode && p.source === 'custom' && (
                      <SelCheckbox checked={ms.selected.has(p.id)} onClick={() => ms.toggle(p.id)} size={13} />
                    )}
                    {/* Click to switch (default model). The full model list lives in
                        the ModelSelector after switching. */}
                    {/* 低危#2:窄屏(322px 手机抽屉)徽章多时名称被 shrink-0 徽章挤没。
                        窄视口下让名称独占第一行(强制占满、全宽可读、极长才截断),模型数
                        /type/来源徽章换行到第二行。桌面弹窗在宽视口不触发,形态不变。
                        (注:类名写在下方 className,不写进本注释避免 JIT 误扫成全局工具类) */}
                    <button disabled={switching}
                      onClick={() => (ms.selMode && p.source === 'custom' ? ms.toggle(p.id) : switchTo(p.id))}
                      className={`flex-1 min-w-0 text-left flex items-center gap-2 max-md:flex-wrap ${switching ? 'opacity-50' : ''}`}>
                      <span title={p.name} className={`flex-1 min-w-0 max-md:!basis-full text-xs font-body truncate ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
                      {p.models?.length > 0 && <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.models.length} 模型</span>}
                      {p.source === 'custom' && p.type && <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.type}</span>}
                      <ProviderSourceBadge p={p} />
                      {isCur(p) && <Check size={12} className="text-accent shrink-0" />}
                    </button>
                    {/* 行内操作:hover 显现,减少常驻按钮噪音。 */}
                    {!ms.selMode && p.source === 'custom' && (<span className="flex items-center gap-0.5 opacity-0 group-hover/prov:opacity-100 group-focus-within/prov:opacity-100 max-md:opacity-100 transition-opacity shrink-0">
                      <button onClick={() => setEditingProvider(p)} title="编辑" className="p-0.5 text-ink-faint hover:text-accent"><Pencil size={12} /></button>
                      <button onClick={() => removeCustom(p.id, p.name)} title="删除" className="p-0.5 text-ink-faint hover:text-error"><Trash2 size={12} /></button>
                    </span>)}
                    {(p.source === 'ccswitch' || p.source === 'openai') && (
                      <button onClick={() => toggleHideProvider(p.id)} title={hiddenProviders.has(p.id) ? '取消隐藏' : '从列表隐藏'}
                        className="p-0.5 text-ink-faint hover:text-ink-muted shrink-0 opacity-0 group-hover/prov:opacity-100 group-focus-within/prov:opacity-100 max-md:opacity-100 transition-opacity">
                        {hiddenProviders.has(p.id) ? <ArchiveRestore size={12} /> : <EyeOff size={12} />}
                      </button>
                    )}
                  </div>
                  {p.source === 'openai' && <OpenAIModelManager provider={p} onSaved={load} />}
                  {(p.source === 'ccswitch' || p.source === 'openai') && (
                    <ProviderOverrideEditor provider={p} override={overrides[p.id]} onSaved={load} />
                  )}
                </div>
              ))}
            </>);
          })()}
          {(() => {
            const hc = [...providers, ...openaiProviders].filter((p) => hiddenProviders.has(p.id)).length;
            return hc > 0 ? (
              <button onClick={() => setShowHidden((v) => !v)}
                className="w-full text-left px-3 py-1.5 text-[10px] text-ink-faint hover:text-ink-muted border-t border-canvas-deep font-body">
                {showHidden ? '收起已隐藏' : `显示 ${hc} 个已隐藏的 provider`}
              </button>
            ) : null;
          })()}
          {importStatus.ccSwitchAvailable && (
            <div className="px-3 py-2 border-t border-canvas-deep">
              <button onClick={importFromCCSwitch} disabled={importing}
                className="w-full text-[11px] px-2 py-1.5 rounded border border-canvas-deep hover:bg-canvas-warm text-ink-muted font-body disabled:opacity-50">
                {importing
                  ? '导入中…'
                  : importStatus.imported
                    ? `再次导入 cc-switch (${importStatus.ccSwitchCount} 项,去重补差)`
                    : `从 cc-switch 一次性导入 (${importStatus.ccSwitchCount} 项)`}
              </button>
            </div>
          )}
    </div>
  );
}

// 修正批#7:Provider 管理独立弹窗(桌面)。设置→Provider tab 已删,顶栏 Provider 切换
// 卡片底部「管理 Provider」经 cgui:open-provider-manager 事件打开本弹窗。ProviderManager
// 组件原样承载(零功能删减);手机端不走这里(合并入口页内推进到同一组件的全屏页)。
// 布局照 ShortcutsPanel:flex 列(头 shrink-0 / 正文 flex-1 min-h-0 overflow-y-auto),
// 不用 sticky(glass 动画残留 transform 会让 sticky 哑,memory 实证);Esc/点外关闭,
// 表单有未保存输入时先 confirmDialog(与原设置面板离开守卫同语义)。
function ProviderManagerModal({ open, onClose, editId = null }) {
  const tryClose = useCallback(async () => {
    if (window.__cguiProviderFormDirty) {
      const ok = await confirmDialog('Provider 表单有未保存的输入，关闭将丢弃。仍要关闭？', { danger: true, confirmText: '丢弃并关闭' });
      if (!ok) return;
      window.__cguiProviderFormDirty = false;
    }
    onClose();
  }, [onClose]);
  // Esc 捕获阶段拦截:阻断冒泡的「双击 Esc 停止流」监听(与 ShortcutsPanel 同手法)。
  useEffect(() => {
    if (!open) return;
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      tryClose();
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [open, tryClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in" onClick={tryClose}>
      <div
        className="glass-popover w-[720px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[min(85vh,calc(var(--app-h,100dvh)-3rem))] rounded-2xl shadow-2xl animate-glass-rise overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-canvas-deep shrink-0">
          <div className="text-[14px] font-display font-semibold text-ink">Provider 管理<span className="text-[11px] font-body font-normal text-ink-faint ml-2">增删改 / 测试 / 隐藏 / 导入 · 点行即切换</span></div>
          <button onClick={tryClose} className="p-1 rounded hover:bg-canvas-warm text-ink-faint hover:text-ink" title="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
          <ProviderManager initialEditId={editId} />
        </div>
      </div>
    </div>
  );
}

// 上下文用量徽章 → 可点击,弹出 /context 风格的分项明细(#1)。数据来自后端
// `/api/context/:sessionId`(对会话 fork 副本跑 /context 后解析,原会话不受影响)。
const CTX_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#a3a3a3'];
// P1.2:徽章升级为「会话信息徽章」。info(可选)= 被收纳的会话头信息(模型/曾用/provider
// hint/工具调用数/token/费用/缓存统计),进弹层顶部分区;零态壳(contextTokens=0,新会话/
// 首回合前)按钮显 ModelBadge+provider hint,占用数据到达后切回 xx k/窗口 xx% 显示。
function ContextBreakdownButton({ contextTokens, contextWindow, contextPct, fmtTok, winLabel, sessionId, projectHash, cwd, model, info = null }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [showMcp, setShowMcp] = useState(false);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  // AA1:后台探测(开会话/回合后)缓存的完整明细 —— 点开优先读它,秒显,不 spawn。
  const cachedBreakdown = useStore((s) => s.ctxBreakdownBySession[sessionId]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    // R1:window 捕获(同 ThemeToggle,详见那里注释);stopPropagation 仍挡住会话级停止监听。
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('click', onDocClick);
    window.addEventListener('keydown', onEsc, true);
    return () => {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, [open]);

  // 渲染后兜底钳制(回滚菜单同款):left=rLeft 是左对齐到按钮,而徽章位于右上统计区,
  // 340px 浮层易冲出右缘;窄屏/zoom 下 max-w 只收宽不挪 left,仍可能右溢。量真实矩形,
  // 任意方向越界就把 fixed left/top 拉回视口(视觉超出量 ÷ z 换算成布局px)。
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !coords) return;
    const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
    const m = menuRef.current.getBoundingClientRect();
    const pad = 8;
    let nl = coords.left, nt = coords.top;
    if (m.right > window.innerWidth - pad) nl -= (m.right - (window.innerWidth - pad)) / z;
    if (m.left < pad) nl += (pad - m.left) / z;
    if (m.bottom > window.innerHeight - pad) nt -= (m.bottom - (window.innerHeight - pad)) / z;
    if (m.top < pad) nt += (pad - m.top) / z;
    if (Math.abs(nl - coords.left) > 0.5 || Math.abs(nt - coords.top) > 0.5) {
      setCoords((c) => ({ ...c, left: nl, top: nt }));
    }
  }, [open, coords, data]);

  const load = async () => {
    if (!sessionId) { setErr('发送一条消息后才能查看明细'); setData(null); return; }
    setLoading(true); setErr('');
    try {
      // V2:把会话当前模型传给 /context —— 否则 CLI 按 settings.json 默认模型
      // (如 haiku)计算窗口并显示,与会话实际模型不符。
      const qs = new URLSearchParams({ cwd: cwd || '', projectHash: projectHash || '', model: model || '' });
      const r = await fetch(`/api/context/${sessionId}?${qs.toString()}`);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || '获取失败');
      setData(d);
      // U3/V1:把 CLI 实测的分子+分母回写为本会话徽章的权威值,徽章与明细从此一致。
      if (d?.windowTokens > 0) useStore.getState().setCtxMeasured(sessionId, { totalTokens: d.totalTokens || 0, windowTokens: d.windowTokens });
      useStore.getState().setCtxBreakdown(sessionId, d); // AA1:刷新缓存
    } catch (e) { setErr(e.message); setData(null); }
    setLoading(false);
  };

  const toggle = (e) => {
    e.stopPropagation();
    if (!open && wrapRef.current) {
      const r = wrapRef.current.getBoundingClientRect();
      const gap = 6;
      const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
      const visH = window.innerHeight / z;
      // getBoundingClientRect 是视觉px(×z),fixed 的 left/top 是布局px → r.* 需除以 z 折算
      // (与回滚菜单同一 zoom 坐标系修复)。否则 z>1 时弹层位置偏移/溢出。
      const rLeft = r.left / z, rTop = r.top / z, rBottom = r.bottom / z;
      const openBelow = (visH - rBottom) >= rTop;
      setCoords({ left: rLeft, top: openBelow ? rBottom + gap : rTop - gap, ty: openBelow ? '0' : '-100%' });
      // AA1:有后台缓存的明细就秒显,不再每次 spawn /context(5~30s)。无缓存才现算。
      if (cachedBreakdown?.categories?.length > 0) { setData(cachedBreakdown); setErr(''); }
      else load();
    }
    setOpen(!open);
  };

  const tone = contextPct >= 80 ? 'text-error bg-error-subtle'
    : contextPct >= 60 ? 'text-warning bg-warning/15'
    : 'text-ink-faint hover:bg-black/5';

  const cats = data?.categories || [];
  const totalForBar = data?.windowTokens || contextWindow || 1;

  const menu = open && coords && (
    <div
      ref={menuRef}
      style={{ position: 'fixed', left: coords.left, top: coords.top, transform: `translate(0, ${coords.ty})`, zIndex: 9999 }}
      className="glass-popover w-[340px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[80vh] overflow-y-auto py-2 animate-glass-rise"
    >
      <div className="px-3 pb-2 flex items-center gap-2 border-b border-black/5">
        <span className="text-xs font-medium text-ink font-body">{info ? '会话信息' : '上下文用量'}</span>
        {data?.model && <span className="text-[10px] text-ink-faint font-mono truncate max-w-[130px]" title={data.model}>{data.model}</span>}
        <button onClick={(e) => { e.stopPropagation(); load(); }} disabled={loading}
          className="ml-auto p-0.5 text-ink-faint hover:text-ink shrink-0" title="重新精确计算 /context（稍慢）">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* P1.2:会话头收纳区 —— 模型/曾用/provider hint/工具调用/token/费用/缓存统计。 */}
      {info && (
        <div className="px-3 py-2 border-b border-black/5 space-y-1.5">
          {info.headerModel && (
            <div className="flex items-center gap-2 text-[11px] font-body">
              <span className="text-ink-faint w-14 shrink-0">模型</span>
              <ModelBadge model={info.headerModel} compact />
              {(info.models || []).filter((m) => m !== info.headerModel).length > 0 && (
                <span className="text-[9px] text-ink-ghost font-mono truncate"
                  title={`本会话历史用过: ${(info.models || []).join(', ')}`}>
                  曾用 {(info.models || []).filter((m) => m !== info.headerModel).length} 个其他
                </span>
              )}
            </div>
          )}
          {info.providerHintLabel && (
            <div className="flex items-center gap-2 text-[11px] font-body">
              <span className="text-ink-faint w-14 shrink-0">Provider</span>
              <span className="text-[10px] text-warning bg-warning/15 border border-warning/30 rounded px-1.5 py-px font-mono"
                title={info.providerBaseUrl ? `cc switch 路由：${info.providerBaseUrl}` : undefined}>
                {info.providerHintLabel}
              </span>
            </div>
          )}
          {info.toolCallCount > 0 && (
            <div className="flex items-center gap-2 text-[11px] font-body">
              <span className="text-ink-faint w-14 shrink-0">工具调用</span>
              <span className="font-mono text-ink-muted">{info.toolCallCount} 次</span>
            </div>
          )}
          {/* 低危#3:第三方裸别名 → 分母为本地估算,实际窗口以服务商为准。点上方刷新
              可让上游 /context 实测校正。 */}
          {info.bareAliasWindowUnknown && (
            <div className="text-[10px] text-amber-700 font-body leading-snug">
              第三方中转下发裸别名,{winLabel} 分母为本地估算,实际窗口以服务商为准。
            </div>
          )}
          <div className="flex items-center gap-2 text-[11px] font-body" title={info.usageDetailTitle}>
            <span className="text-ink-faint w-14 shrink-0">累计 token</span>
            <span className="font-mono text-ink-muted">{(info.totalAllTokens || 0).toLocaleString()}</span>
            {info.totalCostUsd > 0 && (
              <span className="font-mono text-accent/80" title="按当前各模型官网价估算的累计费用（人民币，按 1 USD ≈ 7.2 CNY 换算）">
                · {formatCost(info.totalCostUsd)}
              </span>
            )}
          </div>
          {info.cacheRead > 0 && (
            <div className="flex items-center gap-2 text-[11px] font-body" title={info.usageDetailTitle}>
              <span className="text-ink-faint w-14 shrink-0">缓存命中</span>
              <span className="font-mono text-ink-muted">{info.cacheRead.toLocaleString()} · 命中率 {(info.cacheHitPct || 0).toFixed(1)}%</span>
            </div>
          )}
        </div>
      )}

      {loading && !data && <div className="px-3 py-6 text-center text-xs text-ink-faint">正在计算 /context…</div>}
      {err && !data && <div className="px-3 py-4 text-xs text-amber-700">{err}</div>}

      {data && (
        <div className="px-3 pt-2">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[11px] text-ink-muted font-mono">
              {fmtTok(data.totalTokens)} / {data.windowTokens >= 1_000_000 ? '1M' : Math.round(data.windowTokens / 1000) + 'k'}
            </span>
            <span className="text-[11px] font-mono text-ink-muted">{data.pct}%</span>
          </div>
          {/* BG2:超出名义窗口时给提示 —— 第三方端点常放宽 claude-* 模型名的窗口限制。 */}
          {data.totalTokens > data.windowTokens && (
            <div className="text-[10px] text-amber-700 font-body mb-2 leading-snug">
              已超出该模型名义窗口({data.windowTokens >= 1_000_000 ? '1M' : Math.round(data.windowTokens / 1000) + 'k'})。若用第三方端点,其实际可接受的上下文可能更大;否则建议 /compact 或换 provider。
            </div>
          )}
          {/* 分段进度条 */}
          <div className="h-2 w-full rounded-full bg-black/10 overflow-hidden flex mb-3">
            {cats.filter((c) => !/free space/i.test(c.name)).map((c, i) => (
              <div key={c.name} title={`${c.name}: ${fmtTok(c.tokens)}`}
                style={{ width: `${(c.tokens / totalForBar) * 100}%`, background: CTX_COLORS[i % CTX_COLORS.length] }} />
            ))}
          </div>
          <div className="space-y-1.5">
            {cats.map((c, i) => {
              const free = /free space/i.test(c.name);
              return (
                <div key={c.name} className="flex items-center gap-2 text-[11px] font-body">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: free ? 'transparent' : CTX_COLORS[i % CTX_COLORS.length], border: free ? '1px solid var(--color-ink-faint,#bbb)' : 'none' }} />
                  <span className={`flex-1 truncate ${free ? 'text-ink-faint' : 'text-ink'}`}>{c.name}</span>
                  <span className="font-mono text-ink-muted tabular-nums">{fmtTok(c.tokens)}</span>
                  <span className="font-mono text-ink-faint tabular-nums w-10 text-right">{c.pct}%</span>
                </div>
              );
            })}
          </div>

          {data.mcpServers?.length > 0 && (
            <div className="mt-3 pt-2 border-t border-black/5">
              <button onClick={() => setShowMcp((v) => !v)} className="w-full flex items-center justify-between text-[11px] text-ink-muted hover:text-ink font-body">
                <span>MCP 各服务 ({data.mcpServers.length})</span>
                <span className="font-mono">{showMcp ? '收起' : '展开'}</span>
              </button>
              {showMcp && (
                <div className="mt-1.5 space-y-1">
                  {data.mcpServers.map((s) => (
                    <div key={s.server} className="flex items-center gap-2 text-[11px] font-body">
                      <span className="flex-1 truncate text-ink-muted">{s.server}</span>
                      <span className="font-mono text-ink-faint tabular-nums">{fmtTok(s.tokens)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  // P1.2 零态壳:首回合前没有占用数据,徽章仍渲染(弹层可看会话信息),按钮显
  // ModelBadge + provider hint 代替 0/xx (0%) 的无意义数字。
  const zero = !(contextTokens > 0);
  return (
    <span ref={wrapRef} className="inline-flex shrink-0">
      <button
        onClick={toggle}
        className={`text-[10px] font-mono whitespace-nowrap px-1.5 py-px rounded transition-colors cursor-pointer inline-flex items-center gap-1 ${tone}`}
        title={(contextPct > 100
          ? `当前模型上下文窗口为 ${winLabel}，该会话已使用约 ${fmtTok(contextTokens)} —— 下一条消息发送将超出窗口，可能触发压缩或被上游拒绝。可切换更大窗口的模型，或手动 /compact 压缩。\n`
          : '') + (info?.bareAliasWindowUnknown
          ? `${winLabel} 分母为本地估算：第三方中转下发的是裸别名，实际窗口以服务商为准。\n`
          : '') + (info ? '点击查看会话信息与上下文分项明细（/context）' : '点击查看上下文分项明细（/context）')}
      >
        {zero
          ? (info?.headerModel
            ? (<><ModelBadge model={info.headerModel} compact />{info.providerHintLabel && <span className="text-amber-700">{info.providerHintLabel}</span>}</>)
            : '会话信息')
          : `${fmtTok(contextTokens)}/${winLabel} (${contextPct}%)`}
      </button>
      {createPortal(menu, document.body)}
    </span>
  );
}

// Full-screen password gate shown to EXTERNAL clients (phone over LAN/Tailscale)
// when a password is set. The Mac (loopback) never sees this. On success the
// server sets an HttpOnly cookie; we reload so WS + every fetch carry it.
function LoginScreen({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) { onSuccess(); return; }
      // 透传后端错误体:429 限速返回"尝试过多,请 N 秒后再试",一律显示"密码错误"会误导用户重试
      const j = await res.json().catch(() => null);
      setError(j?.error || '密码错误');
    } catch { setError('网络错误'); }
    finally { setBusy(false); }
  };
  return (
    // 手机批#1:100dvh/w-screen 在真机不可靠 —— ①dvh 不折算 html zoom(字体缩放时
    // 高度失真);②iOS 软键盘不缩 layout viewport,autoFocus 弹键盘后输入框被盖,
    // 视觉上"没居中"。改用与 mobile root 相同的 zoom 不变量 px(--app-w/--app-h,
    // 均在 auth 门控前的 effect 里就已写入)并减去 --kb(软键盘高),始终真居中。
    <div
      className="flex items-center justify-center bg-canvas px-6"
      style={{
        position: 'fixed', left: 0, top: 0,
        width: 'var(--app-w, 100vw)',
        height: 'calc(var(--app-h, 100dvh) - var(--kb, 0px))',
      }}
    >
      <form onSubmit={submit} className="w-full max-w-[320px] flex flex-col items-center gap-5">
        <div className="flex items-center gap-2">
          <span className="text-accent text-2xl leading-none font-mono">✻</span>
          <span className="text-xl font-display font-semibold text-ink tracking-tight">Claude Code</span>
        </div>
        <p className="text-[13px] text-ink-muted font-body text-center">远程访问需要密码</p>
        <input
          type="password" autoFocus value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="访问密码"
          className="w-full text-[15px] font-body rounded-xl border border-canvas-deep bg-canvas-warm px-4 py-3 text-ink focus:outline-none focus:border-accent"
        />
        {error && <span className="text-[12px] text-error font-body">{error}</span>}
        <button
          type="submit" disabled={busy || !password}
          className="w-full py-3 rounded-xl bg-accent text-on-accent font-body font-medium text-[15px] disabled:opacity-50 transition-opacity"
        >
          {busy ? '验证中…' : '进入'}
        </button>
      </form>
    </div>
  );
}

// ── Mobile menu (Claude-app style multi-level push navigation) ───
// Replaces the old cramped horizontal control strip. The phone's main view shows
// ONLY the current session; this panel slides in from the left and drills into
// sub-pages (会话/模型/外观/…) one screen at a time, so a control's options never
// overflow the viewport the way the desktop popovers (w-80 etc.) did.
function MobileMenuRow({ icon: Icon, label, value, onClick, danger = false, chevron = true, dot = false }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas-warm active:bg-canvas-deep/30 transition-colors">
      {Icon && <Icon size={18} strokeWidth={1.75} className={danger ? 'text-error' : 'text-ink-muted'} />}
      <span className={`flex-1 text-[14px] font-body truncate ${danger ? 'text-error' : 'text-ink'}`}>{label}</span>
      {/* 审计批A5:红点提醒(有可用更新等)。桌面 PanelDock 同语义。 */}
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0 animate-pulse" />}
      {value != null && value !== '' && (
        <span className="text-[12px] text-ink-faint font-body truncate max-w-[44%] text-right shrink-0">{value}</span>
      )}
      {chevron && <ChevronRight size={16} className="text-ink-ghost shrink-0" />}
    </button>
  );
}

function MobileSegmented({ options, onChange }) {
  return (
    <div className="flex items-center gap-1 rounded-xl bg-canvas-warm p-0.5">
      {options.map((o) => (
        <button key={String(o.value)} onClick={() => onChange(o.value)}
          className={`flex-1 flex items-center justify-center gap-1 py-2 rounded-lg text-[12px] font-body transition-colors ${
            o.active ? 'bg-accent text-on-accent shadow-sm' : 'text-ink-muted hover:text-ink'}`}>
          {o.icon && <o.icon size={13} />}{o.label}
        </button>
      ))}
    </div>
  );
}

function MobileModelPage({ permKey }) {
  const availableModels = useStore((s) => s.availableModels);
  const customModels = useStore((s) => s.customModels);
  const currentModel = useStore((s) => (permKey && s.modelBySession[permKey]) || s.currentModel);
  const [customInput, setCustomInput] = useState('');
  const [fetched, setFetched] = useState([]);
  const [fetchNote, setFetchNote] = useState('');
  const [fetching, setFetching] = useState(false);
  const [query, setQuery] = useState('');
  // The desktop ModelSelector normally fetches the model catalogue; it isn't
  // mounted on phones. 手机批#3:改用 store.fetchModel(同一份 /api/model 落库逻辑,
  // 含 providerName/defaultEffort),不再内联重复一份。
  useEffect(() => { useStore.getState().fetchModel(); }, []);
  const has1m = /\[1m\]/i.test(currentModel || '');
  const pick = (id) => {
    const base = id.replace(/\[1m\]/i, '');
    useStore.getState().setModelFor(permKey, has1m ? `${base}[1m]` : base);
  };
  const toggle1m = () => {
    const base = (currentModel || '').replace(/\[1m\]/i, '');
    if (!base) return;
    useStore.getState().setModelFor(permKey, has1m ? base : `${base}[1m]`);
  };
  const addCustom = (v) => { useStore.getState().addCustomModel(v); pick(v); };
  const doFetch = async () => {
    setFetching(true); setFetchNote('');
    try {
      const r = await fetch('/api/provider/fetch-models', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '拉取失败');
      setFetched(Array.isArray(d.models) ? d.models : []);
      setFetchNote(d.note || (d.models?.length ? `已拉取 ${d.models.length} 个` : '未返回模型'));
    } catch (e) { setFetchNote('拉取失败：' + e.message); }
    setFetching(false);
  };
  const q = query.trim().toLowerCase();
  const match = (id, name) => !q || id.toLowerCase().includes(q) || (name || '').toLowerCase().includes(q);
  const customRows = customModels
    .filter((id) => !availableModels.some((m) => m.id === id))
    .map((id) => ({ id, name: id.replace(/\[1m\]/i, ''), context1m: /\[1m\]/i.test(id) }));
  const fetchedRows = fetched
    .filter((id) => !availableModels.some((m) => m.id === id) && !customModels.includes(id))
    .filter((id) => match(id, id))
    .map((id) => ({ id, name: id }));
  return (
    <div className="py-1">
      <div className="px-4 py-2.5 border-b border-canvas-deep/40 space-y-2">
        <div className="flex gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型…"
            className="flex-1 bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-accent" />
          <button onClick={doFetch} disabled={fetching}
            className="px-3 py-2 text-[12px] border border-accent text-accent rounded-lg disabled:opacity-50 shrink-0">
            {fetching ? '拉取中…' : '拉取最新'}
          </button>
        </div>
        {/* 修正批#5:自定义模型 ID 输入框移到页顶(与桌面弹层一致),列表长了不用滚着找。 */}
        <div className="flex gap-2">
          <input value={customInput} onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { const v = customInput.trim(); if (v) { addCustom(v); setCustomInput(''); } } }}
            placeholder="自定义模型 ID…"
            className="flex-1 bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2 text-[13px] font-mono text-ink focus:outline-none focus:border-accent" />
          <button onClick={() => { const v = customInput.trim(); if (v) { addCustom(v); setCustomInput(''); } }}
            disabled={!customInput.trim()}
            className="px-3 py-2 text-[12px] bg-accent text-on-accent rounded-lg disabled:bg-canvas-deep disabled:text-ink-ghost">应用</button>
        </div>
        {fetchNote && <div className="text-[11px] text-ink-faint font-body">{fetchNote}</div>}
      </div>
      <button onClick={toggle1m}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas-warm transition-colors border-b border-canvas-deep/40">
        <span className="flex-1 text-[14px] font-body text-ink">1M 上下文</span>
        <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${has1m ? 'bg-accent text-on-accent' : 'bg-canvas-deep text-ink-faint'}`}>
          {has1m ? '已开启' : '关闭'}
        </span>
      </button>
      {availableModels.filter((m) => match(m.id, m.name)).map((m) => {
        const active = currentModel === m.id || currentModel === `${m.id}[1m]`;
        return (
          <button key={m.id} onClick={() => pick(m.id)}
            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas-warm transition-colors">
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-body text-ink truncate">{m.name}</div>
              <div className="text-[11px] text-ink-faint font-mono truncate">{m.source === 'cli-alias' ? '由 CLI 解析到当前 tier 最新' : m.id}</div>
            </div>
            {/* 同 SessionSelectors:空 tier 不渲染空药丸,选中行让位给勾 */}
            {m.tier && !active && (
              <span className="text-[10px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{m.tier}</span>
            )}
            {active && <Check size={16} className="text-accent shrink-0" />}
          </button>
        );
      })}
      {fetchedRows.map((m) => {
        const active = currentModel === m.id || currentModel === `${m.id}[1m]`;
        return (
          <button key={`f-${m.id}`} onClick={() => pick(m.id)}
            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas-warm transition-colors">
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-body text-ink truncate">{m.name}</div>
              <div className="text-[11px] text-ink-faint font-mono truncate">实时拉取</div>
            </div>
            {active && <Check size={16} className="text-accent shrink-0" />}
          </button>
        );
      })}
      {customRows.filter((m) => match(m.id, m.name)).map((m) => {
        const active = currentModel === m.id || currentModel === `${m.id}[1m]`;
        return (
          <div key={m.id} className="w-full flex items-center gap-3 px-4 py-3">
            <button onClick={() => pick(m.id)} className="flex-1 min-w-0 text-left">
              <div className="text-[14px] font-body text-ink truncate flex items-center gap-1.5">
                {m.name}
                <span className="text-[9px] px-1 py-px bg-accent-subtle text-accent rounded font-mono shrink-0">自定义</span>
              </div>
              <div className="text-[11px] text-ink-faint font-mono truncate">{m.id}</div>
            </button>
            {active && <Check size={16} className="text-accent shrink-0" />}
            <button onClick={() => useStore.getState().removeCustomModel(m.id)} title="移除"
              className="p-1.5 text-ink-faint hover:text-error shrink-0"><X size={16} /></button>
          </div>
        );
      })}
      {/* 修正批#5:原底部「自定义模型 ID」块已上移到页顶。 */}
    </div>
  );
}

function MobileEffortPage({ permKey }) {
  const effort = useStore((s) => (permKey && permKey in (s.effortBySession || {})) ? s.effortBySession[permKey] : s.effort);
  // 审计批C3:判据/文案与桌面 EffortSelector 对齐 —— openai 协议下映射为
  // reasoning_effort 照常可选;「默认」档 desc 按真实落点显示(设了全局跟随全局)。
  const openAIProtocol = useStore((s) => (s.currentProvider?.protocol || 'anthropic') === 'openai');
  const defaultEffort = useStore((s) => s.defaultEffort || '');
  return (
    <div className="py-1">
      <div className="px-4 pt-2 pb-1 text-[11px] text-ink-faint font-body">
        {openAIProtocol ? '推理力度 (reasoning_effort,不支持的端点自动降级) · ' : ''}作用于当前会话(每个会话独立记忆、互不影响)
      </div>
      {EFFORT_LEVELS.map((e) => {
        const desc = e.id !== '' ? e.desc
          : defaultEffort
            ? `跟随全局设置:${EFFORT_LEVELS.find((x) => x.id === defaultEffort)?.label || defaultEffort}`
            : '未设全局,由模型自适应';
        return (
        <button key={e.id || 'default'} onClick={() => useStore.getState().setEffortFor(permKey, e.id)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas-warm transition-colors">
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-body text-ink">{e.label}</div>
            <div className="text-[11px] text-ink-faint font-body">{desc}</div>
          </div>
          {effort === e.id && <Check size={16} className="text-accent shrink-0" />}
        </button>
        );
      })}
    </div>
  );
}

// 修正批#1b:MobilePermissionPage(手机菜单权限分页)已删除——权限模式唯一入口
// 改为 composer 工具行最左的模式按钮(桌面/手机同一颗,五档门控同一份),菜单里
// 再留一份就是双入口。

// 修正批#2:MobileAgentPage(手机端主控 agent 分页)已删除——主控 agent 前端入口
// 整体移除(用户拍板);store 与发送链能力保留(agent 化会话仍可由服务端/API 驱动)。

// B 方案: 对【任意】provider(含 cc-switch 只读 / openai marker 组)设「默认模型 +
// 档位映射(haiku/sonnet/opus/fable)」。options 来自该 provider 的 models[];不暴露 baseURL/key。
// 保存写 ~/.claude-gui/provider-overrides.json(PUT /api/provider-overrides/:id),不碰
// cc-switch.db。空选项 = 清除该档(回退选中模型),全空 = 删除该 provider 的 override。
// 模块级:避免在 ProviderOverrideEditor 渲染内联定义(否则每次 setState 重定义组件类型
// → 3 个 select 每次 remount)。
function OverrideSelect({ label, value, onChange, models }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] text-ink-faint font-body w-14 shrink-0">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 text-[11px] font-mono px-1.5 py-1 rounded border border-canvas-deep bg-canvas text-ink">
        <option value="">（选中模型）</option>
        {/* 防御:万一某 provider 的 models 是对象数组(如 /api/model 那样),取 .id 转字符串,
            绝不把对象当 React child 渲染(否则整页白屏,见 api-model 那次)。 */}
        {models.map((m) => { const s = typeof m === 'string' ? m : (m && m.id) || String(m); return <option key={s} value={s}>{s}</option>; })}
      </select>
    </label>
  );
}

function ProviderOverrideEditor({ provider, override, onSaved }) {
  const [open, setOpen] = useState(false);
  const models = provider.models || [];
  const ov = override || {};
  const [def, setDef] = useState(ov.defaultModel || '');
  const [tier, setTier] = useState({
    haiku: ov.tierModels?.haiku || '',
    sonnet: ov.tierModels?.sonnet || '',
    opus: ov.tierModels?.opus || '',
    fable: ov.tierModels?.fable || '',
  });
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const save = async () => {
    setBusy(true); setSaveMsg('');
    try {
      const tierModels = {};
      for (const t of ['haiku', 'sonnet', 'opus', 'fable']) if (tier[t]) tierModels[t] = tier[t];
      const r = await fetch(`/api/provider-overrides/${provider.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultModel: def || undefined,
          tierModels: Object.keys(tierModels).length ? tierModels : null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      // BG9:服务端若识别这是当前激活 provider,会自动重写 settings.json env(reapplied=true)
      // → 新会话立刻生效。否则提示用户:切回该 provider 时才生效。
      setSaveMsg(d?.reapplied ? '✓ 已保存并应用到当前 provider，新会话生效' : '✓ 已保存（切回该 provider 时生效）');
      setTimeout(() => { setSaveMsg(''); setOpen(false); onSaved?.(); }, 1500);
    } catch { setSaveMsg('保存失败'); }
    setBusy(false);
  };
  if (models.length === 0) return null; // 无可选模型 → 不显示(官方/无 _MODEL 列表)
  return (
    <div className="mt-1.5">
      <button onClick={() => setOpen((v) => !v)} className="text-[11px] text-accent font-body flex items-center gap-1">
        <Settings size={12} /> 默认模型·档位映射{open ? ' ▴' : ' ▾'}
      </button>
      {open && (
        <div className="mt-1.5 rounded-lg border border-canvas-deep p-2 space-y-1.5">
          <OverrideSelect models={models} label="默认模型" value={def} onChange={setDef} />
          <div className="border-t border-canvas-deep/40 pt-1.5 space-y-1.5">
            <OverrideSelect models={models} label="haiku" value={tier.haiku} onChange={(v) => setTier((s) => ({ ...s, haiku: v }))} />
            <OverrideSelect models={models} label="sonnet" value={tier.sonnet} onChange={(v) => setTier((s) => ({ ...s, sonnet: v }))} />
            <OverrideSelect models={models} label="opus" value={tier.opus} onChange={(v) => setTier((s) => ({ ...s, opus: v }))} />
            <OverrideSelect models={models} label="fable" value={tier.fable} onChange={(v) => setTier((s) => ({ ...s, fable: v }))} />
          </div>
          <button onClick={save} disabled={busy}
            className="w-full px-3 py-1.5 text-[12px] bg-accent text-on-accent rounded-lg disabled:opacity-50">
            {busy ? '保存中…' : '保存'}
          </button>
          {saveMsg && (
            <div className="text-[11px] font-body text-success mt-1 text-center">{saveMsg}</div>
          )}
        </div>
      )}
    </div>
  );
}

// Per-OpenAI-provider model manager: live-fetch the upstream's /v1/models and
// let the user multi-select which to show as switch targets. Selection persists
// server-side (~/.claude-gui/provider-models.json). `provider.models` is the
// current selection. onSaved() refreshes the parent list.
function OpenAIModelManager({ provider, onSaved }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState([]);
  const [checked, setChecked] = useState(() => new Set(provider.models || []));
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const load = async () => {
    setBusy('fetch'); setNote('');
    try {
      const r = await fetch('/api/provider/fetch-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: provider.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '拉取失败');
      setAll(d.models || []);
      setNote(d.models?.length ? `上游共 ${d.models.length} 个` : (d.note || '上游未返回模型'));
    } catch (e) { setNote('拉取失败：' + e.message); }
    setBusy('');
  };
  const toggleOpen = () => { const n = !open; setOpen(n); if (n && all.length === 0) load(); };
  const flip = (m) => setChecked((s) => { const n = new Set(s); n.has(m) ? n.delete(m) : n.add(m); return n; });
  const save = async () => {
    setBusy('save');
    try {
      await fetch(`/api/provider-models/${provider.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: [...checked] }),
      });
      // Refresh the model picker NOW: the backend just synced this provider's
      // openai-active.json snapshot (if it's the active one), so re-read /api/model
      // and notify listeners — otherwise the dropdown only updates after a re-switch.
      useStore.getState().fetchModel?.();
      window.dispatchEvent(new CustomEvent('cgui:provider-change'));
      setOpen(false); onSaved?.();
    } catch {}
    setBusy('');
  };
  // Union of fetched models and any already-selected ones not in the fetch.
  const list = [...new Set([...all, ...(provider.models || [])])];
  return (
    <div className="mt-1.5">
      <button onClick={toggleOpen} className="text-[11px] text-accent font-body flex items-center gap-1">
        <Cpu size={12} /> 管理模型(自动拉取·多选){open ? ' ▴' : ' ▾'}
      </button>
      {open && (
        <div className="mt-1.5 rounded-lg border border-canvas-deep p-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-ink-faint font-body">{busy === 'fetch' ? '拉取中…' : note}</span>
            <button onClick={load} disabled={!!busy} className="text-[10px] text-accent disabled:opacity-50">重新拉取</button>
          </div>
          <div className="max-h-44 overflow-y-auto space-y-0.5">
            {list.map((m) => (
              <label key={m} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-canvas-warm cursor-pointer">
                <input type="checkbox" checked={checked.has(m)} onChange={() => flip(m)} className="accent-[var(--color-accent)]" />
                <span className="text-[12px] font-mono text-ink truncate">{m}</span>
              </label>
            ))}
            {list.length === 0 && <div className="text-[11px] text-ink-faint px-1 py-2">无模型,点「重新拉取」或检查 provider 配置</div>}
          </div>
          <button onClick={save} disabled={busy === 'save'}
            className="w-full px-3 py-1.5 text-[12px] bg-accent text-on-accent rounded-lg disabled:opacity-50">
            {busy === 'save' ? '保存中…' : `保存所选(${checked.size})`}
          </button>
        </div>
      )}
    </div>
  );
}

// Shared add-custom-provider form. Both protocols; can live-fetch the upstream's
// model catalogue via /v1/models. onSaved() refreshes the parent's list.
// customCount = 保存前父级自定义 provider 数:仅添加**第一个**自定义 provider 时
// 自动切换过去(新机首配免二次操作),已有自定义条目时只添加不切换(避免打断当前会话所用 provider)。
function CustomProviderForm({ onSaved, editing, onCancel, onDirtyChange, customCount = 0 }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('openai');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [testResult, setTestResult] = useState(null); // BZ-1:{ ok, error } | null
  const [defaultModel, setDefaultModel] = useState('');  // AZ8:该 provider 默认模型(空=用列表第一个)
  // BB6:档位映射 —— 子代理/标题/compact 用的 haiku/sonnet/opus/fable alias 各自映射到该
  // provider 的真实模型(空=回退默认模型/选中模型,即维持 BA1 行为)。
  const [tierModels, setTierModels] = useState({ haiku: '', sonnet: '', opus: '', fable: '' });
  // 上下文窗口(token,可选):自动压缩窗口按它联动(切到该 provider 时压缩线=窗口×0.85)。
  // 空 = 不联动(CLI 按 200K 假设;窗口更大的模型会被过早压缩用不满)。
  const [ctxWindow, setCtxWindow] = useState('');
  const [busy, setBusy] = useState('');
  const isEdit = !!editing;
  const formRef = useRef(null);
  // 表单挂在列表顶部:点下方条目的「编辑」时列表往往已滚远,展开后把表单滚进视野。
  // block:'start' 而非 'nearest' —— 表单比滚动容器高,'nearest' 会因"已覆盖视口"
  // 而不滚,标题/名称字段留在视野外(实测)。scroll-mt-60 抵消下拉版 sticky 头部
  // 高度(scrollTop clamp 到 0 = 滚回容器顶),不写死滚动容器,设置面板版同样适用。
  useEffect(() => {
    if (open || isEdit) formRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [open, editing?.id]);
  // 新增态已填内容时点某条目「编辑」,预填会整表单覆盖 → 先经 confirmDialog 确认。
  // 每次渲染在**非编辑态**记录 dirty;进入编辑态的那次渲染不更新,ref 里留的就是
  // "点编辑前新增表单是否有未保存输入"。编辑态之间互切(A→B)不算新增态丢失,不拦。
  const addDirtyRef = useRef(false);
  useEffect(() => { if (!editing) addDirtyRef.current = dirty; });
  // Entering edit mode: pre-fill from the chosen provider. The apiKey is NEVER
  // sent to the client (only `hasKey`), so leave it blank — blank means "keep".
  useEffect(() => {
    if (!editing) return;
    let stale = false; // 确认框挂起期间 editing 又变了(再点别的编辑/删除)则放弃本次预填
    (async () => {
      if (addDirtyRef.current) {
        const ok = await confirmDialog(`放弃当前未保存的输入,改为编辑「${editing.name}」?`, { danger: true, confirmText: '放弃并编辑' });
        if (stale) return;
        if (!ok) { onCancel?.(); return; } // 保留新增表单已填内容,退回新增态
        addDirtyRef.current = false;
      }
      setName(editing.name || '');
      setType(editing.type || 'openai');
      setBaseURL(editing.baseURL || '');
      setApiKey('');
      setModelsText((editing.models || []).join('\n'));
      setDefaultModel(editing.defaultModel || '');
      setTierModels({ haiku: editing.tierModels?.haiku || '', sonnet: editing.tierModels?.sonnet || '', opus: editing.tierModels?.opus || '', fable: editing.tierModels?.fable || '' });
      setCtxWindow(editing.contextWindow ? String(editing.contextWindow) : '');
      setTestResult(null); // 切到另一个 provider 编辑时清掉上一个的测试结果横幅(否则误导)
      setBusy('');
      setOpen(true);
    })();
    return () => { stale = true; };
  }, [editing?.id]);
  const reset = () => { setName(''); setType('openai'); setBaseURL(''); setApiKey(''); setModelsText(''); setDefaultModel(''); setTierModels({ haiku: '', sonnet: '', opus: '', fable: '' }); setTestResult(null); setOpen(false); };
  const close = () => { reset(); onCancel?.(); };
  const parseModels = () => modelsText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  // BZ-2:有未保存内容时上报 dirty,父级据此阻止外部点击/Esc 关闭下拉(避免丢输入)。
  const dirty = (open || isEdit) && !!(name.trim() || baseURL.trim() || apiKey.trim() || modelsText.trim());
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => () => onDirtyChange?.(false), []); // 卸载时清掉,避免残留 dirty 卡住关闭
  // BZ-1:测试连接 —— 给默认模型/列表第一个发最小请求,验证鉴权 + 模型可达。
  const testConnection = async () => {
    const model = (defaultModel && parseModels().includes(defaultModel)) ? defaultModel : parseModels()[0];
    if (!baseURL.trim()) return setTestResult({ ok: false, error: '先填 Base URL' });
    if (!model) return setTestResult({ ok: false, error: '先填一个模型 ID 再测试' });
    setBusy('test'); setTestResult(null);
    try {
      const r = await fetch('/api/custom-providers/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, baseURL, apiKey, model, id: editing?.id }),
      });
      const d = await r.json();
      setTestResult(d.ok ? { ok: true, model } : { ok: false, error: d.error || `HTTP ${d.status || '错误'}` });
    } catch (e) { setTestResult({ ok: false, error: e.message }); }
    setBusy('');
  };
  const fetchModels = async () => {
    if (!baseURL.trim()) return confirmDialog('先填 Base URL');
    setBusy('fetch');
    try {
      const r = await fetch('/api/custom-providers/fetch-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // 编辑态带 id:key 框留空(=不修改)时后端按 id 读存储 key 兜底,不再空 key 打上游报 401。
        body: JSON.stringify({ type, baseURL, apiKey, ...(editing?.id ? { id: editing.id } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '拉取失败');
      if (!d.models?.length) confirmDialog('该端点未返回模型,请直接在下方「模型」框手填模型 ID 再保存。');
      else setModelsText(d.models.join('\n'));
    } catch (e) {
      // 文案按 type 区分:
      // - openai 兼容:DeepSeek/OpenAI/Gemini 这些**官方端点**支持 /v1/models,
      //   失败一般是 key 没填或填错 → 提示检查 key。
      // - anthropic 兼容:很多 Claude 协议中转(MiMo 等)只 forward /v1/messages,
      //   /v1/models 直接 404,属正常 → 提示手填即可。
      const tail = type === 'openai'
        ? '\n\nOpenAI 兼容端点通常 /v1/models 可用。常见原因:\n• 上面 API Key 没填或填错\n• 端点路径有出入(部分网关需要 /v1 后缀)\n• 网络/防火墙拦截\n也可直接在下方「模型」框手填模型 ID(每行一个)再保存。'
        : '\n\n很多 Claude 协议中转(如 MiMo 等)不提供 /v1/models 接口,这很正常。直接在下方「模型」框手填模型 ID(每行一个)再保存即可。';
      confirmDialog('拉取模型失败：' + e.message + tail);
    }
    setBusy('');
  };
  const save = async () => {
    if (!name.trim() || !baseURL.trim()) return confirmDialog('名称和 Base URL 必填');
    const parsedModels = parseModels();
    if (type === 'openai' && parsedModels.length === 0) {
      return confirmDialog('OpenAI 兼容 Provider 至少需要一个模型 ID。可以先点「拉取模型」,或在「模型」框每行填一个。');
    }
    // 提醒设默认模型:不设的话新会话/未指定模型的调用回退到列表第一个。多模型时才提醒。
    const hasDefault = defaultModel && parsedModels.includes(defaultModel);
    if (!hasDefault && parsedModels.length > 1) {
      const ok = await confirmDialog(
        `未设置默认模型。新会话及未指定模型的调用将使用列表第一个:${parsedModels[0]}。\n建议在下方设置默认模型,以及 haiku / sonnet / opus / fable 四档对应的模型 id。\n\n仍以「${parsedModels[0]}」作默认保存?`,
      );
      if (!ok) return; // 用户返回去设置默认模型 / 档位映射
    }
    setBusy('save');
    try {
      // Store in the GUI's own custom-providers.json (no cc-switch.db dependency —
      // works on a fresh machine without CC Switch installed).
      const body = { name, type, baseURL, models: parsedModels };
      // AZ8:默认模型(后端校验须在 models 内,否则忽略)。空 = 不指定,回退列表第一个。
      body.defaultModel = defaultModel && parsedModels.includes(defaultModel) ? defaultModel : null;
      // BB6:档位映射。只收在 parsedModels 内的;后端再校验一遍。空档省略 = 回退选中模型。
      body.tierModels = {
        haiku:  parsedModels.includes(tierModels.haiku)  ? tierModels.haiku  : '',
        sonnet: parsedModels.includes(tierModels.sonnet) ? tierModels.sonnet : '',
        opus:   parsedModels.includes(tierModels.opus)   ? tierModels.opus   : '',
        fable:  parsedModels.includes(tierModels.fable)  ? tierModels.fable  : '',
      };
      // 上下文窗口(可选):空串 = 清除;后端校验范围 [1000, 10M]。
      body.contextWindow = ctxWindow.trim() ? Number(ctxWindow.trim()) : null;
      // Edit mode: a blank key means "keep the stored one" (the client never holds
      // the real key), so only send apiKey when the user actually typed a new one.
      if (!isEdit || apiKey.trim()) body.apiKey = apiKey;
      const r = await fetch(isEdit ? `/api/custom-providers/${editing.id}` : '/api/custom-providers', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '保存失败');
      if (!isEdit && d.id && customCount === 0) {
        const sr = await fetch('/api/provider/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: d.id }),
        });
        const sd = await sr.json().catch(() => ({}));
        if (!sr.ok) {
          // 添加已成功持久化,只是切换失败——绝不能报"保存失败"(用户会重试→重复条目,
          // 新机实报)。如实提示 + 正常关表单,列表里可手动切换。
          useStore.getState().fetchModel?.();
          window.dispatchEvent(new CustomEvent('cgui:provider-change'));
          reset();
          onSaved?.();
          setBusy('');
          confirmDialog(`Provider 已保存,但自动切换失败:${sd.error || '未知错误'}\n\n可稍后在 Provider 列表中手动点击切换。`);
          return;
        }
        useStore.getState().clearModelOverrides?.();
      }
      // If we just edited the ACTIVE provider, the backend synced its model
      // snapshot — re-read /api/model so the picker reflects it without a re-switch.
      useStore.getState().fetchModel?.();
      window.dispatchEvent(new CustomEvent('cgui:provider-change'));
      reset();
      onSaved?.();
    } catch (e) { confirmDialog('保存失败：' + e.message); }
    setBusy('');
  };
  const inputCls = 'w-full bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-accent';
  if (!open && !isEdit) {
    return (
      <button onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left text-accent hover:bg-canvas-warm transition-colors border-b border-canvas-deep/40 mb-1">
        <Plus size={16} /><span className="text-[14px] font-body">添加 Provider</span>
      </button>
    );
  }
  return (
    <div ref={formRef} className="px-4 py-3 border-b border-canvas-deep/40 mb-1 space-y-2.5 scroll-mt-60">
      <div className="flex items-center gap-2">
        <button onClick={close} className="p-1 -ml-1 text-ink-faint hover:text-ink" title="返回"><ArrowLeft size={16} /></button>
        <span className="flex-1 text-[13px] font-display font-semibold text-ink">{isEdit ? '编辑 Provider' : '新增 Provider'}<span className="text-[10px] font-body font-normal text-ink-faint ml-1">保存到本机</span></span>
        <button onClick={close} className="p-1 text-ink-faint hover:text-ink"><X size={16} /></button>
      </div>
      <MobileSegmented onChange={setType} options={[
        { value: 'openai', label: 'OpenAI 兼容', active: type === 'openai' },
        { value: 'anthropic', label: 'Anthropic 兼容', active: type === 'anthropic' },
      ]} />
      {/* 内置 provider 模板(Bug #2):一键填好 name/type/baseURL/models,
          用户只需填 API key 然后保存。编辑模式下不显示(避免误覆盖用户已有配置)。 */}
      {!isEdit && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-faint shrink-0 whitespace-nowrap">内置模板</span>
          <select
            defaultValue=""
            onChange={(e) => {
              const tpl = findBuiltin(e.target.value);
              if (!tpl) return;
              setName(tpl.name);
              setType(tpl.type);
              setBaseURL(tpl.baseURL);
              setModelsText((tpl.models || []).join('\n'));
              // 模板带保守的上下文窗口预设(取该家主力模型的最小主流窗口,宁小勿大)→ 自动
              // 压缩联动开箱即用;模板没配(聚合类/窗口差异大)则清空=CLI 默认。
              setCtxWindow(tpl.contextWindow ? String(tpl.contextWindow) : '');
              // 重置 select 自身,让用户能再次选(value 受控就不会卡)
              e.target.value = '';
            }}
            className={`${inputCls} flex-1 cursor-pointer`}
            title="只列与上方所选协议匹配的内置 provider;切换协议后此列表随之变化"
          >
            <option value="">— 选模板自动填充 —</option>
            {/* 只显示与当前所选协议(type)匹配的模板,避免"选了 Anthropic 兼容却点到
                OpenAI 型 deepseek"这类协议错配(用户实报)。切 segmented 即换这组。 */}
            <optgroup label={type === 'anthropic' ? 'Anthropic 兼容' : 'OpenAI 兼容'}>
              {BUILTIN_PROVIDERS.filter((p) => p.type === type).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>
          </select>
        </div>
      )}
      <input className={inputCls} placeholder="名称(如 我的中转)" value={name} onChange={(e) => setName(e.target.value)} />
      <input className={`${inputCls} font-mono`} placeholder="Base URL (https://...)" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
      <input className={`${inputCls} font-mono`} type="password" placeholder={isEdit ? 'API Key(留空 = 不修改)' : 'API Key'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <div className="flex items-center gap-2">
        <textarea className={`${inputCls} font-mono min-h-[60px]`} placeholder="模型(每行一个,或逗号分隔)" value={modelsText} onChange={(e) => setModelsText(e.target.value)} />
      </div>
      {/* AZ8:默认模型 —— 切到此 provider 且未指定模型时用它(否则永远用列表第一个),
          子代理 model-less 解析也回退到它。选项来自上方「模型」框。 */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-ink-faint shrink-0 whitespace-nowrap">默认模型</span>
        <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}
          className={`${inputCls} flex-1 cursor-pointer font-mono`}
          title="切到此 provider 时的默认模型;留空则用模型列表第一个">
          <option value="">— 列表第一个(不指定)—</option>
          {parseModels().map((m) => (<option key={m} value={m}>{m}</option>))}
        </select>
      </div>
      {/* BB6:档位映射 —— 子代理/标题/compact 走 haiku/sonnet/opus/fable 别名,分别映射到该
          provider 的真实模型(简单任务用便宜的、难的用强的)。留空 = 回退默认模型/选中模型。
          要生效:agent .md 写别名(model: haiku)而非具体 id(具体 id 优先级更高,绕过映射)。 */}
      <div className="space-y-1.5 pt-0.5">
        <div className="text-[11px] text-ink-faint">档位映射 <span className="text-ink-faint/70">子代理/标题/compact 走便宜档,主对话走强档;留空 = 用默认模型</span></div>
        {[['haiku', 'Haiku 档(子代理/标题/便宜)'], ['sonnet', 'Sonnet 档(常规)'], ['opus', 'Opus 档(最强)'], ['fable', 'Fable 档(CLI 第四档,agent 可写 model:fable)']].map(([tier, label]) => (
          <div key={tier} className="flex items-center gap-2">
            <span className="text-[11px] text-ink-faint shrink-0 w-14 whitespace-nowrap">{tier}</span>
            <select value={tierModels[tier]} onChange={(e) => setTierModels((s) => ({ ...s, [tier]: e.target.value }))}
              className={`${inputCls} flex-1 cursor-pointer font-mono`} title={label}>
              <option value="">— 回退默认模型 —</option>
              {parseModels().map((m) => (<option key={m} value={m}>{m}</option>))}
            </select>
          </div>
        ))}
      </div>
      {/* 上下文窗口:自动压缩联动的数据源。填了 → 切到该 provider 时 CLI 自动压缩线=窗口×0.85
          (大窗模型不再被 200K 假设过早压缩);留空 → CLI 默认。带 [1m] 的模型名无需填(1M 开关
          自动联动)。 */}
      <div className="flex items-center gap-2 pt-0.5">
        <span className="text-[11px] text-ink-faint shrink-0 whitespace-nowrap">上下文窗口</span>
        <input value={ctxWindow} onChange={(e) => setCtxWindow(e.target.value.replace(/[^\d]/g, ''))}
          placeholder="可选,token 数。如 1000000(qwen/gemini 1M)、262144(256K)"
          className={`${inputCls} flex-1 font-mono`}
          title="该 provider 模型的上下文窗口(token)。填了则切到此 provider 时自动压缩窗口按它联动(×0.85);留空 = CLI 默认 200K 假设。模型名带 [1m] 时无需填。" />
      </div>
      <div className="flex gap-2">
        <button onClick={fetchModels} disabled={!!busy}
          className="flex-1 px-3 py-2 text-[12px] border border-accent text-accent rounded-lg disabled:opacity-50">
          {busy === 'fetch' ? '获取中…' : '获取模型'}
        </button>
        <button onClick={testConnection} disabled={!!busy}
          title="给默认模型(或列表第一个)发一个最小请求,验证鉴权 + 模型是否可达"
          className="flex-1 px-3 py-2 text-[12px] border border-canvas-deep text-ink-muted hover:text-ink rounded-lg disabled:opacity-50">
          {busy === 'test' ? '测试中…' : '测试连接'}
        </button>
        <button onClick={save} disabled={!!busy}
          className="flex-1 px-3 py-2 text-[12px] bg-accent text-on-accent rounded-lg disabled:opacity-50">
          {busy === 'save' ? '保存中…' : (isEdit ? '更新' : '保存')}
        </button>
      </div>
      {/* BZ-1:连接测试结果(成功/失败原因,可见且不自动消失) */}
      {testResult && (
        <div className={`text-[11px] font-body rounded-lg px-3 py-2 border ${testResult.ok
          ? 'text-success border-success/30 bg-success/10'
          : 'text-error border-error/30 bg-error/10'}`}>
          {testResult.ok
            ? `✓ 连接成功 —— 模型「${testResult.model}」可正常响应`
            : <span className="break-all whitespace-pre-wrap">✗ 连接失败:{testResult.error}</span>}
        </div>
      )}
    </div>
  );
}

// 手机批#4:MobileModelChips(行内模型 chip 平铺)已删——合并入口下模型 id 收进
// 折叠区,按行列表展示,不再平铺撑爆页面。

// 手机批#4:「Provider / 模型」合并入口(用户定稿设计)。每个 provider 一行,默认
// **折叠**不显模型 id;点行展开;展开后:
//   - 当前激活 provider → 内嵌 MobileModelPage(原「模型」页全功能:搜索/拉取/自定义/
//     1M,选择走 setModelFor 的 per-pane 语义,不重复切换);
//   - 其它 provider → 该 provider 的模型 id 列表,点某个 id = 走既有 /api/provider/switch
//     切换链路 + setModelFor 选中该模型,成功后 onPicked() 返回菜单根。
// 数据仍走 mergeProviderLists(与桌面管理页/顶栏卡片同一选择器);桌面两个独立按钮零改动。
// 修正批#7:本页只留 切换/选模型;增删改/导入/隐藏/批量删除收进页顶「管理 Provider」
// 入口(onManage → 同一导航流全屏页,渲染与桌面弹窗同一个 ProviderManager 组件)。
function MobileProviderPage({ permKey, onPicked, onManage }) {
  const [providers, setProviders] = useState([]);
  const [openaiProviders, setOpenaiProviders] = useState([]);
  const [customProviders, setCustomProviders] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [switching, setSwitching] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [expandedId, setExpandedId] = useState(null); // 默认全折叠;一次只展开一个
  // 审计批C5:已隐藏的导入项手机页也过滤(桌面切换卡片/管理页早有此行为,手机漏了)。
  const [hiddenProviders, setHiddenProviders] = useState(new Set());
  const load = () => {
    fetch('/api/providers').then((r) => r.json()).then((d) => {
      setProviders(Array.isArray(d.providers) ? d.providers : []);
      setOpenaiProviders(Array.isArray(d.openaiProviders) ? d.openaiProviders : []);
      setCustomProviders(Array.isArray(d.customProviders) ? d.customProviders : []);
      setOverrides(d.overrides && typeof d.overrides === 'object' ? d.overrides : {});
    }).catch(() => {});
    fetch('/api/prefs/hidden-providers').then((r) => r.json())
      .then((d) => setHiddenProviders(new Set(Array.isArray(d.hidden) ? d.hidden : [])))
      .catch(() => {});
  };
  useEffect(load, []);
  const isCur = (p) => rowIsCurrent(p, activeId); // 审计批挂账:兼配 dupOf
  // 既有切换链路原样保留(/api/provider/switch + clearModelOverrides + 双 fetch +
  // provider-change 广播),只加了成功返回值供 pickModel 判断。
  const switchTo = async (id, model) => {
    setSwitching(true);
    let ok = false;
    try {
      const r = await fetch('/api/provider/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model ? { id, model } : { id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '切换失败');
      setActiveId(id);
      useStore.getState().clearModelOverrides?.();
      useStore.getState().fetchProvider?.();
      useStore.getState().fetchModel?.();
      window.dispatchEvent(new CustomEvent('cgui:provider-change'));
      ok = true;
    } catch (e) { confirmDialog('切换 provider 失败：' + e.message); }
    setSwitching(false);
    return ok;
  };
  // 展开列表里点某个模型 id:切到该 provider(既有链路)+ per-pane 选中该模型,
  // 成功后返回菜单根(onPicked)。m 为空 = 该 provider 无模型列表,仅切换。
  const pickModel = async (p, m) => {
    const ok = await switchTo(p.id, m || undefined);
    if (!ok) return;
    if (m) useStore.getState().setModelFor(permKey, m); // clearModelOverrides 之后再钉,pin 存活
    onPicked?.();
  };
  return (
    <div className="py-1">
      {/* 修正批#7:增删改/导入/隐藏/批量删除迁「管理 Provider」全屏页(与桌面弹窗同一
          ProviderManager 组件);本页只留 切换 + 选模型,原页顶内嵌表单/行内编辑删除/多选删除。 */}
      <button onClick={onManage}
        className="w-full flex items-center gap-2 px-4 py-3 text-left text-accent hover:bg-canvas-warm transition-colors border-b border-canvas-deep/40 mb-1">
        <Settings size={16} className="shrink-0" />
        <span className="flex-1 text-[14px] font-body">管理 Provider（增删改 · 测试 · 隐藏 · 导入）</span>
        <ChevronRight size={16} className="text-ink-ghost shrink-0" />
      </button>
      {/* 修正批#6:单一列表(mergeProviderLists,与桌面同一数据选择器)——官方置顶、
          名称序、来源徽章。 */}
      {(() => {
        const rows = mergeProviderLists({ providers, openaiProviders, customProviders, hidden: hiddenProviders });
        return (<>
          <div className="px-4 pt-3 pb-1 border-t border-canvas-deep/40 mt-1">
            <div className="text-[11px] text-ink-faint uppercase tracking-wider font-body">全部 Provider · 点行展开模型,选模型即切换</div>
          </div>
          {rows.map((p) => {
            const cur = isCur(p);
            const expanded = expandedId === p.id;
            const models = Array.isArray(p.models) ? p.models : [];
            return (
              <div key={p.id} className={cur ? 'bg-accent-subtle' : ''}>
                {/* 行头:点击=展开/收起。折叠态不显模型 id。 */}
                <div className="w-full flex items-center gap-1 pr-3 hover:bg-canvas-warm transition-colors">
                  <button
                    onClick={() => setExpandedId(expanded ? null : p.id)}
                    className="flex-1 min-w-0 flex items-center gap-2 px-4 py-3 text-left">
                    {/* min-w 保证名称永不被 shrink-0 徽章挤到 0 宽(实测 322px 抽屉里
                        徽章簇会吃光 flex-1;模型计数不进行头,展开即见列表)。 */}
                    <span className={`flex-1 min-w-[64px] text-[14px] font-body truncate ${cur ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
                    {p.source === 'custom' && p.type && (
                      <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.type}</span>
                    )}
                    <ProviderSourceBadge p={p} />
                    {cur && <Check size={16} className="text-accent shrink-0" />}
                    <ChevronDown size={14} className={`text-ink-ghost shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                </div>
                {expanded && (
                  <div className="pb-2 border-b border-canvas-deep/40">
                    {cur ? (
                      // 当前激活 provider:内嵌原「模型」页(选择=per-pane pin,不重复切换;
                      // 搜索/拉取最新/自定义 ID/1M 开关全保留)。
                      <>
                        <div className="px-4 pt-1 text-[11px] text-ink-faint font-body">当前 Provider · 选择模型仅作用于当前会话</div>
                        <MobileModelPage permKey={permKey} />
                      </>
                    ) : (
                      <div className="py-1">
                        {(models.length ? models : [null]).map((m) => (
                          <button key={m ?? 'default'} disabled={switching} onClick={() => pickModel(p, m)}
                            className={`w-full flex items-center gap-2 pl-8 pr-4 py-2.5 text-left hover:bg-canvas-warm transition-colors ${switching ? 'opacity-50' : ''}`}>
                            <span className="flex-1 text-[13px] font-mono text-ink truncate">{m || '（默认模型）'}</span>
                            <span className="text-[10px] text-ink-faint font-body shrink-0">切换并使用</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {p.source === 'openai' && (
                      <div className="px-4"><OpenAIModelManager provider={p} onSaved={load} /></div>
                    )}
                    {(p.source === 'ccswitch' || p.source === 'openai') && (
                      <div className="px-4"><ProviderOverrideEditor provider={p} override={overrides[p.id]} onSaved={load} /></div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>);
      })()}
    </div>
  );
}

function MobileAppearancePage({ push }) {
  const themeFamily = useStore((s) => s.themeFamily);
  const themeTone = useStore((s) => s.themeTone);
  const setTheme = useStore((s) => s.setTheme);
  const uiFontScale = useStore((s) => s.uiFontScale);
  const setUiFontScale = useStore((s) => s.setUiFontScale);
  const readingFont = useStore((s) => s.readingFont);
  const chatMode = useStore((s) => s.chatMode);
  const setChatMode = useStore((s) => s.setChatMode);
  const extraThemeFamilies = useStore((s) => s.extraThemeFamilies);
  const famName = [...THEME_FAMILIES, ...extraThemeFamilies].find((f) => f.id === themeFamily)?.name || themeFamily;
  const fontName = FONT_OPTIONS.find((f) => f.id === readingFont)?.name || readingFont;
  return (
    <div className="py-2">
      <div className="px-4 pb-2 text-[11px] text-ink-faint font-body">明暗</div>
      <div className="px-4 pb-1">
        <MobileSegmented onChange={(v) => setTheme(themeFamily, v)}
          options={TONES.map((t) => ({ value: t.id, label: t.label, icon: t.Icon, active: themeTone === t.id }))} />
      </div>
      <MobileMenuRow icon={Palette} label="配色方案" value={famName} onClick={() => push('theme')} />
      <div className="px-4 pt-2 pb-2 text-[11px] text-ink-faint font-body">界面字体大小</div>
      <div className="px-4 pb-1">
        <MobileSegmented onChange={(v) => setUiFontScale(v)}
          options={[{ label: '小', value: 0.9 }, { label: '中', value: 1 }, { label: '大', value: 1.2 }, { label: '超大', value: 1.45 }]
            .map((o) => ({ ...o, active: Math.abs(uiFontScale - o.value) < 0.03 }))} />
      </div>
      <MobileMenuRow icon={Type} label="对话正文字体" value={fontName} onClick={() => push('readingfont')} />
      <div className="px-4 pt-2 pb-2 text-[11px] text-ink-faint font-body">对话显示</div>
      <MobileMenuRow icon={MessageSquare} label="聊天模式" value={chatMode ? '开' : '关'} chevron={false} onClick={() => setChatMode(!chatMode)} />
      <div className="px-4 pt-1 text-[10px] text-ink-faint font-body leading-snug">开启后折叠思考/工具/子代理/技能,只看对话文本,配「微信」配色最像微信</div>
      {/* P2.3:设置「外观」tab 删除后,加载动画与对话区背景在手机端的入口迁到这里
          (桌面端在顶栏「主题」弹层),不丢功能。 */}
      <div className="px-4 pt-3"><LoadingStylePicker /></div>
      <div className="px-4 pt-3 pb-4"><ChatBackgroundCard /></div>
    </div>
  );
}

function MobileThemePage() {
  const themeFamily = useStore((s) => s.themeFamily);
  const themeTone = useStore((s) => s.themeTone);
  const setTheme = useStore((s) => s.setTheme);
  const extraThemeFamilies = useStore((s) => s.extraThemeFamilies);
  const effDark = themeTone === 'auto' ? systemPrefersDark() : themeTone === 'dark';
  const toneKey = effDark ? 'dark' : 'light';
  return (
    <div className="grid grid-cols-2 gap-2 p-3">
      {[...THEME_FAMILIES, ...extraThemeFamilies].map((fam) => {
        const sw = fam[toneKey];
        const active = themeFamily === fam.id;
        return (
          <button key={fam.id} onClick={() => setTheme(fam.id, themeTone)}
            style={{ backgroundColor: sw.bg, color: sw.fg, borderColor: active ? sw.accent : sw.bg2, borderWidth: active ? 2 : 1, boxShadow: active ? `0 0 0 3px ${sw.accent}22` : 'none' }}
            className="text-left px-3 py-3 rounded-xl border flex items-center gap-2">
            <div className="flex gap-0.5 shrink-0 items-stretch">
              <div className="w-3 h-7 rounded-sm" style={{ background: sw.accent }} />
              <div className="w-1.5 h-7 rounded-sm" style={{ background: sw.bg2 }} />
              <div className="w-1.5 h-7 rounded-sm" style={{ background: sw.fg, opacity: 0.85 }} />
            </div>
            <span style={{ color: sw.fg }} className="text-[12px] font-body font-medium flex-1 min-w-0 truncate">{fam.name}</span>
            {active && <Check size={14} style={{ color: sw.accent }} className="shrink-0" />}
          </button>
        );
      })}
    </div>
  );
}

function MobileReadingFontPage() {
  return (
    <div className="px-3 py-2">
      <FontPicker />
    </div>
  );
}

function MobileMenu({ setRightPanel, onClose, updateNotice = null }) {
  const [stack, setStack] = useState(['root']);
  const page = stack[stack.length - 1];
  const push = (p) => setStack((s) => [...s, p]);
  // 审计批判官3:管理页返回补脏表单守卫 —— 桌面弹窗 Esc/点外有 confirmDialog,
  // 手机导航流的「返回」原来直接丢弃未保存输入。与 ProviderManagerModal 同语义。
  const back = async () => {
    if (page === 'providermanage' && window.__cguiProviderFormDirty) {
      const ok = await confirmDialog('Provider 表单有未保存的输入，返回将丢弃。仍要返回？', { danger: true, confirmText: '丢弃并返回' });
      if (!ok) return;
      window.__cguiProviderFormDirty = false;
    }
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };

  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const paneSessions = useStore((s) => s.paneSessions);
  const selectedSession = useStore((s) => s.selectedSession);
  const selectedProject = useStore((s) => s.selectedProject);
  const activeSession = (paneSessions && paneSessions[activeTabIndex]) || selectedSession;
  const permKey = activeSession?.sessionId || `draft-${activeSession?.projectHash || 'none'}`;

  const currentModel = useStore((s) => s.modelBySession[permKey] || s.currentModel);
  // 审计批C2:导出 Markdown 需要当前会话消息(手机单窗格=pane0/activeTabIndex)。
  const menuMessages = useStore((s) => (s.paneMessages && s.paneMessages[s.activeTabIndex]) || s.messages || EMPTY_ARRAY);
  const effort = useStore((s) => (permKey && permKey in (s.effortBySession || {})) ? s.effortBySession[permKey] : s.effort);
  const effortLabel = (EFFORT_LEVELS.find((e) => e.id === effort) || EFFORT_LEVELS[0]).label;

  // New chat: prefer the selected project; fall back to the open session's
  // project so ✎ isn't a dead no-op. With no project at all, drop into the
  // history page so the user can pick one (the old code silently did nothing).
  const startNew = () => {
    const st = useStore.getState();
    const sel = st.selectedSession;
    const proj = st.selectedProject || (sel?.projectHash ? { hash: sel.projectHash, path: sel.projectPath } : null);
    if (!proj) { push('history'); return; }
    st.setSelectedSession({ draft: true, draftId: newDraftId(), sessionId: null, projectHash: proj.hash, projectPath: proj.path, firstPrompt: '新会话' });
    useStore.setState({ messages: [] });
    st.setPaneMessages(0, []);
    onClose();
  };
  const openPanel = (id) => { setRightPanel(id); onClose(); };

  // 手机批#4:「模型」「Provider」两个入口合并为一个「Provider / 模型」页(双入口
  // 让人误以为两套状态)。'model' 路由随之删除,MobileModelPage 内嵌进合并页。
  const TITLES = { history: '会话与项目', effort: '推理力度', provider: 'Provider / 模型', providermanage: '管理 Provider', appearance: '外观', theme: '配色方案', readingfont: '对话正文字体' };

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-1 px-3 h-12 border-b border-canvas-deep/60">
        {page === 'root' ? (
          <>
            <span className="flex-1 text-[15px] font-display font-semibold text-ink">菜单</span>
            <button onClick={onClose} className="p-2 -mr-1 text-ink-muted hover:text-ink"><X size={18} /></button>
          </>
        ) : (
          <>
            <button onClick={back} className="flex items-center gap-0.5 text-accent -ml-1 px-1 py-2">
              <ChevronLeft size={20} /><span className="text-[14px] font-body">返回</span>
            </button>
            <span className="flex-1 text-center text-[15px] font-display font-semibold text-ink truncate pr-12">{TITLES[page]}</span>
          </>
        )}
      </div>

      {page === 'history' ? (
        <div className="flex-1 min-h-0">{selectedProject ? <SessionList /> : <ProjectList />}</div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {page === 'root' && (
            <div className="py-1">
              <MobileMenuRow icon={SquarePen} label="新建会话" chevron={false} onClick={startNew} />
              <MobileMenuRow icon={MessageSquare} label="会话与项目" onClick={() => push('history')} />
              <div className="px-4 pt-3 pb-1 text-[11px] text-ink-faint uppercase tracking-wider font-body">当前会话</div>
              {/* 手机批#4:合并入口。值 = 解析后的实际发送模型(pin→全局默认),一眼
                  看到"已继承",不再显示成未选;当前 provider 在入口页内高亮置顶(375px
                  行宽放不下"provider 名+模型徽章"两段,名字挤成省略号反而更差)。 */}
              {/* 不走 MobileMenuRow:其 value 槽 max-w-44% 挤压 flex-1 标签,"Provider/模型"
                  +长模型 id 徽章在 375px 下必有一个被截。此行标签 shrink-0 保完整,徽章占余宽。 */}
              <button onClick={() => push('provider')}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas-warm active:bg-canvas-deep/30 transition-colors">
                <Server size={18} strokeWidth={1.75} className="text-ink-muted" />
                <span className="shrink-0 text-[14px] font-body text-ink">Provider / 模型</span>
                <span className="flex-1 min-w-0 flex justify-end"><ModelBadge model={currentModel} compact /></span>
                <ChevronRight size={16} className="text-ink-ghost shrink-0" />
              </button>
              {/* 审计批C3:门控判据与桌面 EffortSelector 统一 —— openai 协议同样显示
                  (映射为 reasoning_effort,不支持的端点自动降级),文案在分页内区分。 */}
              <MobileMenuRow icon={Gauge} label="推理力度" value={effortLabel} onClick={() => push('effort')} />
              {/* 审计批C1:手机会话内检索入口(桌面为 Cmd+F)。事件由活动窗格的
                  SessionDetail 接住并 setSearchOpen(true);先关抽屉让检索浮层可见。 */}
              {activeSession && (
                <MobileMenuRow icon={Search} label="会话内检索" chevron={false}
                  onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('cgui:open-search')); }} />
              )}
              {/* 修正批#1b:权限模式行已删——唯一入口在输入框工具行最左(桌面/手机同)。 */}
              {activeSession?.sessionId && (
                <div className="px-4 py-2"><RemoteControlButton session={activeSession} /></div>
              )}
              {/* 审计批C2:导出 Markdown / Checkpoint 时间线手机入口 —— 桌面在会话头 ⋮ 内,
                  手机不渲染那块头部;组件原样复用(Checkpoint 弹层本就 body portal)。 */}
              {activeSession?.sessionId && (
                <div className="px-4 py-1 flex items-center gap-2">
                  <ExportSessionButton
                    messages={menuMessages}
                    title={(useStore.getState().customTitles[activeSession.sessionId]
                      || useStore.getState().autoTitles[activeSession.sessionId])
                      || activeSession.firstPrompt || '会话'}
                  />
                  <CheckpointButton
                    sessionId={activeSession.sessionId}
                    cwd={activeSession.projectPath || selectedProject?.path}
                    projectHash={activeSession.projectHash}
                    onRestored={() => {
                      const st = useStore.getState();
                      if (activeSession.sessionId && activeSession.projectHash) {
                        st.fetchMessages(activeSession.sessionId, activeSession.projectHash, { silent: true, tab: activeTabIndex });
                      }
                    }}
                  />
                </div>
              )}
              <div className="px-4 pt-3 pb-1 text-[11px] text-ink-faint uppercase tracking-wider font-body">外观</div>
              <MobileMenuRow icon={Palette} label="主题与字体" onClick={() => push('appearance')} />
              <div className="px-4 pt-3 pb-1 text-[11px] text-ink-faint uppercase tracking-wider font-body">工具</div>
              {Object.entries(PANEL_MAP).filter(([id]) => id !== 'settings').map(([id, { icon: Icon, label }]) => (
                <MobileMenuRow key={id} icon={Icon} label={label} chevron={false} onClick={() => openPanel(id)} />
              ))}
              <div className="px-4 pt-3 pb-1 text-[11px] text-ink-faint uppercase tracking-wider font-body">系统</div>
              {/* 修正批#7:设置里 Provider tab 已删(管理在上方 Provider/模型 入口页内) */}
              {/* 审计批A5:有可用更新时系统行加红点(桌面 PanelDock 红点同语义,手机原来无任何提示)。 */}
              <MobileMenuRow icon={Settings} label="通用（更新 / 会话 / 网络 / 高级）" chevron={false} dot={!!updateNotice} onClick={() => openPanel('settings')} />
              <div className="h-8" />
            </div>
          )}
          {page === 'effort' && <MobileEffortPage permKey={permKey} />}
          {page === 'provider' && <MobileProviderPage permKey={permKey} onPicked={() => setStack(['root'])} onManage={() => push('providermanage')} />}
          {/* 修正批#7:管理页 = 与桌面弹窗同一 ProviderManager 组件,宿主为导航流页面 */}
          {page === 'providermanage' && <div className="px-3 py-2"><ProviderManager /></div>}
          {page === 'appearance' && <MobileAppearancePage push={push} />}
          {page === 'theme' && <MobileThemePage />}
          {page === 'readingfont' && <MobileReadingFontPage />}
        </div>
      )}
    </div>
  );
}

// ── Mobile chrome (Claude-app style) ─────────────────────────────
// A minimal top app bar: drawer toggle · session title · new chat. The heavy
// desktop header (10+ controls) is replaced on phones by this bar plus the
// slide-in MobileMenu, so the layout reads like the Claude app instead of
// cramming every control into a wrapped header.
function MobileTopBar({ onMenu, onNew, title }) {
  return (
    <header className="mobile-topbar glass-bar h-12 px-2 flex items-center gap-1 shrink-0 relative z-40">
      <button onClick={onMenu} className="btn-glass p-2 shrink-0" title="会话">
        <Menu size={18} className="text-ink-muted" />
      </button>
      <div className="flex-1 min-w-0 flex items-center justify-center gap-1.5">
        <span className="text-accent text-[13px] leading-none shrink-0 select-none font-mono">✻</span>
        <span className="text-[13px] font-display font-semibold text-ink tracking-tight truncate">{title}</span>
      </div>
      <button onClick={onNew} className="btn-glass p-2 shrink-0" title="新建会话">
        <SquarePen size={18} className="text-ink-muted" />
      </button>
    </header>
  );
}

// M3(Q9): 非聚焦会话完成回复的悬浮提醒。固定在顶部标题栏下方,10s 自动消失
// (W2:用户反馈 5s 偏短);点击跳转:会话已在某个分屏窗格 → 聚焦该窗格;
// 否则替换当前聚焦窗格的会话。
function CompletionToasts() {
  const toasts = useStore((s) => s.completionToasts);
  const removeToast = useStore((s) => s.removeCompletionToast);
  // P1-4:每条 toast 独立计时。原实现把所有 toast 的 timer 放一个数组,toasts 数组一变
  // (新 toast push/旧的 remove → 新引用)effect 重跑、cleanup clearTimeout 全部 → 旧 toast
  // 计时从 0 重来,持续有新通知时旧的永不自动消失。改为 ref 记每条 timer,只给新出现的起
  // 计时,不动已存在的;被移除的清掉残留;卸载时全清。
  const timersRef = useRef({});
  useEffect(() => {
    const ids = new Set(toasts.map((t) => String(t.id)));
    toasts.forEach((t) => {
      if (!timersRef.current[t.id]) {
        timersRef.current[t.id] = setTimeout(() => {
          delete timersRef.current[t.id];
          removeToast(t.id);
        }, 10000);
      }
    });
    Object.keys(timersRef.current).forEach((id) => {
      if (!ids.has(id)) { clearTimeout(timersRef.current[id]); delete timersRef.current[id]; }
    });
  }, [toasts, removeToast]);
  useEffect(() => () => { Object.values(timersRef.current).forEach(clearTimeout); }, []);
  if (!toasts.length) return null;
  const jump = (t) => {
    const st = useStore.getState();
    const idx = st.paneSessions.slice(0, st.paneCount).findIndex((p) => p?.sessionId === t.sessionId);
    if (idx >= 0) {
      st.setActiveTabIndex(idx);
    } else if (t.session?.sessionId) {
      // 不在任何窗格:替换当前聚焦窗格的会话
      if (st.activeTabIndex === 0) st.setSelectedSession(t.session);
      else st.setPaneSession(st.activeTabIndex, t.session);
    }
    removeToast(t.id);
  };
  return (
    <div className="fixed top-[60px] left-1/2 -translate-x-1/2 z-[150] flex flex-col gap-2 items-center pointer-events-none">
      {toasts.map((t) => (
        <button key={t.id} onClick={() => jump(t)}
          className="pointer-events-auto glass-popover max-w-[calc(var(--app-w,100vw)-2rem)] w-[440px] rounded-xl shadow-lg px-4 py-2.5 text-left animate-glass-rise hover:ring-2 hover:ring-accent/40 transition-shadow">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-success shrink-0" />
            {/* suffix 可覆盖默认文案(后台代理结束提醒复用同一浮条) */}
            <span className="text-[12px] font-medium text-ink font-body truncate flex-1">{t.title} · {t.suffix || '回复完成'}</span>
            <X size={12} className="text-ink-faint shrink-0 hover:text-ink" onClick={(e) => { e.stopPropagation(); removeToast(t.id); }} />
          </div>
          {t.summary && <div className="mt-1 text-[11px] text-ink-muted font-body line-clamp-2">{t.summary}</div>}
        </button>
      ))}
    </div>
  );
}

// ─── 快捷键速查(Cmd/Ctrl+/)────────────────────────────────────
// 纯静态清单,单实例挂在 App 顶层(非 per-pane 组件,不涉及窗格状态)。
const SHORTCUT_GROUPS = [
  ['输入与发送', [
    ['Enter', '发送消息'],
    ['Shift + Enter', '换行(Cmd/Ctrl + Enter 也可发送)'],
    ['Cmd/Ctrl + Z', '撤销输入'],
    ['↑(输入框为空时)', '召回最近发送/入队的消息'],
    ['/', '打开命令面板(输入框内)'],
    ['@', '引用项目文件 / 其它会话(输入框内)'],
  ]],
  ['会话', [
    ['Cmd/Ctrl + N', '当前项目下新建会话'],
    ['Cmd/Ctrl + ↑ / ↓', '切换到上/下一个会话(当前窗格)'],
    ['Cmd/Ctrl + F', '会话内检索(当前窗格)'],
    ['Esc（生成中）', '停止当前回合'],
    ['Esc 连按两次（输入框有字）', '清空输入框，再连按两次可放回'],
    ['Esc 连按两次（输入框为空）', '打开 Checkpoint 时间线回退'],
  ]],
  ['界面', [
    ['Ctrl + Tab', '分屏时轮换聚焦窗格'],
    ['Cmd/Ctrl + 1 … 9', '打开/关闭对应面板(1 文件 2 审查 3 监控 4 Agent 5 用量 6 进程 7 工具 8 技能 9 指令)'],
    ['Cmd/Ctrl + 0', '打开/关闭「通用」面板(顶栏「设置」内)'],
    ['Cmd/Ctrl + /', '打开/关闭本速查'],
  ]],
];

function ShortcutsPanel({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="glass-popover w-[440px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[min(80vh,calc(var(--app-h,100dvh)-2rem))] rounded-2xl shadow-2xl animate-glass-rise overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-canvas-deep shrink-0">
          <div className="text-[14px] font-display font-semibold text-ink">键盘快捷键</div>
          <button onClick={onClose} className="p-1 rounded hover:bg-canvas-warm text-ink-faint hover:text-ink" title="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {SHORTCUT_GROUPS.map(([group, items]) => (
            <div key={group}>
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body mb-1.5">{group}</div>
              <div className="space-y-1">
                {items.map(([keys, desc]) => (
                  <div key={keys} className="flex items-center gap-3">
                    <kbd className="shrink-0 min-w-[132px] px-1.5 py-0.5 rounded border border-canvas-deep bg-canvas-warm text-[11px] font-mono text-ink-soft text-center">{keys}</kbd>
                    <span className="text-[12px] text-ink-muted font-body">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────
export default function App() {
  useWebSocket();
  // #12 后台任务全局活性探测(判官打回修复):bgTasks 的 status 只有创建时的 'running'
  // (自然结束无退出码事件;监控卡的 phase 是组件本地态、面板关了就没人测)→ 任务清单
  // 转圈据 status 判会永转。这里全局唯一轮询:对非终态任务每 5s 查 output 文件 size,
  // 连续 6 轮(≈30s)无增长标 livePhase:'idle'(≈不再工作,不谎称完成),有增长标 'running'。
  // ChatInput 的 bgWorking 据 livePhase 判;无任务时零请求。
  useEffect(() => {
    const sizes = {}; // taskId -> { size, stale }
    const id = setInterval(async () => {
      const st = useStore.getState();
      const live = Object.values(st.bgTasks || {}).filter(
        (t) => t && t.outputPath && !['done', 'failed', 'killed', 'stopped', 'error'].includes(t.status),
      );
      for (const t of live) {
        try {
          const prev = sizes[t.id] || { size: 0, stale: 0 };
          const r = await fetch(`/api/bgtask/output?path=${encodeURIComponent(t.outputPath)}&offset=${prev.size}`);
          const d = await r.json();
          if (!d.exists) continue; // 文件未落盘/被清,不妄判
          if (d.size > prev.size) {
            sizes[t.id] = { size: d.size, stale: 0 };
            if (t.livePhase !== 'running') st.upsertBgTask(t.id, { livePhase: 'running' });
          } else {
            const stale = prev.stale + 1;
            sizes[t.id] = { size: prev.size, stale };
            if (stale >= 6 && t.livePhase !== 'idle') st.upsertBgTask(t.id, { livePhase: 'idle' });
          }
        } catch { /* 网络瞬断,下轮再试 */ }
      }
    }, 5000);
    return () => clearInterval(id);
  }, []);
  const { sidebarCollapsed, toggleSidebar, selectedProject, selectedSession } = useStore();
  // 修正批#1b:顶栏选择器(Provider/模型/力度/远程)作用于「活跃窗格」的会话——
  // 未分屏 = selectedSession;分屏 = 聚焦格。返回既有对象引用,选择器稳定。
  const headerPane = useStore((s) => (s.paneSessions && s.paneSessions[s.activeTabIndex || 0]) || s.selectedSession);
  const headerPermKey = headerPane ? (headerPane.sessionId || `draft-${headerPane.projectHash || 'none'}`) : null;
  const [rightPanel, setRightPanelRaw] = useState(null);
  // 修正批#7:原 T5#1 "离开设置面板丢 Provider 表单输入"守卫已删——表单随 Provider tab
  // 迁出设置,脏数据守卫改由 ProviderManagerModal 的关闭路径(Esc/点外/X)承担。
  const rightPanelRef = useRef(null);
  const setRightPanel = useCallback((next) => {
    const target = typeof next === 'function' ? next(rightPanelRef.current) : next;
    rightPanelRef.current = target;
    setRightPanelRaw(target);
  }, []);
  const [tourOpen, setTourOpen] = useState(false); // CK-3 使用指引浮层
  // Auth gate: external clients with a password set must log in first. Loopback
  // (Mac) always reports authed, so this is a no-op locally.
  const [authLocked, setAuthLocked] = useState(false);
  useEffect(() => {
    fetch('/api/auth-status').then((r) => r.json())
      .then((d) => setAuthLocked(!!(d.required && !d.authed)))
      .catch(() => {});
  }, []);

  // CK-6: Cmd/Ctrl+N 在「当前聚焦窗格的会话所属项目」下新建草稿会话(Mac+Win 通用)。
  // 复用 startNew 的草稿逻辑;写 activeTabIndex 对应窗格,不打扰分屏里其它窗格。
  // 没有项目上下文(还停在项目列表)就不动。
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        const st = useStore.getState();
        const idx = st.activeTabIndex || 0;
        const sel = (st.paneSessions && st.paneSessions[idx]) || st.selectedSession;
        const proj = st.selectedProject || (sel?.projectHash ? { hash: sel.projectHash, path: sel.projectPath } : null);
        if (!proj) return; // 没有项目 → 交给浏览器默认(本地无害)
        e.preventDefault();
        st.setPaneSession(idx, { draft: true, draftId: newDraftId(), sessionId: null, projectHash: proj.hash, projectPath: proj.path, firstPrompt: '新会话' });
        st.setPaneMessages(idx, []);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // F1: 全局截图热键。Rust 侧注册系统快捷键(默认 CmdOrCtrl+Shift+2)→ emit
  // 'cgui:screenshot-hotkey'。这里在 App 顶层单点监听:确定当前活动窗格 → 调 /api/screenshot →
  // 成功后复用 composer-fill(append 模式)把图塞进活动窗格输入框。取消静默,失败给提示。
  const [shotStatus, setShotStatus] = useState(null); // {kind:'busy'|'done'|'error', text}
  const shotBusyRef = useRef(false);
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten = null;
    let toastTimer = null;
    const showStatus = (kind, text, ttl) => {
      setShotStatus({ kind, text });
      if (toastTimer) clearTimeout(toastTimer);
      if (ttl) toastTimer = setTimeout(() => setShotStatus(null), ttl);
    };
    const onHotkey = async () => {
      if (shotBusyRef.current) return; // 防重复触发(截图进行中再按无效)
      shotBusyRef.current = true;
      showStatus('busy', '正在截图，请框选区域或点击窗口…');
      try {
        const r = await fetch('/api/screenshot', { method: 'POST' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          showStatus('error', d.error || '截图失败', 8000);
          return;
        }
        if (d.canceled) { setShotStatus(null); return; }
        // 目标窗格 = 当前活动窗格,key 与 SessionDetail 的 sessionQueueKey 同构。
        const st = useStore.getState();
        const idx = st.activeTabIndex || 0;
        const sel = (st.paneSessions && st.paneSessions[idx]) || st.selectedSession;
        const targetKey = sel?.sessionId || `draft-${sel?.projectHash || 'none'}`;
        const name = String(d.path || 'screenshot.png').split(/[/\\]+/).pop();
        window.dispatchEvent(new CustomEvent('cgui:composer-fill', {
          detail: {
            targetKey,
            appendAttachments: true,
            attachments: [{ kind: 'image', path: d.path, preview: d.preview, name, bytes: d.bytes }],
          },
        }));
        // 截图完成后把 GUI 带回前台展示已入框的图(热键回调不再提前置前——那会盖住目标窗口)。
        // 仅成功路径调;取消(上面已 return)不打扰。
        import('@tauri-apps/api/core').then(({ invoke }) => invoke('focus_main_window')).catch(() => {});
        showStatus('done', '截图已添加到输入框', 2500);
      } catch (err) {
        showStatus('error', '截图失败: ' + (err?.message || err), 8000);
      } finally {
        shotBusyRef.current = false;
      }
    };
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('cgui:screenshot-hotkey', onHotkey))
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => {
      if (typeof unlisten === 'function') unlisten();
      if (toastTimer) clearTimeout(toastTimer);
    };
  }, []);

  // 快捷键(单实例挂 App 顶层,处理器内 getState() 读活动窗格,避免闭包陈旧;
  // 遵循 per-pane 纪律:只写活动窗格的 keyed slot,绝不写全局单值):
  //  · Cmd/Ctrl+/  快捷键速查(meta 组合不会往输入框打字,聚焦时也响应)
  //  · Ctrl+Tab    分屏窗格轮换(仅 paneCount>1)
  //  · Cmd/Ctrl+↑/↓ 当前项目会话列表内切上/下一条(仅活动窗格;输入焦点时不抢——
  //    textarea 里 Cmd+↑/↓ 是光标到头/尾的系统语义)
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    const isEditable = isEditableTarget; // 口径统一在 utils/escAction.js
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && !e.shiftKey && !e.altKey && e.key === '/') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === 'Tab') {
        const st = useStore.getState();
        if ((st.paneCount || 1) > 1) {
          e.preventDefault();
          st.setActiveTabIndex(((st.activeTabIndex || 0) + 1) % st.paneCount);
        }
        return;
      }
      if (meta && !e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (isEditable(document.activeElement)) return;
        const st = useStore.getState();
        const list = (st.sessions || []).filter((s) => !s.archived && s.sessionId);
        if (!list.length) return;
        const idx = st.activeTabIndex || 0;
        const cur = (st.paneSessions && st.paneSessions[idx]) || st.selectedSession;
        // 当前会话不在列表(draft/别的项目)时:↑ 落到最后一条,↓ 落到第一条。
        let pos = cur?.sessionId ? list.findIndex((s) => s.sessionId === cur.sessionId) : -1;
        pos = e.key === 'ArrowUp'
          ? (pos <= 0 ? list.length - 1 : pos - 1)
          : (pos < 0 || pos >= list.length - 1 ? 0 : pos + 1);
        const target = list[pos];
        if (!target || target.sessionId === cur?.sessionId) return;
        e.preventDefault();
        // 与侧栏 handleSelect 同一加载路径:keyed 写活动窗格 + 按 tab 拉消息。
        st.setPaneSession(idx, target);
        st.fetchMessages(target.sessionId, target.projectHash, { tab: idx });
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 速查开着时 Esc 关闭:用捕获阶段拦下,阻断冒泡阶段的「双击 Esc 停止流」监听
  // (SessionDetail 挂在 window 冒泡阶段),避免关面板的 Esc 被计入停止连击。
  useEffect(() => {
    if (!shortcutsOpen) return;
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setShortcutsOpen(false);
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [shortcutsOpen]);

  // 面板页(设置/MCP/技能…)开着时 Esc 先关面板,不穿透到会话级「生成中单击即停」。
  // 边界(别回归 0.2.268):吃 Esc 的是【打开的面板页】,面板坞 rail 展开但没开面板页时
  // rightPanel=null → 本 effect 不挂监听,Esc 照常走停止/双击语义。
  // 相位选 document 捕获(不是 window 捕获):浮层(图片灯箱/预览/右键菜单/快捷键录制/
  // Provider 弹窗/速查/主题与分屏下拉/会话更多菜单/上下文徽章/模型选择器/回滚菜单/窗内检索)
  // 都挂在 window 捕获且 stopPropagation,捕获顺序 window → document,故面板内浮层恒先吃到
  // 这一击,面板不会被越级关掉;它们没接的那一击才轮到这里关面板,stopPropagation 再挡住
  // 冒泡阶段 SessionDetail 的停止监听。
  // 例外(R1):权限/计划/越界卡的键盘监听刻意留在 window 冒泡(捕获相位曾引发误 deny 竞争,
  // 见 PermissionPrompt 顶部注释),相位上抢不过本监听 → 只能由本监听主动让行:本 pane 挂着
  // 卡片时这一击归卡片(Esc=拒绝),面板不关。判据复用 SessionDetail 停止监听的同一纯函数
  // escYieldCardId(焦点在输入框/下拉里时卡片自己会跳过键盘 → 那种情况不让行,免得两边都没人接)。
  // rightPanel 是 App 级单值状态(面板无 per-pane 语义),effect 只此一份,无需分屏门控。
  useEffect(() => {
    if (!rightPanel) return;
    // 已为哪张卡让过行。与 SessionDetail 停止监听里的同名变量【各自独立】:两处让行是
    // 两件事(那边让的是"停整轮",这边让的是"关面板"),共享会互相吃掉对方的那一击。
    // 没有这笔账时,遇上不吃 Esc 的卡(AskUserQuestion 选择卡)= 每一击都让行 → 面板永远关不掉。
    let yieldedForId = null;
    const onEsc = (e) => {
      if (e.isComposing || e.keyCode === 229) return; // IME 组字中的 Esc = 取消候选词
      if (e.key !== 'Escape' || e.repeat) return;
      // R2:焦点在面板内的输入框/文本域/下拉/富文本里时,这一击是"取消本次编辑/退出输入",
      // 不是"关掉整个面板" —— 不守卫的话在设置里改到一半按 Esc,面板连同未保存的编辑一起没了。
      // 判据统一走 escAction.js 的 isEditableTarget。
      // 且【面板内】的这一击必须就地截断:不 stopPropagation 的话它会冒到 window 上的
      // 会话级监听(SessionDetail),生成中一击停整轮、空闲双击清聊天草稿 —— 在设置面板
      // 里打字按个 Esc 把正在跑的回合停了。截断只针对面板容器内的目标:聊天输入框在
      // pane 里,closest 命中不到 [data-cgui-panel],语义原样不动。
      // 面板内没有任何组件用 React onKeyDown 接 Esc(录制快捷键/文件树右键菜单都挂 window
      // 捕获、相位在本监听之前),所以捕获阶段截断不会掐掉面板自己的"取消编辑"。
      const _t = e.target;
      if (isEditableTarget(_t)) {
        if (_t.closest?.('[data-cgui-panel]')) e.stopPropagation();
        return;
      }
      // confirmDialog 挂在 document 冒泡阶段(晚于本监听),不避让会「面板关了、确认框还在」。
      if (document.querySelector('[data-cgui-confirm]')) return;
      const _st = useStore.getState();
      const _yieldId = escYieldCardId({
        targetTag: e.target, // 传元素本身:只给 tagName 时 contentEditable 永远测不到(富文本焦点+卡片=哑键)
        pendingList: _st.pendingPermissions,
        psid: (_st.paneSessions && _st.paneSessions[_st.activeTabIndex || 0])?.sessionId || null,
        yieldedForId,
      });
      if (_yieldId) { yieldedForId = _yieldId; return; } // 让给权限/计划卡,面板不关
      e.stopPropagation();
      setRightPanel(null);
    };
    document.addEventListener('keydown', onEsc, true);
    return () => document.removeEventListener('keydown', onEsc, true);
  }, [rightPanel, setRightPanel]);

  // 修正批#7:Provider 管理独立弹窗(顶栏切换卡片底部「管理 Provider」触发;设置里的
  // Provider tab 已删)。手机端不派发此事件(合并入口页内是导航流全屏页)。
  const [providerMgrOpen, setProviderMgrOpen] = useState(false);
  // 行内编辑按钮直达:事件 detail.editId 带来要编辑的 provider(自定义项进编辑态)。
  const [providerMgrEditId, setProviderMgrEditId] = useState(null);
  useEffect(() => {
    const onOpenMgr = (e) => { setProviderMgrEditId(e?.detail?.editId || null); setProviderMgrOpen(true); };
    window.addEventListener('cgui:open-provider-manager', onOpenMgr);
    return () => window.removeEventListener('cgui:open-provider-manager', onOpenMgr);
  }, []);

  // P1.4:任意组件经此事件打开设置面板并定位到指定设置组。与 jumpToUpdate 同一
  // __cguiSettingsJump 兜底。
  useEffect(() => {
    const onOpenSettings = (e) => {
      setRightPanel('settings');
      const section = e?.detail?.section;
      if (section) {
        window.__cguiSettingsJump = section;
        window.dispatchEvent(new CustomEvent('cgui:settings-jump', { detail: { section } }));
      }
    };
    window.addEventListener('cgui:open-settings', onOpenSettings);
    return () => window.removeEventListener('cgui:open-settings', onOpenSettings);
  }, []);

  // P2.6 导引兜底:composer 系步骤进入时若活跃窗格无会话,自动建 draft(不落盘、无副作用),
  // 让 composer/模式/模型/力度/⋮ 锚点进 DOM。无项目态不建 —— 这些步骤保持自动跳过,
  // 导引末步文案引导"添加项目后重看"。复用 Cmd+N 的草稿逻辑,只写活跃窗格 keyed slot。
  useEffect(() => {
    const onEnsureDraft = () => {
      const st = useStore.getState();
      const idx = st.activeTabIndex || 0;
      const cur = (st.paneSessions && st.paneSessions[idx]) || st.selectedSession;
      if (cur) return; // 已有会话/draft,composer 已在
      const proj = st.selectedProject;
      if (!proj) return;
      st.setPaneSession(idx, { draft: true, draftId: newDraftId(), sessionId: null, projectHash: proj.hash, projectPath: proj.path, firstPrompt: '新会话' });
      st.setPaneMessages(idx, []);
    };
    window.addEventListener('cgui:tour-ensure-draft', onEnsureDraft);
    return () => window.removeEventListener('cgui:tour-ensure-draft', onEnsureDraft);
  }, []);

  // P1.6 面板直达:Cmd/Ctrl+1..9 按 PANEL_MAP 顺序开对应面板,0=设置;再按一次=关闭
  // (与点面板按钮同语义)。rightPanel 是 App 级单值状态、面板本身无 per-pane 语义,
  // 故挂 window 全局无需 paneIsActive 门控;不受面板坞折叠态影响(rail 收起也直达)。
  // meta 组合键不会往输入框打字,输入焦点时也响应(与 Cmd+/ 同策略)。
  useEffect(() => {
    const panelIds = Object.keys(PANEL_MAP);
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.repeat) return; // T5#2:长按连发只算一次,避免面板开关反复闪
      if (!/^[0-9]$/.test(e.key)) return;
      const id = e.key === '0' ? 'settings' : panelIds[Number(e.key) - 1];
      if (!id) return;
      e.preventDefault();
      setRightPanel((cur) => (cur === id ? null : id));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // P2.2(T2):内置 6 个 agent 首启静默安装一次(复用现有 install 端点,skip 不覆盖
  // 用户同名文件)。marker 只跑一次;失败静默、不置 marker,下次启动再试;不阻断任何发送。
  // 防"用户删过 agent 又被装回":仅当内置 agent 一个都没装时才安装;已装过任意一个
  // 视为用户已接管,直接记 marker 不再打扰。
  useEffect(() => {
    try { if (localStorage.getItem('cgui-builtin-agents-installed') === '1') return; } catch {}
    (async () => {
      try {
        const d = await (await fetch('/api/agents/builtin')).json();
        const list = Array.isArray(d?.agents) ? d.agents : [];
        if (!list.length) return; // 接口异常/无预设:静默,下次再试
        if (!list.some((a) => a.installed)) {
          const r = await fetch('/api/agents/builtin/install', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (!r.ok) return; // 失败静默(磁盘/权限),下次启动再试
        }
        try { localStorage.setItem('cgui-builtin-agents-installed', '1'); } catch {}
      } catch { /* 静默,下次启动再试 */ }
    })();
  }, []);

  // Bug #11:首次启动检测 claude CLI;没装就弹模态按系统给安装指引(给小白用户)。
  // dismissed 仅本次会话生效 — 跳过后下次启动还会再问,不本地永存(用户可能装了又卸)。
  const [cliInstalled, setCliInstalled] = useState(true);  // 乐观:有就当装了,errored 才显示
  // 用户点"跳过"后写 localStorage 永久 dismiss(下次启动也不弹)。
  // 但 server 检测到装了的话仍自动隐藏,无需用户操心(installed=true 优先)。
  const [cliCheckDismissed, setCliCheckDismissed] = useState(() => {
    try { return localStorage.getItem('cgui-cli-check-dismissed') === '1'; } catch { return false; }
  });
  const checkCli = useCallback(async () => {
    try {
      const r = await fetch('/api/cli-check');
      const d = await r.json();
      setCliInstalled(!!d.installed);
      // 检测到装了 → 同步清除 dismiss flag(用户之前可能误跳过,现在装好了)
      if (d.installed) {
        try { localStorage.removeItem('cgui-cli-check-dismissed'); } catch {}
        setCliCheckDismissed(false);
      }
    } catch { /* server 自己挂了就不弹,免得让用户更晕 */ }
  }, []);
  useEffect(() => { checkCli(); }, [checkCli]);
  const dismissCliCheck = useCallback(() => {
    try { localStorage.setItem('cgui-cli-check-dismissed', '1'); } catch {}
    setCliCheckDismissed(true);
  }, []);

  // L2: macOS 首次启动权限引导。本机 dismissed flag 落盘到 ~/.claude-gui/(避免 localStorage 跨壳不一致)。
  const [needsFDA, setNeedsFDA] = useState(false);
  const [fdaDismissed, setFdaDismissed] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const [s, d] = await Promise.all([
          fetch('/api/system/permission-status').then((r) => r.json()),
          fetch('/api/system/permission-guide-dismissed').then((r) => r.json()),
        ]);
        setNeedsFDA(!!s.needsFullDiskAccess);
        setFdaDismissed(!!d.dismissed);
      } catch {}
    })();
  }, []);
  const dismissFDA = useCallback(async () => {
    setFdaDismissed(true);
    try { await fetch('/api/system/permission-guide-dismissed', { method: 'POST' }); } catch {}
  }, []);
  const openFDASettings = useCallback(async () => {
    try { await fetch('/api/system/open-fda-settings', { method: 'POST' }); } catch {}
    dismissFDA();
  }, [dismissFDA]);

  // 每次打开 GUI 检查 GUI + Claude Code 是否有新版,有则顶部弹横幅(本次会话可关闭)。
  // 不固定时间——只在启动时查一次。详细更新操作在 设置 → 概览。
  const [updateNotice, setUpdateNotice] = useState(null); // { gui?: ver, cc?: ver }
  // CJ-2:弹窗"稍后"只关弹窗、不清 updateNotice —— 顶栏「更新」按钮据此长期提醒(没点更新就一直在)。
  const [updateModalDismissed, setUpdateModalDismissed] = useState(false);
  // 跳设置→更新区并定位 gui/cc 段。window 事件 + window.__cguiSettingsJump(SettingsPanel 挂载晚于事件时兜底读)。
  const jumpToUpdate = useCallback((section) => {
    setRightPanel('settings');
    setUpdateModalDismissed(true);
    window.__cguiSettingsJump = section;
    window.dispatchEvent(new CustomEvent('cgui:settings-jump', { detail: { section } }));
  }, []);
  useEffect(() => {
    // 原实现只在启动查一次且只置不清 → 用户随后把 CLI/GUI 更到最新,红色「更新」按钮
    // 仍常亮到重启(用户报告)。改为可重跑 + 无更新即清:启动 / 每 30 分钟 / 窗口重获
    // 焦点(限 5 分钟一次,覆盖"在终端更完 CLI 切回来")/ 设置页更新完成事件,都重查。
    let lastRun = 0;
    const checkUpdates = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastRun < 5 * 60_000) return;
      lastRun = now;
      const n = {};
      // 本机 bot 版(localBuild)不提示 GUI 更新:app 内更新会覆盖丢 bot(SettingsPanel 也硬 gate
      // 了下载入口),且本机版本号通常≥公开版,提示"有新版"是误导。version-check 响应已含 localBuild,
      // 直接取用,不必多打 /api/health。Claude Code 更新与此无关,照常提示。
      try { const d = await (await fetch('/api/version-check')).json(); if (d.hasUpdate && !d.localBuild) n.gui = d.latestVersion; } catch {}
      try { const d = await (await fetch('/api/claude-version-check')).json(); if (d.hasUpdate) n.cc = d.latestVersion; } catch {}
      setUpdateNotice((n.gui || n.cc) ? n : null);
    };
    checkUpdates(true);
    const timer = setInterval(() => checkUpdates(true), 30 * 60_000);
    const onFocus = () => checkUpdates(false);
    const onRecheck = () => checkUpdates(true);
    window.addEventListener('focus', onFocus);
    window.addEventListener('cgui:recheck-updates', onRecheck);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); window.removeEventListener('cgui:recheck-updates', onRecheck); };
  }, []);

  // Q1: bundle↔server 版本握手。__BUILD_VERSION__ 由 vite 烤进 bundle;server 版本
  // 走 /api/health(no-store,永远新鲜)。不一致说明本页面是旧 bundle(WebView 缓存/
  // 代理/打包塞了旧 dist),先带 ?v= 强制换缓存键重载一次自愈;重载后仍不一致则是
  // dist 本身是旧的(重载救不了),挂红色横幅报警——旧版界面从此不可能"伪装"成新版。
  const [bundleMismatch, setBundleMismatch] = useState(null); // { bundle, server }
  useEffect(() => {
    (async () => {
      try {
        const h = await (await fetch('/api/health')).json();
        if (!h.version || typeof __BUILD_VERSION__ === 'undefined') return;
        if (h.version === __BUILD_VERSION__) {
          sessionStorage.removeItem('cgui-ver-busted');
          return;
        }
        if (sessionStorage.getItem('cgui-ver-busted') !== h.version) {
          sessionStorage.setItem('cgui-ver-busted', h.version);
          // CL-3:重载目标带 ?v=版本 + &t=时间戳。固定的 /?v=X 在 Windows WebView2 上可能被
          // 当成可缓存条目重新端出旧 bundle(用户报"重装后爆红、设置版本却一致");加每次不同的
          // &t= 让它永远 cache-miss、强制取新 index.html(→新 hash 资源)。SPA 不读 query 无副作用。
          window.location.replace('/?v=' + encodeURIComponent(h.version) + '&t=' + Date.now());
          return;
        }
        setBundleMismatch({ bundle: __BUILD_VERSION__, server: h.version });
      } catch {}
    })();
  }, []);

  // 更新完成后的安装包清理:GUI 一键更新把安装包下到 ~/Downloads 并记录路径;
  // 以新版本首次启动时(后端比对版本判定更新已完成)提示删除。同意才删;
  // 选择保留则清除记录,之后不再提示。
  useEffect(() => {
    (async () => {
      try {
        const d = await (await fetch('/api/update-cleanup')).json();
        if (!d?.pending) return;
        const ok = await confirmDialog(
          `更新已完成。是否删除更新时下载的安装包?\n\n${d.name}(${d.sizeMB}MB)\n${d.path}`,
          { danger: true, confirmText: '删除', cancelText: '保留' },
        );
        await fetch(ok ? '/api/update-cleanup/delete' : '/api/update-cleanup/dismiss', { method: 'POST' });
      } catch { /* 查询/删除失败静默,不影响启动 */ }
    })();
  }, []);

  // Pull the shared session-title map so a rename on the phone shows on the Mac
  // (and vice-versa). Live updates arrive via the ws 'custom-titles' broadcast.
  // 审计批A6:ws-reconnected 时重跑 —— 断线期间的 custom/auto-titles、context-1m
  // 广播已永久丢失,重连补拉一次收敛(与权限卡/列表对账同构;hydrate 均幂等)。
  useEffect(() => {
    const hydrate = () => { useStore.getState().hydrateCustomTitles(); useStore.getState().hydrateAutoTitles(); useStore.getState().hydrateContext1m(); };
    hydrate();
    window.addEventListener('cgui:ws-reconnected', hydrate);
    return () => window.removeEventListener('cgui:ws-reconnected', hydrate);
  }, []);

  // 停止链路 #3:回合间到达的子代理权威终态通知(server 无活跃 SSE 时经全局 WS
  // 广播 task-notification-bg → useWebSocket 转 window 事件)。按 tool_use_id 调
  // finalizeAgent 收尾(幂等:已终态条目 no-op),级联嵌套子代理一并收。
  useEffect(() => {
    const onBgTaskNotification = (e) => {
      const { tool_use_id, task_id, status } = e.detail || {};
      const st = useStore.getState();
      // 双键(批A A4):服务端带了 task_id 却只用 tool_use_id,而 task_updated 转来的通知在
      // 第三方 provider / 早期条目上可能没有 tool_use_id → 广播白发。
      const id = (tool_use_id && st.activeAgents[tool_use_id]) ? tool_use_id : findAgentIdByTaskId(st, task_id);
      // authoritative=true:真 task_notification 允许覆盖 taskManaged 的猜测性 stopped(#1 UI 侧)。
      if (id) finalizeAgent(st, id, status, undefined, true);
    };
    // 批A A4:服务端按 CLI 的 background_tasks_changed 对完账后广播的【存活集】。
    // 只做两件事:① settled 里的条目直接收尾;② 本会话 taskManaged 且不在集内的僵尸卡剪掉。
    // 【永不据此 finalize 流 / abort 进程】—— 纯 UI 收敛。收出来的终态标 settledBy,
    // 表示"成败未知,只知道它结束了";随后到达的权威终态可以覆盖它(finalizeAgent canOverride)。
    const settleByLevel = (id) => {
      const st = useStore.getState();
      const a = st.activeAgents[id];
      // 已是终态就不碰:那可能是刚到的【权威】终态,盖上 settledBy 会把绿勾降级成中性"已结束"。
      if (!a || ['done', 'error', 'stopped'].includes(a.status)) return;
      // 先钉 settledBy(成败未知)再走既有收尾 —— finalizeAgent 还会级联收未终态的嵌套
      // 子代理、给悬空的内部 toolCall 补合成结果,直接 upsert 拿不到这两件事。
      // 非 authoritative:这只是对账推断,不解除 optimisticStop 的待回滚保护。
      st.upsertAgent(id, { settledBy: 'level' });
      finalizeAgent(st, id, 'completed');
    };
    const onBackgroundTasks = (e) => {
      const d = e.detail || {};
      for (const tuid of (d.settled || [])) settleByLevel(tuid);
      for (const id of pruneByLiveSet(useStore.getState().activeAgents, d)) settleByLevel(id);
    };
    // 停止链路 #2:监控面板杀 Claude 子进程后按 sessionId 级联收尾(流外杀点无流内信号)。
    const onSessionProcsKilled = (e) => {
      const sid = e.detail?.sessionId;
      if (sid) finalizeSessionAgents(sid);
    };
    window.addEventListener('cgui:task-notification-bg', onBgTaskNotification);
    window.addEventListener('cgui:background-tasks', onBackgroundTasks);
    window.addEventListener('cgui:session-procs-killed', onSessionProcsKilled);
    return () => {
      window.removeEventListener('cgui:task-notification-bg', onBgTaskNotification);
      window.removeEventListener('cgui:background-tasks', onBackgroundTasks);
      window.removeEventListener('cgui:session-procs-killed', onSessionProcsKilled);
    };
  }, []);

  // Optional local-only widgets (client/src/components/*.local.jsx). Fresh
  // checkouts have none; public builds temporarily move them out of the build
  // graph so personal controls do not enter client/dist or Tauri bundles.
  // Render EVERY local widget (not just the first) so multiple *.local.jsx can
  // coexist — e.g. a bot control + a local-only theme skin.
  const [localWidgets, setLocalWidgets] = useState([]);
  useEffect(() => {
    const mods = import.meta.glob('./components/*.local.jsx');
    Promise.all(Object.values(mods).map((fn) => fn().then((m) => m.default).catch(() => null)))
      .then((list) => setLocalWidgets(list.filter(Boolean)));
  }, []);
  const LocalWidgets = () => localWidgets.map((W, i) => <W key={i} />);

  // 全局轮询正在运行的 chat-process → store,驱动侧栏状态符号(ProjectList /
  // SessionItem)。与按会话的 backgroundPid 轮询相互独立。
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch('/api/agents/active');
        const d = await r.json();
        if (cancelled) return;
        // #26:排除 idle(常驻保活)——它不是"正在跑",否则会话绿点永远亮着
        const running = (d.agents || []).filter((a) => a.kind === 'chat-process' && a.stoppable === true && a.status !== 'idle');
        useStore.getState().setRunningStatus(
          new Set(running.map((a) => a.sessionId).filter(Boolean)),
          new Set(running.map((a) => a.cwd).filter(Boolean)),
        );
      } catch {}
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  // Per-session permission key for the header chip + bypass auto-resolve.
  // Follows the ACTIVE pane (not always pane 0) so in split mode the top-bar
  // mode chip controls whichever pane the user last focused — matching the
  // sessionQueueKey that pane's composer sends with.
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const paneSessions = useStore((s) => s.paneSessions);
  const paneCount = useStore((s) => s.paneCount);
  const customTitles = useStore((s) => s.customTitles);
  // U6:顶栏"项目/会话标题"也要跟随 AI 自动标题(custom > auto > firstPrompt),
  // 之前只读 customTitles → 自动标题生成后顶栏仍显示首条消息。
  const autoTitles = useStore((s) => s.autoTitles);
  // (P2.1) 顶栏会话级选择器已迁 composer:App 根不再需要 activeSession/permKey
  // (各 pane 的 composer 用自己的 sessionQueueKey/sessionId)。

  // 分屏焦点切换 / focus pane 的 session 变化时,让左侧 selectedProject 自动跟到
  // 对应项目,顺便 silent-refresh 该项目的 sessions 列表 — 这样用户切焦点时
  // 左侧能直接看到当前 pane 在用的会话(并被高亮),不用手动回项目列表找。
  //
  // ⚠️ 用于本同步的活动会话【分屏下只认活动窗格,绝不回退到 selectedSession】:
  // 删除聚焦窗格的会话时 handleDelete 把该窗格设 null,若沿用 activeSession 的
  // `|| selectedSession` 回退,activeProjectHash 会跳到别的窗格(tab0)会话所属的
  // 【另一个项目】→ 左侧列表莫名跳走(用户实报)。窗格空(null)时 activeProjectHash
  // 为 undefined,effect 早退,selectedProject 留在原项目不动。非分屏仍用 selectedSession。
  const syncActiveSession = paneCount > 1 ? ((paneSessions && paneSessions[activeTabIndex]) || null) : ((paneSessions && paneSessions[activeTabIndex]) || selectedSession);
  const activeProjectHash = syncActiveSession?.projectHash;
  useEffect(() => {
    if (!activeProjectHash) return;
    const st = useStore.getState();
    if (st.selectedProject?.hash === activeProjectHash) return;
    let proj = (st.projects || []).find((p) => p.hash === activeProjectHash);
    // 兜底:未落盘的 worktree draft(新建会话没发消息)不在 projects 列表 → find 落空 → 原来直接
    // return,导致切走再切回该空会话时左侧列表回不到它的项目(停在上一个窗格的项目,用户实报)。
    // enterWorktree 首次进入时有同款兜底构造,这里对齐:用 draft 自带的 projectPath 构造最小 project
    // (hash+path 都在 draft 里,不需请求)。仅对带 projectPath 的会话兜底,不给真落盘项目临时读不到瞎造。
    if (!proj && syncActiveSession?.projectPath) {
      const path = syncActiveSession.projectPath;
      proj = { hash: activeProjectHash, path, isWorktree: /-worktrees[\\/]|[\\/]\.claude[\\/]worktrees[\\/]/.test(path), sessionCount: 0, lastActivity: null };
    }
    if (!proj) return;
    st.setSelectedProject(proj);
    st.fetchSessions(proj.hash, { silent: true });
  }, [activeProjectHash]);

  // Apply persisted UI font scale on mount. Use document.documentElement.style
  // .zoom so even text-[12px]-style hardcoded sizes scale (not just rem).
  const isMobile = useIsMobile();
  // On entering a phone-sized viewport, collapse the sidebar so the chat
  // (not the drawer) is what's visible first. Desktop keeps its own state.
  // Also force single-pane: a phone only renders pane 0, but a stale paneCount>1
  // (from desktop split usage persisted in this browser's localStorage) would
  // leave splitMode=true, so SessionList.handleSelect routes picks into the
  // hidden pane 1 instead of selectedSession — making "选会话/新建会话" look dead.
  useEffect(() => {
    if (!isMobile) return;
    const st = useStore.getState();
    if (!st.sidebarCollapsed) st.toggleSidebar();
    if (st.paneCount > 1) st.setPaneCount(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  // 首次启动自动弹使用指引(仅桌面端):localStorage 无 cgui-tour-seen 标志即弹,
  // 看完/跳过在 onClose 写标志,此后只能从顶栏问号手动打开。手机布局不弹(导览
  // 高亮的顶栏按钮在手机上大多不渲染,逐个跳过体验差)。
  // ⚠️ 必须等首启的一次性弹窗(EnvCheckPanel 环境检查 / updateNotice 更新提示)先关闭再弹:
  // 导览的高亮是"四周压暗 + 中间镂空透出下面内容",若叠在那些弹窗的遮罩之上,镂空透出的是
  // 被盖灰的顶栏,看着就是一堆灰框(用户实测:更新弹窗关掉后手动点问号即正常)。deps 含这些
  // 弹窗态 → 它们关闭后 effect 重跑,届时界面干净才弹。手动点问号不受此 gate 限制。
  useEffect(() => {
    if (isMobile || tourOpen) return;
    try { if (localStorage.getItem('cgui-tour-seen')) return; } catch { return; }
    const envBlocking = !cliInstalled && !cliCheckDismissed;      // 环境检查大弹窗在显示
    const updateBlocking = !!updateNotice && !updateModalDismissed; // 更新大弹窗在显示
    if (envBlocking || updateBlocking) return;                    // 让路,等其关闭后重跑
    const t = setTimeout(() => setTourOpen(true), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, tourOpen, cliInstalled, cliCheckDismissed, updateNotice, updateModalDismissed]);
  const closeTour = useCallback(() => {
    setTourOpen(false);
    try { localStorage.setItem('cgui-tour-seen', '1'); } catch {}
  }, []);

  // Mobile: picking a session (or starting a new chat) auto-closes the drawer so
  // the chat is revealed — matching the Claude app. selectedSession changes
  // identity on every pick; project-only changes don't touch it, so the drawer
  // stays open while browsing a project's session list.
  const mobileSelSession = useStore((s) => s.selectedSession);
  useEffect(() => {
    if (isMobile && mobileSelSession && !useStore.getState().sidebarCollapsed) {
      useStore.getState().toggleSidebar();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobileSelSession]);

  // New chat from the mobile top bar's ✎. Needs a selected project; if none,
  // just open the drawer so the user can pick one first.
  const startMobileNewChat = () => {
    const st = useStore.getState();
    // Prefer the explicitly-selected project; otherwise fall back to the project
    // of the session currently open, so the ✎ button creates a new chat in the
    // SAME project folder you're chatting in (not a dead no-op).
    const sel = st.selectedSession;
    const proj = st.selectedProject
      || (sel && sel.projectHash ? { hash: sel.projectHash, path: sel.projectPath } : null);
    if (!proj) { if (st.sidebarCollapsed) st.toggleSidebar(); return; }
    st.setSelectedSession({
      draft: true, draftId: newDraftId(), sessionId: null, projectHash: proj.hash,
      projectPath: proj.path, firstPrompt: '新会话',
    });
    useStore.setState({ messages: [] });
    st.setPaneMessages(0, []);
  };
  const mobileTitle = mobileSelSession
    ? (customTitles[mobileSelSession.sessionId] || autoTitles[mobileSelSession.sessionId] || mobileSelSession.firstPrompt?.slice(0, 24) || '新会话')
    : 'Claude Code';

  const uiFontScale = useStore((s) => s.uiFontScale);
  useEffect(() => {
    const z = uiFontScale || 1;
    const html = document.documentElement;
    const apply = () => {
      try {
        html.style.zoom = String(z);
        html.style.setProperty('--ui-zoom', String(z));
        // CSS calc(100vw/--ui-zoom) is correct in Chromium but DOUBLE-compensates
        // in macOS WKWebView (Tauri), where `vw`/`vh` are already divided by zoom
        // → toolbar overflows the window and the page clips. window.innerWidth/
        // Height are zoom-invariant in BOTH engines, so compute the px ourselves.
        html.style.setProperty('--app-w', (window.innerWidth / z) + 'px');
        html.style.setProperty('--app-h', (window.innerHeight / z) + 'px');
      } catch {}
    };
    apply();
    // Tauri 启动首屏:WKWebView 第一帧上报的 window.innerWidth 常常偏小/未定型,
    // apply() 拿到窄宽 → --app-w 偏小 → 顶部工具栏按窄宽 flex-wrap 换行,直到用户
    // 拖拽窗口(触发 resize)才回正(用户报告"每次打开菜单栏分行,拖宽才同行")。
    // 窗口定型后再补几次 apply,无需用户手动 resize。
    const raf = requestAnimationFrame(apply);
    const timers = [60, 200, 500, 1000].map((ms) => setTimeout(apply, ms));
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
    };
  }, [uiFontScale]);

  // Soft-keyboard awareness (#1): publish the keyboard height as `--kb` so the
  // mobile root can lift its bottom above it. Divided by the font zoom because
  // the root's `bottom` inset is itself scaled by the <html> zoom.
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const z = useStore.getState().uiFontScale || 1;
      document.documentElement.style.setProperty('--kb', `${kb / z}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      document.documentElement.style.removeProperty('--kb');
    };
  }, [isMobile]);

  // Apply persisted color theme on mount. Maps `cguiTheme` store value to
  // the `data-cgui-theme="<name>"` attribute on <html>, picked up by the
  // theme blocks in index.css.
  const cguiTheme = useStore((s) => s.cguiTheme);
  useEffect(() => {
    try {
      if (cguiTheme) document.documentElement.setAttribute('data-cgui-theme', cguiTheme);
      else document.documentElement.removeAttribute('data-cgui-theme');
    } catch {}
  }, [cguiTheme]);

  // Resync remote-control locks on mount. The `remoteControlled` map lives in
  // memory only, so a refresh would clear the composer lock while the server's
  // hidden RC pty is still alive — re-enabling sends and risking a double-write
  // to the same session jsonl. Pull the server's active list and restore locks.
  useEffect(() => {
    fetch('/api/remote-control')
      .then((r) => r.json())
      .then((d) => (d?.active || []).forEach((sid) => useStore.getState().setRemoteControl(sid, true)))
      .catch(() => {});
  }, []);

  // A1 裁决单点化:原"切到放任批量放行本会话 pending"effect 已删 —— 切档的
  // POST /chat/permission-mode 在服务端按新档对 pending 重裁(resolvePendingForSession),
  // allow/deny/撤卡全由服务端 settle + resolved 广播完成,客户端不再抢答。

  // Rehydrate after refresh: if a session was persisted, reload its message
  // history + the project's session list. silent:true so we don't render the
  // loading screen and lose the page's restored scroll position.
  useEffect(() => {
    let { selectedProject: p, selectedSession: s } = useStore.getState();
    const { fetchProjects, fetchSessions, fetchMessages, setSelectedProject, setSelectedSession } = useStore.getState();

    // Self-heal: if a previous bug stored the project with a wrong hash
    // (missing the leading "-"), or if the hash doesn't match what the CLI
    // actually uses for this path, regenerate it. Otherwise fetchSessions
    // 404s and the session list stays empty forever.
    if (p?.path) {
      // Normalize the SELECTED PROJECT's path for nice display + clean git
      // operations. But DO NOT touch selectedSession.projectHash — that hash
      // must continue to match the on-disk jsonl directory exactly, even if
      // it has trailing dashes, because the CLI uses it to locate the session
      // for --resume. Sanitizing it here would orphan the session pointer.
      const cleanPath = p.path.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
      const expectedHash = cleanPath.replace(/[^A-Za-z0-9]/g, '-');
      if (p.path !== cleanPath || p.hash !== expectedHash) {
        const corrected = { ...p, path: cleanPath, hash: expectedHash };
        setSelectedProject(corrected);
        p = corrected;
        // selectedSession kept as-is on purpose.
      }
    }

    fetchProjects();
    if (p?.hash) fetchSessions(p.hash, { silent: true });
    if (s?.sessionId && s?.projectHash) fetchMessages(s.sessionId, s.projectHash, { silent: true });
    // Detect the active upstream provider (anthropic / deepseek / mimo / ...)
    // so pricing is computed against the real backend even when cc switch
    // routes Claude-shaped API calls elsewhere. Refresh on settings.json
    // change (the WS file-watcher dispatches cgui:provider-change).
    useStore.getState().fetchProvider();
    // 手机批#3:全局默认模型(settings.json 解析结果)在挂载时就拉一次。桌面顶栏的
    // ModelSelector 也会拉,但手机端不挂它 → currentModel 一直是 null,菜单里模型
    // 徽章显示"?",被用户误读为"手机不继承、必须重新选"。实际发送链(pin→历史→
    // 全局默认)一直是对的,这里只把"解析后的全局默认"显示出来。
    useStore.getState().fetchModel();
    // 审计批A2:会话级偏好(权限档/模型 pin/力度 pin)水合 —— 服务端值优先收敛,
    // 本地存量实键回推。挂载 + ws-reconnected 触发;provider-change 不触发(切换
    // 链路里 clearModelOverrides 的 clear PUT 与 GET 会竞速,旧 pin 可能被拉回)。
    useStore.getState().hydrateSessionSync();
    const onProvCh = () => { useStore.getState().fetchProvider(); useStore.getState().fetchModel(); };
    window.addEventListener('cgui:provider-change', onProvCh);
    // 审计批A1:断线期间 provider-change 广播已丢(半死连接常态)→ 重连成功即补拉
    // provider/model 对账,与权限卡 refetchPendingPermissions 同构。
    const onReconn = () => { onProvCh(); useStore.getState().hydrateSessionSync(); };
    window.addEventListener('cgui:ws-reconnected', onReconn);
    // 回前台补拉(手机切后台期间 WS 冻结,回来时广播早丢):节流 60s,频繁切 tab 不打。
    // 审计批收尾#4:session-sync 也补拉,与 ws-reconnected 路径对齐(后台期间对端改的
    // 权限档/模型 pin/力度 pin 广播已丢);首次迁移后水合纯拉取(收尾#1),多拉无副作用。
    let lastVisPull = Date.now();
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastVisPull < 60_000) return;
      lastVisPull = Date.now();
      onProvCh();
      useStore.getState().hydrateSessionSync();
    };
    document.addEventListener('visibilitychange', onVis);
    // Warm the MCP cache so the first click on the MCP panel is instant
    // (claude mcp list cold spawn is ~2s).
    fetch('/api/mcp').catch(() => {});
    return () => {
      window.removeEventListener('cgui:provider-change', onProvCh);
      window.removeEventListener('cgui:ws-reconnected', onReconn);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // All hooks above; safe to short-circuit to the login gate here.
  if (authLocked) return <LoginScreen onSuccess={() => window.location.reload()} />;

  // 审计批A3:版本不一致横幅抽成共享块 —— 手机经局域网访问同一前端,旧 bundle 告警
  // 同样需要可见(原来只在桌面 return 里渲染,手机端旧前端会静默伪装成新版)。
  const bundleMismatchBanner = bundleMismatch && (
    <div className="fixed top-0 inset-x-0 z-[300] bg-red-600 text-white text-[12px] font-body px-4 py-2 flex items-center justify-center gap-3 flex-wrap shadow-lg">
      <span>⚠️ 界面 v{bundleMismatch.bundle} 与服务端 v{bundleMismatch.server} 不一致。请依次尝试：① 完全退出 GUI 再打开（会自动换用新版服务并绕过缓存）② 仍出现则说明安装包内是旧前端，请重新下载安装</span>
      <button
        onClick={() => { sessionStorage.removeItem('cgui-ver-busted'); window.location.replace('/?r=' + bundleMismatch.server); }}
        className="px-2 py-0.5 rounded bg-white text-red-600 font-medium hover:bg-white/90 transition-colors shrink-0">重试</button>
      <button onClick={() => setBundleMismatch(null)} className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 transition-colors shrink-0">知道了</button>
    </div>
  );

  if (isMobile) {
    // CSS zoom scales fixed-size UI too. Keep the mobile root's layout box
    // divided by the zoom factor so "超大" text does not push the app outside
    // the physical viewport. `--kb` still lifts it above the soft keyboard.
    return (
      <div
        className="cgui-mobile-root flex flex-col overflow-hidden isolate"
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          // Same zoom-invariant px sizing as the desktop root (--app-w/--app-h
          // are window.innerWidth/Height ÷ zoom). CSS calc(100vw/zoom) here
          // DOUBLE-compensated in WKWebView (phone PWA / Safari), so scaling the
          // font shrank the page to viewport÷zoom² — content jammed into a
          // corner. --kb still lifts the bottom above the soft keyboard.
          width: 'var(--app-w, 100vw)',
          height: 'calc(var(--app-h, 100dvh) - var(--kb, 0px))',
        }}
      >
        {/* ③ 全局自定义背景层(手机端同桌面)。 */}
        <GlobalBackgroundLayer />
        <MobileTopBar onMenu={toggleSidebar} onNew={startMobileNewChat} title={mobileTitle} />
        <MainLayout
          sidebarCollapsed={sidebarCollapsed}
          selectedProject={selectedProject}
          rightPanel={rightPanel}
          setRightPanel={setRightPanel}
          isMobile={isMobile}
          updateNotice={updateNotice}
        />
        {LocalWidgets()}
        {/* 外接键盘按 Cmd+/ 也能开;不渲染的话状态会隐形置真并吞掉 Esc */}
        <ShortcutsPanel open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        {/* 审计批A3/A4:版本告警横幅 + 非聚焦会话完成提醒,手机端同样渲染
            (toast 点击跳转走 paneSessions[0],手机单窗格语义一致)。 */}
        {bundleMismatchBanner}
        <CompletionToasts />
        {!cliInstalled && !cliCheckDismissed && (
          <EnvCheckPanel onRecheck={checkCli} onDismiss={dismissCliCheck} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden relative isolate" style={{ width: 'var(--app-w, 100vw)', height: 'var(--app-h, 100dvh)' }}>
      {/* ③ 全局自定义背景层:垫在所有面板之下(root relative+isolate 兜住 -z-10)。 */}
      <GlobalBackgroundLayer />
      {/* Top bar — glass */}
      {/* Top bar uses min-height instead of fixed h-12 so when font scales up
          and the right cluster wraps to a second line, the bar grows with the
          content instead of clipping. flex-wrap on both sides keeps it from
          horizontally overflowing on narrow viewports. */}
      {/* 排版规则(用户要求):所有内容放得下就一行;放不下时左簇(项目/标题)先截断
          让位(flex-1 min-w-0 + truncate),仍不够右簇整体换行且行内右对齐(justify-end)。
          原来左簇不收缩,默认窗宽+中字号就把右簇挤下去 → 打开必两行。 */}
      <header className="glass-bar min-h-12 px-4 py-1 flex items-center gap-y-1 flex-wrap shrink-0 relative z-40">
        <div className="flex items-center gap-2 min-w-0 flex-1 basis-64">
          <button data-tour="sidebar-toggle" onClick={toggleSidebar} className="btn-glass p-1.5 transition-colors shrink-0" title={sidebarCollapsed ? '展开' : '收起'}>
            {sidebarCollapsed ? <ChevronRight size={15} className="text-ink-muted" /> : <ChevronLeft size={15} className="text-ink-muted" />}
          </button>
          {/* 顶栏品牌 logo:Claude 官方风格 —— accent 八瓣星芒(内联 SVG,缓慢呼吸)
              + 大号衬线字标 "Claude"(样式在 index.css .cgui-brand) */}
          <span className="cgui-brand shrink-0 select-none" aria-label="Claude">
            {/* 官方 Claude spark(与气泡头像 ProviderAvatar 同一份 path,取自
                anthropics/anthropic-sdk-typescript)。此前是自制 8 瓣星芒,用户嫌不像官方。 */}
            <svg className="cgui-brand-spark" viewBox="0 0 248 248" fill="currentColor" aria-hidden="true">
              <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
            </svg>
            <span className="cgui-brand-name">Claude</span>
          </span>
          {selectedProject && (
            <span className="chip font-mono truncate min-w-0 max-w-[160px]">
              {formatPathShort(selectedProject.path)}
            </span>
          )}
          {/* 标题跟随焦点 pane(headerPane,判官盲审#2):全局 selectedSession 只是
              pane 0 镜像,分屏焦点在别的 pane 时标题不跟随。同 headerPermKey 口径。 */}
          {headerPane && (
            <>
              <span className="text-ink-ghost shrink-0">/</span>
              <span className="text-[11px] text-ink-muted font-body truncate min-w-0 max-w-[180px]">
                {customTitles[headerPane.sessionId] || autoTitles[headerPane.sessionId] || headerPane.firstPrompt?.slice(0, 36) || headerPane.sessionId?.slice(0, 8) || '新会话'}
              </span>
            </>
          )}
        </div>
        {/* 顶栏终稿:右簇 [Provider][模型][力度][远程][主题][设置坞][?帮助]
            (问号最右)。Provider/模型/力度/远程作用于「活跃窗格」的会话
            (headerPermKey,分屏时跟随聚焦格);composer 只留
            [权限模式][附件][旁问]。弹层均走 AnchoredPopover(portal 顶层)向下弹。 */}
        <div className="flex items-center gap-1 flex-wrap justify-end min-w-0 ml-auto">
          <ProviderSwitcher tourAnchor respondOpenProvider />
          <ModelSelector compact permKey={headerPermKey} tourAnchor />
          <EffortSelector permKey={headerPermKey} tourAnchor />
          <span data-tour="remote-control" className="inline-flex">
            <RemoteControlButton session={headerPane} />
          </span>
          <ThemeToggle />
          {/* 面板坞:分屏 + 10 个面板 + 更新提醒收纳于此(点击展开 rail)。 */}
          <PanelDock rightPanel={rightPanel} setRightPanel={setRightPanel} updateNotice={updateNotice} jumpToUpdate={jumpToUpdate} />
          <button data-tour="help" onClick={() => setTourOpen(true)} title="使用指引 — 逐个介绍界面功能"
            className="flex items-center justify-center p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 transition-colors">
            <HelpCircle size={15} />
          </button>
        </div>
      </header>

      {/* Main content */}
      <MainLayout
        sidebarCollapsed={sidebarCollapsed}
        selectedProject={selectedProject}
        rightPanel={rightPanel}
        setRightPanel={setRightPanel}
        isMobile={isMobile}
      />
      {LocalWidgets()}
      <GuideTour open={tourOpen} onClose={closeTour} hasProject={!!selectedProject} />
      <ShortcutsPanel open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {/* 修正批#7:Provider 管理独立弹窗(桌面;手机走合并入口页内的导航流全屏页) */}
      <ProviderManagerModal open={providerMgrOpen} editId={providerMgrEditId} onClose={() => { setProviderMgrOpen(false); setProviderMgrEditId(null); }} />
      {bundleMismatchBanner}
      <CompletionToasts />
      {/* F1: 截图热键状态提示(截图中/成功/失败)。取消不显示。 */}
      {shotStatus && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[210] max-w-[80vw]">
          <div
            className={`flex items-center gap-2 px-4 py-2 rounded-full shadow-lg text-sm font-body ${
              shotStatus.kind === 'error'
                ? 'bg-error text-white'
                : shotStatus.kind === 'done'
                ? 'bg-ink text-canvas'
                : 'bg-ink/90 text-canvas'
            }`}
            role="status"
          >
            {shotStatus.kind === 'busy' && (
              <span className="w-3.5 h-3.5 rounded-full border-2 border-canvas/40 border-t-canvas animate-spin shrink-0" />
            )}
            <span className="leading-snug">{shotStatus.text}</span>
            {shotStatus.kind === 'error' && (
              <X size={14} className="shrink-0 cursor-pointer hover:opacity-80" onClick={() => setShotStatus(null)} />
            )}
          </div>
        </div>
      )}
      {!cliInstalled && !cliCheckDismissed && (
        <EnvCheckPanel onRecheck={checkCli} onDismiss={dismissCliCheck} />
      )}
      {needsFDA && !fdaDismissed && (
        <FullDiskAccessModal onOpenSettings={openFDASettings} onDismiss={dismissFDA} />
      )}
      {updateNotice && !updateModalDismissed && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in" onClick={() => setUpdateModalDismissed(true)}>
          <div className="glass-popover w-[420px] max-w-[calc(var(--app-w,100vw)-1.5rem)] rounded-2xl shadow-2xl animate-glass-rise overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0 text-[18px]">🎉</div>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-ink font-body">发现新版本</div>
                <div className="text-[12px] text-ink-soft font-body mt-1 space-y-0.5">
                  {updateNotice.gui && <div>Claude GUI → <b className="font-mono text-accent">v{updateNotice.gui}</b></div>}
                  {updateNotice.cc && <div>Claude Code → <b className="font-mono text-accent">v{updateNotice.cc}</b></div>}
                </div>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-canvas-deep flex items-center justify-end gap-2 bg-canvas-warm/40">
              <button onClick={() => setUpdateModalDismissed(true)}
                className="px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink rounded-md hover:bg-canvas-warm transition-colors">稍后</button>
              <button onClick={() => jumpToUpdate(updateNotice.gui ? 'gui-update' : 'cc-update')}
                className="px-3 py-1.5 text-[12px] text-on-accent bg-accent hover:bg-accent/90 rounded-md transition-colors">前往更新</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
