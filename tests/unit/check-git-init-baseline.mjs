// 用户实测打回:点「创建基线提交/立即初始化」转几十秒 → 无效回弹 → 循环。
// 真机取证:项目 ~/Desktop/claude/博士后面上 是空文件夹(0 文件),其上层 ~/Desktop/claude
// 是个零提交仓库(5 月被意外 init)。缺陷链两条都在 /api/git/init:
//   缺陷1 `add -A` 不带 pathspec:git≥2.0 从子目录跑 = 整个工作树 → 巨型父仓库扫全树
//         → 15s 超时 → baselineWarning → 没提交;而且会把兄弟项目一起提交进去。
//   缺陷2 `diff --cached --quiet` 判"没东西可提交"就静默返回 ok → 空文件夹永远没有
//         HEAD → 横幅永久循环。
// 修法:`add -A -- .`(限定 cwd 子树)+ 超时 45s;没东西可提交且仓库还没 HEAD 时
//       `commit --allow-empty`(基线只要求 HEAD 存在)。
// Run: node tests/unit/check-git-init-baseline.mjs
//
// 全部在临时 HOME 里建真仓跑真命令,直接调路由 handler(safeCwd 只放行 $HOME 内路径,
// 所以夹具必须落在临时 HOME 下;git.js 在请求时才读 homedir(),故 import 后再改也有效)。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
const realHome = process.env.HOME, realProfile = process.env.USERPROFILE;
const home = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-gitinit-home-')));
process.env.HOME = home;
process.env.USERPROFILE = home;

const router = (await import('../../server/routes/git.js')).default;
const pick = (path, method) => {
  const l = router.stack.find((x) => x.route?.path === path && x.route.methods?.[method]);
  assert.ok(l, `${method.toUpperCase()} ${path} 路由不见了(改路径了就同步这条断言)`);
  return l.route.stack[0].handle;
};
const initHandler = pick('/git/init', 'post');
const statusHandler = pick('/git/status', 'get');
const call = async (handler, req) => {
  let body = null, code = 200;
  await handler(req, { status(c) { code = c; return this; }, json(p) { body = p; return this; } }, () => {});
  return { code, body };
};
const init = (cwd) => call(initHandler, { body: { cwd } });
const status = (cwd) => call(statusHandler, { query: { cwd } });
const newRepo = (name, { commit = false } = {}) => {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', '.');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  if (commit) { writeFileSync(join(dir, 'seed.txt'), 'seed\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'seed'); }
  return dir;
};

try {
  // ── 1. 空文件夹(自己不是仓库):init + 空基线提交,HEAD 必须存在 ──
  {
    const dir = join(home, 'empty-project');
    mkdirSync(dir, { recursive: true });
    const r = await init(dir);
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true, '空文件夹 init 应成功');
    assert.equal(r.body.baselineWarning, null, `空文件夹不该有 baselineWarning:${r.body.baselineWarning}`);
    assert.equal(r.body.committed, true, '空文件夹必须真的提交(--allow-empty),否则 HEAD 永远不出现 = 按钮永久无效');
    assert.ok(/^[0-9a-f]{40}$/.test(r.body.sha || ''), 'sha 应是真 commit');
    assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), r.body.sha, '空文件夹 init 后 HEAD 必须存在');
  }

  // ── 2. 父仓库 + 子文件夹项目:提交只含子文件夹内容,兄弟文件不得被吞 ──
  {
    const parent = newRepo('parent-with-siblings');
    writeFileSync(join(parent, 'sibling.txt'), '别的项目的文件\n');
    mkdirSync(join(parent, 'other-project'), { recursive: true });
    writeFileSync(join(parent, 'other-project', 'their.txt'), '兄弟项目\n');
    const sub = join(parent, 'my-project');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'mine.txt'), '我的项目\n');

    const r = await init(sub);
    assert.equal(r.body.committed, true, `子文件夹 init 应产出提交:${r.body.baselineWarning}`);
    const files = git(parent, 'show', '--name-only', '--pretty=format:', 'HEAD').trim().split('\n').filter(Boolean);
    assert.deepEqual(files, ['my-project/mine.txt'], `提交只能含项目文件夹内容,实得:${JSON.stringify(files)}`);
    assert.ok(!files.some((f) => f.startsWith('other-project/') || f === 'sibling.txt'), '兄弟项目/兄弟文件绝不能被提交进去');
  }

  // ── 3. 用户实景:零提交父仓库 + 空的子文件夹项目 → 一次点击就该解决 ──
  {
    const parent = newRepo('zero-commit-parent');           // git init 过、从没 commit
    writeFileSync(join(parent, 'other.txt'), '上层其它文件\n');
    const sub = join(parent, '博士后面上');                  // 空文件夹项目(真实路径形态)
    mkdirSync(sub, { recursive: true });

    const before = await status(sub);
    assert.equal(before.body.isRepo, true, '子文件夹在父仓库里 → isRepo:true');
    assert.equal(before.body.hasCommit, false, '父仓库零提交 → hasCommit:false(横幅出「创建基线提交」)');
    assert.equal(before.body.root, parent, 'status 必须回报仓库根(横幅据此显示「仓库根:…」)');
    assert.notEqual(before.body.root, sub, '仓库根与项目路径不同 —— 用户此前完全不知道仓库在上层');

    const r = await init(sub);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.already, true, '父目录已是仓库 → 不重复 git init');
    assert.equal(r.body.committed, true, `一次点击必须建出 HEAD:${r.body.baselineWarning}`);
    assert.equal(r.body.baselineWarning, null, '正常场景不该回警告(那会显示 partial 横幅)');

    const after = await status(sub);
    assert.equal(after.body.hasCommit, true, '点完之后 hasCommit 必须翻真 —— 否则横幅永久循环');
  }

  // ── 4. 已有提交的干净仓库:不造空提交(别往正常历史里塞噪音)──
  {
    const dir = newRepo('healthy-repo', { commit: true });
    const head0 = git(dir, 'rev-parse', 'HEAD').trim();
    const r = await init(dir);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.committed, false, '没东西可提交且已有 HEAD → 不该再造空提交');
    assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), head0, 'HEAD 不得变动');
  }

  // ── 5. 前端护栏(源码断言:JSX 进不了 node,只能钉关键判据)──
  {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
    const banner = app.slice(app.indexOf('function GitInitBanner'), app.indexOf('function CompactDivider'));
    assert.ok(banner, 'GitInitBanner 组件不见了');
    assert.match(
      banner,
      /\[['"]busy['"], ['"]done['"], ['"]partial['"]\]\.includes\(statusRef\.current\)\) return/,
      '探测 effect 必须守住 busy/done/partial,不然 init 结果被重探测冲掉(用户只看到按钮回弹)',
    );
    assert.match(banner, /r\.ok \? r\.json\(\) : Promise\.reject/, '非 2xx 响应不得当探测结果用');
    assert.match(banner, /\.catch\(\(\) => \{ setRepoRoot\(null\); setStatus\('repo'\); \}\)/,
      '探测失败必须 fail-safe 到不显示横幅(绝不冒称"不是 git 仓库")');
    assert.ok(!/setStatus\('norepo'\)[^\n]*catch/.test(banner) && !/catch[^\n]*setStatus\('norepo'\)/.test(banner),
      'fetch 失败路径绝不能映射成 norepo');

    // ⑦判官必修-7:子文件夹场景(repoRoot ≠ cwd)横幅必须明说"属于上层仓库"并展示真实
    // root,绝不能落进"本文件夹未git初始化"分支(服务端 --show-toplevel 已保证 isRepo:true,
    // 本节§3 用真 git 钉死;这里钉前端呈现)。变异哨兵:删掉 nocommit 分支的上层仓库
    // 条件文案,下面两条必须变红(已实际验证过一次)。
    assert.match(banner, /repoRoot && repoRoot !== cwd\s*\? <><b>本文件夹属于上层 git 仓库<\/b>/,
      '子文件夹 nocommit 横幅必须声明"本文件夹属于上层 git 仓库"');
    assert.match(banner, />上层仓库根：\{repoRoot\}<\/span>/,
      '子文件夹场景必须展示真实上层仓库根路径');

    // init 的异步回调归属:add 跑几十秒期间用户可能切项目,A 的结果不许写到 B 上
    // (成功 → B 挂上被钉态守卫锁死的假绿条;partial → 点重试会对 B 执行计划外的
    // add+commit)。归属取发起时闭包 initCwd,写 state 前比当前 statusCwdRef。
    const initBody = banner.slice(banner.indexOf('const init = async'), banner.indexOf('const dismiss ='));
    assert.ok(initBody, 'init() 不见了');
    assert.match(initBody, /const initCwd = cwd;/, 'init 必须在发起时闭包捕获 cwd');
    assert.match(initBody, /statusCwdRef\.current === initCwd/, '归属校验必须比当前 ref 与发起时 cwd(别用渲染态闭包)');
    assert.equal(
      (initBody.match(/if \(!mine\(\)\) return;/g) || []).length, 3,
      '三条写结果 state 的路径(done/partial、非 2xx 回退、异常回退)都必须先过归属守卫',
    );
  }

  console.log('OK check-git-init-baseline');
} finally {
  process.env.HOME = realHome;
  if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  rmSync(home, { recursive: true, force: true });
}
