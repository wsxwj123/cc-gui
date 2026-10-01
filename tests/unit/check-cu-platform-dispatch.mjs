#!/usr/bin/env node
// r142 / T-2 —— 平台分派(纯函数 + 伪 win32 运行时)。
// 合同来源:PLAN-r142 §3.1 A-2(平台分派表)、§6.1 T-2、§7.2 #3(venv-win 命名)、§2.4(Windows 依赖表)。
//
// 三类断言:
//   [纯函数] cu-common 的三个 `*For(platform)` + parseKeySpec(raw, platformName)
//   [运行时] 伪 win32 子进程里观察产品**真实**的行为:建哪个目录、传给 pip 什么依赖表、走哪个解释器候选
//   [回归]   darwin 侧一字不改:常量还是 POSIX 布局、mac helper 的 argv 不许出现 win 专属开关
//
// 跑法:node tests/unit/check-cu-platform-dispatch.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';
import { GRANTED, grantedWindow, makeWinHome, startWinMcp, WIN_DEPS } from './r142-helpers/win-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const report = makeReport('check-cu-platform-dispatch');
const cu = await import('../../server/computer-use/cu-common.js');
const mcp = await import('../../server/computer-use/mcp-server.js');
const MAC_DEPS_MATCH = /const PY_DEPS = \[([^\]]*)\]/.exec(fs.readFileSync(
  join(HERE, '..', '..', 'server', 'computer-use', 'mcp-server.js'), 'utf8'));

// ── T2-01 cu-common 的三个平台纯函数(§6.1 T-2 点名的接口)───────────────
await report.check('T2-01', 'cu-common 导出 venvDirFor/venvPyFor/stampFileFor,且 win32=venv-win(Scripts\\python.exe)', 'red', () => {
  for (const name of ['venvDirFor', 'venvPyFor', 'stampFileFor']) {
    assert.equal(typeof cu[name], 'function',
      `cu-common.js 必须导出 ${name}(platform)(§6.1 T-2 点名;否则平台分派无法纯函数测试)`);
  }
  assert.equal(basename(cu.venvDirFor('win32')), 'venv-win', 'Windows 运行时目录必须是 venv-win(§7.2 #3)');
  assert.equal(basename(cu.venvDirFor('darwin')), 'venv', 'macOS 必须还是 venv(一字不改)');
  assert.equal(cu.venvPyFor('win32'), join(cu.venvDirFor('win32'), 'Scripts', 'python.exe'),
    'Windows venv 的解释器是 Scripts\\python.exe(FORENSICS ② #8)');
  assert.equal(cu.venvPyFor('darwin'), join(cu.venvDirFor('darwin'), 'bin', 'python3'),
    'macOS 解释器路径必须还是 bin/python3');
  assert.equal(basename(cu.stampFileFor('win32')), 'venv-win.stamp', 'Windows 依赖戳跟随目录名(§7.2 #3)');
  assert.equal(basename(cu.stampFileFor('darwin')), 'venv.stamp', 'macOS 依赖戳必须还是 venv.stamp');
});

// ── T2-02 本机(darwin)现有常量与修前一致(修前绿)────────────────────
await report.check('T2-02', 'darwin 下 VENV_DIR/VENV_PY/STAMP_FILE 仍是 POSIX 布局(逐字节不变)', 'green', () => {
  assert.equal(cu.VENV_DIR, join(cu.RUNTIME_DIR, 'venv'), 'VENV_DIR 变了(mac 布局不许动)');
  assert.equal(cu.VENV_PY, join(cu.RUNTIME_DIR, 'venv', 'bin', 'python3'), 'VENV_PY 变了(mac 布局不许动)');
  assert.equal(cu.STAMP_FILE, join(cu.RUNTIME_DIR, 'venv.stamp'), 'STAMP_FILE 变了(mac 布局不许动)');
  assert.ok(cu.RUNTIME_DIR.endsWith(join('.claude-gui', 'cu-runtime')), '运行时目录仍在 ~/.claude-gui/cu-runtime');
});

// ── T2-03 伪 win32:产品真的去装 mss+Pillow+comtypes,且不含 pyobjc(修前红)──
{
  // 故意写错依赖戳 ⇒ bootstrap 会走 pip install,桩会把**产品真实传出去的依赖表**记下来。
  const fake = makeWinHome('t2-deps', { venvReady: true, stamp: 'mismatch' });
  fake.setGrants({ apps: [GRANTED.bundleId] });
  fake.setScenario({ windows: { reply: { ok: true, frontmost: null, windows: [grantedWindow()] } } });
  const mcpWin = await startWinMcp(fake);
  await mcpWin.call('window_list', {}, 30_000).catch(() => null);
  mcpWin.kill();
  const pip = fake.log().find((e) => e.kind === 'py' && e.subcmd === '-m pip');
  await report.check('T2-03', '伪 win32 下传给 pip 的依赖表 = mss+Pillow+comtypes>=1.4.0(无 pyobjc)', 'red', () => {
    assert.ok(pip, `伪 win32 下没观察到 pip install 调用;桩记录:${JSON.stringify(fake.log().slice(0, 5))}`);
    const deps = pip.args.filter((a) => !a.startsWith('-')).slice(2);
    assert.deepEqual(deps, WIN_DEPS, `传出去的依赖表是 ${JSON.stringify(deps)},§2.4 钉的是 ${JSON.stringify(WIN_DEPS)}`);
    assert.ok(!deps.some((d) => /pyobjc|pyautogui/.test(d)),
      'Windows 依赖表不许含 pyobjc-* / pyautogui(它们在 Windows 上装不上或不被使用)');
  });
}

// ── T2-04 伪 win32:没有 venv 时建的是 venv-win,解释器候选走 py -3 / python(修前红)──
{
  const fake = makeWinHome('t2-venv', { venvReady: false });
  const mcpWin = await startWinMcp(fake);
  await mcpWin.call('window_list', {}, 30_000).catch(() => null);
  mcpWin.kill();
  const venvCall = fake.log().find((e) => e.kind === 'py' && e.subcmd === '-m venv');
  const versionCall = fake.log().find((e) => e.kind === 'py' && e.subcmd === '--version');
  await report.check('T2-04', '伪 win32 建 venv 时:目录名 venv-win;解释器候选是 PATH 上的 py -3 / python', 'red', () => {
    assert.ok(versionCall, '产品没在 PATH 上试过任何 Windows 候选解释器(py / python):win32 候选表还没加');
    assert.ok(['py', 'python'].includes(versionCall.pyname),
      `探测用的解释器是 ${versionCall.pyname},既不是 py 也不是 python`);
    assert.ok(venvCall, `没观察到 -m venv 调用;桩记录:${JSON.stringify(fake.log().slice(0, 6))}`);
    assert.equal(basename(venvCall.args[1] || ''), 'venv-win', `建出来的目录是 ${venvCall.args[1]},必须是 venv-win`);
  });
}

// ── T2-05 伪 win32 没有 py/python 时:CCGUI_CU_PYTHON 只在 CCGUI_CU_TEST=1 下生效(修前红)──
{
  const hookPath = join(makeWinHome('t2-hook', { venvReady: false }).binDir, 'python');
  const noTest = makeWinHome('t2-hook-a', { venvReady: false });
  const mcpA = await startWinMcp(noTest, { env: { PATH: '/nonexistent-r142', CCGUI_CU_PYTHON: hookPath } });
  await mcpA.call('window_list', {}, 20_000).catch(() => null);
  mcpA.kill();
  const withTest = makeWinHome('t2-hook-b', { venvReady: false });
  const mcpB = await startWinMcp(withTest, { env: { PATH: '/nonexistent-r142', CCGUI_CU_PYTHON: hookPath, CCGUI_CU_TEST: '1' } });
  await mcpB.call('window_list', {}, 20_000).catch(() => null);
  mcpB.kill();
  await report.check('T2-05', 'CCGUI_CU_PYTHON 只在 CCGUI_CU_TEST=1 时被读(生产环境不许被 env 指向任意解释器)', 'red', () => {
    assert.equal(noTest.log().some((e) => e.kind === 'py'),
      false, '没设 CCGUI_CU_TEST 时产品竟然用了 CCGUI_CU_PYTHON(生产环境可被 env 劫持解释器)');
    assert.ok(withTest.log().some((e) => e.kind === 'py' && e.subcmd === '-m venv'),
      `设了 CCGUI_CU_TEST=1 后 CCGUI_CU_PYTHON 仍未被采纳;桩记录:${JSON.stringify(withTest.log().slice(0, 5))}`);
  });
}

// ── T2-06 parseKeySpec 的 win32 虚拟键码(§6.1 T-2)────────────────────
const VK_NAMES = ['vk', 'vkCode', 'virtualKey', 'keyCode', 'code'];
function findVk(spec) {
  for (const name of VK_NAMES) if (typeof spec?.[name] === 'number') return spec[name];
  return null;
}
await report.check('T2-06', "parseKeySpec(raw,'win32') 给出 Windows 虚拟键码;省略第二参时 mac 语义不变", 'red', () => {
  // 先锁"省略第二参 = 老行为"(check-cu-keys 已在守,这里守住跨平台改动别把它带偏)
  assert.equal(mcp.parseKeySpec('ctrl+a').ok, true);
  assert.equal(mcp.parseKeySpec('ctrl+a').unicode, null, 'mac 省略平台参数时的语义不许变');
  assert.equal(mcp.parseKeySpec('cmd+c').ok, true);
  assert.equal(mcp.parseKeySpec('f13').ok, false);

  const VK = { a: 0x41, Z: 0x5a, '7': 0x37, return: 0x0d, enter: 0x0d, escape: 0x1b, esc: 0x1b,
    tab: 0x09, space: 0x20, backspace: 0x08, delete: 0x08,
    arrow_up: 0x26, up: 0x26, arrow_down: 0x28, down: 0x28, arrow_left: 0x25, left: 0x25, arrow_right: 0x27, right: 0x27 };
  const missing = [];
  for (const [raw, vk] of Object.entries(VK)) {
    const spec = mcp.parseKeySpec(raw, 'win32');
    assert.equal(spec.ok, true, `parseKeySpec('${raw}','win32') 应被接受(mac 上它是合法的)`);
    const got = findVk(spec);
    if (got === null) { missing.push(raw); continue; }
    assert.equal(got, vk, `'${raw}' 的 Windows 虚拟键码应为 0x${vk.toString(16)},实际 0x${Number(got).toString(16)}`);
  }
  assert.deepEqual(missing, [],
    `win32 spec 里找不到虚拟键码字段(试过 ${VK_NAMES.join('/')});§6.1 T-2 要求 parseKeySpec(raw,'win32') 出 VK`);
  for (const raw of ['', 'f13', 'cmd+c', 'cmd+cmd+a', 'a+b']) {
    // cmd 是 macOS 修饰符:win32 表里没有它 ⇒ 必须整串拒绝,不许退化成"当作没看见修饰符"
    assert.equal(mcp.parseKeySpec(raw, 'win32').ok, false, `parseKeySpec('${raw}','win32') 必须被拒绝`);
  }
  assert.equal(mcp.parseKeySpec('ctrl+a', 'win32').ok, true, 'ctrl 在 Windows 上必须可用');
});

// ── T2-07 darwin 侧不许沾 win 专属开关(修前绿,且防"顺手把 --method 加给 mac")──
{
  const macH = await import('./q8-helpers/cu-harness.mjs');
  const macFake = macH.makeFakeHome('r142-mac-argv');
  macFake.setGrants({ apps: [macH.GRANTED.bundleId] });
  macFake.setScenario({ windows: { reply: { ok: true, frontmost: null, windows: [macH.grantedWindow()] } } });
  const mac = await macH.startMcp(macFake);
  await mac.call('key', { actionId: 'r142_1', target: macH.TARGET, keys: 'a' }, 30_000).catch(() => null);
  mac.kill();
  const calls = macFake.argv();
  await report.check('T2-07', 'darwin 下 helper 调用不带 win 专属开关(--method/--hwnd)且不出现 release-hold', 'green', () => {
    assert.ok(calls.length > 0, '本机 mac 路径一次 helper 调用都没有(夹具故障,不是产品问题)');
    for (const a of calls) {
      assert.ok(!a.args.includes('--method'),
        `mac 的 ${a.subcmd} 收到了 --method:${JSON.stringify(a.args)}(mac cu_helper.py 的 argparse 没有这个选项,真机会直接报错)`);
      assert.ok(!a.args.includes('--hwnd'), `mac 的 ${a.subcmd} 收到了 --hwnd:${JSON.stringify(a.args)}`);
    }
    assert.equal(calls.some((a) => a.subcmd === 'release-hold'), false,
      'mac 路径出现了 release-hold 子命令(§3.2 B-2 层 4 明确限定 Windows;mac 不许多一次 spawn)');
  });
}

// ── T2-08 PY_DEPS 字面量仍在(cu-harness.mjs:26 正则抠它;R13 硬约束)───────
await report.check('T2-08', 'mcp-server.js 保留 `const PY_DEPS = [...]` 字面量(mac 桩夹具的依赖戳靠它)', 'green', () => {
  assert.ok(MAC_DEPS_MATCH, 'mcp-server.js 里找不到 `const PY_DEPS = [...]` 字面量(cu-harness.mjs:26 会直接抛错,4 个 q8 用例全红)');
  const deps = MAC_DEPS_MATCH[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.ok(deps.includes('mss') && deps.some((d) => d.startsWith('pyobjc-framework-')),
    `PY_DEPS 内容变了:${JSON.stringify(deps)}(mac 依赖表不许动)`);
});

process.exit(report.finish());
