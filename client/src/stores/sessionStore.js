import { create } from 'zustand';
import { nextDockCode } from '../utils/artifactDock.js';
import { mergeSyncedMap, syncableKey, pushLocalOnlyKeys, createInFlightCounter, shouldMarkMigrated } from '../utils/sessionSync.js';
import { FONT_OPTIONS, readingFontCss } from '../utils/systemFonts.js';
import { createQueueId, firstDrainableIndex, isSteerBarrier, reclaimClaimItem, reconcileSteered, stripSteerState } from '../utils/steerQueue.js';
import { isValidContextResponse, shouldReplaceContextCache } from '../utils/contextCache.js';
import { reducePinned, initialExpandedProjects, toggleExpanded, mergeSessionList } from '../utils/projectPanel.js';

// Re-exported so existing importers (App.jsx) keep working; the list and its
// css-resolution logic now live in utils/systemFonts.js alongside the enumeration.
export { FONT_OPTIONS };

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
// 数组类字段:只防解析错不够,残留对象/字符串(旧版格式漂移/手改)会让 .filter/.map 崩(判官 B#4)。
const readLsArr = (key) => { const v = readLs(key, []); return Array.isArray(v) ? v : []; };

// r11-②:启动是否恢复上次会话(默认否 → 进 Home)。裸字符串旗标,非 JSON(与
// SettingsPanel 的 RestoreLastSessionToggle 同一 key/口径)。
const RESTORE_LAST_ON_BOOT = (() => {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('cgui-restore-last-session') === '1'; }
  catch { return false; }
})();

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

// 审计批A2:会话级偏好(权限档/模型 pin/力度 pin)同步提交器。fire-and-forget,
// 失败静默不崩 UI —— 挂载/重连的 GET 收敛是兜底。in-flight 记账(收尾#3 计数化,
// 同键两连改时第一个 PUT 的 finally 不再误摘第二个在途的保护标签):广播/水合期间
// 不覆盖正在提交中的键,防「刚点的选择被旧广播闪回」。
const syncInFlight = createInFlightCounter(); // tag = `${kind}:${sessionId}`
// 返回 Promise<boolean>(PUT 是否成功);现有 setter 调用点忽略返回值仍是
// fire-and-forget,首次迁移回推靠此判据门控 marker(低危#1)。
const putSessionSync = (kind, sessionId, value, { untracked = false } = {}) => {
  const tag = `${kind}:${sessionId}`;
  // outbox:先记账,ok 才清。seq 随记账拿到(untracked 的重放路径读当前 seq),
  // 响应回来只清"自己那次"的记账,过期响应不动新 pending。
  const seq = untracked ? pendingSeq.get(tag) : trackPending(kind, sessionId, value);
  syncInFlight.acquire(tag);
  return fetch('/api/prefs/session-sync', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, sessionId, value }),
  }).then((res) => { if (res.ok) clearPending(kind, sessionId, seq); return res.ok; })
    .catch(() => false).finally(() => syncInFlight.release(tag));
};

// ── 同步 outbox(调研③根修):同步 PUT 全是 fire-and-forget,写丢(开完开关立刻 Cmd+Q/
// 半死连接)服务端停留旧值,重启水合"服务端为准"把本地新值打回——1M 开关重启退回 200k
// 的根因。修法不是合并时猜新旧(无法区分"服务端没见过"与"对端已删除",会复活删除),
// 而是记账重放:写入先落 pending,PUT ok 才清;水合先重放 pending 再拉取,重放失败的键
// 合并时不被服务端覆盖。对端正常删除(其 PUT 成功,无 pending)不受影响。
const readPendingSync = () => readLs('cgui-sync-pending', {});
// 每 tag 一个单调 seq(内存态即可:pending 记账本身在 localStorage,seq 只用来识别
// "这条响应对应的是不是最后一次记账")。连拨竞态(判官重要项):1M 开→关,先发的
// "开"的 PUT 后回 ok,无值校验就把 pending 整条删了;此时后发的"关"若失败,已无人
// 重放 → 水合按服务端旧值把 UI 打回"开",正是 outbox 要根治的写丢在竞态窗口复活。
const pendingSeq = new Map();
const trackPending = (kind, sessionId, value) => {
  if (!sessionId) return null;
  const tag = `${kind}:${sessionId}`;
  const seq = (pendingSeq.get(tag) || 0) + 1;
  pendingSeq.set(tag, seq);
  const m = readPendingSync();
  m[tag] = value;
  writeLs('cgui-sync-pending', m);
  return seq;
};
// seq = 发请求时那次记账的序号;与当前不符 = 期间又写了新值,这条是过期响应,不清。
// (重放路径传发请求前读到的 seq;启动后从 localStorage 恢复的 pending 尚无 seq,
// 两侧同为 undefined 仍相等 → 照常清除,不回归。)
const clearPending = (kind, sessionId, seq) => {
  const tag = `${kind}:${sessionId}`;
  if (pendingSeq.get(tag) !== seq) return;
  const m = readPendingSync();
  // 不删 pendingSeq 条目:计数器必须对该 tag 单调递增。清空后重新从 1 起会让"刚清掉的
  // 那次"与"下一次记账"撞上同一个 seq,迟到的旧响应又能误清新 pending(每 tag 一个小整数,
  // 常驻内存开销可忽略)。
  if (tag in m) { delete m[tag]; writeLs('cgui-sync-pending', m); }
};
const pendingKeysOf = (kind) => new Set(
  Object.keys(readPendingSync()).filter((t) => t.startsWith(kind + ':')).map((t) => t.slice(kind.length + 1)),
);
// 重放全部 pending(context1m 走自己的端点,其余走 session-sync)。返回仍失败的 tag 集。
async function replayPendingSync() {
  const entries = Object.entries(readPendingSync());
  if (!entries.length) return new Set();
  const failed = new Set();
  await Promise.all(entries.map(async ([tag, value]) => {
    const i = tag.indexOf(':');
    const kind = tag.slice(0, i), sessionId = tag.slice(i + 1);
    const seq = pendingSeq.get(tag); // 重放期间用户又改了值 → 记账 seq 前移,重放的 ok 不清新 pending
    let ok = false;
    try {
      if (kind === 'context1m') {
        const r = await fetch('/api/prefs/context-1m', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, on: value === true }),
        });
        ok = r.ok;
      } else {
        ok = await putSessionSync(kind, sessionId, value, { untracked: true });
      }
    } catch {}
    if (ok) clearPending(kind, sessionId, seq); else failed.add(tag);
  }));
  return failed;
}

// Valid `--permission-mode` values per `claude --help`。
// P2.2:'auto' 为 SDK 原生自动档;是否显示由 useVisiblePermissionModes 门控
// (仅官方 Anthropic provider + 未记 auto-unavailable 标记)。
// 批O:'dontAsk'(不打扰)由服务端 autoDecide 模拟,不透传给 SDK(理由见 chat.js
// VALID_PERMISSION_MODES);对 provider 无要求,恒显示。
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

// A1:切档 POST 送达为止重试(仿 respondPermission:8s 短超时快失败,1s/2s/4s/8s 封顶
// 递增间隔)。裁决单点化后这条 POST 是切档生效+服务端重裁 pending 的唯一通道,半死连接
// 上 fire-and-forget 静默丢 = 切档不生效。
// 防乱序:每会话【串行化】—— 同会话永远只有一条在途请求;在途未 settle 时连切档只更新
// latestMode,在途 settle 后发现目标档已变再补发一次最新档。(cancelled 标志方案召不回
// 已发出的 fetch:快速连切 bypass→default 时旧 bypass 请求可在半死连接上迟到反超,
// slot.guiMode 错成 bypass、pending 被按 bypass 重裁全放行。串行化让新档必然在旧档
// settle 之后才发出,服务端按到达序处理即最终一致。)服务端对合法 body 恒 200(无活跃
// 进程也 ok/delivered:0),重试只在网络失败时发生,必然收敛。
// ponytail: 客户端 8s abort 后请求仍可能被服务端迟处理,残余乱序窗口极窄;真踩到再上服务端单调 seq。
const modePostFlights = new Map(); // sessionId → { latestMode }
async function postPermissionMode(sessionId, mode) {
  const inflight = modePostFlights.get(sessionId);
  if (inflight) { inflight.latestMode = mode; return; } // 在途循环 settle 后补发最新档
  const flight = { latestMode: mode };
  modePostFlights.set(sessionId, flight);
  try {
    let attempt = 0;
    // 逃逸口(判官 S4):无限重试没有终止条件——会话已删/服务端长死时循环空转一辈子。
    // 5 分钟上限:本地服务端真挂了整个 app 都不可用,到时未送达放弃即可(用户重切档会
    // 另起 flight;旧 flight 由 finally 清 Map,不挡新 flight)。
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const target = flight.latestMode;
      let delivered = false;
      try {
        const r = await fetch('/api/chat/permission-mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, mode: target }),
          signal: AbortSignal.timeout(8_000),
        });
        delivered = r.ok || r.status === 400; // 400=参数非法,重试无法自愈,视为终态
      } catch { /* 半死连接/超时,落到重试 */ }
      if (delivered) {
        if (flight.latestMode === target) return; // 送达且期间没再切档 → 收敛
        attempt = 0; // 期间又切了档:立即补发最新档,不背旧退避
        continue;
      }
      if (Date.now() > deadline) return;
      await new Promise((ok) => setTimeout(ok, Math.min(1_000 * 2 ** attempt, 8_000)));
      attempt++;
    }
  } finally {
    if (modePostFlights.get(sessionId) === flight) modePostFlights.delete(sessionId);
  }
}

// ── Theme families ───────────────────────────────────────────────
// Each family carries a light + dark variant. `id` is the data-cgui-theme
// value (empty = default Apple-system palette driven purely by data-theme).
// bg/bg2/fg/accent are preview swatch colors for the theme popover cards.
// r13-p2-4:展示名一律用中性描述词,不借用商标/产品名(Claude/OpenCode/GitHub/微信
// 等已改为色彩意象名)。id 保持不变 —— 已落 localStorage、prefs 与皮肤 manifest 的
// base 字段,改 id 会让用户已选主题与已装皮肤失配。
export const THEME_FAMILIES = [
  { id: 'default', name: '默认',
    light: { id: '', bg: '#FFFFFF', bg2: '#ECECEE', fg: '#1A1A1A', accent: '#1A1A1A' },
    dark:  { id: '', bg: '#1A1A1B', bg2: '#121213', fg: '#F5F5F6', accent: '#A0A0A6' } },
  // r11-⑧:全局默认扁平化后,原玻璃观感整体保留为独立主题家族。色值=默认主题
  // (variant 块只恢复形状 token:圆角/阴影/磨砂/透底,见 index.css shape 恢复块);
  // 28 套配色预设与形状正交:选其它任何家族一律扁平。
  { id: 'glass', name: '玻璃拟态(经典)',
    light: { id: 'glass-classic', bg: '#FFFFFF', bg2: '#ECECEE', fg: '#1A1A1A', accent: '#1A1A1A' },
    dark:  { id: 'glass-classic-dark', bg: '#1A1A1B', bg2: '#121213', fg: '#F5F5F6', accent: '#A0A0A6' } },
  { id: 'claude', name: '暖陶',
    light: { id: 'claude-warm', bg: '#F2EDE3', bg2: '#E2DBCC', fg: '#1A1A1A', accent: '#D97757' },
    dark:  { id: 'claude-dark', bg: '#29251F', bg2: '#161412', fg: '#F5F0E8', accent: '#D97757' } },
  { id: 'opencode', name: '炭橘',
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
  { id: 'github', name: '素笺',
    light: { id: 'github-light', bg: '#F6F8FA', bg2: '#EAEEF2', fg: '#24292F', accent: '#0969DA' },
    dark:  { id: 'github-dark',  bg: '#161B22', bg2: '#010409', fg: '#E6EDF3', accent: '#58A6FF' } },
  { id: 'flexoki', name: 'Flexoki',
    light: { id: 'flexoki-light', bg: '#F2F0E5', bg2: '#E6E4D9', fg: '#100F0F', accent: '#205EA6' },
    dark:  { id: 'flexoki-dark',  bg: '#1C1B1A', bg2: '#0A0908', fg: '#CECDC3', accent: '#4385BE' } },
  { id: 'wechat', name: '青碧',
    light: { id: 'wechat-light', bg: '#EDEDED', bg2: '#E3E3E3', fg: '#1A1A1A', accent: '#07C160' },
    dark:  { id: 'wechat-dark',  bg: '#1A1A1A', bg2: '#0D0D0D', fg: '#EDEDED', accent: '#07C160' } },
  { id: 'skyline', name: '晴空',
    light: { id: 'skyline-light', bg: '#EEF5FA', bg2: '#E4EFF6', fg: '#1F2E3A', accent: '#C8901E' },
    dark:  { id: 'skyline-dark',  bg: '#141E28', bg2: '#1C2A36', fg: '#E6EEF4', accent: '#F0C24E' } },
];

// Extra theme families registered at runtime by optional local-only widgets
// (client/src/components/*.local.jsx). Kept in a module array so the non-React
// helpers below (resolveTheme / initThemeFamily) can see them, and mirrored into
// store state (extraThemeFamilies) so the theme popover re-renders when one lands.
// Empty on a public build — no bundled family depends on it.
const extraThemeFamilies = [];
export function allThemeFamilies() { return THEME_FAMILIES.concat(extraThemeFamilies); }

export function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  catch { return false; }
}

// Resolve a family + tone to the concrete { dataTheme, cguiTheme } pair.
// tone 'auto' picks light/dark from the OS at call time; presets are fixed
// palettes so the variant id itself must flip (CSS can't auto-switch them).
export function resolveTheme(familyId, tone) {
  const fam = allThemeFamilies().find((f) => f.id === familyId) || THEME_FAMILIES[0];
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
    const m = allThemeFamilies().find((f) => f.light.id === preset || f.dark.id === preset);
    return m ? m.id : 'default';
  } catch { return 'default'; }
}
function initThemeTone() {
  try { return localStorage.getItem('cgui-theme') || 'auto'; }
  catch { return 'auto'; }
}

// ── Reading font (Claude message prose) ──────────────────────────
// Like Claude Desktop's font setting. FONT_OPTIONS (built-in presets) and the
// css-resolution live in utils/systemFonts.js; a stored value is either a preset
// id or an enumerated system family name (readingFontCss resolves both).
function initReadingFont() {
  try { return localStorage.getItem('cgui-reading-font') || 'newsreader'; }
  catch { return 'newsreader'; }
}
// Favorite fonts are per-device (each device enumerates its own families, so its
// favorites are its own too) — plain localStorage, never in the cross-device sync.
function initFavoriteFonts() {
  const v = readLs('cgui-font-favorites', []);
  return Array.isArray(v) ? v : [];
}
// Apply a reading-font value to the <html> --font-reading custom property.
export function applyReadingFont(id) {
  try { document.documentElement.style.setProperty('--font-reading', readingFontCss(id)); } catch {}
}

// Monotonic counter for fresh stable pane identity tokens (see paneIds).
let nextPaneId = 6;
const freshPaneId = () => `p${nextPaneId++}`;

// 子代理有序 blocks:末块同类型(text/thinking)则并入 content,否则新起一块。
// 因 append 按时序调用,可据此还原"思考→工具→思考"的先后(供 CoworkBlocks 渲染)。
function appendAgentBlock(blocks, type, delta) {
  const arr = Array.isArray(blocks) ? blocks : [];
  const last = arr[arr.length - 1];
  if (last && last.type === type) {
    return [...arr.slice(0, -1), { ...last, content: (last.content || '') + delta }];
  }
  return [...arr, { type, content: delta }];
}

const QUEUE_STORAGE_KEY = 'cgui-message-queue';
const rawQueueSnapshot = readLs(QUEUE_STORAGE_KEY, {});
const initialQueueMap = {};
if (rawQueueSnapshot && typeof rawQueueSnapshot === 'object' && !Array.isArray(rawQueueSnapshot)) {
  for (const [key, value] of Object.entries(rawQueueSnapshot)) {
    if (Array.isArray(value)) initialQueueMap[key] = value;
  }
}
const recoveredQueueMap = stripSteerState(initialQueueMap);

const persistQueueSnapshot = (messageQueue, verify = false) => {
  if (typeof localStorage === 'undefined') return true;
  try {
    const serialized = JSON.stringify(messageQueue);
    localStorage.setItem(QUEUE_STORAGE_KEY, serialized);
    return !verify || localStorage.getItem(QUEUE_STORAGE_KEY) === serialized;
  } catch { return false; }
};
persistQueueSnapshot(recoveredQueueMap);

export const useStore = create((set, get) => ({
  // Data
  projects: [],
  sessions: [],
  messages: [],
  currentModel: null,
  availableModels: [],
  modelEffortMeta: null, // r10-9:当前 provider 的 {modelId:{reasoning?,efforts?}},null=无声明全档可用
  // Live-detected backend (set by fetchProvider). When cc switch routes the
  // CLI's Claude-shaped API calls to deepseek/mimo/etc, this tells us the
  // real upstream so pricing.js can charge correctly. Defaults to anthropic.
  currentProvider: { providerHint: 'anthropic', baseUrl: '', model: null },
  // CLI session knobs. Persisted to localStorage so they survive reload.
  effort: (() => { try { return (typeof localStorage !== 'undefined' && localStorage.getItem('cgui-effort')) || ''; } catch { return ''; } })(),
  addDirs: readLsArr('cgui-add-dirs'),
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
  // 开了 1M 上下文的会话 { [sessionId]: true }。服务端持久化(prefs.json)+ 本地镜像:
  // [1m] 后缀只活在 modelBySession 的 pin 里,重装丢 localStorage 后历史消息恢复不了
  // 它(jsonl 的 model 字段不带后缀)→ 启动时从服务端水合,解析模型时兜底补回后缀。
  context1mBySession: readLs('cgui-context-1m', {}),
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
  // /context 精确缓存按 canonical key 隔离；requestEpoch 只负责生成实例内唯一请求代次。
  ctxBreakdownBySession: {},
  contextRequestEpoch: 0,
  contextCacheRevision: 0,
  // Sessions currently handed off to phone remote control (sessionId → true).
  // While set, the GUI must NOT spawn `-p` turns for that session (both would
  // write the same jsonl). The composer locks and shows a reclaim banner.
  remoteControlled: {},
  // When enabled, spawn includes `--add-dir $HOME` so Claude can READ any file
  // under the user's home directory by default. Writes/edits still require
  // permission (unless mode is bypassPermissions / acceptEdits).
  globalRead: readLs('cgui-global-read', true),

  // UI state — selectedProject persisted so refresh keeps the project context.
  // r11-②:selectedSession 的启动恢复改为默认关闭 —— 启动/刷新进 Home(首页新建
  // 会话形态),设置「启动时恢复上次会话」('cgui-restore-last-session'='1')保留旧
  // 行为。仅门控启动读取;运行期写入照旧,开着开关的下次启动仍能恢复。
  selectedProject: readLs('cgui-selected-project', null),
  selectedSession: RESTORE_LAST_ON_BOOT ? readLs('cgui-selected-session', null) : null,

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
  // r11-②:启动默认进 Home → 全窗格不恢复会话(与 selectedSession 同一开关门控;
  // 只恢复 pane 0 不恢复其余会造成分屏半恢复的怪态)。
  paneSessions: (() => {
    if (!RESTORE_LAST_ON_BOOT) return [null, null, null, null, null, null];
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
  // 串扰窗口1(跨会话串显根源):paneMessages 每格的归属 sessionId(draft/空=null)。
  // 切会话只换 paneSessions、fetch 异步回来前 paneMessages 仍是上个会话的 —— 渲染层
  // 据此标记同步判定"这份历史属于当前会话吗",不属于就当空数组,零窗口期。
  paneMessagesSid: [null, null, null, null, null, null],
  // 整会话用量聚合(keyed by sessionId,服务端随 /messages 端点返回)。按 sessionId
  // 而非 pane 索引存放 —— 分屏关窗/换绑不需要 splice 同步,同会话多窗格天然共享。
  usageTotalsBySession: {},
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

  // splitMode = 派生自 `paneCount > 1`,导出给按 `if (splitMode)` 分支的调用方(App.jsx 多处)。
  splitMode: (() => {
    const n = parseInt(readLs('cgui-pane-count', 1), 10);
    return Number.isFinite(n) && n > 1;
  })(),

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
  // 持久化(#6):队列只活内存时刷新/崩溃即丢(排队消息凭空消失)。init 从 localStorage
  // 读回,每次变更由文件尾 subscribe 镜像写入。崩溃后恢复 = 消息留在队列里等重发,
  // 不自动发送(自动发可能撞正在进行的回合)。
  messageQueue: recoveredQueueMap,

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

  // 对话区自定义背景(全局,localStorage 持久化)。null = 默认外观(完全维持现状)。
  // 形如 { kind:'color'|'image'|'video', color:'#RRGGBB', file:'uuid.png', maskOpacity:0-100 }。
  // maskOpacity = 遮罩不透明度:主题底色(--color-canvas)以该比例盖在背景上,保证文字可读。
  chatBackground: readLs('cgui-chat-background', null),

  // 界面不透明度(百分比 55~100)。缩放各玻璃面板 background 的 alpha,让全局背景
  // 图按需透出。100 = 各主题原始外观(默认,不改变现状)。per-device(localStorage),
  // 切主题不重置。运行时写 :root --surface-alpha(main.jsx 启动前也预置一次防闪)。
  surfaceAlpha: (() => {
    try {
      const v = parseInt(localStorage.getItem('cgui-surface-alpha') || '', 10);
      if (Number.isFinite(v) && v >= 55 && v <= 100) return v;
    } catch {}
    return 100;
  })(),

  // 缓存优化(CLI --exclude-dynamic-system-prompt-sections / SDK systemPrompt.excludeDynamicSections):
  // 把每轮变化的动态段(工作目录 / auto-memory / git 状态)移出系统提示、改注入首条用户消息,
  // 使系统提示保持静态、提升第三方 provider 的前缀缓存命中。三态:'auto'(默认,server 按
  // provider 定——第三方开/官方关)| true | false(用户显式)。旧值 '1'/'0' 原样迁移。
  excludeDynamicSystemPrompt: (() => {
    try {
      const v = localStorage.getItem('cgui-exclude-dynamic-prompt');
      return v === '1' ? true : v === '0' ? false : 'auto';
    } catch { return 'auto'; }
  })(),

  // 会话常驻进程(#26):回合结束后 CLI 进程保活,同会话下一条消息复用 —— 免掉每回合
  // 冷启动(二进制+settings+全部 MCP server,实测 ~5s)。默认开;出问题可在设置关掉
  // 回到逐回合冷启。
  persistentChat: (() => {
    try { return localStorage.getItem('cgui-persistent-chat') !== '0'; } catch { return true; }
  })(),

  // 花费上限(美元,localStorage):>0 时随每次发送传给 SDK 的 maxBudgetUsd,进程
  // 累计花费达到上限即停止并返回 error_max_budget_usd。null = 不限(默认)。
  maxBudgetUsd: (() => {
    try {
      const v = parseFloat(localStorage.getItem('cgui-max-budget-usd'));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  })(),

  // 输入预测:回合结束后 SDK 追发一条 prompt_suggestion(预测的下一条用户输入),
  // 在输入框上方显示为可点击的建议。默认开;可在设置关闭。
  promptSuggestions: (() => {
    try { return localStorage.getItem('cgui-prompt-suggestions') !== '0'; } catch { return true; }
  })(),

  // 收到的建议本身:{ [sessionId]: '建议文本' }。放 store 而非 SessionDetail 的 useState
  // ——建议在回合末到达,此时用户常已切走窗格/关掉分屏,组件 state 随卸载消失,切回来
  // 建议就没了;而 SSE 与 WS 兜底两条送达路径也需要同一个落点。按 sessionId(draft 期是
  // draft-key)存,渲染方按自己的 sid 取,不会跨窗格串。
  promptSuggestionBySid: {},


  // 聊天模式(全局,localStorage):开启后消息流只显示 AI 最终文本 + 用户消息,把
  // thinking / 工具 / 子代理 / skill 折叠成一行可点开的标记,像微信聊天。默认关。
  chatMode: (() => {
    try { return localStorage.getItem('cgui-chat-mode') === '1'; } catch { return false; }
  })(),

  // Theme as a (family, tone) pair. `cguiTheme` is the derived data-cgui-theme
  // variant id ('' = default Apple-system palette). themeTone drives data-theme.
  themeFamily: initThemeFamily(),
  themeTone: initThemeTone(),
  cguiTheme: resolveTheme(initThemeFamily(), initThemeTone()).cguiTheme,
  // Families registered at runtime by local widgets (empty on public builds).
  extraThemeFamilies: [],

  // Reading font for Claude's message prose (see FONT_OPTIONS).
  readingFont: initReadingFont(),
  // Favorited font keys (preset id or system family name), per-device.
  favoriteFonts: initFavoriteFonts(),

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
      // 审计批A2:偏好层跨设备同步(只影响下次 spawn 的档位;运行时切档仍走下方 POST)。
      if (syncableKey(key)) putSessionSync('permissionMode', key, mode);
    } else {
      set({ permissionMode: mode });
      writeLs('cgui-permission-mode', mode);
    }
    // W3②:该会话有正在运行的 CLI 回合时,经 server 向其 stdin 发
    // set_permission_mode control 消息 —— 模式切换对【当前回合】立即生效
    // (plan 模式切出当场停止规划)。draft key 无运行进程,server 找不到即 no-op。
    // A1 裁决单点化后,这条 POST 是"切档生效 + 服务端对 pending 重裁"的唯一通道,
    // 不能再 fire-and-forget 静默丢 → 送达为止重试(postPermissionMode)。
    if (key && !String(key).startsWith('draft-')) {
      postPermissionMode(key, mode);
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
      // [1m] 标记同步到服务端(pin 是唯一携带 [1m] 的地方,localStorage 重装即丢,
      // 服务端 prefs 兜底)。所有 pin 写入都流经这里=单一同步点;draft key 无稳定
      // sessionId 不同步(migrateSessionKey 落到真 sid 时补)。
      get().syncContext1m(key, model);
      // 审计批A2:模型 pin 跨设备同步(会话→模型映射,per-pane=per-会话语义不变)。
      if (syncableKey(key)) putSessionSync('modelPin', key, model);
    } else {
      set({ currentModel: model });
    }
  },
  // key 为真 sessionId 时,把该会话的 1M 开关状态(model 是否带 [1m])同步到
  // 本地镜像 + 服务端 /api/prefs/context-1m。状态没变不发请求。
  syncContext1m: (key, model) => {
    if (!key || key.startsWith('draft-')) return;
    const on = /\[1m\]/i.test(model || '');
    const cur = get().context1mBySession || {};
    if (!!cur[key] === on) return;
    const next = { ...cur };
    if (on) next[key] = true; else delete next[key];
    writeLs('cgui-context-1m', next);
    set({ context1mBySession: next });
    const seq = trackPending('context1m', key, on); // outbox:写丢可重放(重启退回 200k 的根修)
    fetch('/api/prefs/context-1m', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: key, on }),
    }).then((r) => { if (r.ok) clearPending('context1m', key, seq); }).catch(() => {});
  },
  // 启动水合:服务端为准,不回推。此前 legacy 合并回推无法区分「服务端删过该 key」
  // (对端关 1m/切 provider/删会话 GC)和「服务端没见过」——跨设备离线场景会把已删
  // 的旧 key 复活。context1m 只是模型 pin([1m] 后缀)的重装兜底副本,主数据是 pin;
  // 放弃回推最坏在「PUT 失败+随后清 localStorage」双重失败下丢兜底,pin 仍在。
  // fetch 失败(catch)保留本地镜像不覆盖。
  hydrateContext1m: async () => {
    try {
      // outbox 重放先行(调研③):本地有未送达的 1M 变更时先补写服务端,再拉取合并;
      // 重放仍失败的键保留本地值,不被服务端旧值打回(对端正常删除无 pending,不受影响)。
      const failedReplay = await replayPendingSync();
      const res = await fetch('/api/prefs/context-1m');
      const d = await res.json();
      const server = (d && d.sessions && typeof d.sessions === 'object') ? d.sessions : {};
      const local = get().context1mBySession || {};
      const merged = { ...server };
      for (const tag of failedReplay) {
        if (!tag.startsWith('context1m:')) continue;
        const k = tag.slice('context1m:'.length);
        if (local[k]) merged[k] = true; else delete merged[k];
      }
      writeLs('cgui-context-1m', merged);
      set({ context1mBySession: merged });
    } catch {}
  },
  // ws 'context-1m' 广播:全量替换(删除也要传播)。outbox 未送达的键除外(判官 S):
  // 本地刚改还没写进服务端时,旧广播不该把新状态闪回(与 applyRemoteSessionSync 同款 skip)。
  applyRemoteContext1m: (sessions) => {
    const incoming = (sessions && typeof sessions === 'object') ? sessions : {};
    const local = get().context1mBySession || {};
    const next = { ...incoming };
    for (const k of pendingKeysOf('context1m')) {
      if (local[k]) next[k] = true; else delete next[k];
    }
    writeLs('cgui-context-1m', next);
    set({ context1mBySession: next });
  },
  // 审计批A2:三张同步 map(权限档/模型 pin/力度 pin)的水合与广播收敛。
  // 服务端值优先于 localStorage;draft 键与服务端缺失的本地实键保留、提交中的键
  // 不被覆盖(合并规则见 utils/sessionSync.js)。正在流式中的会话不受影响 —— 这些
  // map 只在【发送时】被读取(getModelFor/getEffortFor/getPermissionModeFor),
  // 收敛不会改写已发出回合的参数,下一条消息才生效。providerEpoch 语义不变:
  // 同步来的 pin 与本地 pin 同一存放地,切 provider 的 clearModelOverrides(本地
  // fp 门控 + 服务端 clear)照常使其失效。
  applyRemoteSessionSync: (d, { pushLocalOnly = false } = {}) => {
    const specs = [
      ['permissionModes', 'permissionModeBySession', 'cgui-perm-mode-by-session', 'permissionMode'],
      ['modelPins', 'modelBySession', 'cgui-model-by-session', 'modelPin'],
      ['effortPins', 'effortBySession', 'cgui-effort-by-session', 'effortPin'],
    ];
    const patch = {};
    const pushes = []; // Promise<boolean>[];仅 pushLocalOnly 时非空,供 marker 门控
    for (const [srvKey, stateKey, lsKey, kind] of specs) {
      const server = (d && d[srvKey] && typeof d[srvKey] === 'object') ? d[srvKey] : {};
      const local = get()[stateKey] || {};
      const skip = new Set(
        syncInFlight.keys().filter((t) => t.startsWith(kind + ':')).map((t) => t.slice(kind.length + 1)),
      );
      // outbox 未送达的键同样不被服务端旧值覆盖(调研③:重放失败的键本地胜,下次水合再重放)。
      for (const k of pendingKeysOf(kind)) skip.add(k);
      const next = mergeSyncedMap(local, server, skip);
      // 首次水合:本地有而服务端没有的实键(本功能上线前的存量 pin)推上去,
      // 其他设备也能看到(同 hydrateCustomTitles 的 legacy 合并回推)。
      // 审计批收尾#1:只在初次迁移执行(hydrateSessionSync 以 marker 门控),
      // 键集计算见 pushLocalOnlyKeys 注释 —— 每次水合都回推会复活对端已清的旧键。
      if (pushLocalOnly) {
        for (const k of pushLocalOnlyKeys(local, server)) pushes.push(putSessionSync(kind, k, local[k]));
      }
      writeLs(lsKey, next);
      patch[stateKey] = next;
    }
    set(patch);
    return pushes; // 供 hydrateSessionSync 判断是否全部回推成功再置 marker
  },
  // 审计批收尾#1:pushLocalOnly 仅首次水合执行(localStorage marker),此后纯拉取。
  // 场景:设备 B 切 provider(本地清+服务端 clear modelPins)期间设备 A 离线;若 A
  // 每次重连都回推,本地残留的旧 provider pin 会重新填进服务端并广播回 B → 该会话
  // 下次发送旧模型 id 报 invalid model。离线期间本机新钉的 pin 不靠回推 —— setter
  // 的 fire-and-forget PUT 是主通道,丢了也会在用户下次操作时补写。
  // 低危#1:marker 只在「回推批次全部成功 settle」后置位 —— 此前 GET 成功即置位,
  // 但回推 PUT 若全失败(离线/5xx),存量键就此只留本机、再不回推。改为整批成功才
  // 置位,任一失败不置位、下次重连重试整批(空批=无存量键 → 视为成功直接置位)。
  hydrateSessionSync: async () => {
    try {
      await replayPendingSync(); // outbox 重放先行(调研③):未送达的 pin/档位先补写再拉取
      const res = await fetch('/api/prefs/session-sync');
      const d = await res.json();
      const migrated = readLs('cgui-session-sync-migrated', false);
      const pushes = get().applyRemoteSessionSync(d, { pushLocalOnly: !migrated });
      if (!migrated) {
        const results = await Promise.all(pushes || []);
        if (shouldMarkMigrated(results)) writeLs('cgui-session-sync-migrated', true);
      }
    } catch {}
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
    // 1M 标记随 pin 一起清(切 provider 语义:旧 provider 的 1M 支持不可假设迁移),
    // 服务端全表同步清空,否则水合兜底会把 [1m] 又补回来。
    writeLs('cgui-context-1m', {});
    set({ modelBySession: {}, providerEpoch: now, context1mBySession: {} });
    fetch('/api/prefs/context-1m', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    }).catch(() => {});
    // 审计批A2:服务端同步表的模型 pin 一并清,否则下次水合把旧 provider 的 pin 又拉回来。
    fetch('/api/prefs/session-sync', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: 'modelPins' }),
    }).catch(() => {});
  },
  // U3/V1:记录 /context 实测结果(分子+分母),徽章优先采用。
  setCtxMeasured: (sessionId, payload) => set((s) => (
    sessionId && payload?.windowTokens > 0
      ? { ctxMeasuredBySession: { ...s.ctxMeasuredBySession, [sessionId]: { ...payload, ts: payload.ts || Date.now() } } }
      : s
  )),
  nextContextRequestEpoch: () => {
    let epoch = 0;
    set((s) => { epoch = s.contextRequestEpoch + 1; return { contextRequestEpoch: epoch }; });
    return epoch;
  },
  setCtxBreakdown: (canonicalKey, data, requestEpoch) => set((s) => {
    if (!canonicalKey || !isValidContextResponse(data)) return s;
    const previous = s.ctxBreakdownBySession[canonicalKey];
    if (!shouldReplaceContextCache(previous, data, requestEpoch)) return s;
    return {
      ctxBreakdownBySession: {
        ...s.ctxBreakdownBySession,
        [canonicalKey]: { ...data, requestEpoch },
      },
    };
  }),
  clearContextExactCache: () => set((s) => ({
    ctxBreakdownBySession: {},
    contextCacheRevision: s.contextCacheRevision + 1,
  })),
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
      // draft 期开的 [1m] 落到真 sessionId 时补同步服务端标记(draft key 不同步)。
      get().syncContext1m(toKey, mbs[fromKey]);
      // 审计批A2:draft 期钉的模型落到真 sid 时补推同步表。
      if (syncableKey(toKey)) putSessionSync('modelPin', toKey, mbs[fromKey]);
    }
    const pms = get().permissionModeBySession;
    if (pms[fromKey] != null && (force || pms[toKey] == null)) {
      const p = { ...pms, [toKey]: pms[fromKey] }; delete p[fromKey];
      writeLs('cgui-perm-mode-by-session', p); patch.permissionModeBySession = p;
      if (syncableKey(toKey)) putSessionSync('permissionMode', toKey, pms[fromKey]);
    }
    // effort 也按会话隔离,draft→真 sessionId 时一并迁移,否则草稿里设的力度会丢。
    const ebs = get().effortBySession;
    if (ebs[fromKey] != null && (force || ebs[toKey] == null)) {
      const e2 = { ...ebs, [toKey]: ebs[fromKey] }; delete e2[fromKey];
      writeLs('cgui-effort-by-session', e2); patch.effortBySession = e2;
      if (syncableKey(toKey)) putSessionSync('effortPin', toKey, ebs[fromKey]);
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
      // 与 routing.migrateDraftQueue 同口径:按 queuedAt 升序合并(无 queuedAt 按 0 兜底),
      // 不依赖拼接方向 —— 保证先发先入队的消息先出队,两条迁移路径行为一致。
      const merged = force ? mq[fromKey] : [...(mq[fromKey] || []), ...(mq[toKey] || [])].sort((a, b) => (a?.queuedAt || 0) - (b?.queuedAt || 0));
      next[toKey] = merged;
      delete next[fromKey];
      patch.messageQueue = next;
    }
    // 判官重要2②:draft 阶段 upsert 的子代理/后台任务条目的 sessionId 是 draft-<hash> 键
    // (App.jsx streamOwnerSid draft 回落),init 后必须随真 sid 迁移 —— 否则清理路径
    // (finalizeSessionAgents 按真 sid 严格相等扫)永远扫不到 → 残留 + 监控幽灵条目。
    const aas = get().activeAgents;
    if (aas && Object.values(aas).some((ag) => ag && ag.sessionId === fromKey)) {
      const next = {};
      for (const [id, ag] of Object.entries(aas)) {
        next[id] = (ag && ag.sessionId === fromKey) ? { ...ag, sessionId: toKey } : ag;
      }
      patch.activeAgents = next;
    }
    const bgs = get().bgTasks;
    if (bgs && Object.values(bgs).some((t) => t && t.sessionId === fromKey)) {
      const next = {};
      for (const [id, t] of Object.entries(bgs)) {
        next[id] = (t && t.sessionId === fromKey) ? { ...t, sessionId: toKey } : t;
      }
      patch.bgTasks = next;
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
  customModels: readLsArr('cgui-custom-models'),
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
      // 审计批A2:力度 pin 跨设备同步('' 是合法档位「默认」,服务端按值存不删)。
      if (syncableKey(key)) putSessionSync('effortPin', key, e);
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

  // r13-②:侧栏分组/排序视图(prefs.sidebarView,多端共享;展开态留 localStorage)。
  sidebarView: { groupMode: 'project', sortMode: 'recent', projectOrder: [] },
  hydrateSidebarView: async () => {
    try {
      const d = await (await fetch('/api/prefs/sidebar-view')).json();
      if (d && typeof d === 'object') set({ sidebarView: { groupMode: d.groupMode || 'project', sortMode: d.sortMode || 'recent', projectOrder: Array.isArray(d.projectOrder) ? d.projectOrder : [] } });
    } catch {}
  },
  applyRemoteSidebarView: (v) => {
    if (v && typeof v === 'object') set({ sidebarView: { groupMode: v.groupMode || 'project', sortMode: v.sortMode || 'recent', projectOrder: Array.isArray(v.projectOrder) ? v.projectOrder : [] } });
  },
  putSidebarView: async (patch) => {
    set((s) => ({ sidebarView: { ...s.sidebarView, ...patch } })); // 乐观,回包/广播校准
    try {
      const r = await fetch('/api/prefs/sidebar-view', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const d = await r.json();
      if (r.ok) set({ sidebarView: { groupMode: d.groupMode, sortMode: d.sortMode, projectOrder: d.projectOrder } });
    } catch {}
  },

  // r11-⑫:称呼(prefs.displayName,服务端多端共享)。启动/重连水合 + WS 广播收敛;
  // 写走 PUT(服务端截 20 去空白),本地乐观更新以服务端回包为准。
  displayName: '',
  hydrateDisplayName: async () => {
    try {
      const res = await fetch('/api/prefs/display-name');
      const d = await res.json();
      if (typeof d?.displayName === 'string') set({ displayName: d.displayName });
    } catch {}
  },
  applyRemoteDisplayName: (name) => {
    set({ displayName: typeof name === 'string' ? name : '' });
  },
  putDisplayName: async (name) => {
    const next = typeof name === 'string' ? name.trim().slice(0, 20) : '';
    set({ displayName: next });
    try {
      const res = await fetch('/api/prefs/display-name', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: next }),
      });
      const d = await res.json();
      if (res.ok && typeof d?.displayName === 'string') set({ displayName: d.displayName });
    } catch {}
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
  // #3 流式回写:内联块每 token 拿到新 code 同步进 dock,让停靠面板随流式实时刷新(不冻结在
  // 点击瞬间快照)。双闸短路:仅"正被停靠的那个 artifact(id 匹配)"且"code 真变了"才 set,
  // 防流式每 token 空 setState 风暴。
  updateArtifactDockCode: (id, code) => set((s) => {
    const next = nextDockCode(s.artifactDock, id, code);
    return next === s.artifactDock ? {} : { artifactDock: next };
  }),

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
      const nextSids = [...cur.paneMessagesSid];
      nextSids[0] = null;
      // Fresh id so the now-empty pane's SessionDetail unmounts cleanly.
      const ids = [...cur.paneIds];
      ids[0] = freshPaneId();
      set({ paneSessions: next, paneMessages: nextMsgs, paneMessagesSid: nextSids, paneIds: ids, selectedSession: null, messages: [] });
      writeLs('cgui-selected-session', null);
      writeLs('cgui-pane-sessions', next);
      get().reclaimOrphanClaimDrafts(); // ②旧 pane id 已被换掉,回收指向它的 claim 槽
      return;
    }
    const sessions = [...cur.paneSessions];
    const msgs = [...cur.paneMessages];
    const sids = [...cur.paneMessagesSid];
    const ids = [...cur.paneIds];
    // Splice (i) out then pad back to length 6 so index math stays stable.
    // paneIds splices in lockstep so surviving panes keep their React instance.
    // paneMessagesSid 同步 splice —— 错位会让幸存窗格的历史被归属守卫误藏/误显。
    sessions.splice(i, 1); sessions.push(null);
    msgs.splice(i, 1); msgs.push([]);
    sids.splice(i, 1); sids.push(null);
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
      paneMessagesSid: sids,
      paneIds: ids,
      activeTabIndex: newActive,
      // pane 0 changed if we removed pane 0 — keep legacy mirrors current.
      selectedSession: sessions[0],
      messages: msgs[0] || [],
    });
    get().reclaimOrphanClaimDrafts(); // ②被关 pane 的 id 已出列,回收指向它的 claim 槽
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
    set(patch);
  },
  // sid = 这批消息归属的 sessionId(draft/清空传 null,fetchMessages 传拉取的 sid)。
  // 渲染层按 paneMessagesSid[i] === 当前会话 sid 决定可见性(串扰窗口1守卫)。
  setPaneMessages: (i, messages, sid = null) => {
    const idx = Math.max(0, Math.min(5, i | 0));
    const arr = [...get().paneMessages];
    arr[idx] = Array.isArray(messages) ? messages : [];
    const sids = [...get().paneMessagesSid];
    sids[idx] = sid || null;
    const patch = { paneMessages: arr, paneMessagesSid: sids };
    if (idx === 0) patch.messages = arr[0];
    set(patch);
  },
  // draft→真 sid 升级(init 绑定点):pane 里 draft 期的历史(空数组)归属从 null 升级为
  // 真 sid,避免绑定后、首次 fetch 回来前,归属守卫把活会话误判成"别人的"而藏空。
  claimPaneMessages: (i, sid) => {
    const idx = Math.max(0, Math.min(5, i | 0));
    const sids = [...get().paneMessagesSid];
    if (sids[idx] === (sid || null)) return;
    // 契约自守:槽位已归属别的真 sid(非 draft 空槽)→ 说明某个重置点漏清了消息,
    // 直接认领会把旧会话内容污染进新会话。此时清空消息再认领(setPaneMessages
    // 同时写 arr+sid+pane0 镜像),以后新增重置点漏清也被这里兜住。
    if (sids[idx] !== null) { get().setPaneMessages(idx, [], sid || null); return; }
    sids[idx] = sid || null;
    set({ paneMessagesSid: sids });
  },
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

  // ── 已停会话表(sid → 停止时刻) ─────────────────────────────
  // 主会话被用户停止/删除/杀进程时记录。监控页 workflow 内层 agent 的状态来自服务端
  // 扫 jsonl mtime(只有 done/running/idle,无 stopped 态)——停止后进程已死但 mtime
  // 在存活窗内仍判 running,监控页据此表覆盖显示"已停止"。同 sid 新回合开始时清除。
  stoppedSessions: {},
  markSessionStopped: (sid) => set((s) => (
    sid && !s.stoppedSessions[sid] ? { stoppedSessions: { ...s.stoppedSessions, [sid]: Date.now() } } : s
  )),
  clearSessionStopped: (sid) => set((s) => {
    if (!sid || !s.stoppedSessions[sid]) return s;
    const n = { ...s.stoppedSessions };
    delete n[sid];
    return { stoppedSessions: n };
  }),

  // ── Permission popup helpers ───────────────────────────────
  addPendingPermission: (req) => set((s) => {
    if (s.pendingPermissions.some((p) => p.id === req.id)) return s;
    // A2:进本地列表时打【客户端时钟】戳 receivedAt。对账 remove 判据用它与本机
    // fetchStart 比较(同钟可比);request.createdAt 是服务端时钟,跨机漂移时会把
    // GET 飞行窗口内刚广播的新卡误判为"早于拉取"而误删。所有入列路径(WS 广播/
    // 对账补拉/水合)都经这里,天然全覆盖。展开序保留调用方显式传入的 receivedAt
    // (仅单测构造场景用)。
    return { pendingPermissions: [...s.pendingPermissions, { receivedAt: Date.now(), ...req }] };
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


  setPersistentChat: (on) => {
    set({ persistentChat: !!on });
    try { localStorage.setItem('cgui-persistent-chat', on ? '1' : '0'); } catch {}
  },

  setMaxBudgetUsd: (v) => {
    const n = parseFloat(v);
    const val = Number.isFinite(n) && n > 0 ? n : null;
    set({ maxBudgetUsd: val });
    try {
      if (val) localStorage.setItem('cgui-max-budget-usd', String(val));
      else localStorage.removeItem('cgui-max-budget-usd');
    } catch {}
  },

  setPromptSuggestions: (on) => {
    set({ promptSuggestions: !!on });
    try { localStorage.setItem('cgui-prompt-suggestions', on ? '1' : '0'); } catch {}
  },

  // 建议入位。SSE(流内)与 WS 兜底(prompt-suggestion-bg)都调这里:同一条建议两条
  // 路径都到时内容相等 → 直接返回,不重复 set(免多余渲染,也就无所谓谁先谁后)。
  setPromptSuggestionFor: (sid, text) => {
    const s = String(text || '').trim();
    if (!sid || !s) return;
    const cur = get().promptSuggestionBySid;
    if (cur[sid] === s) return;
    set({ promptSuggestionBySid: { ...cur, [sid]: s } });
  },

  // 清除(发新回合作废上一条 / 用户手动关掉)。一个会话在 draft 期与拿到真 id 后有两个
  // key,故收变长参数一次清干净。
  clearPromptSuggestion: (...sids) => {
    const cur = get().promptSuggestionBySid;
    const hit = sids.filter((k) => k && k in cur);
    if (!hit.length) return;
    const next = { ...cur };
    for (const k of hit) delete next[k];
    set({ promptSuggestionBySid: next });
  },


  setExcludeDynamicSystemPrompt: (v) => {
    // v: 'auto' | true | false('auto' = server 按 provider 决定:第三方开/官方关)
    set({ excludeDynamicSystemPrompt: v === true ? true : v === false ? false : 'auto' });
    try {
      if (v === true) localStorage.setItem('cgui-exclude-dynamic-prompt', '1');
      else if (v === false) localStorage.setItem('cgui-exclude-dynamic-prompt', '0');
      else localStorage.removeItem('cgui-exclude-dynamic-prompt');
    } catch {}
  },

  setChatMode: (on) => {
    set({ chatMode: !!on });
    try { localStorage.setItem('cgui-chat-mode', on ? '1' : '0'); } catch {}
  },

  // 对话区自定义背景。传 null 恢复默认;对象整体替换(引用变更触发订阅组件重渲)。
  setChatBackground: (bg) => {
    const v = bg && bg.kind ? bg : null;
    set({ chatBackground: v });
    writeLs('cgui-chat-background', v);
  },

  // 界面不透明度设置(55~100)。写 store + localStorage + :root --surface-alpha(带 %)。
  setSurfaceAlpha: (v) => {
    const n = Math.max(55, Math.min(100, Math.round(Number(v) || 100)));
    set({ surfaceAlpha: n });
    try {
      localStorage.setItem('cgui-surface-alpha', String(n));
      document.documentElement.style.setProperty('--surface-alpha', n + '%');
    } catch {}
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
  // Runtime theme-family registration for optional local widgets. Pushes into
  // the module array (so resolveTheme sees it) + store state (so the popover
  // re-renders). If the just-registered family is the one already selected
  // (e.g. restored from localStorage before the widget loaded), re-apply so the
  // data-cgui-theme attribute is corrected. Idempotent by id.
  registerThemeFamily: (fam) => {
    if (!fam || !fam.id) return;
    if (extraThemeFamilies.some((f) => f.id === fam.id)) return;
    extraThemeFamilies.push(fam);
    set({ extraThemeFamilies: [...extraThemeFamilies] });
    const s = get();
    if (s.themeFamily === fam.id) s.setTheme(fam.id, s.themeTone);
  },
  // Reading font: persist + apply the --font-reading custom property.
  setReadingFont: (id) => {
    set({ readingFont: id });
    try { localStorage.setItem('cgui-reading-font', id); } catch {}
    applyReadingFont(id);
  },
  // Toggle a font as favorite (bubbles to the top of the picker). Per-device.
  toggleFavoriteFont: (key) => {
    const cur = get().favoriteFonts;
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    set({ favoriteFonts: next });
    writeLs('cgui-font-favorites', next);
  },

  whitelistPermissionTool: (sessionId, toolName) => {
    // 守卫下沉:draft(sessionId 为 null/undefined/空串)直接不写 —— 旧的 `|| 'none'` 兜底
    // 会落到共享键 cgui-perm-wl-none,任何 draft 的同名工具都会被 auto-allow 误放行。
    // 读取侧(useWebSocket / PermissionPrompt)已对称地不读该共享键。
    if (!sessionId) return;
    try {
      const key = `cgui-perm-wl-${sessionId}`;
      const cur = JSON.parse(localStorage.getItem(key) || '[]');
      if (!cur.includes(toolName)) cur.push(toolName);
      localStorage.setItem(key, JSON.stringify(cur));
    } catch {}
  },

  // ── Active subagent helpers ─────────────────────────────────
  // 除旧的三数组(text/thinking/toolCalls,result 兜底/isStreaming 判定仍读)外,
  // 维护一份有序 `blocks`(与主会话 orderedBlocks 同形 {type,content|toolCall}[]),
  // 喂给 CoworkBlocks 与母会话共用同一套 cowork 渲染(§1.5)。因 append 调用本就按
  // 时序到达,直接在 reducer 里"末块同类型则并入、否则新起一块"即可重建时序,
  // App.jsx 两条子代理路径(stream_event / 整块 assistant)无需改动。
  upsertAgent: (id, patch) => set((s) => ({
    activeAgents: {
      ...s.activeAgents,
      [id]: { ...(s.activeAgents[id] || { id, text: [], thinking: [], toolCalls: [], blocks: [] }), ...patch },
    },
  })),
  appendAgentText: (id, delta) => set((s) => {
    const cur = s.activeAgents[id];
    if (!cur) return s;
    return { activeAgents: { ...s.activeAgents, [id]: { ...cur, text: [...cur.text, delta], blocks: appendAgentBlock(cur.blocks,'text', delta) } } };
  }),
  appendAgentThinking: (id, delta) => set((s) => {
    const cur = s.activeAgents[id];
    if (!cur) return s;
    return { activeAgents: { ...s.activeAgents, [id]: { ...cur, thinking: [...cur.thinking, delta], blocks: appendAgentBlock(cur.blocks,'thinking', delta) } } };
  }),
  appendAgentTool: (id, tc) => set((s) => {
    const cur = s.activeAgents[id];
    if (!cur) return s;
    return { activeAgents: { ...s.activeAgents, [id]: { ...cur, toolCalls: [...cur.toolCalls, tc], blocks: [...(cur.blocks || []), { type: 'tool_use', toolCall: tc }] } } };
  }),
  updateAgentTool: (id, toolId, patch) => set((s) => {
    const cur = s.activeAgents[id];
    if (!cur) return s;
    return { activeAgents: { ...s.activeAgents, [id]: {
      ...cur,
      toolCalls: cur.toolCalls.map((tc) => tc.id === toolId ? { ...tc, ...patch } : tc),
      blocks: (cur.blocks || []).map((b) => (b.type === 'tool_use' && b.toolCall?.id === toolId) ? { ...b, toolCall: { ...b.toolCall, ...patch } } : b),
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
  // 部件①单卡精确停止:停某一个子代理/teammate。做成 store action 而非 App handler+props——
  // TaskCard 深嵌在 TurnBubble(3 处渲染)下,透传要改 TurnBubble(不在方案文件清单里),
  // 且卡片本就自带 fetch+getState 直调风格(见 TaskCard.openAgentView)。
  //   1. 乐观收尾:非终态目标即刻标 stopped(第三方 provider 不发 task_notification 也能收敛);
  //      保留 taskManaged,真权威终态到达时 finalizeAgent(authoritative) 仍可覆盖为真实状态。
  //   2. 复用 stopSessionProcs 的 pid 解析(按 sessionId 扇出该会话全部 slot),POST stop-task
  //      {toolUseId, sessionId};只属主且会话匹配的 slot stopped:true,其余无害 no-op。
  stopSingleTask: async (sessionId, toolUseId) => {
    if (!toolUseId) return;
    const st = get();
    const ag = st.activeAgents[toolUseId];
    const prevStatus = ag?.status;
    const didOptimistic = ag && !['done', 'error', 'stopped'].includes(prevStatus);
    // optimisticStop 显式标记「这条 stopped 是我们乐观写的」——权威 stopped 落到乐观 stopped 上
    // 时 status 同值、finalizeAgent 是 no-op,靠 status 区分不了两者;标记由 finalizeAgent 在
    // 任何权威终态到达时清掉(App.jsx),回滚只认还带此标记的乐观 stopped。
    if (didOptimistic) st.upsertAgent(toolUseId, { status: 'stopped', finishedAt: Date.now(), optimisticStop: true });
    try {
      const d = await fetch('/api/agents/active').then((r) => r.json());
      const procs = (d.agents || []).filter((a) => a.kind === 'chat-process' && a.sessionId === sessionId && a.stoppable === true);
      const results = await Promise.allSettled(procs.map((a) => fetch(`/api/chat/${a.pid}/stop-task`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolUseId, sessionId }),
      }).then((r) => r.json())));
      // S1:无一命中(所有属主 pid 都 stopped:false)= 该 task 已不在任何 slot 的 liveTasks。
      // 【落终态,不回滚成"工作中"】(批A A6):原来回滚成 prevStatus(working)。可落空恰恰
      // 说明服务端任务表里已经没有它了 —— 既不会再有权威 task_notification 来纠正,回滚就
      // 造出一张永远转圈的僵尸卡(用户实报)。成败未知,故标 settledBy 让 UI 显示中性"已结束"
      // 而非绿勾"完成";真权威终态若还是到了,finalizeAgent 的 canOverride 会覆盖并清标记。
      // 仍只动我们乐观写的那条 stopped:其间到达的权威终态(finalizeAgent 已清 optimisticStop)
      // 即便 status 同为 stopped 也够不着。
      const anyStopped = results.some((r) => r.status === 'fulfilled' && r.value?.stopped === true);
      if (didOptimistic && !anyStopped) {
        const cur = get().activeAgents[toolUseId];
        if (cur && cur.status === 'stopped' && cur.optimisticStop) {
          get().upsertAgent(toolUseId, { status: 'done', settledBy: 'gone', finishedAt: Date.now(), optimisticStop: false });
        }
      }
      // D5:回滚是静默的 —— 不发 task 事件的 provider 下没有任何 slot 认领,卡片"闪一下又
      // 转回去了",用户以为按钮坏了。把结果回给调用方(两处单卡停止按钮)提示一次;store 里
      // 不直接弹窗,confirmDialog 是 JSX 模块,导进来会让 tests/unit 的 node 直跑 store 挂掉。
      // procAlive:本会话是否还有可停的 chat 进程。落空原因两种,提示文案据此细分——
      // 无进程 = 回合早已结束;有进程却无人认领 = 该 task 已不在服务端任务表(早已结束,
      // 或宿主进程重启后丢了记账)。与 provider 无关:代码从没判过 provider。
      return { stopped: anyStopped, noOwner: didOptimistic && !anyStopped, procAlive: procs.length > 0 };
    } catch {}
    return { stopped: false, noOwner: false, procAlive: false };
  },
  // #9/AZ6 子代理会话窗口:按 tab 记录在主区打开查看的子代理 id(null = 看正常会话)。
  setViewingAgent: (tab, id) => set((s) => ({
    viewingAgentByTab: { ...s.viewingAgentByTab, [tab]: id || null },
  })),

  // ── Message queue helpers (#3) ──────────────────────────────
  enqueueMessage: (sessionKey, msg) => {
    const queued = { ...msg, queueId: msg?.queueId || createQueueId('queue') };
    set((s) => {
      const list = s.messageQueue[sessionKey] || [];
      return { messageQueue: { ...s.messageQueue, [sessionKey]: [...list, queued] } };
    });
    return queued;
  },
  prepareSteer: (sessionKey, queueId) => {
    let prepared = null;
    set((s) => {
      const list = s.messageQueue[sessionKey] || [];
      const index = list.findIndex((item) => item?.queueId === queueId);
      if (index < 0 || isSteerBarrier(list[index])) return s;
      const stableQueueId = list[index].queueId || createQueueId('queue');
      const steerId = list[index].steerId || createQueueId('steer');
      prepared = { ...list[index], queueId: stableQueueId, steerId, steerState: 'unknown', attemptWasAmbiguous: false };
      const nextList = list.map((item, i) => (i === index ? prepared : item));
      const nextQueue = { ...s.messageQueue, [sessionKey]: nextList };
      if (!persistQueueSnapshot(nextQueue, true)) { prepared = null; return s; }
      return { messageQueue: nextQueue };
    });
    return prepared;
  },
  settleSteer: (sessionKey, queueId, outcome) => set((s) => {
    const list = s.messageQueue[sessionKey] || [];
    const index = list.findIndex((item) => item?.queueId === queueId);
    if (index < 0) return s;
    const current = list[index];
    let nextItem = current;
    if (outcome === 'accepted') nextItem = { ...current, steerState: 'accepted' };
    // ①"保留不发"：resolved 终态。必须清 attemptWasAmbiguous（isSteerBarrier 也认它），
    // 且分支要在 ambiguous 兜底之前——needs-review 条目 attemptWasAmbiguous 恒真，
    // 放后面 'kept' 会被兜底分支吞掉。
    else if (outcome === 'kept') nextItem = { ...current, steerState: 'kept', attemptWasAmbiguous: false };
    else if (outcome === 'ambiguous' || current.attemptWasAmbiguous) {
      nextItem = { ...current, steerState: 'needs-review', attemptWasAmbiguous: true };
    } else if (outcome === 'explicit-reject') {
      const { steerId, steerState, steeredAt, attemptWasAmbiguous, ...queued } = current;
      void steerId; void steerState; void steeredAt; void attemptWasAmbiguous;
      nextItem = queued;
    }
    if (nextItem === current) return s;
    const nextQueue = { ...s.messageQueue, [sessionKey]: list.map((item, i) => (i === index ? nextItem : item)) };
    if (!persistQueueSnapshot(nextQueue, true)) return s;
    return { messageQueue: nextQueue };
  }),
  reconcileSteerQueue: (sessionKey, steerKeys) => set((s) => {
    const list = s.messageQueue[sessionKey] || [];
    const nextList = reconcileSteered(list, null, steerKeys);
    if (nextList === list) return s;
    const nextQueue = { ...s.messageQueue, [sessionKey]: nextList };
    if (!persistQueueSnapshot(nextQueue, true)) return s;
    return { messageQueue: nextQueue };
  }),
  beginQueueClaim: (sessionKey, queueId, targetPaneId) => {
    const claimId = createQueueId('claim');
    let claimed = false;
    set((s) => {
      const list = s.messageQueue[sessionKey] || [];
      const index = list.findIndex((item) => item?.queueId === queueId && item.steerState === 'needs-review');
      const paneHasDraft = Object.values(s.messageQueue).some((items) => Array.isArray(items)
        && items.some((item) => item?.claimDraft?.targetPaneId === targetPaneId));
      if (index < 0 || !targetPaneId || paneHasDraft) return s;
      const nextItem = { ...list[index], steerState: 'claiming', claimId, targetPaneId };
      const nextQueue = { ...s.messageQueue, [sessionKey]: list.map((item, i) => (i === index ? nextItem : item)) };
      if (!persistQueueSnapshot(nextQueue, true)) return s;
      claimed = true;
      return { messageQueue: nextQueue };
    });
    return claimed ? claimId : null;
  },
  writePendingClaimDraft: (sessionKey, queueId, claimId, targetPaneId) => {
    let written = false;
    set((s) => {
      const item = (s.messageQueue[sessionKey] || []).find((entry) => entry?.queueId === queueId
        && entry.steerState === 'claiming' && entry.claimId === claimId && entry.targetPaneId === targetPaneId);
      if (!item) return s;
      const attachments = Array.isArray(item.opts?.meta?.attachments) ? item.opts.meta.attachments : [];
      const claimDraft = {
        sessionKey,
        sourceQueueId: queueId,
        claimId,
        targetPaneId,
        text: attachments.length ? (item.opts?.meta?.displayText || '') : item.text,
        queueText: item.text,
        // ②孤儿回收要能还原 steerId:finalize 的 draftSlot 会丢掉原条目全部字段,
        // 复位后仍靠它做 UUID 落盘对账(其实已送达的条目自动清掉)。
        steerId: item.steerId || null,
        attachments,
        sendable: false,
      };
      const nextQueue = {
        ...s.messageQueue,
        [sessionKey]: (s.messageQueue[sessionKey] || []).map((entry) => (
          entry === item ? { ...entry, claimDraft } : entry
        )),
      };
      if (!persistQueueSnapshot(nextQueue, true)) return s;
      written = true;
      return { messageQueue: nextQueue };
    });
    return written;
  },
  finalizeQueueClaim: (sessionKey, queueId, claimId, targetPaneId) => {
    let finalized = false;
    set((s) => {
      const list = s.messageQueue[sessionKey] || [];
      const item = list.find((entry) => entry?.queueId === queueId && entry.steerState === 'claiming'
        && entry.claimId === claimId && entry.targetPaneId === targetPaneId);
      const draft = item?.claimDraft;
      if (!item || !draft || draft.sendable || draft.sessionKey !== sessionKey
        || draft.sourceQueueId !== queueId || draft.claimId !== claimId || draft.queueText !== item.text) return s;
      const draftSlot = {
        text: '',
        queuedAt: item.queuedAt,
        hidden: true,
        queueId: createQueueId('claim-draft'),
        claimDraft: { ...draft, sendable: true },
      };
      const nextQueue = { ...s.messageQueue, [sessionKey]: list.map((entry) => (entry === item ? draftSlot : entry)) };
      if (!persistQueueSnapshot(nextQueue, true)) return s;
      finalized = true;
      return { messageQueue: nextQueue };
    });
    return finalized;
  },
  rollbackQueueClaim: (sessionKey, queueId, claimId, targetPaneId) => set((s) => {
    const list = s.messageQueue[sessionKey] || [];
    const nextList = list.map((item) => {
      if (item?.queueId !== queueId || item.claimId !== claimId || item.targetPaneId !== targetPaneId) return item;
      const { claimId: _claimId, targetPaneId: _targetPaneId, claimDraft: _claimDraft, ...rest } = item;
      void _claimId; void _targetPaneId; void _claimDraft;
      return { ...rest, steerState: 'needs-review', attemptWasAmbiguous: true };
    });
    const nextQueue = { ...s.messageQueue, [sessionKey]: nextList };
    if (!persistQueueSnapshot(nextQueue, true)) return s;
    return { messageQueue: nextQueue };
  }),
  updateClaimDraft: (targetPaneId, claimId, patch) => set((s) => {
    let found = false;
    const nextQueue = Object.fromEntries(Object.entries(s.messageQueue).map(([key, list]) => [key, list.map((item) => {
      const current = item?.claimDraft;
      if (!current?.sendable || current.targetPaneId !== targetPaneId || current.claimId !== claimId) return item;
      found = true;
      return { ...item, claimDraft: { ...current, ...patch } };
    })]));
    if (!found || !persistQueueSnapshot(nextQueue, true)) return s;
    return { messageQueue: nextQueue };
  }),
  // ②孤儿回收:claim 槽的 targetPaneId 已不在当前 paneIds(关窗格/单窗格换新 id)时,
  // 该槽永远无人认领 —— hidden 空文本槽既不可见也不可删,还永久阻塞 drain。复位为
  // 可见 needs-review 原条目(①的出口接手)。closePane 两个分支收尾时调用。
  reclaimOrphanClaimDrafts: () => set((s) => {
    const valid = new Set(Array.isArray(s.paneIds) ? s.paneIds : []);
    let changed = false;
    const nextQueue = Object.fromEntries(Object.entries(s.messageQueue).map(([key, list]) => [
      key,
      (Array.isArray(list) ? list : []).map((item) => {
        const pane = item?.claimDraft?.targetPaneId ?? item?.targetPaneId;
        if ((!item?.claimDraft && item?.steerState !== 'claiming') || valid.has(pane)) return item;
        changed = true;
        return reclaimClaimItem(item);
      }),
    ]));
    if (!changed || !persistQueueSnapshot(nextQueue, true)) return s;
    return { messageQueue: nextQueue };
  }),
  clearClaimDraft: (targetPaneId, claimId) => set((s) => {
    let found = false;
    const nextQueue = Object.fromEntries(Object.entries(s.messageQueue).map(([key, list]) => [key, list.filter((item) => {
      const matches = item?.claimDraft?.targetPaneId === targetPaneId && item.claimDraft.claimId === claimId;
      if (matches) found = true;
      return !matches;
    })]));
    if (!found || !persistQueueSnapshot(nextQueue, true)) return s;
    return { messageQueue: nextQueue };
  }),
  shiftMessage: (sessionKey) => {
    // 原子 pop(#7):取 head 与写回 rest 必须在同一次 setState 里 —— 先 getState 再
    // setState 的两步写法下,并发调用方(流收尾 drain / ⚡引导)会各读到同一个 head,
    // 同一条排队消息被发出两遍。
    // 设计乙:跳过【已注入(steer)】的条目 —— 它已经送达 CLI 在等这一回合读,drain 再发
    // 一次就是双发。两个调用方(流收尾 drain / poll drain)都是排空,故判据放在这里一处
    // 生效(见 utils/steerQueue.js 的 firstDrainableIndex)。
    let head = null;
    useStore.setState((s) => {
      const list = s.messageQueue[sessionKey] || [];
      const i = firstDrainableIndex(list);
      if (i < 0) return s;
      head = list[i];
      return { messageQueue: { ...s.messageQueue, [sessionKey]: [...list.slice(0, i), ...list.slice(i + 1)] } };
    });
    return head;
  },
  // 队列整体替换。用于两处:① steer 200 后把该条目原地标成"已并入";② 回合收尾的
  // 落地判定(reconcileSteered)。调用方负责用纯函数算好新数组。
  replaceQueue: (sessionKey, list) => set((s) => (
    { messageQueue: { ...s.messageQueue, [sessionKey]: Array.isArray(list) ? list : [] } }
  )),
  clearQueue: (sessionKey) => set((s) => {
    const next = { ...s.messageQueue };
    delete next[sessionKey];
    return { messageQueue: next };
  }),
  removeFromQueue: (sessionKey, index) => set((s) => {
    const list = s.messageQueue[sessionKey] || [];
    if (index < 0 || index >= list.length || list[index]?.claimDraft) return s;
    // ①needs-review 必须有删除逃生口（取回失败/附件丢失时这是唯一出路）；'kept' 本就非
    // barrier。仍拒删在途确认态（unknown/accepted/claiming）——那些是"结果未定"，删了会
    // 与对账竞态。确认弹窗在 ChatInput（store 不能 import confirmDialog，JSX 模块）。
    if (isSteerBarrier(list[index]) && list[index].steerState !== 'needs-review') return s;
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

  // r10-11:单层项目折叠面板的数据层。sessionsByProject 是懒加载的 per-project 会话
  // 缓存(钻入才拉取),**独立于 store.sessions 单值槽**——PermissionPrompt 权限卡门禁/
  // @面板/监控反查继续读旧槽,语义零改动。
  sessionsByProject: {},
  // r13-①:钻入式单值 drillProject 退役 → dsh 折叠树多展开 expandedProjects(数组,
  // Set 语义)。持久化回 'cgui-expanded-projects';旧钻入键 'cgui-drill-project' 一次性
  // 迁移(有值=该项目初始展开并删旧键,无值=全部折叠),此后不再读写旧键。
  expandedProjects: (() => {
    const { list, migrated } = initialExpandedProjects(readLs('cgui-expanded-projects', undefined), readLs('cgui-drill-project', undefined));
    if (migrated) {
      writeLs('cgui-expanded-projects', list);
      try { localStorage.removeItem('cgui-drill-project'); } catch {}
    }
    return list;
  })(),
  toggleProjectExpanded: (hash) => set((s) => {
    const next = toggleExpanded(s.expandedProjects, hash);
    if (next === s.expandedProjects) return s;
    writeLs('cgui-expanded-projects', next);
    return { expandedProjects: next };
  }),
  // r13-①:语义回归「确保该项目组展开」(r11-① 期间曾改为钻入)。调用点
  // (选中跟随/添加项目/搜索命中/进 worktree)诉求不变:让该项目的会话列表可见。
  ensureProjectExpanded: (hash) => set((s) => {
    if (!hash || s.expandedProjects.includes(hash)) return s;
    const next = [...s.expandedProjects, hash];
    writeLs('cgui-expanded-projects', next);
    return { expandedProjects: next };
  }),
  fetchSessionsForPanel: async (projectHash) => {
    if (!projectHash) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectHash)}/sessions`);
      const data = await res.json();
      // r17-4:磁盘访问被系统拒绝时,后端回 403 + code:'no-disk-access'。这里必须把它
      // 与"真的没有会话"分开 —— 静默的空列表会让用户以为数据被删了(实测的真实反应)。
      if (res.status === 403 && data?.code === 'no-disk-access') {
        set((st) => (st.sessionsAccessError === data.hint ? st : { sessionsAccessError: data.hint }));
        return;
      }
      const list = Array.isArray(data) ? data : [];
      set((st) => (st.sessionsAccessError ? { sessionsAccessError: null } : st));
      // r13-p2-1:内容不变则复用旧身份并跳过 set —— watcher 每 600ms 刷全部展开组,
      // 无条件换身份会让侧栏整树随流式持续重渲(按钮卡顿/点击丢失根因)。
      set((s) => {
        const prev = s.sessionsByProject[projectHash];
        const merged = mergeSessionList(prev, list);
        if (merged === prev) return s;
        return { sessionsByProject: { ...s.sessionsByProject, [projectHash]: merged } };
      });
    } catch { /* 面板刷新失败保留旧缓存,下次去抖刷新兜底 */ }
  },
  // 置顶(项目/会话,服务端共享):挂载 GET 与 WS 广播都经同一 reducer 入位。
  // r17-4:会话目录不可读(完全磁盘访问未授予)时的人话提示;null = 正常。
  sessionsAccessError: null,
  pinnedProjects: [],
  pinnedSessions: [],
  applyPinned: (data) => set(reducePinned(data)),

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
  //   opts.tab=N   → write into pane N (paneMessages[N]) instead of pane 0
  //                  (tab≠0 always forces silent so tab 0 doesn't flash loader)
  fetchMessages: async (sessionId, projectHash, opts = {}) => {
    // tab 0..5 → write into paneMessages[tab] via setPaneMessages (tab 0 also
    // mirrors the legacy `messages` slot). Only tab 0 drives
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
      if (!res.ok) { if (!silent) set({ loading: false }); return false; }
      const data = await res.json();
      // 端点现返回 { messages, usageTotals };兼容旧的裸数组形态(升级过渡期)。
      const messages = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
      // 乱序守卫:响应落地时该 pane 已切走(sessionId 不再是发起时的)→ 整条丢弃,
      // 防慢响应覆盖新会话的消息/归属标记造成永久空白。所有调用点发起时两者相等。
      if (get().paneSessions[tab]?.sessionId !== sessionId) { if (!silent) set({ loading: false }); return false; }
      get().setPaneMessages(tab, messages, sessionId);
      // 服务端算好的整会话用量聚合,SessionDetail 顶部用量条直接取用,
      // 避免前端对几千条历史消息每帧全量 reduce。
      if (data && !Array.isArray(data) && data.usageTotals) {
        set((s) => ({ usageTotalsBySession: { ...s.usageTotalsBySession, [sessionId]: data.usageTotals } }));
      }
      if (!silent) set({ loading: false });
      return true;
    } catch (err) {
      // Network/parse failure — keep existing messages rather than blanking.
      if (!silent) set({ error: err.message, loading: false });
      return false;
    }
  },

  // Fetch current model
  fetchModel: async () => {
    try {
      const res = await fetch('/api/model');
      const data = await res.json();
      // 判官4:异常响应(无 model 字段)不把 currentModel 打成 undefined ——
      // 顶栏 ModelSelector 以 !currentModel 早退,会整个消失。
      if (data.model) set({ currentModel: data.model });
      set({ availableModels: Array.isArray(data.available) ? data.available : [] });
      // r10-9:当前 provider 的每模型思考能力声明(EffortSelector 按当前模型自适应)。
      set({ modelEffortMeta: (data.modelMeta && typeof data.modelMeta === 'object') ? data.modelMeta : null });
      // 手机批#3:providerName 一并写入(桌面由 ModelSelector 的 load 写;手机端不挂
      // ModelSelector,菜单里"当前 Provider"的显示靠这里)。
      if (data.provider != null) set({ providerName: data.provider });
      // effort 显示:用户没在 GUI 显式选过(localStorage 空)时,用 settings.json 的默认
      // 思考强度(CLAUDE_CODE_EFFORT_LEVEL)显示,免得"settings 设了 high 却显示默认"。
      // 用户在 GUI 选过则尊重其选择(localStorage 有值,不覆盖)。
      try {
        if (!localStorage.getItem('cgui-effort') && data.defaultEffort) set({ effort: data.defaultEffort });
        set({ defaultEffort: data.defaultEffort || '' }); // 判官建议:三个 /api/model 消费点同步此字段,防文案短暂陈旧
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

// claim draft 作为 hidden、空 text 的队列槽，与普通队列项留在同一旧格式快照中。
useStore.subscribe((s, prev) => {
  if (!prev) return; // 首次触发无 prev,无意义回写
  if (s.messageQueue !== prev.messageQueue) persistQueueSnapshot(s.messageQueue);
});

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

if (typeof window !== 'undefined') {
  window.addEventListener('cgui:provider-change', () => {
    useStore.getState().clearContextExactCache();
  });
}
