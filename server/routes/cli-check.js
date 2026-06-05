import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);
const router = Router();

/**
 * GET /api/cli-check
 * 检测 `claude` CLI 是否可执行。给首次启动的小白用户用:GUI 表面打开正常但
 * 没装 CLI 就发不出消息(spawn ENOENT),弹模态指引按系统安装。
 *
 * 返回 { installed: true, version: 'x.y.z' } 或 { installed: false, error: 'ENOENT' }。
 * 失败永远返回 200 — 前端只看 installed 字段决定是否弹窗。
 */
router.get('/cli-check', async (req, res) => {
  try {
    const { stdout } = await execFileP('claude', ['--version'], { timeout: 5000 });
    res.json({ installed: true, version: stdout.trim() });
  } catch (err) {
    res.json({ installed: false, error: err.code || err.message || 'unknown' });
  }
});

export default router;
