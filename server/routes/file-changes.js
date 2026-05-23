import { Router } from 'express';
import { parseJsonl } from '../utils/jsonl-parser.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, resolve as pathResolve, dirname } from 'path';
import { homedir } from 'os';
import { stat } from 'fs/promises';

const execFileP = promisify(execFile);

const router = Router();
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Extract file changes from a session's tool calls.
 * Looks for Edit, Write, and Bash commands that modify files.
 */
function extractFileChanges(records) {
  const changes = [];
  const seen = new Set();

  for (const record of records) {
    if (record.type !== 'assistant') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const { name, input } = block;

      if (name === 'Edit' && input?.file_path) {
        const key = `edit:${input.file_path}:${record.timestamp}`;
        if (!seen.has(key)) {
          seen.add(key);
          changes.push({
            type: 'edit',
            file: input.file_path,
            timestamp: record.timestamp,
            model: record.message?.model,
            uuid: record.uuid,
            preview: input.new_string?.slice(0, 200) || '',
            oldPreview: input.old_string?.slice(0, 200) || '',
          });
        }
      } else if (name === 'Write' && input?.file_path) {
        const key = `write:${input.file_path}:${record.timestamp}`;
        if (!seen.has(key)) {
          seen.add(key);
          changes.push({
            type: 'write',
            file: input.file_path,
            timestamp: record.timestamp,
            model: record.message?.model,
            uuid: record.uuid,
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
              type: 'bash',
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
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('invalid path');
  const resolved = pathResolve(p);
  if (resolved !== p) throw new Error('invalid path');
  if (!resolved.startsWith(homedir())) throw new Error('refusing to touch path outside $HOME');
  return resolved;
}

/**
 * POST /api/file/revert  { file }
 * `git checkout HEAD -- <file>` from the file's enclosing repo. Reverts the
 * file to whatever HEAD has — same semantics a user would type at the shell.
 */
router.post('/file/revert', async (req, res) => {
  try {
    const file = assertSafePath(req.body?.file);
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
