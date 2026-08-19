import express from 'express';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, mkdirSync, watch as fsWatch } from 'fs';
import { createHash } from 'crypto';
import sessionRoutes from './routes/sessions.js';
import chatRoutes, { getInitCommands, mergeInitCommands } from './routes/chat.js';
import processRoutes from './routes/processes.js';
import settingsRoutes, { restoreOpenAIProvider, restoreAnthropicProvider, activeProviderModelMeta } from './routes/settings.js';
import usageRoutes from './routes/usage.js';
import subscriptionUsageRoutes from './routes/subscription-usage.js';
import pricingRoutes from './routes/pricing.js';
import memoryRoutes from './routes/memory.js';
import promptTemplateRoutes from './routes/prompt-templates.js';
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
import skillsRoutes from './routes/skills.js';
import backgroundsRoutes from './routes/backgrounds.js';
import skinsPacksRoutes from './routes/skins-packs.js';
import screenshotRoutes from './routes/screenshot.js';
import imageRoutes from './routes/image.js';
import {
  authMiddleware, isLocalReq, isAuthorized, parseCookies, verifyToken,
  hasPassword, setPassword, setDefaultRandomPassword, clearPassword, verifyPassword, issueToken, updateConfig, loadConfig,
  requestHostname, getTunnelHostname,
} from './services/auth.js';
import { setupFileWatcher } from './services/file-watcher.js';
import { resolveWorkspacePath } from './utils/safe-path.js';
import { clients, broadcast } from './broadcast.js';
import { getDefaultModel, getAvailableModels, setDefaultModel } from './services/model-resolver.js';
import { readdir, readFile } from 'fs/promises';
import { homedir, networkInterfaces } from 'os';
import { stripInheritedProviderEnv } from './utils/provider-env.js';

// 宿主 env 隔离(必须是模块体的第一条语句):Claude Desktop / 一个 claude 会话起的 server
// 会继承宿主的 ANTHROPIC_BASE_URL/_MODEL/_TOKEN。settings.json 切到官方后这些键在
// settings 里已被删,但 model-resolver(provider 名、getDefaultModel 第 4 步)与
// GET /api/provider 都会兜底读 process.env → 官方 provider 被判成 DeepSeek(CLI 四档
// alias 行随之消失、"自动"权限档被降级、费用按第三方单价)。server 自身没有任何合法
// 消费这些键的点(子 CLI 的 env 由 cleanChildEnv 单独构造),boot 时删干净即一处堵死。
// 上面所有 import 只在函数体内读这些键,故此处清理先于任何读点生效。
stripInheritedProviderEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
// 本地 bot 版判据:gitignored 的 bots.local.js 只在本机构建里存在,CI checkout(公开版)没有。
// 网络绑定默认策略与 /api/health 的 localBuild 字段(前端自动更新 gate,防公开版自动更新
// 覆盖带 bot 本地版丢 bots.local.js/FDA)都以此为准。
const IS_LOCAL_BUILD = existsSync(join(__dirname, 'routes', 'bots.local.js'));

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
    join(home, '.pyenv', 'shims'),                // pyenv 垫片(uv/uvx 常落这;MCP 走 uvx 需要)
    join(home, '.cargo', 'bin'),                  // cargo 装的 uv/uvx
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
      // CI-1 同款坑:现代 Node execFile 直跑 .cmd 抛 EINVAL → 此前 Windows 上这段
      // 静默失败,npm prefix 从未补进 PATH("npm 装完检测不到"的根因之一)。经 cmd.exe /c,
      // 并改用 `npm config get prefix`(`npm prefix -g` 在部分 npm 版本打印的是 cwd)。
      const { stdout } = process.platform === 'win32'
        ? await promisify(execFile)('cmd.exe', ['/c', 'npm', 'config', 'get', 'prefix'], { timeout: 8000 })
        : await promisify(execFile)('npm', ['prefix', '-g'], { timeout: 8000 });
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
// 全新机器(从未跑过 claude)没有 ~/.claude 目录,而 settings.json 的 9 处写点
// (provider 切换各分支 / PUT settings / settings-env / global-hooks)都用 writeFile
// 直写不建父目录 → ENOENT"找不到 settings.json"(用户新机实报,还连锁出 provider
// 重复条目)。boot 一次 mkdir 覆盖全部现存与未来写点;已存在时是 no-op。
try { mkdirSync(join(homedir(), '.claude'), { recursive: true }); } catch (e) { console.warn('[boot] mkdir ~/.claude failed:', e.message); }
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
        // 公开版自愈(用户实报"设了密码保存重启后显示未打开"=陷阱态每次启动静默回落):
        // 公开版本就默认"局域网开+每台随机密码",密码记录丢失时按同一策略重新生成随机
        // 密码保持局域网开启(绝不无密码暴露),横幅会提示新默认密码并建议修改。
        // 本地 bot 版不自愈(个人机器不该未经确认重新开放局域网),维持回落+downgraded 横幅引导。
        const isPublicBuild = !IS_LOCAL_BUILD;
        if (isPublicBuild) {
          try {
            setDefaultRandomPassword();
            console.warn('[network] config requests 0.0.0.0 but password record was missing — regenerated a random default password (public build self-heal), LAN stays enabled.');
            return { host: '0.0.0.0', port };
          } catch {}
        }
        console.warn('[network] config requests 0.0.0.0 but no password is set — falling back to 127.0.0.1. Set a password in Settings → 网络 to enable network access.');
        host = '127.0.0.1';
      }
      return { host, port };
    }
    // 首次无配置(按产品方/用户明确要求区分本地版与公开版):
    //  - 本地 bot 版(routes 下有 *.local.js):默认仅回环 127.0.0.1,局域网由用户自己在设置→网络开。
    //  - 公开版(无 *.local.js,CI checkout 不含 gitignored 的 .local):默认开局域网 0.0.0.0 +
    //    【每台随机】默认密码(非全网统一硬编码,消灭"一个常量打穿所有装机"),明文存 config 供本机 UI
    //    显示一次、defaultPassword:true 提示改。手机连时输那串随机码即可。用户改密码后标记与明文自动清。
    const isLocalBuild = IS_LOCAL_BUILD;
    if (!isLocalBuild) {
      try {
        setDefaultRandomPassword(); // 写 passwordHash + defaultPassword:true + defaultPasswordPlain
        updateConfig({ host: '0.0.0.0', port: 6677 });
        return { host: '0.0.0.0', port: 6677 };
      } catch {}
    }
    return { host: '127.0.0.1', port: 6677 };
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
// ── DNS-rebinding 防护:Host 头白名单(必须在所有中间件/路由最前)──────────────
// 根因:isLocalReq 只看 socket 是不是回环、CORS 用"Origin==自身 Host"自指判定,
// 都不校验 Host 头本身。攻击者把 evil.com 短 TTL 重绑到 127.0.0.1,受害者浏览器
// 连到回环但发 Host: evil.com → 被当本机免密 + CORS 自指放行 → 无密码接管全 API
// (读 token/写删文件/跑命令)。实测复现:Host 伪装即 authed:true 且读到 network.json。
// 修:请求 Host 的主机名必须 ∈ {localhost,127.0.0.1,::1,本机 LAN IP(仅 lanMode),
// tunnelHostname(仅配置且合法时)}。浏览器无法伪造 Host(受 fetch 限制),故 evil.com
// 的 Host 一定落在白名单外 → 403。
// 放行无 Host 头(非浏览器/健康探测)与端口无关(只比主机名)。
// 隧道域名放行只开门不减免密码:isLocalReq 的 CF 标记+Host 双否决保证隧道流量仍要密码。
function isAllowedHost(req) {
  const h = requestHostname(req);
  if (!h) return true; // 无 Host 头:非浏览器客户端,socket/密码层继续兜底
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (lanMode && lanIps().includes(h)) return true;
  const t = getTunnelHostname(); // 每请求现读,配置生效免重启;未配置/非法 → '' 不放行
  if (t && h === t) return true;
  return false;
}
app.use((req, res, next) => {
  if (isAllowedHost(req)) return next();
  res.status(403).json({ error: 'Host not allowed (DNS-rebinding protection)' });
});
// ── 隧道 http→https 301(修"http 下 Secure cookie 拒存 → 登录死循环")─────────
// 根因链:CF 边缘 80 端口开着不自动跳转;审计-1 给隧道来源的 cookie 加了 Secure,
// 手机经 http:// 隧道域名登录成功但浏览器在 http 下拒存 Secure cookie → reload 后
// auth-status 无 cookie → 弹回登录页死循环。源站自己动手:Host===配置的
// tunnelHostname 且 CF-Visitor 的 JSON 里 scheme==="http" → 301 到 https。
// 位置约定:在 Host 白名单门之后(evil.com 依旧先 403)、鉴权与限速之前
// (POST /api/login 也 301,不吃密码错误或限速次数)。
// CF-Visitor 只用于判 scheme 这一个用途,不作任何放行依据;无此头 / scheme=https /
// 非隧道 Host / 本机伪造此头(Host 不匹配) / 畸形 JSON → 一律不 301、不 5xx,按原逻辑走。
app.use((req, res, next) => {
  const t = getTunnelHostname();
  if (!t || requestHostname(req) !== t) return next();
  const visitor = req.headers['cf-visitor'];
  if (typeof visitor !== 'string') return next();
  let scheme = null;
  try { scheme = JSON.parse(visitor)?.scheme; } catch { return next(); }
  if (scheme !== 'http') return next();
  res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
});
// Same-origin only: in prod the SPA is served from this same port; in dev Vite
// proxies /api + /ws server-side. So the only legitimate browser origins are
// localhost/127.0.0.1. Reject everything else to blunt drive-by cross-origin
// requests from arbitrary web pages the user may have open.
app.use(cors((req, cb) => cb(null, {
  origin: (origin, originCb) => {
    if (isAllowedBrowserOrigin(origin, req)) return originCb(null, true);
    // 拒了要留痕:曾因 403 不记来源,把 7 月的旧拦截噪音误当成隧道故障排查半天。
    console.warn('[cors] blocked origin=%s host=%s path=%s', origin, requestHostname(req) || '(无)', req.originalUrl);
    const err = new Error('Cross-origin request blocked by cc-gui');
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
  res.json({ ok: true, app: 'claude-gui', port: PORT, version: APP_VERSION, localBuild: IS_LOCAL_BUILD });
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

// S2:登录失败限速。无此限制时,配合局域网绑定,在线爆破密码可行(scrypt 只防离线)。
// 按来源 IP 计失败数,≥5 次起指数退避锁定(封顶 5 分钟),成功即清零。纯内存、进程级。
const _loginFails = new Map(); // ip -> { count, until }
// 分桶 key:隧道流量 socket 全是回环(cloudflared 拨入),按 socket 分桶等于全网共享一桶
// (一个攻击者锁死所有隧道用户)且攻击者换个出口 IP 也不换桶(限速对隧道爆破失效)。
// 故仅当三条件同时成立——socket 回环 ∧ Host===配置的 tunnelHostname ∧ cf-ray 存在
// (即确系隧道流量)——才按 CF-Connecting-IP 值分桶(该头由 CF 边缘重写,隧道攻击者
// 无法伪造);其余一律回落 socket 分桶。LAN 直连者伪造 CF 头换桶绕限速的后门由此堵死
// (socket 非回环,三条件直接不成立);取不到 cf-connecting-ip 时回落 socket 共享桶
// (仍限速,安全方向)。CF 头在此只用于【分桶】,绝不用于放行/grant。
function _loginIp(req) {
  const socketIp = req.socket?.remoteAddress || req.ip || 'unknown';
  const loopback = socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '::ffff:127.0.0.1';
  const t = getTunnelHostname();
  if (loopback && t && requestHostname(req) === t && req.headers?.['cf-ray'] !== undefined) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp) return cfIp;
  }
  return socketIp;
}
function _loginBlockedMs(ip) {
  const r = _loginFails.get(ip);
  return r && r.until > Date.now() ? r.until - Date.now() : 0;
}
function _loginRecordFail(ip) {
  const r = _loginFails.get(ip) || { count: 0, until: 0 };
  r.count += 1;
  if (r.count >= 5) r.until = Date.now() + Math.min(5 * 60_000, 1000 * 2 ** (r.count - 5));
  _loginFails.set(ip, r);
}

// POST /api/login { password } — verify and hand back an HMAC cookie token.
app.post('/api/login', (req, res) => {
  if (!hasPassword()) return res.json({ ok: true, required: false });
  const ip = _loginIp(req);
  const blockedMs = _loginBlockedMs(ip);
  if (blockedMs > 0) {
    return res.status(429).json({ error: `尝试过多，请 ${Math.ceil(blockedMs / 1000)} 秒后再试` });
  }
  const { password } = req.body || {};
  if (!verifyPassword(password)) {
    _loginRecordFail(ip);
    return res.status(401).json({ error: '密码错误' });
  }
  _loginFails.delete(ip); // 成功登录清零
  // Secure 按来源区分(审计-1):隧道域名访问走 https,但 CF 边缘 80 端口默认也开,
  // 手机一旦走 http:// 隧道域名,30 天 token 会在手机→边缘这段公网明文泄露 → 隧道
  // 来源的 cookie 追加 Secure(浏览器只在 https 回传)。本机 localhost/LAN 是 http,
  // 加 Secure 会打断 LAN 登录(Safari 不认 http+Secure)→ 本机/LAN 来源不加。
  const t = getTunnelHostname();
  const secure = t && requestHostname(req) === t ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `cgui_token=${issueToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure}`,
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
app.use('/api', promptTemplateRoutes);
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
app.use('/api', skillsRoutes);
app.use('/api', backgroundsRoutes);
app.use('/api', skinsPacksRoutes); // r11-③ 皮肤包(/api/skins,避开既有 /api/skills)
app.use('/api', screenshotRoutes);
app.use('/api', imageRoutes); // r16-3 生图(/api/image-providers、/api/image/*),配置独立不碰 settings.json

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
  // configHost=配置文件想要的绑定;与 live HOST 不一致(典型:配置 0.0.0.0 但 passwordHash
  // 丢失被 HARD SAFETY 回落)→ downgraded,前端据此显示红色横幅引导补密码,不再静默"显示没打开"。
  const _fileCfg = loadConfig();
  const configHost = _fileCfg.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  res.json({
    host: HOST, port: PORT, lanMode, lanIps: lanIps(),
    configHost, downgraded: configHost === '0.0.0.0' && !lanMode,
    configPath: NETWORK_CONFIG_PATH,
    hasPassword: hasPassword(),
    watchdog,
    // Tauri 双击启动虽无 watchdog,但能运行时 relisten 切 host → 重启按钮可用。
    canRestart: watchdog || process.env.CGUI_TAURI === '1',
    // 公开版首启的【随机】默认密码未改 → 前端横幅提示"你在用默认密码 XXXX,建议修改"。
    defaultPassword: loadConfig().defaultPassword === true,
    // 明文只回给【本机请求】(本机 UI 要显示给用户抄到手机);远程/未鉴权不给,避免泄露默认密码。
    defaultPasswordPlain: (isLocalReq(req) && loadConfig().defaultPassword === true)
      ? (loadConfig().defaultPasswordPlain || null) : null,
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
  // 密码等价于全主机 RCE(经 /api/chat),限速仅指数退避封顶 5min/IP → 最小 6 位(用户要求,
  // 便于用 123456 等简单密码;⚠️弱密码在线爆破仍可行,联网暴露风险自负)。
  if (host === '0.0.0.0' && !hasPassword() && !(typeof password === 'string' && password.length >= 6)) {
    return res.status(400).json({ error: '开启局域网访问必须先设置访问密码（至少 6 位）', needPassword: true });
  }
  try {
    if (typeof password === 'string' && password.length >= 6) { setPassword(password); updateConfig({ defaultPassword: false }); }
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
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  setPassword(password);
  res.json({ ok: true, hasPassword: true });
});

// GET /api/model — current default model + available models
app.get('/api/model', async (req, res) => {
  try {
    const data = await getAvailableModels();
    // settings.json 的默认思考强度(env.CLAUDE_CODE_EFFORT_LEVEL)。前端 effort 选择器
    // 原本只读 localStorage,会出现"settings 设了 high 却显示默认"(实际 CLI 不传
    // --effort 时读 settings 用 high,只是显示没反映)。返回它供前端在 localStorage 为空
    // 时显示,让显示与实际一致。
    let defaultEffort = '';
    try {
      const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf-8'));
      defaultEffort = s.env?.CLAUDE_CODE_EFFORT_LEVEL || '';
    } catch {}
    // r10-9:当前激活 provider 的每模型思考能力声明(null = 无声明,全档可用)。
    const modelMeta = await activeProviderModelMeta();
    res.json({ model: data.current, available: data.models, provider: data.provider, defaultEffort, modelMeta });
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
    // setDefaultModel 的官方端点残留守卫抛 err.status=400(用户输入问题,不是服务端故障)。
    res.status(err.status || 500).json({ error: err.message });
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
  { name: '/review',          desc: '代码审查(2.1.223 起为 /code-review 别名)', type: 'builtin' },
  { name: '/goal',            desc: '设定目标，Claude 停止前会检查是否达成（参数：<condition> | clear）', type: 'builtin' },
  { name: '/code-review',     desc: '评审当前分支或指定 PR 的代码改动（由 code-review 插件提供，未安装时不可用）', type: 'builtin' },
  { name: '/pr-comments',     desc: '查看 PR 评论',        type: 'builtin' },
  { name: '/security-review', desc: '安全审查',            type: 'builtin' },
  { name: '/bug',             desc: '报告 Bug',            type: 'builtin', requiresAnthropic: 'partial', note: '上报到 Anthropic' },
  { name: '/add-dir',         desc: '添加工作目录',        type: 'builtin' },
  { name: '/export',          desc: '导出会话',            type: 'builtin' },
  { name: '/todos',           desc: '查看任务列表',        type: 'builtin' },
  { name: '/context',         desc: '上下文用量明细',      type: 'builtin', note: 'GUI 顶部徽章已原生展示，点击徽章看分类明细' },
  { name: '/usage',           desc: '订阅用量',            type: 'builtin', requiresAnthropic: 'partial', note: 'GUI 用量面板已原生展示' },
  // CLI 的 /btw 是交互式专属(stream-json 里发送被拒),GUI 前端拦截后走 /api/chat/btw
  // (headless fork,不污染主会话),故对用户可用,不标 interactiveOnly。
  { name: '/btw',             desc: '旁问一个问题（参数：<question>），不打断当前工作、不写入会话历史', type: 'builtin' },
  // CLI 内置 skill，打包在二进制里、磁盘扫描枚举不到（init 表也会补一条，此处是 server
  // 重启后缓存为空时的兜底）。描述里必须写清存活边界：调度器跑在本回合的 CLI 子进程内，
  // 进程被回收或 GUI 关闭即停（server/routes/chat.js 的 cron 保活豁免只把回收推迟到 2 小时）。
  { name: '/loop',            desc: '按间隔重复执行一个提示或斜杠命令（如 /loop 5m /foo）；省略间隔则由模型自行掌握节奏。循环由本地 CLI 进程驱动，关闭 GUI 或进程被回收后停止', type: 'builtin' },

  // -p 模式 CLI 拒绝（交互式专属）
  { name: '/branch',         desc: '从当前对话分叉出一条新线，在不影响原会话的前提下试另一种方向（fork）', type: 'builtin', interactiveOnly: true, note: 'GUI 已原生实现：每条消息/回复的「分叉」按钮从该处精确分叉（只保留到此的上下文），在最后一条分叉等价于整会话' },
  { name: '/rewind',         desc: '回退会话/代码',   type: 'builtin', interactiveOnly: true, note: 'GUI 用消息上的回滚/checkpoint 菜单实现' },
  { name: '/rename',         desc: '重命名会话',     type: 'builtin', interactiveOnly: true, note: 'GUI 直接点会话标题即可编辑' },
  { name: '/bashes',         desc: '后台 shell 列表', type: 'builtin', interactiveOnly: true, note: 'GUI 进程面板已原生展示' },
  { name: '/help',           desc: '帮助',           type: 'builtin', interactiveOnly: true },
  { name: '/status',         desc: '会话状态',       type: 'builtin', interactiveOnly: true },
  { name: '/doctor',         desc: '健康检查',       type: 'builtin', interactiveOnly: true },
  { name: '/mcp',            desc: 'MCP 管理',       type: 'builtin', interactiveOnly: true },
  { name: '/config',         desc: '配置',           type: 'builtin', interactiveOnly: true },
  { name: '/permissions',    desc: '权限设置',       type: 'builtin', interactiveOnly: true },
  { name: '/model',          desc: '切换模型',       type: 'builtin', interactiveOnly: true, requiresAnthropic: 'partial' },
  { name: '/memory',         desc: '编辑 CLAUDE.md', type: 'builtin', interactiveOnly: true },
  { name: '/agents',         desc: '子代理管理(CLI 交互向导已于 2.1.198 移除;GUI 的 Agent 面板为原生实现)', type: 'builtin', interactiveOnly: true },
  { name: '/vim',            desc: 'Vim 模式',       type: 'builtin', interactiveOnly: true },
  { name: '/terminal-setup', desc: '终端集成',       type: 'builtin', interactiveOnly: true },
  { name: '/login',          desc: 'Anthropic 登录', type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full' },
  { name: '/logout',         desc: '退出登录',       type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full' },
  { name: '/fast',           desc: 'Opus Fast',      type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full' },
  { name: '/remote-control', desc: '远程控制会话',   type: 'builtin', interactiveOnly: true, requiresAnthropic: 'full',
    note: 'claude --remote-control 是 CLI flag，需在终端启动' },
];

// 第三方端点不可用的 skill/plugin 名称（按 slash 名匹配）
// 'loop' 已移除：/loop 靠 CronCreate（纯本地工具、调度器在 CLI 进程内），与订阅无关；
// 它此前只是永远走不到的死代码（磁盘上没有同名 skill 目录），激活成真过滤反而会误挡。
const SUBSCRIPTION_ONLY_NAMES = new Set([
  'schedule', 'remote-trigger',
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

    // 项目级命令/skill:CLI 会加载 <cwd>/.claude/commands/*.md 与
    // <cwd>/.claude/skills/<dir>/SKILL.md(官方已把自定义命令并入 skills 体系),
    // 团队共享命令在 CLI 里能跑但此前补全列表看不到(和插件命令是同一类盲区)。
    // 先于全局 ~/.claude/skills 扫描插入 → 同名时项目级优先(下方全局扫描的
    // commands.some 去重会跳过)。cwd 必须过 resolveWorkspacePath 门禁,拒任意路径。
    if (typeof req.query.cwd === 'string' && req.query.cwd) {
      let projRoot = null;
      try { projRoot = resolveWorkspacePath(req.query.cwd); } catch {}
      if (projRoot) {
        // .claude/commands/*.md → 命令名 = 文件名(去扩展名)
        try {
          const files = await readdir(join(projRoot, '.claude', 'commands'), { withFileTypes: true });
          for (const f of files) {
            const m = f.isFile() && f.name.match(/^(.+)\.md$/);
            if (!m || commands.some((c) => c.name === `/${m[1]}`)) continue;
            let desc = '项目命令';
            try {
              const content = await readFile(join(projRoot, '.claude', 'commands', f.name), 'utf-8');
              const dm = content.match(/^\s*description\s*:\s*(.+)$/m);
              if (dm) {
                desc = dm[1].trim().replace(/^["']|["',]+$/g, '');
                if (desc.length > 100) desc = desc.slice(0, 100) + '...';
              }
            } catch {}
            commands.push({ name: `/${m[1]}`, desc, type: 'project', requiresAnthropic: false });
          }
        } catch {}
        // .claude/skills/<dir>/SKILL.md → 命令名 = 目录名
        try {
          const projSkillsDir = join(projRoot, '.claude', 'skills');
          const dirs = await readdir(projSkillsDir, { withFileTypes: true });
          for (const d of dirs) {
            if (!d.isDirectory() || d.name.startsWith('.') || d.name.startsWith('_') || commands.some((c) => c.name === `/${d.name}`)) continue;
            if (!existsSync(join(projSkillsDir, d.name, 'SKILL.md')) && !existsSync(join(projSkillsDir, d.name, 'skill.md'))) continue; // 无 SKILL.md 不是技能
            commands.push({
              name: `/${d.name}`,
              desc: await getSkillDescription(projSkillsDir, d.name),
              type: 'project',
              requiresAnthropic: false,
            });
          }
        } catch {}
      }
    }

    const skillsDir = join(homedir(), '.claude', 'skills');
    try {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      // 官方约定:技能=目录含 SKILL.md;跳 _/. 开头(如 _shared 门禁基建目录),无 SKILL.md 的目录不是技能不列
      const skillDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && (existsSync(join(skillsDir, e.name, 'SKILL.md')) || existsSync(join(skillsDir, e.name, 'skill.md'))));
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

    // 插件命令按 CLI 真实形态枚举成 /插件名:命令名(如 /superpowers:brainstorming)。
    // 旧实现只塞一个凭空造的 /插件名 占位(CLI 里并不存在该命令)→ 用户装了
    // superpowers 等插件后在 GUI 输入框敲 "/" 完全看不到插件提供的命令(实际
    // 会话里 CLI 已加载,只是补全列表无感知)。枚举口径对照 CLI init 事件的
    // slash_commands 实测对齐:
    //   <installPath>/commands/*.md|*.toml  → 命令名 = 文件名(去扩展名)
    //   <installPath>/skills/<dir>/SKILL.md → 命令名 = 目录名
    // 仅列 settings.json enabledPlugins 显式为 true 的插件(CLI 同口径:装了但
    // 停用的不加载);描述取 frontmatter/toml 的 description。
    try {
      const pluginsData = JSON.parse(
        await readFile(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf-8')
      );
      let enabledPlugins = {};
      try {
        const settings = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf-8'));
        enabledPlugins = settings.enabledPlugins || {};
      } catch {}
      const plugins = pluginsData.plugins || {};
      for (const [fullName, installs] of Object.entries(plugins)) {
        if (enabledPlugins[fullName] !== true) continue;
        const pluginName = fullName.split('@')[0];
        const installPath = Array.isArray(installs) ? installs[0]?.installPath : installs?.installPath;
        if (!installPath) continue;
        const requiresAnthropic = SUBSCRIPTION_ONLY_NAMES.has(pluginName) ? 'full' : false;
        const seen = new Set(); // 同名 command 与 skill 只列一次
        // commands/*.md|*.toml
        try {
          const files = await readdir(join(installPath, 'commands'), { withFileTypes: true });
          for (const f of files) {
            const m = f.isFile() && f.name.match(/^(.+)\.(md|toml)$/);
            if (!m || seen.has(m[1])) continue;
            seen.add(m[1]);
            let desc = `Plugin: ${pluginName}`;
            try {
              const content = await readFile(join(installPath, 'commands', f.name), 'utf-8');
              const dm = content.match(/^\s*description\s*[:=]\s*(.+)$/m);
              if (dm) {
                desc = dm[1].trim().replace(/^["']|["',]+$/g, '');
                if (desc.length > 100) desc = desc.slice(0, 100) + '...';
              }
            } catch {}
            commands.push({ name: `/${pluginName}:${m[1]}`, desc, type: 'plugin', requiresAnthropic });
          }
        } catch {}
        // skills/<dir>/SKILL.md
        try {
          const dirs = await readdir(join(installPath, 'skills'), { withFileTypes: true });
          for (const d of dirs) {
            if (!d.isDirectory() || d.name.startsWith('.') || seen.has(d.name)) continue;
            seen.add(d.name);
            const desc = await getSkillDescription(join(installPath, 'skills'), d.name);
            commands.push({ name: `/${pluginName}:${d.name}`, desc, type: 'plugin', requiresAnthropic });
          }
        } catch {}
      }
    } catch {}

    // 最后并入 CLI init 事件上报的权威表（含打包进二进制、上面三处磁盘扫描都看不到的
    // 内置 skill，如 /loop）。放在最后 = 磁盘/硬编码已有的条目保留其描述与元数据，
    // init 只补缺失的名字。缓存为空（server 刚重启、本 cwd 还没起过会话）时原样返回。
    mergeInitCommands(commands, getInitCommands(typeof req.query.cwd === 'string' ? req.query.cwd : ''));

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
  if (req.originalUrl?.startsWith('/api/chat/steer')) {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ ok: false, code: 'request-too-large', error: '消息内容过大' });
    }
    if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && err?.status === 400)) {
      return res.status(400).json({ ok: false, code: 'malformed-json', error: '请求 JSON 格式错误' });
    }
  }
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
    // WS 升级不经 express 中间件,须自带 DNS-rebinding 的 Host 白名单(同 HTTP 层)。
    if (!isAllowedHost(info.req)) { console.warn('[ws] blocked host=%s', requestHostname(info.req) || '(无)'); return false; }
    if (!isAllowedBrowserOrigin(info.origin || info.req?.headers?.origin, info.req)) { console.warn('[ws] blocked origin=%s host=%s', info.origin || info.req?.headers?.origin, requestHostname(info.req) || '(无)'); return false; }
    if (!hasPassword()) return true;
    if (isLocalReq(info.req)) return true;
    return verifyToken(parseCookies(info.req).cgui_token);
  },
});

// Track connected clients（clients/broadcast 抽到 ./broadcast.js,避免 route 反向 import 本文件成环）
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  // 客户端应用层心跳:回 pong 供对端确认链路存活。Tailscale/手机网络的"半死连接"
  // 不触发 close 事件,客户端靠"发 ping 后收不到任何消息"判死并重连(useWebSocket)。
  ws.on('message', (buf) => {
    // 短路超大帧:ping 帧极小,>256B 不解析(避免对任意入站大 payload 做 JSON.parse)。
    if (!buf || buf.length > 256) return;
    try {
      if (JSON.parse(buf)?.type === 'ping' && ws.readyState === 1) ws.send('{"type":"pong"}');
    } catch { /* 非 JSON 或非 ping,忽略 */ }
  });

  getDefaultModel()
    .then((model) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'model', model }));
    })
    .catch((err) => console.warn('getDefaultModel on WS connect failed:', err.message));
});

// File watcher → WebSocket broadcast.
// settings.json is the file `cc switch` rewrites — when it changes, tell every
// connected client so ModelSelector / ProviderAvatar can refetch /api/model and
// reflect the new provider without a page reload.
let watcher = null;
// W3①:provider-change 广播携带 provider 指纹(BASE_URL + 凭证哈希前 12 位)。客户端
// 据此判断"是真的换了 provider(终端 cc switch)还是 settings.json 的其他改动",
// 只有指纹变化才清会话模型钉选 + 推进 providerEpoch —— effort 等无关改动
// 不能过度失效历史模型。chokidar 分支与打包版单文件 watch 分支共用。
function broadcastProviderChange(filePath) {
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
if (process.env.CGUI_DISABLE_FILE_WATCHER !== '1') {
  try {
    watcher = setupFileWatcher((eventType, filePath) => {
      // Windows 原生 watcher 发反斜杠路径,客户端 endsWith(`/sid.jsonl`) 只认正斜杠
      // → dev 模式在 Windows 上会话变更不自动刷新(判官 A#2)。出口统一归一。
      const normPath = String(filePath).replace(/\\/g, '/');
      if (normPath.endsWith('/.claude/settings.json')) {
        broadcastProviderChange(normPath);
      }
      broadcast({ type: 'file-change', eventType, path: normPath });
    });
  } catch {
    console.warn('File watcher failed to start (chokidar)');
  }
} else {
  console.log('[file-watcher] disabled for packaged Tauri backend');
  // 打包版禁 chokidar 后,终端 `cc switch` 改 settings.json 就再无人通知客户端 →
  // GUI 顶栏 provider 头像/模型停在旧值。补一个只盯这一个文件的轻量 watch:
  // watch 的是 ~/.claude 父目录而非文件本身 —— 编辑器与我们自己的写入都是
  // tmp+rename 原子写,直接 watch 文件会在 rename 后盯着旧 inode 失联(mac 上
  // fs.watch 文件跟的是 inode);watch 目录则 rename 进来也照报,跨平台稳。
  // 500ms 去抖:一次原子写会连发 rename+change 多个事件,只广播一次。
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    let debounce = null;
    const dirWatcher = fsWatch(join(homedir(), '.claude'), (eventType, filename) => {
      // filename 偶发为 null(平台差异)→ 宽松处理:null 也当可能命中,由去抖兜住频率。
      if (filename && String(filename) !== 'settings.json') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { try { broadcastProviderChange(settingsPath); } catch {} }, 500);
    });
    dirWatcher.on('error', () => {});
  } catch {
    console.warn('[file-watcher] settings.json single-file watch failed to start');
  }
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

// A5 启动清扫:上次异常退出(崩溃/强杀)残留在系统临时目录的 cgui-acw-*.json /
// cgui-settings-*.json(正常路径回合结束就地 unlink,残留只在异常退出时产生)。
// 仅删 mtime>24h 的(绝不碰在跑会话正在用的),全程 best-effort 静默,异步不阻塞启动。
(async () => {
  try {
    const { readdir, stat, unlink } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const dir = tmpdir();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of await readdir(dir)) {
      if (!/^cgui-(acw|settings)-.*\.json$/.test(name)) continue;
      try {
        const p = join(dir, name);
        if ((await stat(p)).mtimeMs < cutoff) await unlink(p);
      } catch { /* 单个文件失败不影响其余 */ }
    }
  } catch { /* tmpdir 不可读等,静默 */ }
})();

server.listen(PORT, HOST, () => {
  const exposure = HOST === '127.0.0.1'
    ? ' (loopback only)'
    : hasPassword()
      ? ' (network-exposed, password protected)'
      : ' (network-exposed)';
  console.log('═'.repeat(60));
  console.log(`  cc-gui server READY   http://localhost:${PORT}`);
  console.log(`  WebSocket                  ws://localhost:${PORT}/ws`);
  console.log(`  Bound to                   ${HOST}${exposure}`);
  console.log(`  Started at                 ${new Date().toLocaleString()}`);
  console.log('═'.repeat(60));
  // r13-p2-6:后台预热会话列表缓存 —— 首屏展开项目不再等 1-2 秒解析。
  // 逐个串行(不抢 I/O),失败静默;缓存本身按 mtime 判定,预热只是把冷启动前置。
  (async () => {
    try {
      const { listProjects, listSessions } = await import('./services/session-reader.js');
      const projects = await listProjects(); // 已按最近活动排序:先热最可能点开的
      const queue = projects.slice(0, 16);
      const worker = async () => {
        while (queue.length) {
          const p = queue.shift();
          if (p?.hash) await listSessions(p.hash).catch(() => {});
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]); // 并发 4,别抢满 I/O
    } catch {}
  })();
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
