#!/usr/bin/env node
// r151f 修法 6(r151e 复审建议 4):savePrefs 写临时文件失败的分支 —— 临时文件不残留、原错误照原样抛出、原偏好文件不变。
//   4a) 偏好目录不可写:临时文件根本建不成(open 报 EACCES)→ 抛回的是这个 EACCES(不被删临时文件时的 ENOENT 盖掉),没有残留;
//   4b) 临时文件建成、写到一半失败(子进程里用 ulimit -f 限制文件大小,write 报 EFBIG,留下半截临时文件)→ 抛回 EFBIG,半截临时文件被删掉。
// 走导出的 updatePrefs(savePrefs 不导出,updatePrefs 是它的唯一入口之一)。临时 HOME,不起服务、不占端口。
// node tests/unit/check-r151f-saveprefs-tmp.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151f-saveprefs-')));
const HOME = join(TMP, 'home');
const PREFS_DIR = join(HOME, '.claude-gui');
const PREFS = join(PREFS_DIR, 'prefs.json');
mkdirSync(PREFS_DIR, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
const ORIGINAL = JSON.stringify({ hiddenProjects: ['keep-me'] }, null, 2);
writeFileSync(PREFS, ORIGINAL);
const PREFS_MODULE = fileURLToPath(new URL('../../server/routes/prefs.js', import.meta.url));
const leftovers = () => readdirSync(PREFS_DIR).filter((n) => n.startsWith('prefs.json.tmp.'));

// 4a) 偏好目录不可写:临时文件建不成
{
  const prefsMod = await import(pathToFileURL(PREFS_MODULE).href);
  chmodSync(PREFS_DIR, 0o555);
  let err = null;
  try {
    await prefsMod.updatePrefs((p) => { p.r151f = 'x'; });
  } catch (e) {
    err = e;
  } finally {
    chmodSync(PREFS_DIR, 0o755);
  }
  assert.ok(err, '4a 写不进时 updatePrefs 必须抛错(不能静默吞掉)');
  assert.deepEqual([err.code, err.syscall, /prefs\.json\.tmp\./.test(String(err.path))], ['EACCES', 'open', true],
    `4a 抛回的是写临时文件时的原错误(不是删临时文件的 ENOENT):${err.code} ${err.syscall} ${err.path}`);
  assert.deepEqual(leftovers(), [], '4a 没有残留的临时文件');
  assert.equal(readFileSync(PREFS, 'utf8'), ORIGINAL, '4a 原偏好文件不变');
}

// 4b) 临时文件写到一半失败:子进程限制可写文件大小(ulimit -f),写超出时 write 报 EFBIG,留下半截临时文件
{
  const child = `
    const { updatePrefs } = await import(${JSON.stringify(pathToFileURL(PREFS_MODULE).href)});
    try { await updatePrefs((p) => { p.r151fBig = 'x'.repeat(200000); }); console.log(JSON.stringify({ ok: true })); }
    catch (e) { console.log(JSON.stringify({ code: e.code, syscall: e.syscall, path: e.path })); }
  `;
  const r = spawnSync('/bin/sh', ['-c', 'ulimit -f 1; exec "$0" --input-type=module -e "$1"', process.execPath, child], {
    env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: 'utf8', timeout: 60_000,
  });
  const line = String(r.stdout).trim().split('\n').at(-1) || '';
  let out = null;
  try { out = JSON.parse(line); } catch { /* 下面断言给出原文 */ }
  assert.ok(out, `4b 子进程输出不可解析:stdout=${r.stdout} stderr=${String(r.stderr).slice(0, 400)}`);
  // write 报的错按文件描述符,不带 path;按错误码与系统调用认
  assert.deepEqual([out.code, out.syscall], ['EFBIG', 'write'], `4b 抛回的是写临时文件中途的原错误:${JSON.stringify(out)}`);
  assert.deepEqual(leftovers(), [], '4b 写了一半的临时文件被删掉,没有残留');
  assert.equal(readFileSync(PREFS, 'utf8'), ORIGINAL, '4b 原偏好文件不变');
}

console.log('✓ check-r151f-saveprefs-tmp 全部通过');
