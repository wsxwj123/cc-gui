#!/usr/bin/env node
// 单测:projects-enoent-fresh-env —— 全新环境(~/.claude/projects 还没创建)下 listProjects 不该抛错。
// 现象:projectsDir 不存在时,listProjects 的 Promise 以 code==='ENOENT' 拒绝,「还没有任何工作区」被当成故障。
// 根因:ENOENT 被原样抛出,没有按「目录不存在 = 工作区列表为空」处理。
// 契约不变:EACCES/EPERM 仍抛且 isAccessDenied 为 true(HTTP 层据此回 403);ENOTDIR 等其他非 ENOENT 错误仍抛,绝不吞成 []。
// 只给 listProjects 传 mkdtemp 建的临时目录,不碰真实 ~/.claude/projects;五条用例互相独立,逐条打印 ok/FAIL。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjects } from '../../server/services/session-reader.js';
import { isAccessDenied } from '../../server/utils/access-hint.js';

// 环境造不出场景时抛它:t() 打印 skip 与原因,不算失败
class Skip extends Error {}

let passed = 0;
let skipped = 0;
let failed = 0;

// 逐条执行:任何异常(含断言失败)都在这里接住,一条红不影响后面,也不会让未捕获的拒绝崩进程
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (e) {
    if (e instanceof Skip) {
      skipped += 1;
      console.log(`skip ${name}: ${e.message}`);
      return;
    }
    failed += 1;
    const reason = e?.name === 'AssertionError' ? e.message : `用例自身异常 ${e?.stack ?? e}`;
    console.log(`FAIL ${name}: ${reason}`);
  }
}

// 调 listProjects,把返回值或抛出的错都收下,由各用例自己断言(红要红在断言上,不是崩在这里)
async function call(dir) {
  try {
    return { ok: true, value: await listProjects(dir) };
  } catch (error) {
    return { ok: false, error };
  }
}

// 报错信息里写清「实际抛了什么」:优先 code(如 ENOENT),没有 code 才退回 name: message
const describeErr = (e) => (e?.code ? String(e.code) : e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// 1 [复现,修复前必红] 父目录存在、自己不存在 → 不抛错,返回 []
await t('目录不存在(父目录存在)→ 返回 []', async () => {
  const base = mkdtempSync(join(tmpdir(), 'projects-enoent-c1-'));
  try {
    const r = await call(join(base, 'projects'));
    assert.ok(r.ok, `目录不存在应返回 [],实际抛了 ${describeErr(r.error)}`);
    assert.deepEqual(r.value, [], `目录不存在应返回空数组 [],实际返回 ${JSON.stringify(r.value)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 2 [复现,修复前必红] 连父目录也不存在的多级路径 → 不抛错,返回 []
await t('连父目录也不存在的多级路径 → 返回 []', async () => {
  const base = mkdtempSync(join(tmpdir(), 'projects-enoent-c2-'));
  try {
    const r = await call(join(base, 'no-such-parent', 'no-such-child', 'projects'));
    assert.ok(r.ok, `连父目录也不存在的多级路径应返回 [],实际抛了 ${describeErr(r.error)}`);
    assert.deepEqual(r.value, [], `连父目录也不存在的多级路径应返回空数组 [],实际返回 ${JSON.stringify(r.value)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 3 [回归] 存在的空目录 → 返回 []
await t('存在的空目录 → 返回 []', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-enoent-c3-'));
  try {
    const r = await call(dir);
    assert.ok(r.ok, `存在的空目录应返回 [],实际抛了 ${describeErr(r.error)}`);
    assert.deepEqual(r.value, [], `存在的空目录应返回空数组 [],实际返回 ${JSON.stringify(r.value)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 4 [回归] 存在但权限为 000 的目录 → 仍抛 EACCES/EPERM,isAccessDenied 命中,不吞成 []
await t('无权限目录(000)→ 抛 EACCES/EPERM 且 isAccessDenied 为 true,不吞成 []', async () => {
  if (process.platform === 'win32') {
    throw new Skip('win32 的 chmod 造不出无权限目录(接口约定:win32 跳过)');
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Skip('当前是 root(uid 0),不受目录权限位限制,读得到 000 目录,造不出无权限场景');
  }
  const base = mkdtempSync(join(tmpdir(), 'projects-enoent-c4-'));
  const locked = join(base, 'locked');
  try {
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const r = await call(locked);
    assert.ok(!r.ok, `无权限目录必须抛错(不许吞成 []),实际返回 ${JSON.stringify(r.value)}`);
    const code = r.error?.code;
    assert.ok(code === 'EACCES' || code === 'EPERM', `无权限目录的错误码应为 EACCES/EPERM,实际 ${describeErr(r.error)}`);
    assert.equal(isAccessDenied(r.error), true, `isAccessDenied(err) 应为 true(HTTP 层靠它回 403),实际抛 ${describeErr(r.error)} 却未命中`);
  } finally {
    // 先恢复权限再删:否则 rmSync 进不去 000 目录,临时目录会残留
    try { chmodSync(locked, 0o755); } catch { /* mkdirSync 没成功时目录不在,忽略 */ }
    rmSync(base, { recursive: true, force: true });
  }
});

// 5 [回归] 路径是普通文件 → 仍抛(POSIX 上 ENOTDIR),绝不是 ENOENT,不吞成 []
await t('路径是普通文件 → 抛 ENOTDIR(不是 ENOENT),不吞成 []', async () => {
  if (process.platform === 'win32') {
    throw new Skip('win32 下对文件路径读目录的错误码与 POSIX 不同(接口约定:ENOTDIR 只在 POSIX 验证,win32 跳过)');
  }
  const base = mkdtempSync(join(tmpdir(), 'projects-enoent-c5-'));
  try {
    const file = join(base, 'not-a-dir');
    writeFileSync(file, 'x');
    const r = await call(file);
    assert.ok(!r.ok, `路径是普通文件时必须抛错(不许吞成 []),实际返回 ${JSON.stringify(r.value)}`);
    assert.notEqual(r.error?.code, 'ENOENT', '普通文件路径的错误不该是 ENOENT(不能被当成「目录不存在」吞掉)');
    assert.equal(r.error?.code, 'ENOTDIR', `POSIX 上普通文件路径应抛 ENOTDIR,实际 ${describeErr(r.error)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

console.log(`共 ${passed + skipped + failed} 条:通过 ${passed},跳过 ${skipped},失败 ${failed}`);
if (failed === 0) {
  console.log('PASS projects-enoent-fresh-env');
} else {
  process.exitCode = 1;
}
