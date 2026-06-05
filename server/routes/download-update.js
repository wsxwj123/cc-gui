import { Router } from 'express';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { createWriteStream } from 'fs';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { extname, join, basename } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

const router = Router();

/**
 * POST /api/download-update { url, filename }
 *
 * 一键下载安装包(仅允许 github.com / objects.githubusercontent.com)到
 * ~/Downloads/<filename>,完成后:
 *  - macOS:先 xattr 清掉 quarantine 标记(免得装完弹"已损坏"),然后 `open` dmg
 *  - Windows:`start` exe/msi 启动 installer
 *  - Linux:`xdg-open` 启动 系统打开
 *
 * 限制:url 必须来自 GitHub release(防止把 server 当成任意 URL 下载代理被滥用)。
 * 文件名做 sanitize 避免路径穿越。
 */
router.post('/download-update', async (req, res) => {
  const { url, filename } = req.body || {};
  if (!url || !filename) return res.status(400).json({ error: 'url + filename 必填' });

  // 域名白名单 — 只允许 GitHub Release 直链
  let u;
  try { u = new URL(url); } catch { return res.status(400).json({ error: 'url 非法' }); }
  const allowedHosts = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  if (!allowedHosts.has(u.hostname)) {
    return res.status(400).json({ error: '只支持 github.com 直链' });
  }

  // 文件名 sanitize(只保留字母数字 . _ -),避免 .. / 等路径穿越
  const safeName = String(filename).replace(/[^\w.-]/g, '_').slice(0, 200);
  if (!safeName) return res.status(400).json({ error: 'filename 非法' });

  const targetDir = join(homedir(), 'Downloads');
  const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
  const ext = extname(safeName);
  const stem = basename(safeName, ext);
  let targetPath = join(targetDir, safeName);
  for (let i = 1; existsSync(targetPath) && i < 100; i++) {
    targetPath = join(targetDir, `${stem}-${i}${ext}`);
  }
  if (existsSync(targetPath)) {
    return res.status(409).json({ error: 'Downloads 中同名文件过多,请手动清理后重试' });
  }

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'claude-gui-updater', 'Accept': 'application/octet-stream' },
      redirect: 'follow',
    });
    if (!r.ok) return res.status(502).json({ error: `下载失败 HTTP ${r.status}` });
    if (!r.body) return res.status(502).json({ error: '上游返回空 body' });
    const contentLength = Number(r.headers.get('content-length') || 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      return res.status(413).json({ error: '安装包过大 (>500MB)' });
    }

    let seen = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > MAX_DOWNLOAD_BYTES) cb(new Error('安装包过大 (>500MB)'));
        else cb(null, chunk);
      },
    });
    await pipeline(r.body, limiter, createWriteStream(targetPath));

    // 平台分支:打开安装包
    const platform = process.platform;
    let opened = false;
    try {
      if (platform === 'darwin') {
        // macOS:清 quarantine + 挂载 dmg(Finder 自动弹挂载窗口)
        try { spawn('xattr', ['-rd', 'com.apple.quarantine', targetPath], { stdio: 'ignore' }); } catch {}
        spawn('open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
        opened = true;
      } else if (platform === 'win32') {
        // Windows:cmd /c start "" "<path>" 让系统按关联应用打开 installer
        spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' }).unref();
        opened = true;
      } else {
        // Linux:xdg-open
        spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
        opened = true;
      }
    } catch (e) {
      // 打开失败不算下载失败 — 文件已经在 Downloads 里,用户能手动打开
    }

    res.json({ ok: true, path: targetPath, opened, platform });
  } catch (err) {
    try { await unlink(targetPath); } catch {}
    res.status(500).json({ error: err.message || 'download failed' });
  }
});

export default router;
