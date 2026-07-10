import { Router } from 'express';
import { parseJsonl } from '../utils/jsonl-parser.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { stat, unlink } from 'fs/promises';
import { resolveWorkspacePath } from '../utils/safe-path.js';

const execFileP = promisify(execFile);

const router = Router();
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// projectHash / sessionId arrive from the request and get concatenated into an
// fs path under PROJECTS_DIR. A crafted `../../` would escape it. Real values
// have no slashes / dots-dots. (Mirrors safeId in sessions.js.)
function safeId(s) {
  if (typeof s !== 'string' || !s) return false;
  return !(s.includes('/') || s.includes('\\') || s.includes('..') || s.includes('\0'));
}

/**
 * Extract file changes from a session's tool calls.
 * Looks for Edit, Write, and Bash commands that modify files.
 */
// 行级 diff(LCS):只标真正变化的行,相同行作为上下文(' '前缀) —— 对齐 claude code /
// codex 的 diff 语义。旧实现把 old 整段标删、new 整段标增(哪怕只改一行也全红全绿),
// 既不准也没法看清改了啥。
function lineDiff(oldStr, newStr) {
  const a = oldStr == null ? [] : String(oldStr).split('\n');
  const b = newStr == null ? [] : String(newStr).split('\n');
  const m = a.length, n = b.length;
  // 大文件保护:LCS dp 表 O(m×n) 内存(2000×2000≈32MB)。超阈值降级为整段删+整段
  // 增,避免会话里多个大文件 Edit 把 server 撑爆 OOM。
  if (m * n > 4_000_000) return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  // LCS 长度表(自底向上)。Edit 的 old/new 通常是文件片段(几十行),m*n 很小;
  // Write 新文件 old 为空 → 直接全部当新增,不构建大表。
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < m) { ops.push(['-', a[i]]); i++; }
  while (j < n) { ops.push(['+', b[j]]); j++; }
  return ops;
}

function unifiedDiff(filePath, oldStr, newStr, label = 'change') {
  const file = String(filePath || label).replace(/^[/\\]+/, '');
  const ops = lineDiff(oldStr, newStr);
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@',
    ...ops.map(([sign, line]) => `${sign}${line}`),
  ].join('\n');
}

function diffStats(diff) {
  const lines = String(diff || '').split('\n');
  return {
    additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
  };
}

// 取一条 user 记录里真正的"用户输入文本"。CLI 会把工具结果也写成 type:'user' 记录
// (content 里是 tool_result),那不是新回合的开始,返回空串以便跳过。
function userInputText(record) {
  const c = record.message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('\n').trim();
  }
  return '';
}

export function extractFileChanges(records) {
  const changes = [];
  const seen = new Set();
  // 回合追踪:每条"真用户输入"开启一个新回合,后续文件变更都归到这个回合 —— 让前端
  // 能按"第几轮对话 + 你那条消息"分组,区分同一文件在不同回合里的多次修改。
  let turnIndex = 0;
  let turnPrompt = '';
  let turnTs = null;

  for (const record of records) {
    if (record.type === 'user') {
      const text = userInputText(record);
      if (text) { turnIndex += 1; turnPrompt = text.slice(0, 120); turnTs = record.timestamp; }
      continue;
    }
    if (record.type !== 'assistant') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;

    const turnMeta = { turnIndex, turnPrompt, turnTs };
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const { name, input, id: toolUseId } = block;

      if (name === 'Edit' && input?.file_path) {
        const key = `edit:${toolUseId || record.uuid}:${input.file_path}:0`;
        if (!seen.has(key)) {
          seen.add(key);
          const diff = unifiedDiff(input.file_path, input.old_string ?? '', input.new_string ?? '');
          changes.push({
            id: key,
            ...turnMeta,
            type: 'edit',
            toolUseId,
            file: input.file_path,
            timestamp: record.timestamp,
            model: record.message?.model,
            uuid: record.uuid,
            diff,
            ...diffStats(diff),
            preview: input.new_string?.slice(0, 200) || '',
            oldPreview: input.old_string?.slice(0, 200) || '',
          });
        }
      } else if (name === 'MultiEdit' && input?.file_path && Array.isArray(input.edits)) {
        input.edits.forEach((edit, editIndex) => {
          const key = `multiedit:${toolUseId || record.uuid}:${input.file_path}:${editIndex}`;
          if (seen.has(key)) return;
          seen.add(key);
          const diff = unifiedDiff(input.file_path, edit.old_string ?? '', edit.new_string ?? '', `edit-${editIndex + 1}`);
          changes.push({
            id: key,
            ...turnMeta,
            type: 'edit',
            toolName: 'MultiEdit',
            toolUseId,
            editIndex,
            file: input.file_path,
            timestamp: record.timestamp,
            model: record.message?.model,
            uuid: record.uuid,
            diff,
            ...diffStats(diff),
            preview: edit.new_string?.slice(0, 200) || '',
            oldPreview: edit.old_string?.slice(0, 200) || '',
          });
        });
      } else if (name === 'Write' && input?.file_path) {
        const key = `write:${toolUseId || record.uuid}:${input.file_path}:0`;
        if (!seen.has(key)) {
          seen.add(key);
          const diff = unifiedDiff(input.file_path, null, input.content ?? '', 'new-file');
          changes.push({
            id: key,
            ...turnMeta,
            type: 'write',
            toolUseId,
            file: input.file_path,
            timestamp: record.timestamp,
            model: record.message?.model,
            uuid: record.uuid,
            diff,
            ...diffStats(diff),
            preview: input.content?.slice(0, 200) || '',
          });
        }
      } else if (name === 'Bash' && input?.command) {
        // Detect file-modifying bash commands
        const cmd = input.command;
        if (/\b(mv|cp|rm|mkdir|touch|chmod|chown|tee|sed -i)\b/.test(cmd)) {
          const key = `bash:${cmd.slice(0, 100)}:${record.timestamp}`;
          if (!seen.has(key)) {
            seen.add(key);
            changes.push({
              id: key,
              ...turnMeta,
              type: 'bash',
              toolUseId,
              command: cmd,
              timestamp: record.timestamp,
              model: record.message?.model,
              uuid: record.uuid,
            });
          }
        }
      }
    }
  }

  return changes;
}

// GET /api/sessions/:sessionId/file-changes — file changes in a session
router.get('/sessions/:sessionId/file-changes', async (req, res) => {
  try {
    const { projectHash } = req.query;
    if (!projectHash) {
      return res.status(400).json({ error: 'projectHash required' });
    }
    if (!safeId(projectHash) || !safeId(req.params.sessionId)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const filePath = join(PROJECTS_DIR, projectHash, `${req.params.sessionId}.jsonl`);
    const records = await parseJsonl(filePath);
    const changes = extractFileChanges(records);
    res.json(changes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Make sure callers can't reach outside the user's home with a crafted path.
function assertSafePath(p) {
  // resolveWorkspacePath = $HOME 门禁 + 已知 claude 工作区例外(HOME 外项目/tmp 会话
  // 文件回滚曾报 "path outside $HOME",用户实报);.. / . 段仍一律拒绝。
  return resolveWorkspacePath(p, { requireCanonical: true });
}

/**
 * POST /api/file/revert  { file }
 * `git checkout HEAD -- <file>` from the file's enclosing repo. Reverts the
 * file to whatever HEAD has — same semantics a user would type at the shell.
 */
router.post('/file/revert', async (req, res) => {
  try {
    const file = assertSafePath(req.body?.file);
    const allowDeleteUntracked = req.body?.allowDeleteUntracked === true;
    // Find the git root by climbing parents until `.git` appears.
    let cwd = dirname(file);
    let gitRoot = null;
    for (let i = 0; i < 24 && cwd !== '/'; i++) {
      try {
        const st = await stat(join(cwd, '.git'));
        if (st) { gitRoot = cwd; break; }
      } catch {}
      cwd = dirname(cwd);
    }
    if (!gitRoot) return res.status(400).json({ error: 'file is not inside a git repo' });

    const rel = file.slice(gitRoot.length + 1);
    let tracked = true;
    try {
      await execFileP('git', ['-C', gitRoot, 'ls-files', '--error-unmatch', '--', rel], { timeout: 5000 });
    } catch {
      tracked = false;
    }
    if (!tracked) {
      if (!allowDeleteUntracked) {
        return res.status(409).json({ error: 'file is untracked; pass allowDeleteUntracked to delete it' });
      }
      await unlink(file);
      return res.json({ ok: true, file, gitRoot, deletedUntracked: true });
    }
    await execFileP('git', ['-C', gitRoot, 'checkout', 'HEAD', '--', rel], { timeout: 10000 });
    res.json({ ok: true, file, gitRoot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/file/open  { file }
 * Hand off to the OS to open the file in the default editor.
 */
router.post('/file/open', async (req, res) => {
  try {
    const file = assertSafePath(req.body?.file);
    const opener = process.platform === 'darwin' ? 'open'
                 : process.platform === 'win32' ? 'explorer'
                 : 'xdg-open';
    await execFileP(opener, [file], { timeout: 5000 }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
