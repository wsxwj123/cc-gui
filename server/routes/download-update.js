import { Router } from 'express';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { createWriteStream, existsSync, readFileSync } from 'fs';
import { unlink, readFile, writeFile, mkdir, stat } from 'fs/promises';
import { extname, join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isPathInside } from '../utils/safe-path.js';

const router = Router();

// ── 更新完成后的安装包清理 ────────────────────────────────────────────
// 下载成功后把安装包路径 + 下载时的 app 版本记到 ~/.claude-gui/pending-update-cleanup.json;
// 新版本首次启动时前端查询 GET /update-cleanup,经用户确认后 POST /update-cleanup/delete 删除。
const CLEANUP_RECORD_PATH = join(homedir(), '.claude-gui', 'pending-update-cleanup.json');
const PKG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
// 删除白名单:文件名必须是 cc-gui 安装包(下载时 sanitize 后空格变 _,GitHub
// 资产名用 .;重名追加 -N 后缀),且位于 ~/Downloads 内 —— 防止记录文件被篡改后
// 该端点删除任意文件。
// 新旧名并容:productName 改名 CC-GUI 后 CI 产物为 CC-GUI_*;旧名分支保留是因为
// 用户 Downloads 里可能躺着改名前下载的旧包记录(r26-A1)。
const INSTALLER_NAME_RE = /^(CC-GUI|Claude[ ._]GUI)[ ._-].*\.(dmg|exe|msi)$/i;

function currentAppVersion() {
  try { return JSON.parse(readFileSync(PKG_PATH, 'utf-8')).version || ''; } catch { return ''; }
}
async function readCleanupRecord() {
  try { return JSON.parse(await readFile(CLEANUP_RECORD_PATH, 'utf-8')); } catch { return null; }
}
async function clearCleanupRecord() {
  try { await unlink(CLEANUP_RECORD_PATH); } catch {}
}

/**
 * GET /api/update-cleanup
 * 有待清理的安装包且更新已完成(当前版本 ≠ 下载时版本)→ { pending:true, path, name, sizeMB }。
 * 其余情况一律 { pending:false }:无记录 / 更新尚未完成(记录保留,下次再查) /
 * 文件已被手动删除(顺带清记录)。
 */
router.get('/update-cleanup', async (_req, res) => {
  const rec = await readCleanupRecord();
  if (!rec || typeof rec.path !== 'string') return res.json({ pending: false });
  const cur = currentAppVersion();
  if (!cur || cur === rec.appVersionAtDownload) return res.json({ pending: false });
  let size = 0;
  try { size = (await stat(rec.path)).size; } catch {
    await clearCleanupRecord();
    return res.json({ pending: false });
  }
  res.json({ pending: true, path: rec.path, name: basename(rec.path), sizeMB: Math.round(size / 1048576) });
});

/** POST /api/update-cleanup/delete — 删除记录的安装包(仅限 ~/Downloads 下的 cc-gui 安装包)。 */
router.post('/update-cleanup/delete', async (_req, res) => {
  const rec = await readCleanupRecord();
  if (!rec || typeof rec.path !== 'string') return res.status(404).json({ error: '没有待清理的安装包记录' });
  const downloads = join(homedir(), 'Downloads');
  if (!isPathInside(rec.path, downloads) || !INSTALLER_NAME_RE.test(basename(rec.path))) {
    await clearCleanupRecord();
    return res.status(400).json({ error: '记录的路径不符合白名单(~/Downloads 下的 cc-gui 安装包),已忽略该记录' });
  }
  try { await unlink(rec.path); } catch (e) {
    if (e.code !== 'ENOENT') return res.status(500).json({ error: e.message });
  }
  await clearCleanupRecord();
  res.json({ ok: true, deleted: rec.path });
});

/** POST /api/update-cleanup/dismiss — 用户选择保留:清记录,之后不再提示。 */
router.post('/update-cleanup/dismiss', async (_req, res) => {
  await clearCleanupRecord();
  res.json({ ok: true });
});

/**
 * POST /api/download-update { url, filename }
 *
 * 一键下载安装包(仅允许 github.com / objects.githubusercontent.com)到
 * ~/Downloads/<filename>,完成后:
 *  - macOS:先 xattr 清掉 quarantine 标记(免得装完弹"已损坏"),然后 `open` dmg
 *  - Windows:`explorer.exe` exe/msi 启动 installer
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
    // 重定向逐跳校验:github.com 的 release 资产会 302 到 cdn(release-assets/
    // objects.githubusercontent.com),但 redirect:'follow' 会无脑跟到任意主机,
    // 域名白名单形同虚设。改 manual + 手动跟,每跳目标必须在白名单内。
    const dlHeaders = { 'User-Agent': 'claude-gui-updater', 'Accept': 'application/octet-stream' };
    let r = await fetch(url, { headers: dlHeaders, redirect: 'manual' });
    for (let hops = 0; r.status >= 300 && r.status < 400; hops++) {
      if (hops >= 5) return res.status(502).json({ error: '重定向次数过多' });
      const loc = r.headers.get('location');
      if (!loc) return res.status(502).json({ error: `上游返回 ${r.status} 但无 Location` });
      let nu;
      try { nu = new URL(loc, url); } catch { return res.status(502).json({ error: '上游重定向地址非法' }); }
      if (!allowedHosts.has(nu.hostname)) {
        return res.status(400).json({ error: `重定向到非 GitHub 主机(${nu.hostname}),已拒绝` });
      }
      r = await fetch(nu, { headers: dlHeaders, redirect: 'manual' });
    }
    if (!r.ok) return res.status(502).json({ error: `下载失败 HTTP ${r.status}` });
    if (!r.body) return res.status(502).json({ error: '上游返回空 body' });
    const contentLength = Number(r.headers.get('content-length') || 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      return res.status(413).json({ error: '安装包过大 (>500MB)' });
    }

    // CJ-1:边下边推进度。一旦确认是合法下载就切 NDJSON 流式响应,逐块写
    // {type:'progress',received,total},完成写 {type:'done',...}、出错写 {type:'error'}。
    // 早期校验失败(上面那些 res.status)仍走普通 JSON 状态码,不受影响。
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const fileStream = createWriteStream(targetPath);
    let received = 0, lastEmit = 0;
    try {
      for await (const chunk of r.body) {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) throw new Error('安装包过大 (>500MB)');
        if (!fileStream.write(chunk)) await new Promise((rs) => fileStream.once('drain', rs)); // 背压
        const now = Date.now();
        if (now - lastEmit > 150) { lastEmit = now; res.write(JSON.stringify({ type: 'progress', received, total: contentLength }) + '\n'); }
      }
      await new Promise((resolve, reject) => fileStream.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      try { fileStream.destroy(); } catch {}
      try { await unlink(targetPath); } catch {}
      res.write(JSON.stringify({ type: 'error', error: err.message || 'download failed' }) + '\n');
      return res.end();
    }

    // 平台分支:打开安装包(同原逻辑)
    const platform = process.platform;
    let opened = false;
    try {
      if (platform === 'darwin') {
        // macOS:清 quarantine + 挂载 dmg(Finder 自动弹挂载窗口)
        try { spawn('xattr', ['-rd', 'com.apple.quarantine', targetPath], { stdio: 'ignore' }); } catch {}
        spawn('open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
        opened = true;
      } else if (platform === 'win32') {
        // Windows:explorer.exe 让系统按关联应用打开 installer
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

    // 记录下载的安装包路径:新版本首次启动时提示删除(见上方 /update-cleanup 端点)。
    try {
      await mkdir(dirname(CLEANUP_RECORD_PATH), { recursive: true });
      await writeFile(CLEANUP_RECORD_PATH, JSON.stringify({
        path: targetPath,
        downloadedAt: Date.now(),
        appVersionAtDownload: currentAppVersion(),
      }, null, 2));
    } catch { /* 记录失败不影响下载结果 */ }

    res.write(JSON.stringify({ type: 'done', ok: true, path: targetPath, opened, platform }) + '\n');
    res.end();
  } catch (err) {
    // writeHead 之前抛(fetch 失败等)→ 还能用 JSON 状态码;之后抛 → 写错误行收尾。
    if (!res.headersSent) {
      try { await unlink(targetPath); } catch {}
      res.status(500).json({ error: err.message || 'download failed' });
    } else {
      try { res.write(JSON.stringify({ type: 'error', error: err.message || 'download failed' }) + '\n'); res.end(); } catch {}
    }
  }
});

export default router;
