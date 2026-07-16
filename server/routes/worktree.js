import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname, basename, resolve as pathResolve } from 'path';
import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { stat } from 'fs/promises';
import { isPathInside, resolveWorkspacePath } from '../utils/safe-path.js';

const execFileP = promisify(execFile);
const router = Router();

function safe(p) {
  // resolveWorkspacePath = $HOME 门禁 + 已知 claude 工作区例外(Windows 项目常在
  // D:\ 等其他盘,纯 $HOME 门禁让 worktree 功能在这类项目上整体不可用);../. 段仍拒。
  return resolveWorkspacePath(p, { requireCanonical: true });
}

async function findGitRoot(start) {
  let cwd = start;
  for (let i = 0; i < 24 && cwd !== '/'; i++) {
    try { await stat(join(cwd, '.git')); return cwd; } catch {}
    cwd = dirname(cwd);
  }
  return null;
}

// Windows 上 git 输出正斜杠/盘符小写与 Node 路径不一致,统一归一后再比较。
function normPath(p) {
  const r = pathResolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** 校验 query/body 里的 path 是本仓 `git worktree list` 登记的树。
 *  safe() 只挡 $HOME 外与 ../,白名单再收紧到"只能对本仓 worktree 执行 git",
 *  不开任意路径 git 执行口。校验失败已写响应,调用方拿到 null 直接 return。 */
async function requireWorktree(req, res) {
  const src = req.method === 'GET' ? req.query : (req.body || {});
  const cwd = safe(String(src.cwd || ''));
  const wtPath = safe(String(src.path || ''));
  const root = await findGitRoot(cwd);
  if (!root) { res.status(400).json({ error: 'not inside a git repo' }); return null; }
  const out = await execFileP('git', ['-C', root, 'worktree', 'list', '--porcelain'], { timeout: 10000 });
  const target = normPath(wtPath);
  const listed = out.stdout.split('\n')
    .some((l) => l.startsWith('worktree ') && normPath(l.slice(9)) === target);
  if (!listed) { res.status(400).json({ error: 'path is not a worktree of this repo' }); return null; }
  return { root, wtPath };
}

/** 该树的脏文件清单(porcelain -z 解析)。gitignored 文件天然不在 status 输出里,
 *  .local/.env 等私有文件不会出现在候选清单。导出供单测(tests/unit/check-worktree-git.mjs)。 */
export async function dirtyFiles(wtPath) {
  const out = await execFileP('git', ['-C', wtPath, 'status', '--porcelain=v1', '-z'],
    { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  const tokens = out.stdout.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.length < 4) continue; // "XY <path>" 至少 4 字符
    const status = tk.slice(0, 2);
    files.push({ file: tk.slice(3), status: status.trim() });
    if (status.includes('R') || status.includes('C')) {
      // rename/copy 后跟原路径 token,必须消费掉,否则会被误读成独立条目。
      // 实测(git 2.50,复现脚本见 tests/unit/check-worktree-git.mjs):R 不止出现
      // 在 X 位('R '/'RM'/'RD'),Y 位也会出现(' R',已跟踪文件 mv 后 `git add -N`
      // 新路径),两种形态都带原路径 token;R/C 只出现在 rename/copy 条目,
      // includes 匹配不会误伤其他状态('??' 等)。
      // 只有 rename 给旧路径补 D 条目(提交勾选时新旧路径一起提交,一次干净,
      // 不给下一次留一条悬空的删除);copy 的源文件仍然存在,记 D 是错的——
      // 勾选提交会把活文件当删除处理。origin 标记供 commit 路由把它排除出
      // `git add` 参数(旧路径已不在索引/工作区,add pathspec 会 fatal;
      // 而 `git commit -- <path>` 认 HEAD,可正常带上删除)。
      i++;
      const from = tokens[i];
      if (from && status.includes('R')) files.push({ file: from, status: 'D', origin: true });
    }
  }
  return files;
}

/** base ref 白名单(导出供单测):字符集收紧 + 拒首字符 '-'(execFile 数组传参
 *  本身不走 shell,这里挡的是 `-`/`--` 开头的 git flag 注入)。 */
export const isValidBaseRef = (s) =>
  typeof s === 'string' && s.length > 0 && !s.startsWith('-') && /^[A-Za-z0-9._/-]+$/.test(s);

/** POST /api/worktree  { cwd, name?, base? } → creates a sibling worktree
 *  base(可选):分支名或 commit,新建分支从它出发;缺省保持现状(当前 HEAD)。 */
router.post('/worktree', async (req, res) => {
  try {
    const cwd = safe(req.body?.cwd || '');
    let name = String(req.body?.name || `session-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-');
    // 全非 ASCII 名(如中文)会整体塌缩成 '---':与输入毫无关联,且第二个中文名
    // 撞车"分支已存在"。净化后不含任何字母数字 → 回落时间戳名。
    if (!/[a-zA-Z0-9]/.test(name)) name = `session-${Date.now()}`;
    const root = await findGitRoot(cwd);
    if (!root) return res.status(400).json({ error: 'not inside a git repo' });

    // 可选 base:白名单字符集 + rev-parse 验证确实指向一个 commit,两关都过才用。
    let base = null;
    if (req.body?.base) {
      const raw = String(req.body.base);
      if (!isValidBaseRef(raw)) return res.status(400).json({ error: `invalid base ref: ${raw}` });
      try {
        await execFileP('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${raw}^{commit}`], { timeout: 5000 });
      } catch {
        return res.status(400).json({ error: `base not found: ${raw}` });
      }
      base = raw;
    }

    // Collect all worktrees in a single `<repo名>-worktrees/` folder beside the
    // repo, instead of scattering loose sibling dirs (which landed on Desktop
    // when the repo sat directly under it). e.g. repo `/a/b/myrepo` →
    // worktree `/a/b/myrepo-worktrees/<name>`.
    const container = pathResolve(root, '..', `${basename(root)}-worktrees`);
    // Guard: HOME 内项目仍要求容器在 $HOME 内(防 repo 直接在 /Users 下时 parent
    // 逃出 HOME);HOME 外项目(已凭工作区例外过门禁,如 D:\proj)容器随项目走。
    if (isPathInside(root, homedir()) && !isPathInside(container, homedir())) {
      return res.status(400).json({ error: 'worktree container would fall outside $HOME' });
    }
    await mkdir(container, { recursive: true });
    const target = join(container, name);
    const branch = `gui/${name}`;
    // 分支可能已存在(删除 worktree 时明确承诺"分支保留",同名重建是常规操作):
    // 存在则检出已有分支,不存在才 -b 新建 —— 否则 git 报"分支已存在"500。
    let branchExists = false;
    try {
      await execFileP('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { timeout: 5000 });
      branchExists = true;
    } catch {}
    // 复用已有分支时 base 不适用(检出的是分支现有指向),忽略之;前端已有
    // reusedBranch 提示让用户知情。
    const addArgs = branchExists
      ? ['-C', root, 'worktree', 'add', target, branch]
      : ['-C', root, 'worktree', 'add', '-b', branch, target, ...(base ? [base] : [])];
    await execFileP('git', addArgs, { timeout: 30000 });
    res.json({ ok: true, path: target, branch, root, reusedBranch: branchExists, base });
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
      // 目录已被手动删除的"幽灵"worktree:git 标 prunable,选中进去开会话 spawn 必失败,
      // 前端据此标灰/只留删除。
      else if (cur && line.startsWith('prunable')) cur.prunable = true;
    }
    if (cur) trees.push(cur);

    // resolve 归一后再比:Windows 上 git porcelain 输出正斜杠(C:/Users/…)而 root
    // 是 Node 反斜杠路径,字符串直比恒 false → 主工作区丢"主"标签、误出删除按钮。
    // pathResolve 不归一盘符大小写:CLI cwd 常以小写盘符记录(d:\proj),仍会 false →
    // 该修复要防的原症状换个形态复发;故 win32 下再 toLowerCase 比较(normPath)。
    // 先算 isMain 才能拿到主分支名,供下方 aheadCount 用作基准。
    for (const t of trees) t.isMain = normPath(t.path) === normPath(root);
    const mainBranch = trees.find((t) => t.isMain)?.branch || null;

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
      // 领先计数:有 upstream 用 @{u}(口径=未推送);否则非主树相对主分支;
      // 都没有(主树无 upstream / detached 主分支)不给字段,前端不显示。
      try {
        let out = null, base = null, baseRef = null;
        try {
          out = await execFileP('git', ['-C', t.path, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 4000 });
          base = 'upstream'; baseRef = '@{u}';
        } catch {
          if (!t.isMain && mainBranch && t.branch !== mainBranch) {
            out = await execFileP('git', ['-C', t.path, 'rev-list', '--count', `refs/heads/${mainBranch}..HEAD`], { timeout: 4000 });
            base = mainBranch; baseRef = `refs/heads/${mainBranch}`;
          }
        }
        if (out) { t.aheadCount = parseInt(out.stdout.trim(), 10) || 0; t.aheadBase = base; }
        // 落后计数(非主树):基准与 aheadCount 同口径,反向 rev-list。失败只丢
        // behind 字段,不影响已写入的 aheadCount。
        if (out && !t.isMain) {
          try {
            const behind = await execFileP('git', ['-C', t.path, 'rev-list', '--count', `HEAD..${baseRef}`], { timeout: 4000 });
            t.behindCount = parseInt(behind.stdout.trim(), 10) || 0;
          } catch {}
        }
      } catch {}
    }

    // 本地分支列表(供"基于分支"新建下拉);取不到不影响主数据。
    let branches;
    try {
      const br = await execFileP('git', ['-C', root, 'branch', '--format=%(refname:short)'], { timeout: 4000 });
      branches = br.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {}

    res.json({ root, trees, branches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/worktree/commits?cwd=&path= → 相对基准领先的 commit 列表(点徽章展开时拉取)。
 *  base 解析:@{u} 存在用 upstream;否则主工作区分支;都没有退化为最近 20 条。 */
router.get('/worktree/commits', async (req, res) => {
  try {
    const ctx = await requireWorktree(req, res);
    if (!ctx) return;
    const { root, wtPath } = ctx;
    let range = null, base = null;
    try {
      await execFileP('git', ['-C', wtPath, 'rev-parse', '--verify', '--quiet', '@{u}'], { timeout: 4000 });
      range = '@{u}..HEAD'; base = 'upstream';
    } catch {
      if (normPath(wtPath) !== normPath(root)) {
        try {
          const r = await execFileP('git', ['-C', root, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeout: 4000 });
          const mainBranch = r.stdout.trim();
          if (mainBranch) { range = `refs/heads/${mainBranch}..HEAD`; base = mainBranch; }
        } catch {}
      }
    }
    const args = ['-C', wtPath, 'log', '--format=%H%x09%ct%x09%s'];
    if (range) args.push(range, '-n', '50');
    else args.push('-n', '20');
    const out = await execFileP('git', args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    const commits = out.stdout.split('\n').filter(Boolean).map((l) => {
      const [sha, ts, ...rest] = l.split('\t');
      return { sha, ts: Number(ts) * 1000, subject: rest.join('\t') };
    });
    res.json({ base, commits });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

/** GET /api/worktree/dirty?cwd=&path= → 脏文件清单(勾选提交的候选;不含 gitignored) */
router.get('/worktree/dirty', async (req, res) => {
  try {
    const ctx = await requireWorktree(req, res);
    if (!ctx) return;
    res.json({ files: await dirtyFiles(ctx.wtPath) });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

/** POST /api/worktree/commit  { cwd, path, files[], message } → 勾选的脏文件提交 */
router.post('/worktree/commit', async (req, res) => {
  try {
    const ctx = await requireWorktree(req, res);
    if (!ctx) return;
    const { wtPath } = ctx;
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'commit message required' });
    const files = req.body?.files;
    if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === 'string' && f)) {
      return res.status(400).json({ error: 'files must be a non-empty string array' });
    }
    // 白名单:每个文件必须在该树当前 porcelain 清单内 —— 挡 `:/`、`*`、../ 等
    // 任意 pathspec 注入;gitignored 文件不在清单里,天然无法被提交(且不提供 -f)。
    const dirtyList = await dirtyFiles(wtPath);
    const dirty = new Set(dirtyList.map((f) => f.file));
    for (const f of files) {
      if (!dirty.has(f)) return res.status(400).json({ error: `file not in dirty list: ${f}` });
    }
    // rename/copy 的旧路径(origin)不进 add:已不在索引/工作区,pathspec 无匹配会 fatal;
    // 删除侧本就 staged,靠下面 commit 的 pathspec(认 HEAD)带上即可。
    const origins = new Set(dirtyList.filter((f) => f.origin).map((f) => f.file));
    const addFiles = files.filter((f) => !origins.has(f));
    // `--` 隔断防选项注入;-A 限定 pathspec,同时覆盖删除/改名。
    if (addFiles.length) await execFileP('git', ['-C', wtPath, 'add', '-A', '--', ...addFiles], { timeout: 15000 });
    // commit 带 pathspec:只提交勾选路径,别处预先 staged 的文件不会被顺带带上。
    await execFileP('git', ['-C', wtPath, 'commit', '-m', message, '--', ...files], {
      timeout: 30000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'claude-gui',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'gui@claude',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'claude-gui',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'gui@claude',
      },
    });
    const rev = await execFileP('git', ['-C', wtPath, 'rev-parse', 'HEAD'], { timeout: 4000 });
    res.json({ ok: true, sha: rev.stdout.trim(), committed: files.length });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
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
    const args = ['-C', root, 'worktree', 'remove', wtPath];
    if (req.body?.force === true) args.push('--force'); // 删带未提交修改/未跟踪文件的工作树
    await execFileP('git', args, { timeout: 15000 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
