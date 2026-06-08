import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFile } from 'child_process';
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

async function getClaudeVersion() {
  try {
    // `claude --version` → "2.1.160 (Claude Code)"，取首个 x.y.z
    const { stdout } = await execFileP('claude', ['--version'], { timeout: 8000 });
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

// 检测 claude CLI 的安装方式(决定用哪个更新命令)。解析 `claude` 的真实路径后按
// 路径特征归类:native(官方 install.sh,~/.local/share/claude)、brew、npm。
async function detectInstallMethod() {
  if (process.platform === 'win32') {
    // Windows 上 CC 主要走 npm / native installer。优先 npm(最常见)。
    return 'npm';
  }
  let real = '';
  try {
    const { stdout } = await execFileP('bash', ['-lc', 'command -v claude'], { timeout: 8000 });
    real = stdout.trim();
    try { const r = await execFileP('readlink', ['-f', real], { timeout: 5000 }); real = r.stdout.trim(); } catch {}
  } catch { return 'unknown'; }
  if (/\/\.local\/(share|bin)\/claude|\/claude\/versions\//.test(real)) return 'native';
  if (/Caskroom|Cellar|\/brew\//i.test(real)) return 'brew';
  if (/node_modules|\/npm|\.nvm|\.npm-global|\/lib\/node/.test(real)) return 'npm';
  return 'unknown';
}

// 按安装方式给出更新 / 安装命令(走 login shell,以加载 nvm/brew 等 PATH)。
function updateCmdFor(method) {
  switch (method) {
    case 'brew': return 'brew upgrade --cask claude-code';
    case 'npm':  return 'npm install -g @anthropic-ai/claude-code@latest';
    case 'native':
    default:     return 'claude update'; // 官方自更新,native 安装首选;unknown 兜底
  }
}
function installCmdFor() {
  // 未安装时的一键安装命令(按平台)。
  if (process.platform === 'win32') return 'npm install -g @anthropic-ai/claude-code';
  return 'curl -fsSL https://claude.ai/install.sh | bash'; // mac/linux 官方一键安装
}

async function runShell(cmd, res, label) {
  try {
    // 用 login shell 跑,确保 nvm/brew/native 的 PATH 都在;Windows 用 cmd。
    const { stdout, stderr } = process.platform === 'win32'
      ? await execFileP('cmd', ['/c', cmd], { timeout: 8 * 60 * 1000 })
      : await execFileP('bash', ['-lc', cmd], { timeout: 8 * 60 * 1000 });
    const after = await getClaudeVersion();
    res.json({ ok: true, output: (stdout || stderr || '').slice(-2000), version: after, command: cmd });
  } catch (err) {
    res.json({ ok: false, error: (err.stderr || err.message || `${label}失败`).slice(-2000), command: cmd });
  }
}

/**
 * GET /api/claude-version-check
 * 比对本地 `claude --version` 与 npm latest,并返回安装方式 + 对应更新命令。
 * 失败永远返回 200(只看字段)。
 */
router.get('/claude-version-check', async (req, res) => {
  const currentVersion = await getClaudeVersion();
  if (!currentVersion) {
    return res.json({
      currentVersion: null, installed: false,
      installCommand: installCmdFor(),
      error: 'Claude Code 未安装或不在 PATH',
    });
  }
  const method = await detectInstallMethod();
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
    updateCommand: updateCmdFor(method),
    hasUpdate: latest ? semverGt(latest, currentVersion) : false,
  });
});

/**
 * POST /api/claude-update — 按检测到的安装方式运行匹配的更新命令。
 * native→claude update,brew→brew upgrade,npm→npm i -g。超时 8 分钟。
 */
router.post('/claude-update', async (req, res) => {
  const method = await detectInstallMethod();
  await runShell(updateCmdFor(method), res, '更新');
});

/**
 * POST /api/claude-install — 未安装时一键安装(mac/linux: 官方 install.sh;win: npm)。
 */
router.post('/claude-install', async (req, res) => {
  await runShell(installCmdFor(), res, '安装');
});

export default router;
