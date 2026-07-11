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
  // maxBuffer 32MB:默认 1MB 会让大仓库(2 万+ 文件)的 ls-tree/首次 commit 输出超限
  // 抛错 —— commit 实际已完成但请求报 500,meta 与 git log 漂移。timeout 60s 同理。
  // LC_ALL=C 固定英文错误输出:错误分类靠 regex 匹配英文串(pathspec did not match
  // 等),中文/其它 locale 下 git 输出本地化会让匹配全失效 → 空快照误判 restore_failed。
  return execFileP('git', ['--git-dir', gitDir, '--work-tree', workTree, ...args],
    { timeout: 60000, cwd: workTree, maxBuffer: 32 * 1024 * 1024, ...opts,
      env: { ...process.env, LC_ALL: 'C', ...(opts.env || {}) } });
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

// commit message 用的 label:换行塌成空格 —— git log %s 只取首行,多行 label 会让
// resolve 的 git-log 回落路径文本匹配失效(退化成纯时间窗)。
function oneLineLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
  // 嵌套 git 仓库保护:shadow 快照里 gitlink 无内容,rm 掉整个子仓库(含未推送
  // 提交)后无法从快照重建 —— 原生 git checkout 会拒删嵌套 .git,这里对齐。
  try {
    await stat(join(abs, '.git'));
    console.warn('[checkpoints] skip removing embedded git repo:', abs);
    return;
  } catch { /* 无 .git → 正常删除 */ }
  await rm(abs, { force: true, recursive: true });
}

function relativeToWorkTree(workTree, file) {
  const root = resolvePath(workTree);
  const abs = resolvePath(file);
  if (abs === root || !abs.startsWith(root + sep)) throw new Error('file outside cwd');
  // 统一正斜杠:git ls-tree 输出恒为 `/` 分隔,Windows 上 resolve 产出 `\` —— 直接
  // 比较 targetFiles.includes(rel) 必 false,会把要还原的文件误判为"快照中没有"。
  return abs.slice(root.length + 1).split(sep).join('/');
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
        ['commit', '--allow-empty', '-q', '-m', oneLineLabel(label) || `checkpoint ${new Date().toISOString()}`],
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
    // meta.json 优先:messageTimestamp 是消息落盘口径,与会话裁剪(trim fromTimestamp)
    // 同源;git commit ct 是"add -A 完成后"的秒级时间,大仓下晚数秒 → 面板 restore 按
    // ct 裁剪会少裁一段(或竞态反向把触发消息裁掉)。meta 为空才回落 git log。
    const meta = await loadMeta(req.params.sessionId);
    if (meta.length) {
      const entries = meta
        .filter((e) => e.sha)
        .map((e) => ({ sha: e.sha, ts: e.messageTimestamp || e.ts, label: e.label || e.promptPreview || '' }))
        .reverse();
      return res.json({ entries });
    }
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
    // pre-restore 快照:shadow HEAD 停留在"发消息前"的 checkpoint,AI 之后新建的
    // 文件从未进过 shadow → 不在 headFiles 差集里,回滚后会残留。先把当前真实状态
    // commit 进 shadow(顺带留下一份可 redo 的快照),再算差集。失败不阻断主流程。
    try {
      await gitShadow(['add', '-A'], req.params.sessionId, workTree);
      await gitShadow(['commit', '--allow-empty', '-q', '-m', `pre-restore ${new Date().toISOString()}`],
        req.params.sessionId, workTree,
        { env: { ...process.env, GIT_AUTHOR_NAME: 'claude-gui', GIT_AUTHOR_EMAIL: 'gui@claude', GIT_COMMITTER_NAME: 'claude-gui', GIT_COMMITTER_EMAIL: 'gui@claude' } });
    } catch { /* 快照失败(嵌入式仓库等)→ 退回旧行为:新增文件可能残留 */ }
    const headFiles = await listTreeFiles(req.params.sessionId, workTree, 'HEAD').catch(() => []);
    const targetFiles = await listTreeFiles(req.params.sessionId, workTree, sha);
    const targetSet = new Set(targetFiles);
    // 空树快照:`checkout <sha> -- .` 会抛 pathspec 错,让下面的删除循环整个跳过 →
    // AI 新建文件全残留(用户报"回滚了但文件没动")。空树时不 checkout,只跑删除循环。
    if (targetFiles.length > 0) {
      await gitShadow(['checkout', sha, '--', '.'], req.params.sessionId, workTree);
    }
    for (const rel of headFiles) {
      if (!targetSet.has(rel)) await removeWorktreePath(workTree, rel);
    }
    // 不再 `git clean -fd`:未跟踪文件(用户手工建的 notes.txt 等)不属 shadow git 管辖,
    // 清掉会丢用户数据。已跟踪文件的删除由上面的 removeWorktreePath 循环处理。
    res.json({ ok: true, removedSinceCheckpoint: headFiles.filter((rel) => !targetSet.has(rel)).length });
  } catch (err) {
    // 区分"快照本身没文件"(pathspec 不匹配,工作区确实未动)、快照对象不存在(bad
    // object,文件一字未动)与其他失败(超时把 checkout 杀在半路=可能部分还原)。
    const msg = err.message || '';
    let code = 'restore_failed';
    if (/pathspec .* did not match/.test(msg)) code = 'empty_checkpoint';
    else if (/bad object|not a valid object|Not a valid object name/i.test(msg)) code = 'missing_snapshot';
    res.status(400).json({ error: msg, code });
  }
});

/** POST /api/checkpoints/:sessionId/restore-file  { sha, cwd, file, allowDelete } */
router.post('/checkpoints/:sessionId/restore-file', async (req, res) => {
  try {
    assertSession(req.params.sessionId);
    const { sha, cwd, file, allowDelete } = req.body || {};
    if (!/^[a-f0-9]{7,40}$/.test(String(sha || ''))) throw new Error('invalid sha');
    const workTree = safe(cwd);
    const absFile = safe(file);
    const rel = relativeToWorkTree(workTree, absFile);
    const targetFiles = await listTreeFiles(req.params.sessionId, workTree, sha);
    if (!targetFiles.includes(rel)) {
      // "快照里没有此文件"≠"该删除":shadow git 的 add -A 尊重 .gitignore,被
      // ignore 的文件(CLAUDE.local.md 等)永远不进快照——无条件删除等于把一次
      // "恢复"变成销毁(且 UI 报成功)。只有调用方显式声明(write 类=本轮新建)
      // 才允许走删除分支,否则 404 让前端如实报"快照中无此文件"。
      if (allowDelete !== true) {
        return res.status(404).json({ error: '该文件不在此快照中(可能被 .gitignore 排除),已保持原样' });
      }
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
