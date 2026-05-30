import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import sessionRoutes from './routes/sessions.js';
import chatRoutes from './routes/chat.js';
import processRoutes from './routes/processes.js';
import settingsRoutes, { restoreOpenAIProvider } from './routes/settings.js';
import usageRoutes from './routes/usage.js';
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
import {
  authMiddleware, isLocalReq, isAuthorized, parseCookies, verifyToken,
  hasPassword, setPassword, clearPassword, verifyPassword, issueToken,
} from './services/auth.js';
import { setupFileWatcher } from './services/file-watcher.js';
import { getDefaultModel, getAvailableModels, setDefaultModel } from './services/model-resolver.js';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { homedir, networkInterfaces } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Network binding: env > ~/.claude-gui/network.json > loopback default.
// The GUI has no auth and can read/write $HOME + spawn `claude`; binding 0.0.0.0
// hands any machine that can reach the port full shell access. The Settings UI
// exposes a LAN toggle (writes the config below) behind a red warning — access
// control is delegated to the network layer (tailscale ACL / LAN isolation).
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
  } catch {}
  return { host: '127.0.0.1', port: 6677 };
}
const _netCfg = loadNetworkConfig();
const PORT = process.env.PORT || _netCfg.port;
const HOST = process.env.HOST || _netCfg.host;
// LAN mode = bound to all interfaces. Loosens CORS (below) so a phone hitting
// http://<lanIp>:PORT isn't rejected as cross-origin.
const lanMode = HOST === '0.0.0.0';

const app = express();
// Same-origin only: in prod the SPA is served from this same port; in dev Vite
// proxies /api + /ws server-side. So the only legitimate browser origins are
// localhost/127.0.0.1. Reject everything else to blunt drive-by cross-origin
// requests from arbitrary web pages the user may have open.
app.use(cors({
  origin: (origin, cb) => {
    // Non-browser clients (curl, same-origin fetch) send no Origin header.
    if (!origin) return cb(null, true);
    // LAN mode: user opted into network exposure (UI toggle + warning), so allow
    // any origin — access control is delegated to the network layer (tailscale/LAN).
    if (lanMode) return cb(null, true);
    try {
      const { hostname } = new URL(origin);
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return cb(null, true);
      }
    } catch {}
    const err = new Error('Cross-origin request blocked by Claude GUI');
    err.status = 403; // surfaced as a clean 403 by the error handler below
    return cb(err);
  },
}));
// Bumped from default 100kb to 25mb so dragged-in screenshots fit in the JSON body.
app.use(express.json({ limit: '25mb' }));

// Password gate for external clients (no-op for 127.0.0.1 / no-password). Must
// sit before the API routes so an unauthorized phone gets 401 on every call
// except /login + /auth-status. The Mac (loopback) is never challenged.
app.use('/api', authMiddleware);

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
  if (process.env.CGUI_WATCHDOG !== '1') {
    return res.status(409).json({
      error: '当前不是通过守护脚本启动，无法自动重启。请用 gui.command 启动 GUI。',
      watchdog: false,
    });
  }
  res.json({ ok: true, restarting: true });
  setTimeout(() => process.exit(0), 250);
});

// API routes
app.use('/api', sessionRoutes);
app.use('/api', chatRoutes);
app.use('/api', processRoutes);
app.use('/api', settingsRoutes);
app.use('/api', usageRoutes);
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

// Auto-load optional local-only routes (server/routes/*.local.js) — gitignored
// personal integrations. Absent on a fresh checkout, so this is a no-op there.
// Mounted under /api AFTER authMiddleware, so they inherit the password gate.
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
  res.json({
    host: HOST, port: PORT, lanMode, lanIps: lanIps(),
    configPath: NETWORK_CONFIG_PATH,
    hasPassword: hasPassword(),
    watchdog: process.env.CGUI_WATCHDOG === '1',
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
    if (typeof password === 'string' && password.length >= 4) setPassword(password);
    // updateConfig merges so passwordHash / tokenSecret aren't clobbered.
    const { updateConfig } = await import('./services/auth.js');
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
try {
  watcher = setupFileWatcher((eventType, filePath) => {
    if (filePath.endsWith('/.claude/settings.json') || filePath.endsWith('\\.claude\\settings.json')) {
      broadcast({ type: 'provider-change', path: filePath });
    }
    broadcast({ type: 'file-change', eventType, path: filePath });
  });
} catch {
  console.warn('File watcher failed to start (chokidar)');
}

// Don't let a single bad request kill the whole dev server. Log loudly,
// but keep serving the GUI — concurrently kills both processes on exit.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

server.listen(PORT, HOST, () => {
  console.log('═'.repeat(60));
  console.log(`  Claude GUI server READY   http://localhost:${PORT}`);
  console.log(`  WebSocket                  ws://localhost:${PORT}/ws`);
  console.log(`  Bound to                   ${HOST}${HOST === '127.0.0.1' ? ' (loopback only)' : ' (⚠ network-exposed, no auth!)'}`);
  console.log(`  Started at                 ${new Date().toLocaleString()}`);
  console.log('═'.repeat(60));
  // Re-arm the OpenAI translation proxy if a codex/opencode provider was active
  // before this (re)start, so settings.json's proxy URL keeps resolving.
  restoreOpenAIProvider().catch(() => {});
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[!] Port ${PORT} already in use. Run: npm run stop (then npm start)\n`);
    process.exit(1);
  }
  throw err;
});

export { broadcast };
