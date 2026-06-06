import { Router } from 'express';
import { spawn } from 'child_process';

const router = Router();

/**
 * POST /api/open-url { url }
 *
 * Tauri WebView 默认拦截 `<a target="_blank">` 跳转(没有"新窗口"概念),
 * 用户点链接没反应。所有"打开外部 URL"统一走这个端点,server 用系统命令
 * 打开默认浏览器:macOS `open`,Windows `explorer.exe`,Linux `xdg-open`。
 *
 * 安全:只接 http/https,拒绝 file:// / javascript: / data: 等可能危险的协议。
 */
router.post('/open-url', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url 必填' });

  let u;
  try { u = new URL(url); } catch { return res.status(400).json({ error: 'url 非法' }); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: '只支持 http/https' });

  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
