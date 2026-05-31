import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { stat } from 'fs/promises';
import { resolveUnderHome } from '../utils/safe-path.js';

const execFileP = promisify(execFile);
const router = Router();

function safeCwd(p) {
  // Normalize harmless `//+` / trailing slash inputs, but keep the HOME boundary
  // exact (`/Users/me2` must not pass for `/Users/me`).
  return resolveUnderHome(p, { label: 'cwd' });
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

    // Baseline commit phase. `add -A` may fail when the working tree contains
    // embedded git repos with no commits, or other corner cases. In that
    // scenario the user STILL has a usable git repo (init succeeded) — only
    // the baseline snapshot is missing. We surface a warning instead of a
    // 500 so the GUI stops nagging "not a git repo" forever.
    let committed = false, sha = null;
    let baselineWarning = null;
    if (commit) {
      try {
        await execFileP('git', ['-C', cwd, 'add', '-A'], { timeout: 15000 });
        try {
          await execFileP('git', ['-C', cwd, 'diff', '--cached', '--quiet'], { timeout: 4000 });
          // No staged changes — nothing to commit.
        } catch {
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
            baselineWarning = 'commit failed: ' + (err.stderr || err.message);
          }
        }
      } catch (err) {
        // `git add -A` failed (most commonly: embedded repo without commits).
        // Repo itself is fine — just skip baseline commit.
        baselineWarning = 'add -A failed (embedded repos?): ' + (err.stderr || err.message);
      }
    }

    res.json({ ok: true, already, committed, sha, baselineWarning });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
