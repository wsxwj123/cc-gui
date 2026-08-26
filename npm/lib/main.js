// CC-GUI npm 启动器主体。跑到这里 Node 已确认 >= 20(bin/cc-gui.js 把关),语法不再受限。
// 铁律(INTERFACE r63 §2/§5):
//   - 零网络:安装字节只来自平台分包 tarball,本文件不 require 任何网络模块。
//   - 写盘落点仅限 ~/Applications、NSIS 用户级安装目录、~/.claude-gui(CC-GUI 自有状态目录)。
//   - mac 换入只用 /usr/bin/tar 解包 + fs.rename;失败必须回退,绝不留半成品。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
const REPO_RELEASES = 'https://github.com/wsxwj123/claude-gui/releases';
const REINSTALL_CMD = 'npm i -g @wsxwj123/cc-gui@latest';

// §1.5 平台 → 分包 / 载荷映射(唯一事实源);体积下限见 §2.2 S3(A4 口径)。
const PLATFORMS = {
  'darwin-arm64': {
    pkgName: '@wsxwj123/cc-gui-darwin-arm64',
    payloadName: 'CC-GUI.app.tar.gz',
    minBytes: 14 * 1024 * 1024,
  },
  'win32-x64': {
    pkgName: '@wsxwj123/cc-gui-win32-x64',
    payloadName: 'CC-GUI-setup.exe',
    minBytes: 50 * 1024 * 1024,
  },
};

function fail(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

// 与 server 侧 semverGt 同语义:前三段 parseInt 逐位比较,非数字段/缺失段按 0。
function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// §2.3 已装版本探测:读不到/坏 JSON/无 version 一律视为未安装(null),不报错不中断。
function readVersionFile(p) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

// §2.5 marker:写入失败不影响安装成功判定(码仍为 0)。
function writeMarker(appPath) {
  try {
    const stateDir = path.join(os.homedir(), '.claude-gui');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'npm-install.json'),
      JSON.stringify({ appPath, installedAt: new Date().toISOString() }, null, 2) + '\n'
    );
  } catch (e) {
    process.stdout.write('已安装成功，但更新提示标记写入失败：' + (e.message || e) + '\n');
  }
}

// 码 7:应用已就位但启动失败(mac open 非 0 / win spawn 抛)。
function failLaunch(root, err) {
  fail(7,
    'CC-GUI 已就位（' + root + '），但没能启动起来：' + (err && err.message || err) + '\n' +
    '可以手动打开它；若反复失败，请到 https://github.com/wsxwj123/claude-gui/issues 反馈。');
}

// S7 框架文案(码 6)。
function s7(reason) {
  return 'CC-GUI v' + VERSION + ' 安装失败：' + reason + '\n' +
    '已保留原有版本，可继续使用。\n' +
    '可到 https://github.com/wsxwj123/claude-gui/releases 手动下载安装。';
}

function rmQuiet(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

// ───────────────────────── macOS ─────────────────────────

const MAC_VERSION_REL = 'Contents/Resources/_up_/package.json';

function macInstalledVersion(appRoot) {
  return readVersionFile(path.join(appRoot, MAC_VERSION_REL));
}

// §2.2 陈旧残留自清:名字严格匹配 STALE_RE 且 pid 已死(ESRCH)才删;
// EPERM(活着但无权限)跳过;任何异常吞掉继续 —— 清理失败不该阻断安装。
const STALE_RE = /^\.cc-gui-(npm|old|lock)-(\d+)$/;
function sweepStale(appsDir) {
  try {
    for (const name of fs.readdirSync(appsDir)) {
      const m = STALE_RE.exec(name);
      if (!m) continue;
      let dead = false;
      try { process.kill(parseInt(m[2], 10), 0); } catch (e) { dead = e && e.code === 'ESRCH'; }
      if (dead) rmQuiet(path.join(appsDir, name));
    }
  } catch {}
}

// 其它进程持有的活锁(排除自己的 pid;pid 已死的锁不算 —— sweepStale 已清,这里再兜一层)。
function otherLiveLocks(appsDir) {
  const out = [];
  try {
    for (const name of fs.readdirSync(appsDir)) {
      const m = /^\.cc-gui-lock-(\d+)$/.exec(name);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (pid === process.pid) continue;
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = !(e && e.code === 'ESRCH'); }
      if (alive) out.push(pid);
    }
  } catch {}
  return out;
}

// §2.4 应用运行检测:pgrep -f 带 ^ 行首锚定(不锚定会匹配到并发的另一条 pgrep 命令行,
// 两个终端同时启动会互相误判)。pgrep 不可用/异常 → fail-open 继续安装。
function macAppRunning(appRoot) {
  try {
    const r = spawnSync('/usr/bin/pgrep', ['-f', '^' + appRoot + '/Contents/MacOS/'],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    if (r.error) throw r.error;
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    throw new Error('pgrep exit ' + r.status);
  } catch {
    process.stdout.write('无法确认 CC-GUI 是否正在运行，继续安装。\n');
    return false;
  }
}

function macOpen(appRoot) {
  try {
    execFileSync('/usr/bin/open', ['-a', appRoot], { stdio: 'ignore' });
  } catch (e) { failLaunch(appRoot, e); }
  process.exit(0);
}

// §2.4 安装流程(锁内)。返回 null=成功;返回 {code,msg}=失败(锁由调用方 finally 释放)。
function macInstallLocked(payload, appsDir, appRoot) {
  const tmp = path.join(appsDir, '.cc-gui-npm-' + process.pid);
  const bak = path.join(appsDir, '.cc-gui-old-' + process.pid);
  process.stdout.write('正在安装 CC-GUI v' + VERSION + '…\n');
  fs.mkdirSync(tmp, { recursive: true });
  // 2. 解包(只用 /usr/bin/tar;禁一切复制式换入 —— 会破坏签名 seal 致 FDA 失效)
  const r = spawnSync('/usr/bin/tar', ['-xzf', payload, '-C', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error || r.status !== 0) {
    rmQuiet(tmp);
    return { code: 6, msg: s7('安装包解压失败（' + (r.error ? r.error.message : 'tar 退出码 ' + r.status) + '）') };
  }
  // 3. 找唯一 *.app(不硬编码顶层目录名,productName 改名不该让链路断掉)
  let apps = [];
  try {
    apps = fs.readdirSync(tmp).filter((n) => {
      try { return n.endsWith('.app') && fs.statSync(path.join(tmp, n)).isDirectory(); } catch { return false; }
    });
  } catch {}
  if (apps.length !== 1) {
    rmQuiet(tmp);
    return { code: 6, msg: s7('包内产物损坏（解出 ' + apps.length + ' 个 .app 目录，期望恰好 1 个）') };
  }
  const src = path.join(tmp, apps[0]);
  // 4. 断言 Contents/MacOS 下存在可执行文件
  let hasExec = false;
  try {
    for (const f of fs.readdirSync(path.join(src, 'Contents/MacOS'))) {
      const st = fs.statSync(path.join(src, 'Contents/MacOS', f));
      if (st.isFile() && (st.mode & 0o111)) { hasExec = true; break; }
    }
  } catch {}
  if (!hasExec) {
    rmQuiet(tmp);
    return { code: 6, msg: s7('包内产物损坏（应用缺少可执行文件）') };
  }
  // 5. 旧目录改名备份
  let hadOld = false;
  if (fs.existsSync(appRoot)) {
    try { fs.renameSync(appRoot, bak); hadOld = true; } catch (e) {
      rmQuiet(tmp);
      return { code: 6, msg: s7('无法移开现有应用（' + e.message + '）') };
    }
  }
  // 6. 新目录改名就位;失败回滚;回滚也失败 → 不再重试,文案给出备份绝对路径
  const rollbackFailMsg = () => s7(
    '新版本换入失败，且旧版本没能自动改回原位。\n' +
    '你的旧版本仍完整保存在：' + bak + '\n' +
    '手动恢复：把该目录改名为 ~/Applications/CC-GUI.app 即可继续使用。');
  try {
    fs.renameSync(src, appRoot);
  } catch (e) {
    if (hadOld) {
      try { fs.renameSync(bak, appRoot); } catch {
        rmQuiet(tmp);
        return { code: 6, msg: rollbackFailMsg() };
      }
    }
    rmQuiet(tmp);
    return { code: 6, msg: s7('新版本换入失败（' + e.message + '）') };
  }
  // S6 复核:装进去的版本必须等于包版本,复核不过绝不报成功 —— 回退到旧版
  const got = macInstalledVersion(appRoot);
  if (got !== VERSION) {
    try { fs.renameSync(appRoot, path.join(tmp, 'rejected.app')); } catch { rmQuiet(appRoot); }
    if (hadOld) {
      try { fs.renameSync(bak, appRoot); } catch {
        rmQuiet(tmp);
        return { code: 6, msg: rollbackFailMsg() };
      }
    }
    rmQuiet(tmp);
    return { code: 6, msg: s7('安装后版本复核不符（读到 ' + (got || '未知') + '，期望 ' + VERSION + '）') };
  }
  // 7. 成功才清备份与临时目录
  rmQuiet(tmp);
  if (hadOld) rmQuiet(bak);
  return null;
}

function runMac(payload) {
  const appsDir = path.join(os.homedir(), 'Applications');
  const appRoot = path.join(appsDir, 'CC-GUI.app');
  sweepStale(appsDir); // S0 之后、S4 之前跑一次

  // S4 只升不降:已装版本 >= 包版本 → 不安装,直接打开(open 本身就是"带到前台")
  const installed = macInstalledVersion(appRoot);
  if (installed && !semverGt(VERSION, installed)) {
    process.stdout.write('CC-GUI v' + installed + ' 已是最新，正在打开…\n');
    macOpen(appRoot);
  }

  // S5 排他锁(mkdir 天然原子,锁名带 pid 供陈旧自清按 ESRCH 回收)
  const lockMsg = '另一个 cc-gui 安装正在进行中，请等它结束后再试。\n' +
    '若确认没有其它 cc-gui 在跑，删掉 ~/Applications/.cc-gui-lock-* 后重试。';
  fs.mkdirSync(appsDir, { recursive: true });
  if (otherLiveLocks(appsDir).length) fail(8, lockMsg);
  const lockDir = path.join(appsDir, '.cc-gui-lock-' + process.pid);
  fs.mkdirSync(lockDir);
  // ponytail: 锁名带 pid,两个进程同时通过上面的检查会各自建锁成功(目录名不同不互斥)。
  // 建锁后复扫一次并按 pid 退让(小者继续、大者退出),保证最多一个进入安装区。
  const rivals = otherLiveLocks(appsDir);
  if (rivals.some((p) => p < process.pid)) {
    rmQuiet(lockDir);
    fail(8, lockMsg);
  }

  let result = null;
  try {
    // S5b 应用正在运行(锁之后:先确认自己是唯一安装者,再谈目标应用状态)
    if (macAppRunning(appRoot)) {
      result = {
        code: 5,
        msg: '检测到 CC-GUI 正在运行，无法升级到 v' + VERSION + '。\n' +
          '请先完全退出 CC-GUI（macOS 按 Cmd+Q，注意关闭窗口只是最小化到托盘），然后重新执行 cc-gui。',
      };
    } else {
      result = macInstallLocked(payload, appsDir, appRoot);
    }
  } finally {
    rmQuiet(lockDir); // 无论成功失败都释放锁
  }
  if (result) fail(result.code, result.msg);

  // S6 成功:写 marker → 报告 → 打开
  writeMarker(appRoot);
  process.stdout.write('已安装到 ' + appRoot + '\n');
  if (fs.existsSync('/Applications/CC-GUI.app')) {
    process.stdout.write('提示：/Applications 下另有一份 CC-GUI。npm 安装的这份在 ~/Applications，两者互不影响；同时打开会争用同一个端口，建议只开一份。\n');
  }
  macOpen(appRoot);
}

// ───────────────────────── Windows ─────────────────────────
// 候选目录基于 %LOCALAPPDATA%(Tauri NSIS 默认 currentUser 落点;perMachine 目录不可能命中,
// 已按 A3 删除)。版本文件相对路径 resources\_up_\package.json 待 M0-b 真机取证收敛。

function winCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [path.join(local, 'CC-GUI'), path.join(local, 'Programs', 'CC-GUI')];
}

function winInstalledDirVersion(dir) {
  return readVersionFile(path.join(dir, 'resources', '_up_', 'package.json'));
}

function winLaunch(dir) {
  const exe = path.join(dir, 'CC-GUI.exe');
  if (!fs.existsSync(exe)) {
    fail(4, '安装目录里没找到 CC-GUI.exe：' + dir + '\n' +
      '请重新安装：npm i -g @wsxwj123/cc-gui@latest，或从 GitHub Release 下载安装包。');
  }
  try {
    // 不经 shell 直接 spawn 绝对路径;detached+unref 让终端立刻归还用户
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } catch (e) { failLaunch(dir, e); }
  process.exit(0);
}

function runWindows(payload) {
  // S4:候选目录里第一个能读出版本的即已装应用
  let installedDir = null;
  let installed = null;
  for (const dir of winCandidates()) {
    const v = winInstalledDirVersion(dir);
    if (v) { installedDir = dir; installed = v; break; }
  }
  if (installed && !semverGt(VERSION, installed)) {
    process.stdout.write('CC-GUI v' + installed + ' 已是最新，正在打开…\n');
    winLaunch(installedDir);
  }

  // S6:静默安装(仅传 /S,目录交给 NSIS 沿用/决定);安装原子性由 NSIS 承担。
  // 超时 300000ms(5 分钟)防不可见对话框把进程挂死(PLAN R2)。
  // Windows 不取排他锁:NSIS 自己拒绝并发实例,也没有 mac 那种改名换目录的中间态。
  process.stdout.write('正在安装 CC-GUI v' + VERSION + '…\n');
  const r = spawnSync(payload, ['/S'], { timeout: 300000, windowsHide: true, stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    fail(6, s7('安装器执行失败（' + (r.error ? r.error.message : '退出码 ' + r.status) + '）'));
  }
  // 复核:第一个"版本文件存在且 version === 包版本"的候选目录;探测不到绝不报成功
  const dirs = winCandidates();
  let target = null;
  for (const dir of dirs) {
    if (winInstalledDirVersion(dir) === VERSION) { target = dir; break; }
  }
  if (!target) {
    fail(6, s7('安装器已退出但没找到安装目录（已检查：' + dirs.join('、') + '）'));
  }
  writeMarker(target);
  process.stdout.write('已安装到 ' + target + '\n');
  winLaunch(target);
}

// ───────────────────────── 入口 ─────────────────────────

function main() {
  // S1 平台/架构支持判定(§1.5 表)
  const plat = PLATFORMS[process.platform + '-' + process.arch];
  if (!plat) {
    fail(2, 'CC-GUI 暂不支持当前系统：' + process.platform + '/' + process.arch + '。\n' +
      '目前支持：macOS（Apple Silicon）与 Windows（x64）。');
  }
  // S2 平台分包解析(分包无 exports 字段,require.resolve 直达其 package.json)
  let platPkgJson = null;
  try {
    platPkgJson = require.resolve(plat.pkgName + '/package.json');
  } catch {
    fail(4, '没找到当前平台的安装包（' + plat.pkgName + '）。\n' +
      '可能原因有两个：\n' +
      '  1. 安装时跳过了可选依赖 —— 请重装：\n' +
      '       ' + REINSTALL_CMD + '\n' +
      '     若仍失败，先执行 npm cache clean --force 再重装。\n' +
      '  2. 国内镜像还没同步到这个版本（通常十几分钟内完成）—— 过一会儿再重装，\n' +
      '     或直接从 ' + REPO_RELEASES + ' 下载安装包。');
  }
  // S3 载荷存在性 + 体积下限(< 下限判损坏;恰好等于放行)
  const payload = path.join(path.dirname(platPkgJson), plat.payloadName);
  let st = null;
  try { st = fs.statSync(payload); } catch {}
  if (!st || !st.isFile() || st.size < plat.minBytes) {
    fail(4, '安装包文件缺失或不完整：' + payload + '\n请重装：' + REINSTALL_CMD);
  }

  if (process.platform === 'darwin') runMac(payload);
  else runWindows(payload);
}

// 可测性出口:单测置 CGUI_LAUNCHER_TEST=r63-unit-exports 后 require 本文件拿纯函数,
// 不执行主流程。值取冷僻串而非 '1'(判官建议 6:用户环境误设 =1 之类常见值时,
// cc-gui 不得静默 no-op 退 0)。正常被 bin/cc-gui.js require 时行为不变。
if (process.env.CGUI_LAUNCHER_TEST === 'r63-unit-exports') {
  module.exports = { semverGt, readVersionFile, PLATFORMS, STALE_RE };
} else {
  try {
    main();
  } catch (e) {
    // 通用兜底(码 1):不吞任何异常,原样带出错误信息
    process.stderr.write('CC-GUI 启动失败：' + (e && e.message || e) + '\n' +
      '请到 https://github.com/wsxwj123/claude-gui/issues 反馈，附上上面这行信息。\n');
    process.exit(1);
  }
}
