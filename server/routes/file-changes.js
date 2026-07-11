import { Router } from 'express';
import { parseJsonl } from '../utils/jsonl-parser.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname, relative, sep } from 'path';
import { homedir } from 'os';
import { stat, unlink, readdir } from 'fs/promises';
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
  // 只有前两行是 ---/+++ 文件头;正文里以 `--`/`++` 开头的内容行(SQL 注释等)拼上
  // diff 符号后也会变成 ---/+++ 前缀,按前缀全局排除会少计。
  const lines = String(diff || '').split('\n');
  let additions = 0, deletions = 0;
  lines.forEach((line, i) => {
    if (i < 2 && (line.startsWith('+++') || line.startsWith('---'))) return;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  });
  return { additions, deletions };
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

  // 预扫 Write 的执行结果:toolUseResult.type==='create'(真新建)/'update'(覆写已
  // 存在文件)。按 tool_use_id 索引,回填到 change.isNewFile,供前端决定回滚能否删除。
  const writeIsNew = new Map();
  for (const record of records) {
    if (record.type !== 'user') continue;
    const tur = record.toolUseResult;
    if (tur && typeof tur === 'object' && (tur.type === 'create' || tur.type === 'update')) {
      const c = record.message?.content;
      const tid = Array.isArray(c) ? c.find((b) => b?.type === 'tool_result')?.tool_use_id : null;
      if (tid) writeIsNew.set(tid, tur.type === 'create');
    }
  }

  for (const record of records) {
    if (record.type === 'user') {
      const text = userInputText(record);
      // CLI 元记录不是新回合:isMeta(caveat 等)、slash 回显(<command-name>)、
      // 本地命令输出(<local-command-*)、compact 续传摘要 —— 当回合会让变更归到
      // "回合 N:<local-command-stdout>Compacted" 这类假 prompt 下。
      const isMetaRecord = record.isMeta === true
        || /^(<command-name>|<local-command-|<system-reminder)/.test(text)
        || text.startsWith('This session is being continued from a previous conversation');
      if (text && !isMetaRecord) { turnIndex += 1; turnPrompt = text.slice(0, 120); turnTs = record.timestamp; }
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
            // isNewFile:仅当 Write 真的新建了文件(toolUseResult.type==='create')才为
            // true。Write 也能【覆写】已存在文件(type==='update'),此时回滚不能当新建
            // 直接删——CLAUDE.local.md / .env 等 gitignored 文件被覆写后若按"新建"删除
            // 就把用户原文件销毁了。null=jsonl 无结果记录(保守当非新建,不授权删除)。
            isNewFile: writeIsNew.has(toolUseId) ? writeIsNew.get(toolUseId) : null,
            file: input.file_path,
            timestamp: record.timestamp,
            model: record.message?.model,
            uuid: record.uuid,
            diff,
            ...diffStats(diff),
            preview: input.content?.slice(0, 200) || '',
          });
        }
      } else if (name === 'NotebookEdit' && input?.notebook_path) {
        // .ipynb 单元格编辑:old 内容不在 input 里拿不到,diff 只展示新内容(insert/
        // replace)或标记删除;重点是别让 notebook 改动在审查面板整体隐身。
        const key = `nbedit:${toolUseId || record.uuid}:${input.notebook_path}:${input.cell_id || '0'}`;
        if (!seen.has(key)) {
          seen.add(key);
          const newSrc = input.edit_mode === 'delete' ? '' : (input.new_source ?? '');
          const diff = unifiedDiff(input.notebook_path, input.edit_mode === 'delete' ? '(已删除单元格)' : null, newSrc, 'notebook-cell');
          changes.push({
            id: key,
            ...turnMeta,
            type: 'edit',
            toolName: 'NotebookEdit',
            toolUseId,
            file: input.notebook_path,
            timestamp: record.timestamp,
            model: record.message?.model,
            uuid: record.uuid,
            diff,
            ...diffStats(diff),
            preview: newSrc.slice(0, 200),
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
    // 子代理(Task)的改动落在 <sid>/subagents/agent-*.jsonl,不在主 jsonl —— 漏掉
    // 它们=派发出去的文件修改在审查面板完全隐身。每个子代理单独提取(忽略其内部
    // 回合划分),按时间戳归入主时间线的对应回合,带 subagent 字段标来源。
    try {
      const subDir = join(PROJECTS_DIR, projectHash, req.params.sessionId, 'subagents');
      const files = (await readdir(subDir)).filter((f) => f.endsWith('.jsonl'));
      if (files.length) {
        const turns = [];
        for (const c of changes) {
          if (!turns.length || turns[turns.length - 1].turnIndex !== c.turnIndex) {
            turns.push({ turnIndex: c.turnIndex, turnPrompt: c.turnPrompt, turnTs: c.turnTs });
          }
        }
        for (const f of files) {
          const subRecords = await parseJsonl(join(subDir, f)).catch(() => []);
          for (const c of extractFileChanges(subRecords)) {
            const t = Date.parse(c.timestamp || '') || 0;
            let owner = null;
            for (const turn of turns) {
              const ts = Date.parse(turn.turnTs || '') || 0;
              if (ts && ts <= t) owner = turn;
              else if (ts > t) break;
            }
            changes.push({
              ...c,
              turnIndex: owner ? owner.turnIndex : 0,
              turnPrompt: owner ? owner.turnPrompt : '',
              turnTs: owner ? owner.turnTs : c.turnTs,
              subagent: f.replace(/^agent-|\.jsonl$/g, ''),
              id: `${f}:${c.id}`,
            });
          }
        }
      }
    } catch { /* 无 subagents 目录 = 常态 */ }
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
    // 终止条件用 dirname(cwd)===cwd(平台无关的文件系统根):Windows 上根是 `C:\`
    // 而非 `/`,原 `cwd !== '/'` 恒真只靠 24 次上限退出(空转);盘符根本身是仓库时
    // gitRoot='C:\' 带尾分隔符,slice(length+1) 会把 rel 切错一位。
    let cwd = dirname(file);
    let gitRoot = null;
    for (let i = 0; i < 24; i++) {
      try {
        const st = await stat(join(cwd, '.git'));
        if (st) { gitRoot = cwd; break; }
      } catch {}
      const parent = dirname(cwd);
      if (parent === cwd) break;
      cwd = parent;
    }
    if (!gitRoot) return res.status(400).json({ error: 'file is not inside a git repo' });

    const rel = relative(gitRoot, file).split(sep).join('/');
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
    // `--`:文件名以 `-` 开头时 open/xdg-open 会当选项解析(explorer 无此语义,不加)。
    const openArgs = process.platform === 'win32' ? [file] : ['--', file];
    await execFileP(opener, openArgs, { timeout: 5000 }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
