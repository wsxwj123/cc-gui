// CLAUDE.md 记忆文件读写。支持官方文档定义的多层级(code.claude.com/docs/en/memory):
//   user(全局)    ~/.claude/CLAUDE.md            所有项目,仅你
//   project(项目) <cwd>/CLAUDE.md 或 .claude/CLAUDE.md  团队共享(git)
//   local(本地)   <cwd>/CLAUDE.local.md          当前项目,仅你(应 gitignore)
//   managed(组织) 平台固定路径                    只读(IT 下发,GUI 不可改)
import { Router } from 'express';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join, dirname, resolve } from 'path';

const router = Router();
const HOME = homedir();

function managedPath() {
  if (platform() === 'darwin') return '/Library/Application Support/ClaudeCode/CLAUDE.md';
  if (platform() === 'win32') return 'C:\\Program Files\\ClaudeCode\\CLAUDE.md';
  return '/etc/claude-code/CLAUDE.md';
}

// 解析某层级的实际文件路径。project 优先用已存在的 <cwd>/CLAUDE.md,否则
// <cwd>/.claude/CLAUDE.md,都不存在则默认 <cwd>/CLAUDE.md(新建时落主位置)。
function resolvePath(level, cwd) {
  if (level === 'user') return join(HOME, '.claude', 'CLAUDE.md');
  if (level === 'managed') return managedPath();
  if (!cwd) return null;
  const root = resolve(cwd);
  if (level === 'local') return join(root, 'CLAUDE.local.md');
  if (level === 'project') {
    const main = join(root, 'CLAUDE.md');
    const nested = join(root, '.claude', 'CLAUDE.md');
    if (existsSync(main)) return main;
    if (existsSync(nested)) return nested;
    return main;
  }
  return null;
}

const EDITABLE = new Set(['user', 'project', 'local']);

// GET /api/memory?level=user|project|local|managed&cwd=<projectPath>
router.get('/memory', async (req, res) => {
  const level = String(req.query.level || '').trim();
  const cwd = req.query.cwd ? String(req.query.cwd) : '';
  const path = resolvePath(level, cwd);
  if (!path) return res.status(400).json({ error: 'invalid level or missing cwd' });
  let content = '';
  let exists = false;
  let mtime = null;
  try {
    content = await readFile(path, 'utf-8');
    exists = true;
    try { mtime = (await stat(path)).mtimeMs; } catch {}
  } catch { /* 不存在 → 空内容,允许新建 */ }
  res.json({ level, path, content, exists, mtime, editable: EDITABLE.has(level) });
});

// PUT /api/memory { level, cwd, content }
router.put('/memory', async (req, res) => {
  const { level, cwd = '', content = '' } = req.body || {};
  if (!EDITABLE.has(level)) return res.status(403).json({ error: '该层级只读，不可编辑' });
  const path = resolvePath(level, cwd);
  if (!path) return res.status(400).json({ error: 'invalid level or missing cwd' });
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(content), 'utf-8');
    res.json({ ok: true, path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
