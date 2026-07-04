import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';

// Stable empty array reference for zustand selectors — prevents React error
// #185 (Maximum update depth exceeded) caused by returning fresh `[]` on
// every selector call. Any selector with `|| []` fallback must point here.
const EMPTY_ARRAY = Object.freeze([]);
// 已尝试过自动生成标题的 sessionId(无论成功失败),防止失败时每轮重复 spawn 标题进程。
const titleAttempted = new Set();
// CQ-15:被用户停止的 chat 进程 pid,跨所有 SessionDetail 实例(分屏多 pane)共享。
// 原来是每个 pane 私有的 useRef(new Set()),pane A 停的 pid,pane B 的 backgroundPid 轮询
// 感知不到 → 可能把 B 自己仍在跑的进程当成「需要 reattach」,reattach 的 finally 又清空 B
// 的流式状态,外观上像「停一个把两个都停了」。改成模块级共享集合即可让停止全局可见。
const stoppedChatPids = new Set();
import { useStore, THEME_FAMILIES, FONT_OPTIONS, systemPrefersDark, PERMISSION_MODES } from './stores/sessionStore.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { MessageBubble } from './components/MessageBubble.jsx';
import { MarkdownRenderer } from './components/MarkdownRenderer.jsx';
import { TurnBubble } from './components/TurnBubble.jsx';
import TurnScrubber from './components/TurnScrubber.jsx';
import { pickDirectory, isTauri } from './utils/pickDirectory.js';
import ChatSearch from './components/ChatSearch.jsx';
import { confirmDialog } from './utils/confirmDialog.jsx';
import { ChatInput, EffortSelector, PermissionModeSelector, AgentModeSelector, EFFORT_LEVELS, MODE_META } from './components/ChatInput.jsx';
import { ModelBadge, ProviderAvatar } from './components/ModelBadge.jsx';
import { UsagePanel } from './components/UsagePanel.jsx';
import { ProcessPanel } from './components/ProcessPanel.jsx';
import { SettingsPanel } from './components/SettingsPanel.jsx';
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
import EnvCheckPanel from './components/EnvCheckPanel.jsx';
import { ArtifactDock } from './components/ArtifactPreview.jsx';
import { FullDiskAccessModal } from './components/FullDiskAccessModal.jsx';
import { BUILTIN_PROVIDERS, findBuiltin } from './utils/builtinProviders.js';
import { computeCost, formatCost } from './utils/pricing.js';
import { extractToolResultText } from './utils/toolResult.js';
import { rebuildTodosFromTaskCalls } from './utils/todos.js';
import {
  FolderOpen, MessageSquare, ChevronLeft, ChevronRight, ChevronDown,
  Search, Hash, Layers, BarChart3, ArrowLeft, Plus,
  RefreshCw, Activity, Settings, Server, GitBranch, FileDiff, Check, Wrench, X,
  Sun, Moon, Monitor, Bot, Camera, History, Loader2, Shield, FolderTree,
  Archive, ArchiveRestore, Trash2, EyeOff, Columns2, Smartphone, Pencil, Type, Palette,
  Menu, SquarePen, Gauge, Cpu, CheckCircle2, BookText, Sparkles, HelpCircle, Pin,
  Download, ClipboardCopy,
} from 'lucide-react';
import { copyText } from './utils/clipboard.js';

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
          else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
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

function CheckpointButton({ sessionId, cwd, projectHash, onRestored }) {
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
      if (!r.ok) { confirmDialog('恢复失败：' + (d.error || r.status)); return; }
      // #1:checkpoint 只是 git 文件快照,不含对话锚点。用快照时间戳把会话裁剪到该时刻,
      // 消息页随之回退(否则用户点了恢复但消息页一动不动,以为"无反应")。best-effort。
      if (projectHash && ts) {
        try {
          await fetch(`/api/sessions/${sessionId}/trim`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectHash, fromTimestamp: new Date(ts).toISOString() }),
          });
        } catch {}
      }
      setOpen(false);
      onRestored?.();
      confirmDialog(`已回到 checkpoint ${sha.slice(0, 7)}：文件已还原，会话已裁剪到该时刻`);
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

function ThemeToggle() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const themeFamily = useStore((s) => s.themeFamily);
  const themeTone = useStore((s) => s.themeTone);
  const setTheme = useStore((s) => s.setTheme);
  const uiFontScale = useStore((s) => s.uiFontScale);
  const setUiFontScale = useStore((s) => s.setUiFontScale);
  const readingFont = useStore((s) => s.readingFont);
  const setReadingFont = useStore((s) => s.setReadingFont);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const effDark = themeTone === 'auto' ? systemPrefersDark() : themeTone === 'dark';
  const toneKey = effDark ? 'dark' : 'light';
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
      {open && (
        <div className="absolute right-0 top-full mt-2 z-[60] w-[300px] glass-popover rounded-2xl border border-canvas-deep shadow-xl p-3 space-y-3 max-h-[min(78dvh,calc(100dvh-6rem))] overflow-y-auto max-md:fixed max-md:left-3 max-md:right-3 max-md:top-16 max-md:w-auto max-md:mt-0 max-md:max-h-[78dvh]">
          {/* ── Tone (light / dark / follow-system) ───────────── */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-black/5">
            {TONES.map(({ id, label, Icon }) => (
              <button key={id} onClick={() => setTheme(themeFamily, id)}
                className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11px] font-body transition-colors ${
                  themeTone === id ? 'bg-accent text-white shadow-sm' : 'text-ink-muted hover:text-ink'}`}>
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
                      ? 'bg-accent text-white shadow-sm'
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
            <select value={readingFont} onChange={(e) => setReadingFont(e.target.value)}
              className="w-full text-[11px] font-body rounded-lg border border-canvas-deep bg-canvas px-2.5 py-1.5 text-ink focus:outline-none focus:border-accent cursor-pointer">
              {FONT_OPTIONS.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
            <div className="text-[14px] text-ink-muted leading-snug px-0.5 font-reading">
              示例 The quick brown fox · 敏捷的棕色狐狸
            </div>
          </div>

          {/* ── Color family ──────────────────────────────────── */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Palette size={12} className="text-ink-muted" />
              <span className="text-[11px] text-ink font-body font-medium">配色外观</span>
              <span className="ml-auto text-[9px] text-ink-faint font-body">当前 {toneKey === 'dark' ? '深色' : '浅色'}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 max-h-[300px] overflow-y-auto pr-0.5">
              {THEME_FAMILIES.map((fam) => {
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

          {/* ── Loading 动画样式(仅弹窗打开时渲染,30 个动画不常驻) ── */}
          <LoadingStylePicker />
        </div>
      )}
    </div>
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
// 优先级:① [1m] 后缀(用户显式开启 1M)→ 1M;② id 里自带窗口标注
// (moonshot-v1-128k 等)→ 取该数;③ 原生 1M+ 的 provider 模型(Gemini /
// GPT-5.x / DeepSeek-V4 / MiMo / MiniMax / Grok-4)→ 1M;④ Kimi 原生 256K;
// ⑤ 其余(GLM=200K、Anthropic 未开 [1m]=200K 等)→ 200K 兜底。
// 依据:用户核对官方文档 — GLM-5.1=200K、Kimi K2.6=256K,均非 1M。
function nativeContextWindow(model) {
  const id = (model || '').toLowerCase();
  if (/\[1m\]/i.test(id)) return 1_000_000;
  const byName = id.match(/(\d+)k(?![a-z0-9])/);     // 如 moonshot-v1-128k
  if (byName) return parseInt(byName[1], 10) * 1000;
  // GPT-5.x:mini / nano 是 400K,5.4/5.5/pro 是 ~1.05M(查 OpenAI 官方文档 2026-06)。
  if (/gpt-5.*(mini|nano)/.test(id)) return 400_000;
  // U3:deepseek/mimo 从 1M 名单移除 —— CLI /context 实测均为 200k 档(用户 Windows
  // 上 deepseek 徽章 1M、点开实测 200k 的矛盾根因)。1M 须显式 [1m] 后缀或实测覆盖。
  if (/gemini|gpt-5|minimax|grok-4/.test(id)) return 1_000_000;
  if (/kimi/.test(id)) return 262_144;               // Kimi K2.6 原生 256K
  return 200_000;
}

// ─── Right Panel (overlay) ────────────────────────────────────
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
  settings: { label: '设置', icon: Settings, component: SettingsPanel },
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
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
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
                  paneCount === n ? 'bg-accent text-white' : 'hover:bg-canvas-warm text-ink'
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

function MainLayout({ sidebarCollapsed, selectedProject, rightPanel, setRightPanel, isMobile }) {
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
          <SessionDetail tabIndex={0} mobileChrome />
        </main>

        {/* Sidebar drawer — Claude-app style multi-level menu */}
        {!sidebarCollapsed && (
          <>
            <div className="fixed inset-0 z-40 bg-black/40 animate-fade-in" onClick={toggleSidebar} />
            <aside className="mobile-drawer fixed inset-y-0 left-0 z-50 w-[86vw] max-w-[360px] glass-thick flex flex-col overflow-hidden animate-glass-rise">
              <MobileMenu setRightPanel={setRightPanel} onClose={toggleSidebar} />
            </aside>
          </>
        )}

        {/* Right panel — full-screen overlay */}
        {rightPanel && (
          <div className="fixed inset-0 z-50 bg-canvas animate-glass-rise">
            <RightPanel panelId={rightPanel} onClose={() => setRightPanel(null)} width="100%" />
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
          <RightPanel panelId={rightPanel} onClose={() => setRightPanel(null)} width={rightPanelWidth} />
          <ArtifactDock />
        </>
      ) : artifactDock ? (
        <ArtifactDock />
      ) : rightPanel && (
        <>
          <Splitter onMouseDown={onRightDrag} axis="x" />
          <RightPanel panelId={rightPanel} onClose={() => setRightPanel(null)} width={rightPanelWidth} />
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
function SplitMain({ activeTabIndex, setActiveTabIndex }) {
  const paneCount = useStore((s) => s.paneCount);
  const paneSessions = useStore((s) => s.paneSessions);
  const paneIds = useStore((s) => s.paneIds);
  const closePane = useStore((s) => s.closePane);
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
                    onClick={(e) => { e.stopPropagation(); closePane(i); }}
                    className="w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-canvas-deep transition-colors"
                    title="关闭此分屏（不结束会话 / 不杀进程）"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
              {(soloPane || hasSession) ? (
                <SessionDetail tabIndex={i} />
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

  return (
    <div style={{ width }} className="glass-thick shrink-0 flex flex-col m-3 ml-0 rounded-2xl overflow-hidden animate-glass-rise">
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

  const filtered = projects.filter((p) =>
    !hidden.has(p.hash) && p.path.toLowerCase().includes(searchQuery.toLowerCase())
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
      setAddDialogOpen(false);
      setAddPathInput('');
    } catch (err) {
      setAddError(err.message || '添加失败');
    } finally {
      setAddingProject(false);
    }
  };

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
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-ink-faint font-body">
            项目
          </h2>
          <button
            onClick={async () => {
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
            }}
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
      <div data-tour="sidebar-list" className="flex-1 overflow-y-auto px-2 stagger">
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
            {hiddenOnly && (
              <button
                onClick={() => { const next = new Set(); setHidden(next); persistHidden(next); }}
                className="mt-3 px-3 py-1.5 rounded-full bg-accent text-white text-[12px] font-body"
              >
                显示全部项目
              </button>
            )}
          </div>
        )}
      </div>
      {addDialogOpen && (
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
                <button disabled={addingProject || !addPathInput.trim()} className="px-4 py-2 rounded-lg bg-accent text-white text-[13px] disabled:opacity-50">
                  {addingProject ? '添加中...' : '添加'}
                </button>
              </div>
            </form>
          </div>
        </div>
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
              else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
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
                {session.model && <ModelBadge model={session.model} compact />}
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

function SessionList() {
  const { sessions, selectedSession, setSelectedSession, fetchMessages, selectedProject } = useStore();
  const runningSessionIds = useStore((s) => s.runningSessionIds);
  // In split mode, sidebar clicks fill the focused pane (tab 0 or 1).
  // Outside split mode the call collapses to setSelectedSession + tab-0
  // fetch — i.e. identical to the legacy single-pane behavior.
  const splitMode = useStore((s) => s.splitMode);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const setActiveTabSession = useStore((s) => s.setActiveTabSession);
  const secondarySession = useStore((s) => s.secondarySession);
  const paneSessions = useStore((s) => s.paneSessions);
  // 焦点 pane 当前的 session,决定本列表里哪条强高亮。原来用 selectedSession +
  // secondarySession 两 pane 都高亮,N-pane 下其他 pane 完全没体现,且看不出焦点。
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

  const handleDelete = async (session) => {
    try {
      const r = await fetch(
        `/api/sessions/${session.sessionId}?projectHash=${encodeURIComponent(session.projectHash)}`,
        { method: 'DELETE' }
      );
      if (!r.ok) { const e = await r.json().catch(() => ({})); confirmDialog('删除失败：' + (e.error || r.status)); return; }
      if (selectedSession?.sessionId === session.sessionId) setSelectedSession(null);
      useStore.getState().fetchSessions(selectedProject.hash, { silent: true });
    } catch (err) {
      confirmDialog('删除失败：' + err.message);
    }
  };

  // Auto-refresh the session list when any .jsonl in ~/.claude/projects/
  // changes (file watcher dispatches via useWebSocket). Debounced so a busy
  // stream doesn't spam fetches. This fixes the "new session A → new session B
  // → A missing from history" race: the moment claude appends to A's jsonl,
  // sidebar refetches and A shows up.
  useEffect(() => {
    if (!selectedProject?.hash) return;
    let timer = null;
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        useStore.getState().fetchSessions(selectedProject.hash, { silent: true });
      }, 600);
    };
    window.addEventListener('cgui:sessions-changed', onChange);
    return () => {
      window.removeEventListener('cgui:sessions-changed', onChange);
      if (timer) clearTimeout(timer);
    };
  }, [selectedProject?.hash]);

  // 新建会话时继承「上一个活跃会话」的 model / 思考强度 / agent 模式(免得每次重选),
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
      st.setActiveAgentFor(draftKey, st.getActiveAgentFor(prevKey));
    }
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

  const openWorktreePicker = async () => {
    if (!selectedProject) return;
    setWorktreeOpen(true);
    setWorktreeList(null);
    try {
      const r = await fetch(`/api/worktree?cwd=${encodeURIComponent(selectedProject.path)}`);
      const d = await r.json();
      if (r.ok) setWorktreeList(d.trees || []);
      else setWorktreeList([]);
    } catch {
      setWorktreeList([]);
    }
  };

  const enterWorktree = (tree) => {
    if (!tree?.path || !selectedProject) return;
    seedNewSessionDefaults(selectedProject.hash);
    const draft = {
      draft: true,
      sessionId: null,
      projectHash: selectedProject.hash,
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
        body: JSON.stringify({ cwd: selectedProject.path, name }),
      });
      const d = await r.json();
      if (!r.ok) return confirmDialog('创建 worktree 失败：' + d.error);
      enterWorktree({ path: d.path, branch: d.branch });
      setNewWorktreeName('');
    } catch (err) {
      confirmDialog('创建 worktree 失败：' + err.message);
    }
  };

  const deleteWorktree = async (tree, e) => {
    e?.stopPropagation();
    if (!tree?.path || !selectedProject || tree.isMain) return;
    const dirty = tree.dirtyFileCount > 0;
    const msg = dirty
      ? `删除这个 worktree 会丢失 ${tree.dirtyFileCount} 个未提交修改：\n${tree.path}\n\n分支 ${tree.branch || ''} 本身保留。确定强制删除？`
      : `删除 worktree：\n${tree.path}\n\n只删这个工作树文件夹，分支 ${tree.branch || ''} 保留。确定？`;
    if (!(await confirmDialog(msg, { danger: true }))) return;
    try {
      const r = await fetch('/api/worktree', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: selectedProject.path, path: tree.path, force: dirty }),
      });
      const d = await r.json();
      if (!r.ok) return confirmDialog('删除失败：' + (d.error || ''));
      openWorktreePicker(); // 刷新列表
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
      // Name the fork after its source: "<source title>分支N". Strip an existing
      // 分支N suffix so branching a branch stays in the same family (会话A分支1 →
      // 会话A分支2, not 会话A分支1分支1). N = max existing +1 across custom titles.
      const baseTitle = (st.customTitles[session.sessionId] || session.firstPrompt || '会话')
        .slice(0, 60).trim().replace(/分支\d+$/, '').trim();
      const reBranch = new RegExp('^' + baseTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '分支(\\d+)$');
      let maxN = 0;
      for (const t of Object.values(st.customTitles)) {
        const m = reBranch.exec(t);
        if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
      }
      st.setCustomTitle(data.newSessionId, `${baseTitle}分支${maxN + 1}`);
      // AZ7:分支继承源会话的 per-session 配置(否则全回退默认)。用解析后的有效值,
      // 即使源会话靠历史/全局兜底也能定住。model 的 [1m] 后缀编码了 1m 开关,拷 model
      // 即拷 1m。keyed setter 只写各自 map、不动全局(已修过分屏污染),拷贝安全。
      const srcKey = session.sessionId;
      const dstKey = data.newSessionId;
      // 模型优先级:源会话显式 pin > 侧栏元数据 model(=源历史最近在用的)> 全局兜底。
      // 之前只用 getModelFor(=pin||全局),源会话没手动 pin 时会拿全局而非它实际在用的模型。
      st.setModelFor(dstKey, st.modelBySession[srcKey] || session.model || st.getModelFor(srcKey));
      st.setEffortFor(dstKey, st.getEffortFor(srcKey));
      st.setPermissionMode(st.getPermissionModeFor(srcKey), dstKey);
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

  return (
    <div className="flex flex-col h-full">
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
      <div data-tour="sidebar-list" className="flex-1 overflow-y-auto px-2 stagger">
        {visible.map((session) => (
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
        {visible.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-ink-faint font-body">
              {q ? '没有匹配的会话' : showArchived ? '没有已归档的会话' : '该项目没有活跃会话'}
            </p>
          </div>
        )}
      </div>

      {/* Worktree picker modal */}
      {worktreeOpen && createPortal((
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in"
          onClick={() => setWorktreeOpen(false)}
        >
          <div
            className="glass-popover w-[480px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[80vh] flex flex-col py-1 animate-glass-rise"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 text-[11px] text-ink-faint uppercase tracking-wider font-body flex items-center justify-between border-b border-canvas-deep shrink-0">
              <span>选择 / 新建 Git Worktree</span>
              <button onClick={() => setWorktreeOpen(false)} className="p-1 hover:bg-canvas-warm rounded">
                <X size={12} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {worktreeList === null ? (
                <div className="text-[11px] text-ink-faint py-6 text-center font-body">加载中…</div>
              ) : worktreeList.length === 0 ? (
                <div className="text-[11px] text-ink-faint py-6 text-center font-body">没有现有 worktree</div>
              ) : (
                worktreeList.map((t) => (
                  <div key={t.path} className="flex items-stretch gap-1 mb-1">
                    <button
                      onClick={() => enterWorktree(t)}
                      className="flex-1 min-w-0 text-left px-3 py-2 rounded-lg hover:bg-canvas-warm border border-canvas-deep transition-colors group"
                    >
                      <div className="flex items-center gap-2 mb-0.5 min-w-0">
                        <GitBranch size={12} className="text-accent shrink-0" />
                        <span className="text-xs font-medium font-mono text-ink truncate min-w-0">
                          {t.branch || '(detached)'}
                        </span>
                        {t.isMain && (
                          <span className="text-[9px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono">主</span>
                        )}
                        {t.dirtyFileCount > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded font-mono">
                            {t.dirtyFileCount} 未提交
                          </span>
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
                    </button>
                    {!t.isMain && (
                      <button
                        onClick={(e) => deleteWorktree(t, e)}
                        title="删除此 worktree（分支保留）"
                        className="shrink-0 px-2 rounded-lg border border-canvas-deep text-ink-faint hover:text-error hover:border-error/40 hover:bg-error-subtle transition-colors flex items-center"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                ))
              )}
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
                  className="flex-1 bg-canvas border border-canvas-deep rounded px-2 py-1 text-[11px] font-mono text-ink focus:outline-none focus:border-accent/40"
                />
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
function EmptyState() {
  return (
    <div className="mobile-empty-state flex-1 flex items-center justify-center glass-base m-3 rounded-2xl relative animate-glass-rise">
      <div className="text-center relative z-10">
        <div className="w-20 h-20 rounded-3xl glass-thin flex items-center justify-center mx-auto mb-6">
          <Layers size={32} className="text-accent" />
        </div>
        <h3 className="text-[22px] font-display font-semibold text-ink mb-1.5 tracking-tight">选择一个会话</h3>
        <p className="text-[13px] text-ink-muted font-body">从左侧项目列表开始浏览历史记录</p>
      </div>
    </div>
  );
}

// ─── CLI-style spinner ─────────────────────────────────────────
// Mimics claude-code terminal: a 6-point asterisk that cycles through Unicode
// frames every ~100ms, paired with a verb that changes every ~3s.
const SPINNER_FRAMES = ['✻', '✶', '✷', '✸', '✹', '✺'];
const THINKING_VERBS = [
  'Frolicking', 'Pondering', 'Brewing', 'Cogitating', 'Mulling',
  'Conjuring', 'Crafting', 'Weaving', 'Synthesizing', 'Noodling',
  'Spelunking', 'Marinating', 'Percolating', 'Ruminating',
];
// Bigger, brand-colored spinner — Claude terracotta #D97757, ~20px default
// (was 14px and accent-blue). Matches Claude's official brand color so the
// "thinking..." indicator feels like Claude's own UI.
function CliSpinner({ size = 20 }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className="font-mono inline-block leading-none"
      style={{ fontSize: size, color: '#D97757' }}
    >
      {SPINNER_FRAMES[frame]}
    </span>
  );
}

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
function LoadingMark({ size = 20, variant = null }) {
  const chosen = useStore((s) => s.loadingStyle) || 'cli';
  const style = variant || chosen;
  if (style === 'cli') return <CliSpinner size={size} />;
  return (
    <span
      className={`loading-mark loading-${style}`}
      style={{ width: size, height: size }}
    ><span /></span>
  );
}
// ③ 对话区自定义背景层(设置→概览→对话区背景)。绝对定位铺满 pane,-z-10 置于
// 内容之下(SessionDetail 根节点在启用背景时加 isolate 建立独立层叠上下文)。
// 遮罩 = 主题底色(--color-canvas)按 maskOpacity 比例盖在背景上,深浅主题下都保证文字可读。
// 未设置背景时返回 null,渲染结果与改动前完全一致。
function ChatBackgroundLayer() {
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

function useCyclingVerb() {
  const [i, setI] = useState(() => Math.floor(Math.random() * THINKING_VERBS.length));
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % THINKING_VERBS.length), 3000);
    return () => clearInterval(id);
  }, []);
  return THINKING_VERBS[i];
}

// ─── Streaming status line ─────────────────────────────────────
// Inline status that mirrors the CLI's "✻ Frolicking…" prompt — spinner
// char + verb + optional tool/phase detail. Updates live as the model
// moves through phases inside one turn.
// CJ-4:流式/思考/connecting 时的实时耗时计数,每秒跳一次。startedAt=本回合发起时间戳。
function ElapsedTime({ startedAt, className = '' }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const txt = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  return <span className={`font-mono text-[12px] text-ink-faint tabular-nums shrink-0 ${className}`}>{txt}</span>;
}

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
    return null;
  }
  // 统一动效(用户反馈"跳动动画→静态头像"割裂):动画载体收敛到回复气泡的
  // ✻ 头像位(TurnBubble 的 ProviderAvatar thinking 态),状态行只保留纯文字,
  // 缩进 50px(34px 头像 + 16px gap)与气泡正文列对齐,渲染在气泡下方。
  return (
    <div className="px-6 -mt-2 pb-3 animate-fade-in">
      <div className="max-w-[var(--content-max)] mx-auto flex items-center gap-2 pl-[50px] text-[13px] text-ink-soft font-body">
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
        纯问答(不调工具)不会弹窗;想直接干活可切"默认"或"接受编辑"。
      </span>
      <button
        onClick={() => setPermissionMode('default', permKey)}
        className="px-2 py-0.5 rounded bg-amber-100 hover:bg-amber-200 text-amber-900 text-[10px] font-medium shrink-0"
        title="每次工具调用都弹窗征求你同意"
      >切默认</button>
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
          未检测到 <b>git</b>。装上 git 才能初始化仓库 / 回滚 AI 的修改。可在 设置 → 环境 里安装，或到 <b>git-scm.com</b> 下载。
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
// 旁问气泡(/btw):独立于主对话流的问答卡片。仅存在于本地 chatMessages
// (不写会话 jsonl),刷新/切会话即消失 —— 与 CLI /btw"不进历史"的语义一致。
function BtwBubble({ msg, onHide }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="px-6 py-3 animate-fade-up" style={{ animationDuration: '0.25s' }}>
      <div className="max-w-[var(--content-max)] mx-auto">
        <div className="border border-dashed border-canvas-deep rounded-2xl px-4 py-3 bg-canvas-warm/50">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] font-body uppercase tracking-wider text-ink-faint border border-canvas-deep rounded px-1.5 py-0.5 shrink-0">旁问</span>
            <span className="text-[12px] text-ink-muted font-body truncate flex-1">{msg.question}</span>
            {/* 折叠:只留问题行收起答案;隐藏:从本地视图移除(旁问本就不入历史) */}
            <button onClick={() => setCollapsed((c) => !c)} title={collapsed ? '展开答案' : '折叠'}
              className="shrink-0 text-ink-faint hover:text-ink">
              <ChevronDown size={13} className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
            </button>
            <button onClick={() => onHide?.(msg.uuid)} title="隐藏这条旁问"
              className="shrink-0 text-ink-faint hover:text-ink">
              <EyeOff size={12} />
            </button>
          </div>
          {!collapsed && (<>
            {msg.pending
              ? <div className="text-[13px] text-ink-faint font-body animate-pulse">思考中…</div>
              : msg.error
              ? <div className="text-[13px] text-red-600/90 font-body">{msg.text}</div>
              : <MarkdownRenderer content={msg.text} />}
            {!msg.pending && !msg.error && (
              <div className="mt-1.5 text-[10px] text-ink-faint font-body">旁问不写入会话历史，刷新后消失</div>
            )}
          </>)}
        </div>
      </div>
    </div>
  );
}

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

// 上下文达到此占比(%)时，GUI 侧主动提示并倒计时自动 /compact。
// 第一方(anthropic)由 CLI 原生 auto-compact 负责(约 92%)；第三方 provider 不支持
// count_tokens、上下文窗口被 CLI 当兜底源 → 原生 auto-compact 不可靠/不触发，由本组件兜底。
const AUTO_COMPACT_THRESHOLD = 80;

// GUI 侧自动压缩看门狗(仅第三方 provider 启用)。idle 且占比越过阈值时弹出倒计时，
// 倒计时结束自动发 /compact；"取消"则本"轮次"内不再提示(占比降回阈值下才重新武装)。
// 作为 SessionDetail 的子组件接收 contextPct —— 占比在父组件渲染末尾才算出、其后已无
// hook 位，放子组件可避免 hook 顺序问题。按 sessionId key，切会话自动重置内部状态。
function AutoCompactBanner({ contextPct, idle, enabled, onCompact, COUNTDOWN = 10 }) {
  const [armed, setArmed] = useState(false);
  const [secs, setSecs] = useState(COUNTDOWN);
  const dismissedRef = useRef(false);
  const onCompactRef = useRef(onCompact);
  onCompactRef.current = onCompact;        // 固定引用，倒计时 effect 不随父组件重渲染重置

  useEffect(() => {
    if (!enabled || contextPct < AUTO_COMPACT_THRESHOLD) {
      dismissedRef.current = false;        // 降回阈值下 → 重新武装下次
      if (armed) setArmed(false);
      return;
    }
    if (!idle || dismissedRef.current || armed) return;
    setSecs(COUNTDOWN);
    setArmed(true);
  }, [enabled, contextPct, idle, armed, COUNTDOWN]);

  useEffect(() => {
    if (!armed || !idle) return;           // 用户手动发消息(非 idle)时暂停倒计时
    if (secs <= 0) {
      setArmed(false);
      dismissedRef.current = true;         // 防止压缩流跑起来前重复触发
      onCompactRef.current();
      return;
    }
    const t = setTimeout(() => setSecs((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [armed, idle, secs]);

  if (!armed) return null;
  return (
    <div className="shrink-0 mx-6 mt-2 px-3 py-2.5 rounded-md bg-amber-50 border border-amber-200 animate-fade-up">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-amber-800 text-[12px] font-body leading-snug">
          上下文已达 <b>{contextPct}%</b>，当前 provider 不会自动压缩 —— 将在 <b>{secs}s</b> 后自动 /compact。
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
    // Tauri WKWebView 拦 blob 下载(点了没反应)→ 走后端落盘到 Downloads;浏览器用 blob。
    if (isTauri()) {
      try {
        const r = await fetch('/api/export-session', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ md, fileName }),
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
  // ③ 是否启用了对话区自定义背景(布尔原始值选择器,引用稳定)。启用时根节点加 isolate。
  const hasChatBg = useStore((s) => !!(s.chatBackground && s.chatBackground.kind));
  // Pane routing generalized to N panes (0..5). Each SessionDetail reads/writes
  // its own slot in paneSessions/paneMessages. setPaneSession/setPaneMessages
  // keep the legacy selectedSession/messages (pane 0) + secondary* (pane 1)
  // mirrors in sync, so the rest of this component is unchanged.
  const paneSessions = useStore((s) => s.paneSessions);
  const paneMessages = useStore((s) => s.paneMessages);
  const selectedSession = (paneSessions && paneSessions[tabIndex]) || null;
  // 空窗格时 paneMessages[tabIndex] 为 undefined,`|| []` 每次渲染造新数组 → 进下方多个
  // useMemo/useEffect deps 致每帧重跑。复用模块级冻结空数组保持引用稳定。
  const messages = (paneMessages && paneMessages[tabIndex]) || EMPTY_ARRAY;
  // 本会话的队列/pin/owner key(草稿用 draft-<hash>)。必须在所有引用它的 effect 之前声明,
  // 否则 effect 依赖数组在渲染期先求值会命中 TDZ(Cannot access before initialization)。
  const sessionQueueKey = selectedSession?.sessionId || `draft-${selectedSession?.projectHash || 'none'}`;
  // C2:用于把 AutoCompactBanner 限定在「当前聚焦的 pane」——分屏下非聚焦 pane 不应
  // 在你没看着时静默 /compact 改写历史。单窗格时 activeTabIndex 恒为 0 = 本 pane。
  const paneIsActive = useStore((s) => s.activeTabIndex) === tabIndex;
  // 窗内检索(Cmd/Ctrl+F)开关 —— 仅当前聚焦 pane 响应。
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    if (!paneIsActive) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneIsActive]);
  const setSelectedSession = useCallback((s) => {
    useStore.getState().setPaneSession(tabIndex, s);
  }, [tabIndex]);
  const setLocalMessages = useCallback((msgs) => {
    useStore.getState().setPaneMessages(tabIndex, Array.isArray(msgs) ? msgs : []);
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
  const currentModel = pinnedModel || historyModel || globalModel;
  const modelBySession = useStore((s) => s.modelBySession);
  const messagesEndRef = useRef(null);
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
  //   { afterLastUser }  reattach:真实起点未知,但进程还活着 ⇒ jsonl 末条用户消息就是本回合
  //                      的 prompt(本地无副本,保留它),丢弃其后的条目。
  // finalize 提交整轮落盘 + 清空本地副本时同步清空,历史交还 jsonl。
  const [streamHistCutoff, setStreamHistCutoff] = useState(null);
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
  const abortRef = useRef(null);
  // pid 集合:被用户主动「停止」过的 chat 进程。停止后进程要等 close 才设 exitCode
  // (SIGTERM→SIGKILL 最多 5s),这期间 /agents/active 仍报 stoppable=true → backgroundPid
  // poll 会把它误判成「后台运行中」并闪黄条,甚至触发 auto-reattach 重连。记下已停的
  // pid,poll 与 reattach 都跳过它。CQ-15:指向模块级共享集合,使分屏各 pane 互相感知停止。
  const stoppedPidsRef = useRef(stoppedChatPids);
  // Set by "⚡ 引导": tells the aborted in-flight send's finally to skip its own
  // queue drain so we don't double-send — handleAccelerate drains directly, which
  // also covers reattach streams (whose finally never drains).
  const acceleratingRef = useRef(false);

  // Latest TodoWrite snapshot for the composer's checklist panel. TodoWrite
  // calls REPLACE the full list each time, so the newest call wins. Search
  // freshest-first: streaming blocks → chatMessages → persisted messages.
  // DECLARED HERE (above any conditional early return) so hook order stays
  // stable when selectedSession flips from null → set → null (React #310).
  const currentTodos = useMemo(() => {
    // BK-8a:输入框上方清单与气泡内清单(TurnBubble)共用同一份重建算法
    // (../utils/todos.js),消除两处口径差异。这里负责把全局所有 turn 的 toolCalls
    // 按"老→新"摊平成单数组(messages → chatMessages → streamingBlocks),交给共享
    // 函数;TurnBubble 传单 turn 的 toolCalls。算法内部:最新 TodoWrite 快照优先
    // (摊平末尾的 streaming 最新),否则回放 TaskCreate/TaskUpdate 序列。
    const flat = [];
    for (const m of messages) { if (m?.type === 'turn' && Array.isArray(m.toolCalls)) flat.push(...m.toolCalls); }
    for (const m of chatMessages) { if (m?.type === 'turn' && Array.isArray(m.toolCalls)) flat.push(...m.toolCalls); }
    for (const b of streamingBlocks) {
      if (b?.type === 'tool_use' && b.toolCall) flat.push(b.toolCall);
    }
    return rebuildTodosFromTaskCalls(flat);
  }, [streamingBlocks, chatMessages, messages]);

  // G1/G2:输入框上方只显 TodoWrite 的待办清单(cc 原生),不再贴整份 ExitPlanMode 计划。
  // 计划全文只在规划模式的审批弹窗(PlanReviewCard)出现——和 claude code 原生一致。
  // (原 currentPlan 已移除:plan 展示位置统一收口到弹窗)

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
        if (lastUser && known.has(tkey(lastUser))) return [];
        return prev.filter((m) => !known.has(tkey(m)));
      });
    };
    window.addEventListener('cgui:sessions-changed', onChange);
    return () => window.removeEventListener('cgui:sessions-changed', onChange);
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
      if (lastUser && known.has(tkey(lastUser))) return [];
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
    if (!selectedSession?.sessionId) { setBackgroundPid(null); return; }
    let cancelled = false;
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
            && a.sessionId === selectedSession.sessionId
            && a.stoppable === true
            && !stoppedPidsRef.current.has(String(a.pid))
        );
        // Only show "background working" if we're NOT actively streaming
        // locally — otherwise the local stream UI is already showing it.
        setBackgroundPid(hit && !streamingRef.current ? String(hit.pid) : null);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedSession?.sessionId]);

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
          confirmDialog('远程控制已激活（后台运行，无终端窗口）。\n手机用 Claude App 接管此会话；电脑端 GUI 会自动同步消息。\n输入框已锁定，避免双写——点顶部「已激活」可收回控制。\n（需 Claude 账号登录，且当前未切到 deepseek/mimo 等三方模型）');
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
        const sel = getLocalSession();
        const btwSid = sel?.sessionId || null;
        const btwCwd = sel?.projectPath || selectedProject?.path;
        const st = useStore.getState();
        const btwModel = String((btwSid && st.modelBySession[btwSid]) || st.currentModel || '').replace(/\[1m\]/i, '');
        const btwUuid = 'btw-' + Date.now();
        // liveVisible 门控:chatMessages 只在 streamOwnerKey===sessionQueueKey 时渲染。
        // 空闲态(刚进会话没发过消息)owner 为 null → 旁问气泡会被藏掉,需认领 owner。
        // 流式进行中不动 owner(已有归属,乱改会影响 finalize/reattach 读 ownerRef 的逻辑)。
        if (!streamingRef.current) setStreamOwner(sessionQueueKey);
        // 记录旁问归属的回合(发起时最后一个已渲染的用户回合)→ 右侧 TurnScrubber
        // 在该回合点标记"含旁问",悬浮可见。空会话无回合则 null(不关联任何点)。
        const atTurnUuid = [...messages].reverse().find((m) => m.type === 'user' && m.uuid)?.uuid || null;
        setChatMessages((prev) => [...prev, {
          uuid: btwUuid, type: 'btw', question: q, text: '', pending: true, atTurnUuid,
          timestamp: new Date().toISOString(),
        }]);
        fetch('/api/chat/btw', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, sessionId: btwSid || undefined, cwd: btwCwd, model: btwModel || undefined }),
        }).then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          setChatMessages((prev) => prev.map((m) => m.uuid === btwUuid
            ? { ...m, text: d.answer || '(无回答)', pending: false } : m));
        }).catch((e) => {
          setChatMessages((prev) => prev.map((m) => m.uuid === btwUuid
            ? { ...m, text: '旁问失败：' + e.message, pending: false, error: true } : m));
        });
        return;
      }
      // Defense-in-depth: ChatInput already locks the composer when the session
      // is under remote control, but handleSend can be reached by other paths.
      // A new `-p` turn here would double-write the RC pty's session jsonl.
      const lockedSid = getLocalSession()?.sessionId;
      if (lockedSid && useStore.getState().remoteControlled[lockedSid]) {
        confirmDialog('此会话已交给手机远程控制，输入框已锁定。点顶部「已激活」收回控制后再发送。');
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
    if (!reattachPid && streamingRef.current) {
      useStore.getState().enqueueMessage(sessionQueueKey, { text: prompt, queuedAt: Date.now(), hidden: !!hiddenUserMessage, opts });
      return;
    }

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
    // BF-1:记录历史截断点 —— 流式期间任何历史重拉都会拉到本回合半成品,渲染层据此丢弃。
    // reattach 时流起点早于现在(进程已跑了一阵),改用"末条用户消息之后"的形态截断。
    setStreamHistCutoff(reattachPid ? { afterLastUser: true } : { sinceTs: Date.now() });
    setCompacting(isCompact);
    setStreamingText('');
    setStreamingThinking('');
    setStreamingToolCalls([]);
    setStreamingBlocks([]);

    if (!reattachPid && !hiddenUserMessage) {
    // Push the user bubble IMMEDIATELY so multi-turn sends don't appear to
    // "swallow" the user's message while waiting on git checkpoint I/O. The
    // checkpoint runs in parallel and back-fills `checkpointSha` on the same
    // chatMessages entry when ready (rollback menu reads it from there).
    const userMsgUuid = 'chat-user-' + Date.now();
    const userMsgTimestamp = new Date().toISOString();
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
    let resultUsage = null;      // result 事件携带的本轮 usage(CLI 聚合口径)
    let resultCostUsd = null;    // result 事件携带的 total_cost_usd(CLI 权威成本)
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
      const permissionMode = useStore.getState().getPermissionModeFor(sessionQueueKey);
      // 模型解析与徽章一致(#8):pin → 历史模型 → 全局默认。否则发送时只读 pin||全局,
      // 全局被 WS 重置成默认后,没 pin 的会话(尤其回滚后)会用默认模型发出,与徽章不符。
      const _pin = useStore.getState().modelBySession[sessionQueueKey];
      // U1/U4:历史模型回退只信任【最近一次 provider 切换之后】产生的消息。
      // 否则切到新 provider 后,老会话的 _hist 仍是旧 provider 的模型 id
      // (如 mimo-v2.5-pro),发给 maoshu/官方 → "无可用渠道 / para error"。
      const _epoch = useStore.getState().providerEpoch || 0;
      const _hist = (() => {
        const ms = getLocalMessages() || [];
        for (let i = ms.length - 1; i >= 0; i--) {
          if (!ms[i]?.model) continue;
          // CLI 给 /compact 摘要、错误占位等写的是 `<synthetic>` 之类伪模型 id —— 真实
          // 模型 id 不以 `<` 开头。盲目回退会把 <synthetic> 当模型发出 → "模型不存在"
          // (实测:/compact 之后再发消息必现)。跳过这类伪 id 继续往前找。
          if (/^</.test(ms[i].model)) continue;
          if (_epoch && (!ms[i].timestamp || Date.parse(ms[i].timestamp) <= _epoch)) return null;
          return ms[i].model;
        }
        return null;
      })();
      // BK-0:切 provider 后,_pin/_hist 可能残留旧 provider 的模型 id(如老会话
      // 全程 mimo-v2.5-pro,切到官方后仍把 mimo 发出 → "模型不存在")。在用于请求
      // 体之前做一层"属于当前 provider 才用"的校验。
      //   白名单 = availableModels(.id,/api/model 返回) ∪ customModels(用户手填)。
      //   custom 纳入白名单避免误杀用户为当前 provider 手填的自定义 id。
      //   比对时去掉 [1m] 后缀按裸 id 匹配(别破坏 1M 逻辑)。
      //   列表为空/未加载时不校验(拿不到就维持原 _pin||_hist||全局,绝不误杀)。
      const _bare = (m) => String(m || '').replace(/\[1m\]/i, '');
      const _validModel = (() => {
        const st = useStore.getState();
        const avail = Array.isArray(st.availableModels) ? st.availableModels : [];
        const custom = Array.isArray(st.customModels) ? st.customModels : [];
        if (avail.length === 0 && custom.length === 0) {
          // 拿不到任何列表 → 维持原行为,不误杀。
          return _pin || _hist || st.currentModel;
        }
        const ok = new Set([
          ...avail.map((m) => _bare(m?.id)),
          ...custom.map((m) => _bare(m)),
        ].filter(Boolean));
        // 官方 Anthropic 端点的 availableModels 只是 settings env + 别名的枚举,并非
        // 完整模型目录(claude-sonnet-4-6 等完全合法的 id 不在其中)。BK-0 的本意是拦
        // "跨 provider 残留 id",不能把官方合法 id 也误杀——否则用户 pin 了 claude-sonnet-4-6、
        // 徽章显示 sonnet,发送时却被静默回退到全局默认(如 haiku),徽章与实际调用不一致
        // (用户实证:选 sonnet-4-6 实际全程 haiku)。官方下任何 claude-* id 一律放行,
        // 交给 API 校验;第三方/中转(providerHint≠anthropic)仍走白名单不变。
        const _officialAnthropic = (st.currentProvider?.providerHint || 'anthropic') === 'anthropic';
        const _isClaudeId = (m) => /^claude-[a-z0-9.-]+(\[1m\])?$/i.test(String(m || ''));
        const inProvider = (m) => m && (ok.has(_bare(m)) || (_officialAnthropic && _isClaudeId(m)));
        if (inProvider(_pin)) return _pin;
        if (inProvider(_hist)) return _hist;
        const global = st.currentModel;
        if (inProvider(global)) return global;
        // 连全局都不在列表 → 不传 --model,让 CLI 用 settings.json 默认。
        return null;
      })();
      const currentModel = _validModel;
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
          excludeDynamicSystemPrompt: useStore.getState().excludeDynamicSystemPrompt || undefined,
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
            // Record the provider this turn ran under so a later switch can strip
            // now-invalid thinking-block signatures. Model name can't tell a mimo
            // relay (claude-* names) from official, so we key off the live hint.
            useStore.getState().setLastProvider(
              event.session_id,
              useStore.getState().currentProvider?.providerHint || 'anthropic',
            );
            const sel = getLocalSession();
            if (sel && !sel.sessionId) {
              // Carry the draft's per-session model/permission pins to the real
              // session id so a model picked for a brand-new chat doesn't revert.
              useStore.getState().migrateSessionKey(`draft-${sel.projectHash || 'none'}`, event.session_id);
              // I4:草稿流拿到真 sessionId,把流归属 key 一并升级,否则 setSelectedSession
              // 把当前会话 key 变成真 id 后,渲染层会判定"流不属于当前会话"而误隐藏本条流。
              if (streamOwnerKeyRef.current === `draft-${sel.projectHash || 'none'}`) {
                setStreamOwner(event.session_id);
              }
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
              const hash = sel.projectHash;
              // Retry triple — jsonl write timing varies. First attempt may
              // hit the brief window before the CLI flushes; later ones catch
              // up. silent so loading flag doesn't flicker.
              if (hash) {
                [400, 1200, 3000].forEach((ms) =>
                  setTimeout(() => useStore.getState().fetchSessions(hash, { silent: true }), ms)
                );
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
                if (!block) continue;
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
                    sessionId: getLocalSession()?.sessionId || null,  // #9 归属会话
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
                      name: parsed.subagent_type || parsed.agent || block.name,
                      description: parsed.description || parsed.prompt?.slice(0, 80) || '',
                      status: 'working',
                      prompt: parsed.prompt || '',  // #9 子代理派发 prompt
                      sessionId: getLocalSession()?.sessionId || null,
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
              if (event.message.model) aStore.upsertAgent(aid, { model: event.message.model });
              for (const block of (Array.isArray(event.message.content) ? event.message.content : [])) {
                if (block.type === 'text' && block.text) aStore.appendAgentText(aid, block.text);
                else if (block.type === 'thinking' && block.thinking) aStore.appendAgentThinking(aid, block.thinking);
                else if (block.type === 'tool_use') aStore.appendAgentTool(aid, { id: block.id, name: block.name, input: block.input || {}, result: null });
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
                    name: inp.subagent_type || inp.agent || block.name,
                    description: inp.description || (inp.prompt ? String(inp.prompt).slice(0, 80) : ''),
                    prompt: inp.prompt || '',
                    status: 'working',
                    startedAt: Date.now(),
                    sessionId: getLocalSession()?.sessionId || null,
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
                    sessionId: getLocalSession()?.sessionId || null,
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
                // If this result closes a Task tool_use, mark the subagent done.
                const store = useStore.getState();
                if (store.activeAgents[block.tool_use_id]) {
                  store.upsertAgent(block.tool_use_id, {
                    status: block.is_error ? 'error' : 'done',
                    result: extractToolResultText(block.content),
                  });
                  // U7 兜底:有些 CLI/provider 不往父流发子代理内部事件的 tool_result,
                  // Task 已收尾时把仍 pending 的子工具统一标记完成,不再转圈。
                  const ag = store.activeAgents[block.tool_use_id];
                  if (ag?.toolCalls?.some((tc) => !tc.result)) {
                    store.upsertAgent(block.tool_use_id, {
                      toolCalls: ag.toolCalls.map((tc) => tc.result
                        ? tc
                        : { ...tc, result: { content: '', isError: false, synthetic: true } }),
                    });
                  }
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
          // Surface CLI-side errors that previously got silently dropped:
          //   - type:"error"  (our server's stderr/spawn fail wrapper)
          //   - type:"result" with is_error:true (CLI's own error envelope,
          //     e.g. "No conversation found with session ID: ...")
          if (event.type === 'error' || (event.type === 'result' && event.is_error)) {
            // P1-1:服务端把 CLI stdout 里任意非 JSON 行(banner/调试/ANSI 噪声)包成
            // {type:'error',error:'bad-line'}。这类是良性噪声,绝不能当致命错误弹❌+break
            // 中止整轮(否则后续有效事件含 result 全丢,进程其实还在跑)。直接跳过。
            if (event.error === 'bad-line') continue;
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
                setSelectedSession({ ..._s, sessionId: null, draft: true });
              }
              setProviderSwitchNotice({ text: '原会话历史已失效，已自动新建会话并重发本条。' });
              setTimeout(() => handleSendRef.current?.(prompt, { ...opts, freshRetry: true }), 80);
              accumulatedText = ''; accumulatedThinking = ''; currentToolCalls = [];
              sawError = true;
              break;
            }
            // G4:上下文超窗 → 413 / prompt too long。/compact 也会因此失败(摘要请求本身超限)。
            // 不自动重试,弹引导横幅让用户选恢复方式。
            if (/\b413\b|payload too large|prompt is too long|too many tokens|input (?:is )?too long|exceed[a-z ]*context|context[a-z ]*exceed|maximum context/i.test(msg)) {
              setCtxOverflow({ has1m: /\[1m\]/i.test(currentModel || ''), wasCompact: isCompact });
              accumulatedText = ''; accumulatedThinking = ''; currentToolCalls = [];
              sawError = true;
              break;
            }
            setChatMessages((prev) => [...prev, {
              uuid: 'chat-error-' + Date.now(),
              type: 'turn',
              timestamp: new Date().toISOString(),
              model: streamingModel,
              text: [`❌ **${msg}**\n\n常见原因：\n- session 不在当前 cwd 对应的项目目录 → 新建会话\n- jsonl 被 trim 后损坏 → 新建会话\n- CLI 版本异常 → 终端跑 \`claude --help\` 验证`],
              thinking: [],
              toolCalls: [],
              blocks: [{ type: 'text', content: `❌ **${msg}**` }],
              usage: null,
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
          // Z1:CLI 在 result 事件上报本轮实际成本 total_cost_usd,比单价表估算
          // 权威。compact 回合除外(其成本属压缩开销,且 usage 是压缩前旧上下文)。
          if (event.type === 'result' && !isCompact && typeof event.total_cost_usd === 'number' && event.total_cost_usd > 0) {
            resultCostUsd = event.total_cost_usd;
          }
          if (event.type === 'done') break;
        }
      }

      if (accumulatedText || accumulatedThinking || currentToolCalls.length > 0) {
        producedReply = true;
        setChatMessages((prev) => [...prev, {
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
      if (err.name === 'AbortError') {
        // 用户主动「停止」:把已经流式显示的文本/思考/工具调用保留成一条气泡(标记
        // 已停止),而不是连同用户消息一起丢弃——以前这里静默清空,用户辛苦看到的半截
        // 回复+工具调用全没了,只剩刚发的消息(#6)。producedReply=true 让 finally 的
        // 落盘轮询把它当正常产出处理(jsonl 若已写入半截会 refetch 覆盖,否则保留本地副本)。
        if (accumulatedText || accumulatedThinking || currentToolCalls.length > 0) {
          producedReply = true;
          setChatMessages((prev) => [...prev, {
            uuid: 'chat-stopped-' + Date.now(), type: 'turn',
            timestamp: new Date().toISOString(), model: streamingModel,
            text: accumulatedText ? [accumulatedText] : [],
            thinking: accumulatedThinking ? [accumulatedThinking] : [],
            toolCalls: currentToolCalls.map((tc) => ({ ...tc, category: tc.category || 'call' })),
            blocks: orderedBlocks,
            usage: null,
            interrupted: true,
          }]);
        }
      } else if (!isNetworkDrop) {
        console.error('Chat error:', err);
        // Render the failure as a visible turn so the user isn't left staring at
        // a frozen "connecting" with no explanation (e.g. invalid project dir).
        setChatMessages((prev) => [...prev, {
          uuid: 'chat-error-' + Date.now(),
          type: 'turn',
          timestamp: new Date().toISOString(),
          model: null,
          text: [`❌ ${err.message || '发送失败'}`],
          thinking: [],
          toolCalls: [],
          blocks: [{ type: 'text', content: `❌ ${err.message || '发送失败'}` }],
          usage: null,
        }]);
      }
    } finally {
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
      const _sel = getLocalSession();
      if (_sel?.sessionId && _sel?.projectHash) {
        const finalizeSid = _sel.sessionId;
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
          if (persisted.filter((m) => m.type === 'turn').length <= turnsBefore) return false;
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
          // PEEK persisted WITHOUT committing to the store. A mid-round jsonl
          // (text+tool written, trailing text C not yet) must NEVER render — if we
          // committed it, the naive [...persisted, ...local] concat + coarse tkey
          // dedup would show the partial turn and drop the complete local copy →
          // the trailing message C vanishes. So we only commit once the FULL round
          // (incl trailing text) has landed.
          let peeked = [];
          try {
            const r = await fetch(`/api/sessions/${finalizeSid}/messages?projectHash=${encodeURIComponent(_sel.projectHash)}`);
            // 该端点直接返回数组(res.json(messages)),不是 {messages:[]}。原来取 .messages
            // 永远是 undefined→peeked 恒为 []→roundLanded 恒 false→每轮空跑满 12 次(~2.4s)
            // 才回退,尾部落盘检测形同虚设。兼容两种形态。
            if (r.ok) { const d = await r.json(); peeked = Array.isArray(d) ? d : (d?.messages || []); }
          } catch {}
          if (getLocalSession()?.sessionId !== finalizeSid) break;
          if (!producedReply) {
            // Empty/errored turn — no jsonl twin to wait for. Commit persisted and
            // drop matched NON-turn locals (the user prompt); keep the local ⚠️/❌
            // turn visible.
            try { await fetchMessagesForTab(finalizeSid, _sel.projectHash, { silent: true }); } catch {}
            const known = new Set(getLocalMessages().map(tkey));
            setChatMessages((prev) => (prev.length ? prev.filter((m) => m.type === 'turn' || !known.has(tkey(m))) : prev));
            break;
          }
          if (roundLanded(peeked, i)) {
            // Full round (incl trailing text) persisted → commit it to the store,
            // then drop ALL local copies (streamed text rarely byte-matches final
            // jsonl, so clearing avoids a doubled turn).
            // 例外:type==='btw' 旁问气泡只活在本地(永远没有 jsonl 孪生),整清会让它
            // 在回合结束时凭空消失;保留,切会话/刷新时自然清掉。
            try { await fetchMessagesForTab(finalizeSid, _sel.projectHash, { silent: true }); } catch {}
            setChatMessages((prev) => (prev.some((m) => m.type === 'btw') ? prev.filter((m) => m.type === 'btw') : []));
            break;
          }
          if (i < 11) await new Promise((r) => setTimeout(r, 200));
        }
      }
      // BF-1:回合收尾清历史截断,历史渲染交还 jsonl。放在 finalize 循环之后:break 与
      // 此处同一同步续体,React 合批 —— 与循环内 setChatMessages([]) 同帧提交,不会闪现
      // "本地已清、截断还在 → 该回合一帧不可见"。nav-away 提前 break / 无 sid 路径也覆盖。
      setStreamHistCutoff(null);
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
          const probePh = getLocalSession()?.projectHash || selectedSession?.projectHash || '';
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
        // 被用来给新会话生成标题(用户报告:其他会话标题被改)。改用流归属 key(真 sid)。
        const _ownerKey = streamOwnerKeyRef.current;
        const titleSid = (_ownerKey && !_ownerKey.startsWith('draft-')) ? _ownerKey : getLocalSession()?.sessionId;
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
      // 排队消息永不自动发出(分屏几乎必现)。排空用本 pane 当前会话 key,reattach
      // 回来时正是该会话;shiftMessage 原子 pop + reattach 串行(reattachedPidRef
      // 守卫)→ 不会与原 finally 双发。仍与 ⚡引导(acceleratingRef)互斥。
      if (!acceleratingRef.current) {
        const tabSel = getLocalSession();
        const queueKey = tabSel?.sessionId
          || `draft-${tabSel?.projectHash || 'none'}`;
        const next = useStore.getState().shiftMessage(queueKey);
        if (next?.text) {
          // 透传入队时的 opts(尤其 hiddenUserMessage)——否则计划执行这种隐藏续跑消息
          // 出队重发时会变成可见的用户气泡(#5)。
          setTimeout(() => handleSendRef.current?.(next.text, next.opts || (next.hidden ? { hiddenUserMessage: true } : {})), 50);
        }
      }
      acceleratingRef.current = false;
    }
  }, [selectedSession, selectedProject, streamingModel, isStreaming, sessionQueueKey]);

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

  const handleStop = useCallback(() => {
    // 记下要停的 pid → poll/reattach 不再把它当「还在后台跑」(它在服务端 60s grace 内
    // 仍 stoppable)。持 SSE 的 activeProc 与不持 SSE 的 background 两条路径都要记。
    const pid = activeProcRef.current || backgroundPid;
    if (pid) stoppedPidsRef.current.add(String(pid));
    abortRef.current?.abort();
    if (activeProcRef.current) {
      fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST' });
    } else if (backgroundPid) {
      // Background CLI proc — we're not holding the SSE but can still kill it.
      fetch(`/api/chat/${backgroundPid}/stop`, { method: 'POST' });
    }
    // 两种情况都立即清掉本地「后台运行中」标记,不等下一轮 poll(那一轮还会误报)。
    setBackgroundPid(null);
  }, [backgroundPid]);
  // CQ-15:把 handleStop / backgroundPid 包成 ref,供 ESC 监听读最新值而不必进 effect deps。
  // 原来 ESC effect 依赖 [isStreaming, backgroundPid, handleStop],而 backgroundPid 每 1.5s
  // poll 抖动、handleStop 随之重建 → effect 频繁 cleanup+register,切焦点同帧有「两个 pane
  // 都短暂挂着 listener」的竞态(双击 ESC 误停其它 pane 的根因之一)。
  const handleStopRef = useRef(handleStop);
  useEffect(() => { handleStopRef.current = handleStop; }, [handleStop]);
  const backgroundPidRef = useRef(backgroundPid);
  useEffect(() => { backgroundPidRef.current = backgroundPid; }, [backgroundPid]);

  // Double-ESC → interrupt streaming (matches Claude Code CLI). A SINGLE Esc
  // keeps its local meaning (closing the slash-command menu / a popover); a
  // SECOND Esc within 600ms aborts the current generation. Deliberately NOT
  // gated on textarea/input focus: during a reply the cursor lives in the
  // composer, so the old "ignore Esc from a textarea" guard meant Esc never
  // interrupted in practice. Permission dialogs still own Esc (deny).
  useEffect(() => {
    // AZ1:分屏下 esc 双击中断只作用于【焦点窗格】。effect 挂 window 级,每个流式
    // pane 各注册一个 listener;不加这道守卫则一次 esc 广播到所有 pane → 中断全部会话。
    // 与上方 Cmd+F effect 的 paneIsActive 守卫同构。单屏 activeTabIndex 恒 0,无回归。
    if (!paneIsActive) return;
    // 只在「焦点 pane」注册一次(deps 仅 paneIsActive)。是否有可停的流改为在按键时用 ref
    // 实时判断,不再让 isStreaming/backgroundPid 抖动驱动 effect 反复重注册(CQ-15 竞态根因)。
    const hasPendingPerm = () => useStore.getState().pendingPermissions
      .some((p) => p.sessionId === getLocalSession()?.sessionId);
    let lastEsc = 0;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.repeat) return; // ignore held-key repeats
      if (!streamingRef.current && !backgroundPidRef.current) return; // 本 pane 没有在跑的流,不拦截
      if (hasPendingPerm()) { lastEsc = 0; return; } // permission card handles Esc
      const now = e.timeStamp || performance.now();
      if (lastEsc && now - lastEsc <= 600) {
        lastEsc = 0;
        e.preventDefault();
        handleStopRef.current?.();
      } else {
        lastEsc = now; // first press — let local Esc semantics run, arm the second
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneIsActive]);

  // "⚡ 引导" — abort the in-flight chat and immediately fire the queued message.
  const handleAccelerate = useCallback(() => {
    if (abortRef.current) try { abortRef.current.abort(); } catch {}
    if (activeProcRef.current) {
      fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST' }).catch(() => {});
    }
    // Drain the queue head ourselves instead of relying on the aborted send's
    // finally: that finally SKIPS drain on a reattach stream (App enters reattach
    // when you revisit a still-generating session), so on mobile "⚡ 引导" did
    // nothing. Flag it so the finally doesn't also pop (double-send).
    acceleratingRef.current = true;
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
        updateStreaming(false);
        setChatMessages([]);
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
    const cwd = proj?.path || sel?.projectPath;
    const projectHash = proj?.hash || sel?.projectHash;
    const idxInChat = chatMessages.findIndex((m) => m.uuid === msg.uuid);
    const idxInStore = messages.findIndex((m) => m.uuid === msg.uuid);
    const resolveCheckpointSha = async () => {
      if (msg.checkpointSha) return msg.checkpointSha;
      if (!sel?.sessionId) return null;
      const params = new URLSearchParams();
      if (msg.timestamp) params.set('timestamp', msg.timestamp);
      if (msg.text) params.set('text', msg.text);
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
        setChatMessages([]);
      } else if (idxInChat !== -1) {
        setChatMessages((prev) => prev.slice(0, idxInChat));
      }
    };

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
    const originalText = msg.text || '';
    if (mode === 'edit' && originalText) {
      // Target THIS pane's composer only (key == its sessionQueueKey). The old
      // untargeted store write + broadcast filled EVERY split pane's input box.
      const targetKey = sel?.sessionId || `draft-${sel?.projectHash || 'none'}`;
      window.dispatchEvent(new CustomEvent('cgui:composer-fill', { detail: { text: originalText, targetKey, editMode: true } }));
      // 非破坏式(#4):只回填输入框 + 记录待回滚目标,绝不在此刻 trim/截断/还原文件。
      // 等用户真正点发送时(handleSend 拦截)才回退;按 Esc 取消则历史毫发无损。
      setPendingEditRollback({ msg, targetKey });
      return;
    }

    if (idxInChat === -1 && idxInStore === -1) return;

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
        if (!r.ok) softDegrade();
      } catch {
        softDegrade();
      }
    }

    // 2) trim on-disk jsonl so the resumed CLI doesn't see stale history.
    //    Strategy: prefer uuid match (historical store messages); fall back to
    //    timestamp for freshly-sent messages whose chat-user-<ts> uuid never
    //    landed in the jsonl (the CLI persists its own uuid but keeps the ts).
    let sessionWasReset = false;
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
          });
        }
      } catch {}
    }

    // 3) abort any in-flight stream from this session so the resend doesn't
    //    collide with it.
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
    if (activeProcRef.current) {
      fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST' }).catch(() => {});
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
        setChatMessages([]);
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

        if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
        if (activeProcRef.current) {
          fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST' }).catch(() => {});
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
      if (tabIndex === 0 && st.paneCount === 1) st.setSelectedSession(fork);
      else st.setPaneSession(tabIndex, fork);
    } catch (e) { await confirmDialog('分叉失败：' + String(e.message || e)); }
  }, [tabIndex]);
  const stableRetryTool = useCallback((turn, toolCall) => handleRetryToolRef.current?.(turn, toolCall), []);
  const stableRollback = useCallback((msg, opts) => handleRollbackRef.current?.(msg, opts), []);

  // In split mode, tab 0's `loading` would otherwise blank out tab 1 too.
  // We only let the loading screen short-circuit the primary tab — tab 1
  // fetches with silent:true so it never sets the global flag, and tab 0
  // remains the one that owns the spinner.
  if (!selectedSession) return <EmptyState />;
  if (loading && tabIndex === 0) return (
    <div className="flex-1 flex items-center justify-center bg-canvas">
      <div className="flex gap-1.5">
        {[0, 0.2, 0.4].map((d) => (
          <div key={d} className="w-2 h-2 rounded-full bg-accent/40" style={{ animation: `breathe 1.4s ease-in-out infinite ${d}s` }} />
        ))}
      </div>
    </div>
  );

  // C1:流式缓冲(chatMessages)只在它归属当前查看的会话时才计入统计 —— 否则流归属
  // 会话 A、用户切到会话 B 的那一帧(setChatMessages([]) 异步未提交前),A 的流式 turn
  // 的 usage/cost 会被算进 B 的徽章/成本(切会话当帧串值闪现)。与渲染层(下面 liveVisible
  // 隐藏流式气泡)同源,统计也走同一门控。
  // CQ-5:原有 `streamOwnerKey == null ||` 子句是「串内容/重复渲染」根因——pane 初次挂载或
  // 刚 setChatMessages([]) 未提交时 owner=null 会让 liveVisible 恒 true,把上个会话残留的
  // chatMessages 显示到当前会话(切走切回就好=第二次 owner 已非 null)。handleSend 在写入
  // 用户气泡前已 setStreamOwner(sessionQueueKey)(含 reattach),所以凡是该显示的本地缓冲
  // owner 必等于 sessionQueueKey;去掉 null 子句即根治泄漏,且与上面 C1 注释本意一致。
  const liveVisible = streamOwnerKey === sessionQueueKey;
  // BF-1:展示口径统一走 visibleMessages(活跃流期间剔除本回合半成品),回合进度条/
  // 成本等派生统计与消息列表同源,不再出现"进度条多一个重复回合点"。
  const allMessages = [...visibleMessages, ...(liveVisible ? chatMessages : [])];
  // 右侧回合进度条数据:每个用户回合一个点(摘要取去附件后的显示文本)。
  // 注意:必须是普通计算,不能用 useMemo —— 这里在 SessionDetail 的早返回
  // (if loading && tabIndex===0 return)之后,加 hook 会导致切换会话(loading 切换)时
  // "Rendered fewer hooks than expected" 崩溃白屏。TurnScrubber 的 measure 已用 turnsRef
  // 稳定,不依赖 userTurns 引用,所以这里每帧新建数组无性能问题。
  const userTurns = allMessages
    .filter((m) => m.type === 'user' && m.uuid)
    .map((m) => ({ uuid: m.uuid, text: m.displayText || m.text || '', ts: m.timestamp }));
  // 哪些回合发起过旁问(atTurnUuid)→ TurnScrubber 在这些点标记"含旁问"。旁问本地态,
  // 数量极小,每帧新建 Set 无性能顾虑(与 userTurns 同理)。
  const btwTurnUuids = new Set(
    chatMessages.filter((m) => m.type === 'btw' && m.atTurnUuid).map((m) => m.atTurnUuid)
  );
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
  const contextWindow = /\[1m\]/i.test(currentModel || '')
    ? 1_000_000
    : (measuredCtx?.windowTokens || nativeContextWindow(currentModel));
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

  return (
    <div className={`flex-1 flex flex-col min-h-0 glass-base relative ${hasChatBg ? 'isolate' : ''}`}>
      {/* ③ 对话区自定义背景(未设置时 null,外观与之前完全一致)。isolate 仅在启用
          背景时加:让 -z-10 背景层限定在本 pane 的层叠上下文内、垫在所有内容之下。 */}
      <ChatBackgroundLayer />
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
        <TurnScrubber containerRef={containerRef} turns={userTurns} btwTurnUuids={btwTurnUuids} />
      )}
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
              <span className="text-[10px] text-ink-faint font-mono shrink-0 whitespace-nowrap">{messages.length + chatMessages.length} 条消息</span>
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
              {toolCallCount > 0 && <span className="text-[10px] text-ink-faint font-mono shrink-0 whitespace-nowrap">{toolCallCount} 工具调用</span>}
              {currentProvider?.providerHint && currentProvider.providerHint !== 'anthropic' && (
                <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-px font-mono shrink-0 whitespace-nowrap"
                  title={`cc switch 路由：${currentProvider.baseUrl}`}>
                  {currentProvider.providerHint === 'unknown'
                    // unknown 时显示 baseUrl hostname,而非丑的 "Unknown"
                    ? (() => { try { return new URL(currentProvider.baseUrl).hostname; } catch { return '自定义'; } })()
                    : currentProvider.providerHint.charAt(0).toUpperCase() + currentProvider.providerHint.slice(1)}
                </span>
              )}
              {/* Show the model the NEXT send will use (current selection),
                  plus any historical models in muted form. Previously this
                  only showed the historical aggregate, so picking Haiku in
                  the dropdown but seeing the past message's Sonnet badge
                  looked like the GUI ignored the switch. */}
              <div className="flex items-center gap-1 shrink-0">
                {headerModel && <ModelBadge model={headerModel} compact />}
                {models.filter((m) => m !== headerModel).length > 0 && (
                  <span className="text-[9px] text-ink-ghost font-mono whitespace-nowrap"
                    title={`本会话历史用过: ${models.join(', ')}`}>
                    曾用 {models.filter((m) => m !== headerModel).length} 个其他
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 min-w-0 flex-wrap justify-end">
            <ExportSessionButton
              messages={[...messages, ...chatMessages]}
              title={(selectedSession?.sessionId
                && (useStore.getState().customTitles[selectedSession.sessionId]
                  || useStore.getState().autoTitles[selectedSession.sessionId]))
                || selectedSession?.firstPrompt || '会话'}
            />
            <CheckpointButton
              sessionId={selectedSession?.sessionId}
              cwd={selectedSession?.projectPath || selectedProject?.path}
              projectHash={selectedSession?.projectHash}
              onRestored={() => {
                // #1:恢复 checkpoint 后重载本会话消息,让消息页跟着回到该时刻(裁剪在 restore 内做)。
                const s = getLocalSession();
                if (s?.sessionId && s?.projectHash) fetchMessagesForTab(s.sessionId, s.projectHash, { silent: true });
              }}
            />
            {/* 悬停显示四项明细(输入/输出/缓存命中/缓存写入)与口径说明。 */}
            <div className="text-right max-md:hidden" title={usageDetailTitle}>
              <div className="text-[10px] text-ink-faint font-mono flex items-center gap-1 justify-end">
                <BarChart3 size={10} />{totalAllTokens.toLocaleString()} tokens
                {totalCostUsd > 0 && (
                  <span className="text-accent/80 ml-1.5" title="按当前各模型官网价估算的累计费用（CNY 模型按 1 USD ≈ 7.2 CNY 换算）">
                    · {formatCost(totalCostUsd)}
                  </span>
                )}
              </div>
              {totalTokens.cacheRead > 0 && (
                <div className="text-[10px] text-ink-ghost font-mono">
                  缓存命中 {totalTokens.cacheRead.toLocaleString()} · 命中率 {cacheHitPct.toFixed(1)}%
                </div>
              )}
            </div>
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

      {/* Permission-mode hint banner — moved here from ChatInput so it sits
          directly under the session title. With our PreToolUse permission
          bridge, default mode now correctly pops a dialog per tool. Banner is
          dismissible per-user (localStorage). */}
      <PermissionModeHintBanner permKey={sessionQueueKey} />

      {/* git-init 提示只在「项目头部」(侧栏)渲染一处(见 GitInitBanner @ 项目面板),
          这里不再重复挂载——两处同时显示同一提示且状态不同步(忽略/init 后只更新
          自己那份),造成重复+脱节。项目头部那处触发更早(选中项目即检测,空状态也覆盖)。 */}

      {/* Provider-switch notice — fades after 5s. Tells the user we just
          stripped thinking blocks from on-disk jsonl so cc switch's new
          backend won't reject the resumed history. */}
      {providerSwitchNotice && (
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

      {/* 第三方 provider 上下文达阈值时的 GUI 侧自动压缩看门狗(原生 auto-compact 对第三方不可靠)。 */}
      <AutoCompactBanner
        key={selectedSession.sessionId || 'draft'}
        contextPct={contextPct}
        idle={!isStreaming && !compacting}
        enabled={paneIsActive && !!(currentProvider?.providerHint && currentProvider.providerHint !== 'anthropic') && !!selectedSession.sessionId}
        onCompact={() => handleSend('/compact')}
      />

      {/* G4:上下文超窗 / compact 失败(413) 的恢复引导。带操作按钮,不自动重试。 */}
      {ctxOverflow && (
        <div className="shrink-0 mx-6 mt-2 px-3 py-2.5 rounded-md bg-red-50 border border-red-200 animate-fade-up">
          <div className="text-red-700 text-[12px] font-body leading-snug mb-2">
            ⚠️ {ctxOverflow.wasCompact ? '/compact 失败' : '上下文超出模型窗口'}：当前对话已超过模型上下文上限，
            {ctxOverflow.wasCompact ? '压缩需要把整段对话发给模型做摘要，请求本身也超限（HTTP 413），所以压缩无法执行。' : '上游拒绝了整个请求（HTTP 413）。'}
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
                  setSelectedSession({ ..._s, sessionId: null, draft: true });
                }
                setChatMessages([]);
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

      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto relative z-10">
          {visibleMessages.length === 0 && (liveVisible ? chatMessages.length : 0) === 0 ? (
            <div className="mobile-draft-empty flex items-center justify-center h-full text-ink-muted text-sm font-body">
              {selectedSession?.draft ? '开始你的第一条消息 ↓' : '该会话没有可显示的消息'}
            </div>
          ) : (
            <>
              <MessageList
                messages={visibleMessages}
                onRetryTurn={stableRetryTurn}
                onRetryTool={stableRetryTool}
                onRollback={stableRollback}
                onFork={forkCurrentSession}
                retryActiveUuid={retryActiveUuid}
              />
              {liveVisible && chatMessages.map((msg, i) => (
                <div key={msg.uuid || i} data-turn-uuid={msg.uuid} data-turn-role={msg.type}>
                  {msg.type === 'compact'
                    ? <CompactDivider />
                    : msg.type === 'btw'
                    ? <BtwBubble msg={msg} onHide={(uuid) => setChatMessages((prev) => prev.filter((m) => m.uuid !== uuid))} />
                    : msg.type === 'turn'
                    ? <TurnBubble turn={msg} onRetry={handleRetryTurn} onRetryTool={(toolCall) => handleRetryTool(msg, toolCall)} retryActive={retryActiveUuid === msg.uuid} />
                    : <MessageBubble message={{ ...msg, role: msg.type }}
                        onRollback={msg.type === 'user' ? handleRollback : undefined} />}
                </div>
              ))}
              {liveVisible && isStreaming && (streamingText || streamingThinking || streamingToolCalls.length > 0 || streamingBlocks.some((b) => (b?.content?.length > 0) || b?.toolCall)) && (
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
              {liveVisible && isStreaming && !streamingText && !streamingThinking && streamingToolCalls.length === 0 && !streamingBlocks.some((b) => (b?.content?.length > 0) || b?.toolCall) && (
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
                      {contextTokens > 100_000 && (
                        <div className="text-[11px] text-ink-faint font-body mt-1">
                          上下文较大({Math.round(contextTokens / 1000)}k)，首字可能较慢；若长时间无响应,可点停止后 <code className="font-mono">/compact</code> 压缩或换 provider。
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

      {!autoScroll && (
        // 桌面 + 手机都居中输入框上方 — 避免压在发送/停止按钮上,视觉重心
        // 也更舒服(原来右下角桌面端虽不挡,但偏角落容易看不见)。
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-20">
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

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        onAccelerate={messageQueue.length > 0 ? handleAccelerate : undefined}
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
        permKey={sessionQueueKey}
        sessionId={selectedSession?.sessionId || null}
      />
    </div>
  );
});

// ─── Model Selector ────────────────────────────────────────────
// Dropdown anchored to the trigger button (lightweight: no full-screen blur).
// Outside-click closes via a document-level listener — needed because the
// usual "fixed inset-0" trick is trapped inside header's transform context.
// Header button that hands the active session off to phone control. Like
// Claude Desktop, the server hosts `claude --remote-control --resume <id>` on a
// HIDDEN pseudo-terminal (node-pty) — no terminal window pops up. The Claude
// mobile app then takes over the SAME account/session via Anthropic's relay;
// the GUI keeps syncing via jsonl. While active, the composer is locked to
// avoid two processes writing the same session file. Clicking again reclaims.
// Disabled until the session exists (a sessionId is needed to --resume).
function RemoteControlButton({ session }) {
  const [busy, setBusy] = useState(false);
  const sid = session?.sessionId || null;
  const cwd = session?.projectPath || null;
  const active = useStore((s) => (sid ? !!s.remoteControlled[sid] : false));

  const toggle = async () => {
    if (!sid || busy) return;
    setBusy(true);
    try {
      const url = active ? '/api/remote-control/stop' : '/api/remote-control';
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, cwd }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      useStore.getState().setRemoteControl(sid, !active);
    } catch (e) {
      confirmDialog((active ? '收回远程控制失败：' : '开启远程控制失败：') + e.message);
    }
    setBusy(false);
  };

  return (
    <button
      onClick={toggle}
      disabled={!sid || busy}
      title={sid
        ? (active
          ? '已在手机上远程控制此会话 · 点击收回控制'
          : '在手机上同账号控制此会话（用 Claude App 接管，需 Claude 账号、非 deepseek/mimo）')
        : '先发送一条消息创建会话，再开启远程控制'}
      className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors text-[11px] font-body ${
        active ? 'bg-green-50 text-green-700' : 'hover:bg-canvas-deep text-ink-muted'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Smartphone size={13} />}
      {active ? '已激活' : '远程'}
    </button>
  );
}

// One-tap API provider switch, sourced from the user's CC Switch config (read
// only, no keys leave the server). Switching overwrites ~/.claude/settings.json
// with the chosen provider snapshot (server backs it up first); the file-watcher
// then broadcasts provider-change so ModelSelector/cost displays self-refresh.
// Hidden entirely when CC Switch isn't installed/empty.
function ProviderSwitcher() {
  const [providers, setProviders] = useState([]);
  // OpenAI-format providers (codex/opencode) — routed through the embedded
  // Anthropic↔OpenAI proxy on switch so the claude CLI can use them.
  const [openaiProviders, setOpenaiProviders] = useState([]);
  const [customProviders, setCustomProviders] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  // Optimistic current id: the CC Switch db's is_current isn't updated by us
  // (we never write that db), so after a switch we mark the active one locally.
  const [activeId, setActiveId] = useState(null);
  // cc-switch providers can't be deleted from the read-only db, so "hiding" them
  // (server-persisted set of ids) is how a removal sticks. Custom providers are
  // truly deleted instead.
  const [hiddenProviders, setHiddenProviders] = useState(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const wrapRef = useRef(null);
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
  // BZ-2:加/编辑 provider 表单有未保存内容时,外部点击/Esc 不关闭下拉(否则卸载表单
  // → 已输入的 url/key/model 全丢)。表单经 onDirtyChange 上报,这里用 ref 读最新值。
  const formDirtyRef = useRef(false);
  useEffect(() => {
    load();
    const onCh = () => load();
    window.addEventListener('cgui:provider-change', onCh);
    return () => window.removeEventListener('cgui:provider-change', onCh);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (formDirtyRef.current) return; if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') { if (formDirtyRef.current) return; setOpen(false); } };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // Always render — even with zero providers the dropdown still hosts the
  // "添加 Provider" form, so a fresh machine (no CC Switch, nothing added yet)
  // can set up its first provider.

  const isCur = (p) => (activeId != null ? p.id === activeId : p.isCurrent);
  const cur = providers.find(isCur) || openaiProviders.find(isCur) || customProviders.find(isCur);
  // providerHint is lowercase server-side (pricing/compare logic depends on it),
  // so capitalize only for display.
  const capHint = (h) => (h ? h.charAt(0).toUpperCase() + h.slice(1) : h);
  const label = cur?.name || capHint(currentProvider?.providerHint) || 'Provider';

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
      setOpen(false);
    } catch (e) {
      confirmDialog('切换 provider 失败：' + e.message);
    }
    setSwitching(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button onClick={() => setOpen(!open)} title="切换 API Provider（来自 CC Switch）"
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-canvas-deep transition-colors">
        <Server size={12} className="text-ink-muted" />
        <span className="text-[11px] text-ink-soft font-body max-w-[88px] truncate">{label}</span>
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      {open && (
        <div className="glass-popover absolute left-0 top-full mt-2 w-60 max-w-[calc(var(--app-w,100vw)-1.5rem)] z-50 py-1 animate-glass-rise max-h-[70vh] overflow-y-auto max-md:fixed max-md:left-3 max-md:right-3 max-md:w-auto max-md:top-16 max-md:mt-0">
          <div className="px-3 py-2 sticky top-0 bg-canvas border-b border-canvas-deep">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body">切换 Provider</div>
            <p className="text-[10px] text-ink-faint font-body mt-1 leading-snug">
              借鉴 <a href="https://github.com/farion1231/cc-switch" target="_blank" rel="noreferrer" className="text-accent hover:underline">CC Switch</a>。切换会改写 <code className="font-mono">~/.claude/settings.json</code>（自动备份），<b>对新发的消息生效</b>。
            </p>
            <p className="text-[10px] text-ink-faint font-body mt-1 leading-snug border-t border-canvas-deep/40 pt-1">
              <b>原理(协议路由)</b>：和 <a href="https://github.com/farion1231/cc-switch" target="_blank" rel="noreferrer" className="text-accent hover:underline">cc-switch</a> 一样把 Claude 模型名映射到第三方。OpenAI 格式经本地代理 <code className="font-mono">8788</code> 做协议翻译、Anthropic 格式经 <code className="font-mono">8789</code> 透传换 token —— 都是<b>本机中转</b>，非直连官方。
            </p>
          </div>
          {providers.filter((p) => showHidden || !hiddenProviders.has(p.id)).map((p) => (
            <div key={p.id} className={`px-3 py-1 ${isCur(p) ? 'bg-accent-subtle' : ''} ${hiddenProviders.has(p.id) ? 'opacity-50' : ''}`}>
              <div className="flex items-center gap-0.5 -mx-3 pr-2 pl-3 hover:bg-canvas-warm transition-colors">
                <button disabled={switching} onClick={() => switchTo(p.id)}
                  className={`flex-1 min-w-0 text-left py-1 flex items-center gap-2 ${switching ? 'opacity-50' : ''}`}>
                  <span className={`flex-1 text-xs font-body truncate ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
                  {isCur(p) && <Check size={12} className="text-accent shrink-0" />}
                </button>
                <button onClick={() => toggleHideProvider(p.id)} title={hiddenProviders.has(p.id) ? '取消隐藏' : '从列表隐藏'} className="p-1 text-ink-faint hover:text-ink-muted shrink-0">
                  {hiddenProviders.has(p.id) ? <ArchiveRestore size={12} /> : <EyeOff size={12} />}
                </button>
              </div>
              {p.category !== 'official' && <ProviderOverrideEditor provider={p} override={overrides[p.id]} onSaved={load} />}
            </div>
          ))}
          {openaiProviders.length > 0 && (
            <div className="px-3 pt-2 pb-1 mt-1 border-t border-canvas-deep">
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body flex items-center gap-1">
                OpenAI 格式 <span className="text-ink-ghost normal-case tracking-normal">· 经内置代理</span>
              </div>
            </div>
          )}
          {openaiProviders.filter((p) => showHidden || !hiddenProviders.has(p.id)).map((p) => (
            <div key={p.id} className={`px-3 py-2 ${isCur(p) ? 'bg-accent-subtle' : ''} ${hiddenProviders.has(p.id) ? 'opacity-50' : ''}`}>
              <div className="flex items-center gap-2">
                {/* Click the provider to switch to it (default model). The full
                    model list lives in the ModelSelector after switching. */}
                <button disabled={switching} onClick={() => switchTo(p.id)}
                  className={`flex-1 min-w-0 text-left flex items-center gap-2 ${switching ? 'opacity-50' : ''}`}>
                  <span className={`flex-1 text-xs font-body truncate ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
                  {p.models.length > 0 && <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.models.length} 模型</span>}
                  {isCur(p) && <Check size={12} className="text-accent shrink-0" />}
                </button>
                <button onClick={() => toggleHideProvider(p.id)} title={hiddenProviders.has(p.id) ? '取消隐藏' : '从列表隐藏'} className="p-0.5 text-ink-faint hover:text-ink-muted shrink-0">
                  {hiddenProviders.has(p.id) ? <ArchiveRestore size={12} /> : <EyeOff size={12} />}
                </button>
              </div>
              <OpenAIModelManager provider={p} onSaved={load} />
              <ProviderOverrideEditor provider={p} override={overrides[p.id]} onSaved={load} />
            </div>
          ))}
          {customProviders.length > 0 && (
            <div className="px-3 pt-2 pb-1 mt-1 border-t border-canvas-deep">
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body">自定义</div>
            </div>
          )}
          {customProviders.map((p) => (
            <div key={p.id} className={`px-3 py-2 ${isCur(p) ? 'bg-accent-subtle' : ''}`}>
              <div className="flex items-center gap-2">
                {/* Click to switch (default model). The full model list lives in
                    the ModelSelector after switching — NOT nested under the
                    provider row. */}
                <button disabled={switching} onClick={() => switchTo(p.id)}
                  className={`flex-1 min-w-0 text-left flex items-center gap-2 ${switching ? 'opacity-50' : ''}`}>
                  <span className={`flex-1 text-xs font-body truncate ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
                  {p.models.length > 0 && <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.models.length} 模型</span>}
                  <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.type}</span>
                  {isCur(p) && <Check size={12} className="text-accent shrink-0" />}
                </button>
                <button onClick={() => setEditingProvider(p)} title="编辑" className="p-0.5 text-ink-faint hover:text-accent shrink-0"><Pencil size={12} /></button>
                <button onClick={() => removeCustom(p.id, p.name)} title="删除" className="p-0.5 text-ink-faint hover:text-error shrink-0"><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
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
          <CustomProviderForm
            editing={editingProvider}
            onCancel={() => setEditingProvider(null)}
            onSaved={() => { setEditingProvider(null); load(); }}
            onDirtyChange={(d) => { formDirtyRef.current = d; }}
          />
        </div>
      )}
    </div>
  );
}

// 上下文用量徽章 → 可点击,弹出 /context 风格的分项明细(#1)。数据来自后端
// `/api/context/:sessionId`(对会话 fork 副本跑 /context 后解析,原会话不受影响)。
const CTX_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#a3a3a3'];
function ContextBreakdownButton({ contextTokens, contextWindow, contextPct, fmtTok, winLabel, sessionId, projectHash, cwd, model }) {
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
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onEsc);
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
    : contextPct >= 60 ? 'text-amber-700 bg-amber-50'
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
        <span className="text-xs font-medium text-ink font-body">上下文用量</span>
        {data?.model && <span className="text-[10px] text-ink-faint font-mono truncate max-w-[130px]" title={data.model}>{data.model}</span>}
        <button onClick={(e) => { e.stopPropagation(); load(); }} disabled={loading}
          className="ml-auto p-0.5 text-ink-faint hover:text-ink shrink-0" title="重新精确计算 /context（稍慢）">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

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

  return (
    <span ref={wrapRef} className="inline-flex shrink-0">
      <button
        onClick={toggle}
        className={`text-[10px] font-mono whitespace-nowrap px-1.5 py-px rounded transition-colors cursor-pointer ${tone}`}
        title="点击查看上下文分项明细（/context）"
      >
        {fmtTok(contextTokens)}/{winLabel} ({contextPct}%)
      </button>
      {createPortal(menu, document.body)}
    </span>
  );
}

export function ModelSelector({ compact = false, permKey = null }) {
  const { availableModels } = useStore();
  const customModels = useStore((s) => s.customModels);
  // Per-session model: show/select THIS session's model (falls back to the
  // global resolved default when the session has no explicit pick). Picking
  // writes only the session override — never the global settings.json default.
  const currentModel = useStore((s) => (permKey && s.modelBySession[permKey]) || s.currentModel);
  const setModel = (id) => useStore.getState().setModelFor(permKey, id);
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [provider, setProvider] = useState('');
  const [fetchNote, setFetchNote] = useState('');
  const [fetching, setFetching] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  // Live catalogue lives in the store (keyed by provider) so it auto-loads AND
  // survives closing/reopening the picker — instead of vanishing with this
  // component's local state every time it unmounts.
  const fetched = useStore((s) => s.fetchedByProvider[provider]) || EMPTY_ARRAY;
  const doFetch = async () => {
    setFetching(true); setFetchNote('');
    try {
      const r = await fetch('/api/provider/fetch-models', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '拉取失败');
      const models = Array.isArray(d.models) ? d.models : [];
      useStore.getState().setFetchedModels(provider, models);
      setFetchNote(d.note || (models.length ? `已拉取 ${models.length} 个` : '未返回模型'));
    } catch (e) { setFetchNote('拉取失败：' + e.message); }
    setFetching(false);
  };

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/model').then(r => r.json()).then(data => {
        if (cancelled) return;
        const prov = data.provider || '';
        setProvider(prov);
        // Seed the GLOBAL default only (never a per-session override) — this is
        // the resolved settings.json default, used as fallback for sessions
        // without an explicit pick.
        if (data.model) useStore.setState({ currentModel: data.model });
        if (data.available) useStore.setState({ availableModels: data.available });
        // effort 显示:用户没在 GUI 显式选过(localStorage 空)时,用 settings.json 的默认
        // 思考强度(CLAUDE_CODE_EFFORT_LEVEL)显示,免得"settings 设了 high 却显示默认"
        // (实际对话已是 high:GUI 不传 --effort → CLI 读 settings;这里只让显示一致)。
        try {
          if (!localStorage.getItem('cgui-effort') && data.defaultEffort) useStore.setState({ effort: data.defaultEffort });
        } catch {}
        // Auto-load the live catalogue once per provider so the latest models
        // (e.g. Opus 4.8) show up without a manual "拉取最新" click — and persist
        // in the store so they don't disappear when the picker is reopened.
        if (prov && !useStore.getState().fetchedByProvider[prov]) {
          fetch('/api/provider/fetch-models', { method: 'POST' })
            .then((r) => r.json())
            .then((d) => { if (!cancelled) useStore.getState().setFetchedModels(prov, Array.isArray(d.models) ? d.models : []); })
            .catch(() => {});
        }
      }).catch(() => {});
    };
    load();
    const onProviderChange = () => load();
    window.addEventListener('cgui:provider-change', onProviderChange);
    return () => {
      cancelled = true;
      window.removeEventListener('cgui:provider-change', onProviderChange);
    };
  }, []);

  // Outside-click close. Document listener works regardless of transform
  // containing blocks (the fixed-inset trick would be trapped in header).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const handleCustomSubmit = () => {
    const id = customInput.trim();
    if (id) { useStore.getState().addCustomModel(id); selectModel(id); setCustomInput(''); }
  };
  // Merge user-added ids that the server didn't already enumerate, so they show
  // as selectable rows (with a remove affordance).
  const q = query.trim().toLowerCase();
  const match = (id, name) => !q || id.toLowerCase().includes(q) || (name || '').toLowerCase().includes(q);
  const customRows = customModels
    .filter((id) => !availableModels.some((m) => m.id === id))
    .map((id) => ({ id, name: id.replace(/\[1m\]/i, ''), tier: '自定义', source: 'custom', context1m: /\[1m\]/i.test(id) }));
  const fetchedRows = fetched
    .filter((id) => !availableModels.some((m) => m.id === id) && !customModels.includes(id))
    .filter((id) => match(id, id))
    .map((id) => ({ id, name: id }));

  // 1M-context toggle: Claude Code enables the 1M beta via a `[1m]` suffix on
  // the model id (same thing the CLI's /model picker writes). Toggling just
  // adds/removes the suffix on whatever model is current.
  // `[1m]` 是 Claude Code 启用 1M 上下文的通用后缀约定。Anthropic(Opus 4.8/4.7/4.6、
  // Sonnet 4.6)和 MiMo(mimo-v2.5-pro[1m],见官方文档)等兼容 provider 都用它启用 1M。
  // 因此对所有模型开放——provider 若不支持会自行报错,由用户决定关掉。
  const has1m = /\[1m\]/i.test(currentModel || '');
  const toggle1m = () => {
    const base = (currentModel || '').replace(/\[1m\]/i, '');
    if (!base) return;
    setModel(has1m ? base : `${base}[1m]`);
  };
  // 切换模型时保留当前 1M 标记,避免换模型静默丢掉 1M 选择。
  const selectModel = (id) => {
    const base = id.replace(/\[1m\]/i, '');
    setModel(has1m ? `${base}[1m]` : base);
    setOpen(false);
  };

  if (!currentModel) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-2 py-1 rounded-md hover:bg-canvas-deep transition-colors ${compact ? '' : 'px-2.5'}`}>
        <ModelBadge model={currentModel} compact={compact} />
        {/* The vendor tag is redundant with the Claude model badge when on the
            official Anthropic endpoint — only show it for relays (DeepSeek/MiMo/
            OpenRouter) where it warns that aliases may be redirected. */}
        {provider && provider !== 'Anthropic' && !compact && (
          <span className="text-[9px] px-1 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono">{provider}</span>
        )}
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      {open && (
        <div className="glass-popover absolute left-0 top-full mt-2 w-80 max-w-[calc(var(--app-w,100vw)-1.5rem)] z-50 py-1 animate-glass-rise max-h-[70vh] overflow-y-auto max-md:fixed max-md:left-3 max-md:right-3 max-md:w-auto max-md:top-16 max-md:mt-0">
          <div className="px-3 py-2 sticky top-0 bg-canvas border-b border-canvas-deep">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body flex items-center justify-between">
              <span>选择模型</span>
              {provider && provider !== 'Anthropic' && <span className="text-ink-ghost normal-case">{provider}</span>}
            </div>
            <p className="text-[10px] text-ink-faint font-body mt-1 leading-snug">
              <b>alias</b> = CLI 接收 <code className="font-mono">sonnet/opus/haiku</code> 简称，由 CLI 解析到当前 tier 最新模型。
              {provider && provider !== 'Anthropic' && (
                <span className="block text-amber-700 mt-0.5">
                  ⚠ 当前 provider 是 <b>{provider}</b>，alias 可能被该 provider 重定向到其默认模型。建议用具体模型 ID。
                </span>
              )}
            </p>
            <div className="flex gap-1.5 mt-2">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型…"
                className="flex-1 bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-xs text-ink focus:outline-none focus:border-accent/40" />
              <button onClick={doFetch} disabled={fetching}
                className="px-2 py-1 text-[10px] border border-accent text-accent rounded disabled:opacity-50 shrink-0">
                {fetching ? '拉取中…' : '拉取最新'}
              </button>
            </div>
            {fetchNote && <div className="text-[10px] text-ink-faint font-body mt-1">{fetchNote}</div>}
          </div>
          {/* 1M context toggle — appends [1m] to the active model id.
              Claude Code 通用约定:Anthropic / MiMo 等兼容 provider 都用 [1m] 启用 1M。 */}
          <button onClick={toggle1m}
            className="w-full text-left px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 border-b border-canvas-deep">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-ink font-body">1M 上下文</div>
              <div className="text-[10px] text-ink-faint font-body leading-snug">
                给当前模型追加 <code className="font-mono">[1m]</code> 后缀（1M tokens 上下文，需 provider 支持）
              </div>
            </div>
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono shrink-0 ${
              has1m ? 'bg-accent text-white' : 'bg-canvas-deep text-ink-faint'}`}>
              {has1m ? '已开启' : '关闭'}
            </span>
          </button>
          {availableModels.filter((m) => match(m.id, m.name)).map((m) => {
            const isAlias = m.source === 'cli-alias';
            return (
              <button key={m.id} onClick={() => selectModel(m.id)}
                className={`w-full text-left px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 ${
                  (currentModel === m.id || currentModel === `${m.id}[1m]`) ? 'bg-accent-subtle/50' : ''}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-ink font-body flex items-center gap-1.5">
                    {m.name}
                    {isAlias && (
                      <span className="text-[8.5px] px-1 py-px bg-amber-50 text-amber-700 rounded font-mono"
                        title="CLI 解析的简称，实际模型由 CLI 决定">
                        alias
                      </span>
                    )}
                    {m.context1m && (
                      <span className="text-[8.5px] px-1 py-px bg-accent text-white rounded font-mono"
                        title="1M tokens 上下文">
                        1M
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-ink-faint font-mono truncate">
                    {isAlias ? '由 CLI 解析到当前 tier 最新' : m.id}
                  </div>
                </div>
                <span className="text-[9px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{m.tier}</span>
                {(currentModel === m.id || currentModel === `${m.id}[1m]`) && <Check size={12} className="text-accent shrink-0" />}
              </button>
            );
          })}
          {customRows.filter((m) => match(m.id, m.name)).map((m) => (
            <div key={m.id}
              className={`w-full px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 ${
                (currentModel === m.id || currentModel === `${m.id}[1m]`) ? 'bg-accent-subtle/50' : ''}`}>
              <button onClick={() => selectModel(m.id)} className="flex-1 min-w-0 text-left">
                <div className="text-xs font-medium text-ink font-body flex items-center gap-1.5">
                  {m.name}
                  <span className="text-[8.5px] px-1 py-px bg-accent-subtle text-accent rounded font-mono">自定义</span>
                  {m.context1m && <span className="text-[8.5px] px-1 py-px bg-accent text-white rounded font-mono">1M</span>}
                </div>
                <div className="text-[10px] text-ink-faint font-mono truncate">{m.id}</div>
              </button>
              {(currentModel === m.id || currentModel === `${m.id}[1m]`) && <Check size={12} className="text-accent shrink-0" />}
              <button onClick={() => useStore.getState().removeCustomModel(m.id)} title="移除自定义模型"
                className="p-1 text-ink-faint hover:text-error shrink-0"><X size={12} /></button>
            </div>
          ))}
          {fetchedRows.map((m) => (
            <button key={`f-${m.id}`} onClick={() => selectModel(m.id)}
              className={`w-full text-left px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 ${
                (currentModel === m.id || currentModel === `${m.id}[1m]`) ? 'bg-accent-subtle/50' : ''}`}>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-ink font-body truncate">{m.name}</div>
                <div className="text-[10px] text-ink-faint font-mono truncate">实时拉取</div>
              </div>
              {(currentModel === m.id || currentModel === `${m.id}[1m]`) && <Check size={12} className="text-accent shrink-0" />}
            </button>
          ))}
          <div className="border-t border-canvas-deep mt-1 pt-1 px-3 pb-2">
            <div className="text-[10px] text-ink-faint mb-1 font-body">自定义模型 ID</div>
            <div className="flex gap-1.5">
              <input type="text" value={customInput} onChange={e => setCustomInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCustomSubmit()}
                placeholder="输入模型 ID..."
                className="flex-1 bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-xs font-mono text-ink focus:outline-none focus:border-accent/40" />
              <button onClick={handleCustomSubmit} disabled={!customInput.trim()}
                className="px-2 py-1 text-[10px] bg-accent text-white rounded hover:bg-accent-hover disabled:bg-canvas-deep disabled:text-ink-ghost transition-colors">
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
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
      setError('密码错误');
    } catch { setError('网络错误'); }
    finally { setBusy(false); }
  };
  return (
    <div className="h-[100dvh] w-screen flex items-center justify-center bg-canvas px-6">
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
          className="w-full py-3 rounded-xl bg-accent text-white font-body font-medium text-[15px] disabled:opacity-50 transition-opacity"
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
function MobileMenuRow({ icon: Icon, label, value, onClick, danger = false, chevron = true }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas-warm active:bg-canvas-deep/30 transition-colors">
      {Icon && <Icon size={18} strokeWidth={1.75} className={danger ? 'text-error' : 'text-ink-muted'} />}
      <span className={`flex-1 text-[14px] font-body truncate ${danger ? 'text-error' : 'text-ink'}`}>{label}</span>
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
            o.active ? 'bg-accent text-white shadow-sm' : 'text-ink-muted hover:text-ink'}`}>
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
  // mounted on phones, so populate the global default + available list here.
  useEffect(() => {
    fetch('/api/model').then((r) => r.json()).then((d) => {
      if (d.model) useStore.setState({ currentModel: d.model });
      if (d.available) useStore.setState({ availableModels: d.available });
      try {
        if (!localStorage.getItem('cgui-effort') && d.defaultEffort) useStore.setState({ effort: d.defaultEffort });
      } catch {}
    }).catch(() => {});
  }, []);
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
        {fetchNote && <div className="text-[11px] text-ink-faint font-body">{fetchNote}</div>}
      </div>
      <button onClick={toggle1m}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas-warm transition-colors border-b border-canvas-deep/40">
        <span className="flex-1 text-[14px] font-body text-ink">1M 上下文</span>
        <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${has1m ? 'bg-accent text-white' : 'bg-canvas-deep text-ink-faint'}`}>
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
            <span className="text-[10px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{m.tier}</span>
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
      <div className="px-4 py-3 border-t border-canvas-deep/40 mt-1">
        <div className="text-[11px] text-ink-faint mb-1.5 font-body">自定义模型 ID</div>
        <div className="flex gap-2">
          <input value={customInput} onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { const v = customInput.trim(); if (v) { addCustom(v); setCustomInput(''); } } }}
            placeholder="输入模型 ID…"
            className="flex-1 bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2 text-[13px] font-mono text-ink focus:outline-none focus:border-accent" />
          <button onClick={() => { const v = customInput.trim(); if (v) { addCustom(v); setCustomInput(''); } }}
            disabled={!customInput.trim()}
            className="px-3 py-2 text-[12px] bg-accent text-white rounded-lg disabled:bg-canvas-deep disabled:text-ink-ghost">应用</button>
        </div>
      </div>
    </div>
  );
}

function MobileEffortPage({ permKey }) {
  const effort = useStore((s) => (permKey && permKey in (s.effortBySession || {})) ? s.effortBySession[permKey] : s.effort);
  return (
    <div className="py-1">
      <div className="px-4 pt-2 pb-1 text-[11px] text-ink-faint font-body">作用于当前会话(每个会话独立记忆、互不影响)</div>
      {EFFORT_LEVELS.map((e) => (
        <button key={e.id || 'default'} onClick={() => useStore.getState().setEffortFor(permKey, e.id)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas-warm transition-colors">
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-body text-ink">{e.label}</div>
            <div className="text-[11px] text-ink-faint font-body">{e.desc}</div>
          </div>
          {effort === e.id && <Check size={16} className="text-accent shrink-0" />}
        </button>
      ))}
    </div>
  );
}

function MobilePermissionPage({ permKey }) {
  const permissionMode = useStore((s) => (permKey ? (s.permissionModeBySession[permKey] || s.permissionMode) : s.permissionMode));
  return (
    <div className="py-1">
      {PERMISSION_MODES.map((m) => {
        const meta = MODE_META[m];
        const MIcon = meta.icon;
        return (
          <button key={m} onClick={() => useStore.getState().setPermissionMode(m, permKey)}
            className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-canvas-warm transition-colors">
            <MIcon size={16} className={`${meta.tone} mt-0.5 shrink-0`} />
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-body text-ink">{meta.label}</div>
              <div className="text-[11px] text-ink-faint font-body">{meta.desc}</div>
            </div>
            {permissionMode === m && <Check size={16} className="text-accent shrink-0 mt-0.5" />}
          </button>
        );
      })}
    </div>
  );
}

// B 方案: 对【任意】provider(含 cc-switch 只读 / openai marker 组)设「默认模型 +
// 档位映射(haiku/sonnet/opus)」。options 来自该 provider 的 models[];不暴露 baseURL/key。
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
  });
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const save = async () => {
    setBusy(true); setSaveMsg('');
    try {
      const tierModels = {};
      for (const t of ['haiku', 'sonnet', 'opus']) if (tier[t]) tierModels[t] = tier[t];
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
          </div>
          <button onClick={save} disabled={busy}
            className="w-full px-3 py-1.5 text-[12px] bg-accent text-white rounded-lg disabled:opacity-50">
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
            className="w-full px-3 py-1.5 text-[12px] bg-accent text-white rounded-lg disabled:opacity-50">
            {busy === 'save' ? '保存中…' : `保存所选(${checked.size})`}
          </button>
        </div>
      )}
    </div>
  );
}

// Shared add-custom-provider form. Both protocols; can live-fetch the upstream's
// model catalogue via /v1/models. onSaved() refreshes the parent's list.
function CustomProviderForm({ onSaved, editing, onCancel, onDirtyChange }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('openai');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [testResult, setTestResult] = useState(null); // BZ-1:{ ok, error } | null
  const [defaultModel, setDefaultModel] = useState('');  // AZ8:该 provider 默认模型(空=用列表第一个)
  // BB6:档位映射 —— 子代理/标题/compact 用的 haiku/sonnet/opus alias 各自映射到该
  // provider 的真实模型(空=回退默认模型/选中模型,即维持 BA1 行为)。
  const [tierModels, setTierModels] = useState({ haiku: '', sonnet: '', opus: '' });
  const [busy, setBusy] = useState('');
  const isEdit = !!editing;
  // Entering edit mode: pre-fill from the chosen provider. The apiKey is NEVER
  // sent to the client (only `hasKey`), so leave it blank — blank means "keep".
  useEffect(() => {
    if (!editing) return;
    setName(editing.name || '');
    setType(editing.type || 'openai');
    setBaseURL(editing.baseURL || '');
    setApiKey('');
    setModelsText((editing.models || []).join('\n'));
    setDefaultModel(editing.defaultModel || '');
    setTierModels({ haiku: editing.tierModels?.haiku || '', sonnet: editing.tierModels?.sonnet || '', opus: editing.tierModels?.opus || '' });
    setTestResult(null); // 切到另一个 provider 编辑时清掉上一个的测试结果横幅(否则误导)
    setBusy('');
    setOpen(true);
  }, [editing?.id]);
  const reset = () => { setName(''); setType('openai'); setBaseURL(''); setApiKey(''); setModelsText(''); setDefaultModel(''); setTierModels({ haiku: '', sonnet: '', opus: '' }); setTestResult(null); setOpen(false); };
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
        body: JSON.stringify({ type, baseURL, apiKey }),
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
        `未设置默认模型。新会话及未指定模型的调用将使用列表第一个:${parsedModels[0]}。\n建议在下方设置默认模型,以及 haiku / sonnet / opus 三档对应的模型 id。\n\n仍以「${parsedModels[0]}」作默认保存?`,
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
      };
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
      if (!isEdit && d.id) {
        const sr = await fetch('/api/provider/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: d.id }),
        });
        const sd = await sr.json().catch(() => ({}));
        if (!sr.ok) throw new Error(sd.error || 'Provider 已保存,但自动切换失败');
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
        className="w-full flex items-center gap-2 px-4 py-3 text-left text-accent hover:bg-canvas-warm transition-colors border-t border-canvas-deep/40 mt-1">
        <Plus size={16} /><span className="text-[14px] font-body">添加 Provider</span>
      </button>
    );
  }
  return (
    <div className="px-4 py-3 border-t border-canvas-deep/40 mt-1 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-display font-semibold text-ink">{isEdit ? '编辑 Provider' : '新增 Provider'}<span className="text-[10px] font-body font-normal text-ink-faint ml-1">保存到本机</span></span>
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
              // 重置 select 自身,让用户能再次选(value 受控就不会卡)
              e.target.value = '';
            }}
            className={`${inputCls} flex-1 cursor-pointer`}
            title="选择一个内置 provider,自动填好 baseURL/默认模型;仍需自填 API key"
          >
            <option value="">— 选模板自动填充 —</option>
            <optgroup label="OpenAI 兼容">
              {BUILTIN_PROVIDERS.filter((p) => p.type === 'openai').map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>
            <optgroup label="Anthropic 兼容">
              {BUILTIN_PROVIDERS.filter((p) => p.type === 'anthropic').map((p) => (
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
      {/* BB6:档位映射 —— 子代理/标题/compact 走 haiku/sonnet/opus 别名,分别映射到该
          provider 的真实模型(简单任务用便宜的、难的用强的)。留空 = 回退默认模型/选中模型。
          要生效:agent .md 写别名(model: haiku)而非具体 id(具体 id 优先级更高,绕过映射)。 */}
      <div className="space-y-1.5 pt-0.5">
        <div className="text-[11px] text-ink-faint">档位映射 <span className="text-ink-faint/70">子代理/标题/compact 走便宜档,主对话走强档;留空 = 用默认模型</span></div>
        {[['haiku', 'Haiku 档(子代理/标题/便宜)'], ['sonnet', 'Sonnet 档(常规)'], ['opus', 'Opus 档(最强)']].map(([tier, label]) => (
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
          className="flex-1 px-3 py-2 text-[12px] bg-accent text-white rounded-lg disabled:opacity-50">
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

function MobileProviderPage() {
  const [providers, setProviders] = useState([]);
  const [openaiProviders, setOpenaiProviders] = useState([]);
  const [customProviders, setCustomProviders] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [switching, setSwitching] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const load = () => {
    fetch('/api/providers').then((r) => r.json()).then((d) => {
      setProviders(Array.isArray(d.providers) ? d.providers : []);
      setOpenaiProviders(Array.isArray(d.openaiProviders) ? d.openaiProviders : []);
      setCustomProviders(Array.isArray(d.customProviders) ? d.customProviders : []);
      setOverrides(d.overrides && typeof d.overrides === 'object' ? d.overrides : {});
    }).catch(() => {});
  };
  useEffect(load, []);
  const isCur = (p) => (activeId != null ? p.id === activeId : p.isCurrent);
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
      window.dispatchEvent(new CustomEvent('cgui:provider-change'));
    } catch (e) { confirmDialog('切换 provider 失败：' + e.message); }
    setSwitching(false);
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
  return (
    <div className="py-1">
      {providers.map((p) => (
        <div key={p.id} className={`${isCur(p) ? 'bg-accent-subtle' : ''}`}>
          <div className="w-full flex items-center gap-1 pr-3 hover:bg-canvas-warm transition-colors">
            <button disabled={switching} onClick={() => switchTo(p.id)}
              className={`flex-1 min-w-0 flex items-center gap-3 px-4 py-3 text-left ${switching ? 'opacity-50' : ''}`}>
              <span className={`flex-1 text-[14px] font-body truncate ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
              {isCur(p) && <Check size={16} className="text-accent shrink-0" />}
            </button>
          </div>
          {p.category !== 'official' && (
            <div className="px-4 pb-2"><ProviderOverrideEditor provider={p} override={overrides[p.id]} onSaved={load} /></div>
          )}
        </div>
      ))}
      {openaiProviders.length > 0 && (
        <div className="px-4 pt-3 pb-1 text-[11px] text-ink-faint uppercase tracking-wider font-body border-t border-canvas-deep/40 mt-1">OpenAI 格式 · 经内置代理</div>
      )}
      {openaiProviders.map((p) => (
        <div key={p.id} className="px-4 py-2.5">
          <div className={`text-[14px] font-body mb-1.5 flex items-center gap-2 ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>
            <span className="flex-1 truncate">{p.name}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(p.models.length ? p.models : ['(默认)']).map((m) => (
              <button key={m} disabled={switching} onClick={() => switchTo(p.id, p.models.length ? m : undefined)}
                className="text-[11px] font-mono px-2 py-1 rounded-lg border border-canvas-deep text-ink-soft hover:border-accent hover:text-accent">{m}</button>
            ))}
          </div>
          <OpenAIModelManager provider={p} onSaved={load} />
          <ProviderOverrideEditor provider={p} override={overrides[p.id]} onSaved={load} />
        </div>
      ))}
      {customProviders.length > 0 && (
        <div className="px-4 pt-3 pb-1 text-[11px] text-ink-faint uppercase tracking-wider font-body border-t border-canvas-deep/40 mt-1">自定义</div>
      )}
      {customProviders.map((p) => (
        <div key={p.id} className="px-4 py-2.5 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className={`text-[14px] font-body mb-1 flex items-center gap-1.5 ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>
              <span className="truncate">{p.name}</span>
              <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.type}</span>
              {isCur(p) && <Check size={14} className="text-accent shrink-0" />}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(p.models.length ? p.models : ['(默认)']).map((m) => (
                <button key={m} disabled={switching} onClick={() => switchTo(p.id, p.models.length ? m : undefined)}
                  className="text-[11px] font-mono px-2 py-1 rounded-lg border border-canvas-deep text-ink-soft hover:border-accent hover:text-accent">{m}</button>
              ))}
            </div>
          </div>
          <button onClick={() => setEditingProvider(p)} title="编辑" className="p-1.5 text-ink-faint hover:text-accent shrink-0"><Pencil size={15} /></button>
          <button onClick={() => removeCustom(p.id, p.name)} title="删除" className="p-1.5 text-ink-faint hover:text-error shrink-0"><Trash2 size={15} /></button>
        </div>
      ))}
      <CustomProviderForm
        editing={editingProvider}
        onCancel={() => setEditingProvider(null)}
        onSaved={() => { setEditingProvider(null); load(); }}
      />
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
  const famName = THEME_FAMILIES.find((f) => f.id === themeFamily)?.name || themeFamily;
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
    </div>
  );
}

function MobileThemePage() {
  const themeFamily = useStore((s) => s.themeFamily);
  const themeTone = useStore((s) => s.themeTone);
  const setTheme = useStore((s) => s.setTheme);
  const effDark = themeTone === 'auto' ? systemPrefersDark() : themeTone === 'dark';
  const toneKey = effDark ? 'dark' : 'light';
  return (
    <div className="grid grid-cols-2 gap-2 p-3">
      {THEME_FAMILIES.map((fam) => {
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
  const readingFont = useStore((s) => s.readingFont);
  const setReadingFont = useStore((s) => s.setReadingFont);
  return (
    <div className="py-1">
      {FONT_OPTIONS.map((f) => (
        <button key={f.id} onClick={() => setReadingFont(f.id)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas-warm transition-colors">
          <span className="flex-1 text-[15px] text-ink">{f.name}</span>
          {readingFont === f.id && <Check size={16} className="text-accent shrink-0" />}
        </button>
      ))}
    </div>
  );
}

function MobileMenu({ setRightPanel, onClose }) {
  const [stack, setStack] = useState(['root']);
  const page = stack[stack.length - 1];
  const push = (p) => setStack((s) => [...s, p]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const paneSessions = useStore((s) => s.paneSessions);
  const selectedSession = useStore((s) => s.selectedSession);
  const selectedProject = useStore((s) => s.selectedProject);
  const activeSession = (paneSessions && paneSessions[activeTabIndex]) || selectedSession;
  const permKey = activeSession?.sessionId || `draft-${activeSession?.projectHash || 'none'}`;

  const currentModel = useStore((s) => s.modelBySession[permKey] || s.currentModel);
  const effort = useStore((s) => (permKey && permKey in (s.effortBySession || {})) ? s.effortBySession[permKey] : s.effort);
  const permissionMode = useStore((s) => s.permissionModeBySession[permKey] || 'default');
  // --effort works on every claude-format upstream (official + mimo/deepseek/
  // openrouter relays); only the OpenAI proxy (codex-local) can't map it. Gate
  // on protocol, not providerHint.
  const claudeProtocol = useStore((s) => (s.currentProvider?.protocol || 'anthropic') !== 'openai');
  const effortLabel = (EFFORT_LEVELS.find((e) => e.id === effort) || EFFORT_LEVELS[0]).label;
  const permLabel = (MODE_META[permissionMode] || MODE_META.default).label;

  // New chat: prefer the selected project; fall back to the open session's
  // project so ✎ isn't a dead no-op. With no project at all, drop into the
  // history page so the user can pick one (the old code silently did nothing).
  const startNew = () => {
    const st = useStore.getState();
    const sel = st.selectedSession;
    const proj = st.selectedProject || (sel?.projectHash ? { hash: sel.projectHash, path: sel.projectPath } : null);
    if (!proj) { push('history'); return; }
    st.setSelectedSession({ draft: true, sessionId: null, projectHash: proj.hash, projectPath: proj.path, firstPrompt: '新会话' });
    useStore.setState({ messages: [] });
    st.setPaneMessages(0, []);
    onClose();
  };
  const openPanel = (id) => { setRightPanel(id); onClose(); };

  const TITLES = { history: '会话与项目', model: '模型', effort: '推理力度', permission: '权限模式', provider: 'Provider', appearance: '外观', theme: '配色方案', readingfont: '对话正文字体' };

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
              <MobileMenuRow icon={Cpu} label="模型" value={<ModelBadge model={currentModel} compact />} onClick={() => push('model')} />
              {claudeProtocol && <MobileMenuRow icon={Gauge} label="推理力度" value={effortLabel} onClick={() => push('effort')} />}
              <MobileMenuRow icon={Shield} label="权限模式" value={permLabel} onClick={() => push('permission')} />
              <MobileMenuRow icon={Server} label="Provider" onClick={() => push('provider')} />
              {activeSession?.sessionId && (
                <div className="px-4 py-2"><RemoteControlButton session={activeSession} /></div>
              )}
              <div className="px-4 pt-3 pb-1 text-[11px] text-ink-faint uppercase tracking-wider font-body">外观</div>
              <MobileMenuRow icon={Palette} label="主题与字体" onClick={() => push('appearance')} />
              <div className="px-4 pt-3 pb-1 text-[11px] text-ink-faint uppercase tracking-wider font-body">工具</div>
              {Object.entries(PANEL_MAP).filter(([id]) => id !== 'settings').map(([id, { icon: Icon, label }]) => (
                <MobileMenuRow key={id} icon={Icon} label={label} chevron={false} onClick={() => openPanel(id)} />
              ))}
              <div className="px-4 pt-3 pb-1 text-[11px] text-ink-faint uppercase tracking-wider font-body">系统</div>
              <MobileMenuRow icon={Settings} label="设置（网络 / 密码 / 端口 / 存储）" chevron={false} onClick={() => openPanel('settings')} />
              <div className="h-8" />
            </div>
          )}
          {page === 'model' && <MobileModelPage permKey={permKey} />}
          {page === 'effort' && <MobileEffortPage permKey={permKey} />}
          {page === 'permission' && <MobilePermissionPage permKey={permKey} />}
          {page === 'provider' && <MobileProviderPage />}
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

// ─── Main App ──────────────────────────────────────────────────
export default function App() {
  useWebSocket();
  const { sidebarCollapsed, toggleSidebar, selectedProject, selectedSession } = useStore();
  const [rightPanel, setRightPanel] = useState(null);
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
        st.setPaneSession(idx, { draft: true, sessionId: null, projectHash: proj.hash, projectPath: proj.path, firstPrompt: '新会话' });
        st.setPaneMessages(idx, []);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      try { const d = await (await fetch('/api/version-check')).json(); if (d.hasUpdate) n.gui = d.latestVersion; } catch {}
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
  useEffect(() => { useStore.getState().hydrateCustomTitles(); useStore.getState().hydrateAutoTitles(); }, []);

  // Optional local-only widgets (client/src/components/*.local.jsx). Fresh
  // checkouts have none; public builds temporarily move them out of the build
  // graph so personal controls do not enter client/dist or Tauri bundles.
  const [LocalWidget, setLocalWidget] = useState(null);
  useEffect(() => {
    const mods = import.meta.glob('./components/*.local.jsx');
    const entry = Object.values(mods)[0];
    if (entry) entry().then((m) => setLocalWidget(() => m.default)).catch(() => {});
  }, []);

  // 全局轮询正在运行的 chat-process → store,驱动侧栏状态符号(ProjectList /
  // SessionItem)。与按会话的 backgroundPid 轮询相互独立。
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch('/api/agents/active');
        const d = await r.json();
        if (cancelled) return;
        const running = (d.agents || []).filter((a) => a.kind === 'chat-process' && a.stoppable === true);
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
  const customTitles = useStore((s) => s.customTitles);
  // U6:顶栏"项目/会话标题"也要跟随 AI 自动标题(custom > auto > firstPrompt),
  // 之前只读 customTitles → 自动标题生成后顶栏仍显示首条消息。
  const autoTitles = useStore((s) => s.autoTitles);
  const activeSession = (paneSessions && paneSessions[activeTabIndex]) || selectedSession;
  const permKey = activeSession?.sessionId || `draft-${activeSession?.projectHash || 'none'}`;

  // 分屏焦点切换 / focus pane 的 session 变化时,让左侧 selectedProject 自动跟到
  // 对应项目,顺便 silent-refresh 该项目的 sessions 列表 — 这样用户切焦点时
  // 左侧能直接看到当前 pane 在用的会话(并被高亮),不用手动回项目列表找。
  const activeProjectHash = activeSession?.projectHash;
  useEffect(() => {
    if (!activeProjectHash) return;
    const st = useStore.getState();
    if (st.selectedProject?.hash === activeProjectHash) return;
    const proj = (st.projects || []).find((p) => p.hash === activeProjectHash);
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
      draft: true, sessionId: null, projectHash: proj.hash,
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

  // Mid-stream mode change → bulk-resolve waiting popups, but ONLY for the
  // session that was switched to 放任. "切到放任后该会话待处理工具直接放行"。
  // Must NOT touch other sessions' pending requests (that was the 授权串号 bug).
  const permissionMode = useStore((s) => s.permissionModeBySession[permKey] || 'default');
  useEffect(() => {
    if (permissionMode !== 'bypassPermissions') return;
    const sid = activeSession?.sessionId;
    if (!sid) return;
    const pending = useStore.getState().pendingPermissions;
    // AskUserQuestion 例外:切到放任也要保留它的 picker,不能批量放行
    // (放行=CLI headless 跑不了该工具=AI 退化文本提问)。
    pending.filter((p) => p.sessionId === sid && p.toolName !== 'AskUserQuestion').forEach((p) => {
      fetch(`/api/permissions/respond/${p.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' }),
      }).catch(() => {});
      useStore.getState().removePendingPermission(p.id);
    });
  }, [permissionMode, activeSession?.sessionId]);

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
    const onProvCh = () => useStore.getState().fetchProvider();
    window.addEventListener('cgui:provider-change', onProvCh);
    // Warm the MCP cache so the first click on the MCP panel is instant
    // (claude mcp list cold spawn is ~2s).
    fetch('/api/mcp').catch(() => {});
    return () => window.removeEventListener('cgui:provider-change', onProvCh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // All hooks above; safe to short-circuit to the login gate here.
  if (authLocked) return <LoginScreen onSuccess={() => window.location.reload()} />;

  if (isMobile) {
    // CSS zoom scales fixed-size UI too. Keep the mobile root's layout box
    // divided by the zoom factor so "超大" text does not push the app outside
    // the physical viewport. `--kb` still lifts it above the soft keyboard.
    return (
      <div
        className="cgui-mobile-root flex flex-col overflow-hidden"
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
        <MobileTopBar onMenu={toggleSidebar} onNew={startMobileNewChat} title={mobileTitle} />
        <MainLayout
          sidebarCollapsed={sidebarCollapsed}
          selectedProject={selectedProject}
          rightPanel={rightPanel}
          setRightPanel={setRightPanel}
          isMobile={isMobile}
        />
        {LocalWidget && <LocalWidget />}
        {!cliInstalled && !cliCheckDismissed && (
          <EnvCheckPanel onRecheck={checkCli} onDismiss={dismissCliCheck} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden" style={{ width: 'var(--app-w, 100vw)', height: 'var(--app-h, 100dvh)' }}>
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
          {selectedSession && (
            <>
              <span className="text-ink-ghost shrink-0">/</span>
              <span className="text-[11px] text-ink-muted font-body truncate min-w-0 max-w-[180px]">
                {customTitles[selectedSession.sessionId] || autoTitles[selectedSession.sessionId] || selectedSession.firstPrompt?.slice(0, 36) || selectedSession.sessionId?.slice(0, 8) || '新会话'}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap justify-end min-w-0 ml-auto">
          <span data-tour="provider-switcher" className="inline-flex"><ProviderSwitcher /></span>
          <span data-tour="model-selector" className="inline-flex"><ModelSelector placement="bottom" align="right" compact permKey={permKey} /></span>
          <span data-tour="effort-selector" className="inline-flex"><EffortSelector placement="bottom" align="right" permKey={permKey} /></span>
          <span data-tour="permission-selector" className="inline-flex"><PermissionModeSelector permKey={permKey} /></span>
          <span data-tour="agent-selector" className="inline-flex"><AgentModeSelector permKey={permKey} sessionStarted={!!activeSession?.sessionId} /></span>
          <span data-tour="remote-control" className="inline-flex"><RemoteControlButton session={activeSession} /></span>
          <div className="w-px h-4 bg-ink-ghost/30 mx-1" />
          {/* Split-screen toggle. Activates the right pane (initially empty
              until user clicks a session in the sidebar). Click again to
              collapse back to a single SessionDetail. */}
          <span data-tour="pane-count" className="inline-flex"><PaneCountPicker /></span>
          {Object.entries(PANEL_MAP).map(([id, { icon: Icon, label }]) => {
            // Short chip label (always visible under the icon). Long `label`
            // stays as the hover tooltip for the full name.
            const SHORT = {
              files: '文件', monitor: '监控', agents: 'Agent', usage: '用量', processes: '进程',
              changes: '审查', mcp: '工具', skills: '技能', memory: '指令', settings: '设置',
            };
            const short = SHORT[id] || label;
            return (
              <button key={id} data-tour={`panel-${id}`} onClick={() => setRightPanel(rightPanel === id ? null : id)}
                className={`px-1.5 py-1 rounded-lg transition-all flex flex-col items-center gap-0.5 ${rightPanel === id ? 'bg-accent-subtle text-accent' : 'text-ink-muted hover:text-ink hover:bg-black/5'}`}
                title={label}>
                <Icon size={15} />
                <span className="text-[9px] leading-none font-body">{short}</span>
              </button>
            );
          })}
          {/* CJ-2:有可用更新时常驻提醒按钮(没在弹窗里点更新也长期显示);点击跳设置→更新区。 */}
          {updateNotice && (
            <button
              onClick={() => jumpToUpdate(updateNotice.gui ? 'gui-update' : 'cc-update')}
              title={`有可用更新${updateNotice.gui ? ` · GUI v${updateNotice.gui}` : ''}${updateNotice.cc ? ` · Claude Code v${updateNotice.cc}` : ''} — 点击前往更新`}
              className="flex items-center gap-1 px-1.5 py-1 rounded-lg text-red-500 hover:bg-red-500/10 transition-colors animate-pulse">
              <RefreshCw size={15} />
              <span className="text-[11px] leading-none font-body">更新</span>
            </button>
          )}
          <button onClick={() => setTourOpen(true)} title="使用指引 — 逐个介绍界面功能"
            className="flex items-center justify-center p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 transition-colors">
            <HelpCircle size={15} />
          </button>
          <div className="w-px h-4 bg-ink-ghost/30 mx-1" />
          <ThemeToggle />
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
      {LocalWidget && <LocalWidget />}
      <GuideTour open={tourOpen} onClose={() => setTourOpen(false)} hasProject={!!selectedProject} />
      {bundleMismatch && (
        <div className="fixed top-0 inset-x-0 z-[300] bg-red-600 text-white text-[12px] font-body px-4 py-2 flex items-center justify-center gap-3 shadow-lg">
          <span>⚠️ 界面 v{bundleMismatch.bundle} 与服务端 v{bundleMismatch.server} 不一致。请依次尝试：① 完全退出 GUI 再打开（会自动换用新版服务并绕过缓存）② 仍出现则说明安装包内是旧前端，请重新下载安装</span>
          <button
            onClick={() => { sessionStorage.removeItem('cgui-ver-busted'); window.location.replace('/?r=' + bundleMismatch.server); }}
            className="px-2 py-0.5 rounded bg-white text-red-600 font-medium hover:bg-white/90 transition-colors shrink-0">重试</button>
          <button onClick={() => setBundleMismatch(null)} className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 transition-colors shrink-0">知道了</button>
        </div>
      )}
      <CompletionToasts />
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
                className="px-3 py-1.5 text-[12px] text-white bg-accent hover:bg-accent/90 rounded-md transition-colors">前往更新</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
