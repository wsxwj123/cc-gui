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

// Valid `--permission-mode` values per `claude --help`.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

// ── Theme families ───────────────────────────────────────────────
// Each family carries a light + dark variant. `id` is the data-cgui-theme
// value (empty = default Apple-system palette driven purely by data-theme).
// bg/bg2/fg/accent are preview swatch colors for the theme popover cards.
export const THEME_FAMILIES = [
  { id: 'default', name: '默认',
    light: { id: '', bg: '#FAF9F5', bg2: '#ECE8DD', fg: '#141413', accent: '#D97757' },
    dark:  { id: '', bg: '#1F1D1A', bg2: '#161412', fg: '#F5F0E8', accent: '#E08A6B' } },
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
    light: { id: 'everforest-light', bg: '#F4F0D9', bg2: '#EFEBD4', fg: '#5C6A72', accent: '#8DA101' },
    dark:  { id: 'everforest-dark',  bg: '#374145', bg2: '#232A2E', fg: '#D3C6AA', accent: '#A7C080' } },
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
  // Default to 'default' (each tool call asks for permission via CLI built-in flow).
  // Users can switch to acceptEdits/bypassPermissions/plan from the header.
  // `permissionMode` is the value for the CURRENTLY active session (a mirror
  // kept in sync so existing `s.permissionMode` readers keep working).
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
  effortBySession: readLs('cgui-effort-by-session', {}),
  // User-defined session titles { [sessionId]: title }. When set, overrides the
  // auto firstPrompt everywhere the title shows (sidebar / header / breadcrumb).
  // We never touch the on-disk jsonl — titles live only in localStorage.
  customTitles: readLs('cgui-custom-titles', {}),
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
  // Pending text to drop into ChatInput's textarea (used by message rollback
  // "重新编辑" action). ChatInput watches this, sets its local text, clears.
  composerDraft: '',

  // In-flight subagent state keyed by the parent Task tool_use.id. Each entry:
  //   { id, name, description, status, startedAt,
  //     text: [], thinking: [], toolCalls: [], result }
  // App.jsx reader populates this; AgentMonitorPanel + TaskCard render it.
  activeAgents: {},

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
      const v = parseFloat(localStorage.getItem('cgui-ui-font-scale') || '1');
      if (Number.isFinite(v) && v >= 0.6 && v <= 2) return v;
    } catch {}
    return 1;
  })(),

  // Theme as a (family, tone) pair. `cguiTheme` is the derived data-cgui-theme
  // variant id ('' = default Apple-system palette). themeTone drives data-theme.
  themeFamily: initThemeFamily(),
  themeTone: initThemeTone(),
  cguiTheme: resolveTheme(initThemeFamily(), initThemeTone()).cguiTheme,

  // Reading font for Claude's message prose (see FONT_OPTIONS).
  readingFont: initReadingFont(),

  loading: false,
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
      writeLs('cgui-permission-mode', mode);
      set({ permissionModeBySession: map, permissionMode: mode });
    } else {
      set({ permissionMode: mode });
      writeLs('cgui-permission-mode', mode);
    }
  },
  // Resolve the effective mode for a session key. No entry → 'default' (NOT the
  // last-used global value — that's exactly the cross-session bleed we fixed).
  getPermissionModeFor: (key) => {
    if (!key) return get().permissionMode || 'default';
    const map = get().permissionModeBySession || {};
    return map[key] || 'default';
  },
  // Per-session model. No entry → global currentModel (the resolved default).
  // Does NOT write settings.json — a per-session pick must not change the CLI's
  // global default (which terminal use + cc switch rely on).
  setModelFor: (key, model) => {
    if (!model) return;
    if (key) {
      const map = { ...get().modelBySession, [key]: model };
      writeLs('cgui-model-by-session', map);
      set({ modelBySession: map, currentModel: model });
    } else {
      set({ currentModel: model });
    }
  },
  getModelFor: (key) => (key && get().modelBySession[key]) || get().currentModel,
  // Mark/unmark a session as handed off to phone remote control.
  setRemoteControl: (sessionId, on) => {
    if (!sessionId) return;
    const map = { ...get().remoteControlled };
    if (on) map[sessionId] = true; else delete map[sessionId];
    set({ remoteControlled: map });
  },
  // Per-session effort. '' is a valid value (CLI default), so use key presence.
  setEffortFor: (key, e) => {
    if (key) {
      const map = { ...get().effortBySession, [key]: e };
      writeLs('cgui-effort-by-session', map);
      set({ effortBySession: map, effort: e });
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
  // the auto firstPrompt). Persisted to localStorage.
  setCustomTitle: (sessionId, title) => {
    if (!sessionId) return;
    const next = { ...get().customTitles };
    const trimmed = (title || '').trim();
    if (trimmed) next[sessionId] = trimmed;
    else delete next[sessionId];
    writeLs('cgui-custom-titles', next);
    set({ customTitles: next });
  },

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
  setUiFontScale: (v) => {
    const n = Math.max(0.6, Math.min(2, Number(v) || 1));
    set({ uiFontScale: n });
    try { localStorage.setItem('cgui-ui-font-scale', String(n)); } catch {}
    try { document.documentElement.style.zoom = String(n); } catch {}
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
  clearAgents: () => set({ activeAgents: {} }),

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
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      const projects = Array.isArray(data) ? data : [];
      set({ projects, loading: false });
    } catch (err) {
      set({ projects: [], error: err.message, loading: false });
    }
  },

  // Fetch sessions for a project.
  // `silent` = true means a background refresh (e.g. after a chat just
  // finished) — don't flip the global `loading` flag, which causes
  // SessionDetail to swap to a breathing-dots screen mid-conversation and
  // makes the page feel like it's reloading.
  fetchSessions: async (projectHash, opts = {}) => {
    const silent = !!opts.silent;
    if (!silent) set({ loading: true, error: null });
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectHash)}/sessions`);
      const data = await res.json();
      // Treat non-array response (e.g. {error:"..."} from a 500) as empty.
      // Without this, on 500 `data` would still be a non-array object — we
      // already coerce to [], but earlier bugs let stale `sessions` linger
      // because the spread didn't include the key. The explicit `sessions: []`
      // below guarantees the list is reset for every project switch.
      const sessions = Array.isArray(data) ? data : [];
      set(silent ? { sessions } : { sessions, loading: false });
    } catch (err) {
      set(silent ? { sessions: [] } : { sessions: [], error: err.message, loading: false });
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
      const data = await res.json();
      const messages = Array.isArray(data) ? data : [];
      get().setPaneMessages(tab, messages);
      if (!silent) set({ loading: false });
    } catch (err) {
      get().setPaneMessages(tab, []);
      if (!silent) set({ error: err.message, loading: false });
    }
  },

  // Fetch current model
  fetchModel: async () => {
    try {
      const res = await fetch('/api/model');
      const data = await res.json();
      set({ currentModel: data.model, availableModels: data.available || [] });
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
