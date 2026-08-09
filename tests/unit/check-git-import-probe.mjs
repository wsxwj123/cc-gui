// Bug7:导入 git 仓库的子文件夹被提示"不是 git 仓库",且没有任何初始化入口。
// 根因 = 导入检查只跑 `git rev-parse HEAD` + 裸 catch:零提交仓库、git 没装、TCC 拒读、
// dubious ownership 全被归成"不是 git 仓库",而横幅走 --show-toplevel(在仓库里就隐藏),
// 于是"零提交仓库(含其子目录)"= 弹误导提示 + 无出路。
// 修法 = classifyGitProbe 三态(repoNoCommit / notRepo / gitCheckFailed),前端按态给按钮;
// 存量(早已导入过的)项目靠 GET /api/git/status 的 hasCommit 字段判零提交(§6)。
// Run: node tests/unit/check-git-import-probe.mjs
//
// 判定输入是真 git 跑出来的错误对象(本文件在 tmpdir 真建仓真跑命令),不是手写 stderr。
// 实测形态(git 2.50,中文本地化环境):
//   零提交仓库   HEAD → code 128 "致命错误：有歧义的参数 'HEAD'…" / --is-inside-work-tree 成功
//   非仓库目录   两条都 code 128 "致命错误：不是 git 仓库（或者任何父目录）：.git"
//   git 没装     两条都 code 'ENOENT',stderr 空
// 只有 dubious ownership / timeout 没法在单测里真造,单独用最小对象覆盖分支。
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGitProbe } from '../../server/routes/settings.js';

const execFileP = promisify(execFile);
const roots = [];
function mkdir_(...seg) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-gitimport-')));
  roots.push(dir);
  for (const s of seg) mkdirSync(join(dir, s), { recursive: true });
  return dir;
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });

// 复刻 settings.js 的探测顺序:HEAD 成功即 ok,失败才补 --is-inside-work-tree。
async function probe(dir, bin = 'git') {
  let headErr = null, insideErr = null;
  try {
    await execFileP(bin, ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 4000 });
  } catch (err) { headErr = err; }
  if (headErr) {
    try {
      await execFileP(bin, ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeout: 4000 });
    } catch (err) { insideErr = err; }
  }
  return classifyGitProbe({ headErr, insideErr });
}

try {
  // ── 1. 有提交的仓库:根与子目录都是 ok(子目录本来就不该报错,锁定不回归)──
  {
    const dir = mkdir_('sub/deep');
    git(dir, 'init', '-q', '-b', 'main', '.');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    assert.deepEqual(await probe(dir), { gitState: 'ok' }, '有提交的仓库根 = ok');
    assert.deepEqual(await probe(join(dir, 'sub')), { gitState: 'ok' }, '有提交仓库的子目录 = ok(不弹任何提示)');
    assert.deepEqual(await probe(join(dir, 'sub/deep')), { gitState: 'ok' }, '孙目录同样 ok');
  }

  // ── 2. 零提交仓库:根与子目录都是 repoNoCommit,不得说成"不是仓库"(Bug7 主场景)──
  {
    const dir = mkdir_('sub');
    git(dir, 'init', '-q', '-b', 'main', '.');
    assert.deepEqual(await probe(dir), { gitState: 'repoNoCommit' }, '零提交仓库根 = repoNoCommit');
    assert.deepEqual(await probe(join(dir, 'sub')), { gitState: 'repoNoCommit' }, '零提交仓库的子文件夹 = repoNoCommit(旧实现在这里误报 notRepo)');
  }

  // ── 3. 真非仓库目录:notRepo(横幅给"立即初始化")──
  {
    const dir = mkdir_('sub');
    assert.deepEqual(await probe(dir), { gitState: 'notRepo' }, '非仓库目录 = notRepo');
    assert.deepEqual(await probe(join(dir, 'sub')), { gitState: 'notRepo' }, '非仓库目录的子目录 = notRepo');
  }

  // ── 4. git 调用失败:一律 gitCheckFailed,绝不冒称"不是仓库"──
  {
    const dir = mkdir_();
    git(dir, 'init', '-q', '-b', 'main', '.');  // 真仓库,只是 git 拿不到
    const r = await probe(dir, 'cgui-git-does-not-exist');
    assert.deepEqual(r, { gitState: 'gitCheckFailed', gitCheckReason: 'gitMissing' }, 'git 没装(ENOENT)= gitCheckFailed');
  }
  // 超时 / dubious ownership 造不出真环境,用与真形态一致的最小对象覆盖分支:
  // 超时的 execFile 错误带 killed:true;ownership 的 git 输出见 git 源码 setup.c。
  assert.deepEqual(
    classifyGitProbe({ headErr: { killed: true }, insideErr: { killed: true, stderr: '' } }),
    { gitState: 'gitCheckFailed', gitCheckReason: 'timeout' },
    '超时 = gitCheckFailed(timeout)',
  );
  assert.deepEqual(
    classifyGitProbe({
      headErr: { code: 128 },
      insideErr: { code: 128, stderr: "fatal: detected dubious ownership in repository at '/x'" },
    }),
    { gitState: 'gitCheckFailed', gitCheckReason: 'ownership' },
    'dubious ownership = gitCheckFailed(ownership),不是 notRepo',
  );
  {
    const r = classifyGitProbe({ headErr: { code: 128 }, insideErr: { code: 128, stderr: 'fatal: Operation not permitted\n第二行' } });
    assert.equal(r.gitState, 'gitCheckFailed', 'TCC/其他失败 = gitCheckFailed');
    assert.equal(r.gitCheckReason, 'other');
    assert.equal(r.gitCheckDetail, 'fatal: Operation not permitted', '未知失败带首行原文,便于如实告知');
  }

  // ── 5. 英文环境的 notRepo 文案同样命中(CI/非中文 locale)──
  assert.equal(
    classifyGitProbe({ headErr: { code: 128 }, insideErr: { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' } }).gitState,
    'notRepo',
    '英文 not a git repository 命中 notRepo',
  );
  assert.equal(
    classifyGitProbe({ headErr: { code: 128 }, insideErr: { code: 128, stderr: '致命错误：不是 git 仓库（或者任何父目录）：.git' } }).gitState,
    'notRepo',
    '中文本地化输出命中 notRepo(git 2.50 实测形态)',
  );

  // ── 6. GET /api/git/status 的 hasCommit ──
  // 存量(早已导入过的)项目只有这一个数据源:导入响应的 gitState 是一次性的,
  // 前端内存 Map 刷新即丢。零提交 → hasCommit:false,横幅才有「创建基线提交」。
  // 直接调路由 handler(同 check-remote-control-gate 的做法);safeCwd 只放行
  // $HOME 内路径,所以夹具建在临时 HOME 里(git.js 在请求时才读 homedir())。
  {
    const realHome = process.env.HOME, realProfile = process.env.USERPROFILE;
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-gitstatus-home-')));
    roots.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const gitRouter = (await import('../../server/routes/git.js')).default;
      const layer = gitRouter.stack.find((l) => l.route?.path === '/git/status' && l.route.methods?.get);
      assert.ok(layer, 'GET /git/status 路由不见了(改路径了就同步这条断言)');
      const handler = layer.route.stack[0].handle;
      const status = async (cwd) => {
        let body = null;
        await handler({ query: { cwd } }, { status() { return this; }, json(p) { body = p; return this; } }, () => {});
        return body;
      };

      const withCommit = join(home, 'withcommit');
      mkdirSync(join(withCommit, 'sub'), { recursive: true });
      git(withCommit, 'init', '-q', '-b', 'main', '.');
      git(withCommit, 'config', 'user.email', 't@t');
      git(withCommit, 'config', 'user.name', 't');
      writeFileSync(join(withCommit, 'a.txt'), 'a\n');
      git(withCommit, 'add', '-A');
      git(withCommit, 'commit', '-qm', 'init');
      assert.deepEqual(
        { isRepo: (await status(withCommit)).isRepo, hasCommit: (await status(withCommit)).hasCommit },
        { isRepo: true, hasCommit: true },
        '有提交的仓库 = hasCommit:true(横幅保持隐藏)',
      );
      assert.equal((await status(join(withCommit, 'sub'))).hasCommit, true, '有提交仓库的子目录同样 hasCommit:true');

      const zero = join(home, 'zerocommit');
      mkdirSync(join(zero, 'sub'), { recursive: true });
      git(zero, 'init', '-q', '-b', 'main', '.');
      const zeroBody = await status(zero);
      assert.equal(zeroBody.isRepo, true, '零提交仓库仍然 isRepo:true(所以只靠 isRepo 判不出来)');
      assert.equal(zeroBody.hasCommit, false, '零提交仓库 = hasCommit:false ← 存量项目横幅的唯一依据');
      assert.equal((await status(join(zero, 'sub'))).hasCommit, false, '零提交仓库的子文件夹同样 hasCommit:false(用户实报场景)');

      const plain = join(home, 'plain');
      mkdirSync(plain, { recursive: true });
      const plainBody = await status(plain);
      assert.equal(plainBody.isRepo, false, '非仓库目录 isRepo:false');
      assert.equal('hasCommit' in plainBody, false, '非仓库目录不带 hasCommit 字段(前端 === false 才算数,不得误命中 nocommit)');
    } finally {
      process.env.HOME = realHome;
      if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
    }
  }

  console.log('OK check-git-import-probe');
} finally {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
}
