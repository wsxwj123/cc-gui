// r26-E4:stat(cwd) 吞 EPERM 成 404 —— 修前 git.js 对 stat 的一切失败都回
// 404「cwd does not exist」,EACCES/EPERM(系统拒绝访问)被误报成目录不存在,
// 用户去查路径拼写而真正该做的是授权限。修后按码分类:ENOENT/ENOTDIR → 404;
// EACCES/EPERM/EROFS → 403 + {code:'no-disk-access', hint, canOpenSettings}(契约 C-E4);
// 其他 → 500 原 message。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { classifyStatError } from '../../server/routes/git.js';

let n = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); n += 1; };
const ok = (v, m) => { assert.ok(v, m); n += 1; };

// ── 纯函数三象限 ─────────────────────────────────────────────────
{
  const r = classifyStatError({ code: 'ENOENT' });
  eq(r.status, 404, 'ENOENT → 404');
  eq(r.body.error, 'cwd does not exist', '404 文案不变(向后兼容)');
}
{
  const r = classifyStatError({ code: 'ENOTDIR' });
  eq(r.status, 404, 'ENOTDIR(路径穿过一个文件)→ 404');
}
for (const code of ['EACCES', 'EPERM', 'EROFS']) {
  const r = classifyStatError({ code });
  eq(r.status, 403, `${code} → 403,不再吞成 404(核心哨兵)`);
  eq(r.body.code, 'no-disk-access', 'C-E4:code 逐字固定');
  ok(typeof r.body.hint === 'string' && r.body.hint.length > 0, 'C-E4:带平台化 hint');
  eq(typeof r.body.canOpenSettings, 'boolean', 'C-E4:带 canOpenSettings 布尔位');
}
{
  const r = classifyStatError({ code: 'EIO', message: 'i/o error' });
  eq(r.status, 500, '其他错误 → 500');
  eq(r.body.error, 'i/o error', '500 带原 message');
  eq(r.body.code, undefined, '500 不带 code(与 403 形态区分)');
}

// ── 真实 fs 驱动:stat 的真错误对象进分类器(不手捏) ─────────────────
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r26e4-')));
  try {
    // ENOENT 真形态
    const enoent = await stat(join(home, 'no-such-dir')).then(() => null, (e) => e);
    eq(enoent.code, 'ENOENT', '前提:不存在路径是 ENOENT');
    eq(classifyStatError(enoent).status, 404, '真 ENOENT → 404');

    // ENOTDIR 真形态(路径组件穿过一个普通文件)
    writeFileSync(join(home, 'afile'), 'x');
    const enotdir = await stat(join(home, 'afile', 'inner')).then(() => null, (e) => e);
    eq(enotdir.code, 'ENOTDIR', '前提:穿过文件是 ENOTDIR');
    eq(classifyStatError(enotdir).status, 404, '真 ENOTDIR → 404');

    // EACCES 真形态:上级目录 chmod 000,stat 其内路径(stat 需要对祖先的执行权限)
    // Windows 无 POSIX 权限位语义,跳过(win 上 E4 的分类由上面的手捏 code 用例钉住)。
    if (process.platform !== 'win32') {
      mkdirSync(join(home, 'locked', 'inner'), { recursive: true });
      chmodSync(join(home, 'locked'), 0o000);
      try {
        const eacces = await stat(join(home, 'locked', 'inner')).then(() => null, (e) => e);
        eq(eacces.code, 'EACCES', '前提:无执行权限的上级 → EACCES');
        const r = classifyStatError(eacces);
        eq(r.status, 403, '真 EACCES → 403(修前这里是 404「不存在」,误诊哨兵)');
        eq(r.body.code, 'no-disk-access', '真 EACCES 的 body 按 C-E4 形状');
      } finally {
        chmodSync(join(home, 'locked'), 0o755);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ── 路由接线:stat catch 走分类器而不是笼统 404 ─────────────────────
{
  const realHome = process.env.HOME, realProfile = process.env.USERPROFILE;
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r26e4-home-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const gitRouter = (await import('../../server/routes/git.js')).default;
    const layer = gitRouter.stack.find((l) => l.route?.path === '/git/status' && l.route.methods?.get);
    ok(layer, 'GET /git/status 路由存在');
    const handler = layer.route.stack[0].handle;
    const call = async (cwd) => {
      let body = null, code = 200;
      await handler({ query: { cwd } }, {
        status(c) { code = c; return this; },
        json(p) { body = p; return this; },
      }, () => {});
      return { body, code };
    };
    // 路由级 404 回归:不存在的目录仍 404(既有过往行为不破)
    const r404 = await call(join(home, 'missing'));
    eq(r404.code, 404, '路由:不存在仍 404');
    eq(r404.body.error, 'cwd does not exist', '路由:404 文案不变');
    // 路由级 403:chmod 000 的上级目录(非 win)
    if (process.platform !== 'win32') {
      mkdirSync(join(home, 'locked', 'inner'), { recursive: true });
      chmodSync(join(home, 'locked'), 0o000);
      try {
        const r403 = await call(join(home, 'locked', 'inner'));
        eq(r403.code, 403, '路由:拒访 → 403(修前 404,核心哨兵)');
        eq(r403.body.code, 'no-disk-access', '路由:403 body 按 C-E4');
        eq(typeof r403.body.canOpenSettings, 'boolean', '路由:带 canOpenSettings');
      } finally {
        chmodSync(join(home, 'locked'), 0o755);
      }
    }
  } finally {
    process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

console.log(`✓ check-r26-stat-cwd-classify(E4):${n} 条断言全过`);
