import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve as pathResolve } from 'path';
import { homedir } from 'os';
import { stat } from 'fs/promises';

const execFileP = promisify(execFile);
const router = Router();

function safeCwd(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('invalid cwd');
  const r = pathResolve(p);
  if (r !== p) throw new Error('invalid cwd');
  if (!r.startsWith(homedir())) throw new Error('refusing to operate outside $HOME');
  return r;
}

/** GET /api/git/status?cwd=... → { isRepo, branch, hasChanges } */
router.get('/git/status', async (req, res) => {
  try {
    const cwd = safeCwd(String(req.query.cwd || ''));
    try { await stat(cwd); } catch { return res.status(404).json({ error: 'cwd does not exist' }); }
    try {
      const top = await execFileP('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 4000 });
      const root = top.stdout.trim();
      let branch = '';
      try {
        const b = await execFileP('git', ['-C', cwd, 'branch', '--show-current'], { timeout: 4000 });
        branch = b.stdout.trim();
      } catch {}
      let hasChanges = false;
      try {
        const s = await execFileP('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 4000 });
        hasChanges = s.stdout.trim().length > 0;
      } catch {}
      res.json({ isRepo: true, root, branch, hasChanges });
    } catch {
      res.json({ isRepo: false });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/git/init { cwd, commit?: true, message? }
 * Runs `git init`, optionally followed by `git add -A && git commit`.
 * If the dir is already a repo this is a no-op (idempotent).
 */
router.post('/git/init', async (req, res) => {
  try {
    const cwd = safeCwd(req.body?.cwd || '');
    const commit = req.body?.commit !== false;
    const message = String(req.body?.message || 'chore: initial commit (via Claude GUI)');

    // Already a repo? No-op for init.
    let already = false;
    try {
      await execFileP('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 4000 });
      already = true;
    } catch {}

    if (!already) {
      await execFileP('git', ['-C', cwd, 'init'], { timeout: 8000 });
    }

    let committed = false, sha = null;
    if (commit) {
      await execFileP('git', ['-C', cwd, 'add', '-A'], { timeout: 15000 });
      // Skip commit if nothing is staged (empty dir).
      try {
        await execFileP('git', ['-C', cwd, 'diff', '--cached', '--quiet'], { timeout: 4000 });
      } catch {
        // Non-zero exit = staged changes exist → commit them.
        try {
          await execFileP('git', ['-C', cwd, 'commit', '-m', message], {
            timeout: 30000,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'claude-gui',
              GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'gui@claude',
              GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'claude-gui',
              GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'gui@claude',
            },
          });
          committed = true;
          const rev = await execFileP('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 4000 });
          sha = rev.stdout.trim();
        } catch (err) {
          return res.status(500).json({ error: 'commit failed: ' + err.message });
        }
      }
    }

    res.json({ ok: true, already, committed, sha });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
