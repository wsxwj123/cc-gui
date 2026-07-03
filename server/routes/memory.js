// CLAUDE.md 记忆文件读写。支持官方文档定义的多层级(code.claude.com/docs/en/memory):
//   user(全局)    ~/.claude/CLAUDE.md            所有项目,仅你
//   project(项目) <cwd>/CLAUDE.md 或 .claude/CLAUDE.md  团队共享(git)
//   local(本地)   <cwd>/CLAUDE.local.md          当前项目,仅你(应 gitignore)
//   managed(组织) 平台固定路径                    只读(IT 下发,GUI 不可改)
import { Router } from 'express';
import { readFile, writeFile, mkdir, stat, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join, dirname, resolve } from 'path';
import { isPathInside } from '../utils/safe-path.js';

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

// ── auto-memory(CLI 自动记忆)────────────────────────────────────────────
// CLI 把跨会话记忆写在 ~/.claude/projects/<hash>/memory/:MEMORY.md 是索引
// (每条一行 `- [标题](file.md) — 描述`),每条记忆一个 kebab-case .md(frontmatter
// name/description)。GUI 提供 查/改/删;MEMORY.md 本身只读展示,删除条目时联动
// 删掉它的索引行。hash 编码与 CLI 一致:非字母数字全部 → '-'。

function memoryDirFor(cwd) {
  const hash = String(cwd).replace(/[^A-Za-z0-9]/g, '-');
  return join(HOME, '.claude', 'projects', hash, 'memory');
}

// 文件名白名单 + isPathInside 双保险(safe-path)。MEMORY.md 索引不许直接写/删。
function safeEntryPath(dir, file) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file) || file === 'MEMORY.md') return null;
  const p = join(dir, file);
  return isPathInside(p, dir) ? p : null;
}

function parseEntryMeta(content) {
  const meta = { name: '', description: '' };
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const n = fm[1].match(/^name:\s*(.+)$/m);
    const d = fm[1].match(/^description:\s*(.+)$/m);
    if (n) meta.name = n[1].trim();
    if (d) meta.description = d[1].trim();
  }
  return meta;
}

// GET /api/memory/entries?cwd= — 列出该项目全部自动记忆 + 索引原文
router.get('/memory/entries', async (req, res) => {
  const cwd = String(req.query.cwd || '');
  if (!cwd) return res.status(400).json({ error: 'cwd 必填' });
  const dir = memoryDirFor(cwd);
  const entries = [];
  let index = '';
  try {
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.md')) continue;
      if (f === 'MEMORY.md') {
        try { index = await readFile(join(dir, f), 'utf-8'); } catch {}
        continue;
      }
      const p = safeEntryPath(dir, f);
      if (!p) continue;
      try {
        const content = await readFile(p, 'utf-8');
        const st = await stat(p);
        entries.push({ file: f, ...parseEntryMeta(content), mtime: st.mtimeMs });
      } catch {}
    }
  } catch { /* 目录不存在 = 该项目还没有自动记忆 */ }
  entries.sort((a, b) => b.mtime - a.mtime);
  res.json({ dir, index, entries });
});

// GET /api/memory/entries/:file?cwd=
router.get('/memory/entries/:file', async (req, res) => {
  const dir = memoryDirFor(String(req.query.cwd || ''));
  const p = safeEntryPath(dir, req.params.file);
  if (!p) return res.status(400).json({ error: 'invalid file' });
  try {
    const content = await readFile(p, 'utf-8');
    const st = await stat(p);
    res.json({ file: req.params.file, content, mtime: st.mtimeMs });
  } catch { res.status(404).json({ error: 'not found' }); }
});

// PUT /api/memory/entries/:file { cwd, content, baseMtime? }
// baseMtime 乐观检查:CLI 可能在会话运行中并发重写记忆,磁盘比编辑基线新则拒绝,防静默覆盖。
router.put('/memory/entries/:file', async (req, res) => {
  const { cwd = '', content = '', baseMtime = null } = req.body || {};
  const dir = memoryDirFor(String(cwd));
  const p = safeEntryPath(dir, req.params.file);
  if (!p) return res.status(400).json({ error: 'invalid file' });
  try {
    if (baseMtime != null) {
      try {
        const st = await stat(p);
        if (st.mtimeMs > Number(baseMtime) + 1) {
          return res.status(409).json({ error: '该记忆在你编辑期间被 CLI 更新过,请刷新后重改' });
        }
      } catch { /* 文件不存在 = 新建,放行 */ }
    }
    await mkdir(dir, { recursive: true });
    await writeFile(p, String(content), 'utf-8');
    const st = await stat(p);
    res.json({ ok: true, mtime: st.mtimeMs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/memory/entries/:file?cwd= — 删条目 + 联动删 MEMORY.md 里它的索引行
router.delete('/memory/entries/:file', async (req, res) => {
  const dir = memoryDirFor(String(req.query.cwd || ''));
  const p = safeEntryPath(dir, req.params.file);
  if (!p) return res.status(400).json({ error: 'invalid file' });
  try {
    await unlink(p);
    const idxPath = join(dir, 'MEMORY.md');
    try {
      const idx = await readFile(idxPath, 'utf-8');
      const next = idx.split('\n').filter((l) => !l.includes(`](${req.params.file})`)).join('\n');
      if (next !== idx) await writeFile(idxPath, next, 'utf-8');
    } catch { /* 无索引文件,忽略 */ }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
