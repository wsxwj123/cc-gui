// computer use 的共享配置层:MCP 进程(由 CLI spawn)与 GUI 后端(server route)都读这一份。
//
// 为什么 runtime 目录不直接用 os.homedir():GUI 后端与 CLI 常由不同 launcher 启动,
// 两者的 $HOME 可能不同(打包后 tauri 启动的后端、终端里的 CLI)。授权/运行时/截图目录
// 必须落在同一个用户级位置,否则"面板里授权了、MCP 却说不允许"。所以优先用
// os.userInfo().homedir(登录用户在 /etc/passwd 里的家目录,不受 $HOME 影响)。
//
// 平台分派(r142):本文件是"平台相关的一切"的唯一落点 —— 运行时目录布局(venv-win/Scripts)、
// 依赖表、解释器候选、能力表。两个平台的行为差异必须在**纯函数**里,便于 mac 上直接单测
// (见 tests/unit/check-cu-{platform-dispatch,capabilities-platform,uia-cache}.mjs)。
import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir, userInfo } from 'os';
import { join } from 'path';

export const RUNTIME_DIR = cuRuntimeDir();
export const SHOT_DIR = join(RUNTIME_DIR, 'shots');
export const GRANTS_FILE = join(RUNTIME_DIR, 'grants.json');
// UIA 可用性结论的磁盘缓存(§2.5③):"comtypes/UIA 能不能用"只有 Python 侧知道,而
// capabilityReport 是同步纯函数(Express 请求里不能 spawn)⇒ 探测结果落在磁盘,面板读缓存。
export const UIA_CACHE_FILE = join(RUNTIME_DIR, 'uia-capability.json');

function cuRuntimeDir() {
  let home = null;
  try {
    home = userInfo().homedir;
  } catch {
    home = null;
  }
  return join(home || homedir(), '.claude-gui', 'cu-runtime');
}

// ── 平台相关的运行时路径(纯函数) ───────────────────────────────────────
// macOS 保持 v1 的布局(venv / bin/python3 / venv.stamp)一字不改;
// Windows 是 venv-win / Scripts\python.exe / venv-win.stamp(FORENSICS ② #8)。
export function venvDirFor(platformName = process.platform) {
  return join(RUNTIME_DIR, platformName === 'win32' ? 'venv-win' : 'venv');
}

export function venvPyFor(platformName = process.platform) {
  return platformName === 'win32'
    ? join(venvDirFor('win32'), 'Scripts', 'python.exe')
    : join(venvDirFor(platformName), 'bin', 'python3');
}

export function stampFileFor(platformName = process.platform) {
  return join(RUNTIME_DIR, platformName === 'win32' ? 'venv-win.stamp' : 'venv.stamp');
}

export const VENV_DIR = venvDirFor();
export const VENV_PY = venvPyFor();
export const STAMP_FILE = stampFileFor();

// ── 依赖表与依赖戳(纯函数) ─────────────────────────────────────────────
// ⚠️ 与 mcp-server.js 里的 `const PY_DEPS = [...]` / `const PY_DEPS_WIN = [...]` 字面量**必须逐项一致**:
// 那两行是测试契约(tests/unit/q8-helpers/cu-harness.mjs:27 与 check-cu-uia-cache.mjs 用正则抠它算戳),
// 形态不能动;本文件这份是给"不看 mcp-server 源码的读路径"(uia 缓存的 depsStamp)用的。
// 两边不一致时 check-cu-uia-cache 的 T8-02/T8-04 会直接红(它按 mcp-server 源码算戳,拿这里的读路径验证)。
export const PY_DEPS_MAC = ['mss', 'pyautogui', 'pyobjc-framework-Cocoa', 'pyobjc-framework-Quartz', 'pyobjc-framework-ApplicationServices'];
export const PY_DEPS_WIN = ['mss', 'Pillow', 'comtypes>=1.4.0'];

export function pyDepsFor(platformName = process.platform) {
  return platformName === 'win32' ? PY_DEPS_WIN : PY_DEPS_MAC;
}

export function depsStampFor(platformName = process.platform) {
  return createHash('sha256').update(pyDepsFor(platformName).join('|')).digest('hex');
}

// ── Python 解释器候选(纯函数;探测在 findPython3) ───────────────────────
// CCGUI_CU_PYTHON 是测试钩子,只在 CCGUI_CU_TEST=1 时被读 —— 生产环境里不许由 env
// 指向任意解释器(那等于把"跑哪份代码"交给环境变量)。
export function pythonCandidates(platformName = process.platform) {
  const out = [];
  if (process.env.CCGUI_CU_TEST === '1' && process.env.CCGUI_CU_PYTHON) {
    out.push({ cmd: process.env.CCGUI_CU_PYTHON, args: [] });
  }
  if (platformName === 'win32') {
    // python.org 安装版 / Microsoft Store 版都提供 python.exe;py launcher 用 -3 锁主版本。
    out.push({ cmd: 'python', args: [] }, { cmd: 'py', args: ['-3'] }, { cmd: 'py', args: [] });
    return out;
  }
  // HOME 在 Windows 上通常没有(那边是 USERPROFILE),旧写法回落 '/tmp' 在 win32 不存在。
  // 用 os.homedir() 兜底:它在两个平台都给真实家目录;`|| '/tmp'` 那层已删——三源全空时
  // homedir() 仍会给值,留着只会让跨平台扫描继续把它当"硬编码 /tmp"命中。
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  for (const cmd of ['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', `${home}/.pyenv/shims/python3`]) {
    out.push({ cmd, args: [] });
  }
  return out;
}

/** 逐个试候选(带 --version 探测),返回第一个能跑起来的 {cmd,args};都没有返回 null。 */
export function findPython3(platformName = process.platform) {
  for (const candidate of pythonCandidates(platformName)) {
    try {
      const r = spawnSync(candidate.cmd, [...candidate.args, '--version'],
        { timeout: 5000, windowsHide: true });
      if (r.status === 0) return candidate;
    } catch { /* 试下一个 */ }
  }
  return null;
}

function run(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* 已退出 */ } reject(new Error(`命令超时: ${file} ${args[0]}`)); }, timeoutMs);
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${file} 退出码 ${code}: ${(stderr || stdout).slice(-400)}`));
    });
  });
}

/**
 * 建运行时:venv + pip install(主源失败退清华镜像)。
 * 从 mcp-server 抽到这里是为了让 GUI 路由(/prepare)能复用 —— `mcp-server.js` 一被 import 就会
 * 执行 `createInterface({input: process.stdin})`,绝不能在 Express 进程里 import 它。
 *
 * stamp 落盘走 `onReady` 回调:mcp-server 侧因此保留 `writeFileSync(STAMP_FILE, …)` 的字面形态
 * (check-q8-atomic-write 的 Q8-09c allowlist 键是精确串 `server/computer-use/mcp-server.js::STAMP_FILE`)。
 */
export async function ensureRuntime({
  platformName = process.platform,
  deps = pyDepsFor(platformName),
  stamp = depsStampFor(platformName),
  findPython = findPython3,
  onReady = null,
} = {}) {
  const venvDir = venvDirFor(platformName);
  const venvPy = venvPyFor(platformName);
  const stampFile = stampFileFor(platformName);
  if (existsSync(venvPy) && existsSync(stampFile)
    && readFileSync(stampFile, 'utf8').trim() === stamp) {
    return { ready: true, created: false, venvPy, venvDir, stampFile };
  }
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const py = findPython(platformName);
  if (!py) {
    throw new Error('找不到 Python(需要 3.9+):macOS 请装 python3 并确保在 PATH;Windows 请装 python.org 版或 py launcher 并确保 python/py 在 PATH。');
  }
  // venvPy 可能是指向 base 解释器的符号链接:Python 升级后会悬空(existsSync=false)
  // 而 pyvenv.cfg 还在 —— 只判 cfg 会跳过重建,直接走到 pip 必 ENOENT。
  if (!existsSync(venvPy) || !existsSync(join(venvDir, 'pyvenv.cfg'))) {
    await run(py.cmd, [...py.args, '-m', 'venv', venvDir], 180_000);
  }
  await run(venvPy, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...deps], 600_000)
    .catch(async (firstErr) => {
      await run(venvPy, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check',
        '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', ...deps], 600_000)
        .catch((mirrorErr) => { throw new Error(`pip 主源与镜像均失败: ${mirrorErr.message} (主源: ${firstErr.message})`); });
    });
  if (typeof onReady === 'function') onReady(stamp);
  else writeStampFile(stamp, platformName);
  return { ready: true, created: true, venvPy, venvDir, stampFile };
}

/** 依赖戳落盘(临时文件 + rename,与 writeGrants 同款原子替换)。 */
export function writeStampFile(stamp, platformName = process.platform) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const tmp = `${stampFileFor(platformName)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${stamp}\n`);
  renameSync(tmp, stampFileFor(platformName));
}

// ── UIA 可用性缓存(§2.5③④) ────────────────────────────────────────────
/**
 * 读缓存(同步、纯读盘、绝不 spawn)。
 * 返回 { uia, checked, comtypes?, reason? }:
 *   checked=true  = 有一份**依赖戳对得上**的探测结论(此时 uia 才有意义);
 *   checked=false = 尚未探测/缓存损坏/依赖表变了 ⇒ uia 恒 false,reason 说明原因。
 * 用 checked 区分"探测结论是 false"与"根本没有结论",是能力表的阶段 A/阶段 B 的唯一分界(见 capabilityReport)。
 *
 * ⚠️ 依赖戳一律按**当前进程平台**(process.platform)算,不看 capabilityReport 的 platformName 入参:
 * platformName 只是给纯函数测试注入的;缓存文件是"本机磁盘上的既有结论",它的有效性只跟本机依赖表有关。
 */
export function readUiaCapability() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(UIA_CACHE_FILE, 'utf8'));
  } catch {
    return { uia: false, checked: false, reason: '尚未探测(UIA 可用性缓存不存在或不可读)' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { uia: false, checked: false, reason: '缓存不是对象,已忽略(尚未探测)' };
  }
  if (raw.version !== 1) {
    return { uia: false, checked: false, reason: `缓存版本 ${JSON.stringify(raw.version)} 不认识(尚未探测)` };
  }
  if (typeof raw.depsStamp !== 'string' || raw.depsStamp !== depsStampFor(process.platform)) {
    return { uia: false, checked: false, reason: '依赖表变了或缓存来自另一个平台(重装/切换平台即失效),需要重新探测' };
  }
  return {
    uia: raw.uia === true,
    checked: true,
    comtypes: typeof raw.comtypes === 'string' ? raw.comtypes : null,
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : null,
  };
}

/** 写缓存(临时文件 + rename:与 writeGrants 同款原子替换,并发读到的永远是完整 JSON)。 */
export function writeUiaCapability({ uia, comtypes = null } = {}) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const body = {
    version: 1,
    uia: uia === true,
    checkedAt: new Date().toISOString(),
    comtypes: typeof comtypes === 'string' ? comtypes : null,
    depsStamp: depsStampFor(process.platform),
  };
  const tmp = `${UIA_CACHE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  renameSync(tmp, UIA_CACHE_FILE);
  return body;
}

// ── 能力状态(合同第 9 段:不得含糊) ────────────────────────────────────
// available / unsupported / unverified + reason(非 available 必须给 reason)。
// 锁屏路径当前没有已验证的授权组件接口,只能 disabled/unverified。
const SCREEN_SCOPE_REASON = '需要单独授权「允许主屏全部可见内容」后才允许主屏截图;当前只能通过 POST /api/computer-use/grants 设置 screenScope:true,图形界面尚未提供该入口';
const LOCKSCREEN_REASON = '锁屏持续/遮蔽显示器需要已验证的授权组件,当前无公开可复用接口;未证明前不声明可用';
const SCREENSHOT_TARGET_REASON = '按应用/窗口截图尚未在真机验证;能力未证明前不返回前台其他应用的画面顶替';
const LOCKSCREEN_DISABLED = {
  state: 'disabled',
  reason: '本构建不提供锁屏操控;显式启用锁屏需要独立授权组件,尚未验证(见 capabilityReport.lockscreen)',
};

function macCapabilities() {
  return {
    screenshot: { status: 'available' },
    screenshotTarget: { status: 'unverified', reason: SCREENSHOT_TARGET_REASON },
    windowList: { status: 'available' },
    cursorPosition: { status: 'available' },
    backgroundClick: { status: 'available' },
    backgroundType: { status: 'available' },
    backgroundKey: { status: 'available' },
    screenScope: { status: 'unverified', reason: SCREEN_SCOPE_REASON },
    lockscreen: { status: 'unverified', reason: LOCKSCREEN_REASON },
  };
}

// Windows 阶段 A:只读(截图/窗口/光标)+ 输入**未声明**。
// 什么时候是阶段 A:UIA 可用性还没有结论(缓存缺失/损坏/依赖表变了)。"没有结论"不等于
// "不可用",但按本仓一贯口径(见 screenshotTarget 的 unverified),未证明的能力不对外声明。
const WIN_INPUT_PENDING_REASON = 'Windows 后台输入通道尚未在本机建立可用性结论(先在卡片上点「准备环境」跑一次 UIA 探测);结论出来之前不声明输入可用';
const WIN_FOREGROUND_PENDING_REASON = '全局投递(SendInput)尚未声明可用:它只在你显式同意后才会被使用,而且会移动真实光标、把目标窗口切到前台';
const WIN_BACKGROUND_KEY_REASON = 'UIA 没有"投递组合键"的 pattern;消息投递对组合键基本无效';
const WIN_FOREGROUND_REASON = 'SendInput 全局投递(仅在你显式同意后):会移动真实光标、把目标窗口切到前台,Type 无法读回验证(verification 为 unknown)';

function winCapabilities({ uia, declared }) {
  const base = {
    screenshot: { status: 'available' },
    screenshotTarget: {
      status: 'unverified',
      reason: '按应用/窗口截图在 Windows 上未证明保真(PrintWindow 对 GPU 合成/Chromium 常返回黑帧);能力未证明前不返回前台其他应用的画面顶替',
    },
    windowList: { status: 'available' },
    cursorPosition: { status: 'available' },
    screenScope: { status: 'unverified', reason: SCREEN_SCOPE_REASON },
    lockscreen: { status: 'unverified', reason: LOCKSCREEN_REASON },
  };
  if (!declared) {
    return {
      ...base,
      backgroundClick: { status: 'unsupported', reason: WIN_INPUT_PENDING_REASON },
      backgroundType: { status: 'unsupported', reason: WIN_INPUT_PENDING_REASON },
      backgroundKey: { status: 'unsupported', reason: WIN_INPUT_PENDING_REASON },
      foregroundClick: { status: 'unsupported', reason: WIN_FOREGROUND_PENDING_REASON },
      foregroundType: { status: 'unsupported', reason: WIN_FOREGROUND_PENDING_REASON },
      foregroundKey: { status: 'unsupported', reason: WIN_FOREGROUND_PENDING_REASON },
    };
  }
  return {
    ...base,
    backgroundClick: uia
      ? { status: 'available', coverage: 'partial',
        reason: 'UI Automation 元素级操作 + 消息投递兜底:不抢前台、不动光标。传统 Win32/WPF 覆盖好;Chromium/Electron 需 accessibility 按需开启(首次可能失败,重试一次);Java/自绘界面/安全桌面覆盖不到' }
      : { status: 'available', coverage: 'narrow',
        reason: 'UIA 不可用(comtypes 未就绪),仅剩消息投递:只对传统 Win32 控件有效,浏览器类应用基本无效' },
    backgroundType: uia
      ? { status: 'available', coverage: 'partial',
        reason: '经 ValuePattern 直写控件值,不抢前台;自绘/无 UIA 元素的界面覆盖不到' }
      : { status: 'available', coverage: 'narrow',
        reason: 'UIA 不可用,仅剩 WM_CHAR 逐字符投递:只对传统 Win32 编辑控件有效' },
    backgroundKey: { status: 'unsupported', reason: WIN_BACKGROUND_KEY_REASON },
    foregroundClick: { status: 'available', degradation: 'global', reason: WIN_FOREGROUND_REASON },
    foregroundType: { status: 'available', degradation: 'global', reason: WIN_FOREGROUND_REASON },
    foregroundKey: { status: 'available', degradation: 'global', reason: WIN_FOREGROUND_REASON },
  };
}

function unsupportedCapabilities(platformName) {
  const reason = `computer use 的执行层目前只在 macOS 与 Windows 上提供;当前平台(${platformName})没有实现`;
  return {
    screenshot: { status: 'unsupported', reason },
    screenshotTarget: { status: 'unverified', reason: SCREENSHOT_TARGET_REASON },
    windowList: { status: 'unsupported', reason },
    cursorPosition: { status: 'unsupported', reason },
    backgroundClick: { status: 'unsupported', reason },
    backgroundType: { status: 'unsupported', reason },
    backgroundKey: { status: 'unsupported', reason },
    screenScope: { status: 'unverified', reason: SCREEN_SCOPE_REASON },
    lockscreen: { status: 'unverified', reason: LOCKSCREEN_REASON },
  };
}

/**
 * 能力表。mac 分支与 v1 逐字节相同(新键只在 win32 出现)。
 * `uia` 入参显式注入(true/false)用于纯函数测试;省略时读磁盘缓存(T-1 仍是纯函数测试,T-8 走真实读路径)。
 */
export function capabilityReport({ platformName = process.platform, uia = undefined } = {}) {
  if (platformName === 'darwin') {
    return { capabilities: macCapabilities(), lockscreen: LOCKSCREEN_DISABLED };
  }
  if (platformName !== 'win32') {
    return { capabilities: unsupportedCapabilities(platformName), lockscreen: LOCKSCREEN_DISABLED };
  }
  const injected = uia !== undefined && uia !== null;
  const probe = injected ? { uia: uia === true, checked: true } : readUiaCapability();
  return {
    capabilities: winCapabilities({ uia: probe.uia === true, declared: probe.checked === true }),
    lockscreen: LOCKSCREEN_DISABLED,
  };
}

/**
 * 输入模式五态(由能力表推导,与 tests/unit/check-cu-capabilities-platform.mjs 的映射表同源):
 *   background              输入全走后台(macOS)
 *   background-partial      后台优先(UIA 元素级 → 消息投递),部分应用覆盖不到(Windows,UIA 就绪)
 *   background-message-only 仅消息投递(Windows,UIA 不可用)
 *   global-only             后台通道完全不可用,只有显式同意后才走全局
 *   none                    不支持输入(Windows 尚未建立结论、其他平台)
 */
export function inputModeFor(capabilities, platformName = process.platform) {
  if (platformName === 'darwin') return 'background';
  if (platformName !== 'win32') return 'none';
  const click = capabilities?.backgroundClick || {};
  const type = capabilities?.backgroundType || {};
  const fg = capabilities?.foregroundClick || {};
  const anyBackground = click.status === 'available' || type.status === 'available';
  if (!anyBackground) return fg.status === 'available' ? 'global-only' : 'none';
  if (click.coverage === 'partial' || type.coverage === 'partial') return 'background-partial';
  if (click.coverage === 'narrow' || type.coverage === 'narrow') return 'background-message-only';
  return 'background';
}

// ── 授权(按应用 + 全屏范围) ────────────────────────────────────────────
// 存储形态:
// { version:1, screenScope:{granted:bool, grantedAt}, apps:{ [bundleId]: {name, grantedAt} } }
export const EMPTY_GRANTS = { version: 1, screenScope: { granted: false, grantedAt: null }, apps: {} };

export function readGrants() {
  try {
    const raw = JSON.parse(readFileSync(GRANTS_FILE, 'utf8'));
    return normalizeGrants(raw);
  } catch {
    return { version: 1, screenScope: { granted: false, grantedAt: null }, apps: {} };
  }
}

function normalizeGrants(raw) {
  const out = { version: 1, screenScope: { granted: false, grantedAt: null }, apps: {} };
  if (raw && typeof raw === 'object') {
    if (raw.screenScope && raw.screenScope.granted === true) {
      out.screenScope = { granted: true, grantedAt: raw.screenScope.grantedAt || null };
    }
    for (const [bundleId, entry] of Object.entries(raw.apps || {})) {
      if (!bundleId || typeof entry !== 'object' || entry === null) continue;
      out.apps[bundleId] = { name: typeof entry.name === 'string' ? entry.name : bundleId,
        grantedAt: entry.grantedAt || null };
    }
  }
  return out;
}

export function writeGrants(next) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const tmp = `${GRANTS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalizeGrants(next), null, 2)}\n`);
  renameSync(tmp, GRANTS_FILE); // 原子替换:并发读到的永远是完整 JSON
  return readGrants();
}

/** 单次授权变更。bundleId=null 表示只改全屏范围。granted=false 即撤销。 */
export function setGrant({ bundleId = null, name = null, granted = true, screenScope = null } = {}) {
  const current = readGrants();
  const next = { ...current, apps: { ...current.apps }, screenScope: { ...current.screenScope } };
  if (screenScope !== null) {
    next.screenScope = screenScope
      ? { granted: true, grantedAt: new Date().toISOString() }
      : { granted: false, grantedAt: null };
  }
  if (bundleId) {
    if (granted) {
      next.apps[bundleId] = { name: name || current.apps[bundleId]?.name || bundleId,
        grantedAt: new Date().toISOString() };
    } else {
      delete next.apps[bundleId];
    }
  }
  return writeGrants(next);
}

export function appGranted(grants, bundleId) {
  return Boolean(bundleId && grants.apps && grants.apps[bundleId]);
}

export function screenScopeGranted(grants) {
  return Boolean(grants.screenScope && grants.screenScope.granted === true);
}

export function runtimeReady() {
  return existsSync(VENV_PY) && existsSync(STAMP_FILE);
}
