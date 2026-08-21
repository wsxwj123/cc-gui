// r26-E1:/git/status 兜底过宽 —— 修前 norepo/missing/killed 之外的一切错误都报
// permissionDenied,dubious ownership / .git 损坏 / 磁盘满全被误诊成「系统拒绝访问」,
// 引导用户去开完全磁盘访问。修后:isAccessDenied 命中才走权限分支,其余落
// {isRepo:null, gitError:true, error, detail}(契约 C-E1,与 permissionDenied 互斥)。
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyGitStatusError } from '../../server/routes/git.js';

let n = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); n += 1; };
const ok = (v, m) => { assert.ok(v, m); n += 1; };

// ── 纯函数五形态 ─────────────────────────────────────────────────
eq(classifyGitStatusError({ stderr: 'fatal: detected dubious ownership in repository at /x' }).kind,
  'unknown', 'dubious ownership → unknown(误诊哨兵:修前这句会报成 permissionDenied)');
eq(classifyGitStatusError({ stderr: 'fatal: not a git repository' }).kind, 'norepo', 'not a git repository → norepo');
eq(classifyGitStatusError({ stderr: '致命错误：不是 git 仓库（或者任何父目录）：.git' }).kind,
  'norepo', '中文本地化 norepo 同样命中');
eq(classifyGitStatusError({ code: 'ENOENT' }).kind, 'missing', 'git 没装(ENOENT)→ missing');
eq(classifyGitStatusError({ killed: true, message: 'Command failed: git ...' }).kind, 'killed', '超时 → killed');
eq(classifyGitStatusError({ stderr: 'fatal: Operation not permitted' }).kind, 'denied', 'Operation not permitted → denied');
eq(classifyGitStatusError({ code: 'EPERM' }).kind, 'denied', 'fs 形态 EPERM code → denied(E6 主判据)');
eq(classifyGitStatusError({ stderr: 'fatal: アクセスが拒否されました' }).kind, 'denied', '日文拒访文本 → denied(E6 辅判据)');
eq(classifyGitStatusError({ message: 'No space left on device' }).kind, 'unknown', '磁盘满 → unknown,不是 denied');

// unknown 支带首行 detail(截断 200),denied/norepo 等不带
{
  const u = classifyGitStatusError({ stderr: 'fatal: some weird failure\nsecond line' });
  eq(u.detail, 'fatal: some weird failure', 'unknown 带首行 detail');
  const long = classifyGitStatusError({ stderr: 'x'.repeat(300) });
  eq(long.detail.length, 200, 'detail 截断 200 字符');
}

// ── 路由薄壳:真实驱动 denied 与 norepo 两分支 ─────────────────────
// safeCwd 只放行 $HOME 内路径,夹具建在临时 HOME(同 check-git-import-probe 做法)。
{
  const realHome = process.env.HOME, realProfile = process.env.USERPROFILE;
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r26e1-home-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const gitRouter = (await import('../../server/routes/git.js')).default;
    const layer = gitRouter.stack.find((l) => l.route?.path === '/git/status' && l.route.methods?.get);
    ok(layer, 'GET /git/status 路由存在');
    const handler = layer.route.stack[0].handle;
    const status = async (cwd) => {
      let body = null, code = 200;
      await handler({ query: { cwd } }, {
        status(c) { code = c; return this; },
        json(p) { body = p; return { body, code }; },
      }, () => {});
      return { body, code };
    };

    // norepo:普通目录
    const plain = join(home, 'plain');
    mkdirSync(plain);
    eq((await status(plain)).body.isRepo, false, '路由:norepo 分支不变');

    // denied:chmod 000 的 git 仓库,真实 git 报 "Permission denied"(本机实测形态)
    const locked = join(home, 'locked');
    mkdirSync(locked);
    execFileSync('git', ['-C', locked, 'init', '-q', '.']);
    chmodSync(locked, 0o000);
    try {
      const r = await status(locked);
      eq(r.body.isRepo, null, '路由:拒访 isRepo:null');
      eq(r.body.permissionDenied, true, '路由:拒访仍走 permissionDenied 分支(不误改成 gitError)');
      ok(r.body.hint, '路由:denied 带平台化 hint');
      eq(r.body.gitError, undefined, '路由:denied 不带 gitError(C-E1 互斥)');
    } finally {
      chmodSync(locked, 0o755);
    }
  } finally {
    process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

// ── 接线断言:unknown 分支逐字按 C-E1 契约形状,与 permissionDenied 互斥 ──
{
  const src = readFileSync(new URL('../../server/routes/git.js', import.meta.url), 'utf-8');
  ok(/classifyGitStatusError\(e\)/.test(src), '路由薄壳调用 classifyGitStatusError');
  ok(/res\.json\(\{ isRepo: null, gitError: true, error: 'git 探测失败', detail: cls\.detail \}\)/.test(src),
    'C-E1 契约形状逐字固定:{isRepo:null, gitError:true, error, detail}');
  ok(src.indexOf('gitError: true') > src.indexOf("cls.kind === 'denied'"),
    'gitError 分支在 denied 分支之后(unknown 是最后的兜底,不会抢权限分支)');
}

console.log(`✓ check-r26-git-status-classify(E1):${n} 条断言全过`);
