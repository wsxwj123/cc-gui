import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, resolve as resolvePath, sep } from 'path';
import { homedir } from 'os';
import { stat, mkdir, readFile, writeFile, rm, access } from 'fs/promises';
import { resolveWorkspacePath } from '../utils/safe-path.js';

const execFileP = promisify(execFile);
const router = Router();

// Checkpoints are stored as a shadow git index under ~/.claude/gui/checkpoints/<sessionId>/
// (a separate worktree-like directory keyed off GIT_DIR). We don't touch the
// user's real repo history; restores happen via `git --work-tree=<cwd> --git-dir=<shadow>
// checkout <sha> -- .` so the user's index/branch/staging is untouched.
const CHECKPOINTS_ROOT = join(homedir(), '.claude', 'gui', 'checkpoints');

function safe(p) {
  // Canonicalize `//+` and trailing `/` rather than reject — legacy project
  // dirs decode to non-canonical paths but are still valid.
  // resolveWorkspacePath = $HOME 门禁 + 已知 claude 工作区例外(Windows 项目在
  // D:\ 等其他盘、mac /tmp 下的会话文件,纯 $HOME 门禁让回滚报 outside $HOME)。
  return resolveWorkspacePath(p);
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
  // cwd 必须是 workTree:`checkout <sha> -- .` 的 `.` pathspec 相对 git 进程 cwd 解析,
  // 不设就落在 server 自己的目录(work-tree 之外)→ "pathspec '.' did not match"
  // (用户在无文件改动的消息上回滚时的还原失败根因)。
  return execFileP('git', ['--git-dir', gitDir, '--work-tree', workTree, ...args],
    { timeout: 30000, cwd: workTree, ...opts });
}

async function loadMeta(sessionId) {
  const d = await shadowDir(sessionId);
  try {
    const raw = await readFile(join(d, 'meta.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function saveMeta(sessionId, entries) {
  const d = await shadowDir(sessionId);
  await writeFile(join(d, 'meta.json'), JSON.stringify({ entries: entries.slice(-500) }, null, 2));
}

function parseMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

function textPrefix(value) {
  return String(value || '').slice(0, 60);
}

async function listTreeFiles(sessionId, workTree, sha) {
  const out = await gitShadow(['ls-tree', '-r', '--name-only', sha], sessionId, workTree);
  return out.stdout.trim().split('\n').filter(Boolean);
}

async function removeWorktreePath(workTree, rel) {
  if (!rel || rel.includes('\0') || rel.startsWith('../') || rel === '..') return;
  const root = resolvePath(workTree);
  const abs = resolvePath(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return;
  await rm(abs, { force: true, recursive: true });
}

function relativeToWorkTree(workTree, file) {
  const root = resolvePath(workTree);
  const abs = resolvePath(file);
  if (abs === root || !abs.startsWith(root + sep)) throw new Error('file outside cwd');
  return abs.slice(root.length + 1);
}

async function fileExists(file) {
  try { await access(file); return true; }
  catch { return false; }
}

/** POST /api/checkpoints  { sessionId, cwd, label } */
router.post('/checkpoints', async (req, res) => {
  try {
    const { sessionId, cwd, label, clientMessageId, messageTimestamp, promptPreview } = req.body || {};
    assertSession(sessionId);
    const workTree = safe(cwd);
    await gitShadow(['add', '-A'], sessionId, workTree);
    try {
      await gitShadow(
        ['commit', '--allow-empty', '-m', label || `checkpoint ${new Date().toISOString()}`],
        sessionId, workTree,
        { env: { ...process.env, GIT_AUTHOR_NAME: 'claude-gui', GIT_AUTHOR_EMAIL: 'gui@claude', GIT_COMMITTER_NAME: 'claude-gui', GIT_COMMITTER_EMAIL: 'gui@claude' } },
      );
      const rev = await gitShadow(['rev-parse', 'HEAD'], sessionId, workTree);
      const sha = rev.stdout.trim();
      const entries = await loadMeta(sessionId);
      entries.push({
        sha,
        ts: Date.now(),
        label: label || '',
        cwd: workTree,
        clientMessageId: String(clientMessageId || ''),
        messageTimestamp: parseMs(messageTimestamp),
        promptPreview: textPrefix(promptPreview || label || ''),
      });
      await saveMeta(sessionId, entries);
      res.json({ ok: true, sha });
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

/** GET /api/checkpoints/:sessionId/resolve?timestamp=&text= */
router.get('/checkpoints/:sessionId/resolve', async (req, res) => {
  try {
    assertSession(req.params.sessionId);
    const targetTs = parseMs(req.query.timestamp);
    const prefix = textPrefix(req.query.text);
    const before = req.query.before === 'true';
    const meta = await loadMeta(req.params.sessionId);
    const scored = meta
      .filter((e) => e.sha && /^[a-f0-9]{7,40}$/.test(e.sha))
      .map((e) => {
        const sameText = !prefix || !e.promptPreview || prefix.startsWith(e.promptPreview) || e.promptPreview.startsWith(prefix);
        const baseTs = e.messageTimestamp || e.ts || 0;
        if (before && targetTs && baseTs > targetTs) return null;
        const delta = targetTs ? (before ? targetTs - baseTs : Math.abs(baseTs - targetTs)) : 0;
        return { entry: e, score: (sameText ? 0 : 1000000000) + delta };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);
    const best = scored[0];
    if (best && best.score < 1000000000 + (before ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000)) {
      return res.json({ sha: best.entry.sha, source: 'meta' });
    }

    const gitDir = await shadowDir(req.params.sessionId);
    const out = await execFileP('git', ['--git-dir', gitDir, 'log', '--format=%H%x09%ct%x09%s'],
      { timeout: 10000 });
    const fallback = out.stdout.trim().split('\n').filter(Boolean)
      .map((line) => {
        const [sha, ts, ...rest] = line.split('\t');
        const label = rest.join('\t');
        const sameText = !prefix || label.includes(prefix);
        const baseTs = Number(ts) * 1000;
        if (before && targetTs && baseTs > targetTs) return null;
        const delta = targetTs ? (before ? targetTs - baseTs : Math.abs(baseTs - targetTs)) : 0;
        return { sha, score: (sameText ? 0 : 1000000000) + delta };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)[0];
    if (fallback && fallback.score < 1000000000 + (before ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000)) {
      return res.json({ sha: fallback.sha, source: 'log' });
    }
    res.status(404).json({ error: 'checkpoint not found' });
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
    const headFiles = await listTreeFiles(req.params.sessionId, workTree, 'HEAD').catch(() => []);
    const targetFiles = await listTreeFiles(req.params.sessionId, workTree, sha);
    const targetSet = new Set(targetFiles);
    await gitShadow(['checkout', sha, '--', '.'], req.params.sessionId, workTree);
    for (const rel of headFiles) {
      if (!targetSet.has(rel)) await removeWorktreePath(workTree, rel);
    }
    // 不再 `git clean -fd`:未跟踪文件(用户手工建的 notes.txt 等)不属 shadow git 管辖,
    // 清掉会丢用户数据。已跟踪文件的删除由上面的 removeWorktreePath 循环处理。
    res.json({ ok: true, removedSinceCheckpoint: headFiles.filter((rel) => !targetSet.has(rel)).length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/checkpoints/:sessionId/restore-file  { sha, cwd, file } */
router.post('/checkpoints/:sessionId/restore-file', async (req, res) => {
  try {
    assertSession(req.params.sessionId);
    const { sha, cwd, file } = req.body || {};
    if (!/^[a-f0-9]{7,40}$/.test(String(sha || ''))) throw new Error('invalid sha');
    const workTree = safe(cwd);
    const absFile = safe(file);
    const rel = relativeToWorkTree(workTree, absFile);
    const targetFiles = await listTreeFiles(req.params.sessionId, workTree, sha);
    if (!targetFiles.includes(rel)) {
      if (await fileExists(absFile)) await removeWorktreePath(workTree, rel);
      return res.json({ ok: true, deleted: true });
    }
    await gitShadow(['checkout', sha, '--', rel], req.params.sessionId, workTree);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
