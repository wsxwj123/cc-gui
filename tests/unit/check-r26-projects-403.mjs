#!/usr/bin/env node
// 单测:r26-E3 /projects 顶层目录被系统拒绝 → 403 + code:'no-disk-access'(契约 C-E3)。
// 根因:/projects 直接 await listProjects() 后 res.json,无 403 分支——EACCES 时走 500
// 或空列表,前端显示「没有找到项目」,用户以为项目数据丢了。
// 修法:路由层 catch 里 isAccessDenied(err)(PKG-4 的错误码主判据)→ 403 契约体。
// 真实行为验证:listProjects 注入 /tmp 自建 chmod 000 目录,真抛出 EACCES(不 mock)。
// 变异哨兵(实际验证过红):S1 删掉 403 分支(isAccessDenied 判断)→ t2 红。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjects } from '../../server/services/session-reader.js';
import { isAccessDenied } from '../../server/utils/access-hint.js';
import { projectsAccessDeniedBody } from '../../server/routes/sessions.js';

// t1 真实 fs 行为:无权限目录 listProjects 抛 EACCES/EPERM,且 isAccessDenied 命中主判据
//    (root 运行时机率上读得到,跳过该断言;本机/CI 均为非 root)
{
  const dir = mkdtempSync(join(tmpdir(), 'r26-e3-'));
  const locked = join(dir, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log('t1: root 环境跳过 EACCES 断言');
    } else {
      let err = null;
      try { await listProjects(locked); } catch (e) { err = e; }
      assert.ok(err, 't1: 无权限目录必须抛错(不许静默吞成空列表)');
      assert.ok(err.code === 'EACCES' || err.code === 'EPERM', `t1: 错误码应为 EACCES/EPERM(实际 ${err.code})`);
      assert.equal(isAccessDenied(err), true, 't1: isAccessDenied 主判据命中');
    }
  } finally {
    chmodSync(locked, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
}

// t2 403 契约体形状(契约 C-E3:{code:'no-disk-access', hint, canOpenSettings})
{
  const body = projectsAccessDeniedBody();
  assert.equal(body.code, 'no-disk-access', 't2: code 逐字按契约');
  assert.ok(typeof body.hint === 'string' && body.hint.length > 0, 't2: hint 非空');
  assert.match(body.hint, /项目文件本身没有丢失/, 't2: 明说数据没丢(用户第一反应是"被删了")');
  assert.ok('canOpenSettings' in body, 't2: canOpenSettings 键必须在');
  // canOpenSettings 字段有无按注入平台(与 E1/E6 共用夹具口径)
  assert.equal(projectsAccessDeniedBody('darwin').canOpenSettings, true, 't2: macOS 有系统设置面板可跳');
  assert.equal(projectsAccessDeniedBody('win32').canOpenSettings, false, 't2: Windows 无面板可跳');
}

// t3 非权限错误不误判(误诊哨兵):ENOENT/普通 Error 不该走 403 分支
{
  assert.equal(isAccessDenied(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })), false,
    't3: ENOENT 不算拒访');
  assert.equal(isAccessDenied(new Error('disk full')), false, 't3: 磁盘满不算拒访');
}

// t4 正常目录不受影响(回归哨兵)
{
  const dir = mkdtempSync(join(tmpdir(), 'r26-e3-ok-'));
  try {
    const out = await listProjects(dir);
    assert.deepEqual(out, [], 't4: 空的正常目录 → 空列表(200 路径不变)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// t5 路由接线钉住(剥注释后断言,与 check-session-access-error.mjs 同口径):
//    /projects 的 catch 必须经 isAccessDenied 分类成 403,不是笼统 500
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../server/routes/sessions.js', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const projectsRoute = src.match(/router\.get\('\/projects',[\s\S]*?\n\}\);/);
  assert.ok(projectsRoute, 't5: 找到 /projects 路由');
  assert.match(projectsRoute[0], /isAccessDenied\(err\)/, 't5: catch 必须走 isAccessDenied 分类');
  assert.match(projectsRoute[0], /res\.status\(403\)\.json\(projectsAccessDeniedBody\(\)\)/,
    't5: 拒访 → 403 + 契约体');
}

console.log('PASS r26-e3-projects-403');
