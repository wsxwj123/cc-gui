import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, realpathSync, readdirSync } from 'fs';
import { resolveClaudeAsync, listClaudeInstallsAsync, getClaudeOverride, setClaudeOverride, winLivePathDirsAsync } from '../utils/claude-resolver.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir, homedir } from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { closeAllPersistentProcesses } from './chat.js';
import { isLocalReq } from '../services/auth.js';

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

// 本地 bot 版判据(与 server/index.js 的 IS_LOCAL_BUILD 同口径,此处 bots.local.js 是
// 本文件的 sibling):前端自动更新 gate 用,防公开版自动更新覆盖带 bot 本地版。
const IS_LOCAL_BUILD = existsSync(join(__dirname, 'bots.local.js'));

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
    // 本机 HTTP 代理(可能 null):前端 Tauri updater check({proxy}) 用。updater 的
    // Rust 侧下载不读系统代理,墙内直连 GitHub 常超时,探测到 Clash 等本机代理就透传。
    proxy: await detectLocalProxy().catch(() => null),
    // 本地 bot 版标记:true 时前端禁用自动更新(公开包不含 bots.local.js/FDA 签名)。
    localBuild: IS_LOCAL_BUILD,
  });
});

// ─── Claude Code CLI 版本检测 + 一键更新 ───────────────────────────────
let ccCache = null;       // claude-code 最新版本(native 渠道或 npm,按 ccCacheSrc 区分)
let ccCacheSrc = '';      // 'native' | 'npm' — 缓存来自哪个真源,防止跨源错用
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

// 带代理回退的 GET:node fetch 不读系统代理,墙内直连 downloads.claude.ai 必失败
// → 探测本机代理端口后经 curl 重试(mac 自带、Win10+ 自带 curl.exe)。
async function httpGetText(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { const e = new Error(`HTTP ${r.status} (${new URL(url).host})`); e.status = r.status; throw e; }
    return await r.text();
  } catch (err) {
    const proxy = await detectLocalProxy().catch(() => null);
    if (!proxy) throw err;
    const { stdout } = await execFileP('curl', ['-fsSL', '--max-time', '15', '-x', proxy, url], { timeout: 20000 });
    return stdout;
  }
}

async function fetchNpmLatest() {
  const text = await httpGetText('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', { 'Accept': 'application/json' });
  return String(JSON.parse(text).version || '');
}

// 原生安装(claude update)的真源是官方下载渠道清单,不是 npm。两渠道发布有时间差
// (实测窗口期:本机原生 2.1.198 = 当时渠道最新,npm 已 2.1.199)→ 原生用户按 npm 比
// 会"永远差一版",红色更新按钮点了更新也不灭。native 只按本渠道比,失败就报错,
// **不回落 npm**(跨渠道比对必然造出"已是渠道最新却仍提示更新"的假阳性)。
async function fetchNativeLatest() {
  const v = String(await httpGetText('https://downloads.claude.ai/claude-code-releases/latest')).trim();
  if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error('原生渠道返回的版本号格式异常');
  return v;
}

// 检测 claude CLI 的安装方式 + 解析它的绝对路径。返回 { method, path, via }。
// 路径解析统一走 claude-resolver(PATH → login shell → npm 全局前缀 → 已知安装
// 路径),与 claudeSpawn / SDK / cli-check 同源 —— 报告版本、执行更新的都是 GUI
// 实际会用的那个安装。此处只负责按路径特征分类安装方式(native/brew/npm)。
// 按真实落点(解 symlink 后)把 claude 安装分类成 native/npm/brew。Windows 无软链概念,
// 直接用入口路径匹配;mac/linux 传 readlink -f 解析后的 target。
function classifyClaudePath(real) {
  if (process.platform === 'win32') {
    if (/AnthropicClaude|\\\.claude\\local|\\\.local\\bin|\\claude\\versions\\/i.test(real)) return 'native';
    if (/npm|node_modules|nodejs/i.test(real)) return 'npm';
    return 'native';  // 兜底按 native 自更新(claude update 在 Windows 亦支持)
  }
  if (/\/\.local\/(share|bin)\/claude|\/claude\/versions\//.test(real)) return 'native';
  if (/Caskroom|Cellar|\/brew\//i.test(real)) return 'brew';
  if (/node_modules|\/npm|\.nvm|\.npm-global|\/lib\/node/.test(real)) return 'npm';
  return 'unknown';
}

async function detectInstall() {
  // refresh:true 绕过 15s 负缓存 —— 本函数只被【用户显式检查】的端点调用(版本检查/env-check/
  // 安装列表)。GUI 更新/claude 重装期间二进制正被替换,一次解析落空就负缓存 15s,期间打开设置
  // 页会误显"未安装或不在 PATH"(用户实报:更新中断/完成后偶发未安装)。显式检查永远现场重解析;
  // 聊天 spawn 热路径仍走带缓存的 resolveClaude() 不受影响。
  const hit = await resolveClaudeAsync({ refresh: true });
  if (!hit) return { method: 'unknown', path: '', via: null };
  const real = hit.path;
  // 解析软链(~/.local/bin/claude → ~/.local/share/claude/versions/x.y.z)以便按
  // 真实落点分类;分类用 target,返回的 path 保留解析到的入口路径(可直接执行)。
  let target = real;
  if (process.platform !== 'win32') {
    try { const r = await execFileP('readlink', ['-f', real], { timeout: 5000 }); target = r.stdout.trim() || real; } catch {}
  }
  return { method: classifyClaudePath(target), path: real, via: hit.via };
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
      ? 'call npm install -g @anthropic-ai/claude-code@latest --registry=https://registry.npmmirror.com'  // call:npm.cmd 在 .bat 里需 call 才返回,否则后续 pause 被跳过窗口闪退
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
export function installCmdFor(proxyUrl = null, method = 'native') { // export 仅为可单测
  // 未安装时的一键安装命令。method:'npm' | 'native'。
  // npm:读 HTTP_PROXY 环境变量(由 launchInTerminal 在脚本里 set/export),且自带
  // 下载/安装进度输出 —— 想"看得见进度"选它;前提是本机有 node(GUI 后端本就靠 node 跑,
  // 所以 GUI 能开 = node 在)。
  // 装完自动把 npm 全局 bin 写入用户 PATH(npm 自己从不写 → "装成功但终端/检测都找不到"
  // 的根因):Win 用 PowerShell 追加 HKCU\Environment\Path(不用 setx——超 1024 字符会
  // 截断毁 PATH;SetEnvironmentVariable 会广播 WM_SETTINGCHANGE,新开终端即生效);
  // mac/linux 追加 export 行到 ~/.zshrc(darwin)/~/.bashrc。已包含则跳过,不重复写。
  if (method === 'npm') {
    if (process.platform === 'win32') {
      const psAppend = `$p=(npm config get prefix).Trim(); $u=[Environment]::GetEnvironmentVariable('Path','User'); if(@(($u -split ';') | Where-Object {$_ -eq $p}).Count -eq 0){[Environment]::SetEnvironmentVariable('Path', ($u.TrimEnd(';')+';'+$p), 'User'); Write-Host ('npm bin dir written to user PATH: '+$p)} else {Write-Host 'user PATH already contains npm bin dir'}`;
      // 关键:`call npm`——npm 是 npm.cmd(批处理),在 .bat 里不加 call 直调另一个 .cmd
      // 控制权不返回 → npm 装完后 `&& powershell`(写 PATH)、后续 pause 全被跳过,PATH
      // 写入根本没跑 → "装成功但检测不到"。加 call 让 npm.cmd 返回,链条才完整执行。
      return `call npm install -g @anthropic-ai/claude-code && powershell -NoProfile -Command "${psAppend}"`;
    }
    const rc = process.platform === 'darwin' ? '$HOME/.zshrc' : '$HOME/.bashrc';
    // EACCES 根治(用户实报 permission denied):官方 pkg 装的 node,npm 全局目录
    // (/usr/local/lib/node_modules)归 root,裸 `npm install -g` 必失败。检测实际写入目录
    // 不可写时改装到 ~/.npm-global(免 sudo;claude-resolver fixedCandidates 已含此落点,
    // rc 未生效前 GUI 也能找到)。W 逐级回退:node_modules 可能尚不存在。
    return `PREFIX="$(npm prefix -g)" && W="$PREFIX/lib/node_modules" && { [ -d "$W" ] || W="$PREFIX/lib"; } && { [ -d "$W" ] || W="$PREFIX"; } && { [ -w "$W" ] || { PREFIX="$HOME/.npm-global"; echo "npm 全局目录 $W 无写权限(permission denied 根因),改装到 $PREFIX(免 sudo)"; }; } && npm install -g --prefix "$PREFIX" @anthropic-ai/claude-code && NPMBIN="$PREFIX/bin" && { case ":$PATH:" in *":$NPMBIN:"*) echo "PATH 已包含 $NPMBIN";; *) echo "export PATH=\\"$NPMBIN:\\$PATH\\"" >> ${rc} && echo "已把 $NPMBIN 写入 ${rc}(新开终端生效)";; esac; }`;
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
export async function detectLocalProxy() { // export:skills.js 直连 GitHub 失败时回落代理用
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
    // 区分两种落空:①完全没解析到二进制 = 真未安装;②解析到路径但 --version 超时/异常
    // (杀毒实时扫描、npm shim 里 node 冷启动 >8s)= 已装但探测失败,别误报"未安装"诱导重装。
    if (claudePath) {
      return res.json({
        currentVersion: null, installed: true, method,
        error: '已检测到 Claude 但读取版本超时(可能被杀毒扫描拦截),稍后重试',
      });
    }
    return res.json({
      currentVersion: null, installed: false,
      installCommand: installCmdFor(),
      error: 'Claude Code 未安装或不在 PATH',
    });
  }
  let latest = '';
  const now = Date.now();
  // 缓存按"真源"分键:native 渠道与 npm 的版本可能不同,混用一个缓存会把 npm 的
  // 版本号错发给原生安装(正是"永远差一版"的放大器)。
  const srcKey = method === 'native' ? 'native' : 'npm';
  if (ccCache && ccCacheSrc === srcKey && now - ccCachedAt < CACHE_TTL_MS) {
    latest = ccCache;
  } else {
    try {
      latest = method === 'native'
        ? await fetchNativeLatest()
        : await fetchNpmLatest();
      ccCache = latest; ccCacheSrc = srcKey; ccCachedAt = now;
    } catch (err) {
      if (ccCache && ccCacheSrc === srcKey) latest = ccCache;
      else return res.json({ currentVersion, installed: true, method, error: err.message || '版本查询失败' });
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
  // Windows:运行中的 claude 锁住 claude.exe,npm/upgrade 覆盖时报 "could not write ...claude.exe"。
  // 更新前先关掉 GUI 自己的常驻 claude 进程释放文件锁(终端里 npm 先下载,给进程退出留足时间)。
  if (process.platform === 'win32') { try { closeAllPersistentProcesses(); } catch {} }
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
  // Windows:先关常驻 claude 释放 claude.exe 锁(否则覆盖失败 "could not write");等 ~1.2s 让进程退出。
  if (process.platform === 'win32') {
    let closed = 0; try { closed = closeAllPersistentProcesses(); } catch {}
    if (closed) { res.write(JSON.stringify({ type: 'log', line: `已关闭 ${closed} 个运行中的 claude 进程以释放 claude.exe(更新前置)` }) + '\n'); await new Promise((r) => setTimeout(r, 1200)); }
  }
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

// GET /api/claude-installs
// 列出机器上所有 claude 安装(不止当前用的那个)+ 各自版本 + 分类,并标出当前
// 实际激活的是哪个(供设置页"切换用哪个 claude")。overridden = 用户是否已手动钉死。
router.get('/claude-installs', async (_req, res) => {
  const list = await listClaudeInstallsAsync();
  const override = getClaudeOverride();
  // refresh:true 同 detectInstall:显式检查不吃 15s 负缓存(更新中断后误显未安装/无选中)。
  const active = await resolveClaudeAsync({ refresh: true });  // 含 override,当前 spawn/SDK 实际会用的那个
  let activeReal = '';
  if (active) { try { activeReal = realpathSync(active.path); } catch { activeReal = active.path; } }
  // Windows 路径大小写不敏感(盘符 C:\ vs c:\、目录大小写)而 === 敏感 → active 比对落空,
  // 设置页没有任何安装被标"当前"(首开不选中的根因之一)。归一化后再比。
  const norm = (p) => process.platform === 'win32' ? String(p).replace(/\//g, '\\').toLowerCase() : String(p);
  const activeKey = norm(activeReal);
  const installs = await Promise.all(list.map(async (it) => ({
    path: it.path,
    method: classifyClaudePath(it.real),
    version: await getClaudeVersion(it.path),   // 失败为 null,best-effort
    active: !!activeKey && norm(it.real) === activeKey,
  })));
  res.json({ installs, overridden: !!override, override, activeVia: active?.via || null });
});

// PUT /api/claude-active { path }
// 钉死 GUI 用哪个 claude;path 传空串 → 清除,回到自动优先级。写覆盖文件并强制
// resolver 重解析,下次聊天/agent/MCP spawn 立即用新的(无需重启)。
router.put('/claude-active', async (req, res) => {
  // 限本机请求(fable 审计实测:原来任何存在的文件都收,连不可执行文本都行,之后全部
  // spawn 用它——authed 局域网客户端可打瘫 GUI,配合本机可执行恶意文件可升级 RCE)。
  // 钉 claude 路径是桌面机主动作,与 permissions.js 权限检查接口同款门禁。
  if (!isLocalReq(req)) return res.status(403).json({ error: '该操作仅限本机执行' });
  const p = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
  if (p && !existsSync(p)) return res.status(400).json({ error: '该路径不存在或已失效' });
  try {
    setClaudeOverride(p);
    const active = await resolveClaudeAsync({ refresh: true });
    res.json({ ok: true, active: active?.path || '', via: active?.via || null });
  } catch (e) {
    res.status(500).json({ error: e.message || '写入失败' });
  }
});

// ─── 统一环境检查(node / claude / python)──────────────────────────────
// Windows 通用兜底:手动装完 python/git/uv 后仍检测不到的根因 = 正在运行的 GUI 进程持有
// 安装前的旧 PATH 快照(安装器只把新目录写进注册表,不重启读不到)。用注册表实时 PATH
// 逐目录拼 exe 名 —— 与 claude-resolver 的 fromWinLivePath 同思路,装了无需重启即可发现。
// 异步(opus 审计):同步版在 PATH 未命中的 Windows 上每次 env-check 同步 spawn PowerShell
// 1-3s 阻塞事件循环;异步版 + resolver 侧 30s 缓存,一次 env-check 三个工具只 spawn 一次。
async function winLiveCandidates(exeNames) {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (const d of await winLivePathDirsAsync()) for (const n of exeNames) out.push(join(d, n));
  return out;
}
// python.org / Store 安装器的固定落点(用户没勾"Add to PATH"时注册表也没有 → 直扫)。
// 目录名带版本(Python312 等),扫父目录下 /^Python\d/ 子目录。
function pythonWinFixed() {
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const out = [];
  for (const base of [
    join(local, 'Programs', 'Python'),                                 // python.org 仅当前用户(默认)
    process.env.ProgramFiles || 'C:\\Program Files',                   // python.org 所有用户
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  ]) {
    try { for (const d of readdirSync(base)) if (/^Python\d/i.test(d)) out.push(join(base, d, 'python.exe')); } catch {}
  }
  out.push(join(local, 'Microsoft', 'WindowsApps', 'python.exe'));     // Microsoft Store 版垫片
  return out;
}

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
    ? [...(await winLiveCandidates(['python3.exe', 'python.exe'])), ...pythonWinFixed()]  // 注册表实时 PATH + python.org/Store 固定落点
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
export async function detectUv() { // export:mcp.js 把裸 uvx 改写为真实 uv 绝对路径用
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
        ...(await winLiveCandidates(['uv.exe'])),                                                                // 注册表实时 PATH(装完不重启即认)
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
  // Windows winget 兜底:winget(App Installer)在 LTSC/Server/未更新旧 Win10/企业锁机上
  // 可能缺失 → 裸 `winget install` 会报"不是内部命令"卡死。批处理里先 `where winget` 探测,
  // 没有就 `start` 打开官方下载页(默认浏览器)。`if errorlevel 1`= where 未找到(errorlevel≥1)。
  const wingetOr = (id, url) =>
    `where winget >nul 2>nul & if errorlevel 1 ( echo winget 不可用,正在打开官方下载页... & start "" "${url}" ) else ( winget install -e --id ${id} )`;
  if (target === 'node') {
    if (win) return wingetOr('OpenJS.NodeJS.LTS', 'https://nodejs.org/en/download/');
    if (mac) return 'brew install node || { echo "未检测到 Homebrew,已打开 Node.js 官网 —— 下载 pkg 双击安装即可(无需 Xcode CLT / Homebrew)"; open "https://nodejs.org/en/download/"; }';
    return 'sudo apt-get update && sudo apt-get install -y nodejs npm || echo "请用你的发行版包管理器安装 node"';
  }
  if (target === 'python') {
    if (win) return wingetOr('Python.Python.3.12', 'https://www.python.org/downloads/windows/');
    if (mac) return 'brew install python || { echo "未检测到 Homebrew,已打开 Python 官网 —— 下载 pkg 双击安装即可(无需 Xcode CLT / Homebrew)"; open "https://www.python.org/downloads/"; }';
    return 'sudo apt-get update && sudo apt-get install -y python3 python3-pip || echo "请用你的发行版包管理器安装 python3"';
  }
  if (target === 'git') {
    if (win) return wingetOr('Git.Git', 'https://git-scm.com/download/win');
    if (mac) return 'xcode-select --install || brew install git || echo "请到 https://git-scm.com/download/mac 下载安装"';
    return 'sudo apt-get update && sudo apt-get install -y git || echo "请用你的发行版包管理器安装 git"';
  }
  return null;
}

// git 检测。GUI 的 git init / 回滚 / worktree 都依赖它,且子代理的 using-git-worktrees
// skill 在无 git 时会报错。策略同 detectPython:PATH → 全平台已知安装目录。
async function detectGit() {
  const tryRun = async (bin) => {
    try {
      const { stdout } = await execFileP(bin, ['--version'], { timeout: 5000 });
      const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
      if (m) return { version: m[1], path: bin };
    } catch {}
    return null;
  };
  const onPath = await tryRun('git');
  if (onPath) return { installed: true, ...onPath };
  const home = homedir();
  const cands = process.platform === 'win32'
    ? [
        ...(await winLiveCandidates(['git.exe'])),  // 注册表实时 PATH(Git for Windows 装完写 Machine PATH,进程旧快照读不到)
        join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
        join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
        join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'Git', 'cmd', 'git.exe'),
      ]
    : ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const hit = await tryRun(p);
    if (hit) return { installed: true, ...hit, via: 'fallback' };
  }
  return { installed: false };
}

router.get('/env-check', async (req, res) => {
  const { method, path: claudePath, via } = await detectInstall();
  const claudeVersion = await getClaudeVersion(claudePath);
  const python = await detectPython();
  const uv = await detectUv();
  const git = await detectGit();
  res.json({
    node: { installed: true, version: process.version, required: true },
    // resolvedPath/via:实际解析到的二进制位置与命中策略(PATH / login-shell /
    // npm-prefix / known-path),检测面板据此展示"从哪找到的"。
    claude: {
      // 解析到路径即算已装(即便 --version 超时未取到版本号),避免"已装但探测慢"被误报未安装。
      installed: !!claudePath, version: claudeVersion || null, method, required: true,
      resolvedPath: claudePath || null, via: via || null,
      versionProbeFailed: !!claudePath && !claudeVersion,
    },
    git: { installed: git.installed, version: git.version || null, required: false },
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
    const titles = { claude: '安装 Claude Code', node: '安装 Node.js', python: '安装 Python', uv: '安装 uv', git: '安装 Git' };
    launchInTerminal(cmd, titles[target] || '安装', termProxy);
    res.json({ ok: true, launched: true, command: cmd, platform: process.platform, proxy: proxyUrl });
  } catch (err) {
    res.json({ ok: false, error: err.message || '启动终端失败' });
  }
});

export default router;
