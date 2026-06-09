import { Router } from 'express';
import { readdir } from 'fs/promises';
import { homedir, platform } from 'os';
import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { spawn } from 'child_process';

const router = Router();

// L2+L5: macOS adhoc 签名每次 build cdhash 都变,TCC 旧授权失效。完全磁盘访问按
// bundle ID 持久化,需用户手动加。**不再用 readdir 主动探测**(那会触发 macOS 原生
// "想访问 Downloads"小弹窗,短路本引导)。改为 macOS 上始终建议授权,用户点 dismiss
// 后落 flag 永久不弹;`?probe=1` 选项允许设置面板里强制探测一次。
router.get('/system/permission-status', async (req, res) => {
  const plat = platform();
  if (plat !== 'darwin') {
    return res.json({ platform: plat, needsFullDiskAccess: false, canReadDownloads: true });
  }
  // 默认不探测 — 直接看 dismissed flag。
  let dismissed = false;
  try { await readFile(PERMISSION_GUIDE_SHOWN, 'utf-8'); dismissed = true; } catch {}
  let canRead = null;
  if (req.query?.probe === '1') {
    try { await readdir(join(homedir(), 'Downloads')); canRead = true; }
    catch { canRead = false; }
  }
  res.json({
    platform: plat,
    needsFullDiskAccess: !dismissed,
    canReadDownloads: canRead,
    dismissed,
  });
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

// L5: 设置面板用 — 让用户重新触发引导(例:换了机器/重 build 后想重新提醒)
router.post('/system/permission-guide-reset', async (_req, res) => {
  try { (await import('fs/promises')).unlink(PERMISSION_GUIDE_SHOWN).catch(() => {}); res.json({ ok: true }); }
  catch { res.json({ ok: true }); }
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
