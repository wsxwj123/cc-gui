import { create } from 'zustand';

// Helper: read JSON from localStorage with fallback.
const readLs = (key, fallback) => {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
};
const writeLs = (key, val) => {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
};

// Push one session-title change to the shared server store (fire-and-forget).
// Server merges per-key and broadcasts the full map back over ws so the other
// device updates live. Empty title clears the override.
const putCustomTitle = (sessionId, title) => {
  fetch('/api/prefs/custom-titles', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, title: title || '' }),
  }).catch(() => {});
};

// Valid `--permission-mode` values per `claude --help`.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

// ── Theme families ───────────────────────────────────────────────
// Each family carries a light + dark variant. `id` is the data-cgui-theme
// value (empty = default Apple-system palette driven purely by data-theme).
// bg/bg2/fg/accent are preview swatch colors for the theme popover cards.
export const THEME_FAMILIES = [
  { id: 'default', name: '默认',
    light: { id: '', bg: '#FFFFFF', bg2: '#ECECEE', fg: '#1A1A1A', accent: '#1A1A1A' },
    dark:  { id: '', bg: '#1A1A1B', bg2: '#121213', fg: '#F5F5F6', accent: '#A0A0A6' } },
  { id: 'claude', name: 'Claude',
    light: { id: 'claude-warm', bg: '#F2EDE3', bg2: '#E2DBCC', fg: '#1A1A1A', accent: '#D97757' },
    dark:  { id: 'claude-dark', bg: '#29251F', bg2: '#161412', fg: '#F5F0E8', accent: '#D97757' } },
  { id: 'opencode', name: 'OpenCode',
    light: { id: 'opencode-light', bg: '#F0F0F0', bg2: '#EAEAEA', fg: '#1A1A1A', accent: '#D2691E' },
    dark:  { id: 'opencode-dark',  bg: '#141414', bg2: '#050505', fg: '#EEEEEE', accent: '#FAB283' } },
  { id: 'tokyonight', name: 'Tokyo Night',
    light: { id: 'tokyonight-day', bg: '#D5D6DB', bg2: '#C8C9CE', fg: '#3760BF', accent: '#2E7DE9' },
    dark:  { id: 'tokyonight',     bg: '#1E2030', bg2: '#16161E', fg: '#C8D3F5', accent: '#82AAFF' } },
  { id: 'nord', name: 'Nord',
    light: { id: 'nord-light', bg: '#E5E9F0', bg2: '#DDE3EC', fg: '#2E3440', accent: '#5E81AC' },
    dark:  { id: 'nord',       bg: '#3B4252', bg2: '#242933', fg: '#ECEFF4', accent: '#88C0D0' } },
  { id: 'rosepine', name: 'Rosé Pine',
    light: { id: 'rose-pine-dawn', bg: '#FFFAF3', bg2: '#F2E9E1', fg: '#575279', accent: '#31748F' },
    dark:  { id: 'rosepine',       bg: '#1F1D2E', bg2: '#131019', fg: '#E0DEF4', accent: '#9CCFD8' } },
  { id: 'catppuccin', name: 'Catppuccin',
    light: { id: 'catppuccin-latte', bg: '#E6E9EF', bg2: '#CCD0DA', fg: '#4C4F69', accent: '#1E66F5' },
    dark:  { id: 'catppuccin-mocha', bg: '#313244', bg2: '#181825', fg: '#CDD6F4', accent: '#89B4FA' } },
  { id: 'dracula', name: 'Dracula',
    light: { id: 'dracula-light', bg: '#F5F1E0', bg2: '#EDE9D8', fg: '#1F1F1F', accent: '#644AC9' },
    dark:  { id: 'dracula',       bg: '#383A4A', bg2: '#21222C', fg: '#F8F8F2', accent: '#BD93F9' } },
  { id: 'gruvbox', name: 'Gruvbox',
    light: { id: 'gruvbox-light', bg: '#F2E5BC', bg2: '#EBDBB2', fg: '#3C3836', accent: '#076678' },
    dark:  { id: 'gruvbox-dark',  bg: '#3C3836', bg2: '#1D2021', fg: '#EBDBB2', accent: '#FE8019' } },
  { id: 'kanagawa', name: 'Kanagawa',
    light: { id: 'kanagawa-lotus', bg: '#EAE4D7', bg2: '#E3DCD2', fg: '#54433A', accent: '#2D4F67' },
    dark:  { id: 'kanagawa',       bg: '#2A2A37', bg2: '#16161D', fg: '#DCD7BA', accent: '#7E9CD8' } },
  { id: 'everforest', name: 'Everforest',
    light: { id: 'everforest-light', bg: '#FFFFFF', bg2: '#EAF1E4', fg: '#2C4A33', accent: '#4B8B3B' },
    dark:  { id: 'everforest-dark',  bg: '#1A211C', bg2: '#131A15', fg: '#A8D5A2', accent: '#7FC06E' } },
  { id: 'solarized', name: 'Solarized',
    light: { id: 'solarized-light', bg: '#F5EFD6', bg2: '#EEE8D5', fg: '#586E75', accent: '#268BD2' },
    dark:  { id: 'solarized-dark',  bg: '#073642', bg2: '#00212B', fg: '#93A1A1', accent: '#268BD2' } },
  { id: 'github', name: 'GitHub',
    light: { id: 'github-light', bg: '#F6F8FA', bg2: '#EAEEF2', fg: '#24292F', accent: '#0969DA' },
    dark:  { id: 'github-dark',  bg: '#161B22', bg2: '#010409', fg: '#E6EDF3', accent: '#58A6FF' } },
  { id: 'flexoki', name: 'Flexoki',
    light: { id: 'flexoki-light', bg: '#F2F0E5', bg2: '#E6E4D9', fg: '#100F0F', accent: '#205EA6' },
    dark:  { id: 'flexoki-dark',  bg: '#1C1B1A', bg2: '#0A0908', fg: '#CECDC3', accent: '#4385BE' } },
];

export function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  catch { return false; }
}

// Resolve a family + tone to the concrete { dataTheme, cguiTheme } pair.
// tone 'auto' picks light/dark from the OS at call time; presets are fixed
// palettes so the variant id itself must flip (CSS can't auto-switch them).
export function resolveTheme(familyId, tone) {
  const fam = THEME_FAMILIES.find((f) => f.id === familyId) || THEME_FAMILIES[0];
  const effDark = tone === 'auto' ? systemPrefersDark() : tone === 'dark';
  return { dataTheme: tone, cguiTheme: (effDark ? fam.dark.id : fam.light.id) || '' };
}

// Initial family: explicit choice, else derive from a legacy preset id, else default.
function initThemeFamily() {
  try {
    const fam = localStorage.getItem('cgui-theme-family');
    if (fam) return fam;
    const preset = localStorage.getItem('cgui-theme-preset') || '';
    if (!preset) return 'default';
    const m = THEME_FAMILIES.find((f) => f.light.id === preset || f.dark.id === preset);
    return m ? m.id : 'default';
  } catch { return 'default'; }
}
function initThemeTone() {
  try { return localStorage.getItem('cgui-theme') || 'auto'; }
  catch { return 'auto'; }
}

// ── Reading font (Claude message prose) ──────────────────────────
// Like Claude Desktop's font setting. `css` is the font stack written to the
// --font-reading custom property; system serifs (Times/Georgia) need no load,
// 'Newsreader'/'JetBrains Mono'/'DM Sans' are already loaded in index.html.
export const FONT_OPTIONS = [
  { id: 'newsreader', name: '默认衬线 (Newsreader)', css: "'Newsreader', Georgia, serif" },
  { id: 'times',      name: 'Times New Roman',       css: "'Times New Roman', Times, serif" },
  { id: 'georgia',    name: 'Georgia',               css: "Georgia, 'Times New Roman', serif" },
  { id: 'sans',       name: '无衬线 (DM Sans)',      css: "'DM Sans', -apple-system, system-ui, sans-serif" },
  { id: 'mono',       name: '等宽 (JetBrains Mono)', css: "'JetBrains Mono', ui-monospace, monospace" },
];
function initReadingFont() {
  try { return localStorage.getItem('cgui-reading-font') || 'newsreader'; }
  catch { return 'newsreader'; }
}
// Apply a reading-font id to the <html> --font-reading custom property.
export function applyReadingFont(id) {
  const opt = FONT_OPTIONS.find((f) => f.id === id) || FONT_OPTIONS[0];
  try { document.documentElement.style.setProperty('--font-reading', opt.css); } catch {}
}

// Monotonic counter for fresh stable pane identity tokens (see paneIds).
let nextPaneId = 6;
const freshPaneId = () => `p${nextPaneId++}`;

export const useStore = create((set, get) => ({
  // Data
  projects: [],
  sessions: [],
  messages: [],
  currentModel: null,
  availableModels: [],
  // Live-detected backend (set by fetchProvider). When cc switch routes the
  // CLI's Claude-shaped API calls to deepseek/mimo/etc, this tells us the
  // real upstream so pricing.js can charge correctly. Defaults to anthropic.
  currentProvider: { providerHint: 'anthropic', baseUrl: '', model: null },
  // CLI session knobs. Persisted to localStorage so they survive reload.
  effort: (() => { try { return (typeof localStorage !== 'undefined' && localStorage.getItem('cgui-effort')) || ''; } catch { return ''; } })(),
  addDirs: readLs('cgui-add-dirs', []),
  // 默认 'default'(每个工具调用弹窗征求同意)。曾默认 'plan'(Bug #9),但选择器
  // 回退 'default'、而 banner/getPermissionModeFor 回退全局('plan') → 新建会话出现
  // "选择器显示默认却实际在跑 plan + banner 报规划模式"的三方不一致(用户报告的冲突)。
  // 统一为:三处都回退全局 permissionMode,初始即 default → 显示=实际。想要 plan 的
  // 用户手动切一次即可,会粘到后续新会话。`permissionMode` 是活跃会话的镜像值
  // (per-session 真值在 permissionModeBySession)。
  permissionMode: readLs('cgui-permission-mode', 'default'),
  // Per-session override map { [sessionKey]: mode }. Each session (or draft)
  // remembers its OWN mode so switching from session A (plan) to session B
  // (bypass) shows B's mode, not A's. Keyed by sessionId, or `draft-<hash>`
  // for unsent drafts (mirrors sessionQueueKey).
  permissionModeBySession: readLs('cgui-perm-mode-by-session', {}),
  // Same per-session pattern for model + effort (#9). currentModel/effort stay
  // as the GLOBAL default (resolved from settings.json / WS); these maps hold
  // each session's explicit override. A session with no entry uses the default.
  modelBySession: readLs('cgui-model-by-session', {}),
  // Per-SESSION reasoning effort (cgui-effort-by-session)。与 model/permission 一致:
  // 按会话隔离 + 持久化,同一模型在不同会话可设不同力度、互不影响。无 entry 的会话
  // 回落全局 `effort`(最终 settings.json env)。切模型时若该档不被新模型支持,CLI 自动
  // 降级到 ≤该档的最高支持档,不报错。
  effortBySession: readLs('cgui-effort-by-session', {}),
  // Per-session "active agent / mode" (BG5). When set, the session is started
  // with `--agent <name>` so that agent (e.g. orchestrator) becomes the primary
  // controller and delegates to subagents. Empty = 普通模式 (no --agent). Only
  // applied on NEW sessions (CLI rejects --agent on --resume).
  activeAgentBySession: readLs('cgui-agent-by-session', {}),
  // User-defined session titles { [sessionId]: title }. When set, overrides the
  // auto firstPrompt everywhere the title shows (sidebar / header / breadcrumb).
  // We never touch the on-disk jsonl — titles live only in localStorage.
  customTitles: readLs('cgui-custom-titles', {}),
  // AI 自动生成的会话标题 { [sessionId]: title }(首轮对话后由 /api/chat/title 生成)。
  // 优先级低于用户自定义 customTitles、高于 firstPrompt。仅存 localStorage。
  autoTitles: readLs('cgui-auto-titles', {}),
  // The provider (providerHint) each session last sent under. A provider switch
  // (e.g. mimo → official) invalidates the prior turns' thinking-block
  // signatures. We can't infer the old provider from the model name — mimo is a
  // claude-protocol relay so its turns carry claude-* names and look identical
  // to official — so we record the REAL provider per send and compare next time.
  lastProviderBySession: readLs('cgui-last-provider-by-session', {}),
  // U1/U4:最近一次 provider 切换的时间戳。发送路径的"历史模型回退"(_hist)只信任
  // 晚于该时刻的消息 —— 否则切走 provider 后,老会话历史里的旧 provider 模型 id
  // (如 mimo-v2.5-pro)会继续被发给新 provider,上游报"模型无可用渠道/para error"。
  providerEpoch: readLs('cgui-provider-epoch', 0),
  // U3/V1:/context 实测结果 { [sessionId]: { totalTokens, windowTokens, ts } }。
  // 这是权威来源 —— 徽章的分子/分母与按事件 usage/模型名猜测不一致时,以实测为准
  // (回合结束后台自动探测一次 + 点徽章手动探测都会回写)。仅内存态,不持久化。
  ctxMeasuredBySession: {},
  // AA1:缓存 /context 的完整分项明细 { [sessionId]: { categories, mcpServers, model,
  // totalTokens, windowTokens, pct, ts } }。后台探测(开会话/回合后)拿到的 d 整体存进
  // 来,点徽章弹层直接读缓存秒开 —— 不必再 spawn `claude -p /context`(冷启动+多次
  // count_tokens 网络往返,5~30s)。仅内存态。
  ctxBreakdownBySession: {},
  // Sessions currently handed off to phone remote control (sessionId → true).
  // While set, the GUI must NOT spawn `-p` turns for that session (both would
  // write the same jsonl). The composer locks and shows a reclaim banner.
  remoteControlled: {},
  // When enabled, spawn includes `--add-dir $HOME` so Claude can READ any file
  // under the user's home directory by default. Writes/edits still require
  // permission (unless mode is bypassPermissions / acceptEdits).
  globalRead: readLs('cgui-global-read', true),

  // UI state — selectedProject + selectedSession persisted so refresh
  // restores the user's current conversation instead of dumping them on Empty.
  selectedProject: readLs('cgui-selected-project', null),
  selectedSession: readLs('cgui-selected-session', null),

  // Multi-pane state (Phase 2). paneCount = 1..6 panes visible side-by-side.
  // Pane 0 MIRRORS the legacy selectedSession / messages so existing reads
  // outside SessionDetail keep working unchanged. Panes 1..5 live in the
  // sparse arrays below — each slot is independently null-able so closing a
  // middle pane just splices it out without disturbing other slots.
  //
  // splitMode is derived (paneCount > 1) but exported for legacy code that
  // checks `if (splitMode)` for branching.
  paneCount: (() => {
    const n = parseInt(readLs('cgui-pane-count', 1), 10);
    return Number.isFinite(n) && n >= 1 && n <= 6 ? n : 1;
  })(),
  // paneSessions[0] always == selectedSession; index 1..5 are extra panes.
  paneSessions: (() => {
    const arr = readLs('cgui-pane-sessions', [null, null, null, null, null, null]);
    const padded = Array.isArray(arr) ? arr.slice(0, 6) : [];
    while (padded.length < 6) padded.push(null);
    // pane 0 reload from legacy slot so refresh in single mode also restores
    padded[0] = readLs('cgui-selected-session', null);
    return padded;
  })(),
  // paneMessages is in-memory only (re-fetched on session load). Persisting
  // it would bloat localStorage and the on-disk jsonl is the source of truth.
  paneMessages: [[], [], [], [], [], []],
  // Stable per-pane identity tokens. SplitMain keys each SessionDetail by these
  // (not by position), so closePane's left-shift keeps every surviving pane's
  // React instance — and its live streaming state — paired with its session.
  // In-memory only; layout positions are restored from paneSessions on reload.
  paneIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'],
  activeTabIndex: (() => {
    const n = parseInt(readLs('cgui-active-tab-index', 0), 10);
    return Number.isFinite(n) && n >= 0 && n <= 5 ? n : 0;
  })(),
  // Background-process pids per session, surfaced for sidebar dots + top
  // badge. Populated by SessionDetail's backgroundPid poll. Shape:
  //   { [sessionId]: pid }
  backgroundSessions: {},

  // M3(Q9): 非聚焦会话完成回复时的悬浮提醒。[{id, sessionId, projectHash, title, summary, ts}]
  completionToasts: [],
  pushCompletionToast: (t) => set((s) => ({
    completionToasts: [...s.completionToasts.filter((x) => x.sessionId !== t.sessionId), { ...t, id: `${t.sessionId}-${Date.now()}` }],
  })),
  removeCompletionToast: (id) => set((s) => ({
    completionToasts: s.completionToasts.filter((x) => x.id !== id),
  })),

  // ── Legacy aliases for Phase 1 callers (kept for back-compat) ──
  // splitMode is `paneCount > 1`; secondarySession/Messages mirror pane 1.
  // These fields are also mutated by the new pane actions below so reads
  // stay in sync. Eventually App.jsx + components will be refactored to use
  // pane APIs directly and these can be dropped.
  splitMode: (() => {
    const n = parseInt(readLs('cgui-pane-count', 1), 10);
    return Number.isFinite(n) && n > 1;
  })(),
  secondarySession: (() => {
    const arr = readLs('cgui-pane-sessions', null);
    return Array.isArray(arr) ? arr[1] || null : null;
  })(),
  secondaryMessages: [],

  // In-flight subagent state keyed by the parent Task tool_use.id. Each entry:
  //   { id, name, description, status, startedAt,
  //     text: [], thinking: [], toolCalls: [], result }
  // App.jsx reader populates this; AgentMonitorPanel + TaskCard render it.
  activeAgents: {},
  viewingAgentByTab: {},  // #9/AZ6:per-tab 在主区打开的子代理 id(分屏隔离,原全局单值会让 A 的子代理占用 B 窗格)

  // 侧栏状态符号数据源:有活跃 chat-process 的 sessionId(转圈)+ 它们的 cwd(让
  // ProjectList 在任一会话运行时给项目转圈)。App 每 1.5s 轮询 /agents/active 写入;
  // setter 在内容不变时返回 {} 保持 Set 引用稳定,避免侧栏无谓重渲染。
  runningSessionIds: new Set(),
  runningCwds: new Set(),
  setRunningStatus: (ids, cwds) => set((s) => {
    const sameIds = s.runningSessionIds.size === ids.size && [...ids].every((x) => s.runningSessionIds.has(x));
    const sameCwds = s.runningCwds.size === cwds.size && [...cwds].every((x) => s.runningCwds.has(x));
    if (sameIds && sameCwds) return {};
    return {
      runningSessionIds: sameIds ? s.runningSessionIds : ids,
      runningCwds: sameCwds ? s.runningCwds : cwds,
    };
  }),

  // Message queue per session: { [sessionKey]: [{ text, attachments, queuedAt }] }
  // Keyed by sessionId (or 'draft' for unsent drafts). When user types during
  // streaming + clicks 入队, message goes here. handleSend pops the queue after
  // the current chat finishes.
  messageQueue: {},

  // Pending CLI permission requests waiting on the user. Each entry:
  //   { id, toolName, toolInput, sessionId, cwd, hookEvent, createdAt }
  // Populated by useWebSocket on `permission:request`. Removed when
  // /respond is called OR `permission:resolved` arrives (e.g. CLI exited).
  pendingPermissions: [],

  // 0.80 ~ 1.40, applied as `document.documentElement.style.zoom` on mount.
  // Use zoom (not html font-size) so px-hardcoded Tailwind classes also scale.
  uiFontScale: (() => {
    try {
      const v = parseFloat(localStorage.getItem('cgui-ui-font-scale') || '');
      if (Number.isFinite(v) && v >= 0.6 && v <= 2) return v;
    } catch {}
    return 1.2; // 默认"大"(用户偏好);仅当用户从未手动选过才生效
  })(),

  // "AI 思考中"加载动画样式(主题弹窗可选)。'cli' = 原 ASCII 帧 spinner(默认);
  // 其余对应 index.css 的 .loading-<id> 纯 CSS 动画(移植自 clawd-station)。
  loadingStyle: (() => {
    try { return localStorage.getItem('cgui-loading-style') || 'cli'; } catch { return 'cli'; }
  })(),

  // Theme as a (family, tone) pair. `cguiTheme` is the derived data-cgui-theme
  // variant id ('' = default Apple-system palette). themeTone drives data-theme.
  themeFamily: initThemeFamily(),
  themeTone: initThemeTone(),
  cguiTheme: resolveTheme(initThemeFamily(), initThemeTone()).cguiTheme,

  // Reading font for Claude's message prose (see FONT_OPTIONS).
  readingFont: initReadingFont(),

  loading: false,
  // Separate from `loading`: list refreshes (projects/sessions) must NOT flip
  // `loading`, because SessionDetail reads `loading` to show a full-screen
  // spinner over the CHAT. Sharing one flag meant every background sessions
  // refresh (file-watcher poll) or project fetch blanked the open conversation
  // — the "新建没反应 / 列表闪烁" bugs. `loading` is now message-view only.
  listLoading: false,
  error: null,
  searchQuery: '',
  sidebarCollapsed: !!readLs('cgui-sidebar-collapsed', false),

  // Actions
  setProjects: (projects) => set({ projects }),
  setSessions: (sessions) => set({ sessions }),
  setMessages: (messages) => set({ messages }),
  setCurrentModel: (model) => set({ currentModel: model }),
  setEffort: (e) => { set({ effort: e }); try { localStorage.setItem('cgui-effort', e); } catch {} },
  setAddDirs: (dirs) => { set({ addDirs: dirs }); writeLs('cgui-add-dirs', dirs); },
  // setPermissionMode(mode, key?) — when `key` is given, store it against that
  // session and also refresh the active mirror. Without a key it just sets the
  // global default (used before any session is active).
  setPermissionMode: (m, key) => {
    const mode = PERMISSION_MODES.includes(m) ? m : 'default';
    if (key) {
      const map = { ...get().permissionModeBySession, [key]: mode };
      writeLs('cgui-perm-mode-by-session', map);
      // 同 setModelFor:keyed 时不动全局,避免分屏跨窗格污染(显示靠 permissionModeBySession[key])。
      set({ permissionModeBySession: map });
    } else {
      set({ permissionMode: mode });
      writeLs('cgui-permission-mode', mode);
    }
    // W3②:该会话有正在运行的 CLI 回合时,经 server 向其 stdin 发
    // set_permission_mode control 消息 —— 模式切换对【当前回合】立即生效
    // (plan 模式切出当场停止规划)。draft key 无运行进程,server 找不到即 no-op。
    if (key && !String(key).startsWith('draft-')) {
      fetch('/api/chat/permission-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: key, mode }),
      }).catch(() => {});
    }
  },
  // Resolve the effective mode for a session key. An explicit per-session pick
  // wins; otherwise fall back to the last-used global mode (persisted to
  // localStorage) so the user's choice STICKS across page reloads and into new
  // drafts instead of resetting to 'default' on every refresh.
  getPermissionModeFor: (key) => {
    if (!key) return get().permissionMode || 'default';
    const map = get().permissionModeBySession || {};
    return map[key] || get().permissionMode || 'default';
  },
  // Per-session active agent / mode (BG5). Keyed like model/permission.
  setActiveAgentFor: (key, name) => {
    if (!key) return;
    const map = { ...get().activeAgentBySession };
    if (name) map[key] = name; else delete map[key];
    writeLs('cgui-agent-by-session', map);
    set({ activeAgentBySession: map });
  },
  getActiveAgentFor: (key) => {
    if (!key) return '';
    return (get().activeAgentBySession || {})[key] || '';
  },

  // Per-session model. No entry → global currentModel (the resolved default).
  // Does NOT write settings.json — a per-session pick must not change the CLI's
  // global default (which terminal use + cc switch rely on).
  setModelFor: (key, model) => {
    if (!model) return;
    if (key) {
      const map = { ...get().modelBySession, [key]: model };
      writeLs('cgui-model-by-session', map);
      // 只写本会话的钉选,不动全局 currentModel —— 否则分屏下在 A 窗格选模型会污染
      // 全局,未钉选的 B/C 窗格(尤其切过 provider、historyModel 被 epoch 门控失效后)
      // 回退到这个被改过的全局值 → 看起来"所有窗格共用模型"。单窗格显示靠 pinnedModel
      // (= modelBySession[key]) 已即时反映,无需写全局。与 setEffortFor 同构。
      set({ modelBySession: map });
    } else {
      set({ currentModel: model });
    }
  },
  getModelFor: (key) => (key && get().modelBySession[key]) || get().currentModel,
  // Drop every per-session model pin. Called on a provider switch: those pins
  // reference the OLD provider's models (and would otherwise mask the new
  // provider's default model + survive as invalid ids on the new backend).
  clearModelOverrides: () => {
    writeLs('cgui-model-by-session', {});
    // U1/U4:清 pin 的同时推进 provider 代际戳,使发送路径不再信任此前的历史模型。
    const now = Date.now();
    writeLs('cgui-provider-epoch', now);
    set({ modelBySession: {}, providerEpoch: now });
  },
  // U3/V1:记录 /context 实测结果(分子+分母),徽章优先采用。
  setCtxMeasured: (sessionId, payload) => set((s) => (
    sessionId && payload?.windowTokens > 0
      ? { ctxMeasuredBySession: { ...s.ctxMeasuredBySession, [sessionId]: { ...payload, ts: payload.ts || Date.now() } } }
      : s
  )),
  // AA1:存 /context 完整明细供弹层秒开。要求有 categories(否则无明细可显)。
  // 择优缓存:/context 是新 fork 出来的临时进程跑的,MCP 服务有时还没连上就快照(竞态),
  // 偶尔会拿到"类别更少"的退化结果(如缺 MCP、或第三方下塌成只剩 Skills+Messages)。
  // 后台探测多次,只要其中一次完整,就让它留住——退化结果不覆盖更完整的缓存。
  // (用户显式点刷新走 load() 的 setData,直接显示那次结果,不受此影响。)
  setCtxBreakdown: (sessionId, data) => set((s) => {
    if (!sessionId || !Array.isArray(data?.categories) || data.categories.length === 0) return s;
    // 拒绝不一致/空结果:/context 对刚压缩或瞬态会话偶尔返回 totalTokens=0 但 pct>0,
    // 缓存后弹层会显示"0 / 200k (25%)"这种自相矛盾的头部(用户报告 #1)。丢弃不缓存。
    if (!(data.totalTokens > 0)) return s;
    const realCats = (cats) => cats.filter((c) => !/free space/i.test(c.name)).length;
    const prev = s.ctxBreakdownBySession[sessionId];
    // 仅当新结果类别数 >= 旧缓存时才覆盖;更少则视为退化快照,保留旧的更完整版本。
    if (prev?.categories && realCats(data.categories) < realCats(prev.categories)) return s;
    return { ctxBreakdownBySession: { ...s.ctxBreakdownBySession, [sessionId]: { ...data, ts: Date.now() } } };
  }),
  // When a draft session (keyed `draft-<projectHash>`) gets its real CLI session
  // id, carry its per-session model + permission pins over to the new key. Without
  // this the pins orphan under the draft key, so the model the user picked for a
  // brand-new chat silently reverts to the global default once they navigate away
  // and back (the remount re-seeds currentModel from settings.json).
  // force=true:目标 key 已有值也覆盖。回滚首条消息(真 sid → draft)时,当前会话的
  // 显式模型/模式/力度选择必须赢过 draft-<项目> 里上一次草稿的残留值,否则迁移被
  // `toKey==null` 守卫跳过 → 回滚后恢复成残留/默认模型(#5)。
  migrateSessionKey: (fromKey, toKey, force = false) => {
    if (!fromKey || !toKey || fromKey === toKey) return;
    const patch = {};
    const mbs = get().modelBySession;
    if (mbs[fromKey] != null && (force || mbs[toKey] == null)) {
      const m = { ...mbs, [toKey]: mbs[fromKey] }; delete m[fromKey];
      writeLs('cgui-model-by-session', m); patch.modelBySession = m;
    }
    const pms = get().permissionModeBySession;
    if (pms[fromKey] != null && (force || pms[toKey] == null)) {
      const p = { ...pms, [toKey]: pms[fromKey] }; delete p[fromKey];
      writeLs('cgui-perm-mode-by-session', p); patch.permissionModeBySession = p;
    }
    // effort 也按会话隔离,draft→真 sessionId 时一并迁移,否则草稿里设的力度会丢。
    const ebs = get().effortBySession;
    if (ebs[fromKey] != null && (force || ebs[toKey] == null)) {
      const e2 = { ...ebs, [toKey]: ebs[fromKey] }; delete e2[fromKey];
      writeLs('cgui-effort-by-session', e2); patch.effortBySession = e2;
    }
    // BG5:活跃 Agent / 模式也按会话隔离,draft→真 sid 一并迁移,否则发送后模式开关回落"普通模式"。
    const abs = get().activeAgentBySession;
    if (abs[fromKey] != null && (force || abs[toKey] == null)) {
      const a = { ...abs, [toKey]: abs[fromKey] }; delete a[fromKey];
      writeLs('cgui-agent-by-session', a); patch.activeAgentBySession = a;
    }
    // Q2 修复:messageQueue 也按会话隔离,draft 期间排队的消息要随 init 后的真 sid 迁移。
    // 否则:用户在新会话连续发 A/B,A 时还是 draft → 进 messageQueue[draft-xxx];
    // init 拿到真 sid 后 sessionQueueKey 变,B 进 messageQueue[真sid];
    // UI 只渲染当前 key 的队列 → A 看起来"消失"了。
    const mq = get().messageQueue;
    if (Array.isArray(mq[fromKey]) && mq[fromKey].length) {
      const next = { ...mq };
      const merged = force ? mq[fromKey] : [...(mq[fromKey] || []), ...(mq[toKey] || [])];
      next[toKey] = merged;
      delete next[fromKey];
      patch.messageQueue = next;
    }
    if (Object.keys(patch).length) set(patch);
  },
  // Live-fetched model catalogue per provider (in-memory; re-fetched on reload).
  // Lets the official catalogue (incl. latest Opus) show automatically and SURVIVE
  // closing/reopening the picker instead of vanishing with the component's state.
  fetchedByProvider: {},
  setFetchedModels: (provider, models) => {
    if (!provider) return;
    set({ fetchedByProvider: { ...get().fetchedByProvider, [provider]: Array.isArray(models) ? models : [] } });
  },
  // User-defined model ids, persisted GUI-side and merged into the model list so
  // a typed-in custom id actually SHOWS as a selectable row (the server's
  // auto-enumeration only knows models from settings.json env + the provider's
  // config). Kept separate from availableModels because that array is replaced
  // wholesale on every /api/model fetch.
  customModels: readLs('cgui-custom-models', []),
  addCustomModel: (id) => {
    const v = String(id || '').trim();
    if (!v || get().customModels.includes(v)) return;
    const list = [...get().customModels, v];
    writeLs('cgui-custom-models', list);
    set({ customModels: list });
  },
  removeCustomModel: (id) => {
    const list = get().customModels.filter((m) => m !== id);
    writeLs('cgui-custom-models', list);
    set({ customModels: list });
  },
  // Mark/unmark a session as handed off to phone remote control.
  setRemoteControl: (sessionId, on) => {
    if (!sessionId) return;
    const map = { ...get().remoteControlled };
    if (on) map[sessionId] = true; else delete map[sessionId];
    set({ remoteControlled: map });
  },
  // Per-SESSION effort。'' 是合法值(CLI 默认)。key 为 sessionId 或 draft-<hash>。
  // 无 key 时写全局兜底 `effort`。与 setModelFor/setPermissionMode 同构,实现会话隔离。
  setEffortFor: (key, e) => {
    if (key) {
      const map = { ...get().effortBySession, [key]: e };
      writeLs('cgui-effort-by-session', map);
      set({ effortBySession: map });
    } else {
      set({ effort: e });
      try { localStorage.setItem('cgui-effort', e); } catch {}
    }
  },
  getEffortFor: (key) => {
    const map = get().effortBySession || {};
    return key && key in map ? map[key] : get().effort;
  },
  setGlobalRead: (v) => {
    set({ globalRead: !!v });
    writeLs('cgui-global-read', !!v);
  },
  setSelectedProject: (project) => {
    // Only switch which project's session list shows in the sidebar — do NOT
    // touch selectedSession or messages. User explicitly wants to browse other
    // projects' session lists while keeping the current chat in the right
    // panel running. The session detail only switches when user clicks a
    // session entry (setSelectedSession).
    set({ selectedProject: project });
    writeLs('cgui-selected-project', project);
  },
  setSelectedSession: (session) => {
    // Setting selectedSession also writes pane 0, keeping the mirror in sync.
    const panes = [...(get().paneSessions || [])];
    panes[0] = session;
    set({ selectedSession: session, paneSessions: panes });
    writeLs('cgui-selected-session', session);
    writeLs('cgui-pane-sessions', panes);
  },

  // Rename a session. Empty/whitespace title clears the override (reverts to
  // the auto firstPrompt). Optimistic local update (localStorage cache + state)
  // then pushed to the shared server store so the phone/Mac stay in sync.
  setCustomTitle: (sessionId, title) => {
    if (!sessionId) return;
    const next = { ...get().customTitles };
    const trimmed = (title || '').trim();
    if (trimmed) next[sessionId] = trimmed;
    else delete next[sessionId];
    writeLs('cgui-custom-titles', next);
    set({ customTitles: next });
    putCustomTitle(sessionId, trimmed);
  },

  // 写入 AI 自动标题。仅当该会话还没有自定义标题时生效(自定义优先)。
  // W4:同时推送服务端共享并广播 —— 否则标题只存生成端浏览器,其他端永远看不到。
  setAutoTitle: (sessionId, title) => {
    const t = (title || '').trim();
    if (!sessionId || !t) return;
    const next = { ...get().autoTitles, [sessionId]: t };
    writeLs('cgui-auto-titles', next);
    set({ autoTitles: next });
    fetch('/api/prefs/auto-titles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, title: t }),
    }).catch(() => {});
  },

  // W4:启动时从服务端水合自动标题;本地多出的旧条目合并并回推。
  hydrateAutoTitles: async () => {
    try {
      const res = await fetch('/api/prefs/auto-titles');
      const d = await res.json();
      const server = (d && d.titles && typeof d.titles === 'object') ? d.titles : {};
      const legacy = readLs('cgui-auto-titles', {}) || {};
      const merged = { ...legacy, ...server };
      writeLs('cgui-auto-titles', merged);
      set({ autoTitles: merged });
      for (const sid of Object.keys(legacy)) {
        if (!(sid in server)) {
          fetch('/api/prefs/auto-titles', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, title: legacy[sid] }),
          }).catch(() => {});
        }
      }
    } catch {}
  },

  // W4:应用服务端广播的自动标题全量 map。
  applyRemoteAutoTitles: (titles) => {
    const next = (titles && typeof titles === 'object') ? titles : {};
    writeLs('cgui-auto-titles', next);
    set({ autoTitles: next });
  },

  // Load the shared title map on startup. Server is the source of truth; any
  // legacy localStorage-only entries (from before the server move) are merged
  // and pushed up so they're not lost and reach the other device too.
  hydrateCustomTitles: async () => {
    try {
      const res = await fetch('/api/prefs/custom-titles');
      const d = await res.json();
      const server = (d && d.titles && typeof d.titles === 'object') ? d.titles : {};
      const legacy = readLs('cgui-custom-titles', {}) || {};
      const merged = { ...legacy, ...server };
      writeLs('cgui-custom-titles', merged);
      set({ customTitles: merged });
      for (const sid of Object.keys(legacy)) {
        if (!(sid in server)) putCustomTitle(sid, legacy[sid]);
      }
    } catch {}
  },

  // Apply a title map pushed from the server (ws 'custom-titles' broadcast).
  // Full replace — that's how a delete on the other device propagates here.
  applyRemoteTitles: (titles) => {
    const next = (titles && typeof titles === 'object') ? titles : {};
    writeLs('cgui-custom-titles', next);
    set({ customTitles: next });
  },

  // Record which provider a session last sent under (see lastProviderBySession).
  setLastProvider: (sessionId, providerHint) => {
    if (!sessionId || !providerHint) return;
    const cur = get().lastProviderBySession || {};
    if (cur[sessionId] === providerHint) return;
    const nextMap = { ...cur, [sessionId]: providerHint };
    writeLs('cgui-last-provider-by-session', nextMap);
    set({ lastProviderBySession: nextMap });
  },

  // BH-1b: ChatWise 式右侧停靠面板。全局单 dock(同一时刻只一个),纯内存不持久化。
  // { lang, code, tabIndex } | null。打开时分屏只渲聚焦窗格 + 右栏让位给 dock。
  artifactDock: null,
  openArtifactDock: (payload) => set({ artifactDock: payload }),
  closeArtifactDock: () => set({ artifactDock: null }),

  // ── Multi-pane actions (Phase 2) ───────────────────────────
  // Set how many panes are visible (1..6). Snaps activeTabIndex if it ends
  // up out of range. Persists so refresh restores the layout.
  setPaneCount: (n) => {
    const next = Math.max(1, Math.min(6, n | 0));
    const cur = get();
    writeLs('cgui-pane-count', next);
    const newActive = cur.activeTabIndex >= next ? 0 : cur.activeTabIndex;
    writeLs('cgui-active-tab-index', newActive);
    set({ paneCount: next, activeTabIndex: newActive, splitMode: next > 1 });
  },
  // Close one pane — splice it out (panes after shift left), paneCount--.
  // Sessions in closed panes are DROPPED from view only; their CLI processes
  // keep running. The sidebar's background-dot is how the user finds them
  // again.
  closePane: (i) => {
    const cur = get();
    if (cur.paneCount <= 1) {
      // Last pane: don't drop count to 0, just clear its session binding.
      const next = [...cur.paneSessions];
      next[0] = null;
      const nextMsgs = [...cur.paneMessages];
      nextMsgs[0] = [];
      // Fresh id so the now-empty pane's SessionDetail unmounts cleanly.
      const ids = [...cur.paneIds];
      ids[0] = freshPaneId();
      set({ paneSessions: next, paneMessages: nextMsgs, paneIds: ids, selectedSession: null, messages: [] });
      writeLs('cgui-selected-session', null);
      writeLs('cgui-pane-sessions', next);
      return;
    }
    const sessions = [...cur.paneSessions];
    const msgs = [...cur.paneMessages];
    const ids = [...cur.paneIds];
    // Splice (i) out then pad back to length 6 so index math stays stable.
    // paneIds splices in lockstep so surviving panes keep their React instance.
    sessions.splice(i, 1); sessions.push(null);
    msgs.splice(i, 1); msgs.push([]);
    ids.splice(i, 1); ids.push(freshPaneId());
    const newCount = cur.paneCount - 1;
    const newActive = cur.activeTabIndex >= newCount
      ? Math.max(0, newCount - 1)
      : cur.activeTabIndex;
    writeLs('cgui-pane-count', newCount);
    writeLs('cgui-pane-sessions', sessions);
    writeLs('cgui-active-tab-index', newActive);
    set({
      paneCount: newCount,
      // Keep splitMode derived (paneCount>1) in sync — without this, closing
      // 2→1 leaves splitMode stale-true so MainLayout keeps rendering the split
      // chrome around a single pane instead of collapsing to the default view.
      splitMode: newCount > 1,
      paneSessions: sessions,
      paneMessages: msgs,
      paneIds: ids,
      activeTabIndex: newActive,
      // pane 0 changed if we removed pane 0 — keep legacy mirrors current.
      selectedSession: sessions[0],
      messages: msgs[0] || [],
    });
  },
  // Tab-index setter, clamped.
  setActiveTabIndex: (i) => {
    const cur = get();
    const idx = Math.max(0, Math.min(cur.paneCount - 1, i | 0));
    writeLs('cgui-active-tab-index', idx);
    set({ activeTabIndex: idx });
  },
  // Write session to a specific pane. Pane 0 also updates the legacy
  // selectedSession mirror so reads outside SessionDetail keep working.
  setPaneSession: (i, session) => {
    const idx = Math.max(0, Math.min(5, i | 0));
    const sessions = [...get().paneSessions];
    sessions[idx] = session;
    writeLs('cgui-pane-sessions', sessions);
    const patch = { paneSessions: sessions };
    if (idx === 0) {
      patch.selectedSession = session;
      writeLs('cgui-selected-session', session);
    }
    // Mirror to legacy `secondarySession` (pane 1) so Phase-1-era reads work.
    if (idx === 1) patch.secondarySession = session;
    set(patch);
  },
  setPaneMessages: (i, messages) => {
    const idx = Math.max(0, Math.min(5, i | 0));
    const arr = [...get().paneMessages];
    arr[idx] = Array.isArray(messages) ? messages : [];
    const patch = { paneMessages: arr };
    if (idx === 0) patch.messages = arr[0];
    if (idx === 1) patch.secondaryMessages = arr[1];
    set(patch);
  },
  // ── Legacy Phase-1 aliases ─────────────────────────────────
  toggleSplitMode: () => {
    const cur = get();
    get().setPaneCount(cur.paneCount > 1 ? 1 : 2);
  },
  setSecondarySession: (session) => get().setPaneSession(1, session),
  setSecondaryMessages: (messages) => get().setPaneMessages(1, messages),
  // Writes a session into whichever pane is active. Used by SessionList click.
  setActiveTabSession: (session) => {
    const idx = get().activeTabIndex;
    get().setPaneSession(idx, session);
  },
  // Mark/unmark a session as having a live background CLI process. Drives
  // sidebar dots + top "运行中" badge.
  setBackgroundSession: (sessionId, pid) => {
    if (!sessionId) return;
    const cur = { ...get().backgroundSessions };
    if (pid) cur[sessionId] = pid;
    else delete cur[sessionId];
    set({ backgroundSessions: cur });
  },

  // ── Permission popup helpers ───────────────────────────────
  addPendingPermission: (req) => set((s) => {
    if (s.pendingPermissions.some((p) => p.id === req.id)) return s;
    return { pendingPermissions: [...s.pendingPermissions, req] };
  }),
  removePendingPermission: (id) => set((s) => ({
    pendingPermissions: s.pendingPermissions.filter((p) => p.id !== id),
  })),
  setPendingPermissions: (list) => set({ pendingPermissions: Array.isArray(list) ? list : [] }),
  // "本会话内永远允许 X" — write to localStorage so future incoming requests
  // for `toolName` under `sessionId` auto-resolve in useWebSocket without
  // popping the dialog.
  setLoadingStyle: (id) => {
    const v = String(id || 'cli');
    set({ loadingStyle: v });
    try { localStorage.setItem('cgui-loading-style', v); } catch {}
  },

  setUiFontScale: (v) => {
    const n = Math.max(0.6, Math.min(2, Number(v) || 1));
    set({ uiFontScale: n });
    try { localStorage.setItem('cgui-ui-font-scale', String(n)); } catch {}
    try {
      document.documentElement.style.zoom = String(n);
      // Mirror into a CSS var so the root container can size itself as
      // calc(100dvh / var(--ui-zoom)) — otherwise zoom>1 makes the page taller
      // than the viewport and the bottom composer scrolls off-screen.
      document.documentElement.style.setProperty('--ui-zoom', String(n));
    } catch {}
  },
  // Apply a (family, tone) pair: persists both, derives the variant id, and
  // syncs data-theme + data-cgui-theme on <html>. data-theme-system is handled
  // separately by the OS-preference listener (needed by the default family).
  setTheme: (familyId, tone) => {
    const { dataTheme, cguiTheme } = resolveTheme(familyId, tone);
    set({ themeFamily: familyId, themeTone: tone, cguiTheme });
    try {
      localStorage.setItem('cgui-theme-family', familyId);
      localStorage.setItem('cgui-theme', tone);
      localStorage.setItem('cgui-theme-preset', cguiTheme);
    } catch {}
    try {
      const root = document.documentElement;
      root.setAttribute('data-theme', dataTheme);
      if (cguiTheme) root.setAttribute('data-cgui-theme', cguiTheme);
      else root.removeAttribute('data-cgui-theme');
    } catch {}
  },
  // Reading font: persist + apply the --font-reading custom property.
  setReadingFont: (id) => {
    set({ readingFont: id });
    try { localStorage.setItem('cgui-reading-font', id); } catch {}
    applyReadingFont(id);
  },

  whitelistPermissionTool: (sessionId, toolName) => {
    try {
      const key = `cgui-perm-wl-${sessionId || 'none'}`;
      const cur = JSON.parse(localStorage.getItem(key) || '[]');
      if (!cur.includes(toolName)) cur.push(toolName);
      localStorage.setItem(key, JSON.stringify(cur));
    } catch {}
  },

  // ── Active subagent helpers ─────────────────────────────────
  upsertAgent: (id, patch) => set((s) => ({
    activeAgents: {
      ...s.activeAgents,
      [id]: { ...(s.activeAgents[id] || { id, text: [], thinking: [], toolCalls: [] }), ...patch },
    },
  })),
  appendAgentText: (id, delta) => set((s) => {
    const cur = s.activeAgents[id];
    if (!cur) return s;
    return { activeAgents: { ...s.activeAgents, [id]: { ...cur, text: [...cur.text, delta] } } };
  }),
  appendAgentThinking: (id, delta) => set((s) => {
    const cur = s.activeAgents[id];
    if (!cur) return s;
    return { activeAgents: { ...s.activeAgents, [id]: { ...cur, thinking: [...cur.thinking, delta] } } };
  }),
  appendAgentTool: (id, tc) => set((s) => {
    const cur = s.activeAgents[id];
    if (!cur) return s;
    return { activeAgents: { ...s.activeAgents, [id]: { ...cur, toolCalls: [...cur.toolCalls, tc] } } };
  }),
  updateAgentTool: (id, toolId, patch) => set((s) => {
    const cur = s.activeAgents[id];
    if (!cur) return s;
    return { activeAgents: { ...s.activeAgents, [id]: {
      ...cur,
      toolCalls: cur.toolCalls.map((tc) => tc.id === toolId ? { ...tc, ...patch } : tc),
    } } };
  }),

  // ── 后台任务(Bash run_in_background)──────────────────────────
  // keyed by tool_use id(创建时);result 到达后补 shellId + outputPath(供 tail)。
  // 后台 bash 的实时输出不进 stream,落盘到 outputPath,由 AgentMonitorPanel 轮询 tail。
  bgTasks: {},
  upsertBgTask: (id, patch) => set((s) => ({
    bgTasks: { ...s.bgTasks, [id]: { ...(s.bgTasks[id] || { id }), ...patch } },
  })),
  clearAgents: () => set({ activeAgents: {} }),
  // #9/AZ6 子代理会话窗口:按 tab 记录在主区打开查看的子代理 id(null = 看正常会话)。
  setViewingAgent: (tab, id) => set((s) => ({
    viewingAgentByTab: { ...s.viewingAgentByTab, [tab]: id || null },
  })),

  // ── Message queue helpers (#3) ──────────────────────────────
  enqueueMessage: (sessionKey, msg) => set((s) => {
    const list = s.messageQueue[sessionKey] || [];
    return { messageQueue: { ...s.messageQueue, [sessionKey]: [...list, msg] } };
  }),
  shiftMessage: (sessionKey) => {
    const list = useStore.getState().messageQueue[sessionKey] || [];
    if (list.length === 0) return null;
    const [head, ...rest] = list;
    useStore.setState((s) => ({ messageQueue: { ...s.messageQueue, [sessionKey]: rest } }));
    return head;
  },
  clearQueue: (sessionKey) => set((s) => {
    const next = { ...s.messageQueue };
    delete next[sessionKey];
    return { messageQueue: next };
  }),
  removeFromQueue: (sessionKey, index) => set((s) => {
    const list = s.messageQueue[sessionKey] || [];
    if (index < 0 || index >= list.length) return s;
    const next = [...list.slice(0, index), ...list.slice(index + 1)];
    return { messageQueue: { ...s.messageQueue, [sessionKey]: next } };
  }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  toggleSidebar: () => set((s) => {
    const collapsed = !s.sidebarCollapsed;
    writeLs('cgui-sidebar-collapsed', collapsed);
    return { sidebarCollapsed: collapsed };
  }),

  // Fetch projects
  fetchProjects: async () => {
    set({ listLoading: true, error: null });
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      const projects = Array.isArray(data) ? data : [];
      set({ projects, listLoading: false });
    } catch (err) {
      set({ projects: [], error: err.message, listLoading: false });
    }
  },

  // Fetch sessions for a project.
  // `silent` = true means a background refresh (e.g. after a chat just
  // finished) — don't flip the global `loading` flag, which causes
  // SessionDetail to swap to a breathing-dots screen mid-conversation and
  // makes the page feel like it's reloading.
  fetchSessions: async (projectHash, opts = {}) => {
    const silent = !!opts.silent;
    if (!silent) set({ listLoading: true, error: null });
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectHash)}/sessions`);
      const data = await res.json();
      // Treat non-array response (e.g. {error:"..."} from a 500) as empty.
      // Without this, on 500 `data` would still be a non-array object — we
      // already coerce to [], but earlier bugs let stale `sessions` linger
      // because the spread didn't include the key. The explicit `sessions: []`
      // below guarantees the list is reset for every project switch.
      const sessions = Array.isArray(data) ? data : [];
      set(silent ? { sessions } : { sessions, listLoading: false });
    } catch (err) {
      set(silent ? { sessions: [] } : { sessions: [], error: err.message, listLoading: false });
    }
  },

  // Fetch messages for a session.
  //   opts.silent  → don't toggle global loading (used by background refresh)
  //   opts.tab=1   → write into secondaryMessages instead of messages
  //                  (tab=1 always forces silent so tab 0 doesn't flash loader)
  fetchMessages: async (sessionId, projectHash, opts = {}) => {
    // tab 0..5 → write into paneMessages[tab] via setPaneMessages (which also
    // mirrors the legacy messages/secondaryMessages slots). Only tab 0 drives
    // the global loading flag; other panes load silently so they don't flash
    // the whole-screen loader.
    const tab = Number.isInteger(opts.tab) && opts.tab >= 0 && opts.tab <= 5 ? opts.tab : 0;
    const silent = !!opts.silent || tab !== 0;
    if (!silent) set({ loading: true, error: null });
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/messages?projectHash=${encodeURIComponent(projectHash)}`
      );
      // A missing / just-trimmed jsonl (404) or a server error must NOT blank the
      // pane: in split view a sibling pane showing the same reset session would
      // also re-fetch and go empty ("该会话没有可显示的消息" everywhere). Keep
      // whatever is there — a genuinely empty session still returns 200 + [].
      if (!res.ok) { if (!silent) set({ loading: false }); return; }
      const data = await res.json();
      const messages = Array.isArray(data) ? data : [];
      get().setPaneMessages(tab, messages);
      if (!silent) set({ loading: false });
    } catch (err) {
      // Network/parse failure — keep existing messages rather than blanking.
      if (!silent) set({ error: err.message, loading: false });
    }
  },

  // Fetch current model
  fetchModel: async () => {
    try {
      const res = await fetch('/api/model');
      const data = await res.json();
      set({ currentModel: data.model, availableModels: data.available || [] });
      // effort 显示:用户没在 GUI 显式选过(localStorage 空)时,用 settings.json 的默认
      // 思考强度(CLAUDE_CODE_EFFORT_LEVEL)显示,免得"settings 设了 high 却显示默认"。
      // 用户在 GUI 选过则尊重其选择(localStorage 有值,不覆盖)。
      try {
        if (!localStorage.getItem('cgui-effort') && data.defaultEffort) set({ effort: data.defaultEffort });
      } catch {}
    } catch {}
  },

  // Detect active provider (anthropic / deepseek / mimo / ...) from
  // ~/.claude/settings.json env. Used by pricing.js so cost is computed
  // against the real upstream, not the Claude-shaped display name.
  fetchProvider: async () => {
    try {
      const res = await fetch('/api/provider');
      const data = await res.json();
      if (data && data.providerHint) {
        set({ currentProvider: data });
      }
    } catch {}
  },

  // Set model (just updates local state, API call happens via ModelSelector)
  setModel: (modelId) => {
    set({ currentModel: modelId });
    // Persist to server
    fetch('/api/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
    }).catch(() => {});
  },
}));

// When following the system, a preset family's fixed palette must flip with the
// OS — re-resolve the variant id on every prefers-color-scheme change so React
// state, localStorage and the DOM stay consistent. (data-theme-system mirroring
// for the default family lives in main.jsx.)
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const s = useStore.getState();
    if (s.themeTone === 'auto') s.setTheme(s.themeFamily, 'auto');
  });
}
