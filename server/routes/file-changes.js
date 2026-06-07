import { Router } from 'express';
import { parseJsonl } from '../utils/jsonl-parser.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { stat, unlink } from 'fs/promises';
import { resolveUnderHome } from '../utils/safe-path.js';

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
function unifiedDiff(filePath, oldStr, newStr, label = 'change') {
  const file = String(filePath || label).replace(/^[/\\]+/, '');
  const oldLines = oldStr == null ? [] : String(oldStr).split('\n');
  const newLines = newStr == null ? [] : String(newStr).split('\n');
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@',
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

function diffStats(diff) {
  const lines = String(diff || '').split('\n');
  return {
    additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
  };
}

export function extractFileChanges(records) {
  const changes = [];
  const seen = new Set();

  for (const record of records) {
    if (record.type !== 'assistant') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;

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
  return resolveUnderHome(p, { requireCanonical: true });
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
