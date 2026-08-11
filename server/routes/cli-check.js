import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { resolveClaude, getClaudeOverride } from '../utils/claude-resolver.js';

const execFileP = promisify(execFile);
const router = Router();

// 执行 claude 取版本。Windows 上 npm 装的是 claude.cmd/.bat/.ps1 —— Node 的 execFile
// **不能直接执行 .cmd/.bat**(它们不是真正可执行文件,要经 cmd.exe),直接
// execFileP('xxx.cmd') 会抛 EINVAL/ENOENT。Windows 一律走 cmd.exe /c(.exe 也兼容)。
async function claudeVersion(p) {
  if (process.platform === 'win32') {
    const { stdout } = await execFileP('cmd.exe', ['/c', p, '--version'], { timeout: 5000 });
    return stdout.trim();
  }
  const { stdout } = await execFileP(p, ['--version'], { timeout: 5000 });
  return stdout.trim();
}

/**
 * GET /api/cli-check
 * 检测 `claude` CLI 是否可执行。给首次启动的小白用户用:GUI 表面打开正常但没装 CLI
 * 就发不出消息(spawn ENOENT),弹模态指引安装。永远返回 200。
 *
 * 路径解析统一走 claude-resolver(PATH → login shell → npm 全局前缀 → 已知安装
 * 路径),与 claudeSpawn / SDK / env-check 同源 —— 检测到的即是实际会用的那个。
 */
router.get('/cli-check', async (req, res) => {
  // R8-2:手动指定的 claude 路径已失效(文件没了)→ 显式告知(只增字段,老前端忽略)。
  // 此前 resolver 静默回落自动优先级,用户以为还在用指定的那个,实际跑的是回落安装。
  const override = getClaudeOverride();
  const deadFields = (override && !existsSync(override)) ? { overrideDead: true, override } : {};
  const hit = resolveClaude();
  if (!hit) {
    return res.json({ installed: false, error: '所有检测策略均未找到 claude(PATH / login shell / npm 前缀 / 已知路径)', ...deadFields });
  }
  try {
    const version = await claudeVersion(hit.path);
    return res.json({ installed: true, version, via: hit.via, path: hit.path, resolvedPath: hit.path, ...deadFields });
  } catch (err) {
    return res.json({
      installed: false,
      resolvedPath: hit.path,
      error: `已定位到 ${hit.path},但执行 --version 失败:${err.message || err}`,
      ...deadFields,
    });
  }
});

export default router;
