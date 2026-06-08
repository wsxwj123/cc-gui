import { Router } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
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

async function fetchGitHubLatest() {
  const r = await fetch('https://api.github.com/repos/wsxwj123/claude-gui/releases/latest', {
    headers: { 'User-Agent': 'claude-gui-version-check', 'Accept': 'application/vnd.github+json' },
  });
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
    const { stdout } = await execFileP(claudePath || 'claude', ['--version'], { timeout: 8000 });
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
async function detectInstall() {
  let real = '';
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileP('where', ['claude'], { timeout: 8000 });
      real = (stdout.split(/\r?\n/).find(Boolean) || '').trim();  // 第一个匹配 = 优先级最高
    } catch { return { method: 'npm', path: '' }; }
    if (/AnthropicClaude|\\\.claude\\local|\\claude\\versions\\/i.test(real)) return { method: 'native', path: real };
    if (/npm|node_modules|nodejs/i.test(real)) return { method: 'npm', path: real };
    return { method: 'native', path: real };  // 兜底按 native 自更新(claude update 在 Windows 亦支持)
  }
  try {
    const { stdout } = await execFileP('bash', ['-lc', 'command -v claude'], { timeout: 8000 });
    real = stdout.trim();
    try { const r = await execFileP('readlink', ['-f', real], { timeout: 5000 }); real = r.stdout.trim(); } catch {}
  } catch { return { method: 'unknown', path: '' }; }
  if (/\/\.local\/(share|bin)\/claude|\/claude\/versions\//.test(real)) return { method: 'native', path: real };
  if (/Caskroom|Cellar|\/brew\//i.test(real)) return { method: 'brew', path: real };
  if (/node_modules|\/npm|\.nvm|\.npm-global|\/lib\/node/.test(real)) return { method: 'npm', path: real };
  return { method: 'unknown', path: real };
}

// 按安装方式给出更新命令。native 用「绝对路径 + update」自更新,避免终端里裸 `claude`
// 解析到另一个安装(用户的 shell PATH 和 GUI 的 PATH 顺序可能不同)。
function updateCmdFor(method, claudePath) {
  switch (method) {
    case 'brew': return 'brew upgrade --cask claude-code';
    case 'npm':  return 'npm install -g @anthropic-ai/claude-code@latest';
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
function installCmdFor() {
  // 未安装时的一键安装命令(按平台)。
  if (process.platform === 'win32') return 'npm install -g @anthropic-ai/claude-code';
  return 'curl -fsSL https://claude.ai/install.sh | bash'; // mac/linux 官方一键安装
}

// 打开一个「可见终端」运行命令,而不是 headless execFile。原因:
//  ① `claude update` / install.sh 是交互式自更新/安装器,无 TTY 时可能挂起或
//     无反馈(用户报告"点了没反应")。
//  ② 终端里跑能让官方安装器自己把 CLI 目录写进 shell profile 的 PATH。
//  ③ 用户能直观看到进度 / 出错信息,无需在 GUI 里盲等。
// 做法:写一个临时脚本,用 `open`(mac)/`start`(win)/终端模拟器(linux)启动。
// fire-and-forget——终端是独立进程,server 不捕获结果,UI 引导用户完成后点"检查更新"。
function launchInTerminal(cmd, title) {
  const stamp = `cgui-cc-${process.pid}-${Math.round(process.hrtime()[1])}`;
  if (process.platform === 'darwin') {
    const file = join(tmpdir(), `${stamp}.command`);
    writeFileSync(file, `#!/bin/bash\necho "▶ ${title}"\n${cmd}\nstatus=$?\necho\nif [ $status -eq 0 ]; then echo "✅ 完成,可关闭本窗口"; else echo "❌ 失败(退出码 $status)"; fi\n`, { mode: 0o755 });
    spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    const file = join(tmpdir(), `${stamp}.bat`);
    writeFileSync(file, `@echo off\r\necho ▶ ${title}\r\n${cmd}\r\necho.\r\necho ===== 完成,按任意键关闭 =====\r\npause >nul\r\n`);
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
  try {
    launchInTerminal(cmd, `更新 Claude Code (${method})`);
    res.json({ ok: true, launched: true, command: cmd, platform: process.platform });
  } catch (err) {
    res.json({ ok: false, error: err.message || '启动终端失败', command: cmd });
  }
});

/**
 * POST /api/claude-install — 未安装时一键安装(mac/linux: 官方 install.sh;win: npm)。
 * 在可见终端运行,让官方安装器自行把 CLI 目录写入系统 PATH。
 */
router.post('/claude-install', async (req, res) => {
  const cmd = installCmdFor();
  try {
    launchInTerminal(cmd, '安装 Claude Code');
    res.json({ ok: true, launched: true, command: cmd, platform: process.platform });
  } catch (err) {
    res.json({ ok: false, error: err.message || '启动终端失败', command: cmd });
  }
});

export default router;
