#!/usr/bin/env node
// r63【单测】npm 分发通道纯函数(import 真函数,不 mock):
//   启动器侧(npm/lib/main.js,CGUI_LAUNCHER_TEST 出口):semverGt 只升不降判据、
//     平台映射表、陈旧残留目录名正则;
//   server 侧(server/routes/version-check.js):pickNewestMirrorSnap 取大语义、
//     isInstalledViaNpm marker 前缀判真、resolveUserNpmRegistry 归一化与回落、
//     两处 semverGt 同语义互证;
//   F1 回归闸门(源码锚):pickNewestMirrorSnap 只允许在分支 A 兜底链(resolveGitHubSnap)
//     被调用,分支 B(viaNpm)的 latestVersion 绝不经过它;npmUpgradeCommand 在
//     npmLagsBehind/npmChannelUnknown 时必须缺席。
// Run: node tests/unit/check-npm-channel.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { makeTmpHome } from '../acceptance/r26/lib.mjs';

makeTmpHome('r63-npm-unit'); // version-check 顶层固化 HOME 相关路径,先隔离

const require = createRequire(import.meta.url);
process.env.CGUI_LAUNCHER_TEST = 'r63-unit-exports';
const launcher = require('../../npm/lib/main.js');
const launcherSrc = readFileSync(new URL('../../npm/lib/main.js', import.meta.url), 'utf8');
const vc = await import('../../server/routes/version-check.js');
const vcSrc = readFileSync(new URL('../../server/routes/version-check.js', import.meta.url), 'utf8');

// Windows 主程序名 = mainBinaryName ?? Cargo 包名(**不是** productName)。从事实源推导,
// 别从实现里抄 —— 2026-08-26 前这里锁的是 productName 拼的 "CC-GUI.exe",测试全绿而
// 真机上根本没有这个进程,运行检测恒判"没在跑"、启动直接找不到 exe。
const WIN_MAIN_EXE = (() => {
  const cargo = readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  return (conf.mainBinaryName || (cargo.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1]) + '.exe';
})();

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('ok   - ' + name); }
  catch (e) { failed++; console.log('FAIL - ' + name + '\n       ' + String(e.message || e).split('\n').join('\n       ')); }
}

// ── 启动器:semverGt 只升不降判据 ─────────────────────────────
t('semverGt 数值逐位比较,不是字符串比(0.10.0 > 0.9.0)', () => {
  assert.equal(launcher.semverGt('0.10.0', '0.9.0'), true);
  assert.equal(launcher.semverGt('0.9.0', '0.10.0'), false);
});
t('semverGt 相等不算大(同版本不重装)', () => {
  assert.equal(launcher.semverGt('0.2.353', '0.2.353'), false);
});
t('semverGt 缺失段按 0(0.2.353 > 0.2)', () => {
  assert.equal(launcher.semverGt('0.2.353', '0.2'), true);
  assert.equal(launcher.semverGt('0.2', '0.2.353'), false);
});
t('semverGt 非数字段按 0(0.2.353 > 0.2.abc)', () => {
  assert.equal(launcher.semverGt('0.2.353', '0.2.abc'), true);
});
t('semverGt 剥 v 前缀', () => {
  assert.equal(launcher.semverGt('v0.3.0', '0.2.0'), true);
});
t('两处 semverGt 同语义互证(启动器 vs server 源码,同一组输入)', () => {
  // server 侧 semverGt 未 export(避免动响应面),用源码断言其实现骨架一致
  assert.match(vcSrc, /function semverGt\(a, b\)/);
  assert.match(vcSrc, /for \(let i = 0; i < 3; i\+\+\)/);
});

// ── 启动器:平台映射与残留目录名正则 ─────────────────────────
t('平台映射表 = darwin-arm64 / win32-x64 恰好两项,载荷固定名', () => {
  assert.deepEqual(Object.keys(launcher.PLATFORMS).sort(), ['darwin-arm64', 'win32-x64']);
  assert.equal(launcher.PLATFORMS['darwin-arm64'].payloadName, 'CC-GUI.app.tar.gz');
  assert.equal(launcher.PLATFORMS['win32-x64'].payloadName, 'CC-GUI-setup.exe');
  assert.equal(launcher.PLATFORMS['darwin-arm64'].minBytes, 14 * 1024 * 1024);
  assert.equal(launcher.PLATFORMS['win32-x64'].minBytes, 50 * 1024 * 1024);
});
t('陈旧残留正则:只认 .cc-gui-{npm,old,lock}-<纯数字pid>', () => {
  for (const good of ['.cc-gui-npm-123', '.cc-gui-old-1', '.cc-gui-lock-99999']) {
    assert.ok(launcher.STALE_RE.test(good), good + ' 应匹配');
  }
  for (const bad of ['.cc-gui-lock-abc', '.cc-gui-backup', '.cc-gui-old-', '.cc-gui-npm-12x', 'cc-gui-old-1', '.hidden']) {
    assert.ok(!launcher.STALE_RE.test(bad), bad + ' 不该匹配(误删别人目录)');
  }
});
t('readVersionFile 读不到/坏 JSON → null(视为未安装,不抛)', () => {
  assert.equal(launcher.readVersionFile('/nonexistent/zzz/package.json'), null);
});

// ── 启动器:sweepStale 旧版备份保护(05.5 安全审计修订 —— 重要 1) ──
// 回滚双失败时程序承诺"旧版完整保存在 .cc-gui-old-<pid>,手动改名即可恢复";
// 用户最自然的下一步就是再跑一次 cc-gui,而 sweepStale 是那一趟的第一件事。
// 应用本体不在 = 这份备份是唯一恢复源,不许被清掉。
{
  const mkCase = (names, withApp) => {
    const d = mkdtempSync(path.join(tmpdir(), 'cgui-sweep-'));
    for (const n of names) mkdirSync(path.join(d, n), { recursive: true });
    if (withApp) mkdirSync(path.join(d, 'CC-GUI.app'), { recursive: true });
    launcher.sweepStale(d);
    return readdirSync(d).sort();
  };
  const DEAD = 999999; // 超出 macOS pid 上限,process.kill(pid,0) 必然 ESRCH

  t('sweepStale:应用不存在时,死 pid 的 -old- 备份必须留着(唯一恢复源)', () => {
    assert.deepEqual(mkCase([`.cc-gui-old-${DEAD}`], false), [`.cc-gui-old-${DEAD}`]);
  });
  t('sweepStale:应用不存在也照清 -npm-/-lock-(它们不是恢复源,留着纯占地方)', () => {
    assert.deepEqual(mkCase([`.cc-gui-npm-${DEAD}`, `.cc-gui-lock-${DEAD}`, `.cc-gui-old-${DEAD}`], false),
      [`.cc-gui-old-${DEAD}`]);
  });
  t('sweepStale:应用在位时 -old- 是冗余的 20MB,照清不误', () => {
    assert.deepEqual(mkCase([`.cc-gui-old-${DEAD}`], true), ['CC-GUI.app']);
  });
  t('sweepStale:活 pid 的 -old- 任何情况都不动(别人正在装)', () => {
    assert.deepEqual(mkCase([`.cc-gui-old-${process.pid}`], true), ['.cc-gui-old-' + process.pid, 'CC-GUI.app']);
  });
  t('sweepStale:名字不匹配的目录一律不碰', () => {
    const keep = ['.cc-gui-backup', '.cc-gui-old-abc', 'MyApp.app'];
    assert.deepEqual(mkCase(keep, false), keep.slice().sort());
  });
  t('runMac 装成功后复扫一次(源码锚:被保护的孤儿备份不许永久残留)', () => {
    const after = launcherSrc.indexOf('if (result) fail(result.code, result.msg);');
    const sweeps = [...launcherSrc.matchAll(/^\s*sweepStale\(appsDir\);/gm)].map((m) => m.index);
    assert.ok(after > 0, 'runMac 结构变了,本条锚点失效');
    assert.equal(sweeps.length, 2, 'sweepStale 必须调两次:装前一次(保护)+ 装成功后一次(回收)');
    assert.ok(sweeps[1] > after, '第二次复扫必须在安装成功之后,否则备份保护形同虚设');
  });
}

// ── 启动器:Windows 应用运行检测(05.5 安全审计修订 —— 重要 2) ──
// NSIS 静默安装的 PREINSTALL 钩子会 taskkill /F /T 把运行中的 CC-GUI 连同 node 后端、
// claude CLI 一起强杀。必须先检测、按 mac 同款码 5 拒绝,而不是静默推平用户的长任务。
// 真调 winAppRunning:把 %SystemRoot% 指到临时目录,在 <它>/System32/tasklist.exe 放假 tasklist
// (启动器走绝对路径,不再吃 PATH —— 打桩方式必须跟着走,否则测的是别的东西)。mac 上也能跑到全部分支。
{
  const ROOT0 = process.env.SystemRoot;
  const stub = (body) => {
    const d = mkdtempSync(path.join(tmpdir(), 'cgui-sysroot-'));
    mkdirSync(path.join(d, 'System32'), { recursive: true });
    const exe = path.join(d, 'System32', 'tasklist.exe');
    writeFileSync(exe, '#!/bin/sh\nprintf %s "$*" > "' + d + '/argv"\n' + body);
    chmodSync(exe, 0o755);
    process.env.SystemRoot = d;
    return d;
  };
  // winAppRunning 的 fail-open 分支要往 stdout 打一行,收下来断言,顺带别污染测试输出
  const capture = (fn) => {
    const orig = process.stdout.write.bind(process.stdout);
    let out = '';
    process.stdout.write = (s) => { out += s; return true; };
    try { return { ret: fn(), out }; } finally { process.stdout.write = orig; }
  };

  try {
    t(`winAppRunning:tasklist 输出含 ${WIN_MAIN_EXE} → true(正在运行)`, () => {
      const d = stub(`echo "${WIN_MAIN_EXE}   4242 Console   1   180,000 K"\n`);
      const { ret, out } = capture(() => launcher.winAppRunning());
      assert.equal(ret, true, '应用明明在跑却判成没跑 → 下一步就是 NSIS 强杀它');
      assert.equal(out, '', '命中时不该打 fail-open 提示');
      assert.equal(readFileSync(path.join(d, 'argv'), 'utf8'), `/FI IMAGENAME eq ${WIN_MAIN_EXE} /NH`,
        'tasklist 过滤器必须是真实主程序名(写成 productName 会恒判"没在跑",检测形同虚设)');
    });
    t('winAppRunning:tasklist 说没有匹配任务 → false(照常安装)', () => {
      stub('echo "信息: 没有运行的任务匹配指定标准。"\n');
      const { ret, out } = capture(() => launcher.winAppRunning());
      assert.equal(ret, false, '没在跑还拦着不让装 = 纯骚扰');
      assert.equal(out, '', 'tasklist 正常工作时不该打"无法确认"');
    });
    t('winAppRunning:tasklist 非 0 退出 → fail-open,打提示并继续', () => {
      stub('exit 1\n');
      const { ret, out } = capture(() => launcher.winAppRunning());
      assert.equal(ret, false);
      assert.equal(out, '无法确认 CC-GUI 是否正在运行，继续安装。\n', '与 mac 的 pgrep fail-open 同一句');
    });
    t('winAppRunning:tasklist 根本不存在 → fail-open,不抛(老/裁剪版 Windows)', () => {
      process.env.SystemRoot = mkdtempSync(path.join(tmpdir(), 'cgui-empty-'));
      const { ret, out } = capture(() => launcher.winAppRunning());
      assert.equal(ret, false, '检测工具缺失就把用户永久拦死 = 比不检测更糟');
      assert.equal(out, '无法确认 CC-GUI 是否正在运行，继续安装。\n');
    });
    t('winAppRunning:只认 %SystemRoot%\\System32 的绝对路径,不吃 PATH/当前目录(防同名 exe 劫持)', () => {
      const d = stub(`echo "${WIN_MAIN_EXE}   4242 Console   1   180,000 K"\n`);
      const PATH0 = process.env.PATH;
      const cwd0 = process.cwd();
      const hijack = mkdtempSync(path.join(tmpdir(), 'cgui-hijack-'));
      writeFileSync(path.join(hijack, 'tasklist.exe'), '#!/bin/sh\ntouch "' + hijack + '/PWNED"\n');
      chmodSync(path.join(hijack, 'tasklist.exe'), 0o755);
      try {
        process.env.PATH = hijack + ':' + PATH0;
        process.chdir(hijack); // Windows 裸名 spawn 会先搜当前目录 —— 这里就是那个劫持面
        assert.equal(capture(() => launcher.winAppRunning()).ret, true);
      } finally { process.chdir(cwd0); process.env.PATH = PATH0; }
      assert.ok(!existsSync(path.join(hijack, 'PWNED')), '跑的是当前目录/PATH 里的同名 exe,不是系统 tasklist');
      assert.equal(readFileSync(path.join(d, 'argv'), 'utf8'), `/FI IMAGENAME eq ${WIN_MAIN_EXE} /NH`, '跑的应是系统那份');
    });
  } finally { process.env.SystemRoot = ROOT0; if (ROOT0 === undefined) delete process.env.SystemRoot; }

// ── 启动器:Windows 安装目录以注册表为准(0.2.356) ──
// Tauri 的 installer.nsi 装完把 $INSTDIR 写进卸载项的 InstallLocation,升级时它自己又从
// 注册表读回来决定装哪("装过一次就跟着走")。所以固定的 %LOCALAPPDATA% 两条只是"从没装过"
// 时的默认;把应用装在 D 盘的用户,安装会成功而固定候选一条都不命中 → 复核误报"没找到
// 安装目录"(与 0.2.355 修掉的报错长得一样,原因不同)。
// 打桩:%SystemRoot%/System32/reg.exe 换成假 reg;它的 stdout 由 JS 写进文件再 cat 出来,
// 免掉在 shell 字面量里转义 Windows 路径反斜杠的地狱。
{
  const ROOT0 = process.env.SystemRoot;
  const LOCAL0 = process.env.LOCALAPPDATA;
  // hkcu/hklm: null = 该 hive 查不到(reg 退 1);字符串 = reg query 的完整 stdout
  const stubReg = ({ hkcu = null, hklm = null }) => {
    const d = mkdtempSync(path.join(tmpdir(), 'cgui-sysroot-reg-'));
    mkdirSync(path.join(d, 'System32'), { recursive: true });
    if (hkcu !== null) writeFileSync(path.join(d, 'hkcu.txt'), hkcu);
    if (hklm !== null) writeFileSync(path.join(d, 'hklm.txt'), hklm);
    const exe = path.join(d, 'System32', 'reg.exe');
    writeFileSync(exe, [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "' + d + '/argv"',
      'case "$*" in',
      '  *HKCU*) f="' + d + '/hkcu.txt";;',
      '  *HKLM*) f="' + d + '/hklm.txt";;',
      '  *) exit 1;;',
      'esac',
      '[ -f "$f" ] || exit 1',
      'cat "$f"',
    ].join('\n') + '\n');
    chmodSync(exe, 0o755);
    process.env.SystemRoot = d;
    return d;
  };
  // NSIS 写的是带引号的值(WriteRegStr ... "$\"$INSTDIR$\""),真机 reg query 就长这样
  const regOut = (dir) => '\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CC-GUI\n' +
    '    InstallLocation    REG_SZ    "' + dir + '"\n\n';
  // 固定候选依赖 %LOCALAPPDATA%,钉死它才能断言"第一条是注册表那条"
  const FAKE_LOCAL = path.join(path.sep, 'fake', 'Local');
  const FIXED = [path.join(FAKE_LOCAL, 'CC-GUI'), path.join(FAKE_LOCAL, 'Programs', 'CC-GUI')];

  try {
    process.env.LOCALAPPDATA = FAKE_LOCAL;

    t('winRegisteredDir:读到 InstallLocation → 剥掉 NSIS 写入的双引号', () => {
      stubReg({ hkcu: regOut('D:\\Apps\\CC-GUI') });
      assert.equal(launcher.winRegisteredDir(), 'D:\\Apps\\CC-GUI',
        '不剥引号,后面所有 path.join 都会拼出带引号的废路径');
    });

    t('winCandidates:注册表目录排第一,固定候选殿后(装在 D 盘也能复核到)', () => {
      stubReg({ hkcu: regOut('D:\\Apps\\CC-GUI') });
      const c = launcher.winCandidates();
      assert.equal(c[0], 'D:\\Apps\\CC-GUI', '注册表才是安装器认的目录,必须先查');
      assert.deepEqual(c.slice(1), FIXED, '固定候选不能丢:注册表被清过的机器还得靠它');
    });

    t('winCandidates:注册表值就是默认目录 → 不重复列(错误信息别把同一条打两遍)', () => {
      stubReg({ hkcu: regOut(FIXED[0]) });
      assert.deepEqual(launcher.winCandidates(), FIXED);
    });

    t('winRegisteredDir:HKCU 查不到 → 继续查 HKLM(perMachine / MSI 装的落这儿)', () => {
      const d = stubReg({ hkcu: null, hklm: regOut('C:\\Program Files\\CC-GUI') });
      assert.equal(launcher.winRegisteredDir(), 'C:\\Program Files\\CC-GUI');
      const argv = readFileSync(path.join(d, 'argv'), 'utf8');
      assert.ok(argv.includes('HKCU') && argv.includes('HKLM'), '两个 hive 都要查,实际:\n' + argv);
    });

    t('winRegisteredDir:两个 hive 都没有 → null,候选回落固定两条', () => {
      stubReg({});
      assert.equal(launcher.winRegisteredDir(), null);
      assert.deepEqual(launcher.winCandidates(), FIXED);
    });

    t('winRegisteredDir:reg.exe 根本不存在 → 不抛,回落(裁剪版 Windows / 权限受限)', () => {
      process.env.SystemRoot = mkdtempSync(path.join(tmpdir(), 'cgui-empty-reg-'));
      assert.equal(launcher.winRegisteredDir(), null, '查不到注册表就把用户拦死 = 比不查更糟');
      assert.deepEqual(launcher.winCandidates(), FIXED);
    });

    t('winRegisteredDir:输出里没有 InstallLocation 行 → null(别把表头/DisplayName 当路径)', () => {
      stubReg({ hkcu: '\nHKEY_CURRENT_USER\\Software\\...\\CC-GUI\n    DisplayName    REG_SZ    CC-GUI\n' });
      assert.equal(launcher.winRegisteredDir(), null);
    });

    t('winRegisteredDir:只认 %SystemRoot%\\System32 的绝对路径(防当前目录同名 reg.exe 劫持)', () => {
      const d = stubReg({ hkcu: regOut('D:\\Apps\\CC-GUI') });
      const PATH0 = process.env.PATH;
      const cwd0 = process.cwd();
      const hijack = mkdtempSync(path.join(tmpdir(), 'cgui-hijack-reg-'));
      writeFileSync(path.join(hijack, 'reg.exe'), '#!/bin/sh\ntouch "' + hijack + '/PWNED"\n');
      chmodSync(path.join(hijack, 'reg.exe'), 0o755);
      try {
        process.env.PATH = hijack + ':' + PATH0;
        process.chdir(hijack); // Windows 裸名 spawn 会先搜当前目录 —— 这就是那个劫持面
        assert.equal(launcher.winRegisteredDir(), 'D:\\Apps\\CC-GUI');
      } finally { process.chdir(cwd0); process.env.PATH = PATH0; }
      assert.ok(!existsSync(path.join(hijack, 'PWNED')), '跑的是当前目录里的假 reg.exe');
      assert.ok(readFileSync(path.join(d, 'argv'), 'utf8').includes('InstallLocation'), '跑的应是系统那份');
    });
  } finally {
    process.env.SystemRoot = ROOT0; if (ROOT0 === undefined) delete process.env.SystemRoot;
    process.env.LOCALAPPDATA = LOCAL0; if (LOCAL0 === undefined) delete process.env.LOCALAPPDATA;
  }

  t('winRegisteredDir 走绝对路径拼装(源码锚,同 tasklist)', () => {
    assert.match(launcherSrc, /path\.join\(process\.env\.SystemRoot \|\| 'C:\\\\Windows', 'System32', 'reg\.exe'\)/);
    assert.ok(!/spawnSync\('reg'/.test(launcherSrc), '裸名 reg 又回来了');
  });
  t('winCandidates 把注册表排在固定候选之前(源码锚:顺序反了等于没修)', () => {
    const fn = launcherSrc.slice(launcherSrc.indexOf('function winCandidates'));
    assert.ok(fn.indexOf('winRegisteredDir()') < fn.indexOf('return [registered'),
      'winCandidates 必须先取注册表再拼候选表');
    assert.match(fn, /return \[registered, \.\.\.fixed\]/, '注册表那条必须排第一');
  });
}

  t('winAppRunning 走绝对路径拼装(源码锚:裸名 spawn 在 Windows 先搜当前目录 = 可劫持)', () => {
    assert.match(launcherSrc, /path\.join\(process\.env\.SystemRoot \|\| 'C:\\\\Windows', 'System32', 'tasklist\.exe'\)/);
    assert.ok(!/spawnSync\('tasklist'/.test(launcherSrc), '裸名 tasklist 又回来了');
  });
  t('runWindows:检测到在跑 → 码 5 + 契约文案,且必须在跑安装器之前(源码锚)', () => {
    const gate = launcherSrc.indexOf('if (winAppRunning()) {');
    const msg = launcherSrc.indexOf("fail(5, '检测到 CC-GUI 正在运行，请先退出应用后重试。');");
    const install = launcherSrc.indexOf("spawnSync(payload, ['/S']");
    assert.ok(gate > 0, 'runWindows 里没有运行检测闸门 = 静默强杀运行中的应用');
    assert.ok(msg > gate && msg < install, '码 5 拒绝必须落在闸门内、且在 NSIS 启动之前');
    assert.ok(install > gate, '先装再检测等于没检测');
  });
  t('runWindows:检测排在 S4 只升不降之后(同版本只是打开窗口,不该被要求退出应用)', () => {
    assert.ok(launcherSrc.indexOf('winLaunch(installedDir);') < launcherSrc.indexOf('if (winAppRunning()) {'),
      '判据顺序与 mac 不一致:同版本时报"请先退出"是纯骚扰');
  });
}

// ── server:pickNewestMirrorSnap ─────────────────────────────
const snapOf = (tag, src) => ({ tagName: tag, mirrorSource: src });
t('pickNewestMirrorSnap:空/全 falsy → null', () => {
  assert.equal(vc.pickNewestMirrorSnap([]), null);
  assert.equal(vc.pickNewestMirrorSnap([null, undefined]), null);
  assert.equal(vc.pickNewestMirrorSnap(undefined), null);
});
t('pickNewestMirrorSnap:单个有效 snap 原样返回', () => {
  const s = snapOf('v0.2.353', 'jsdelivr');
  assert.equal(vc.pickNewestMirrorSnap([s, null]), s);
});
t('pickNewestMirrorSnap:两个有效取 semver 更大(带/不带 v 前缀混合)', () => {
  const a = snapOf('v0.2.352', 'npm:registry.npmmirror.com');
  const b = snapOf('0.2.353', 'jsdelivr');
  assert.equal(vc.pickNewestMirrorSnap([a, b]), b);
  assert.equal(vc.pickNewestMirrorSnap([b, a]), b);
});
t('pickNewestMirrorSnap:版本相等返回 npmmirror 那个(国内下载链路一致)', () => {
  const npm = snapOf('v0.2.353', 'npm:registry.npmmirror.com');
  const jsd = snapOf('v0.2.353', 'jsdelivr');
  assert.equal(vc.pickNewestMirrorSnap([jsd, npm]), npm);
  assert.equal(vc.pickNewestMirrorSnap([npm, jsd]), npm);
});
t('pickNewestMirrorSnap:tagName 非法的 snap 被忽略', () => {
  const ok = snapOf('v0.2.353', 'jsdelivr');
  assert.equal(vc.pickNewestMirrorSnap([snapOf('main', 'x'), snapOf('v1.2', 'y'), ok]), ok);
});

// ── server:isInstalledViaNpm(marker 前缀判真) ───────────────
t('isInstalledViaNpm:null/非对象/无 appPath → false', () => {
  assert.equal(vc.isInstalledViaNpm(null, '/a/b'), false);
  assert.equal(vc.isInstalledViaNpm('str', '/a/b'), false);
  assert.equal(vc.isInstalledViaNpm({}, '/a/b'), false);
  assert.equal(vc.isInstalledViaNpm({ appPath: 42 }, '/a/b'), false);
});
t('isInstalledViaNpm:server 目录在 appPath 之下 → true(容忍老 marker 多余字段)', () => {
  const marker = { appPath: '/Users/u/Applications/CC-GUI.app', via: 'npm', package: 'x' };
  assert.equal(vc.isInstalledViaNpm(marker, '/Users/u/Applications/CC-GUI.app/Contents/Resources/_up_/server/routes'), true);
});
t('isInstalledViaNpm:前缀不匹配(dmg 装 /Applications) → false', () => {
  const marker = { appPath: '/Users/u/Applications/CC-GUI.app' };
  assert.equal(vc.isInstalledViaNpm(marker, '/Applications/CC-GUI.app/Contents/Resources/_up_/server/routes'), false);
});
t('isInstalledViaNpm:恰好等于 appPath 本身(无 sep 后缀) → false,同名前缀目录不误判', () => {
  const marker = { appPath: '/Users/u/Applications/CC-GUI.app' };
  assert.equal(vc.isInstalledViaNpm(marker, '/Users/u/Applications/CC-GUI.app'), false);
  assert.equal(vc.isInstalledViaNpm(marker, '/Users/u/Applications/CC-GUI.app2/server'), false);
});
t('isInstalledViaNpm:Windows 大小写不敏感分支存在(源码锚,mac 上跑不到 win32 分支)', () => {
  assert.match(vcSrc, /win32'\) \{\s*app = app\.toLowerCase\(\);\s*dir = dir\.toLowerCase\(\);/);
});

// ── server:resolveUserNpmRegistry 归一化与回落 ──────────────
{
  const url = await vc.resolveUserNpmRegistry(); // 真调 npm config get registry(只读)
  t('resolveUserNpmRegistry 返回合法 http(s) URL 且无尾斜杠', () => {
    assert.match(url, /^https?:\/\/\S+$/);
    assert.ok(!url.endsWith('/'), '尾斜杠必须剥掉(拼包名 URL 会出双斜杠):' + url);
  });
  t('resolveUserNpmRegistry 回落链:取不到时用 npmmirror(源码锚)', () => {
    assert.match(vcSrc, /url = 'https:\/\/registry\.npmmirror\.com';/);
  });
}

// ── F1 回归闸门(调用点硬约束) ───────────────────────────────
t('pickNewestMirrorSnap 全文件恰好 1 个调用点,且在 resolveGitHubSnap(分支 A 兜底)内', () => {
  const calls = [...vcSrc.matchAll(/pickNewestMirrorSnap\(/g)].length;
  const defs = [...vcSrc.matchAll(/function pickNewestMirrorSnap\(/g)].length;
  assert.equal(defs, 1);
  assert.equal(calls - defs, 1, '调用点必须恰好 1 处 —— 分支 B 经过它 = GitHub 版本重新胜出,F1 死循环复活');
  const fnStart = vcSrc.indexOf('async function resolveGitHubSnap()');
  const fnEnd = vcSrc.indexOf("router.get('/version-check'");
  const callAt = vcSrc.indexOf('pickNewestMirrorSnap(', vcSrc.indexOf('const picked'));
  assert.ok(fnStart >= 0 && callAt > fnStart && callAt < fnEnd, '唯一调用点必须落在 resolveGitHubSnap 函数体内');
});
t('分支 B:npm 成功时 latestVersion 取 npm snap(源码锚:snap = npmR.value)', () => {
  assert.match(vcSrc, /snap = npmR\.value/);
});
t('npmUpgradeCommand 门控:npmLagsBehind/npmChannelUnknown 任一为真必须缺席(源码锚)', () => {
  assert.match(vcSrc, /viaNpm && !extra\.npmLagsBehind && !extra\.npmChannelUnknown\s*\?\s*\{ npmUpgradeCommand: 'npm i -g @wsxwj123\/cc-gui@latest' \}/);
});
t('命名撞车防线:fetchNpmChannelGuiLatest 与 fetchNpmLatest 并存且是两个不同函数', () => {
  assert.match(vcSrc, /async function fetchNpmChannelGuiLatest\(/);
  assert.match(vcSrc, /async function fetchNpmLatest\(/);
});

if (failed) { console.log(`\ncheck-npm-channel: ${failed} 条失败`); process.exit(1); }
console.log('\ncheck-npm-channel: all passed (r63)');
process.exit(0);
