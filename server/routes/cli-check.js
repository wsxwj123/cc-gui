import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const execFileP = promisify(execFile);
const router = Router();

/**
 * GET /api/cli-check
 * 检测 `claude` CLI 是否可执行。给首次启动的小白用户用:GUI 表面打开正常但
 * 没装 CLI 就发不出消息(spawn ENOENT),弹模态指引按系统安装。
 *
 * 多策略检测,避免 nvm / mise / asdf 等版本管理器装的 claude 误报"未装":
 *  1. 直接走 PATH 查 claude(server 启动时已扩展常见路径)
 *  2. login shell `sh -lc 'command -v claude'`,加载用户 ~/.zshrc / ~/.bashrc
 *     拿到 nvm/mise/asdf 改写过的真实 PATH,任一存在即认作已装
 *  3. 兜底扫已知绝对路径(~/.claude/local/bin/claude 等)
 *
 * 返回 { installed: true, version: 'x.y.z', via: 'PATH'|'login-shell'|'fallback' }
 * 或 { installed: false, error: '...' }。永远返回 200。
 */
router.get('/cli-check', async (req, res) => {
  // 策略 1:走 PATH 直接执行。Windows 上 npm 装的是 claude.cmd/.ps1(没 .exe),
  // Node execFile 不解析 .cmd → 必须经 cmd.exe(按 PATHEXT 解析 .cmd/.exe/.ps1,
  // 覆盖 nvm4w / 任意 npm prefix 等所有在 PATH 里的位置)。
  try {
    const { stdout } = process.platform === 'win32'
      ? await execFileP('cmd.exe', ['/c', 'claude', '--version'], { timeout: 5000 })
      : await execFileP('claude', ['--version'], { timeout: 5000 });
    return res.json({ installed: true, version: stdout.trim(), via: 'PATH' });
  } catch {}

  // 策略 2:login shell — 加载用户 profile(nvm / mise / asdf 在这里给 PATH)
  if (process.platform !== 'win32') {
    try {
      const { stdout: which } = await execFileP('sh', ['-lc', 'command -v claude'], { timeout: 5000 });
      const path = which.trim();
      if (path) {
        const { stdout } = await execFileP(path, ['--version'], { timeout: 5000 });
        return res.json({ installed: true, version: stdout.trim(), via: 'login-shell', path });
      }
    } catch {}
  }

  // 策略 3:扫已知绝对路径
  const home = homedir();
  const candidates = process.platform === 'win32'
    ? [
        join(home, 'AppData', 'Local', 'AnthropicClaude', 'claude.exe'),
        join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
      ]
    : [
        join(home, '.claude', 'local', 'bin', 'claude'),
        join(home, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        '/usr/bin/claude',
      ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const { stdout } = await execFileP(p, ['--version'], { timeout: 5000 });
      return res.json({ installed: true, version: stdout.trim(), via: 'fallback', path: p });
    } catch {}
  }

  res.json({ installed: false, error: '所有检测策略均未找到 claude(PATH / login shell / 已知路径)' });
});

export default router;
