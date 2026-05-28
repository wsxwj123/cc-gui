import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname, basename, resolve as pathResolve } from 'path';
import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { stat } from 'fs/promises';

const execFileP = promisify(execFile);
const router = Router();

function safe(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('invalid path');
  const r = pathResolve(p);
  if (r !== p) throw new Error('invalid path');
  if (!r.startsWith(homedir())) throw new Error('out of $HOME');
  return r;
}

async function findGitRoot(start) {
  let cwd = start;
  for (let i = 0; i < 24 && cwd !== '/'; i++) {
    try { await stat(join(cwd, '.git')); return cwd; } catch {}
    cwd = dirname(cwd);
  }
  return null;
}

/** POST /api/worktree  { cwd, name? } → creates a sibling worktree */
router.post('/worktree', async (req, res) => {
  try {
    const cwd = safe(req.body?.cwd || '');
    const name = String(req.body?.name || `session-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-');
    const root = await findGitRoot(cwd);
    if (!root) return res.status(400).json({ error: 'not inside a git repo' });

    // Collect all worktrees in a single `<repo名>-worktrees/` folder beside the
    // repo, instead of scattering loose sibling dirs (which landed on Desktop
    // when the repo sat directly under it). e.g. repo `/a/b/myrepo` →
    // worktree `/a/b/myrepo-worktrees/<name>`.
    const container = pathResolve(root, '..', `${basename(root)}-worktrees`);
    // Guard: never create the container outside $HOME (e.g. if root sits
    // directly under /Users, its parent escapes HOME).
    if (!container.startsWith(homedir())) {
      return res.status(400).json({ error: 'worktree container would fall outside $HOME' });
    }
    await mkdir(container, { recursive: true });
    const target = join(container, name);
    const branch = `gui/${name}`;
    await execFileP('git', ['-C', root, 'worktree', 'add', '-b', branch, target], { timeout: 30000 });
    res.json({ ok: true, path: target, branch, root });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/worktree?cwd=... → list worktrees + last commit + dirty file count */
router.get('/worktree', async (req, res) => {
  try {
    const cwd = safe(String(req.query.cwd || ''));
    const root = await findGitRoot(cwd);
    if (!root) return res.status(400).json({ error: 'not inside a git repo' });
    const out = await execFileP('git', ['-C', root, 'worktree', 'list', '--porcelain'], { timeout: 10000 });
    const trees = [];
    let cur = null;
    for (const line of out.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) trees.push(cur);
        cur = { path: line.slice(9), branch: null, head: null };
      } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
      else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
    if (cur) trees.push(cur);

    // Enrich each worktree with last-commit subject + timestamp + uncommitted change count.
    for (const t of trees) {
      try {
        const log = await execFileP('git', ['-C', t.path, 'log', '-1', '--format=%H%x09%ct%x09%s'], { timeout: 4000 });
        const [sha, ts, ...rest] = log.stdout.trim().split('\t');
        t.lastCommit = { sha, ts: Number(ts) * 1000, subject: rest.join('\t') };
      } catch {}
      try {
        const status = await execFileP('git', ['-C', t.path, 'status', '--porcelain'], { timeout: 4000 });
        t.dirtyFileCount = status.stdout.trim().split('\n').filter(Boolean).length;
      } catch { t.dirtyFileCount = 0; }
      t.isMain = t.path === root;
    }

    res.json({ root, trees });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/worktree  { cwd, path } */
router.delete('/worktree', async (req, res) => {
  try {
    const cwd = safe(req.body?.cwd || '');
    const wtPath = safe(req.body?.path || '');
    const root = await findGitRoot(cwd);
    if (!root) return res.status(400).json({ error: 'not inside a git repo' });
    if (wtPath === root) return res.status(400).json({ error: 'refusing to remove main worktree' });
    await execFileP('git', ['-C', root, 'worktree', 'remove', wtPath], { timeout: 15000 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
