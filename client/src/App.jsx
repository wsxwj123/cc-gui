import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';

// Stable empty array reference for zustand selectors — prevents React error
// #185 (Maximum update depth exceeded) caused by returning fresh `[]` on
// every selector call. Any selector with `|| []` fallback must point here.
const EMPTY_ARRAY = Object.freeze([]);
import { useStore, THEME_FAMILIES, FONT_OPTIONS, systemPrefersDark, PERMISSION_MODES } from './stores/sessionStore.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { MessageBubble } from './components/MessageBubble.jsx';
import { TurnBubble } from './components/TurnBubble.jsx';
import { ChatInput, EffortSelector, PermissionModeSelector, EFFORT_LEVELS, MODE_META } from './components/ChatInput.jsx';
import { ModelBadge, ProviderAvatar } from './components/ModelBadge.jsx';
import { UsagePanel } from './components/UsagePanel.jsx';
import { ProcessPanel } from './components/ProcessPanel.jsx';
import { SettingsPanel } from './components/SettingsPanel.jsx';
import { FileExplorerPanel } from './components/FileExplorerPanel.jsx';
import { useResizable as useResizableHook, Splitter as SplitterCmp } from './hooks/useResizable.jsx';
import { MCPPanel } from './components/MCPPanel.jsx';
import { FileChangesPanel } from './components/FileChangesPanel.jsx';
import { AgentsPanel } from './components/AgentsPanel.jsx';
import { AgentMonitorPanel } from './components/AgentMonitorPanel.jsx';
import { computeCost, formatCost } from './utils/pricing.js';
import {
  FolderOpen, MessageSquare, ChevronLeft, ChevronRight, ChevronDown,
  Search, Hash, Layers, BarChart3, ArrowLeft, Plus,
  RefreshCw, Activity, Settings, Server, GitBranch, FileDiff, Check, Wrench, X,
  Sun, Moon, Monitor, Bot, Camera, History, Loader2, Shield, FolderTree,
  Archive, ArchiveRestore, Trash2, EyeOff, Columns2, Smartphone, Pencil, Type, Palette,
  Menu, SquarePen, Gauge, Cpu,
} from 'lucide-react';

// ── Per-session shadow-git checkpoints ──────────────────────────
// Session title with inline rename (click pencil → edit → Enter/blur saves,
// Esc cancels). Empty value reverts to the auto firstPrompt. Drafts (no stable
// sessionId yet) can't be renamed — the pencil is hidden until the first send.
function EditableSessionTitle({ session }) {
  const customTitles = useStore((s) => s.customTitles);
  const setCustomTitle = useStore((s) => s.setCustomTitle);
  const sid = session?.sessionId;
  const auto = session?.firstPrompt?.slice(0, 80) || '会话详情';
  const display = (sid && customTitles[sid]) || auto;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const start = () => {
    if (!sid) return;
    setDraft((customTitles[sid] || session.firstPrompt || '').slice(0, 200));
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

function CheckpointButton({ sessionId, cwd }) {
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
    } catch (err) { alert('快照失败：' + err.message); }
    setBusy(false);
  };

  const restore = async (sha) => {
    if (!confirm(`恢复 cwd 到该 checkpoint？\n${sha.slice(0, 7)}\n会覆盖未提交的修改。`)) return;
    try {
      const r = await fetch(`/api/checkpoints/${sessionId}/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha, cwd }),
      });
      const d = await r.json();
      if (!r.ok) alert('恢复失败：' + (d.error || r.status));
    } catch (err) { alert('恢复失败：' + err.message); }
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
      const W = 288; // w-72
      let left = r.right - W;
      left = Math.max(8, Math.min(left, window.innerWidth - 8 - W));
      setPos({ top: r.bottom + 8, left });
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
          <div className="glass-popover fixed w-72 z-[56] py-1 animate-glass-rise"
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
                <button key={e.sha} onClick={() => restore(e.sha)}
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
        className="px-1.5 py-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 transition-colors flex flex-col items-center gap-0.5"
        title="主题与外观">
        <ToneIcon size={15} />
        <span className="text-[9px] leading-none font-body">主题</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-[60] w-[300px] glass-popover rounded-2xl border border-canvas-deep shadow-xl p-3 space-y-3 max-md:fixed max-md:left-3 max-md:right-3 max-md:top-16 max-md:w-auto max-md:mt-0 max-md:max-h-[78dvh] max-md:overflow-y-auto">
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
        </div>
      )}
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
  return path.replace(/^\/Users\/[^/]+/, '~');
}

function formatPathShort(path) {
  if (!path) return '';
  const parts = formatPath(path).split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

// ─── Right Panel (overlay) ────────────────────────────────────
// Top-right panels. AgentsPanel (定义编辑器) is now reachable from inside
// AgentMonitorPanel — no longer needs its own header icon.
const PANEL_MAP = {
  files: { label: '文件浏览器', icon: FolderTree, component: FileExplorerPanel },
  monitor: { label: 'Subagent 监控', icon: Bot, component: AgentMonitorPanel },
  usage: { label: '用量统计', icon: BarChart3, component: UsagePanel },
  processes: { label: '进程管理 / 停止', icon: Activity, component: ProcessPanel },
  mcp: { label: 'MCP 服务器', icon: Server, component: MCPPanel },
  settings: { label: '设置', icon: Settings, component: SettingsPanel },
};

// useResizable + Splitter live in hooks/useResizable.js — kept aliased for
// the in-file callsites below.
const useResizable = useResizableHook;
const Splitter = SplitterCmp;

function _RESIZABLE_DEAD_({ initial, min, max, axis = 'x', storageKey, invert = false }) {
  const [size, setSize] = useState(() => {
    if (storageKey) {
      try {
        const v = parseFloat(localStorage.getItem(storageKey));
        if (Number.isFinite(v)) return Math.max(min, Math.min(max, v));
      } catch {}
    }
    return initial;
  });
  useEffect(() => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, String(size)); } catch {}
  }, [size, storageKey]);
  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    const startCoord = axis === 'x' ? e.clientX : e.clientY;
    const startSize = size;
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startCoord;
      const next = Math.max(min, Math.min(max, startSize + (invert ? -delta : delta)));
      setSize(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [size, axis, min, max, invert]);
  return [size, onMouseDown];
}

// (dead — replaced by import from hooks/useResizable.js)
function _SplitterDead({ onMouseDown, axis = 'x' }) {
  const isVert = axis === 'x';
  return (
    <div
      onMouseDown={onMouseDown}
      className={`shrink-0 ${isVert ? 'w-1 cursor-col-resize hover:w-1.5' : 'h-1 cursor-row-resize hover:h-1.5'} bg-transparent hover:bg-accent/30 transition-all relative z-10`}
      title={isVert ? '拖动调节宽度' : '拖动调节高度'}
    />
  );
}

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
  const splitMode = useStore((s) => s.splitMode);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const setActiveTabIndex = useStore((s) => s.setActiveTabIndex);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

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
      {splitMode ? (
        <SplitMain
          activeTabIndex={activeTabIndex}
          setActiveTabIndex={setActiveTabIndex}
        />
      ) : (
        <main className="flex-1 flex flex-col relative m-3 rounded-2xl overflow-hidden min-w-0" style={{ minWidth: '26em' }}>
          <SessionDetail tabIndex={0} />
        </main>
      )}
      {rightPanel && (
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

  const panes = Array.from({ length: paneCount }, (_, i) => i);
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
              onMouseDown={() => setActiveTabIndex(i)}
              style={{ width: widths[i] ?? 480, flexShrink: 0, flexGrow: 0 }}
              className={`flex flex-col relative my-3 mx-1.5 rounded-2xl overflow-hidden transition-shadow ${
                focused ? 'ring-2 ring-accent/40 shadow-lg' : 'ring-1 ring-canvas-deep/40'
              }`}
            >
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
              {hasSession ? (
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
            {/* Draggable right edge — resizes THIS pane (every pane, last included) */}
            <SplitterCmp onMouseDown={startResize(i)} axis="x" />
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
function ProjectList() {
  const { projects, selectedProject, setSelectedProject, fetchProjects, fetchSessions, searchQuery, setSearchQuery } = useStore();
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

  useEffect(() => { fetchProjects(); }, []);
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
        const ok = window.confirm(`文件夹不存在：\n${data.addedPath}\n\n是否新建该文件夹并作为项目？`);
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
              const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
              if (isLocalHost && !isMobile) {
                try {
                  const r = await fetch('/api/pick-directory', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: '选择项目目录', startDir: lastStart || undefined }),
                  });
                  if (r.ok) {
                    const data = await r.json();
                    if (data.path === null) return;  // user cancelled
                    path = data.path;
                  }
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
        {filtered.map((project) => (
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
                <span className="text-[13px] text-ink-soft truncate font-body font-medium">
                  {formatPathShort(project.path)}
                </span>
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
            <button
              onClick={(e) => { e.stopPropagation(); toggleHidden(project.hash); }}
              className="absolute top-1.5 right-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity p-1 hover:bg-canvas-deep rounded"
              title="从侧栏隐藏（不删除本地文件，下次按 + 重新添加同路径即可恢复）"
            >
              <EyeOff size={12} className="text-ink-faint" />
            </button>
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
function SessionItem({ session, isSelected, onSelect, onFork, onArchive, onDelete, forking }) {
  const [expanded, setExpanded] = useState(false);
  const customTitle = useStore((s) => s.customTitles[session.sessionId]);
  const setCustomTitle = useStore((s) => s.setCustomTitle);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const hasSubagents = session.subagents?.length > 0;
  const isArchived = !!session.archived;
  const isDraft = !!session.draft || !session.sessionId;

  const startRename = (e) => {
    e?.stopPropagation();
    if (isDraft) return;
    setDraft((customTitle || session.firstPrompt || '').slice(0, 200));
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
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink-soft line-clamp-2 font-body leading-snug pr-1">
                {customTitle || session.firstPrompt || '(空会话)'}
              </div>
              {/* Bottom row leaves space on the right for the hover action bar. */}
              <div className="flex items-center gap-2 gap-y-1 flex-wrap mt-1.5 pr-20">
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
      <div className="absolute bottom-1.5 right-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
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
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm('永久删除该会话历史？（jsonl 文件将被删除，无法恢复）')) onDelete(session);
          }}
          className="p-1 hover:bg-red-50 rounded"
          title="删除本地会话历史"
        >
          <Trash2 size={12} className="text-ink-faint hover:text-red-600" />
        </button>
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
  // In split mode, sidebar clicks fill the focused pane (tab 0 or 1).
  // Outside split mode the call collapses to setSelectedSession + tab-0
  // fetch — i.e. identical to the legacy single-pane behavior.
  const splitMode = useStore((s) => s.splitMode);
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const setActiveTabSession = useStore((s) => s.setActiveTabSession);
  const secondarySession = useStore((s) => s.secondarySession);
  const [forking, setForking] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  const visible = sessions.filter((s) => !!s.archived === showArchived);
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
      alert('归档失败：' + err.message);
    }
  };

  const handleDelete = async (session) => {
    try {
      const r = await fetch(
        `/api/sessions/${session.sessionId}?projectHash=${encodeURIComponent(session.projectHash)}`,
        { method: 'DELETE' }
      );
      if (!r.ok) { const e = await r.json().catch(() => ({})); alert('删除失败：' + (e.error || r.status)); return; }
      if (selectedSession?.sessionId === session.sessionId) setSelectedSession(null);
      useStore.getState().fetchSessions(selectedProject.hash, { silent: true });
    } catch (err) {
      alert('删除失败：' + err.message);
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

  const handleNew = () => {
    if (!selectedProject) return;
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
    const draft = {
      draft: true,
      sessionId: null,
      projectHash: selectedProject.hash,
      projectPath: tree.path,
      firstPrompt: `新会话 · ${tree.branch || tree.path.split('/').pop()}`,
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
      if (!r.ok) return alert('创建 worktree 失败：' + d.error);
      enterWorktree({ path: d.path, branch: d.branch });
      setNewWorktreeName('');
    } catch (err) {
      alert('创建 worktree 失败：' + err.message);
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
        alert('分支失败：' + (data.error || res.status));
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
      alert('分支失败：' + err.message);
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
        <div className="flex items-center gap-2 mb-1">
          <button onClick={() => useStore.getState().setSelectedProject(null)} className="p-0.5 hover:bg-canvas-deep rounded transition-colors">
            <ArrowLeft size={14} className="text-ink-faint" />
          </button>
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-ink-faint font-body shrink-0">会话</h2>
          <span className="text-[10px] text-ink-ghost font-mono shrink-0">{sessions.length}</span>
          <button
            onClick={handleNewWorktree}
            className="ml-auto btn-glass flex items-center gap-1 px-2 py-1 text-[11px] font-body text-ink-soft shrink-0 whitespace-nowrap"
            title="在新 git worktree 中开会话（隔离）"
          >
            <GitBranch size={11} />worktree
          </button>
          <button
            onClick={handleNew}
            className="btn-accent flex items-center gap-1 px-2 py-1 text-[11px] font-body shrink-0 whitespace-nowrap"
            title="新建会话"
          >
            <Plus size={11} />新建
          </button>
        </div>
        <p className="text-xs text-ink-muted font-body truncate ml-6">{formatPath(selectedProject?.path)}</p>
        {/* Git status check at project level — fires immediately on project
            selection, doesn't wait for a session to be opened. This was the
            missing piece behind "新建项目文件夹不再自动检测 git 仓库"; the banner
            previously only mounted inside SessionDetail. */}
        <div className="-mx-4 mt-2">
          <GitInitBanner cwd={selectedProject?.path} />
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
        {visible.map((session) => (
          <SessionItem
            key={session.sessionId}
            session={session}
            isSelected={
              selectedSession?.sessionId === session.sessionId
              || (splitMode && secondarySession?.sessionId === session.sessionId)
            }
            onSelect={handleSelect}
            onFork={handleFork}
            onArchive={handleArchive}
            onDelete={handleDelete}
            forking={forking === session.sessionId}
          />
        ))}
        {visible.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-ink-faint font-body">
              {showArchived ? '没有已归档的会话' : '该项目没有活跃会话'}
            </p>
          </div>
        )}
      </div>

      {/* Worktree picker modal */}
      {worktreeOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in"
          onClick={() => setWorktreeOpen(false)}
        >
          <div
            className="glass-popover w-[480px] max-w-[calc(100vw-1.5rem)] max-h-[80vh] flex flex-col py-1 animate-glass-rise"
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
                  <button
                    key={t.path}
                    onClick={() => enterWorktree(t)}
                    className="w-full text-left px-3 py-2 mb-1 rounded-lg hover:bg-canvas-warm border border-canvas-deep transition-colors group"
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
      )}
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
function StreamingStatusLine({ thinking, text, toolCalls }) {
  const verb = useCyclingVerb();
  let label = null;
  // Latest unresolved tool call (no result yet) → "Bash(ls)"
  const pendingTool = [...toolCalls].reverse().find((tc) => !tc.result);
  if (pendingTool) {
    const preview =
      pendingTool.input?.command ||
      pendingTool.input?.file_path?.split('/').pop() ||
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
  return (
    <div className="px-6 pt-3 pb-1 animate-fade-in">
      <div className="max-w-3xl mx-auto flex items-center gap-2.5 text-[14px] text-ink-soft font-body">
        <CliSpinner size={22} />
        <span className="font-mono truncate font-medium" style={{ color: '#D97757' }}>{label}</span>
        <span style={{ color: '#D97757' }}>…</span>
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
  const permissionMode = useStore((s) => (permKey ? (s.permissionModeBySession[permKey] || 'default') : s.permissionMode));
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('cgui-perm-hint-dismissed') === '1'; }
    catch { return false; }
  });
  if (permissionMode !== 'default' || dismissed) return null;
  const dismiss = () => {
    try { localStorage.setItem('cgui-perm-hint-dismissed', '1'); } catch {}
    setDismissed(true);
  };
  return (
    <div className="shrink-0 mx-6 mt-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 flex items-center gap-2 gap-y-1.5 flex-wrap text-[11px] font-body animate-fade-up">
      <Shield size={13} className="text-amber-600 shrink-0" />
      <span className="text-amber-800 flex-1 min-w-[12rem]">
        当前是<b>默认权限</b>模式：每次工具调用都会在输入框上方弹窗征求你同意。
        想加速可切换到接受编辑或放任。
      </span>
      <button
        onClick={() => setPermissionMode('acceptEdits', permKey)}
        className="px-2 py-0.5 rounded bg-amber-100 hover:bg-amber-200 text-amber-900 text-[10px] font-medium shrink-0"
        title="自动接受 Edit/Write 工具的调用"
      >接受编辑</button>
      <button
        onClick={() => setPermissionMode('bypassPermissions', permKey)}
        className="px-2 py-0.5 rounded bg-red-100 hover:bg-red-200 text-red-900 text-[10px] font-medium shrink-0"
        title="跳过全部权限检查（危险）"
      >放任所有</button>
      <button
        onClick={dismiss}
        className="px-2 py-0.5 rounded hover:bg-amber-100 text-amber-700 text-[10px] shrink-0"
        title="永久隐藏此提示（仍可通过权限模式选择器手动切换）"
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
      .then((s) => setStatus(s?.isRepo === false ? 'norepo' : 'repo'))
      .catch(() => setStatus('repo'));  // network err → silent
  }, [cwd, kick]);

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
        alert('git init 失败：' + (data.error || r.status));
        setStatus('norepo');
      }
    } catch (err) { alert('git init 失败：' + err.message); setStatus('norepo'); }
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
    <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
      <div className="flex-1 h-px bg-canvas-deep/60" />
      <span className="text-[10px] text-ink-faint font-body uppercase tracking-wider whitespace-nowrap">
        上下文已压缩
      </span>
      <div className="flex-1 h-px bg-canvas-deep/60" />
    </div>
  );
}

// ─── Session Detail ────────────────────────────────────────────
function SessionDetail({ tabIndex = 0, mobileChrome = false }) {
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
  const selectedSession = (paneSessions && paneSessions[tabIndex]) || null;
  const messages = (paneMessages && paneMessages[tabIndex]) || [];
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
  const currentModel = useStore((s) => s.currentModel);
  const modelBySession = useStore((s) => s.modelBySession);
  const messagesEndRef = useRef(null);
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
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
  const [showFileChanges, setShowFileChanges] = useState(false);
  const activeProcRef = useRef(null);
  const abortRef = useRef(null);

  // Latest TodoWrite snapshot for the composer's checklist panel. TodoWrite
  // calls REPLACE the full list each time, so the newest call wins. Search
  // freshest-first: streaming blocks → chatMessages → persisted messages.
  // DECLARED HERE (above any conditional early return) so hook order stays
  // stable when selectedSession flips from null → set → null (React #310).
  const currentTodos = useMemo(() => {
    const scanToolCalls = (toolCalls) => {
      if (!Array.isArray(toolCalls)) return null;
      for (let j = toolCalls.length - 1; j >= 0; j--) {
        const tc = toolCalls[j];
        if (tc?.name === 'TodoWrite' && Array.isArray(tc.input?.todos)) {
          return tc.input.todos;
        }
      }
      return null;
    };
    for (let i = streamingBlocks.length - 1; i >= 0; i--) {
      const b = streamingBlocks[i];
      if (b?.type === 'tool_use' && b.toolCall?.name === 'TodoWrite' && Array.isArray(b.toolCall.input?.todos)) {
        return b.toolCall.input.todos;
      }
    }
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i];
      if (m?.type !== 'turn') continue;
      const found = scanToolCalls(m.toolCalls);
      if (found) return found;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.type !== 'turn') continue;
      const found = scanToolCalls(m.toolCalls);
      if (found) return found;
    }
    return null;
  }, [streamingBlocks, chatMessages, messages]);

  // When the file watcher reports a write to THIS session's jsonl (e.g. a
  // detached background stream from another tab/session is still writing),
  // silently re-pull messages so the UI catches up.
  //
  // ALSO clear local chatMessages once the jsonl-derived messages have the
  // user prompt that's currently sitting in chatMessages. Otherwise the same
  // turn would render twice — once from `messages` (persisted, from jsonl)
  // and once from `chatMessages` (the in-memory copy from the just-finished
  // local stream).
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
        return prev.filter((m) => !known.has(tkey(m)));
      });
    };
    window.addEventListener('cgui:sessions-changed', onChange);
    return () => window.removeEventListener('cgui:sessions-changed', onChange);
  }, [selectedSession?.sessionId, selectedSession?.projectHash]);

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
    if (!autoScroll) return;
    const id = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages, chatMessages, streamingText, streamingThinking, streamingToolCalls, autoScroll]);

  // Persist scroll position per session so refresh keeps the user where they
  // were (not at top, not at bottom — wherever they were reading).
  const scrollPersistKey = selectedSession?.sessionId
    ? `cgui-scroll-${selectedSession.sessionId}`
    : null;

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 120);
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
          el.scrollTop = top;
          setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
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
  const sessionQueueKey = selectedSession?.sessionId || `draft-${selectedSession?.projectHash || 'none'}`;
  // Model shown in THIS pane's header — the session's own pick, else default.
  const headerModel = modelBySession[sessionQueueKey] || currentModel;
  const messageQueueRaw = useStore((s) => s.messageQueue[sessionQueueKey]);
  const messageQueue = messageQueueRaw || EMPTY_ARRAY;

  const handleSend = useCallback(async (prompt, opts = {}) => {
    const { reattachPid } = opts;
    // Intercept the /remote-control (alias /rc) command. It CANNOT be sent
    // through `claude -p` — slash commands are interactive-only and the CLI
    // rejects them ("isn't available in this environment"). Instead we launch
    // `claude --remote-control --resume <id>` in a real terminal (TTY required)
    // so the Claude mobile app can take over; the GUI keeps syncing via jsonl.
    if (!reattachPid) {
      const cmd = (prompt || '').trim().toLowerCase();
      if (cmd === '/remote-control' || cmd === '/rc' || cmd === 'remote-control') {
        const sel = getLocalSession();
        const rcCwd = selectedProject?.path || sel?.projectPath;
        if (!sel?.sessionId) {
          window.alert('请先发送至少一条消息以创建会话，然后再输入 /remote-control 开启手机远程控制。');
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
          window.alert('远程控制已激活（后台运行，无终端窗口）。\n手机用 Claude App 接管此会话；电脑端 GUI 会自动同步消息。\n输入框已锁定，避免双写——点顶部「已激活」可收回控制。\n（需 Claude 账号登录，且当前未切到 deepseek/mimo 等三方模型）');
        } catch (e) {
          window.alert('开启远程控制失败：' + e.message);
        }
        return;
      }
      // Defense-in-depth: ChatInput already locks the composer when the session
      // is under remote control, but handleSend can be reached by other paths.
      // A new `-p` turn here would double-write the RC pty's session jsonl.
      const lockedSid = getLocalSession()?.sessionId;
      if (lockedSid && useStore.getState().remoteControlled[lockedSid]) {
        window.alert('此会话已交给手机远程控制，输入框已锁定。点顶部「已激活」收回控制后再发送。');
        return;
      }
    }
    // On a normal send, gate against duplicate streams and enqueue overflow.
    // On reattach, the caller is the backgroundPid effect — we WANT it to take
    // over the stream, so skip the gate and the prep work (no user bubble,
    // no checkpoint, no provider-mismatch strip, no POST /api/chat).
    if (!reattachPid && streamingRef.current) {
      useStore.getState().enqueueMessage(sessionQueueKey, { text: prompt, queuedAt: Date.now() });
      return;
    }

    const cwd = selectedProject?.path || selectedSession?.projectPath;
    // Note: previously this function had a blocking `confirm()` for git preflight.
    // That dialog could appear behind other modals or get auto-suppressed by
    // browsers, leaving sends silently stuck. Git preflight is now opportunistic
    // and non-blocking — kicked off in the background, never gates the send.
    // (User can still run git init manually anytime.)

    updateStreaming(true);
    setStreamingText('');
    setStreamingThinking('');
    setStreamingToolCalls([]);
    setStreamingBlocks([]);

    if (!reattachPid) {
    // Push the user bubble IMMEDIATELY so multi-turn sends don't appear to
    // "swallow" the user's message while waiting on git checkpoint I/O. The
    // checkpoint runs in parallel and back-fills `checkpointSha` on the same
    // chatMessages entry when ready (rollback menu reads it from there).
    const userMsgUuid = 'chat-user-' + Date.now();
    setChatMessages((prev) => [...prev, {
      uuid: userMsgUuid, type: 'user',
      timestamp: new Date().toISOString(), text: prompt,
      checkpointSha: null,
    }]);

    // Fire-and-forget git checkpoint. Failures (not a git repo etc.) are
    // silent — no checkpointSha just means the rollback menu's "files only"
    // option will be disabled for this message.
    (async () => {
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
          }),
        });
        if (!cr.ok) return;
        const lr = await fetch(`/api/checkpoints/${sel.sessionId}`);
        if (!lr.ok) return;
        const data = await lr.json();
        const sha = data.entries?.[0]?.sha || null;
        if (!sha) return;
        setChatMessages((prev) =>
          prev.map((m) => (m.uuid === userMsgUuid ? { ...m, checkpointSha: sha } : m))
        );
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
        const inferProv = (m) => {
          if (!m) return null;
          const s = String(m).toLowerCase();
          if (s.startsWith('claude-')) return 'anthropic';
          if (s.startsWith('deepseek')) return 'deepseek';
          if (s.startsWith('mimo')) return 'mimo';
          return null;
        };
        const persisted = getLocalMessages();
        let histProv = null;
        for (let i = persisted.length - 1; i >= 0; i--) {
          const m = persisted[i];
          const hasThinking = (Array.isArray(m.thinking) && m.thinking.length > 0)
            || (Array.isArray(m.blocks) && m.blocks.some((b) => b?.type === 'thinking'));
          if (m.type === 'turn' && hasThinking && m.model) {
            histProv = inferProv(m.model);
            break;
          }
        }
        const currProv = useStore.getState().currentProvider?.providerHint || 'anthropic';
        if (histProv && histProv !== currProv) {
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
    } // end if (!reattachPid)

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
      const { addDirs, globalRead } = useStore.getState();
      // Permission mode / model / effort are all per-session: read THIS
      // session's stored value (keyed by sessionQueueKey) so each pane/session
      // sends with its own settings, not whatever was last globally selected.
      const permissionMode = useStore.getState().getPermissionModeFor(sessionQueueKey);
      const currentModel = useStore.getState().getModelFor(sessionQueueKey);
      const effort = useStore.getState().getEffortFor(sessionQueueKey);
      // When resuming an existing session, cwd MUST be the EXACT string the
      // CLI was launched with — including Unicode chars (e.g. `/foo/肠骨轴`).
      // Reconstructing from the hash dir name is lossy: CLI maps every non-
      // ASCII char to `-`, so `肠骨轴` → `----` is one-way. The server now
      // reads the real cwd out of the jsonl's first system record and ships
      // it as `projectPath` on the session object — always trust that first.
      const sid = selectedSession?.sessionId;
      const chatCwd = (sid && selectedSession?.projectPath)
        ? selectedSession.projectPath
        : (selectedProject?.path || selectedSession?.projectPath);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          // Omit sessionId for a draft so the CLI creates a fresh session.
          sessionId: sid || undefined,
          cwd: chatCwd,
          model: currentModel,
          effort: effort || undefined,
          addDirs: addDirs && addDirs.length ? addDirs : undefined,
          permissionMode: permissionMode || 'default',
          globalRead: globalRead !== false,
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
      let accumulatedText = '';
      let accumulatedThinking = '';
      let currentToolCalls = [];
      // **ORDERED** blocks list — preserves the chronological sequence of
      // text/thinking/tool_use content blocks so the UI can render them in the
      // exact order the model emitted them (which is what Claude Desktop / the
      // CLI terminal do). Without this, all text would group at the top and
      // tool calls dump at the bottom — losing the "tool → think → tool → write"
      // narrative.
      let orderedBlocks = [];  // [{ type, blockIndex, content?, toolCall? }, ...]
      // Did we already render a visible error turn? Guards the empty-output
      // fallback below so we don't double-report.
      let sawError = false;
      // Per-content-block scratch indexed by Anthropic SDK's block `index` field.
      // Each entry: { type: 'text'|'thinking'|'tool_use', toolId?, name?, jsonBuf?, orderIdx? }
      const blocks = {};

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          // Capture the new session id when starting from a draft.
          // IMPORTANT: go through `setSelectedSession` setter so the new id is
          // persisted to localStorage. Bypassing it (raw `useStore.setState`)
          // leaves localStorage with the old draft (sessionId=null), so a
          // page refresh forgets the session even though it exists on disk.
          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            const sel = getLocalSession();
            if (sel && !sel.sessionId) {
              setSelectedSession({
                ...sel,
                draft: false,
                sessionId: event.session_id,
              });
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
                if (cb.name === 'Task') {
                  store.upsertAgent(cb.id, {
                    name: 'Task',
                    description: '',
                    status: 'starting',
                    startedAt: Date.now(),
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
                  if (block.name === 'Task' && parsed) {
                    store.upsertAgent(block.toolId, {
                      name: parsed.subagent_type || parsed.agent || 'Task',
                      description: parsed.description || parsed.prompt?.slice(0, 80) || '',
                      status: 'working',
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
            for (const block of event.message.content) {
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
              }
            }
            if (event.message.model) setStreamingModel(event.message.model);
          }
          if (event.type === 'user' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result') {
                // If this result closes a Task tool_use, mark the subagent done.
                const store = useStore.getState();
                if (store.activeAgents[block.tool_use_id]) {
                  store.upsertAgent(block.tool_use_id, {
                    status: block.is_error ? 'error' : 'done',
                    result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
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
            const msg = (event.errors && event.errors.join('; '))
              || event.error
              || event.subtype
              || 'CLI 报错（无消息体）';
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
          if (event.type === 'done') break;
        }
      }

      if (accumulatedText || accumulatedThinking || currentToolCalls.length > 0) {
        setChatMessages((prev) => [...prev, {
          uuid: 'chat-assistant-' + Date.now(), type: 'turn',
          timestamp: new Date().toISOString(), model: streamingModel,
          text: accumulatedText ? [accumulatedText] : [],
          thinking: accumulatedThinking ? [accumulatedThinking] : [],
          toolCalls: currentToolCalls.map((tc) => ({ ...tc, category: tc.category || 'call' })),
          // The canonical ordered view used by TurnBubble for in-order rendering.
          blocks: orderedBlocks,
          usage: null,
        }]);
      } else if (!sawError) {
        // Stream ended with NOTHING — no text, no tools, no error envelope. This
        // is the "connecting → 空白" case, typically an OpenAI-proxy provider whose
        // upstream rejected auth / the model doesn't exist, so the CLI produced no
        // turn. Surface a fallback instead of a silent blank.
        const msg = 'provider 没有返回任何内容（常见于认证失败 401 或模型不存在）。请检查当前 provider 的 key 与模型是否有效，或切换其它 provider。';
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
      if (err.name !== 'AbortError') {
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
      // After the stream ends locally, pull the persisted jsonl and let it
      // own the displayed history. Then dedup chatMessages — anything that
      // also exists in persisted is dropped, so the assistant turn we just
      // pushed locally doesn't render alongside its jsonl twin.
      const _sel = getLocalSession();
      if (_sel?.sessionId && _sel?.projectHash) {
        try {
          await fetchMessagesForTab(_sel.sessionId, _sel.projectHash, { silent: true });
        } catch {}
        setChatMessages((prev) => {
          if (!prev.length) return prev;
          const persisted = getLocalMessages();
          const tkey = (m) => {
            const t = Array.isArray(m.text) ? m.text.join('') : (m.text || '');
            return `${m.type}|${(t || '').slice(0, 80)}`;
          };
          const known = new Set(persisted.map(tkey));
          return prev.filter((m) => !known.has(tkey(m)));
        });
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

      // After the chat fully finishes, drain the queue: pop the head and send
      // it. This runs once per chat — if more were queued, the next send's
      // finally block will pop again. setTimeout 0 gets us out of this finally
      // first so React commits isStreaming=false before the next send starts.
      // Skip on reattach — the queue belongs to whoever did the original send.
      if (!reattachPid) {
        const tabSel = getLocalSession();
        const queueKey = tabSel?.sessionId
          || `draft-${tabSel?.projectHash || 'none'}`;
        const next = useStore.getState().shiftMessage(queueKey);
        if (next?.text) {
          setTimeout(() => handleSendRef.current?.(next.text), 50);
        }
      }
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
    abortRef.current?.abort();
    if (activeProcRef.current) {
      fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST' });
    } else if (backgroundPid) {
      // Background CLI proc — we're not holding the SSE but can still kill it.
      fetch(`/api/chat/${backgroundPid}/stop`, { method: 'POST' });
      setBackgroundPid(null);
    }
  }, [backgroundPid]);

  // Global ESC → interrupt streaming (matches Claude Code CLI behavior where
  // Esc aborts the current generation). Skip when typing in an input/textarea
  // (those have their own Escape semantics) and when a permission dialog is
  // open (the permission card binds Esc to "deny" — let it handle).
  useEffect(() => {
    if (!isStreaming && !backgroundPid) return;
    const hasPendingPerm = () => useStore.getState().pendingPermissions
      .some((p) => p.sessionId === selectedSession?.sessionId);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (hasPendingPerm()) return; // permission card handles Esc
      e.preventDefault();
      handleStop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isStreaming, backgroundPid, handleStop, selectedSession?.sessionId]);

  // "⚡ 引导" — abort the in-flight chat and immediately fire the queued message.
  const handleAccelerate = useCallback(() => {
    if (abortRef.current) try { abortRef.current.abort(); } catch {}
    if (activeProcRef.current) {
      fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST' }).catch(() => {});
    }
    // The abort triggers handleSend's finally, which drains the queue.
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
        setShowFileChanges(false);
        // Clear reattach guard so navigating back to a session with the same
        // backgroundPid triggers a fresh reattach attempt.
        reattachedPidRef.current = null;
      }
      prevSessionRef.current = curr;
    }
  }, [selectedSession]);

  // Roll back a user message. Three modes:
  //   'message' — restore git (if sha) + trim on-disk jsonl + trim UI + auto re-send
  //                the original text. "Pretend I never sent this and try again."
  //   'edit'    — same restore as above, but instead of auto-resend, drop the
  //                text into the composer so the user can edit before sending.
  //   'files'   — git restore only; conversation untouched.
  //
  // We MUST trim the on-disk jsonl too. Claude CLI resumes a session by
  // reading the jsonl; without trimming it, the next prompt sees the rolled-
  // back AI reply as still-valid history, which defeats the whole rollback.
  //
  // Declared BEFORE the early returns below to keep hook order stable across
  // renders (React #310).
  const handleRollback = useCallback(async (msg, { mode }) => {
    const sel = getLocalSession();
    const proj = useStore.getState().selectedProject;
    const cwd = proj?.path || sel?.projectPath;
    const projectHash = proj?.hash || sel?.projectHash;
    const idxInChat = chatMessages.findIndex((m) => m.uuid === msg.uuid);
    const idxInStore = messages.findIndex((m) => m.uuid === msg.uuid);

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
      if (!msg.checkpointSha) { alert('该消息发送时没有 git 快照，无法还原文件。'); return; }
      if (!sel?.sessionId || !cwd) { alert('缺少 sessionId 或工作目录，无法还原文件。'); return; }
      try {
        const r = await fetch(`/api/checkpoints/${sel.sessionId}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha: msg.checkpointSha, cwd }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          alert('文件还原失败：' + (e.error || r.status));
        }
      } catch (err) {
        alert('文件还原失败：' + err.message);
      }
      return;
    }

    // ── message / edit: full rollback ─────────────────────────
    // For edit mode, fill the composer FIRST — before any state lookups,
    // index checks, or awaits. Even if idx lookup fails or the message has
    // already been removed from both arrays (re-fetch raced ahead, etc.),
    // the user still gets the original text in the input box, which is the
    // primary visible signal they expect from "重新编辑".
    const originalText = msg.text || '';
    if (mode === 'edit' && originalText) {
      useStore.setState({ composerDraft: originalText });
      window.dispatchEvent(new CustomEvent('cgui:composer-fill', { detail: { text: originalText } }));
    }

    if (idxInChat === -1 && idxInStore === -1) return;

    // 1) git restore (best-effort — silently skip if no sha / no repo)
    if (msg.checkpointSha && sel?.sessionId && cwd) {
      try {
        await fetch(`/api/checkpoints/${sel.sessionId}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha: msg.checkpointSha, cwd }),
        });
      } catch {}
    }

    // 2) trim on-disk jsonl so the resumed CLI doesn't see stale history.
    //    Strategy: prefer uuid match (historical store messages); fall back to
    //    timestamp for freshly-sent messages whose chat-user-<ts> uuid never
    //    landed in the jsonl (the CLI persists its own uuid but keeps the ts).
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

    // 4) trim UI
    truncateUi();

    // 5) Re-fetch the (now-trimmed) message list so the UI mirrors disk —
    //    avoids any drift between in-memory slice and what the CLI will see.
    if (sel?.sessionId && projectHash) {
      try { await fetchMessagesForTab(sel.sessionId, projectHash, { silent: true }); } catch {}
    }

    // 6) act per mode
    if (mode === 'edit') return; // composer was filled at the top of this branch
    // mode === 'message': auto-resend.
    if (originalText && handleSendRef.current) {
      setTimeout(() => { handleSendRef.current(originalText); }, 50);
    }
  }, [chatMessages, messages, fetchMessagesForTab, setLocalMessages, setSelectedSession, getLocalSession]);

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

  const allMessages = [...messages, ...chatMessages];
  const totalTokens = allMessages.reduce((acc, m) => {
    if (m.usage) { acc.input += m.usage.input_tokens || 0; acc.output += m.usage.output_tokens || 0; acc.cacheRead += m.usage.cache_read_input_tokens || 0; }
    return acc;
  }, { input: 0, output: 0, cacheRead: 0 });
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
  const lastUsage = [...allMessages].reverse().find(
    (m) => m.usage && ((m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0)) > 0,
  )?.usage;
  const contextTokens = lastUsage
    ? (lastUsage.input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0) + (lastUsage.cache_creation_input_tokens || 0)
    : 0;
  const contextWindow = /\[1m\]/i.test(currentModel || '') ? 1_000_000 : 200_000;
  const contextPct = contextTokens > 0 ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : 0;
  const fmtTok = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
  const winLabel = contextWindow >= 1_000_000 ? '1M' : '200k';

  return (
    <div className="flex-1 flex flex-col min-h-0 glass-base relative">
      {!mobileChrome && <div className="glass-bar shrink-0 px-6 py-3 relative z-30">
        {/* Title row wraps when the pane is narrow or font is scaled up so
            the right-side stats/buttons drop to a second line instead of
            clipping the title. */}
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-y-2 flex-wrap">
          <div className="min-w-0 flex-1">
            <EditableSessionTitle session={selectedSession} />
            <div className="flex items-center gap-3 mt-0.5 flex-wrap max-md:hidden">
              <span className="text-[10px] text-ink-faint font-mono flex items-center gap-1 shrink-0 whitespace-nowrap">
                <Hash size={10} />{selectedSession.sessionId?.slice(0, 8) || '新会话'}
              </span>
              <span className="text-[10px] text-ink-faint font-mono shrink-0 whitespace-nowrap">{messages.length + chatMessages.length} 条消息</span>
              {contextTokens > 0 && (
                <span
                  className={`text-[10px] font-mono shrink-0 whitespace-nowrap px-1.5 py-px rounded ${
                    contextPct >= 80 ? 'text-error bg-error-subtle'
                      : contextPct >= 60 ? 'text-amber-700 bg-amber-50'
                      : 'text-ink-faint'}`}
                  title={`上下文 ${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens${contextPct >= 80 ? ' — 接近上限，建议 /compact' : ''}`}
                >
                  {fmtTok(contextTokens)}/{winLabel} ({contextPct}%)
                </span>
              )}
              {toolCallCount > 0 && <span className="text-[10px] text-ink-faint font-mono shrink-0 whitespace-nowrap">{toolCallCount} 工具调用</span>}
              {currentProvider?.providerHint && currentProvider.providerHint !== 'anthropic' && (
                <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-px font-mono shrink-0 whitespace-nowrap"
                  title={`cc switch 路由：${currentProvider.baseUrl}`}>
                  {currentProvider.providerHint.charAt(0).toUpperCase() + currentProvider.providerHint.slice(1)}
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
            <CheckpointButton
              sessionId={selectedSession?.sessionId}
              cwd={selectedProject?.path || selectedSession?.projectPath}
            />
            <button
              onClick={() => setShowFileChanges(!showFileChanges)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-body transition-colors ${
                showFileChanges ? 'bg-accent/10 text-accent' : 'bg-canvas-warm text-ink-faint hover:text-ink-muted'
              }`}
              title="文件变更"
            >
              <FileDiff size={12} />变更
            </button>
            <div className="text-right max-md:hidden">
              <div className="text-[10px] text-ink-faint font-mono flex items-center gap-1 justify-end">
                <BarChart3 size={10} />{(totalTokens.input + totalTokens.output).toLocaleString()} tokens
                {totalCostUsd > 0 && (
                  <span className="text-accent/80 ml-1.5" title="按当前各模型官网价估算的累计费用（CNY 模型按 1 USD ≈ 7.2 CNY 换算）">
                    · {formatCost(totalCostUsd)}
                  </span>
                )}
              </div>
              {totalTokens.cacheRead > 0 && (
                <div className="text-[10px] text-ink-ghost font-mono">缓存命中 {totalTokens.cacheRead.toLocaleString()}</div>
              )}
            </div>
          </div>
        </div>
      </div>}

      {/* Permission-mode hint banner — moved here from ChatInput so it sits
          directly under the session title. With our PreToolUse permission
          bridge, default mode now correctly pops a dialog per tool. Banner is
          dismissible per-user (localStorage). */}
      <PermissionModeHintBanner permKey={sessionQueueKey} />

      {/* Non-blocking git-init prompt — replaces the old native confirm() that
          got auto-suppressed by browsers and silently froze sends. */}
      <GitInitBanner cwd={selectedProject?.path || selectedSession?.projectPath} />

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

      {showFileChanges ? (
        <div className="flex-1 overflow-y-auto relative z-10 px-6 py-4">
          <div className="max-w-3xl mx-auto">
            <h3 className="text-sm font-display font-medium text-ink mb-4">文件变更记录</h3>
            <FileChangesPanel sessionId={selectedSession.sessionId} projectHash={selectedSession.projectHash} />
          </div>
        </div>
      ) : (
        <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto relative z-10">
          {messages.length === 0 && chatMessages.length === 0 ? (
            <div className="mobile-draft-empty flex items-center justify-center h-full text-ink-muted text-sm font-body">
              {selectedSession?.draft ? '开始你的第一条消息 ↓' : '该会话没有可显示的消息'}
            </div>
          ) : (
            <>
              {messages.map((msg, i) => msg.type === 'compact'
                ? <CompactDivider key={msg.uuid || i} />
                : msg.type === 'turn'
                ? <TurnBubble key={msg.uuid || i} turn={msg} />
                : <MessageBubble key={msg.uuid || i} message={{ ...msg, role: msg.type }}
                    onRollback={msg.type === 'user' ? handleRollback : undefined} />
              )}
              {chatMessages.map((msg, i) => msg.type === 'compact'
                ? <CompactDivider key={msg.uuid || i} />
                : msg.type === 'turn'
                ? <TurnBubble key={msg.uuid || i} turn={msg} />
                : <MessageBubble key={msg.uuid || i} message={{ ...msg, role: msg.type }}
                    onRollback={msg.type === 'user' ? handleRollback : undefined} />
              )}
              {isStreaming && (streamingText || streamingThinking || streamingToolCalls.length > 0 || streamingBlocks.length > 0) && (
                <>
                  <StreamingStatusLine
                    thinking={streamingThinking}
                    text={streamingText}
                    toolCalls={streamingToolCalls}
                  />
                  <TurnBubble turn={{
                    uuid: 'streaming', type: 'turn', timestamp: new Date().toISOString(), model: streamingModel,
                    text: streamingText ? [streamingText] : [],
                    thinking: streamingThinking ? [streamingThinking] : [],
                    toolCalls: streamingToolCalls.map((tc) => ({ ...tc, category: 'call' })),
                    blocks: streamingBlocks,
                    usage: null,
                  }} />
                </>
              )}
              {isStreaming && !streamingText && !streamingThinking && streamingToolCalls.length === 0 && (
                <div className="px-6 py-3 animate-fade-in">
                  <div className="max-w-3xl mx-auto flex items-center gap-2.5 text-[14px] font-body" style={{ color: '#D97757' }}>
                    <CliSpinner size={22} />
                    <span className="font-mono font-medium">Connecting</span>
                    <span>…</span>
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {!autoScroll && !showFileChanges && (
        <div className="absolute bottom-24 right-6 z-20">
          <button onClick={() => {
              // Scroll ONLY the messages container — scrollIntoView would scroll
              // every scrollable ancestor (incl. the root flex), shoving the
              // header off-screen and leaving a blank gap at the bottom (#16).
              const el = containerRef.current;
              if (el) el.scrollTop = el.scrollHeight;
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
          window.dispatchEvent(new CustomEvent('cgui:composer-fill', { detail: { text: item.text } }));
        }}
        todos={currentTodos}
        permKey={sessionQueueKey}
        sessionId={selectedSession?.sessionId || null}
      />
    </div>
  );
}

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
      window.alert((active ? '收回远程控制失败：' : '开启远程控制失败：') + e.message);
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

  const load = () => {
    fetch('/api/providers').then((r) => r.json()).then((d) => {
      setProviders(Array.isArray(d.providers) ? d.providers : []);
      setOpenaiProviders(Array.isArray(d.openaiProviders) ? d.openaiProviders : []);
      setCustomProviders(Array.isArray(d.customProviders) ? d.customProviders : []);
    }).catch(() => {});
    fetch('/api/prefs/hidden-providers').then((r) => r.json())
      .then((d) => setHiddenProviders(new Set(Array.isArray(d.hidden) ? d.hidden : [])))
      .catch(() => {});
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
    if (!window.confirm(`删除自定义 Provider「${name}」?`)) return;
    await fetch(`/api/custom-providers/${id}`, { method: 'DELETE' }).catch(() => {});
    load();
  };
  useEffect(() => {
    load();
    const onCh = () => load();
    window.addEventListener('cgui:provider-change', onCh);
    return () => window.removeEventListener('cgui:provider-change', onCh);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
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
      setOpen(false);
    } catch (e) {
      window.alert('切换 provider 失败：' + e.message);
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
        <div className="glass-popover absolute left-0 top-full mt-2 w-60 z-50 py-1 animate-glass-rise max-h-[70vh] overflow-y-auto">
          <div className="px-3 py-2 sticky top-0 bg-canvas border-b border-canvas-deep">
            <div className="text-[10px] text-ink-faint uppercase tracking-wider font-body">切换 Provider</div>
            <p className="text-[10px] text-ink-faint font-body mt-1 leading-snug">
              来自 CC Switch。切换会改写 <code className="font-mono">~/.claude/settings.json</code>（自动备份），<b>对新发的消息生效</b>。
            </p>
          </div>
          {providers.filter((p) => showHidden || !hiddenProviders.has(p.id)).map((p) => (
            <div key={p.id} className={`w-full flex items-center gap-0.5 pr-2 hover:bg-canvas-warm transition-colors ${isCur(p) ? 'bg-accent-subtle' : ''} ${hiddenProviders.has(p.id) ? 'opacity-50' : ''}`}>
              <button disabled={switching} onClick={() => switchTo(p.id)}
                className={`flex-1 min-w-0 text-left px-3 py-2 flex items-center gap-2 ${switching ? 'opacity-50' : ''}`}>
                <span className={`flex-1 text-xs font-body truncate ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
                {isCur(p) && <Check size={12} className="text-accent shrink-0" />}
              </button>
              <button onClick={() => toggleHideProvider(p.id)} title={hiddenProviders.has(p.id) ? '取消隐藏' : '从列表隐藏'} className="p-1 text-ink-faint hover:text-ink-muted shrink-0">
                {hiddenProviders.has(p.id) ? <ArchiveRestore size={12} /> : <EyeOff size={12} />}
              </button>
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
                <span className={`flex-1 text-xs font-body truncate ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
                <span className="text-[9px] px-1 py-px bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{p.type}</span>
                {isCur(p) && <Check size={12} className="text-accent shrink-0" />}
                <button onClick={() => removeCustom(p.id, p.name)} title="删除" className="p-0.5 text-ink-faint hover:text-error shrink-0"><Trash2 size={12} /></button>
              </div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {(p.models.length ? p.models : ['(默认)']).map((m) => (
                  <button key={m} disabled={switching}
                    onClick={() => switchTo(p.id, p.models.length ? m : undefined)}
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${switching ? 'opacity-50' : ''} border-canvas-deep text-ink-soft hover:border-accent hover:text-accent`}>
                    {m}
                  </button>
                ))}
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
          <CustomProviderForm onSaved={load} />
        </div>
      )}
    </div>
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
  const [fetched, setFetched] = useState([]);
  const [fetchNote, setFetchNote] = useState('');
  const [fetching, setFetching] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
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

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/model').then(r => r.json()).then(data => {
        if (cancelled) return;
        setProvider(data.provider || '');
        // Seed the GLOBAL default only (never a per-session override) — this is
        // the resolved settings.json default, used as fallback for sessions
        // without an explicit pick.
        if (data.model) useStore.setState({ currentModel: data.model });
        if (data.available) useStore.setState({ availableModels: data.available });
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
  const has1m = /\[1m\]/i.test(currentModel || '');
  const toggle1m = () => {
    const base = (currentModel || '').replace(/\[1m\]/i, '');
    if (!base) return;
    setModel(has1m ? base : `${base}[1m]`);
  };
  // Switching models PRESERVES the current 1M flag, so picking a different model
  // doesn't silently drop your 1M-context choice (#4). Removing 1M is explicit
  // via the toggle above.
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
        <div className="glass-popover absolute right-0 top-full mt-2 w-80 z-50 py-1 animate-glass-rise max-h-[70vh] overflow-y-auto max-md:fixed max-md:left-3 max-md:right-3 max-md:top-16 max-md:w-auto max-md:mt-0">
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
          {/* 1M context toggle — appends [1m] to the active model id */}
          <button onClick={toggle1m}
            className="w-full text-left px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 border-b border-canvas-deep">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-ink font-body">1M 上下文</div>
              <div className="text-[10px] text-ink-faint font-body leading-snug">
                给当前模型追加 <code className="font-mono">[1m]</code> 后缀（1M tokens 上下文 beta）
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
                  currentModel === m.id ? 'bg-accent-subtle/50' : ''}`}>
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
                {currentModel === m.id && <Check size={12} className="text-accent shrink-0" />}
              </button>
            );
          })}
          {customRows.filter((m) => match(m.id, m.name)).map((m) => (
            <div key={m.id}
              className={`w-full px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 ${
                currentModel === m.id ? 'bg-accent-subtle/50' : ''}`}>
              <button onClick={() => selectModel(m.id)} className="flex-1 min-w-0 text-left">
                <div className="text-xs font-medium text-ink font-body flex items-center gap-1.5">
                  {m.name}
                  <span className="text-[8.5px] px-1 py-px bg-accent-subtle text-accent rounded font-mono">自定义</span>
                  {m.context1m && <span className="text-[8.5px] px-1 py-px bg-accent text-white rounded font-mono">1M</span>}
                </div>
                <div className="text-[10px] text-ink-faint font-mono truncate">{m.id}</div>
              </button>
              {currentModel === m.id && <Check size={12} className="text-accent shrink-0" />}
              <button onClick={() => useStore.getState().removeCustomModel(m.id)} title="移除自定义模型"
                className="p-1 text-ink-faint hover:text-error shrink-0"><X size={12} /></button>
            </div>
          ))}
          {fetchedRows.map((m) => (
            <button key={`f-${m.id}`} onClick={() => selectModel(m.id)}
              className={`w-full text-left px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 ${
                currentModel === m.id ? 'bg-accent-subtle/50' : ''}`}>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-ink font-body truncate">{m.name}</div>
                <div className="text-[10px] text-ink-faint font-mono truncate">实时拉取</div>
              </div>
              {currentModel === m.id && <Check size={12} className="text-accent shrink-0" />}
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
  const effModel = useStore((s) => ((permKey && s.modelBySession[permKey]) || s.currentModel) || '');
  const effort = useStore((s) => { const b = effModel.replace(/\[1m\]/i, ''); return b && b in s.effortByModel ? s.effortByModel[b] : s.effort; });
  return (
    <div className="py-1">
      <div className="px-4 pt-2 pb-1 text-[11px] text-ink-faint font-body">作用于当前模型 <span className="font-mono text-ink-soft">{effModel.replace(/\[1m\]/i, '') || '默认'}</span>(推理力度按模型记忆)</div>
      {EFFORT_LEVELS.map((e) => (
        <button key={e.id || 'default'} onClick={() => useStore.getState().setEffortForModel(effModel, e.id)}
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
  const permissionMode = useStore((s) => (permKey ? (s.permissionModeBySession[permKey] || 'default') : s.permissionMode));
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
function CustomProviderForm({ onSaved }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('openai');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [busy, setBusy] = useState('');
  const parseModels = () => modelsText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const fetchModels = async () => {
    if (!baseURL.trim()) return window.alert('先填 Base URL');
    setBusy('fetch');
    try {
      const r = await fetch('/api/custom-providers/fetch-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, baseURL, apiKey }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '拉取失败');
      if (!d.models?.length) window.alert('该端点未返回模型,请手动填写');
      else setModelsText(d.models.join('\n'));
    } catch (e) { window.alert('拉取模型失败：' + e.message); }
    setBusy('');
  };
  const save = async () => {
    if (!name.trim() || !baseURL.trim()) return window.alert('名称和 Base URL 必填');
    setBusy('save');
    try {
      // Store in the GUI's own custom-providers.json (no cc-switch.db dependency —
      // works on a fresh machine without CC Switch installed).
      const r = await fetch('/api/custom-providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, baseURL, apiKey, models: parseModels() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '保存失败');
      setName(''); setBaseURL(''); setApiKey(''); setModelsText(''); setOpen(false);
      onSaved?.();
    } catch (e) { window.alert('保存失败：' + e.message); }
    setBusy('');
  };
  const inputCls = 'w-full bg-canvas-warm border border-canvas-deep rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-accent';
  if (!open) {
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
        <span className="text-[13px] font-display font-semibold text-ink">新增 Provider<span className="text-[10px] font-body font-normal text-ink-faint ml-1">保存到本机</span></span>
        <button onClick={() => setOpen(false)} className="p-1 text-ink-faint hover:text-ink"><X size={16} /></button>
      </div>
      <MobileSegmented onChange={setType} options={[
        { value: 'openai', label: 'OpenAI 兼容', active: type === 'openai' },
        { value: 'anthropic', label: 'Anthropic 兼容', active: type === 'anthropic' },
      ]} />
      <input className={inputCls} placeholder="名称(如 我的中转)" value={name} onChange={(e) => setName(e.target.value)} />
      <input className={`${inputCls} font-mono`} placeholder="Base URL (https://...)" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
      <input className={`${inputCls} font-mono`} type="password" placeholder="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <div className="flex items-center gap-2">
        <textarea className={`${inputCls} font-mono min-h-[60px]`} placeholder="模型(每行一个,或逗号分隔)" value={modelsText} onChange={(e) => setModelsText(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <button onClick={fetchModels} disabled={!!busy}
          className="flex-1 px-3 py-2 text-[12px] border border-accent text-accent rounded-lg disabled:opacity-50">
          {busy === 'fetch' ? '拉取中…' : '从 /v1/models 拉取'}
        </button>
        <button onClick={save} disabled={!!busy}
          className="flex-1 px-3 py-2 text-[12px] bg-accent text-white rounded-lg disabled:opacity-50">
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

function MobileProviderPage() {
  const [providers, setProviders] = useState([]);
  const [openaiProviders, setOpenaiProviders] = useState([]);
  const [customProviders, setCustomProviders] = useState([]);
  const [switching, setSwitching] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const load = () => {
    fetch('/api/providers').then((r) => r.json()).then((d) => {
      setProviders(Array.isArray(d.providers) ? d.providers : []);
      setOpenaiProviders(Array.isArray(d.openaiProviders) ? d.openaiProviders : []);
      setCustomProviders(Array.isArray(d.customProviders) ? d.customProviders : []);
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
    } catch (e) { window.alert('切换 provider 失败：' + e.message); }
    setSwitching(false);
  };
  const removeCustom = async (id, name) => {
    if (!window.confirm(`删除自定义 Provider「${name}」?`)) return;
    await fetch(`/api/custom-providers/${id}`, { method: 'DELETE' }).catch(() => {});
    load();
  };
  return (
    <div className="py-1">
      {providers.map((p) => (
        <div key={p.id} className={`w-full flex items-center gap-1 pr-3 hover:bg-canvas-warm transition-colors ${isCur(p) ? 'bg-accent-subtle' : ''}`}>
          <button disabled={switching} onClick={() => switchTo(p.id)}
            className={`flex-1 min-w-0 flex items-center gap-3 px-4 py-3 text-left ${switching ? 'opacity-50' : ''}`}>
            <span className={`flex-1 text-[14px] font-body truncate ${isCur(p) ? 'text-accent font-medium' : 'text-ink'}`}>{p.name}</span>
            {isCur(p) && <Check size={16} className="text-accent shrink-0" />}
          </button>
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
          <button onClick={() => removeCustom(p.id, p.name)} title="删除" className="p-1.5 text-ink-faint hover:text-error shrink-0"><Trash2 size={15} /></button>
        </div>
      ))}
      <CustomProviderForm onSaved={load} />
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
  const effort = useStore((s) => { const b = (currentModel || '').replace(/\[1m\]/i, ''); return b && b in s.effortByModel ? s.effortByModel[b] : s.effort; });
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

// ─── Main App ──────────────────────────────────────────────────
export default function App() {
  useWebSocket();
  const { sidebarCollapsed, toggleSidebar, selectedProject, selectedSession } = useStore();
  const [rightPanel, setRightPanel] = useState(null);
  // Auth gate: external clients with a password set must log in first. Loopback
  // (Mac) always reports authed, so this is a no-op locally.
  const [authLocked, setAuthLocked] = useState(false);
  useEffect(() => {
    fetch('/api/auth-status').then((r) => r.json())
      .then((d) => setAuthLocked(!!(d.required && !d.authed)))
      .catch(() => {});
  }, []);

  // Optional local-only widgets (client/src/components/*.local.jsx). Fresh
  // checkouts have none; public builds temporarily move them out of the build
  // graph so personal controls do not enter client/dist or Tauri bundles.
  const [LocalWidget, setLocalWidget] = useState(null);
  useEffect(() => {
    const mods = import.meta.glob('./components/*.local.jsx');
    const entry = Object.values(mods)[0];
    if (entry) entry().then((m) => setLocalWidget(() => m.default)).catch(() => {});
  }, []);
  // Per-session permission key for the header chip + bypass auto-resolve.
  // Follows the ACTIVE pane (not always pane 0) so in split mode the top-bar
  // mode chip controls whichever pane the user last focused — matching the
  // sessionQueueKey that pane's composer sends with.
  const activeTabIndex = useStore((s) => s.activeTabIndex);
  const paneSessions = useStore((s) => s.paneSessions);
  const customTitles = useStore((s) => s.customTitles);
  const activeSession = (paneSessions && paneSessions[activeTabIndex]) || selectedSession;
  const permKey = activeSession?.sessionId || `draft-${activeSession?.projectHash || 'none'}`;

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
    ? (customTitles[mobileSelSession.sessionId] || mobileSelSession.firstPrompt?.slice(0, 24) || '新会话')
    : 'Claude Code';

  const uiFontScale = useStore((s) => s.uiFontScale);
  useEffect(() => {
    try {
      const z = String(uiFontScale || 1);
      document.documentElement.style.zoom = z;
      // Root container uses calc(100dvh / var(--ui-zoom)) to stay exactly one
      // physical viewport tall regardless of zoom (keeps the composer visible).
      document.documentElement.style.setProperty('--ui-zoom', z);
    } catch {}
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
    pending.filter((p) => p.sessionId === sid).forEach((p) => {
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
          width: 'calc(100vw / var(--ui-zoom, 1))',
          height: 'calc((100dvh / var(--ui-zoom, 1)) - var(--kb, 0px))',
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
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden" style={{ width: 'calc(100vw / var(--ui-zoom, 1))', height: 'calc(100dvh / var(--ui-zoom, 1))' }}>
      {/* Top bar — glass */}
      {/* Top bar uses min-height instead of fixed h-12 so when font scales up
          and the right cluster wraps to a second line, the bar grows with the
          content instead of clipping. flex-wrap on both sides keeps it from
          horizontally overflowing on narrow viewports. */}
      <header className="glass-bar min-h-12 px-4 py-1 flex items-center justify-between gap-y-1 flex-wrap shrink-0 relative z-40">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={toggleSidebar} className="btn-glass p-1.5 transition-colors shrink-0" title={sidebarCollapsed ? '展开' : '收起'}>
            {sidebarCollapsed ? <ChevronRight size={15} className="text-ink-muted" /> : <ChevronLeft size={15} className="text-ink-muted" />}
          </button>
          <span className="text-accent text-[15px] leading-none shrink-0 select-none font-mono">✻</span>
          <span className="text-[15px] font-display font-semibold text-ink tracking-tight shrink-0">Claude Code</span>
          {selectedProject && (
            <span className="chip font-mono truncate min-w-0 max-w-[200px]">
              {formatPathShort(selectedProject.path)}
            </span>
          )}
          {selectedSession && (
            <>
              <span className="text-ink-ghost shrink-0">/</span>
              <span className="text-[11px] text-ink-muted font-body truncate min-w-0 max-w-[220px]">
                {customTitles[selectedSession.sessionId] || selectedSession.firstPrompt?.slice(0, 36) || selectedSession.sessionId?.slice(0, 8) || '新会话'}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          <ProviderSwitcher />
          <ModelSelector placement="bottom" align="right" compact permKey={permKey} />
          <EffortSelector placement="bottom" align="right" permKey={permKey} />
          <PermissionModeSelector permKey={permKey} />
          <RemoteControlButton session={activeSession} />
          <div className="w-px h-4 bg-ink-ghost/30 mx-1" />
          {/* Split-screen toggle. Activates the right pane (initially empty
              until user clicks a session in the sidebar). Click again to
              collapse back to a single SessionDetail. */}
          <PaneCountPicker />
          {Object.entries(PANEL_MAP).map(([id, { icon: Icon, label }]) => {
            // Short chip label (always visible under the icon). Long `label`
            // stays as the hover tooltip for the full name.
            const SHORT = {
              files: '文件', monitor: '监控', usage: '用量', processes: '进程',
              mcp: 'MCP', settings: '设置',
            };
            const short = SHORT[id] || label;
            return (
              <button key={id} onClick={() => setRightPanel(rightPanel === id ? null : id)}
                className={`px-1.5 py-1 rounded-lg transition-all flex flex-col items-center gap-0.5 ${rightPanel === id ? 'bg-accent-subtle text-accent' : 'text-ink-muted hover:text-ink hover:bg-black/5'}`}
                title={label}>
                <Icon size={15} />
                <span className="text-[9px] leading-none font-body">{short}</span>
              </button>
            );
          })}
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
    </div>
  );
}
