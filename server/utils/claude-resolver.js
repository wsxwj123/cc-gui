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
import { execFileSync } from 'child_process';
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'fs';
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
function readOverride() {
  try {
    const p = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf-8'))?.path;
    return (typeof p === 'string' && p) ? p : '';
  } catch { return ''; }
}

function safeExec(file, args, timeout = 5000) {
  try { return execFileSync(file, args, { timeout }).toString().trim(); } catch { return ''; }
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

// 策略 2(非 Win):login shell 加载用户 profile —— nvm/mise/asdf 改写的 PATH 只在
// 这里可见。
function fromLoginShell() {
  if (isWin) return '';
  return safeExec('sh', ['-lc', 'command -v claude']);
}

// 策略 3:问 npm 自己的全局 prefix(用户 `npm config set prefix` 到任意目录时,
// npm 不写 shell PATH → "装成功但检测不到"的经典因;npm 本体随 node 恒可达)。
function fromNpmPrefix() {
  const out = isWin
    ? safeExec('cmd.exe', ['/c', 'npm', 'config', 'get', 'prefix'], 6000)
    : safeExec('npm', ['prefix', '-g'], 6000);
  const prefix = out.trim();
  if (!prefix || /^undefined$/i.test(prefix)) return [];
  return isWin
    ? [join(prefix, 'claude.exe'), join(prefix, 'claude.cmd')]
    : [join(prefix, 'bin', 'claude')];
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
  _missAt = Date.now();
  return null;
}

/**
 * 组装可直接交给 execFile/spawn 的 { file, args }。
 * Windows 上 .cmd/.bat 不是真正可执行文件,必须经 cmd.exe /c;解析失败时回落裸
 * 'claude'(Win 也经 cmd.exe 让 PATHEXT 兜底),保持旧行为。
 */
export function claudeCommand(args = []) {
  const hit = resolveClaude();
  const bin = hit ? hit.path : 'claude';
  if (isWin && (bin === 'claude' || /\.(cmd|bat|ps1)$/i.test(bin))) {
    return { file: 'cmd.exe', args: ['/c', bin, ...args] };
  }
  return { file: bin, args };
}

/**
 * 列出机器上所有能找到的 claude 安装(跑全部解析策略,不止第一个命中)。
 * 按真实路径(解 symlink)去重 —— PATH 命中的 ~/.local/bin/claude 与已知候选
 * 里的同一个软链会指向同一 real,只算一个;npm 版和原生版 real 不同,各算一个。
 * 返回 [{ path, real }],path 是首次发现的入口路径(可直接执行)。
 */
export function listClaudeInstalls() {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    if (!p || !existsSync(p)) return;
    let real = p;
    try { real = realpathSync(p); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    out.push({ path: p, real });
  };
  add(fromPath());
  add(fromLoginShell());
  for (const p of fromNpmPrefix()) add(p);
  for (const p of fixedCandidates()) add(p);
  return out;
}

/** 读当前覆盖路径('' = 未设,走自动优先级)。 */
export function getClaudeOverride() {
  return readOverride();
}

/** 钉死用哪个 claude;传空串清除回自动。写完清缓存,下次解析立即生效。 */
export function setClaudeOverride(path) {
  mkdirSync(dirname(OVERRIDE_FILE), { recursive: true });
  writeFileSync(OVERRIDE_FILE, JSON.stringify({ path: path || '' }, null, 2));
  _cache = null;
  _missAt = 0;
}
