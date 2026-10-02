#!/usr/bin/env node
// r142-附3 —— Windows 的「应用身份」归一化(0.2.412 审查 必修-5 的回归)。
//
// 事故:Windows 的应用身份是 exe 路径,而授权表里存的是**用户手填的原样字符串**。手填
// `c:/windows/system32/notepad.exe`(小写 + 正斜杠)时:`os.path.exists` 为真 ⇒ 面板显示"已安装"、
// 授权"成功";但 `enum_windows` 报的是内核路径 `C:\Windows\System32\notepad.exe` ⇒ 精确查表
// 永不命中 ⇒ 动作永远 CU_APP_NOT_ALLOWED(窗口查找那条回 CU_TARGET_NOT_FOUND)。用户看到的是
// "我明明授权了它"。仓内 AGENTS.md 的 Windows 口径就是"路径按 [/\\] 切、比较需大小写归一化"。
//
// 这条用例锁三件事:
//   ① 纯函数口径:归一化(分隔符 + 大小写)、mac 侧原样不动、授权查表跨写法命中、重复授权不并存两条;
//   ② 伪 win32 真跑:授权表存一种写法、target 用另一种写法 ⇒ 动作必须被允许(修前 = CU_APP_NOT_ALLOWED);
//   ③ 反向守卫:真正没授权过的另一个应用仍然被拒(归一化没有把不相干的东西放进来)。
//
// 口径说明(为什么这么写、语义没放宽):新增断言只覆盖"同一路径的另一种写法",③ 明确锁住
// "不同路径仍被拒";mac 的 bundleId 大小写敏感口径由 AID-01 的 darwin 分支锁死,未改动。
//
// 跑法:node tests/unit/check-cu-win-appid-normalize.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';
import { GRANTED, grantedWindow, makeWinHome, startWinMcp } from './r142-helpers/win-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const report = makeReport('check-cu-win-appid-normalize');
const cu = await import('../../server/computer-use/cu-common.js');

const MIXED = 'c:/windows/system32/notepad.exe';                 // 用户手填的写法
const KERNEL = 'C:\\Windows\\System32\\notepad.exe';              // 内核/窗口列表的写法
const OTHER = 'C:\\Other\\other.exe';                             // 没授权过的另一个应用

// ── AID-01 纯函数口径(修前红:normalizeAppId/sameAppId 不存在)──────────
await report.check('AID-01', 'normalizeAppId/sameAppId:Windows 归一化大小写与分隔符,macOS 原样不动;重复授权不并存两条', 'red', () => {
  assert.equal(typeof cu.normalizeAppId, 'function', 'cu-common 必须导出 normalizeAppId(比较口径的唯一落点)');
  assert.equal(typeof cu.sameAppId, 'function', 'cu-common 必须导出 sameAppId');
  assert.equal(cu.normalizeAppId(MIXED, 'win32'), cu.normalizeAppId(KERNEL, 'win32'), '两种写法必须归一成同一个 key');
  assert.equal(cu.normalizeAppId(KERNEL, 'win32'), 'c:\\windows\\system32\\notepad.exe');
  assert.equal(cu.normalizeAppId('com.apple.TextEdit', 'darwin'), 'com.apple.TextEdit',
    'macOS 的 bundleId 大小写敏感,不许被归一化改写');
  assert.ok(cu.sameAppId(MIXED, KERNEL, 'win32'), '同一个 exe 的两种写法必须判等');
  assert.ok(!cu.sameAppId(OTHER, KERNEL, 'win32'), '不同 exe 不许判等');
  assert.ok(!cu.sameAppId('com.apple.TextEdit', 'com.apple.textedit', 'darwin'), 'mac 侧必须仍然大小写敏感');
  // 授权查表:存一种写法、查另一种写法
  const grants = { version: 1, screenScope: { granted: false, grantedAt: null }, apps: { [KERNEL]: { name: 'Notepad', grantedAt: null } } };
  assert.ok(cu.appGranted(grants, MIXED, 'win32'), '授权表里存内核写法时,手填写法也必须命中(修前就是这里漏)');
  assert.ok(!cu.appGranted(grants, OTHER, 'win32'), '反向:没授权的应用不许命中');
  assert.ok(!cu.appGranted(grants, 'com.apple.textedit', 'darwin'), '反向:mac 侧仍大小写敏感');
});

// ── AID-02 setGrant 真去重(在伪 win32 + 假家目录的子进程里跑,绝不碰真 ~/.claude-gui)──
{
  const base = join(HERE, 'r142-helpers', '.artifacts', 't10-setgrant');
  fs.rmSync(base, { recursive: true, force: true });
  const home = join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const PRELOAD = pathToFileURL(join(HERE, 'r142-helpers', 'win-preload.mjs')).href;
  const SCRIPT = `
import fs from 'node:fs';
import { join } from 'node:path';
const home = process.env.CU_TEST_HOME;
fs.mkdirSync(join(home, '.claude-gui', 'cu-runtime'), { recursive: true });
const cu = await import(process.env.AID_CU);
const out = {};
cu.setGrant({ bundleId: 'C:\\\\Windows\\\\System32\\\\Notepad.exe', name: 'Notepad', granted: true });
cu.setGrant({ bundleId: 'c:/windows/system32/notepad.exe', name: 'Notepad', granted: true });
out.afterDoubleGrant = Object.keys(cu.readGrants().apps);
out.grantedByOtherSpelling = cu.appGranted(cu.readGrants(), 'C:/WINDOWS/system32/Notepad.EXE');
cu.setGrant({ bundleId: 'c:/WINDOWS/system32/notepad.exe', granted: false });
out.afterRevoke = Object.keys(cu.readGrants().apps);
process.stdout.write(JSON.stringify(out));
`;
  const r = spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, CU_TEST_HOME: home, AID_CU: pathToFileURL(join(ROOT, 'server', 'computer-use', 'cu-common.js')).href },
    timeout: 60_000,
  });
  let res = null;
  try { res = JSON.parse(String(r.stdout).trim().split('\n').pop() || 'null'); } catch { res = null; }
  await report.check('AID-02', 'setGrant 按归一化去重:同一应用换写法再授权只留一条;撤销也能按另一种写法命中', 'red', () => {
    assert.ok(res, `子进程没有输出可解析 JSON(stdout=${String(r.stdout).slice(0, 200)} stderr=${String(r.stderr).slice(0, 300)})`);
    assert.deepEqual(res.afterDoubleGrant, ['C:\\Windows\\System32\\Notepad.exe'],
      `同一应用换写法授权了两次,授权表里却是 ${JSON.stringify(res.afterDoubleGrant)}(应为 1 条)`);
    assert.equal(res.grantedByOtherSpelling, true, '查表时另一种写法也必须命中');
    assert.deepEqual(res.afterRevoke, [], `按第 3 种写法撤销后应清空,实际 ${JSON.stringify(res.afterRevoke)}`);
  });
}

// ── AID-03 端到端:授权写法与窗口路径不同 ⇒ 动作必须被允许(修前红)──────
{
  const fake = makeWinHome('t10-appid');
  fake.setGrants({ apps: ['C:\\Windows\\System32\\Notepad.exe'] });   // 注意大小写与内核路径不同
  fake.setScenario({ windows: { reply: { ok: true, frontmost: null, windows: [grantedWindow()] } } });
  const mcp = await startWinMcp(fake);
  const target = { bundleId: MIXED, pid: GRANTED.pid, windowId: GRANTED.windowId };
  const listed = await mcp.call('window_list', {}, 30_000).catch((e) => ({ error: String(e) }));
  const typed = await mcp.call('type', { actionId: 'r142_appid_1', target, text: 'AB' }, 40_000)
    .catch((e) => ({ error: String(e) }));
  const denied = await mcp.call('type', { actionId: 'r142_appid_2', target: { ...target, bundleId: OTHER }, text: 'AB' }, 40_000)
    .catch((e) => ({ error: String(e) }));
  mcp.kill();

  await report.check('AID-03', '伪 win32:授权表存 C:\\…\\Notepad.exe、target 用 c:/…/notepad.exe ⇒ 动作被允许(不是 CU_APP_NOT_ALLOWED)', 'red', () => {
    assert.ok(!typed.error, `type 调用本身报错:${typed.error}`);
    assert.notEqual(typed.sc?.code, 'CU_APP_NOT_ALLOWED',
      '手填写法与内核写法被当成两个应用 ⇒ 用户"明明授权了"却被拒(必修-5)');
    assert.notEqual(typed.sc?.code, 'CU_TARGET_NOT_FOUND',
      '窗口匹配也在精确比较 bundleId ⇒ 找不到窗口(必修-5)');
    assert.equal(typed.isError, false, `动作没被允许:${JSON.stringify(typed.sc)}`);
  });

  await report.check('AID-04', 'window_list 的已授权集合按同一口径:授权写法不同也照样列出该窗口', 'red', () => {
    assert.equal(listed.isError, false, `window_list 失败:${JSON.stringify(listed.sc)}`);
    assert.equal(listed.sc?.windows?.length, 1,
      `window_list 没列出该窗口(已授权集合仍在精确比较):${JSON.stringify(listed.sc?.windows)}`);
  });

  await report.check('AID-05', '反向守卫:真正没授权过的另一个 exe 仍然 CU_APP_NOT_ALLOWED(归一化没放宽到别的应用)', 'green', () => {
    assert.equal(denied.isError, true, `未授权应用却成功了:${JSON.stringify(denied.sc)}`);
    assert.equal(denied.sc?.code, 'CU_APP_NOT_ALLOWED', `失败码是 ${denied.sc?.code},应为 CU_APP_NOT_ALLOWED`);
  });
}

process.exit(report.finish());
