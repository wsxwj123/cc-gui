// 环境软件全量扫描器 —— 补齐 env-check 的两个盲区:
//  ① 装在非默认盘/非常规目录且 PATH 没配(如 Windows 装 D:\nodejs、python.org 装 E:\Python312):
//     原有检测只查 PATH + C 盘环境变量落点,这里枚举所有固定盘 + 各版本管理器落点直扫;
//  ② 版本达标判断(node ≥ 20 硬性,其余仅报告已装版本)。
// 另:不止报"第一个命中",列出机器上**所有**能找到的安装(路径+版本),供面板展开查看。
// claude 不在本文件扫 —— claude-resolver 已是全策略解析(PATH/login-shell/npm-prefix/
// 注册表实时 PATH/固定候选),env-check 路由直接复用 listClaudeInstallsAsync。
//
// 设计:候选生成(buildCandidates)/通配展开(expandPattern)/版本解析(parseVersionOutput)
// 全是纯函数,执行层(exists/readdir/realpath/execOut/getDrives)经 deps 注入 —— Windows 分支
// 在 mac 上没法真跑,单测 mock 执行层覆盖(tests/unit/check-env-scanner.mjs)。
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const execFileP = promisify(execFile);

// node 硬性最低版本:node-pty 等原生模块按新 ABI 构建,且 server 用了 ES2022+ 语法。
export const NODE_MIN_MAJOR = 20;

/** 从 --version 输出提取 x.y.z(python 打 stderr、git 带 .windows.1 后缀、node 带 v 前缀都兼容)。 */
export function parseVersionOutput(out) {
  const m = String(out || '').match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** node 版本是否达标(主版本 ≥ min)。version 可带 v 前缀。 */
export function nodeMeets(version, min = NODE_MIN_MAJOR) {
  const major = parseInt(String(version || '').replace(/^v/, '').split('.')[0], 10);
  return Number.isFinite(major) && major >= min;
}

/** 各工具的可执行文件名(按平台)。 */
export function binNames(tool, platform) {
  const win = platform === 'win32';
  if (tool === 'python') return win ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  return win ? [`${tool}.exe`] : [tool];
}

/**
 * 生成候选安装路径模式(纯函数,不碰文件系统)。返回 [{ pattern, via }],
 * pattern 中目录段可含 `*`(如 Python3*、nvm 版本目录),由 expandPattern 展开。
 * ctx: { platform, home, env, drives } —— drives 仅 Windows,形如 ['C:\\','D:\\']。
 */
export function buildCandidates(tool, { platform, home, env = {}, drives = [] }) {
  const out = [];
  const add = (pattern, via) => out.push({ pattern, via });
  if (platform === 'win32') {
    // 不用 path.join:它按**当前进程平台**选分隔符,纯函数要能在 mac 上被单测(win 路径恒反斜杠)。
    const wj = (...parts) => parts.join('\\');
    const localApp = env.LOCALAPPDATA || wj(home, 'AppData', 'Local');
    const appData = env.APPDATA || wj(home, 'AppData', 'Roaming');
    const programData = env.ProgramData || 'C:\\ProgramData';
    const scoop = wj(home, 'scoop', 'shims');
    const choco = wj(programData, 'chocolatey', 'bin');
    // ── 每个固定盘的常见系统级落点(非 C 盘安装的主要覆盖面)──
    for (const d of drives) {
      const R = /[\\/]$/.test(d) ? d : d + '\\';
      if (tool === 'node') {
        add(`${R}Program Files\\nodejs\\node.exe`, 'drive-scan');
        add(`${R}nodejs\\node.exe`, 'drive-scan');
      }
      if (tool === 'git') {
        add(`${R}Program Files\\Git\\cmd\\git.exe`, 'drive-scan');
        add(`${R}Program Files (x86)\\Git\\cmd\\git.exe`, 'drive-scan');
        add(`${R}Git\\cmd\\git.exe`, 'drive-scan');
      }
      if (tool === 'python') {
        add(`${R}Python3*\\python.exe`, 'drive-scan');          // python.org "全用户+自定义根目录"惯用形态
        add(`${R}Program Files\\Python3*\\python.exe`, 'drive-scan');
      }
    }
    // ── 用户级 / 包管理器落点(路径由环境变量决定,与盘无关)──
    if (tool === 'node') {
      add(wj(appData, 'nvm', 'v*', 'node.exe'), 'nvm-windows');
      add(wj(localApp, 'Volta', 'bin', 'node.exe'), 'volta');
      add(wj(scoop, 'node.exe'), 'scoop');
      add(wj(choco, 'node.exe'), 'chocolatey');
    }
    if (tool === 'python') {
      add(wj(localApp, 'Programs', 'Python', 'Python3*', 'python.exe'), 'user-install'); // python.org 默认(仅当前用户)
      add(wj(localApp, 'Microsoft', 'WindowsApps', 'python.exe'), 'ms-store'); // 未装时是打开商店的假垫片,--version 失败会被过滤
      add(wj(scoop, 'python.exe'), 'scoop');
      add(wj(choco, 'python.exe'), 'chocolatey');
    }
    if (tool === 'git') {
      add(wj(localApp, 'Programs', 'Git', 'cmd', 'git.exe'), 'user-install');
      add(wj(scoop, 'git.exe'), 'scoop');
      add(wj(choco, 'git.exe'), 'chocolatey');
    }
    if (tool === 'uv') {
      add(wj(home, '.local', 'bin', 'uv.exe'), 'astral');
      add(wj(home, '.cargo', 'bin', 'uv.exe'), 'cargo');
      add(wj(scoop, 'uv.exe'), 'scoop');
      add(wj(choco, 'uv.exe'), 'chocolatey');
      add(wj(localApp, 'Microsoft', 'WinGet', 'Links', 'uv.exe'), 'winget');
      add(wj(appData, 'Python', 'Scripts', 'uv.exe'), 'pip-user');
    }
    return out;
  }
  // ── mac / linux ──
  const commonDirs = [
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
  ];
  for (const d of commonDirs) for (const n of binNames(tool, platform)) add(join(d, n), 'common-dir');
  if (tool === 'node') {
    add(join(home, '.nvm', 'versions', 'node', '*', 'bin', 'node'), 'nvm');
    add(join(home, '.volta', 'bin', 'node'), 'volta');
    add(join(home, '.fnm', 'node-versions', '*', 'installation', 'bin', 'node'), 'fnm');
    add(join(home, 'Library', 'Application Support', 'fnm', 'node-versions', '*', 'installation', 'bin', 'node'), 'fnm');
  }
  if (tool === 'python') {
    add(join(home, '.pyenv', 'shims', 'python3'), 'pyenv');   // shim 报版本要真跑 --version,下游正是这么做的
    add('/Library/Frameworks/Python.framework/Versions/*/bin/python3', 'python.org');
  }
  if (tool === 'uv') {
    add(join(home, '.cargo', 'bin', 'uv'), 'cargo');
    add(join(home, '.rye', 'shims', 'uv'), 'rye');
    add(join(home, '.pyenv', 'shims', 'uv'), 'pyenv');
  }
  if (tool === 'git') add('/Library/Developer/CommandLineTools/usr/bin/git', 'xcode-clt');
  return out;
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 展开路径模式中的 `*` 目录段(支持多段,如 nvm 的 versions/node/&#42;/bin/node)。
 * 纯逻辑,readdirFn 注入。展开失败(目录不存在)返回 []。
 */
export function expandPattern(pattern, readdirFn) {
  if (!pattern.includes('*')) return [pattern];
  const sep = pattern.includes('\\') ? '\\' : '/';
  const parts = pattern.split(sep);
  const starI = parts.findIndex((p) => p.includes('*'));
  let baseDir = parts.slice(0, starI).join(sep);
  if (!baseDir) baseDir = sep;                       // unix 根:'/Library/...' 切出首段 ''
  if (/^[A-Za-z]:$/.test(baseDir)) baseDir += sep;   // 'C:' → 'C:\'(裸盘符 readdir 会落到该盘 CWD)
  const rest = parts.slice(starI + 1).join(sep);
  const rx = new RegExp('^' + parts[starI].split('*').map(escapeRx).join('.*') + '$', 'i');
  let entries = [];
  try { entries = readdirFn(baseDir); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!rx.test(e)) continue;
    const joined = (baseDir.endsWith(sep) ? baseDir : baseDir + sep) + e + (rest ? sep + rest : '');
    if (rest.includes('*')) out.push(...expandPattern(joined, readdirFn));
    else out.push(joined);
  }
  return out;
}

/**
 * 存在性过滤 + 按 realpath 去重(软链与目标只算一个;Windows 大小写不敏感,lowercase 归一)。
 * cands: [{ path, via }] → [{ path, via, real }],保留首次发现的入口路径。
 */
export function dedupeByReal(cands, { exists, realpath, platform }) {
  const seen = new Set();
  const out = [];
  for (const c of cands) {
    if (!c.path || !exists(c.path)) continue;
    let real = c.path;
    try { real = realpath(c.path); } catch { continue; }
    const key = platform === 'win32' ? String(real).toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, real });
  }
  return out;
}

// ── 执行层(可注入)────────────────────────────────────────────────
// 非零退出也救回已捕获的输出(老 python 把版本打到 stderr;which -a 未命中非零退出)。
async function execOutDefault(file, args, timeout = 5000) {
  try {
    const { stdout, stderr } = await execFileP(file, args, { timeout });
    return String(stdout || stderr || '').trim();
  } catch (e) {
    const s = String(e?.stdout || '').trim();
    return s || String(e?.stderr || '').trim();
  }
}

// Windows 固定盘枚举(DriveType=3,排除网络/可移动盘 —— 扫网络盘可能秒级挂起)。
// wmic 在 Win11 24H2 已移除,用 Get-CimInstance;精简系统 CIM 不可用时退 Get-PSDrive。
let _drivesCache = null;
export async function getFixedDrivesWin(execOut = execOutDefault) {
  if (process.platform !== 'win32') return [];
  if (_drivesCache) return _drivesCache;
  let out = await execOut('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID"], 8000);
  let drives = String(out).split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[A-Za-z]:$/.test(s)).map((s) => s + '\\');
  if (!drives.length) {
    out = await execOut('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-PSDrive -PSProvider FileSystem).Root'], 8000);
    drives = String(out).split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[A-Za-z]:\\$/.test(s));
  }
  if (!drives.length) drives = ['C:\\'];
  _drivesCache = drives;
  return drives;
}

async function runVersion(bin, d) {
  // Windows 上非 .exe(.cmd/.bat/裸名)不是真可执行文件,须经 cmd.exe /c(与 cli-check 同款)。
  const out = (d.platform === 'win32' && !/\.exe$/i.test(bin))
    ? await d.execOut('cmd.exe', ['/c', bin, '--version'])
    : await d.execOut(bin, ['--version']);
  return parseVersionOutput(out);
}

const defaultDeps = {
  platform: process.platform,
  home: homedir(),
  env: process.env,
  exists: existsSync,
  readdir: readdirSync,
  realpath: realpathSync,
  execOut: execOutDefault,
  getDrives: getFixedDrivesWin,
};

/**
 * 扫描一个工具的**全部**安装:PATH 上所有命中(which -a / where)∪ 固定候选(多盘 +
 * 版本管理器落点)。去重后并行跑 --version(单项 5s 超时,Promise.allSettled 互不拖垮),
 * 只保留能成功报版本的(过滤 Store 假垫片 / 损坏安装)。返回 [{ path, real, via, version }]。
 */
export async function scanToolInstalls(tool, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const cands = [];
  // 1. PATH 全部命中(mac `which -a` / win `where` 本就列出所有)
  for (const n of binNames(tool, d.platform)) {
    const out = d.platform === 'win32'
      ? await d.execOut('where', [n])
      : await d.execOut('which', ['-a', n]);
    for (const line of String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      cands.push({ path: line, via: 'PATH' });
    }
  }
  // 2. 固定候选(Windows 先枚举固定盘)
  const drives = d.platform === 'win32' ? await d.getDrives(d.execOut) : [];
  for (const { pattern, via } of buildCandidates(tool, { platform: d.platform, home: d.home, env: d.env, drives })) {
    for (const p of expandPattern(pattern, d.readdir)) cands.push({ path: p, via });
  }
  // 3. 去重 + 4. 并行取版本
  const uniq = dedupeByReal(cands, d);
  const settled = await Promise.allSettled(uniq.map(async (c) => ({ ...c, version: await runVersion(c.path, d) })));
  return settled
    .filter((s) => s.status === 'fulfilled' && s.value.version)
    .map((s) => s.value);
}

// ── 全量扫描 + 缓存 ──────────────────────────────────────────────
// 面板每次打开都会 fetch;全量扫描要 spawn 十几个进程,5 分钟缓存足够(装完软件用户会点
// "重新检测" = refresh:true 强刷)。绝不阻塞 server 启动 —— 只有 env-check 请求才触发。
let _scanCache = null;
let _scanInflight = null; // 进行中的全量扫描 promise(并发去重,同 claude-resolver 的 _installsInflight)
const SCAN_TTL_MS = 5 * 60 * 1000;
// deps 仅供单测注入(透传 scanToolInstalls),生产不传。
export async function scanAllTools({ refresh = false, deps } = {}) {
  if (!refresh && _scanCache && Date.now() - _scanCache.at < SCAN_TTL_MS) return _scanCache.data;
  // in-flight 去重:面板 mount 与"重新检测"可能并发打进来,缓存 miss 时各 spawn 十几个
  // 进程。第一个存 promise,后到者(含 refresh:true)共享同一轮;完成后清除。
  if (_scanInflight) return _scanInflight;
  _scanInflight = (async () => {
    const tools = ['node', 'git', 'python', 'uv'];
    const results = await Promise.all(tools.map((t) => scanToolInstalls(t, deps).catch(() => [])));
    const data = Object.fromEntries(tools.map((t, i) => [t, results[i]]));
    _scanCache = { at: Date.now(), data };
    return data;
  })();
  try { return await _scanInflight; }
  finally { _scanInflight = null; }
}
