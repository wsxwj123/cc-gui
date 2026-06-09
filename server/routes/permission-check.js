import { Router } from 'express';
import { readdir } from 'fs/promises';
import { homedir, platform } from 'os';
import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { spawn } from 'child_process';

const router = Router();

// L2: macOS adhoc 签名每次 build cdhash 都变,TCC 旧授权失效。完全磁盘访问按
// bundle ID 持久化,需用户手动加。本端点探测当前是否能读 ~/Downloads,前端据此
// 决定首次启动是否弹引导。Windows/Linux 无 TCC,直接返回 false。
router.get('/system/permission-status', async (_req, res) => {
  const plat = platform();
  if (plat !== 'darwin') {
    return res.json({ platform: plat, needsFullDiskAccess: false, canReadDownloads: true });
  }
  let canRead = false;
  try {
    await readdir(join(homedir(), 'Downloads'));
    canRead = true;
  } catch { canRead = false; }
  res.json({ platform: plat, needsFullDiskAccess: !canRead, canReadDownloads: canRead });
});

// 引导弹窗"我已授权"按钮调:记录用户已经看过一次引导,即使再次返回 false
// (TCC 还没生效需重启 app)也不再骚扰。本机标记,不进 git。
const PERMISSION_GUIDE_SHOWN = join(homedir(), '.claude-gui', 'permission-guide-shown.flag');
router.post('/system/permission-guide-dismissed', async (_req, res) => {
  try {
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    await writeFile(PERMISSION_GUIDE_SHOWN, new Date().toISOString());
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/system/permission-guide-dismissed', async (_req, res) => {
  try { await readFile(PERMISSION_GUIDE_SHOWN, 'utf-8'); res.json({ dismissed: true }); }
  catch { res.json({ dismissed: false }); }
});

// POST /api/system/open-fda-settings — 打开 macOS 完全磁盘访问设置面板
router.post('/system/open-fda-settings', async (_req, res) => {
  if (platform() !== 'darwin') return res.status(400).json({ error: 'macOS only' });
  try {
    spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
