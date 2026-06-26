import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir, homedir } from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, '..', '..', 'package.json');
const router = Router();

// GitHub API 缓存。未认证 IP 限制 60 次/小时,用户频繁点"检查更新"或多台
// 设备同 IP 很容易撞 403 → 设 5 分钟 TTL 重用上次结果,即便 403 也回 200
// 旧数据,不让 UI 报错。
let cache = null;       // { tagName, htmlUrl, publishedAt, assets } 缓存的 GitHub 响应
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCurrentVersion() {
  try { return JSON.parse(readFileSync(PKG_PATH, 'utf-8')).version || null; } catch { return null; }
}

// 简单语义版本对比 0.1.24 vs 0.1.23 — 前 3 段数字逐位比较;比较器只关心
// 我们自己的 vX.Y.Z 格式,不处理 pre-release 标签(本项目从不用)。
function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

/**
 * GET /api/version-check
 * 比对本地 package.json 版本与 GitHub releases/latest tag。
 * 返回 { currentVersion, latestVersion, hasUpdate, htmlUrl, publishedAt, error? }。
 * 失败永远返回 200 — 前端只看 hasUpdate / error 字段决定 UI。
 */
// 从 tag_name 构造常用资产直链 — 当 GitHub 返回 403/empty assets 时兜底,确保
// 前端"一键下载并安装"按钮始终可用。直链模式即使 API 拒,Release 页面的资产
// 文件仍可直接 GET(走 CDN,不计 API rate limit)。
function buildFallbackAssets(version) {
  return [
    { name: `Claude.GUI_${version}_aarch64.dmg`,
      url: `https://github.com/wsxwj123/claude-gui/releases/download/v${version}/Claude.GUI_${version}_aarch64.dmg`,
      size: 0 },
    { name: `Claude.GUI_${version}_x64-setup.exe`,
      url: `https://github.com/wsxwj123/claude-gui/releases/download/v${version}/Claude.GUI_${version}_x64-setup.exe`,
      size: 0 },
    { name: `Claude.GUI_${version}_x64_en-US.msi`,
      url: `https://github.com/wsxwj123/claude-gui/releases/download/v${version}/Claude.GUI_${version}_x64_en-US.msi`,
      size: 0 },
  ];
}

const GH_HEADERS = { 'User-Agent': 'claude-gui-version-check', 'Accept': 'application/vnd.github+json' };

// 退路:`releases/latest` 在"还没有已发布 release"时返回 404 —— CI 正在构建(~9min)、
// 或刚删了旧 release 的空窗,都会让它 404 → 检测彻底失效(用户报告的"显示最新/404")。
// 而 git **tag 一推上去就立刻存在**(不依赖 CI),所以退回看最大 semver tag,检测照常工作;
// 下载链接用 tag 直链兜底(buildFallbackAssets),CI 发布 DMG 后即可下。
async function fetchLatestTagSnap() {
  const r = await fetch('https://api.github.com/repos/wsxwj123/claude-gui/tags?per_page=100', { headers: GH_HEADERS });
  if (!r.ok) { const err = new Error(`GitHub API ${r.status}`); err.status = r.status; throw err; }
  const arr = await r.json();
  const names = (Array.isArray(arr) ? arr : [])
    .map((t) => String(t.name || ''))
    .filter((n) => /^v?\d+\.\d+\.\d+$/.test(n));
  if (!names.length) throw new Error('GitHub 仓库没有符合 semver 的 tag');
  names.sort((a, b) => (semverGt(a.replace(/^v/, ''), b.replace(/^v/, '')) ? -1 : 1));
  const raw = names[0].replace(/^v/, '');
  return { tagName: `v${raw}`, htmlUrl: `https://github.com/wsxwj123/claude-gui/releases/tag/v${raw}`, publishedAt: null, assets: [] };
}

async function fetchGitHubLatest() {
  const r = await fetch('https://api.github.com/repos/wsxwj123/claude-gui/releases/latest', { headers: GH_HEADERS });
  if (r.status === 404) return await fetchLatestTagSnap(); // 无已发布 release → 退回看最新 tag
  if (!r.ok) {
    const err = new Error(`GitHub API ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const d = await r.json();
  return {
    tagName: String(d.tag_name || ''),
    htmlUrl: d.html_url || '',
    publishedAt: d.published_at || null,
    assets: Array.isArray(d.assets)
      ? d.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
      : [],
  };
}

router.get('/version-check', async (req, res) => {
  const currentVersion = getCurrentVersion();
  if (!currentVersion) {
    return res.json({ currentVersion: null, error: '无法读取本地版本(package.json)' });
  }

  let snap;
  const now = Date.now();
  // TTL 内复用缓存,避开 GitHub 60/hr rate limit
  if (cache && now - cachedAt < CACHE_TTL_MS) {
    snap = cache;
  } else {
    try {
      snap = await fetchGitHubLatest();
      cache = snap;
      cachedAt = now;
    } catch (err) {
      // 403 / 网络失败 — 如果有旧缓存就用旧缓存(stale-while-error),没有就报错
      if (cache) {
        snap = cache;
      } else {
        return res.json({ currentVersion, error: err.message || 'fetch failed' });
      }
    }
  }

  const latestRaw = snap.tagName.replace(/^v/, '');
  if (!latestRaw) return res.json({ currentVersion, error: 'GitHub 未返回 tag_name' });
  const hasUpdate = semverGt(latestRaw, currentVersion);
  // assets 为空(403 期间也可能拿到不完整数据)时用 tag 直链兜底
  const assets = snap.assets.length > 0 ? snap.assets : buildFallbackAssets(latestRaw);

  res.json({
    currentVersion,
    latestVersion: latestRaw,
    hasUpdate,
    htmlUrl: snap.htmlUrl || `https://github.com/wsxwj123/claude-gui/releases/tag/v${latestRaw}`,
    publishedAt: snap.publishedAt,
    assets,
    // server 端 process.platform 比前端 navigator.userAgent 更可靠 — Tauri
    // WebView2/WKWebView 的 UA 在某些版本被改写过,前端单独靠 UA 选 asset
    // 可能 null → 按钮不渲染只剩手动链接(用户当前的体感问题)。
    serverPlatform: process.platform,
  });
});

// ─── Claude Code CLI 版本检测 + 一键更新 ───────────────────────────────
let ccCache = null;       // npm registry 上 @anthropic-ai/claude-code 的 latest 版本
let ccCachedAt = 0;

async function getClaudeVersion(claudePath) {
  try {
    // 优先用 detectInstall 解析到的绝对路径,确保"报告的版本"与"要更新的那个 claude"
    // 是同一个(否则 mac 上 login-shell PATH 与 Node 进程 PATH 顺序不同可能取到不同安装)。
    // `claude --version` → "2.1.160 (Claude Code)"，取首个 x.y.z
    // CI-1:Windows 上 npm 装的是 claude.cmd/.ps1 或 `where claude` 给的是无扩展名裸路径
    // (如 ...\npm\claude)——Node execFile **不能直接执行**它们(.cmd 抛 EINVAL、无扩展名抛
    // ENOENT),必须经 cmd.exe /c(cmd 会按 PATHEXT 把裸路径解析成 .cmd)。否则版本检测/环境
    // tab 永远 installed:false(用户报告:npm 装好仍扫不到)。与 cli-check.js 同款修法。
    let stdout;
    if (process.platform === 'win32') {
      ({ stdout } = await execFileP('cmd.exe', ['/c', claudePath || 'claude', '--version'], { timeout: 8000 }));
    } else {
      ({ stdout } = await execFileP(claudePath || 'claude', ['--version'], { timeout: 8000 }));
    }
    const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null; // CLI 未安装 / 不在 PATH
  }
}

async function fetchNpmLatest() {
  const r = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', {
    headers: { 'Accept': 'application/json' },
  });
  if (!r.ok) { const e = new Error(`npm registry ${r.status}`); e.status = r.status; throw e; }
  const d = await r.json();
  return String(d.version || '');
}

// 检测 claude CLI 的安装方式 + 解析它的绝对路径。返回 { method, path }。
// 关键:解析 GUI 实际会用到的那个 claude(与 getClaudeVersion 的 execFile('claude')
// 同源,都走 process.env.PATH),这样更新才打到 GUI 真正读取的那个安装。
// Y1:PATH 解析失败时的兜底 —— 直接探测各安装方式的已知落点。npm i -g 在 prefix
// 不在 PATH 时(用户报告:装成功但 GUI 检测不到)`where/command -v` 都找不到;
// 这里先问 npm 自己的全局 prefix,再扫常见目录,扫到即按绝对路径使用。
async function probeKnownClaude() {
  const home = homedir();
  const candidates = [];
  try {
    const { stdout } = await execFileP(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['prefix', '-g'], { timeout: 6000 },
    );
    const prefix = stdout.trim();
    if (prefix) {
      candidates.push(process.platform === 'win32'
        ? join(prefix, 'claude.cmd')
        : join(prefix, 'bin', 'claude'));
    }
  } catch {}
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    candidates.push(
      join(home, '.local', 'bin', 'claude.exe'),
      join(home, '.claude', 'local', 'claude.exe'),
      join(appData, 'npm', 'claude.cmd'),
      join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'claude.cmd'),
    );
  } else {
    candidates.push(
      join(home, '.local', 'bin', 'claude'),
      join(home, '.claude', 'local', 'bin', 'claude'),
      join(home, '.npm-global', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    );
  }
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return '';
}

async function detectInstall() {
  let real = '';
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileP('where', ['claude'], { timeout: 8000 });
      real = (stdout.split(/\r?\n/).find(Boolean) || '').trim();  // 第一个匹配 = 优先级最高
    } catch {
      real = await probeKnownClaude();
      if (!real) return { method: 'npm', path: '' };
    }
    if (/AnthropicClaude|\\\.claude\\local|\\\.local\\bin|\\claude\\versions\\/i.test(real)) return { method: 'native', path: real };
    if (/npm|node_modules|nodejs/i.test(real)) return { method: 'npm', path: real };
    return { method: 'native', path: real };  // 兜底按 native 自更新(claude update 在 Windows 亦支持)
  }
  try {
    const { stdout } = await execFileP('bash', ['-lc', 'command -v claude'], { timeout: 8000 });
    real = stdout.trim();
    try { const r = await execFileP('readlink', ['-f', real], { timeout: 5000 }); real = r.stdout.trim(); } catch {}
  } catch {
    real = await probeKnownClaude();
    if (!real) return { method: 'unknown', path: '' };
  }
  if (/\/\.local\/(share|bin)\/claude|\/claude\/versions\//.test(real)) return { method: 'native', path: real };
  if (/Caskroom|Cellar|\/brew\//i.test(real)) return { method: 'brew', path: real };
  if (/node_modules|\/npm|\.nvm|\.npm-global|\/lib\/node/.test(real)) return { method: 'npm', path: real };
  return { method: 'unknown', path: real };
}

// 按安装方式给出更新命令。native 用「绝对路径 + update」自更新,避免终端里裸 `claude`
// 解析到另一个安装(用户的 shell PATH 和 GUI 的 PATH 顺序可能不同)。
function updateCmdFor(method, claudePath) {
  switch (method) {
    // Y1:brew 渠道由社区维护、版本严重滞后(用户实测 latest 仅 1.5x,官方已 2.1.x),
    // `brew upgrade` 等于没更新。改为直接运行官方原生安装器:装到 ~/.local/bin,
    // GUI 的 PATH 前置使其优先于 brew 旧版,此后由 claude 自更新接管。
    case 'brew': return installCmdFor();
    // Windows npm 安装的更新仍走 npm(装在哪就用哪更新),用淘宝镜像兜底 —
    // registry.npmjs.org 常被墙,且 cmd 子终端不继承系统代理。
    case 'npm':  return process.platform === 'win32'
      ? 'npm install -g @anthropic-ai/claude-code@latest --registry=https://registry.npmmirror.com'
      : 'npm install -g @anthropic-ai/claude-code@latest';
    case 'native':
    default: {
      // update 与 upgrade 是同一命令的别名;用 upgrade(用户实测 Windows 上体验更好)。
      // 路径按平台正确转义:Windows .bat 用双引号;mac/linux bash 用单引号(防路径含
      // 空格/$/反引号被 shell 解释)。
      let bin = 'claude';
      if (claudePath) {
        bin = process.platform === 'win32'
          ? `"${claudePath}"`
          : `'${claudePath.replace(/'/g, `'\\''`)}'`;
      }
      return `${bin} upgrade`;
    }
  }
}
function installCmdFor(proxyUrl = null, method = 'native') {
  // 未安装时的一键安装命令。method:'npm' | 'native'。
  // npm:读 HTTP_PROXY 环境变量(由 launchInTerminal 在脚本里 set/export),且自带
  // 下载/安装进度输出 —— 想"看得见进度"选它;前提是本机有 node(GUI 后端本就靠 node 跑,
  // 所以 GUI 能开 = node 在)。
  if (method === 'npm') {
    return 'npm install -g @anthropic-ai/claude-code';
  }
  if (process.platform === 'win32') {
    // O2: Windows 官方原生安装器(独立二进制,不需要 Node/npm,自动写 PATH)。
    // 关键(墙内卡死根因):Windows PowerShell 5.1 的 irm/Invoke-WebRequest **不读
    // HTTP_PROXY 环境变量**(只认 WinINET 系统代理),所以外层 .bat 的 `set HTTP_PROXY`
    // 对 irm 无效 → 直连被屏蔽的 claude.ai → 卡死/极慢/无输出(用户报告:只显示代理
    // 端口后再无动静)。检测到本机代理时,在 PowerShell 进程内显式设 .NET DefaultWebProxy
    // + $env,让脚本本体及其下载的二进制都走代理(同进程 iex,代理设置进程级生效)。
    const setup = proxyUrl
      ? `$p='${proxyUrl}'; [System.Net.WebRequest]::DefaultWebProxy=New-Object System.Net.WebProxy($p); $env:HTTP_PROXY=$p; $env:HTTPS_PROXY=$p; Write-Host ('(proxy: '+$p+')'); `
      : '';
    const inner = `${setup}$ProgressPreference='Continue'; Write-Host 'Installing Claude Code CLI (downloading from claude.ai)...'; irm https://claude.ai/install.ps1 | iex`;
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${inner}"`;
  }
  return 'curl -fsSL https://claude.ai/install.sh | bash'; // mac/linux 官方一键安装
}

// 打开一个「可见终端」运行命令,而不是 headless execFile。原因:
//  ① `claude update` / install.sh 是交互式自更新/安装器,无 TTY 时可能挂起或
//     无反馈(用户报告"点了没反应")。
//  ② 终端里跑能让官方安装器自己把 CLI 目录写进 shell profile 的 PATH。
//  ③ 用户能直观看到进度 / 出错信息,无需在 GUI 里盲等。
// 做法:写一个临时脚本,用 `open`(mac)/`start`(win)/终端模拟器(linux)启动。
// fire-and-forget——终端是独立进程,server 不捕获结果,UI 引导用户完成后点"检查更新"。
// M1: 探测本机 HTTP 代理端口(Clash/v2ray 等常用端口)。Windows 终端子进程不继承
// PowerShell/系统代理设置,claude update / install.sh 直连 claude.ai 或 npm 经常
// ETIMEDOUT。找到在听的端口就在更新/安装命令前 export,找不到返回 null(直连)。
const COMMON_PROXY_PORTS = [7890, 7897, 1087, 8889, 8118, 10809];
async function detectLocalProxy() {
  // 用户已显式配置的优先(server 进程自己的 env)。
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) return envProxy;
  const { createConnection } = await import('net');
  const probe = (port) => new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port, timeout: 300 });
    sock.on('connect', () => { sock.destroy(); resolve(port); });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
  const hits = await Promise.all(COMMON_PROXY_PORTS.map(probe));
  const port = hits.find(Boolean);
  return port ? `http://127.0.0.1:${port}` : null;
}

function launchInTerminal(cmd, title, proxyUrl = null) {
  const stamp = `cgui-cc-${process.pid}-${Math.round(process.hrtime()[1])}`;
  if (process.platform === 'darwin') {
    const file = join(tmpdir(), `${stamp}.command`);
    const proxyLine = proxyUrl ? `export HTTP_PROXY='${proxyUrl}' HTTPS_PROXY='${proxyUrl}' http_proxy='${proxyUrl}' https_proxy='${proxyUrl}'\necho "(代理: ${proxyUrl})"\n` : '';
    writeFileSync(file, `#!/bin/bash\necho "▶ ${title}"\n${proxyLine}${cmd}\nstatus=$?\necho\nif [ $status -eq 0 ]; then echo "✅ 完成,可关闭本窗口"; else echo "❌ 失败(退出码 $status)"; fi\n`, { mode: 0o755 });
    spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    const file = join(tmpdir(), `${stamp}.bat`);
    const proxyLine = proxyUrl ? `set HTTP_PROXY=${proxyUrl}\r\nset HTTPS_PROXY=${proxyUrl}\r\necho (代理: ${proxyUrl})\r\n` : '';
    writeFileSync(file, `@echo off\r\necho ▶ ${title}\r\n${proxyLine}${cmd}\r\necho.\r\necho ===== 完成,按任意键关闭 =====\r\npause >nul\r\n`);
    // start '' <file> — 空标题占位,避免把文件路径当成窗口标题
    spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } else {
    const file = join(tmpdir(), `${stamp}.sh`);
    writeFileSync(file, `#!/bin/bash\necho "▶ ${title}"\n${cmd}\necho\nread -p "完成,回车关闭…"\n`, { mode: 0o755 });
    // 常见终端模拟器逐个尝试(best-effort)
    const term = process.env.TERMINAL || 'x-terminal-emulator';
    spawn(term, ['-e', `bash "${file}"`], { detached: true, stdio: 'ignore' }).unref();
  }
}

/**
 * GET /api/claude-version-check
 * 比对本地 `claude --version` 与 npm latest,并返回安装方式 + 对应更新命令。
 * 失败永远返回 200(只看字段)。
 */
router.get('/claude-version-check', async (req, res) => {
  const { method, path: claudePath } = await detectInstall();
  const currentVersion = await getClaudeVersion(claudePath);
  if (!currentVersion) {
    return res.json({
      currentVersion: null, installed: false,
      installCommand: installCmdFor(),
      error: 'Claude Code 未安装或不在 PATH',
    });
  }
  let latest = '';
  const now = Date.now();
  if (ccCache && now - ccCachedAt < CACHE_TTL_MS) {
    latest = ccCache;
  } else {
    try { latest = await fetchNpmLatest(); ccCache = latest; ccCachedAt = now; }
    catch (err) {
      if (ccCache) latest = ccCache;
      else return res.json({ currentVersion, installed: true, method, error: err.message || 'npm 查询失败' });
    }
  }
  res.json({
    currentVersion,
    latestVersion: latest,
    installed: true,
    method,                         // native | brew | npm | unknown
    updateCommand: updateCmdFor(method, claudePath),
    hasUpdate: latest ? semverGt(latest, currentVersion) : false,
  });
});

/**
 * POST /api/claude-update — 按检测到的安装方式运行匹配的更新命令。
 * native→claude update,brew→brew upgrade,npm→npm i -g。超时 8 分钟。
 */
router.post('/claude-update', async (req, res) => {
  const { method, path: claudePath } = await detectInstall();
  const cmd = updateCmdFor(method, claudePath);
  // M1: native 自更新直连 claude.ai 下载,墙内必须带代理;npm/brew 同样受益。
  const proxyUrl = await detectLocalProxy().catch(() => null);
  try {
    launchInTerminal(cmd, `更新 Claude Code (${method})`, proxyUrl);
    res.json({ ok: true, launched: true, command: cmd, platform: process.platform, proxy: proxyUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message || '启动终端失败', command: cmd });
  }
});

/**
 * POST /api/claude-update/stream — CN-2:在 GUI 内显示更新进度。headless spawn 更新命令
 * (npm/native),把 stdout+stderr 以 NDJSON 逐行推给前端实时展示,不用开外部终端。
 * 注:npm -g 在个别 Unix 需 sudo 会 headless 挂起 —— 前端保留"改用终端"兜底。
 */
router.post('/claude-update/stream', async (req, res) => {
  const { method, path: claudePath } = await detectInstall();
  const cmd = updateCmdFor(method, claudePath);
  const proxyUrl = await detectLocalProxy().catch(() => null);
  const env = { ...process.env };
  if (proxyUrl) { env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = proxyUrl; }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  res.write(JSON.stringify({ type: 'start', command: cmd, method, proxy: proxyUrl }) + '\n');
  let child;
  try {
    child = spawn(cmd, { shell: true, env });
  } catch (e) {
    res.write(JSON.stringify({ type: 'error', error: e.message }) + '\n'); return res.end();
  }
  const pump = (chunk) => {
    String(chunk).split(/\r?\n/).forEach((line) => {
      if (line.trim()) { try { res.write(JSON.stringify({ type: 'log', line }) + '\n'); } catch {} }
    });
  };
  child.stdout?.on('data', pump);
  child.stderr?.on('data', pump);
  child.on('error', (e) => { try { res.write(JSON.stringify({ type: 'error', error: e.message }) + '\n'); res.end(); } catch {} });
  child.on('close', (code) => { try { res.write(JSON.stringify({ type: 'done', code }) + '\n'); res.end(); } catch {} });
  req.on('close', () => { try { child.kill(); } catch {} });
});

/**
 * POST /api/claude-install — 未安装时一键安装(mac/linux: 官方 install.sh;win: npm)。
 * 在可见终端运行,让官方安装器自行把 CLI 目录写入系统 PATH。
 */
router.post('/claude-install', async (req, res) => {
  const method = req.body?.method === 'npm' ? 'npm' : 'native';
  const proxyUrl = await detectLocalProxy().catch(() => null);
  const cmd = installCmdFor(proxyUrl, method);
  // 代理注入位置按 method 分:
  //  · npm / 任意平台的 curl:进程读 HTTP_PROXY 环境变量 → 交给 launchInTerminal 在脚本里 set/export。
  //  · native + Windows:PowerShell 的 irm 不读 env,代理已在命令内注入 → 不再让 .bat 重复 set。
  const termProxy = (method === 'npm' || process.platform !== 'win32') ? proxyUrl : null;
  const title = method === 'npm' ? '安装 Claude Code (npm)' : '安装 Claude Code (官方安装器)';
  try {
    launchInTerminal(cmd, title, termProxy);
    res.json({ ok: true, launched: true, command: cmd, method, platform: process.platform, proxy: proxyUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message || '启动终端失败', command: cmd });
  }
});

// ─── 统一环境检查(node / claude / python)──────────────────────────────
// node:app 能跑 = node 必在,直接报 process.version。claude:复用 detectInstall +
// getClaudeVersion。python:可选(部分技能 生图/出题/bot 需要),多策略检测。
async function detectPython() {
  const tryRun = async (bin, args = ['--version']) => {
    try {
      const { stdout, stderr } = await execFileP(bin, args, { timeout: 5000 });
      const out = (stdout || stderr || '').trim(); // 老版本 python 把版本打到 stderr
      const m = out.match(/(\d+\.\d+\.\d+)/);
      if (m) return { version: m[1], path: bin };
    } catch {}
    return null;
  };
  for (const bin of ['python3', 'python']) {
    const hit = await tryRun(bin);
    if (hit) return { installed: true, ...hit };
  }
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileP('sh', ['-lc', 'command -v python3 || command -v python'], { timeout: 5000 });
      const p = stdout.trim();
      if (p) { const hit = await tryRun(p); if (hit) return { installed: true, ...hit, via: 'login-shell' }; }
    } catch {}
  }
  const home = homedir();
  const cands = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', join(home, '.asdf/shims/python3')];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const hit = await tryRun(p);
    if (hit) return { installed: true, ...hit, via: 'fallback' };
  }
  return { installed: false };
}

// uv 检测(uvx 命令随 uv 一起装)。部分 MCP(fetch / paper-search 等)走 uvx 拉起,
// 别人机器上不一定有 uv;uvx 需要时会自动下载托管 Python,所以只需检测/安装 uv。
// 策略同 detectPython:PATH → login-shell → 全平台已知安装目录(astral/cargo/brew/
// scoop/winget/pipx/rye 等),避免「PATH 没刷新/版本管理器装的」误报未装。
async function detectUv() {
  const tryRun = async (bin) => {
    try {
      const { stdout } = await execFileP(bin, ['--version'], { timeout: 5000 });
      const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
      if (m) return { version: m[1], path: bin };
    } catch {}
    return null;
  };
  const hit1 = await tryRun('uv');
  if (hit1) return { installed: true, ...hit1, via: 'PATH' };
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileP('sh', ['-lc', 'command -v uv'], { timeout: 5000 });
      const p = stdout.trim();
      if (p) { const hit = await tryRun(p); if (hit) return { installed: true, ...hit, via: 'login-shell' }; }
    } catch {}
  }
  const home = homedir();
  const cands = process.platform === 'win32'
    ? [
        join(home, '.local', 'bin', 'uv.exe'),                                                          // astral 官方安装器
        join(home, '.cargo', 'bin', 'uv.exe'),                                                          // cargo install
        join(home, 'scoop', 'shims', 'uv.exe'),                                                         // scoop
        join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links', 'uv.exe'), // winget(非 Store 包落 WinGet\Links,非 WindowsApps)
        join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Python', 'Scripts', 'uv.exe'),   // pip --user
      ]
    : [
        join(home, '.local', 'bin', 'uv'),   // astral 安装器 / pipx
        join(home, '.cargo', 'bin', 'uv'),   // cargo
        '/opt/homebrew/bin/uv',              // brew (Apple Silicon)
        '/usr/local/bin/uv',                 // brew (Intel) / 手动
        '/usr/bin/uv',                       // 系统包
        '/opt/local/bin/uv',                 // MacPorts
        join(home, '.rye', 'shims', 'uv'),   // rye 自带 uv
        join(home, '.pyenv', 'shims', 'uv'), // pyenv 垫片(pip/pyenv 装的 uv)
      ];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const hit = await tryRun(p);
    if (hit) return { installed: true, ...hit, via: 'fallback' };
  }
  return { installed: false };
}

function envInstallCmd(target, proxyUrl = null, method = null) {
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  // CI-2:claude 支持选 npm / native。原来恒 native(`irm claude.ai/install.ps1`),Windows 上
  // claude.ai 常被墙;npm 走 `npm install -g @anthropic-ai/claude-code`(GUI 能开=node 在)。
  if (target === 'claude') return installCmdFor(proxyUrl, method === 'npm' ? 'npm' : 'native');
  if (target === 'uv') {
    // Windows 同 claude native:PowerShell 5.1 的 irm 不读 HTTP_PROXY 环境变量,
    // 必须在进程内注入 .NET DefaultWebProxy,否则墙内卡死(见 installCmdFor 注释)。
    if (win) {
      const setup = proxyUrl
        ? `$p='${proxyUrl}'; [System.Net.WebRequest]::DefaultWebProxy=New-Object System.Net.WebProxy($p); $env:HTTP_PROXY=$p; $env:HTTPS_PROXY=$p; Write-Host ('(proxy: '+$p+')'); `
        : '';
      const inner = `${setup}$ProgressPreference='Continue'; Write-Host 'Installing uv (astral.sh)...'; irm https://astral.sh/uv/install.ps1 | iex`;
      return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${inner}"`;
    }
    return 'curl -LsSf https://astral.sh/uv/install.sh | sh'; // mac + linux 官方安装器
  }
  if (target === 'node') {
    if (win) return 'winget install -e --id OpenJS.NodeJS.LTS';
    if (mac) return 'brew install node || echo "未检测到 Homebrew,请到 https://nodejs.org 下载安装"';
    return 'sudo apt-get update && sudo apt-get install -y nodejs npm || echo "请用你的发行版包管理器安装 node"';
  }
  if (target === 'python') {
    if (win) return 'winget install -e --id Python.Python.3.12';
    if (mac) return 'brew install python || echo "未检测到 Homebrew,请到 https://www.python.org/downloads 下载安装"';
    return 'sudo apt-get update && sudo apt-get install -y python3 python3-pip || echo "请用你的发行版包管理器安装 python3"';
  }
  return null;
}

router.get('/env-check', async (req, res) => {
  const { method, path: claudePath } = await detectInstall();
  const claudeVersion = await getClaudeVersion(claudePath);
  const python = await detectPython();
  const uv = await detectUv();
  res.json({
    node: { installed: true, version: process.version, required: true },
    claude: { installed: !!claudeVersion, version: claudeVersion || null, method, required: true },
    python: { installed: python.installed, version: python.version || null, required: false },
    uv: { installed: uv.installed, version: uv.version || null, required: false },
    platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
  });
});

router.post('/env-check/install', async (req, res) => {
  const target = String(req.body?.target || '');
  const method = req.body?.method === 'npm' ? 'npm' : null; // CI-2:claude 可选 npm 安装
  try {
    const proxyUrl = await detectLocalProxy().catch(() => null);
    const cmd = envInstallCmd(target, proxyUrl, method);
    if (!cmd) return res.status(400).json({ ok: false, error: 'unknown target: ' + target });
    // win + uv:代理已注入 PS 命令内,不让 .bat 再 set(对 irm 无效且重复)。其余照旧由
    // launchInTerminal 在脚本里 export/set HTTP_PROXY。
    const termProxy = (target === 'uv' && process.platform === 'win32') ? null : proxyUrl;
    const titles = { claude: '安装 Claude Code', node: '安装 Node.js', python: '安装 Python', uv: '安装 uv' };
    launchInTerminal(cmd, titles[target] || '安装', termProxy);
    res.json({ ok: true, launched: true, command: cmd, platform: process.platform, proxy: proxyUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message || '启动终端失败' });
  }
});

export default router;
