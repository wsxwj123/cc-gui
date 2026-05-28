import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname, resolve as pathResolve } from 'path';
import { homedir } from 'os';
import { stat, mkdir } from 'fs/promises';

const execFileP = promisify(execFile);
const router = Router();

// Checkpoints are stored as a shadow git index under ~/.claude/gui/checkpoints/<sessionId>/
// (a separate worktree-like directory keyed off GIT_DIR). We don't touch the
// user's real repo history; restores happen via `git --work-tree=<cwd> --git-dir=<shadow>
// checkout <sha> -- .` so the user's index/branch/staging is untouched.
const CHECKPOINTS_ROOT = join(homedir(), '.claude', 'gui', 'checkpoints');

function safe(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('invalid path');
  // Use pathResolve to canonicalize `//+` and trailing `/` rather than reject —
  // legacy project dirs decode to non-canonical paths but are still valid.
  const r = pathResolve(p);
  if (!r.startsWith(homedir())) throw new Error('out of $HOME');
  return r;
}

const SESSION_RE = /^[A-Za-z0-9_-]{1,80}$/;
function assertSession(id) {
  if (!SESSION_RE.test(String(id || ''))) throw new Error('invalid sessionId');
}

async function shadowDir(sessionId) {
  const d = join(CHECKPOINTS_ROOT, sessionId);
  await mkdir(d, { recursive: true });
  try { await stat(join(d, 'HEAD')); }
  catch {
    await execFileP('git', ['--git-dir', d, 'init', '--bare'], { timeout: 10000 });
  }
  return d;
}

async function gitShadow(args, sessionId, workTree, opts = {}) {
  const gitDir = await shadowDir(sessionId);
  return execFileP('git', ['--git-dir', gitDir, '--work-tree', workTree, ...args],
    { timeout: 30000, ...opts });
}

/** POST /api/checkpoints  { sessionId, cwd, label } */
router.post('/checkpoints', async (req, res) => {
  try {
    const { sessionId, cwd, label } = req.body || {};
    assertSession(sessionId);
    const workTree = safe(cwd);
    await gitShadow(['add', '-A'], sessionId, workTree);
    try {
      const out = await gitShadow(
        ['commit', '--allow-empty', '-m', label || `checkpoint ${new Date().toISOString()}`],
        sessionId, workTree,
        { env: { ...process.env, GIT_AUTHOR_NAME: 'claude-gui', GIT_AUTHOR_EMAIL: 'gui@claude', GIT_COMMITTER_NAME: 'claude-gui', GIT_COMMITTER_EMAIL: 'gui@claude' } },
      );
      res.json({ ok: true, output: out.stdout.slice(0, 500) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/checkpoints/:sessionId */
router.get('/checkpoints/:sessionId', async (req, res) => {
  try {
    assertSession(req.params.sessionId);
    const gitDir = await shadowDir(req.params.sessionId);
    try {
      const out = await execFileP('git', ['--git-dir', gitDir, 'log', '--format=%H%x09%ct%x09%s'],
        { timeout: 10000 });
      const entries = out.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [sha, ts, ...rest] = line.split('\t');
        return { sha, ts: Number(ts) * 1000, label: rest.join('\t') };
      });
      res.json({ entries });
    } catch {
      res.json({ entries: [] });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/checkpoints/:sessionId/restore  { sha, cwd } */
router.post('/checkpoints/:sessionId/restore', async (req, res) => {
  try {
    assertSession(req.params.sessionId);
    const { sha, cwd } = req.body || {};
    if (!/^[a-f0-9]{7,40}$/.test(String(sha || ''))) throw new Error('invalid sha');
    const workTree = safe(cwd);
    await gitShadow(['checkout', sha, '--', '.'], req.params.sessionId, workTree);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
