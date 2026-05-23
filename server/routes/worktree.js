import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname, resolve as pathResolve } from 'path';
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

    const target = pathResolve(root, '..', `${name}`);
    const branch = `gui/${name}`;
    await execFileP('git', ['-C', root, 'worktree', 'add', '-b', branch, target], { timeout: 30000 });
    res.json({ ok: true, path: target, branch, root });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/worktree?cwd=... → list worktrees of the enclosing repo */
router.get('/worktree', async (req, res) => {
  try {
    const cwd = safe(String(req.query.cwd || ''));
    const root = await findGitRoot(cwd);
    if (!root) return res.status(400).json({ error: 'not inside a git repo' });
    const out = await execFileP('git', ['-C', root, 'worktree', 'list', '--porcelain'], { timeout: 10000 });
    const trees = [];
    let cur = null;
    for (const line of out.stdout.split('\n')) {
      if (line.startsWith('worktree ')) { if (cur) trees.push(cur); cur = { path: line.slice(9), branch: null, head: null }; }
      else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
      else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
    if (cur) trees.push(cur);
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
