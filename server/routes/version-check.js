import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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

export default router;
