// worktree.js 服务端 git 逻辑单测:在临时目录造真 git 仓跑真命令断言。
// Run: node tests/unit/check-worktree-git.mjs
// 覆盖:porcelain rename/copy 变体解析(dirtyFiles)、merge 前置检查/冲突 abort
// (mergeWorktreeIntoMain)、base ref 白名单(isValidBaseRef)。
//
// rename 变体实测记录(git 2.50.0,本文件即复现脚本):
//   'R '  staged rename(git mv)            → "R  new\0old\0"
//   'RM'  staged rename 后又修改            → "RM new\0old\0"
//   'RD'  staged rename 后工作区删除        → "RD new\0old\0"
//   ' R'  Y 位 rename(mv 已跟踪文件 + git add -N 新路径) → " R new\0old\0"
//   'C '  staged copy(需 status.renames=copies 且源文件同时被修改)→ "C  new\0src\0"
//   未复现出 Y 位 C;单纯 rm+新建(不 add)只给 " D"+"??",无 R 条目。
// 所有 R/C 条目都带原路径 token,解析必须消费它;只有 R 才补 origin 的 D 条目。
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, renameSync, rmSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirtyFiles, mergeWorktreeIntoMain, isValidBaseRef } from '../../server/routes/worktree.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const roots = [];
function makeRepo() {
  // realpath:mac 的 tmpdir 是 symlink(/var→/private/var),git porcelain 记 realpath,
  // 不解开会让 normPath 匹配不上 worktree 路径。
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-wt-test-')));
  roots.push(dir);
  git(dir, 'init', '-q', '-b', 'main', '.');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'content-A-long-enough-for-rename-detect-1234567890\n');
  writeFileSync(join(dir, 'b.txt'), 'other\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}
const byFile = (files, f) => files.find((x) => x.file === f);

// ── 1. staged rename 'R ':新路径 R 条目 + 旧路径 origin D 条目 ──
{
  const dir = makeRepo();
  git(dir, 'mv', 'a.txt', 'a2.txt');
  const files = await dirtyFiles(dir);
  assert.deepStrictEqual(byFile(files, 'a2.txt'), { file: 'a2.txt', status: 'R' });
  assert.deepStrictEqual(byFile(files, 'a.txt'), { file: 'a.txt', status: 'D', origin: true });
  assert.strictEqual(files.length, 2, `R : 应恰好 2 条,得到 ${JSON.stringify(files)}`);
}

// ── 2. 'RM' rename 后又修改:同样 2 条,状态 RM ──
{
  const dir = makeRepo();
  git(dir, 'mv', 'a.txt', 'a2.txt');
  appendFileSync(join(dir, 'a2.txt'), 'extra\n');
  const files = await dirtyFiles(dir);
  assert.strictEqual(byFile(files, 'a2.txt')?.status, 'RM');
  assert.ok(byFile(files, 'a.txt')?.origin, 'RM: 旧路径应有 origin D 条目');
  assert.strictEqual(files.length, 2);
}

// ── 3. Y 位 rename ' R'(mv + add -N):旧路径 token 必须被消费,且补 origin D ──
{
  const dir = makeRepo();
  renameSync(join(dir, 'a.txt'), join(dir, 'a3.txt'));
  git(dir, 'add', '-N', 'a3.txt');
  // 自证前提:porcelain 确实输出 Y 位 R(git 版本若不产出该形态,这里直接暴露)
  const raw = git(dir, 'status', '--porcelain=v1', '-z');
  assert.ok(raw.startsWith(' R a3.txt\0a.txt\0'), `前提失败:porcelain 输出 ${JSON.stringify(raw)}`);
  const files = await dirtyFiles(dir);
  assert.deepStrictEqual(byFile(files, 'a3.txt'), { file: 'a3.txt', status: 'R' }); // trim 后 ' R'→'R'
  assert.deepStrictEqual(byFile(files, 'a.txt'), { file: 'a.txt', status: 'D', origin: true });
  assert.strictEqual(files.length, 2, `' R': 旧路径 token 未消费会多出伪条目: ${JSON.stringify(files)}`);
}

// ── 4. copy 'C ':源文件仍存在,不得补 D 条目;token 正常消费 ──
{
  const dir = makeRepo();
  git(dir, 'config', 'status.renames', 'copies');
  writeFileSync(join(dir, 'acopy.txt'), 'content-A-long-enough-for-rename-detect-1234567890\n');
  appendFileSync(join(dir, 'a.txt'), 'modify-source\n');
  git(dir, 'add', '-A');
  const raw = git(dir, 'status', '--porcelain=v1', '-z');
  assert.ok(raw.includes('C  acopy.txt\0a.txt\0'), `前提失败:copy 未被检测,porcelain=${JSON.stringify(raw)}`);
  const files = await dirtyFiles(dir);
  assert.strictEqual(byFile(files, 'acopy.txt')?.status, 'C');
  const src = byFile(files, 'a.txt');
  assert.strictEqual(src?.status, 'M', `copy 源文件应是 M(被修改)而不是 D: ${JSON.stringify(src)}`);
  assert.ok(!src?.origin, 'copy 源文件不得标 origin');
  assert.strictEqual(files.length, 2);
}

// ── 5. merge 成功路径:worktree 分支 1 个提交合回 main,摘要正确 ──
{
  const dir = makeRepo();
  const wt = dir + '-wt-feature'; roots.push(wt); // 兄弟目录,单独清理
  git(dir, 'worktree', 'add', '-q', '-b', 'gui/feat', wt);
  writeFileSync(join(wt, 'new.txt'), 'from-feature\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'feat commit');
  const r = await mergeWorktreeIntoMain(dir, wt);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.branch, 'gui/feat');
  assert.strictEqual(r.targetBranch, 'main');
  assert.strictEqual(r.mergedCommits, 1);
  assert.ok(existsSync(join(dir, 'new.txt')), 'merge 后主树应有 worktree 的文件');
  assert.strictEqual(git(dir, 'status', '--porcelain').trim(), '', 'merge 后主树应干净');
}

// ── 6. merge 冲突:返回冲突清单 + 自动 abort 不留半合并状态 ──
{
  const dir = makeRepo();
  const wt = dir + '-wt-conflict'; roots.push(wt); // 兄弟目录,单独清理
  git(dir, 'worktree', 'add', '-q', '-b', 'gui/conflict', wt);
  writeFileSync(join(wt, 'b.txt'), 'worktree-side\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'wt edit');
  writeFileSync(join(dir, 'b.txt'), 'main-side\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'main edit');
  const r = await mergeWorktreeIntoMain(dir, wt);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.conflicts, ['b.txt']);
  // 半合并状态检查:MERGE_HEAD 不存在、工作区干净、b.txt 回到 main 侧内容
  assert.ok(!existsSync(join(dir, '.git', 'MERGE_HEAD')), '必须已 merge --abort');
  assert.strictEqual(git(dir, 'status', '--porcelain').trim(), '', 'abort 后主树应干净');
}

// ── 7. merge 前置:主树脏 → 拒绝(statusCode 409),且不动任何东西 ──
{
  const dir = makeRepo();
  const wt = dir + '-wt-x'; roots.push(wt); // 兄弟目录,单独清理
  git(dir, 'worktree', 'add', '-q', '-b', 'gui/x', wt);
  writeFileSync(join(wt, 'new.txt'), 'x\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'x');
  writeFileSync(join(dir, 'dirty.txt'), 'uncommitted\n');
  await assert.rejects(() => mergeWorktreeIntoMain(dir, wt), (e) => {
    assert.strictEqual(e.statusCode, 409);
    assert.ok(/未提交/.test(e.message));
    return true;
  });
  assert.ok(!existsSync(join(dir, 'new.txt')), '拒绝后不得发生合并');
}

// ── 8. merge:detached worktree(无分支)→ 400 ──
{
  const dir = makeRepo();
  const wt = dir + '-wt-detached'; roots.push(wt); // 兄弟目录,单独清理
  git(dir, 'worktree', 'add', '-q', '--detach', wt);
  await assert.rejects(() => mergeWorktreeIntoMain(dir, wt), (e) => e.statusCode === 400);
}

// ── 9. merge:该树自身脏 → 携带 warning 但不阻断 ──
{
  const dir = makeRepo();
  const wt = dir + '-wt-dirty'; roots.push(wt); // 兄弟目录,单独清理
  git(dir, 'worktree', 'add', '-q', '-b', 'gui/dirty', wt);
  writeFileSync(join(wt, 'new.txt'), 'y\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'y');
  writeFileSync(join(wt, 'uncommitted.txt'), 'z\n');
  const r = await mergeWorktreeIntoMain(dir, wt);
  assert.strictEqual(r.ok, true);
  assert.ok(/未提交/.test(r.warning || ''), `应有脏树 warning: ${r.warning}`);
}

// ── 10. base ref 白名单 ──
assert.strictEqual(isValidBaseRef('main'), true);
assert.strictEqual(isValidBaseRef('feature/x-1.2'), true);
assert.strictEqual(isValidBaseRef('abc1234'), true);
assert.strictEqual(isValidBaseRef('-rf'), false);       // flag 注入
assert.strictEqual(isValidBaseRef('--force'), false);
assert.strictEqual(isValidBaseRef('a;b'), false);       // 非法字符
assert.strictEqual(isValidBaseRef('a b'), false);
assert.strictEqual(isValidBaseRef(''), false);
assert.strictEqual(isValidBaseRef(null), false);

for (const d of roots) rmSync(d, { recursive: true, force: true });
console.log('check-worktree-git OK — rename/copy 解析、merge 前置/冲突 abort、base 白名单全部通过');
