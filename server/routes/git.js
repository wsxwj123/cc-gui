import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { stat } from 'fs/promises';
import { resolveWorkspacePath } from '../utils/safe-path.js';

const execFileP = promisify(execFile);
const router = Router();

function safeCwd(p) {
  // Normalize harmless `//+` / trailing slash inputs, but keep the HOME boundary
  // exact (`/Users/me2` must not pass for `/Users/me`).
  // 工作区例外版(fable 审计):Windows 项目常在 D:\ 等其他盘,严格 $HOME 门禁让
  // git status 400 → GitInitBanner 静默失效、git init 必炸(与 purge 同类)。
  // git -C 按文件系统身份工作,realpath 归一化形态无害。
  return resolveWorkspacePath(p, { label: 'cwd' });
}

/**
 * GET /api/git/status?cwd=... → { isRepo, root, branch, hasChanges, hasCommit }
 * `root` = 仓库根(`rev-parse --show-toplevel`)。cwd 是子文件夹时它与 cwd 不同,
 * 前端据此告诉用户"这个零提交仓库其实在上层哪个目录"。
 */
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
      // 在仓库里但一个提交都没有(git init 过、从没 commit):worktree 与基于 git 的
      // 回滚都要求至少一个提交,前端据此给「创建基线提交」按钮。此前这一态只在
      // 导入响应里出现一次,存量项目选中时横幅拿不到 → 没提示也没入口(Bug7)。
      // 这里已确认在仓库内(--show-toplevel 成功),HEAD 失败即无提交,不必再细分形态。
      let hasCommit = true;
      try {
        await execFileP('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 4000 });
      } catch { hasCommit = false; }
      res.json({ isRepo: true, root, branch, hasChanges, hasCommit });
    } catch (e) {
      // T3: 只有 git 明确说 "not a git repository" 才算 norepo。其他失败形态
      // (macOS TCC 拒 Desktop 等受保护目录:有时 stderr 带 "Operation not
      // permitted",有时进程被直接掐死 stderr 全空)一律不能误报成"不是 repo"——
      // 那会引导用户去 init(同因失败,且对已是 repo 的目录是误导)。
      const msg = String(e?.stderr || e?.message || '');
      if (/not a git repository|不是.*git\s*仓库/i.test(msg)) {
        return res.json({ isRepo: false });
      }
      if (e?.code === 'ENOENT') {
        // git 没装:之前静默(前端不挂横幅)→ 用户报"没装 git 时看不到任何 git 初始化提示"。
        // 改成显式上报 gitMissing,前端弹引导横幅(装了才能 init / 回滚)。
        return res.json({ isRepo: null, gitMissing: true });
      }
      if (e?.killed) {
        // 超时:信息不足,静默。
        return res.json({ isRepo: null });
      }
      res.json({ isRepo: null, permissionDenied: true });
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

    // Baseline commit phase. `add` may fail when the working tree contains
    // embedded git repos with no commits, or other corner cases. In that
    // scenario the user STILL has a usable git repo (init succeeded) — only
    // the baseline snapshot is missing. We surface a warning instead of a
    // 500 so the GUI stops nagging "not a git repo" forever.
    let committed = false, sha = null;
    let baselineWarning = null;
    const digest = (err) => (err?.killed ? '(超时)' : '') +
      String(err?.stderr || err?.message || '').split('\n')[0].slice(0, 200);
    if (commit) {
      try {
        // `-- .` 限定到 cwd 这棵子树。git ≥2.0 的 `add -A` 不带 pathspec = **整个工作树**:
        // 项目是巨型仓库的子文件夹时(兄弟项目 / node_modules / 嵌套仓库)会扫全树 →
        // 超时 → 基线永远建不出来(用户实测:按钮转几十秒后无效回弹),而且会把兄弟
        // 项目的文件一并提交进去。限定后提交只含项目文件夹自身内容。
        await execFileP('git', ['-C', cwd, 'add', '-A', '--', '.'], { timeout: 45000 });
      } catch (err) {
        baselineWarning = 'add 失败(目录可能过大,或含嵌入式 git 仓库):' + digest(err);
      }
    }
    if (commit && !baselineWarning) {
      try {
        let staged = false;
        try {
          await execFileP('git', ['-C', cwd, 'diff', '--cached', '--quiet'], { timeout: 4000 });
        } catch { staged = true; }
        let hasHead = true;
        try {
          await execFileP('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 4000 });
        } catch { hasHead = false; }
        // 没东西可提交(空文件夹 / 内容全被 .gitignore 挡掉)且仓库还没有 HEAD 时建空提交:
        // 基线的唯一要求是 HEAD 存在(worktree 与回滚探测都只看 HEAD)。此前这种情况直接
        // 静默返回 ok,HEAD 永远不出现 → 横幅永久循环(用户实测:空项目文件夹 + 上层零
        // 提交仓库)。已经有 HEAD 的仓库不造空提交,免得往正常历史里塞噪音。
        if (staged || !hasHead) {
          await execFileP('git', ['-C', cwd, 'commit', ...(staged ? [] : ['--allow-empty']), '-m', message], {
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
        }
      } catch (err) {
        baselineWarning = 'commit 失败:' + digest(err);
      }
    }

    res.json({ ok: true, already, committed, sha, baselineWarning });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
