import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const execFileP = promisify(execFile);
const router = Router();

// 执行一个 claude 候选并取版本。Windows 上 npm 装的是 claude.cmd/.bat/.ps1 ——
// Node 的 execFile **不能直接执行 .cmd/.bat**(它们不是真正可执行文件,要经 cmd.exe),
// 直接 execFileP('xxx.cmd') 会抛 EINVAL/ENOENT。所以 .cmd/.bat/.ps1 一律走 cmd.exe /c。
async function claudeVersion(p) {
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(p)) {
    const { stdout } = await execFileP('cmd.exe', ['/c', p, '--version'], { timeout: 5000 });
    return stdout.trim();
  }
  const { stdout } = await execFileP(p, ['--version'], { timeout: 5000 });
  return stdout.trim();
}

// Windows:用 `npm config get prefix` 拿到真实的 npm 全局前缀(全局 .cmd 垫片就放在
// 这个目录下)。npm 本体在 Node 安装目录、恒在 PATH,所以即便「全局前缀目录本身」没进
// 后端进程的 PATH(GUI 启动时 PATH 没刷新、或自定义/nvm4w 前缀),也能定位到 claude.cmd。
async function npmGlobalCandidates() {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileP('cmd.exe', ['/c', 'npm', 'config', 'get', 'prefix'], { timeout: 6000 });
    const prefix = stdout.trim();
    if (!prefix || /^undefined$/i.test(prefix)) return [];
    return [join(prefix, 'claude.cmd'), join(prefix, 'claude.exe'), join(prefix, 'claude')];
  } catch { return []; }
}

/**
 * GET /api/cli-check
 * 检测 `claude` CLI 是否可执行。给首次启动的小白用户用:GUI 表面打开正常但没装 CLI
 * 就发不出消息(spawn ENOENT),弹模态指引安装。永远返回 200。
 *
 * 多策略,避免 nvm/mise/asdf/npm 全局前缀等位置误报"未装":
 *  1. PATH 直接执行(Win 经 cmd.exe 按 PATHEXT 解析 .cmd/.exe)
 *  2. (非 Win)login shell 加载用户 profile 拿版本管理器改写的 PATH
 *  3. (Win)`npm config get prefix` 动态定位全局前缀里的 claude.cmd/.exe
 *  4. 兜底扫已知绝对路径(.cmd 经 cmd.exe 执行)
 */
router.get('/cli-check', async (req, res) => {
  // 策略 1:走 PATH。Win 经 cmd.exe(解析 .cmd/.ps1,覆盖 nvm4w / 任意在 PATH 的 npm prefix)。
  try {
    const version = process.platform === 'win32'
      ? (await execFileP('cmd.exe', ['/c', 'claude', '--version'], { timeout: 5000 })).stdout.trim()
      : (await execFileP('claude', ['--version'], { timeout: 5000 })).stdout.trim();
    return res.json({ installed: true, version, via: 'PATH' });
  } catch {}

  // 策略 2:login shell — 加载用户 profile(nvm / mise / asdf 在这里给 PATH)
  if (process.platform !== 'win32') {
    try {
      const { stdout: which } = await execFileP('sh', ['-lc', 'command -v claude'], { timeout: 5000 });
      const path = which.trim();
      if (path) {
        return res.json({ installed: true, version: await claudeVersion(path), via: 'login-shell', path });
      }
    } catch {}
  }

  // 策略 3(Win):动态发现 npm 全局前缀里的 claude(根治"PATH 没含前缀/自定义前缀"导致
  // 策略 1 落空,但 cmd 里 claude -v 却能跑")。
  for (const p of await npmGlobalCandidates()) {
    if (!existsSync(p)) continue;
    try { return res.json({ installed: true, version: await claudeVersion(p), via: 'npm-prefix', path: p }); }
    catch {}
  }

  // 策略 4:扫已知绝对路径(.cmd 经 cmd.exe 执行,修"扫到 claude.cmd 却 execFile 失败")。
  const home = homedir();
  const candidates = process.platform === 'win32'
    ? [
        join(home, 'AppData', 'Local', 'AnthropicClaude', 'claude.exe'),
        join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
        join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm', 'claude.exe'),
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
    try { return res.json({ installed: true, version: await claudeVersion(p), via: 'fallback', path: p }); }
    catch {}
  }

  res.json({ installed: false, error: '所有检测策略均未找到 claude(PATH / npm 前缀 / 已知路径)' });
});

export default router;
