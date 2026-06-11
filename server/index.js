import express from 'express';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import sessionRoutes from './routes/sessions.js';
import chatRoutes from './routes/chat.js';
import processRoutes from './routes/processes.js';
import settingsRoutes, { restoreOpenAIProvider, restoreAnthropicProvider } from './routes/settings.js';
import usageRoutes from './routes/usage.js';
import subscriptionUsageRoutes from './routes/subscription-usage.js';
import pricingRoutes from './routes/pricing.js';
import memoryRoutes from './routes/memory.js';
import mcpRoutes from './routes/mcp.js';
import forkRoutes from './routes/fork.js';
import fileChangesRoutes from './routes/file-changes.js';
import searchRoutes from './routes/search.js';
import checkpointsRoutes from './routes/checkpoints.js';
import agentsRoutes from './routes/agents.js';
import worktreeRoutes from './routes/worktree.js';
import gitRoutes from './routes/git.js';
import uploadRoutes from './routes/upload.js';
import pickerRoutes from './routes/picker.js';
import permissionsRoutes from './routes/permissions.js';
import filesRoutes from './routes/files.js';
import remoteControlRoutes from './routes/remote-control.js';
import prefsRoutes from './routes/prefs.js';
import cliCheckRoutes from './routes/cli-check.js';
import permissionCheckRoutes from './routes/permission-check.js';
import versionCheckRoutes from './routes/version-check.js';
import downloadUpdateRoutes from './routes/download-update.js';
import openUrlRoutes from './routes/open-url.js';
import {
  authMiddleware, isLocalReq, isAuthorized, parseCookies, verifyToken,
  hasPassword, setPassword, clearPassword, verifyPassword, issueToken, updateConfig, loadConfig,
} from './services/auth.js';
import { setupFileWatcher } from './services/file-watcher.js';
import { getDefaultModel, getAvailableModels, setDefaultModel } from './services/model-resolver.js';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { homedir, networkInterfaces } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tauri 启动的 server 从 GUI 进程继承 PATH,通常缺少用户 shell 里手工加的目录。
// curl install.sh 装的 claude 落在 ~/.claude/local/bin(macOS/Linux/Windows 一致),
// npm i -g 装的在 ~/.local/bin 或 NPM prefix。Tauri spawn 不走 shell,这些路径
// 都不在 → spawn('claude') ENOENT → CLI 检测误报"未装"+ chat.js 发消息直接挂。
// 启动时把常见安装路径前置到 PATH,所有后续 spawn / execFile('claude') 一并受益。
(function expandClaudePath() {
  const home = homedir();
  const dirs = [
    join(home, '.claude', 'local', 'bin'),       // 官方 install.sh 默认
    join(home, '.local', 'bin'),                  // pipx / 部分 npm prefix
    join(home, '.npm-global', 'bin'),             // Y1: 常见自定义 npm prefix(npm 不写 PATH 的根治之一)
    '/opt/homebrew/bin',                          // mac Apple Silicon brew
    '/usr/local/bin',                             // mac Intel brew + 通用
  ];
  if (process.platform === 'win32') {
    dirs.push(
      join(home, 'AppData', 'Local', 'AnthropicClaude'),
      join(home, '.claude', 'local'),
      join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm'),
    );
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  const existing = (process.env.PATH || '').split(sep);
  const lower = (s) => process.platform === 'win32' ? s.toLowerCase() : s;
  const existingLower = new Set(existing.map(lower));
  const toAdd = dirs.filter((d) => d && !existingLower.has(lower(d)));
  if (toAdd.length) {
    process.env.PATH = [...toAdd, ...existing].join(sep);
  }
  // Y1:再问 npm 自己的全局 prefix(用户可能 `npm config set prefix` 到任意目录,
  // npm 不会替用户写 shell PATH → "装成功但 GUI 检测不到"的根因)。异步补挂,
  // 不阻塞启动;后续 spawn 读 process.env.PATH 时已生效。
  (async () => {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const { stdout } = await promisify(execFile)(
        process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], { timeout: 8000 },
      );
      const prefix = stdout.trim();
      if (!prefix) return;
      const binDir = process.platform === 'win32' ? prefix : join(prefix, 'bin');
      const cur = (process.env.PATH || '').split(sep);
      if (!cur.map(lower).includes(lower(binDir))) {
        process.env.PATH = [binDir, ...cur].join(sep);
        console.log('[path] appended npm global bin:', binDir);
      }
    } catch {}
  })();
})();
// Network binding: env > ~/.claude-gui/network.json > loopback default.
// External clients require the GUI password; binding 0.0.0.0 without one would
// expose $HOME-backed actions and spawned Claude sessions to the network, so it
// is forced back to loopback below.
const NETWORK_CONFIG_PATH = join(homedir(), '.claude-gui', 'network.json');
function loadNetworkConfig() {
  try {
    if (existsSync(NETWORK_CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(NETWORK_CONFIG_PATH, 'utf-8'));
      let host = cfg.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
      const port = Number.isInteger(cfg.port) && cfg.port >= 1024 && cfg.port <= 65535 ? cfg.port : 6677;
      // HARD SAFETY: never expose 0.0.0.0 without a password. A legacy or
      // hand-edited config that requests network binding but has no passwordHash
      // falls back to loopback so there's never an auth-less open port.
      if (host === '0.0.0.0' && !cfg.passwordHash) {
        console.warn('[network] config requests 0.0.0.0 but no password is set — falling back to 127.0.0.1. Set a password in Settings → 网络 to enable network access.');
        host = '127.0.0.1';
      }
      return { host, port };
    }
    // 首次无配置:默认走局域网(用户要求开箱即用,手机/局域网设备直接连)。HARD
    // SAFETY 要求 0.0.0.0 必须有密码,故同时写入默认密码 123456。⚠️ 弱密码 + 裸
    // 局域网 HTTP 明文传输,首次启动后应立即在 设置→网络 改密码,勿暴露公共 WiFi
    // /公网(优先 Tailscale)。defaultPassword 标记驱动前端首次提示改密码。
    if (!hasPassword()) setPassword('123456');
    updateConfig({ host: '0.0.0.0', port: 6677, defaultPassword: true });
    return { host: '0.0.0.0', port: 6677 };
  } catch {}
  return { host: '127.0.0.1', port: 6677 };
}
const _netCfg = loadNetworkConfig();
const PORT = process.env.PORT || _netCfg.port;
let HOST = process.env.HOST || _netCfg.host;
if (HOST === '0.0.0.0' && !hasPassword()) {
  console.warn('[network] HOST=0.0.0.0 requested but no password is set — falling back to 127.0.0.1.');
  HOST = '127.0.0.1';
}
// LAN mode = bound to all interfaces. Loosens CORS (below) so a phone hitting
// http://<lanIp>:PORT isn't rejected as cross-origin. `let` because relisten()
// can flip the binding at runtime (设置→网络 的局域网开关,无需重启进程)。
let lanMode = HOST === '0.0.0.0';

function requestHostname(req) {
  const host = req?.headers?.host || '';
  return host.replace(/^\[/, '').replace(/\](:\d+)?$/, '').replace(/:\d+$/, '');
}

function isAllowedBrowserOrigin(origin, req = null) {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    const host = requestHostname(req);
    if (host && hostname === host) return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (lanMode && lanIps().includes(hostname)) return true;
  } catch {}
  return false;
}

const app = express();
// Same-origin only: in prod the SPA is served from this same port; in dev Vite
// proxies /api + /ws server-side. So the only legitimate browser origins are
// localhost/127.0.0.1. Reject everything else to blunt drive-by cross-origin
// requests from arbitrary web pages the user may have open.
app.use(cors((req, cb) => cb(null, {
  origin: (origin, originCb) => {
    if (isAllowedBrowserOrigin(origin, req)) return originCb(null, true);
    const err = new Error('Cross-origin request blocked by Claude GUI');
    err.status = 403; // surfaced as a clean 403 by the error handler below
    return originCb(err);
  },
})));
// Bumped from default 100kb to 25mb so dragged-in screenshots fit in the JSON body.
app.use(express.json({ limit: '25mb' }));

// Password gate for external clients (no-op for 127.0.0.1 / no-password). Must
// sit before the API routes so an unauthorized phone gets 401 on every call
// except /login + /auth-status. The Mac (loopback) is never challenged.
// 版本号:Tauri 壳启动时用 /api/health 的 version 校验"复用的 6677 server"是否同版本,
// 不符就杀旧 server 起新的 —— 根治"升级 app 却复用了旧 server 进程"导致 cli-check 等
// 旧代码误判(装了 claude 仍提示未装)的问题。
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version || null; }
  catch { return null; }
})();
app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'claude-gui', port: PORT, version: APP_VERSION });
});
app.use('/api', authMiddleware);

// API responses are dynamic — never cache them. Without this, iOS Safari applies
// HEURISTIC caching to GET /api/* (no Cache-Control + an ETag is enough): after a
// `cc switch`, the phone's `fetch('/api/model')` served a STALE cached body so the
// model list "didn't change, even on refresh". Desktop Chromium revalidated the
// ETag and dodged it, which is why it only reproduced on the phone.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});

// POST /api/login { password } — verify and hand back an HMAC cookie token.
app.post('/api/login', (req, res) => {
  if (!hasPassword()) return res.json({ ok: true, required: false });
  const { password } = req.body || {};
  if (!verifyPassword(password)) return res.status(401).json({ error: '密码错误' });
  res.setHeader(
    'Set-Cookie',
    `cgui_token=${issueToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
  );
  res.json({ ok: true });
});

// GET /api/auth-status — lets the SPA decide whether to show the login screen.
app.get('/api/auth-status', (req, res) => {
  res.json({
    required: hasPassword() && !isLocalReq(req),
    authed: isAuthorized(req),
    isLocal: isLocalReq(req),
  });
});

// POST /api/restart — clean-exit so the gui.command watchdog relaunches with the
// new config (e.g. after toggling LAN mode). Refuses when NOT under the watchdog
// so a bare `node server/index.js` isn't silently killed (which would strand a
// phone client with no way to bring it back).
app.post('/api/restart', (req, res) => {
  // watchdog(gui.command)启动:clean-exit,守护脚本拉起新进程读新配置。
  if (process.env.CGUI_WATCHDOG === '1') {
    res.json({ ok: true, restarting: true });
    setTimeout(() => process.exit(0), 250);
    return;
  }
  // Tauri 双击启动:无 watchdog,但能运行时 relisten 切换 host(局域网开关),不重启
  // 进程。port 变更不支持(webview 连固定端口)——只切 host。先发响应再延迟 relisten,
  // 否则 closeAllConnections 会断掉当前这个请求的连接,res 发不出去。
  if (process.env.CGUI_TAURI === '1') {
    const target = loadNetworkConfig().host; // 已过 HARD SAFETY 回落
    res.json({ ok: true, relistening: true, host: target });
    setTimeout(() => { relisten(target).catch((e) => console.error('[network] relisten failed:', e.message)); }, 250);
    return;
  }
  // 纯命令行(node server/index.js)既非 watchdog 也非 Tauri:拒绝,避免掐死 server
  // 把手机端晾在没法恢复的状态。
  return res.status(409).json({
    error: '当前不是通过守护脚本或 GUI 启动，无法自动重启。请用 gui.command 启动 GUI。',
    watchdog: false,
  });
});

// API routes
app.use('/api', sessionRoutes);
app.use('/api', chatRoutes);
app.use('/api', processRoutes);
app.use('/api', settingsRoutes);
app.use('/api', usageRoutes);
app.use('/api', subscriptionUsageRoutes);
app.use('/api', pricingRoutes);
app.use('/api', memoryRoutes);
app.use('/api', mcpRoutes);
app.use('/api', forkRoutes);
app.use('/api', fileChangesRoutes);
app.use('/api', searchRoutes);
app.use('/api', checkpointsRoutes);
app.use('/api', agentsRoutes);
app.use('/api', worktreeRoutes);
app.use('/api', gitRoutes);
app.use('/api', uploadRoutes);
app.use('/api', pickerRoutes);
app.use('/api', permissionsRoutes);
app.use('/api', filesRoutes);
app.use('/api', remoteControlRoutes);
app.use('/api', prefsRoutes);
app.use('/api', cliCheckRoutes);
app.use('/api', permissionCheckRoutes);
app.use('/api', versionCheckRoutes);
app.use('/api', downloadUpdateRoutes);
app.use('/api', openUrlRoutes);

// Auto-load optional local-only routes only when explicitly requested. These
// files are gitignored personal integrations; packaged/public builds must not
// activate them just because a local working tree had them during bundling.
if (process.env.CGUI_ENABLE_LOCAL_ROUTES === '1') {
  try {
    const routesDir = join(__dirname, 'routes');
    const localFiles = (await readdir(routesDir)).filter((f) => f.endsWith('.local.js'));
    for (const f of localFiles) {
      try {
        const mod = await import(`./routes/${f}`);
        if (mod.default) { app.use('/api', mod.default); console.log(`[local] mounted routes/${f}`); }
      } catch (e) { console.warn(`[local] failed to load routes/${f}:`, e.message); }
    }
  } catch {}
}

// GET /api/network — current binding + LAN addresses for the Settings UI.
function lanIps() {
  const out = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
app.get('/api/network', (req, res) => {
  const watchdog = process.env.CGUI_WATCHDOG === '1';
  res.json({
    host: HOST, port: PORT, lanMode, lanIps: lanIps(),
    configPath: NETWORK_CONFIG_PATH,
    hasPassword: hasPassword(),
    watchdog,
    // Tauri 双击启动虽无 watchdog,但能运行时 relisten 切 host → 重启按钮可用。
    canRestart: watchdog || process.env.CGUI_TAURI === '1',
    // 首次默认密码(123456)未改 → 前端横幅强提示改密码。
    defaultPassword: loadConfig().defaultPassword === true,
  });
});
// POST /api/network — persist binding to ~/.claude-gui/network.json. Takes effect
// after a restart (we never relisten at runtime). host limited to loopback or
// all-interfaces; port to the unprivileged range. Enabling 0.0.0.0 REQUIRES a
// password (set here or already on file) — no auth-less network exposure.
// Merges into the config so the password hash / token secret survive.
app.post('/api/network', async (req, res) => {
  const { host, port, password } = req.body || {};
  if (host !== '0.0.0.0' && host !== '127.0.0.1') {
    return res.status(400).json({ error: 'host 必须是 127.0.0.1 或 0.0.0.0' });
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    return res.status(400).json({ error: '端口需为 1024–65535 的整数' });
  }
  if (host === '0.0.0.0' && !hasPassword() && !(typeof password === 'string' && password.length >= 4)) {
    return res.status(400).json({ error: '开启局域网访问必须先设置访问密码（至少 4 位）', needPassword: true });
  }
  try {
    if (typeof password === 'string' && password.length >= 4) { setPassword(password); updateConfig({ defaultPassword: false }); }
    // updateConfig merges so passwordHash / tokenSecret aren't clobbered.
    updateConfig({ host, port: p });
    res.json({ ok: true, host, port: p, restartRequired: true, watchdog: process.env.CGUI_WATCHDOG === '1' });
  } catch (e) {
    res.status(500).json({ error: '写入配置失败：' + e.message });
  }
});

// POST /api/network/password { password } | { clear:true } — change/remove the
// access password independently of the host toggle.
app.post('/api/network/password', (req, res) => {
  const { password, clear } = req.body || {};
  if (clear) { clearPassword(); return res.json({ ok: true, hasPassword: false }); }
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: '密码至少 4 位' });
  }
  setPassword(password);
  res.json({ ok: true, hasPassword: true });
});

// GET /api/model — current default model + available models
app.get('/api/model', async (req, res) => {
  try {
    const data = await getAvailableModels();
    res.json({ model: data.current, available: data.models, provider: data.provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/model — set default model
app.put('/api/model', async (req, res) => {
  try {
    const { model } = req.body;
    if (!model) return res.status(400).json({ error: 'model is required' });
    await setDefaultModel(model);
    res.json({ ok: true, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 仅作 UI 提示用，绝不在 server 端做命令路由。所有 slash 一律原样透传给 `claude -p`，
// 由 CLI 自己决定如何处理（含 skill 加载、interactive-only 提示等）。
//   interactiveOnly: true   实测 `claude -p "/xxx"` 会返回 "isn't available in this environment"
//   requiresAnthropic       cc switch 到第三方端点后的可用性，与 CLI 是否支持 -p 正交
const BUILTIN_COMMANDS = [
  // -p 模式 CLI 会真正执行
  { name: '/clear',           desc: '清除当前会话上下文',  type: 'builtin' },
  { name: '/compact',         desc: '压缩会话历史',        type: 'builtin' },
  { name: '/cost',            desc: '显示当前会话费用',    type: 'builtin', requiresAnthropic: 'partial', note: '第三方端点 token 计价不准' },
  { name: '/init',            desc: '生成项目 CLAUDE.md',  type: 'builtin' },
  { name: '/resume',          desc: '恢复会话',            type: 'builtin' },
  { name: '/review',          desc: '代码审查',            type: 'builtin' },
  { name: '/pr-comments',     desc: '查看 PR 评论',        type: 'builtin' },
  { name: '/security-review', desc: '安全审查',            type: 'builtin' },
  { name: '/bug',             desc: '报告 Bug',            type: 'builtin', requiresAnthropic: 'partial', note: '上报到 Anthropic' },
  { name: '/add-dir',         desc: '添加工作目录',        type: 'builtin' },
  { name: '/export',          desc: '导出会话',            type: 'builtin' },
  { name: '/todos',           desc: '查看任务列表',        type: 'builtin' },

  // -p 模式 CLI 拒绝（交互式专属）
  { name: '/help',           desc: '帮助',           type: 'builtin', interactiveOnly: true },
  { name: '/status',         desc: '会话状态',       type: 'builtin', interactiveOnly: true },
  { name: '/doctor',         desc: '健康检查',       type: 'builtin', interactiveOnly: true },
  { name: '/mcp',            desc: 'MCP 管理',       type: 'builtin', interactiveOnly: true },
  { name: '/config',         desc: '配置',           type: 'builtin', interactiveOnly: true },
  { name: '/permissions',    desc: '权限设置',       type: 'builtin', interactiveOnly: true },
  { name: '/model',          desc: '切换模型',       type: 'builtin', interactiveOnly: true, requiresAnthropic: 'partial' },
  { name: '/memory',         desc: '编辑 CLAUDE.md', type: 'builtin', interactiveOnly: true },
  { name: '/agents',         desc: '管理 subagents', type: 'builtin', interactiveOnly: true },
  { name: '/vim',            desc: 'Vim 模式',       type: 'builtin', interactiveOnly: true },
  { name: '/terminal-setup', desc: '终端集成',       type: 'builtin', interactiveOnly: true },
  { name: '/login',          desc: 'Anthropic 登录', type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full' },
  { name: '/logout',         desc: '退出登录',       type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full' },
  { name: '/fast',           desc: 'Opus Fast',      type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full' },
  { name: '/remote-control', desc: '远程控制会话',   type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full',
    note: 'claude --remote-control 是 CLI flag，需在终端启动' },
];

// 第三方端点不可用的 skill/plugin 名称（按 slash 名匹配）
const SUBSCRIPTION_ONLY_NAMES = new Set([
  'loop', 'schedule', 'remote-trigger',
]);

// Extract description from SKILL.md frontmatter
async function getSkillDescription(skillDir, skillName) {
  try {
    const content = await readFile(join(skillDir, skillName, 'SKILL.md'), 'utf-8');
    const match = content.match(/^---[\s\S]*?description:\s*(.+?)[\n\r]/);
    if (match) {
      const desc = match[1].trim().replace(/^[>]+\s*/, '');
      return desc.length > 100 ? desc.slice(0, 100) + '...' : desc;
    }
  } catch {}
  return skillName.replace(/-/g, ' ');
}

app.get('/api/slash-commands', async (req, res) => {
  try {
    const commands = [...BUILTIN_COMMANDS];

    const skillsDir = join(homedir(), '.claude', 'skills');
    try {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      const skillDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
      const descriptions = await Promise.all(skillDirs.map(d => getSkillDescription(skillsDir, d.name)));
      skillDirs.forEach((entry, i) => {
        if (commands.some(c => c.name === `/${entry.name}`)) return;
        commands.push({
          name: `/${entry.name}`,
          desc: descriptions[i],
          type: 'skill',
          requiresAnthropic: SUBSCRIPTION_ONLY_NAMES.has(entry.name) ? 'full' : false,
        });
      });
    } catch {}

    try {
      const pluginsData = JSON.parse(
        await readFile(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf-8')
      );
      const plugins = pluginsData.plugins || {};
      for (const [name] of Object.entries(plugins)) {
        const pluginName = name.split('@')[0];
        if (commands.some(c => c.name === `/${pluginName}`)) continue;
        commands.push({
          name: `/${pluginName}`,
          desc: `Plugin: ${pluginName}`,
          type: 'plugin',
          requiresAnthropic: SUBSCRIPTION_ONLY_NAMES.has(pluginName) ? 'full' : false,
        });
      }
    } catch {}

    // Tell the client which endpoint is currently active so it can gray out
    // subscription-only commands when cc switch points to a third-party endpoint.
    let provider = 'Anthropic';
    try {
      const data = await getAvailableModels();
      provider = data.provider || 'Anthropic';
    } catch {}
    const isAnthropic = provider === 'Anthropic';

    res.json({ commands, provider, isAnthropic });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CORS / error handler: a blocked cross-origin request reaches here via the
// cors callback's Error. Return a clean 403 (with JSON) instead of letting it
// fall through to Express's default 500 HTML page.
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err?.status || 500;
  res.status(status).json({ error: err?.message || 'internal error' });
});

// Serve static frontend in production.
// IMPORTANT: index.html must NEVER be cached — its inline <script src> points
// to a content-hashed bundle (e.g. index-G15SFXlT.js). If the browser caches
// index.html, it keeps loading the OLD bundle hash forever even after rebuilds.
// Hashed assets under /assets/* CAN be cached aggressively (the filename itself
// busts the cache on change).
const clientDist = join(__dirname, '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, {
    // index: false → don't auto-serve index.html for "/" — that path must
    // hit our app.get('/{*splat}') handler below so we can inject the
    // per-request meta tag (busts stuck browser HTML caches).
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else if (filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
  app.get('/{*splat}', async (req, res) => {
    // Inject a per-request timestamp meta into index.html so the response
    // bytes change every time. This works around browser HTTP-cache stickiness
    // some users hit even with Cache-Control: no-cache (because the previously
    // cached entry didn't have the no-cache header). After one new visit
    // through this path, the browser stores the fresh no-cache HTML and
    // future requests revalidate properly — no more need for `?v=` suffixes.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    try {
      const { readFile } = await import('fs/promises');
      let html = await readFile(join(clientDist, 'index.html'), 'utf-8');
      html = html.replace(
        '</head>',
        `<meta name="cgui-build" content="${Date.now()}"></head>`,
      );
      res.type('html').send(html);
    } catch {
      res.sendFile(join(clientDist, 'index.html'));
    }
  });
}

// HTTP + WebSocket server
const server = createServer(app);
// Gate the WS handshake with the same rule as the HTTP API: local + no-password
// pass; external clients need a valid cookie token. Without this an
// unauthorized phone could still open the live stream after being 401'd on REST.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info) => {
    if (!isAllowedBrowserOrigin(info.origin || info.req?.headers?.origin, info.req)) return false;
    if (!hasPassword()) return true;
    if (isLocalReq(info.req)) return true;
    return verifyToken(parseCookies(info.req).cgui_token);
  },
});

// Track connected clients
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));

  getDefaultModel()
    .then((model) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'model', model }));
    })
    .catch((err) => console.warn('getDefaultModel on WS connect failed:', err.message));
});

// Broadcast to all connected clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

// File watcher → WebSocket broadcast.
// settings.json is the file `cc switch` rewrites — when it changes, tell every
// connected client so ModelSelector / ProviderAvatar can refetch /api/model and
// reflect the new provider without a page reload.
let watcher = null;
if (process.env.CGUI_DISABLE_FILE_WATCHER !== '1') {
  try {
    watcher = setupFileWatcher((eventType, filePath) => {
      if (filePath.endsWith('/.claude/settings.json') || filePath.endsWith('\\.claude\\settings.json')) {
        // W3①:广播携带 provider 指纹(BASE_URL + 凭证哈希前 12 位)。客户端据此判断
        // "是真的换了 provider(终端 cc switch)还是 settings.json 的其他改动",
        // 只有指纹变化才清会话模型钉选 + 推进 providerEpoch —— effort 等无关改动
        // 不能过度失效历史模型。
        let providerFp = null;
        try {
          const raw = JSON.parse(readFileSync(filePath, 'utf8'));
          const env = raw?.env || {};
          const base = String(env.ANTHROPIC_BASE_URL || 'official');
          const cred = String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '');
          providerFp = base + '|' + createHash('sha256').update(cred).digest('hex').slice(0, 12);
        } catch {}
        broadcast({ type: 'provider-change', path: filePath, providerFp });
      }
      broadcast({ type: 'file-change', eventType, path: filePath });
    });
  } catch {
    console.warn('File watcher failed to start (chokidar)');
  }
} else {
  console.log('[file-watcher] disabled for packaged Tauri backend');
}

// Don't let a single bad request kill the whole dev server. Log loudly,
// but keep serving the GUI — concurrently kills both processes on exit.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// 运行时切换监听地址(局域网开关),不重启进程。Tauri 双击启动没有 watchdog,靠它
// 让"重启 server"按钮也能生效。WS 长连接会卡住 server.close 的回调,必须先 terminate;
// 前端会自动重连/reload。webview 始终连 127.0.0.1,而 0.0.0.0 含 loopback,故切到
// 局域网后 webview 仍可访问。
async function relisten(newHost) {
  for (const c of wss.clients) { try { c.terminate(); } catch {} }
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try { server.close(fin); } catch { fin(); }
    server.closeAllConnections?.();
    setTimeout(fin, 1000); // 兜底:close 回调若因残留连接未触发也继续
  });
  const oldHost = HOST;
  HOST = newHost;
  lanMode = (newHost === '0.0.0.0');
  try {
    await new Promise((resolve, reject) => {
      const onErr = (e) => { server.removeListener('error', onErr); reject(e); };
      server.once('error', onErr);
      server.listen(PORT, newHost, () => { server.removeListener('error', onErr); resolve(); });
    });
    console.log(`[network] relistened on ${newHost}:${PORT}`);
  } catch (e) {
    // 监听新地址失败(如端口在 close→listen 间隙被抢):回退旧地址,避免 server 既不听
    // 新也不听旧的死状态(webview 白屏 / 手机端断线无法自恢复)。
    console.error(`[network] relisten to ${newHost} failed: ${e.message} — reverting to ${oldHost}`);
    HOST = oldHost;
    lanMode = (oldHost === '0.0.0.0');
    await new Promise((resolve) => { server.listen(PORT, oldHost, resolve); });
  }
}

server.listen(PORT, HOST, () => {
  const exposure = HOST === '127.0.0.1'
    ? ' (loopback only)'
    : hasPassword()
      ? ' (network-exposed, password protected)'
      : ' (network-exposed)';
  console.log('═'.repeat(60));
  console.log(`  Claude GUI server READY   http://localhost:${PORT}`);
  console.log(`  WebSocket                  ws://localhost:${PORT}/ws`);
  console.log(`  Bound to                   ${HOST}${exposure}`);
  console.log(`  Started at                 ${new Date().toLocaleString()}`);
  console.log('═'.repeat(60));
  // Re-arm the OpenAI translation proxy if a codex/opencode provider was active
  // before this (re)start, so settings.json's proxy URL keeps resolving.
  restoreOpenAIProvider().catch(() => {});
  // Same for the Anthropic passthrough proxy (deepseek/mimo/relay providers that
  // dodge the subscription-OAuth-token poisoning).
  restoreAnthropicProvider().catch(() => {});
  // First-run convenience: pop the default browser to the local URL. The launcher
  // (gui.command / gui.bat) sets CGUI_OPEN_BROWSER=1 for the initial start only —
  // it flips to 0 for watchdog restarts, and Tauri spawns us without it (Tauri has
  // its own window) — so this fires exactly once per manual launch, never twice.
  if (process.env.CGUI_OPEN_BROWSER === '1') {
    const url = `http://localhost:${PORT}`;
    const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
    try { spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref(); } catch {}
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[!] Port ${PORT} already in use. Run: npm run stop (then npm start)\n`);
    process.exit(1);
  }
  throw err;
});

export { broadcast };
