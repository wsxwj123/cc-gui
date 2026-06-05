import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, '..', '..', 'package.json');
const router = Router();

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
router.get('/version-check', async (req, res) => {
  const currentVersion = getCurrentVersion();
  if (!currentVersion) {
    return res.json({ currentVersion: null, error: '无法读取本地版本(package.json)' });
  }
  try {
    const r = await fetch('https://api.github.com/repos/wsxwj123/claude-gui/releases/latest', {
      headers: { 'User-Agent': 'claude-gui-version-check', 'Accept': 'application/vnd.github+json' },
    });
    if (!r.ok) {
      return res.json({ currentVersion, error: `GitHub API ${r.status}` });
    }
    const d = await r.json();
    const latestRaw = String(d.tag_name || '').replace(/^v/, '');
    if (!latestRaw) return res.json({ currentVersion, error: 'GitHub 未返回 tag_name' });
    const hasUpdate = semverGt(latestRaw, currentVersion);
    res.json({
      currentVersion,
      latestVersion: latestRaw,
      hasUpdate,
      htmlUrl: d.html_url || `https://github.com/wsxwj123/claude-gui/releases/tag/${d.tag_name}`,
      publishedAt: d.published_at || null,
    });
  } catch (err) {
    res.json({ currentVersion, error: err.message || 'fetch failed' });
  }
});

export default router;
