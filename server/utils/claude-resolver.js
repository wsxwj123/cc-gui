// 统一的 claude CLI 二进制解析器 —— 全 server 唯一入口。
//
// 背景:Finder/资源管理器启动的 app,后端进程继承的 PATH 是精简版
// (/usr/bin:/bin:/usr/sbin:/sbin),不含 ~/.local/bin、/opt/homebrew/bin 等用户
// 安装目录 → 只靠 PATH 找 claude 必失败;终端起 dev server 时 PATH 齐全复现不了。
// 此前解析逻辑散落四处(cli-check / version-check 的 probeKnownClaude / chat.js 的
// resolveWinClaude / mcp.js runClaude),口径不一:检测面板靠候选兜底能"检测到",
// 聊天/MCP/agents 只靠 PATH → nvm 等安装位"检测到却用不了"。统一收口到这里。
//
// 解析顺序:PATH(which/where)→ login shell(非 Win)→ npm 全局 prefix → 固定候选
// (原生安装/homebrew/npm 自定义 prefix/volta/pnpm/yarn/nvm/fnm/scoop 等)。
// 命中即缓存(按 mtime + 存在性失效);未命中短 TTL 负缓存,装好后无需重启即可生效。
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
const execFileP = promisify(execFile);
// 同 safeExec 但**异步**(不阻塞事件循环)。非零退出也救回已捕获的 stdout(同 safeExecStdout)。
// 仅用于 listClaudeInstallsAsync ——那是唯一"每次全量扫所有策略"的重活,同步版会在 Windows
// 上以 cmd/PowerShell 冷启动几秒卡死整个单线程 Express(chat/provider 全冻,用户报"到处 connecting")。
// r110:extra 用来透传 claudeExecSpec/winCmdSpawnSpec 给出的 spawn 选项(Windows 的
// windowsVerbatimArguments)。默认空对象,既有三参调用行为不变。
async function safeExecAsync(file, args, timeout = 5000, extra = {}) {
  try { const { stdout } = await execFileP(file, args, { timeout, ...extra }); return String(stdout).trim(); }
  catch (e) { return e?.stdout ? String(e.stdout).trim() : ''; }
}
import { winCmdSpawnSpec } from './win-cmd.js';
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync, openSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const isWin = process.platform === 'win32';

let _cache = null;   // { path, via, mtimeMs } | null
let _missAt = 0;     // 上次全部策略落空的时间戳(负缓存)
const MISS_TTL_MS = 15_000;

// 用户手动指定用哪个 claude(设置→更新页"切换")。多个安装并存时,自动优先级
// (PATH→login-shell→npm-prefix→已知路径)会选中第一个命中的,用户可能想用另一个。
// 存独立 JSON 文件、同步可读 —— resolver 在同步请求路径上,不能依赖异步 prefs 路由。
const OVERRIDE_FILE = join(homedir(), '.claude-gui', 'claude-bin.json');
// r12-①a:格式扩为 {path, paused?, pausedAt?}。paused = 「暂停指定(可恢复)」——
// 路径暂时失效(如 npm 更新中断留坏壳包)时不丢用户钉选,resolver 视同无 override
// 回落自动,重装探测健康后自动回钉。旧格式 {path} 兼容读出 paused=false。
function readOverrideRaw() {
  try {
    const d = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf-8'));
    const path = (typeof d?.path === 'string') ? d.path : '';
    return { path, paused: d?.paused === true && !!path, pausedAt: Number.isFinite(d?.pausedAt) ? d.pausedAt : null };
  } catch { return { path: '', paused: false, pausedAt: null }; }
}
function readOverride() {
  const { path, paused } = readOverrideRaw();
  return (path && !paused) ? path : '';
}

function safeExec(file, args, timeout = 5000) {
  try { return execFileSync(file, args, { timeout }).toString().trim(); } catch { return ''; }
}

// 同 safeExec,但**非零退出也救回已捕获的 stdout**。交互登录 shell(`$SHELL -ilc`)常因
// rc 文件末尾命令非零退出而整体非零 → execFileSync 抛错,普通 safeExec 会连带丢掉
// `command -v claude` 已经打到 stdout 的正确结果。这里从 error.stdout 里捞回来。
function safeExecStdout(file, args, timeout = 5000) {
  try { return execFileSync(file, args, { timeout }).toString().trim(); }
  catch (e) { try { return (e.stdout || '').toString().trim(); } catch { return ''; } }
}

function mtimeOf(p) {
  try { return statSync(p).mtimeMs; } catch { return null; }
}

// Windows:where 可能同时给出无扩展名脚本(bash 用,Win 跑不了)/.cmd/.ps1/.exe。
// 优先 .exe(可直接 spawn)> .cmd/.bat(经 cmd.exe)> 其余。
function pickWinLine(lines) {
  return lines.find((p) => /\.exe$/i.test(p))
    || lines.find((p) => /\.(cmd|bat)$/i.test(p))
    || lines[0] || '';
}

// 策略 1:PATH 直查(index.js 的 expandClaudePath 已把常见安装目录前置进 PATH,
// 所以绝大多数安装在这一步就命中)。
function fromPath() {
  if (isWin) {
    const out = safeExec('where', ['claude']);
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return pickWinLine(lines);
  }
  return safeExec('which', ['claude']).split(/\r?\n/)[0] || '';
}

// 策略 2(非 Win):用【用户真实 $SHELL】的【交互+登录】模式解析 —— 与用户终端里
// 敲 `claude` 完全同款,终端能找到 GUI 就一定能找到。
// 为什么必须交互(-i):mac 默认 shell 是 zsh,claude/homebrew 的 PATH 常只写进
// **~/.zshrc**(交互配置),而登录配置(.zprofile/.zlogin/.profile)里没有。原实现用
// `sh -lc` —— sh 登录模式只读 .profile/bash_profile,**读不到 .zshrc** → 用户"终端能用、
// GUI 检测不到"的最常见根因。改用 `$SHELL -ilc` 让 zsh source .zshrc。
// 稳健处理:① </dev/null 防 rc 里的 read 挂起;② 超时兜底(safeExec 5s);③ rc 可能往
// stdout 打欢迎语 → 逐行找"绝对路径 + basename 是 claude*"的那行(command -v 的真结果),
// 找不到再回落首行。④ 交互 shell 可能非零退出(rc 里有 return/报错),safeExec 已吞错。
function fromLoginShell() {
  if (isWin) return '';
  const shell = process.env.SHELL || 'sh';
  // -i 有小概率因怪异 rc 卡住/报错;safeExec 的 execFileSync 默认 stdin 即 EOF(rc 里的
  // read 立刻返回)+ 超时兜底。失败则回落原来的 `sh -lc`(至少覆盖 .profile)。
  let out = safeExecStdout(shell, ['-i', '-l', '-c', 'command -v claude'], 6000);
  if (!out) out = safeExecStdout('sh', ['-lc', 'command -v claude']);
  return pickLoginShellLine(out);
}
// 从 login-shell 输出里挑 claude 路径(sync/async 共用)。
function pickLoginShellLine(out) {
  const lines = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // 优先取"看起来是 claude 可执行文件的绝对路径"那行,滤掉 rc 往 stdout 打印的欢迎语噪声。
  const hit = [...lines].reverse().find((l) => l.startsWith('/') && /\/claude$/.test(l) && existsSync(l));
  return hit || lines[lines.length - 1] || '';
}
async function fromLoginShellAsync() {
  if (isWin) return '';
  const shell = process.env.SHELL || 'sh';
  let out = await safeExecAsync(shell, ['-i', '-l', '-c', 'command -v claude'], 6000);
  if (!out) out = await safeExecAsync('sh', ['-lc', 'command -v claude']);
  return pickLoginShellLine(out);
}

// 策略 3:问 npm 自己的全局 prefix(用户 `npm config set prefix` 到任意目录时,
// npm 不写 shell PATH → "装成功但检测不到"的经典因;npm 本体随 node 恒可达)。
// 除 bin shim 外,再直扫包内真实二进制:npm 版 claude-code 是 wrapper 包,postinstall
// 把原生二进制放在 <全局 node_modules>/@anthropic-ai/claude-code/bin/claude.exe
// (全平台都叫 .exe,mac 上实为 Mach-O,可直接执行)。shim 缺失/软链断(--ignore-scripts、
// 杀毒隔离 shim 等)时这条仍能命中——探测彻底与 PATH 无关。
// npm 全局 prefix → claude 候选路径(sync/async 共用,避免重复逻辑)。
function npmPrefixCandidates(prefix) {
  if (!prefix || /^undefined$/i.test(prefix)) return [];
  const nodeModules = isWin ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
  const pkgBin = join(nodeModules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return isWin
    ? [join(prefix, 'claude.exe'), join(prefix, 'claude.cmd'), pkgBin]
    : [join(prefix, 'bin', 'claude'), pkgBin];
}
const NPM_PREFIX_ARGS = isWin ? ['cmd.exe', ['/c', 'npm', 'config', 'get', 'prefix'], 6000]
                              : ['npm', ['prefix', '-g'], 6000];
const WIN_LIVE_PATH_PS = "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')";

function fromNpmPrefix() {
  return npmPrefixCandidates(safeExec(NPM_PREFIX_ARGS[0], NPM_PREFIX_ARGS[1], NPM_PREFIX_ARGS[2]).trim());
}
// 异步版策略(仅 listClaudeInstallsAsync 用,不阻塞事件循环)。
async function fromPathAsync() {
  if (isWin) return pickWinLine((await safeExecAsync('where', ['claude'])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  return (await safeExecAsync('which', ['claude'])).split(/\r?\n/)[0] || '';
}
async function fromNpmPrefixAsync() {
  return npmPrefixCandidates((await safeExecAsync(NPM_PREFIX_ARGS[0], NPM_PREFIX_ARGS[1], NPM_PREFIX_ARGS[2])).trim());
}
async function fromWinLivePathAsync() {
  if (!isWin) return [];
  // 复用 winLivePathDirsAsync 的 30s 缓存,而非自己再 spawn 一个 powershell —— env-check 刚把
  // live PATH 缓存热了,claude-installs 不该再冷启动一个 powershell(白白多一次几秒开销)。
  const dirs = await winLivePathDirsAsync();
  const cands = [];
  for (const d of dirs) cands.push(join(d, 'claude.exe'), join(d, 'claude.cmd'));
  return cands;
}

// nvm(mac/linux)/fnm 把每个 node 版本装在独立目录,全局 bin 在 <ver>/bin,
// 逐版本目录扫(npm prefix 只在当前 shell 恰好激活该版本时才命中,必须直扫)。
function nvmNixCandidates(home) {
  const out = [];
  for (const base of [
    join(home, '.nvm', 'versions', 'node'),
    join(home, '.local', 'state', 'fnm_multishells'),
    join(home, '.fnm', 'node-versions'),
  ]) {
    try {
      for (const v of readdirSync(base)) {
        out.push(join(base, v, 'bin', 'claude'));
        out.push(join(base, v, 'installation', 'bin', 'claude')); // fnm 布局
      }
    } catch {}
  }
  return out;
}
function nvmWinCandidates(appData) {
  const out = [];
  try {
    for (const v of readdirSync(join(appData, 'nvm'))) out.push(join(appData, 'nvm', v, 'claude.cmd'));
  } catch {}
  return out;
}

// 策略 3.5(仅 Win):读【注册表实时 PATH】(Machine+User)再逐目录找 claude。
// 经典 Windows 根因:安装器把 claude 目录写进注册表 HKCU\Environment\Path,但**已在运行
// 的 Explorer/GUI 进程持有的是安装前的旧 PATH 快照**(PATH 改动要重开进程/重登才传播)→
// `where claude` 和 process.env.PATH 都看不到,用户"装了却检测不到、要重启才行"。直接问
// 注册表拿最新 PATH,无需重启即可发现。与 Tauri find_node 的 Windows live-PATH 同思路。
// 读【注册表实时 PATH】(User+Machine)返回目录列表;仅 Win,非 Win 返回 []。导出复用:
// claude 用它找 claude.exe,env-check 用它找 python/git/uv(同一"进程持旧 PATH 快照、装了
// 检测不到、要重启才行"的根因 —— 直接问注册表拿最新,无需重启)。
// r108-建4:注册表 PATH 条目可能自带双引号(`"C:\Program Files\Foo\bin"`,系统设置里手输
// 带空格路径的人常这么写)。只 trim 不去引号的话,join 出来的候选路径必然落空。
// 纯函数,export 仅为可单测。
export function splitWinPathList(str) {
  return String(str ?? '')
    .split(';')
    .map((s) => s.trim().replace(/^"|"$/g, '').trim())
    .filter(Boolean);
}

export function winLivePathDirs() {
  if (!isWin) return [];
  const ps = "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')";
  const out = safeExec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 8000);
  if (!out) return [];
  return splitWinPathList(out);
}
// 异步版(opus 审计:env-check 的 py/git/uv 检测原用同步版,PATH 未命中的 Windows 机器上
// 每次 env-check 同步 spawn PowerShell 1-3s 阻塞事件循环)。带 30s 短缓存:一次 env-check
// 会连查三个工具,别 spawn 三遍。
let _liveDirsCache = null; // { at, dirs }
export async function winLivePathDirsAsync() {
  if (!isWin) return [];
  if (_liveDirsCache && Date.now() - _liveDirsCache.at < 30_000) return _liveDirsCache.dirs;
  const out = await safeExecAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_LIVE_PATH_PS], 8000);
  const dirs = splitWinPathList(out);
  _liveDirsCache = { at: Date.now(), dirs };
  return dirs;
}

function fromWinLivePath() {
  const cands = [];
  for (const d of winLivePathDirs()) cands.push(join(d, 'claude.exe'), join(d, 'claude.cmd'));
  return cands;
}

// 策略 4:固定候选 —— 各安装方式的已知落点。
function fixedCandidates() {
  const home = homedir();
  if (isWin) {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const localApp = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(home, '.local', 'bin', 'claude.exe'),                  // 官方原生安装器
      join(home, '.claude', 'local', 'claude.exe'),
      join(localApp, 'AnthropicClaude', 'claude.exe'),
      join(appData, 'npm', 'claude.cmd'),                         // npm 默认全局
      join(appData, 'npm', 'claude.exe'),
      join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'claude.cmd'),
      join(home, 'scoop', 'shims', 'claude.cmd'),                 // scoop
      join(localApp, 'Volta', 'bin', 'claude.exe'),               // volta
      join(localApp, 'pnpm', 'claude.cmd'),                       // pnpm global
      join(home, '.bun', 'bin', 'claude.exe'),                    // bun 全局
      ...nvmWinCandidates(appData),                               // nvm-windows
    ];
  }
  return [
    join(home, '.local', 'bin', 'claude'),                        // 官方原生安装器(软链)
    join(home, '.claude', 'local', 'bin', 'claude'),              // 旧版 install.sh
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',                                   // brew (Apple Silicon)
    '/usr/local/bin/claude',                                      // brew (Intel) / 手动
    '/usr/bin/claude',
    join(home, '.npm-global', 'bin', 'claude'),                   // 常见自定义 npm prefix
    join(home, '.volta', 'bin', 'claude'),                        // volta
    join(home, 'Library', 'pnpm', 'claude'),                      // pnpm (mac)
    join(home, '.local', 'share', 'pnpm', 'claude'),              // pnpm (linux)
    join(home, '.config', 'yarn', 'global', 'node_modules', '.bin', 'claude'), // yarn global
    join(home, '.bun', 'bin', 'claude'),                          // bun 全局
    join(home, '.local', 'share', 'mise', 'shims', 'claude'),     // mise
    join(home, '.asdf', 'shims', 'claude'),                       // asdf
    ...nvmNixCandidates(home),                                    // nvm / fnm
  ];
}

function doResolve() {
  const ov = readOverride();
  if (ov && existsSync(ov)) return { path: ov, via: 'override' };
  const p1 = fromPath();
  if (p1 && existsSync(p1)) return { path: p1, via: 'PATH' };
  const p2 = fromLoginShell();
  if (p2 && existsSync(p2)) return { path: p2, via: 'login-shell' };
  for (const p of fromNpmPrefix()) {
    if (existsSync(p)) return { path: p, via: 'npm-prefix' };
  }
  for (const p of fromWinLivePath()) {
    try { if (existsSync(p)) return { path: p, via: 'win-live-path' }; } catch {}
  }
  for (const p of fixedCandidates()) {
    try { if (existsSync(p)) return { path: p, via: 'known-path' }; } catch {}
  }
  return null;
}

/**
 * 解析 claude 二进制。返回 { path, via } 或 null(未安装)。
 * via: 'PATH' | 'login-shell' | 'npm-prefix' | 'known-path'。
 * 同步(claudeSpawn 等调用点在同步请求路径上);结果带缓存:
 *  - 命中:按「文件仍存在 + mtime 未变」判有效,claude 自更新换版本后自动重解析;
 *  - 落空:15s 负缓存,避免每次请求都跑一遍全部策略,装好后无需重启即可被发现。
 */
export function resolveClaude({ refresh = false } = {}) {
  if (!refresh) {
    if (_cache && mtimeOf(_cache.path) === _cache.mtimeMs) return { path: _cache.path, via: _cache.via };
    if (!_cache && _missAt && Date.now() - _missAt < MISS_TTL_MS) return null;
  }
  const hit = doResolve();
  if (hit) {
    _cache = { ...hit, mtimeMs: mtimeOf(hit.path) };
    _missAt = 0;
    return hit;
  }
  _cache = null;
  // refresh(显式检查)落空不武装 15s 负缓存:更新空窗内前端焦点触发的检查若续期负缓存,
  // 紧接着聊天 spawn 走 resolveClaude() 会吃到负缓存返回 null → 回落裸 'claude'。显式检查只读真相。
  if (!refresh) _missAt = Date.now();
  return null;
}

// doResolve 的异步版:策略逐个 await(非零并发,保持"命中即返回"的短路语义),全程不阻塞事件循环。
async function doResolveAsync() {
  const ov = readOverride();
  if (ov && existsSync(ov)) return { path: ov, via: 'override' };
  const p1 = await fromPathAsync();
  if (p1 && existsSync(p1)) return { path: p1, via: 'PATH' };
  const p2 = await fromLoginShellAsync();
  if (p2 && existsSync(p2)) return { path: p2, via: 'login-shell' };
  for (const p of await fromNpmPrefixAsync()) {
    if (existsSync(p)) return { path: p, via: 'npm-prefix' };
  }
  for (const p of await fromWinLivePathAsync()) {
    try { if (existsSync(p)) return { path: p, via: 'win-live-path' }; } catch {}
  }
  for (const p of fixedCandidates()) {
    try { if (existsSync(p)) return { path: p, via: 'known-path' }; } catch {}
  }
  return null;
}

/**
 * resolveClaude 的异步版,与同步版共用 _cache/_missAt。显式检查端点(detectInstall 等,由前端
 * 窗口焦点/定时高频触发)必须走这个 —— 否则 refresh:true 会跑同步级联(where+npm+powershell 冷启动
 * 数秒)阻塞单线程 Express,复发"到处 connecting"。同步 resolveClaude 只留给 spawn 热路径(缓存基本恒命中)。
 */
export async function resolveClaudeAsync({ refresh = false } = {}) {
  if (!refresh) {
    if (_cache && mtimeOf(_cache.path) === _cache.mtimeMs) return { path: _cache.path, via: _cache.via };
    if (!_cache && _missAt && Date.now() - _missAt < MISS_TTL_MS) return null;
  }
  const hit = await doResolveAsync();
  if (hit) {
    _cache = { ...hit, mtimeMs: mtimeOf(hit.path) };
    _missAt = 0;
    return hit;
  }
  _cache = null;
  if (!refresh) _missAt = Date.now(); // 同步版注释:显式检查落空不武装负缓存
  return null;
}

/**
 * 组装可直接交给 execFile/spawn 的 { file, args }。
 * Windows 上除 .exe 外(.cmd/.bat/裸 'claude'/`where` 给的无扩展名 shim 路径如 ...\npm\claude)
 * 都不是 Node 能直接执行的真可执行文件,必须经 cmd.exe /c(cmd 按 PATHEXT 兜底解析)。
 * 此前只匹配 .cmd/.bat/.ps1/裸 'claude',漏了无扩展名解析路径 → execFile 直接跑抛 ENOENT,
 * 出现"版本检测正常(getClaudeVersion 对所有 Win 路径都经 cmd.exe)但 MCP/agents 全挂"的割裂。
 */
export function claudeCommand(args = []) {
  const hit = resolveClaude();
  return claudeExecSpec(hit ? hit.path : 'claude', args);
}

/**
 * SDK 能真正驱动的 claude 路径,驱动不了就返回 null(调用方据此让 SDK 回落自带二进制)。
 * Windows 的 .cmd/.bat/.ps1/无扩展名 shim 不是可执行文件,SDK 的 spawn 起不来 —— 这时
 * SDK 跑的是 node_modules/@anthropic-ai/claude-agent-sdk 捆绑的那个 CLI(package.json
 * 的 claudeCodeVersion,当前 2.1.191),**与 PATH 上装的版本无关**。凡"按 CLI 版本决定
 * 加不加 flag"的地方都必须以这个返回值为准,否则会拿 PATH 上的新版能力去喂自带的旧版。
 */
export function resolveSdkClaude() {
  const hit = resolveClaude();
  return hit ? resolveSdkClaudeFrom(hit.path) : null;
}

/**
 * resolveSdkClaude 的纯函数内核(platform/existsSync/readFileSync 可注入,便于在 mac 上
 * 用临时目录模拟 Windows 布局单测)。
 *
 * r106:Windows 上 npm 全局装出来的入口是 `<prefix>\claude.cmd`(批处理 shim,SDK 的
 * spawn 起不来)→ 旧实现一律返 null → SDK 改用自带的旧 CLI(claudeCodeVersion 2.1.191,
 * 不认 --system-prompt-snapshot)→ 系统提示每次冷启重算,第三方缓存命中率忽高忽低。
 * 但真二进制就在同一份 npm 布局里:`<prefix>\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
 * SDK 完全可以直接 spawn 它。坏壳包(postinstall 没落真二进制、bin 还是 ASCII stub)仍返
 * null —— 宁可回落自带 CLI,也不能把一个跑不起来的文件交给 SDK。
 */
const _smallExeLogged = new Set(); // 残缺 exe 回落日志去重(按 binTarget)
export function resolveSdkClaudeFrom(hitPath, {
  platform = process.platform,
  existsSync: exists = existsSync,
  readFileSync: readFn = null,
  statSync: statFn = statSync,
  // r108-建2:体积下限。注入了 readFileSync = 单测在用假文件头模拟布局,此时不看体积
  // (也不 stat —— 那些路径根本没落盘);真实路径下要求 ≥5MB。
  minExeBytes = readFn ? 0 : 5_000_000,
} = {}) {
  if (!hitPath) return null;
  if (platform !== 'win32' || /\.exe$/i.test(hitPath)) return hitPath;
  const pkgDir = npmPkgDirFor(hitPath, exists);
  if (!pkgDir) return null;
  const binTarget = join(pkgDir, 'bin', 'claude.exe');
  if (!exists(binTarget)) return null;
  // 两道判定:① 壳包(≥2.1.227,包内有 install.cjs)由 classifyShim 判"装完没";
  // ② 非壳包 classifyShim 返 null,由文件头判定兜底。任一说不是真 PE 就放弃。
  if (classifyShim(hitPath, pkgDir)?.broken) return null;
  if (!isWinPeFile(binTarget, readFn)) return null;
  // r108-建2:isWinPeFile 只验前 2 字节,被截断的平台包(npmmirror 对 81MB 包 16-20KB/s +
  // 超时中断留下的僵尸安装)照样带 'MZ' 头 → 交给 SDK 直接 spawn 失败 → Windows 聊天起不来。
  // 旧行为(回落 SDK 自带 CLI)至少能用,所以体积不达标宁可回落。statSync 抛错(被杀毒隔离/
  // 无权限)同样按不可用处理。
  if (minExeBytes > 0) {
    try {
      const size = statFn(binTarget).size;
      if (size < minExeBytes) {
        // 这条静默回落最难排查(聊天"能用"但一直是 SDK 自带的旧 CLI),留一行到 server.log。
        // 按 binTarget 去重(同 logSdkClaudeOnce):这函数在每次聊天的热路径上,坏安装不去重
        // 就是每发一条消息刷一行。
        if (!_smallExeLogged.has(binTarget)) {
          _smallExeLogged.add(binTarget);
          console.error(`[claude-resolver] 包内 claude.exe 仅 ${size} 字节,疑似安装不全,回落 SDK 自带 CLI`);
        }
        return null;
      }
    } catch { return null; }
  }
  return binTarget;
}

// bin\claude.exe 是不是真 PE(而非 ASCII 假启动器)。这条路只在 Windows 上走,PE 的 'MZ'
// 是唯一合法头 —— 不复用 sniffBinaryKind(它把 Mach-O/ELF 也算 binary,那些在 Windows 上
// 照样起不来)。只读前 2 字节,不整份读入(真二进制 80MB+)。readFileSync 注入仅为单测。
function isWinPeFile(p, readFn) {
  try {
    if (readFn) { const b = Buffer.from(readFn(p)); return b[0] === 0x4D && b[1] === 0x5A; }
    const fd = openSync(p, 'r');
    try {
      const b = Buffer.alloc(2);
      return readSync(fd, b, 0, 2, 0) === 2 && b[0] === 0x4D && b[1] === 0x5A;
    } finally { closeSync(fd); }
  } catch { return false; }
}

// r106:一行日志说明 SDK 这次实际驱动的是哪个 claude(Windows npm 装的会被上面推成包内
// exe,排查"缓存命中忽高忽低"时第一眼就要看到它)。每个路径只打一次;--version 异步探测,
// 不阻塞事件循环。只打路径与版本号,不碰环境变量/密钥。
// r108-建1:默认 logger 是 console.error 不是 console.log —— 装机版(src-tauri/src/lib.rs)
// 把后端 stdout 丢 null,只有 stderr 落 ~/.claude-gui/server.log,打 stdout 等于没打。
const _sdkLogged = new Set();
export function logSdkClaudeOnce(claudePath, log = console.error) {
  const key = String(claudePath || '');
  if (_sdkLogged.has(key)) return;
  _sdkLogged.add(key);
  if (!key) { log('[chat] sdk claude: (SDK 自带 CLI —— 未解析到可直接执行的 claude)'); return; }
  // 路径先同步落一行:--version 探测要 spawn(Windows 上首次执行 80MB+ exe 会被 Defender
  // 全量扫描,最坏 8s 超时),挂住/被杀毒隔离时至少 server.log 里已经有"SDK 在用哪个二进制"。
  log(`[chat] sdk claude: ${key}`);
  const spec = claudeExecSpec(key, ['--version']);
  safeExecAsync(spec.file, spec.args, 8000, spec.opts)
    .then((out) => log(`[chat] sdk claude: ${key} → ${String(out).split(/\r?\n/)[0] || '(--version 无输出)'}`))
    .catch(() => {}); // 纯日志,注入的 log 抛异常也不能变成 unhandled rejection
}

/**
 * claudeCommand 的纯函数内核:给定二进制路径直接组装 { file, args },不做解析。
 * 需要探测【某个具体路径】(而不是当前解析结果)的地方用它 —— 例如
 * utils/prompt-cache-env.js 的 `--help` 能力探测:Windows 上 npm 装出来的是
 * claude.cmd,execFile 直接跑抛 ENOENT/EINVAL → 探测恒失败 → 所有按 flag 门控的
 * 优化在 Windows 上静默失效。platform 可注入仅为可单测。
 */
export function claudeExecSpec(bin, args = [], platform = process.platform) {
  const b = bin || 'claude';
  // r110:经 cmd.exe 时用 winCmdSpawnSpec 的 verbatim 引号。旧写法把参数原样拼进 cmd 命令行,
  // `mcp<2`(paper-search 预设)里的 `<2` 被 cmd 当成 stdin 重定向 → 报"找不到指定的文件",
  // claude 根本没被执行。opts 必须由调用方并进自己的 spawn/execFile 选项,漏一处那条路照旧吃
  // `< > | & ^`。
  if (platform === 'win32' && !/\.exe$/i.test(b)) return winCmdSpawnSpec(b, args, {});
  return { file: b, args, opts: {} };
}

// ── R8-1 壳包识别 ─────────────────────────────────────────────
// 背景:npm 包 @anthropic-ai/claude-code ≥2.1.227 是「原生安装器引导壳」:bin 指
// bin/claude.exe,初始是 ASCII 假启动器文本,真二进制由 postinstall 从 optionalDep
// 平台包本地拷贝覆盖。慢源(npmmirror 对 81MB 平台包 16-20KB/s)+ 超时中断会留下
// 「装了但 bin 还是文本 stub」的死安装 —— 列表里看着正常、切过去 spawn 就废。
// 靠读文件头魔数识别真伪:**只读前几个字节,绝不执行不可信文件**。
// 返回 'binary'(Mach-O/PE/ELF 真可执行)| 'text'(shebang/ASCII stub)| 'unreadable'。
export function sniffBinaryKind(p) {
  let fd = null;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(8);
    const n = readSync(fd, buf, 0, 8, 0);
    if (n < 4) return 'text'; // 不足 4 字节放不下任何可执行魔数,必是残缺文本
    const be = buf.readUInt32BE(0);
    // Mach-O 薄/胖二进制(两种字节序)| ELF | PE('MZ')
    if ([0xFEEDFACE, 0xFEEDFACF, 0xCEFAEDFE, 0xCFFAEDFE, 0xCAFEBABE, 0xBEBAFECA].includes(be)) return 'binary';
    if (buf[0] === 0x7F && buf[1] === 0x45 && buf[2] === 0x4C && buf[3] === 0x46) return 'binary';
    if (buf[0] === 0x4D && buf[1] === 0x5A) return 'binary';
    return 'text';
  } catch { return 'unreadable'; }
  finally { if (fd !== null) { try { closeSync(fd); } catch {} } }
}

// 从安装项的真实路径推导 npm 包目录(非 npm 包安装返回 null)。两种形态:
// ① real 已在包内(mac 的 bin/claude 软链解析后、直扫 pkgBin 命中);
// ② real 是 shim(Windows 的 <prefix>\claude.cmd 非软链 / 断链 shim),按 npm 布局
//    从所在目录猜 node_modules 落点(win 平铺 / *nix lib/node_modules 两种)。
// exists 可注入(r106:resolveSdkClaudeFrom 要在 mac 上按注入的 fs 模拟 Windows 布局)。
function npmPkgDirFor(real, exists = existsSync) {
  const norm = String(real).replace(/\\/g, '/');
  const m = norm.match(/^(.*\/node_modules\/@anthropic-ai\/claude-code)\//i);
  if (m) return m[1];
  const dir = norm.replace(/\/[^/]*$/, '');
  for (const c of [
    `${dir}/node_modules/@anthropic-ai/claude-code`,
    `${dir.replace(/\/bin$/, '')}/lib/node_modules/@anthropic-ai/claude-code`,
  ]) { try { if (exists(c)) return c; } catch {} }
  return null;
}

// 壳包判定(导出仅为可单测)。判据双条件防误判(风险清单:修好的壳包不能标 broken):
// 「是壳包」= 包目录存在 install.cjs(≥2.1.227 引导壳专属特征);
// 「坏」= bin 目标(bin/claude.exe)缺失或文件头是文本(postinstall 没落真二进制)。
// 修好的壳包(claude.exe 为真 Mach-O/PE)只标 shim:true,是正常安装。
export function classifyShim(real, pkgDirOverride = null) {
  const pkgDir = pkgDirOverride ?? npmPkgDirFor(real);
  if (!pkgDir) return null;
  try { if (!existsSync(join(pkgDir, 'install.cjs'))) return null; } catch { return null; }
  const binTarget = join(pkgDir, 'bin', 'claude.exe');
  if (!existsSync(binTarget)) {
    return { shim: true, broken: true, reason: '壳包未完成安装(postinstall 未落真二进制)' };
  }
  if (sniffBinaryKind(binTarget) !== 'binary') {
    return { shim: true, broken: true, reason: '壳包未完成安装(postinstall 未落真二进制)' };
  }
  return { shim: true };
}

/**
 * 列出机器上所有能找到的 claude 安装(跑全部解析策略,不止第一个命中)。
 * 按真实路径(解 symlink)去重 —— PATH 命中的 ~/.local/bin/claude 与已知候选
 * 里的同一个软链会指向同一 real,只算一个;npm 版和原生版 real 不同,各算一个。
 * 返回 [{ path, real, shim?, broken?, reason? }],path 是首次发现的入口路径(可直接执行)。
 */
// 候选路径列表 → 去重后的 [{path, real}]。按【逻辑安装身份】去重,而非裸真实路径:
// Windows npm 版会同时命中 shim(`<prefix>\claude.cmd`,非软链)和包内二进制
// (`<prefix>\node_modules\@anthropic-ai\claude-code\bin\claude.exe`)——两者 realpath 各是自己
// →旧逻辑列成两条重复项(用户实测)。key 把包内二进制映射回 npm 前缀、shim 用其所在目录,
// 同一 prefix 即合并成一条;原生版/不同 prefix 的 key 不同,仍各算一个。
function buildInstalls(paths) {
  const seen = new Set();
  const out = [];
  const keyOf = (real) => {
    const low = real.replace(/\\/g, '/').toLowerCase();
    const m = low.match(/^(.*)\/node_modules\/@anthropic-ai\/claude-code\//);
    return m ? m[1] : low.replace(/\/[^/]*$/, ''); // 包内二进制→前缀;否则→所在目录
  };
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    let real = p;
    try { real = realpathSync(p); } catch { continue; }
    const key = keyOf(real);
    if (seen.has(key)) continue;
    seen.add(key);
    // R8-1:npm 引导壳标注(shim/broken/reason)。非壳包安装 classifyShim 返回 null,零字段。
    out.push({ path: p, real, ...(classifyShim(real) || {}) });
  }
  return out;
}

export function listClaudeInstalls() {
  return buildInstalls([fromPath(), fromLoginShell(), ...fromNpmPrefix(), ...fromWinLivePath(), ...fixedCandidates()]);
}

// ⚡ 异步版:唯一"每次全量扫所有策略"的重活。同步版在 Windows 上以 cmd/PowerShell 冷启动
// 几秒 execFileSync **阻塞单线程 Express 事件循环**(chat/provider/health 全冻→用户报"到处
// connecting、设置页一直加载中")。异步 spawn 让循环空转、其他请求照常。带 8s TTL 缓存,免
// 设置页 mount + clickMethod + switchActive + check 反复全扫;setClaudeOverride 时清缓存。
let _installsCache = null; // { at, list }
let _installsInflight = null; // 进行中的解析 promise(并发去重)
const INSTALLS_TTL_MS = 8_000;
export async function listClaudeInstallsAsync() {
  if (_installsCache && Date.now() - _installsCache.at < INSTALLS_TTL_MS) return _installsCache.list;
  // in-flight 去重:设置页 mount 常同时发 /claude-installs 与 /env-check,两边并发 miss 会各跑
  // 一整套 where/login-shell/npm/powershell 冷启动。第一个存 promise,后续并发直接 await 它。
  if (_installsInflight) return _installsInflight;
  _installsInflight = (async () => {
    const [p1, login, npm, live] = await Promise.all([fromPathAsync(), fromLoginShellAsync(), fromNpmPrefixAsync(), fromWinLivePathAsync()]);
    const list = buildInstalls([p1, login, ...npm, ...live, ...fixedCandidates()]);
    _installsCache = { at: Date.now(), list };
    return list;
  })();
  try { return await _installsInflight; }
  finally { _installsInflight = null; }
}

/** 读当前【生效】覆盖路径('' = 未设或已暂停,走自动优先级)。 */
export function getClaudeOverride() {
  return readOverride();
}

/** r12-①a:读覆盖文件完整对象 {path, paused, pausedAt}(UI/自动恢复逻辑用)。 */
export function getClaudeOverrideRaw() {
  return readOverrideRaw();
}

/** 钉死用哪个 claude;传空串彻底清除回自动(含清 paused 态)。写完清缓存,下次解析立即生效。 */
export function setClaudeOverride(path) {
  mkdirSync(dirname(OVERRIDE_FILE), { recursive: true });
  writeFileSync(OVERRIDE_FILE, JSON.stringify({ path: path || '' }, null, 2));
  _cache = null;
  _missAt = 0;
  _installsCache = null; // 切换/手动指定后立即反映到安装列表(active 归属会变)
}

/** r12-①a:暂停指定(可恢复)——保留 path 只置 paused;无 path 时 no-op 返回 false。 */
export function pauseClaudeOverride() {
  const raw = readOverrideRaw();
  if (!raw.path) return false;
  mkdirSync(dirname(OVERRIDE_FILE), { recursive: true });
  writeFileSync(OVERRIDE_FILE, JSON.stringify({ path: raw.path, paused: true, pausedAt: Date.now() }, null, 2));
  _cache = null;
  _missAt = 0;
  _installsCache = null;
  return true;
}
