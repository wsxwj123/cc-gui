import { Router } from 'express';
import { readFile, readdir, stat, writeFile, mkdir } from 'fs/promises';
import { join, sep, dirname } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { syncMcpToAgents } from './agents.js';
import { assertPublicBaseURL } from './settings.js';
import { claudeCommand } from '../utils/claude-resolver.js';
import { detectUv, detectLocalProxy, probeTcp, isLoopbackProxyHost } from './version-check.js';
import { searchRegistry } from '../services/mcp-registry.js';

const execFileP = promisify(execFile);

// 读 ~/.claude.json 里某个 MCP 的原始配置(含 env 值,用于 spawn 探测)。
async function readRawMcpConfig(name) {
  try {
    const j = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf-8'));
    return j.mcpServers?.[name] || null;
  } catch { return null; }
}

// MCP command 来自用户配置,shell:true 会让每个 arg 过 cmd 元字符解释 = 命令注入面。
// 照 chat.js claudeSpawn 手法:Windows 上先把裸命令名经 where.exe 解析成真实文件,
// .cmd/.bat 显式包 cmd.exe /c(Node 安全策略拒绝直跑批处理),参数仍是独立 argv 不过
// shell 字符串拼接;.exe / 非 Windows 直接 spawn。解析失败原样返回,由 spawn 报 ENOENT。
async function spawnMcpCommand(command, args, opts) {
  if (process.platform !== 'win32') return spawn(command, args, opts);
  let resolved = command;
  if (!/[\\/]/.test(command)) {
    try {
      const { stdout } = await execFileP('where', [command], { timeout: 5000 });
      const hits = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // 裸名可能同时命中无扩展名 shim 与 .cmd/.exe:优先可直接执行的扩展名。
      resolved = hits.find((h) => /\.(exe|cmd|bat)$/i.test(h)) || hits[0] || command;
    } catch { /* where 失败:原样交给 spawn 报错 */ }
  }
  if (/\.(cmd|bat)$/i.test(resolved)) return spawn('cmd.exe', ['/c', resolved, ...args], opts);
  return spawn(resolved, args, opts);
}

// 直接 spawn stdio MCP 的命令抓早期 stderr —— `claude mcp get` 只报 "Failed to connect",
// 不吐子进程真因(命令未找到 / 包无可执行入口 / 缺依赖 / realpath 缺失等)。最多等 timeoutMs:
// stdio MCP 正常启动会静默等 stdin(无 stderr、不退出)→ 视为无早期错误;快速退出 + stderr = 真错误。
async function probeStdioStderr(cfg, timeoutMs = 6000) {
  if (!cfg || !cfg.command) return '';
  const isWin = process.platform === 'win32';
  // 先解析命令(spawnMcpCommand 是 async),再进 Promise 包事件流。
  const spawnIt = await spawnMcpCommand(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], {
    env: { ...process.env, ...(cfg.env || {}) },
    stdio: ['ignore', 'ignore', 'pipe'],
    // 非 Win:独立进程组,便于负 pid 杀掉命令 fork 出的真实 server 子进程,不留孤儿。
    detached: !isWin,
  }).catch((e) => e);
  if (spawnIt instanceof Error) return `spawn 失败: ${spawnIt.message}`;
  const child = spawnIt;
  return new Promise((resolve) => {
    let stderr = '', done = false, timer;
    const killTree = () => {
      if (!child || child.pid == null) return;
      try {
        if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL'); // detached → 负 pid 杀整个进程组(连 npx/uvx fork 的子进程)
      } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const finish = (suffix = '') => {
      if (done) return; done = true;
      clearTimeout(timer);
      killTree();
      resolve((stderr.trim() + suffix).trim().slice(0, 1200));
    };
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => finish(e.code === 'ENOENT'
      ? `\n命令未找到: ${cfg.command}(不在 PATH 中 —— 该命令需要的运行时可能没装,或装了但 GUI 启动环境的 PATH 没包含它)`
      : `\n${e.message}`));
    child.on('exit', (code) => finish(code ? `\n(子进程退出码 ${code})` : ''));
    timer = setTimeout(() => finish(), timeoutMs);
  });
}

// All `claude ...` invocations go through execFile with an args array — no shell, no injection.
// Async (not execFileSync) so a slow CLI cold start doesn't freeze the whole event loop —
// and with it every other client's live SSE stream — for up to `timeout` ms.
// env:完整子进程环境副本。插件路径用它剔除死代理而不修改父进程 process.env;
// 其余调用仍可用 extraEnv 做增量合并。
async function runClaude(args, {
  timeout = 10000,
  extraEnv = null,
  env = null,
  killTreeOnTimeout = false,
} = {}) {
  // 路径解析统一走 claude-resolver(与检测面板/聊天链路同源,PATH 外安装位也可用);
  // Windows 的 .cmd/.bat 不是真正可执行文件,claudeCommand 已包好 cmd.exe /c。
  const { file, args: fullArgs } = claudeCommand(args);
  const isWin = process.platform === 'win32';
  // Windows:直接子进程是 cmd.exe,execFile 内建超时只 TerminateProcess 掉 cmd.exe,真正的
  // claude(mcp login 时内含 OAuth 回调 HTTP server)成孤儿占死端口 → 重试登录一直失败。
  // 故 Win 关掉内建超时、自管定时器 taskkill /T 杀整棵树(cmd 存活时杀它会连带 claude)。
  // 非 Win claude 是直接子进程,内建超时直接杀它无孤儿。
  const p = execFileP(file, fullArgs, {
    encoding: 'utf-8',
    timeout: (isWin || killTreeOnTimeout) ? 0 : timeout,
    env: env ? { ...env } : { ...process.env, ...(extraEnv || {}) },
    maxBuffer: 8 * 1024 * 1024,
    // 插件 CLI 可能再拉起 git/包装器；独立进程组才能在 120 秒边界清掉整棵树。
    detached: killTreeOnTimeout && !isWin,
  });
  let timedOut = false, timer = null;
  if ((isWin || killTreeOnTimeout) && timeout > 0) {
    const child = p.child;
    timer = setTimeout(() => {
      timedOut = true;
      if (child?.pid != null) {
        try {
          if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          else process.kill(-child.pid, 'SIGKILL');
        } catch { try { child.kill('SIGKILL'); } catch {} }
      }
    }, timeout);
  }
  try {
    const { stdout } = await p;
    return stdout;
  } catch (err) {
    if (timedOut) err.killed = true; // 与非 Win execFile 内建超时同语义:login 端点靠 err.killed 判超时
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 允许空格:claude.ai connector 的服务器名带空格(如 "claude.ai Google Drive")。
// 所有 claude 调用走 execFile 参数数组无 shell,空格不构成注入面。
const NAME_RE = /^[A-Za-z0-9_.:@/ -]{1,128}$/;
function assertSafeName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('invalid MCP server name');
  }
}

const router = Router();
const CLAUDE_DIR = join(homedir(), '.claude');
const GUI_DIR = join(CLAUDE_DIR, 'gui');
const DISABLED_FILE = join(GUI_DIR, 'disabled-mcp.json');
const AUTOAPPROVE_FILE = join(GUI_DIR, 'mcp-autoapprove.json'); // ["serverName", ...]
const META_FILE = join(GUI_DIR, 'mcp-meta.json');               // { name: { label } }
const DISABLED_TOOLS_FILE = join(GUI_DIR, 'disabled-mcp-tools.json'); // { serverName: ["tool1", ...] } 用户手动关掉的单个工具

// 读/写"手动禁用的单个 MCP 工具"清单。禁用 = chat.js 把 `mcp__<server>__<tool>` 加进 SDK
// query 的 disallowedTools → 模型【根本看不到】该工具(不是权限拦截)。解决 paper-search 这类
// 一个 server 暴露十几个工具、模型乱选 crossref 的噪音问题。
export async function readDisabledMcpTools() {
  const j = await readJsonFile(DISABLED_TOOLS_FILE, {});
  return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
}
async function writeDisabledMcpTools(map) { await writeJsonFile(DISABLED_TOOLS_FILE, map); }

// 连上某个已配置的 stdio MCP server 走 MCP 协议 tools/list 握手,返回其暴露的工具清单。
// 没有 `claude mcp` 子命令能列工具(get 只给 config),故自己发 JSON-RPC(newline-delimited,
// stdio 传输标准)。HTTP/SSE server 的握手不同(SSE 流),此函数只支持 stdio;HTTP 返回空+提示。
export async function listMcpTools(name, timeoutMs = 15000) {
  const cfg = await readRawMcpConfig(name);
  if (!cfg) throw Object.assign(new Error('MCP server 未找到'), { status: 404 });
  return listToolsFromCfg(cfg, timeoutMs);
}
// 握手核心与"已配置的 server"解耦:添加表单在**添加前**预览工具清单时,传入草稿 cfg 直接握手。
export async function listToolsFromCfg(cfg, timeoutMs = 15000) {
  if (!cfg.command) return { transport: cfg.type || 'http', tools: null, note: '仅 stdio 类型支持查看工具清单;HTTP/SSE server 请在其平台侧管理。' };
  const isWin = process.platform === 'win32';
  // 先解析命令(spawnMcpCommand 是 async:Windows where.exe + .cmd 包 cmd.exe,不过 shell)。
  const spawnIt = await spawnMcpCommand(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], {
    env: { ...process.env, ...(cfg.env || {}) }, stdio: ['pipe', 'pipe', 'ignore'],
  }).catch((e) => e);
  if (spawnIt instanceof Error) return { transport: 'stdio', tools: null, note: `启动失败: ${spawnIt.message}` };
  const child = spawnIt;
  return await new Promise((resolve) => {
    let done = false, buf = '', timer; // timer 提前声明:finish 里 clearTimeout(timer) 在
    // 同步失败路径会先于末尾赋值执行,用 const 声明会 TDZ ReferenceError 污染错误文案。
    const finish = (tools, note) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { if (isWin && child?.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child?.kill('SIGKILL'); } catch {}
      resolve({ transport: 'stdio', tools, note });
    };
    child.on('error', (e) => finish(null, `启动失败: ${e.message}`));
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    // 按行解析 JSON-RPC,拿到 id:2(tools/list)的 result 即完成。
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) { // initialize 完成 → 通知 initialized + 请求 tools/list
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          const tools = (msg.result?.tools || []).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 300) }));
          finish(tools);
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-gui', version: '1' } } });
    timer = setTimeout(() => finish(null, '握手超时(server 无响应或不是标准 MCP stdio server)'), timeoutMs);
  });
}

// 把单行命令拆成 command + args[](尊重引号),对齐 claude code 官方配置的
// { command, args } 结构。例:`npx -y @scope/pkg --flag "a b"` → {command:'npx',
// args:['-y','@scope/pkg','--flag','a b']}。
function parseCommandLine(str) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || ''))) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return { command: tokens[0] || '', args: tokens.slice(1) };
}

async function readJsonFile(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return fallback; }
}
async function writeJsonFile(path, data) {
  await mkdir(GUI_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}
async function setAutoApprove(name, on) {
  const list = await readJsonFile(AUTOAPPROVE_FILE, []);
  const set = new Set(Array.isArray(list) ? list : []);
  if (on) set.add(name); else set.delete(name);
  await writeJsonFile(AUTOAPPROVE_FILE, [...set]);
}
async function setMeta(name, label) {
  const meta = await readJsonFile(META_FILE, {});
  if (label && label.trim()) meta[name] = { label: label.trim() };
  else delete meta[name];
  await writeJsonFile(META_FILE, meta);
}

/**
 * Parse `claude mcp list` output into structured data.
 * Format: "name: command - ✓ Connected" or "name: url (HTTP) - ✓ Connected"
 */
function parseMcpList(output) {
  const servers = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    // Skip header/empty lines
    if (!line.trim() || line.includes('Checking MCP') || line.includes('health')) continue;

    // 状态图标:CLI 实际用 ✔/✘(U+2714/2718),早期匹配的 ✓/✗(U+2713/2717)对不上 →
    // 状态恒 unknown + 命令尾巴被 " - ✔ Connected" 污染。这里两套都收,外加 ! 需认证。
    // 名字用 (.+?) 非贪婪到首个 ": ":claude.ai connector 名含空格(如
    // "claude.ai Google Drive: https://... - ! Needs authentication"),\S+ 整行匹配不上被丢。
    const match = line.match(/^(.+?):\s+(.+?)(?:\s+-\s+([✓✔✗✘!])\s+(.+))?$/);
    if (match) {
      const [, name, command, statusIcon, statusText] = match;
      const isHttp = command.includes('(HTTP)') || command.startsWith('http');
      const cleanCommand = command.replace(/\s*\(HTTP\)\s*$/, '').trim();
      const status = (statusIcon === '!' || /needs\s+auth/i.test(statusText || '')) ? 'needs-auth'
        : (statusIcon === '✓' || statusIcon === '✔') ? 'connected'
        : (statusIcon === '✗' || statusIcon === '✘') ? 'disconnected'
        : 'unknown';

      servers.push({
        name,
        command: cleanCommand,
        transport: isHttp ? 'http' : 'stdio',
        status,
        source: 'claude mcp',
      });
    }
  }

  return servers;
}

// In-memory cache. `runClaude(['mcp', 'list'])` spawns the claude CLI, which
// takes ~2s cold start. Result is stable for a session, so cache it. Enable/
// disable mutations invalidate the cache below.
let mcpCache = null;
let mcpCacheAt = 0;
// Long TTL because mcp/plugin list rarely changes mid-session.
// Mutations (enable/disable) invalidate explicitly via invalidateMcpCache().
// Pass `?fresh=1` to force a refresh.
const MCP_CACHE_TTL_MS = 5 * 60_000;
// MCP 配置换代戳:每次增删改(含登录/登出/插件变动)touch 一次,chat.js 的常驻进程兼容键
// 计入其 mtime → 同会话下条消息自动换新进程加载新 MCP,无需重启会话。不能直接用
// ~/.claude.json 的 mtime(CLI 每次会话都写它,会杀死进程复用);选落盘文件而非内存 epoch:
// mtime 跨 server 重启稳定,内存变量重启归零会与旧兼容键撞车误复用。
const MCP_STAMP_FILE = join(GUI_DIR, 'mcp-config.stamp');
// 只清列表/详情内存缓存,不 touch 换代戳。用于"不改变常驻进程该加载什么 MCP"的变更
// (如 autoapprove:chat.js 权限判定时实时 readFileSync mcp-autoapprove.json,不经 query 起时定死,
// 无需换进程;touch 戳会让聊天中途勾选"自动执行"白白冷启动 ~5s)。
// 全市场可装插件列表缓存(折叠式高级搜索用):`claude plugin list --available --json` 较慢
// (拉全部已配置 marketplace),缓存全量 + 前端每次搜索只在内存过滤,不每击键跑一次 CLI。
let availablePluginsCache = null; // { at, items }
const AVAILABLE_PLUGINS_TTL_MS = 5 * 60_000;
function invalidateMcpListCache() {
  mcpCache = null; mcpCacheAt = 0;
  availablePluginsCache = null; // 装/卸插件后 installed 标记会变,一并失效
  try { invalidateDetailsCache(); } catch {}
}
// 增删改 MCP(含登录/登出/插件变动):清缓存 + touch 换代戳,让 chat.js 常驻进程兼容键计入其
// mtime → 同会话下条消息自动换新进程加载新 MCP。不能直接用 ~/.claude.json 的 mtime(CLI 每次
// 会话都写它,会杀死复用);落盘文件而非内存 epoch(mtime 跨 server 重启稳定,内存变量重启归零
// 会与旧兼容键撞车误复用)。
function invalidateMcpCache() {
  invalidateMcpListCache();
  mkdir(GUI_DIR, { recursive: true })
    .then(() => writeFile(MCP_STAMP_FILE, String(Date.now()) + '\n'))
    .catch(() => {}); // fire-and-forget:戳写失败只影响"下条消息自动生效",不阻塞主流程
}

// 直接读 ~/.claude.json 顶层 mcpServers(`claude mcp add -s user` 的真实落点)。
// 秒回、不做健康检查 —— 保证用户加的 MCP 一定显示,即便 `claude mcp list` 的健康检查
// 超时。(注:CLI 配置在 home 下的 .claude.json 文件,不是 .claude/settings.json。)
async function readUserMcpServers() {
  try {
    const j = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf-8'));
    const servers = j.mcpServers || {};
    return Object.entries(servers).map(([name, cfg]) => {
      const isHttp = cfg.type === 'http' || cfg.type === 'sse' || (!cfg.command && !!cfg.url);
      return {
        name,
        command: isHttp ? (cfg.url || '') : [cfg.command || '', ...(cfg.args || [])].join(' ').trim(),
        args: cfg.args || [],
        env: cfg.env ? Object.keys(cfg.env) : [],
        transport: isHttp ? (cfg.type || 'http') : 'stdio',
        status: 'unknown',
        source: 'config',
      };
    });
  } catch { return []; }
}

// 构建 MCP 列表。抽成函数供端点同步调用 + 后台刷新 + 启动预热复用。
// liveStatus=false:跳过 `claude mcp list` 健康检查(3~33s 剧烈波动、卡哪个服务器都拖慢),
//   只用配置文件 + 快文件读,~300ms 秒回 —— 冷加载首屏用它,避免"每次进面板都卡几十秒"。
// liveStatus=true:补做健康检查,覆盖在线状态 + 发现 plugin/project 提供的 MCP —— 后台刷新用它。
async function buildMcpList({ liveStatus = true } = {}) {
    const result = { mcpServers: [], plugins: [], external: [] };

    // 1a. 先从 ~/.claude.json 直接读已配置的 user-scope MCP —— 秒回、不依赖健康检查。
    //     根治"加了不显示":`claude mcp list` 会对每个服务器做健康检查,服务器一多即 >10s,
    //     旧版 runClaude 默认 10s 超时 → 抛错 → 落回 settings.json(没有 CLI 加的服务器)
    //     → 整列表丢失(用户多机复现、重启无效的根因)。
    const byName = new Map();
    for (const s of await readUserMcpServers()) {
      result.mcpServers.push(s);
      byName.set(s.name, s);
    }

    // 1b. (仅 liveStatus)TRY `claude mcp list`(健康检查慢且波动大,给 60s)覆盖在线状态 +
    //     补 plugin/project 提供的 MCP。失败/超时也无妨:上面已从配置文件给出列表,不致空。
    //     冷加载不做这步(liveStatus=false),把几十秒的健康检查甩到后台,首屏只等文件读。
    if (liveStatus) {
      try {
        const output = await runClaude(['mcp', 'list'], { timeout: 60000 });
        for (const ls of parseMcpList(output)) {
          const ex = byName.get(ls.name);
          if (ex) ex.status = ls.status;           // 已有(配置文件)→ 仅覆盖 live 状态
          else { result.mcpServers.push(ls); byName.set(ls.name, ls); } // plugin/project 提供的
        }
      } catch {}
    }

    // 2. Installed plugins (also parse `claude plugin list` for enabled state)
    let pluginEnabled = {};
    try {
      const out = await runClaude(['plugin', 'list'], { timeout: 8000 });
      // Format: blocks separated by blank lines, each containing
      //   ❯ <name>@<marketplace>
      //   ...
      //   Status: ✔ enabled | ✘ disabled | ✘ failed to load
      const blocks = out.split(/\n(?=\s*❯)/);
      for (const block of blocks) {
        const nameMatch = block.match(/❯\s*([^@\s]+)/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        pluginEnabled[name] = /Status:\s*✔\s*enabled/i.test(block);
      }
    } catch {}
    try {
      const pluginsData = JSON.parse(
        await readFile(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf-8')
      );
      const plugins = pluginsData.plugins || {};
      for (const [name, instances] of Object.entries(plugins)) {
        const inst = Array.isArray(instances) ? instances[0] : instances;
        const bareName = name.split('@')[0];
        result.plugins.push({
          name,
          version: inst.version || '?',
          scope: inst.scope || 'user',
          installPath: inst.installPath || '',
          installedAt: inst.installedAt || null,
          lastUpdated: inst.lastUpdated || null,
          // Match by bare name first (installed_plugins.json keys can include
          // `@marketplace`), fall back to assuming enabled if unparseable.
          enabled: pluginEnabled[bareName] !== undefined ? pluginEnabled[bareName] : true,
        });
      }
    } catch {}

    // 4. External MCP projects
    try {
      const externalDir = join(CLAUDE_DIR, 'external');
      const entries = await readdir(externalDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(externalDir, entry.name);
        let type = 'unknown';
        let files = [];
        try {
          if (entry.isDirectory()) {
            type = 'directory';
            files = (await readdir(fullPath)).slice(0, 10);
          } else {
            type = 'file';
            const s = await stat(fullPath);
            files = [`${s.size} bytes`];
          }
        } catch {}
        result.external.push({ name: entry.name, type, files, path: fullPath });
      }
    } catch {}

    // 5. Merge disabled state。claude mcp list 是权威来源:出现在 live 列表里 = 已注册
    // 启用。若某服务器既在 live 列表又在 disabled.json,那是过期残留(被外部重新 add
    // 过)→ 视为启用并清理残留;否则 GUI 会显示"已禁用",点开 enable 又因"已存在"
    // 报错 → 开关闪一下回滚(用户报告的 desktop-commander 现象)。disabled.json 里
    // 不在 live 列表的才是真正禁用的,补成禁用行供用户重新启用(原来这类服务器根本不显示)。
    try {
      const disabled = JSON.parse(await readFile(DISABLED_FILE, 'utf-8'));
      const liveNames = new Set(result.mcpServers.map((s) => s.name));
      let stale = false;
      for (const srv of result.mcpServers) {
        srv.enabled = true;
        if (disabled[srv.name]) { delete disabled[srv.name]; stale = true; } // 残留,清理
      }
      for (const [name, cfg] of Object.entries(disabled)) {
        if (liveNames.has(name)) continue;
        result.mcpServers.push({
          name,
          command: cfg.command || '',
          args: cfg.args || [],
          env: [],
          transport: cfg.transport || 'stdio',
          status: 'disconnected',
          enabled: false,
          disabledConfig: cfg,
        });
      }
      if (stale) { try { await writeDisabled(disabled); } catch {} }
    } catch {
      for (const srv of result.mcpServers) {
        srv.enabled = true;
      }
    }

    // 6. 附加 GUI 元数据:自动放行(autoApprove)+ 显示名(label)。
    try {
      const auto = new Set(await readJsonFile(AUTOAPPROVE_FILE, []));
      const meta = await readJsonFile(META_FILE, {});
      for (const srv of result.mcpServers) {
        srv.autoApprove = auto.has(srv.name);
        srv.label = meta[srv.name]?.label || '';
      }
    } catch {}

    return result;
}

let mcpRefreshing = false;
function refreshMcpCache() {
  if (mcpRefreshing) return;
  mcpRefreshing = true;
  buildMcpList()
    .then((r) => { mcpCache = r; mcpCacheAt = Date.now(); })
    .catch(() => {})
    .finally(() => { mcpRefreshing = false; });
}

// GET /api/mcp — stale-while-revalidate:有缓存(即使过期)立即秒回,过期再后台刷新。
// 冷加载(无缓存)走"快路径"(不做健康检查,~300ms 秒回),在线状态由后台补——彻底消除
// "每次进面板都卡几十秒等 claude mcp list 健康检查"。?fresh=1 强制阻塞做完整健康检查。
router.get('/mcp', async (req, res) => {
  const fresh = req.query.fresh === '1';
  if (!fresh && mcpCache) {
    res.json(mcpCache);
    if (Date.now() - mcpCacheAt >= MCP_CACHE_TTL_MS) refreshMcpCache();
    return;
  }
  try {
    // fresh=1:阻塞做完整(含健康检查)。冷加载:只做快路径秒回,随后后台补在线状态。
    const result = await buildMcpList({ liveStatus: fresh });
    mcpCache = result;
    mcpCacheAt = Date.now();
    res.json(result);
    if (!fresh) refreshMcpCache(); // 后台 liveStatus:true 覆盖在线状态 + 补 plugin/project MCP
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 启动预热:延迟后台构建一次缓存,使用户首次进 MCP 面板即秒回(把健康检查 ~5s 挪到
// 启动后台,不阻塞启动)。
setTimeout(() => refreshMcpCache(), 8000);

// 启动回填:把当前所有已配置 MCP 同步进所有 agent(覆盖升级前就存在的 MCP、GUI 关闭期间
// 外部加的)。add-only 幂等——已含则 rewrite 返回 null 不写盘,无副作用。符合用户选择的
// "所有 agent 都能用所有 MCP"。删除 MCP 由 DELETE 端点同步移除,故此处只 add 当前集不会复活已删的。
setTimeout(async () => {
  try {
    const names = (await readUserMcpServers()).map((s) => s.name);
    if (names.length) await syncMcpToAgents({ add: names });
  } catch {}
}, 9000);

// Helper: read disabled MCP configs
async function readDisabled() {
  try {
    return JSON.parse(await readFile(DISABLED_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

async function writeDisabled(data) {
  await mkdir(GUI_DIR, { recursive: true });
  await writeFile(DISABLED_FILE, JSON.stringify(data, null, 2) + '\n');
}

// `claude mcp get` 冷启动 ~3s。编辑表单回填会打这个端点,缓存住让二次编辑秒开。
// 任何增删改(invalidateMcpCache)一并清空,避免回填到旧配置。
const detailsCache = new Map(); // name -> { at, out }
const DETAILS_TTL_MS = 5 * 60_000;
function invalidateDetailsCache() { detailsCache.clear(); }

// 请求头键名白名单:RFC 7230 token 字符集(字母数字与 !#$%&'*+.^_`|~-)。之前只放
// [A-Za-z0-9-],下划线等合法键(实抓 CLI 接受 X-Custom_Key)被静默丢弃 → 保存"成功"
// 但 server 实际没带该头,连接失败无线索。client/src/components/McpForm.jsx 内联同一
// regex 做提交前即时校验 —— 改这里必须同步那边。
export const HEADER_KEY_RE = /^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/;

// 从 `claude mcp get` 文本解析 Headers: 段(缩进的 `Key: value` 行,http/sse 才有)。
// 实抓(2026-07):get 输出明文值(add 输出才 [REDACTED]),可用于编辑回显。
// "禁用→启用带回 headers"与编辑回显全押在这个解析上 → export 供单测钉死
// (tests/unit/check-mcp-add-headers.mjs,含真实 `claude mcp get` 输出样本)。
export function parseHeadersFromDetails(details) {
  const headers = {};
  const section = String(details || '').split(/\n\s*Headers:/)[1];
  if (section) {
    for (const line of section.split('\n')) {
      if (/^To remove/.test(line.trim())) break;
      const hm = line.match(/^\s+([!#$%&'*+.^_`|~A-Za-z0-9-]+):\s?(.*)$/);
      if (hm) headers[hm[1]] = hm[2];
    }
  }
  return headers;
}

async function getServerDetails(name) {
  try {
    assertSafeName(name);
    const hit = detailsCache.get(name);
    if (hit && (Date.now() - hit.at) < DETAILS_TTL_MS) return hit.out;
    const out = await runClaude(['mcp', 'get', name]);
    detailsCache.set(name, { at: Date.now(), out });
    return out;
  } catch {
    return null;
  }
}

/**
 * GET /api/mcp/:name/ping
 * Hit `claude mcp get <name>` to verify the server is registered and (for
 * stdio servers) its command resolves. Returns the raw CLI output plus a
 * parsed status: ok | error | unknown. For HTTP transport, also attempts
 * a HEAD request to the URL.
 */
router.get('/mcp/:name/ping', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);
    const start = Date.now();
    let output, status = 'ok', detail = '';
    // CI-3:`claude mcp get` 不是纯读配置——它会真去 spawn+连接 MCP server 验证。stdio server
    // 经 uvx/npx 冷启动首次可能 >10s(用户报 16s 即 Command failed)。① 超时给足 40s;② 冷启
    // 暖机失败(超时/Failed to connect)等 1.5s 重试一次(第二次缓存已暖,常成功)。
    const getOnce = (t) => runClaude(['mcp', 'get', name], { timeout: t });
    const looksTransient = (e) => /timed out|ETIMEDOUT|Failed to connect|not connected|disconnected/i
      .test((e?.stderr?.toString() || '') + ' ' + (e?.message || ''));
    try {
      output = await getOnce(40000);
    } catch (err) {
      if (looksTransient(err)) {
        await new Promise((r) => setTimeout(r, 1500));
        try { output = await getOnce(40000); }
        catch (err2) { output = err2.stderr?.toString() || err2.message; status = 'error'; detail = err2.message; }
      } else {
        output = err.stderr?.toString() || err.message;
        status = 'error';
        detail = err.message;
      }
    }
    // Parse the actual connection status from CLI output (not just exit code):
    //   "Status: ✓ Connected" → ok
    //   "Status: ✘ disconnected" / "Status: ✘ failed" → error
    //   "Status: ✘ Failed to connect" → error
    if (status === 'ok' && output) {
      if (/Status:\s*✘|failed to connect|not connected|disconnected/i.test(output)) {
        status = 'error';
        const m = output.match(/Status:\s*✘\s*([^\n]+)/i);
        detail = m ? m[1].trim() : 'not connected';
      } else if (/Status:\s*✔|Connected/i.test(output)) {
        status = 'ok';
        detail = 'connected';
      }
    }
    // If it's an HTTP transport, attempt a HEAD ping too — purely informational.
    const urlMatch = output && output.match(/URL:\s*(https?:\/\/\S+)/);
    let httpStatus = null;
    if (urlMatch) {
      try {
        // SSRF 守卫(与 provider baseURL 同口径,本机环回 MCP 放行):URL 来自 MCP 配置,
        // server 主动 fetch 前挡内网/云元数据地址。
        await assertPublicBaseURL(urlMatch[1]);
        // SSRF 防护:redirect 必须 manual。assertPublicBaseURL 只校验初始 URL,
        // follow 会让 302 绕进私网/云元数据地址。ping 场景不需要跟跳,3xx 直接按失败处理。
        const r = await fetch(urlMatch[1], { method: 'HEAD', redirect: 'manual' });
        httpStatus = r.status;
        if (httpStatus >= 300 && httpStatus < 400) throw new Error(`HTTP ${httpStatus} redirect`);
        // HTTP server may not allow HEAD — that's not a real failure if
        // the CLI itself says Connected.
        if (httpStatus >= 500 && status === 'ok') {
          status = 'error';
          detail = `HTTP ${httpStatus}`;
        }
      } catch (err) {
        httpStatus = -1;
        // CLI Connected + HEAD failed is normal for some transports.
        if (status === 'ok' && !/Connected/i.test(output)) {
          status = 'error';
          detail = err.message;
        }
      }
    }
    // stdio 失败:claude mcp get 只说 "Failed to connect",不吐真因。自己 spawn 该命令
    // 抓早期 stderr,给用户看到具体原因(命令未找到 / 包无可执行入口 / 缺依赖等)。
    let stderr = '';
    if (status === 'error' && !urlMatch) {
      const cfg = await readRawMcpConfig(name);
      if (cfg) stderr = await probeStdioStderr(cfg);
    }
    // CI-3:npx/uvx 缓存损坏(常见 Windows:_npx 下半截依赖丢失)报 ERR_MODULE_NOT_FOUND /
    // Cannot find package —— 这是用户机环境问题,给可操作修复提示,别只甩原始堆栈。
    // Windows pip 残留 uvx 垫片(见 rewriteUvCommandLine 注释):给定向修复指引,并附检测到的真实 uv 位置。
    if (stderr && /Could not find the `?uv`? binary/i.test(stderr)) {
      let uvHint = '';
      try { const hit = await detectUv(); if (hit?.installed && hit.path) uvHint = `\n(本机已检测到可用 uv:${hit.path})`; } catch {}
      stderr = '⚠️ PATH 上的 uvx 是 pip 残留的启动器:它只找自己同目录的 uv.exe,而那里没有,'
        + '于是挡住了真正可用的 uv。修复任选:① 在 GUI 里「编辑」该 MCP 直接保存(会自动改用真实 uv 的绝对路径);'
        + '② 删除报错路径里残留的 uvx.exe(或 pip uninstall uv)后重试。' + uvHint + '\n\n原始报错:\n' + stderr;
    }
    if (stderr && /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/i.test(stderr)) {
      stderr = '⚠️ npx/uvx 缓存损坏(常见于 Windows)。修复:终端运行 `npm cache clean --force`,'
        + '或删除「用户目录\\AppData\\Local\\npm-cache\\_npx」后重试;uvx 则运行 `uv cache clean`。\n\n原始报错:\n'
        + stderr;
    }
    res.json({
      name, status,
      ms: Date.now() - start,
      httpStatus,
      output: (output || '').slice(0, 1500),
      detail,
      stderr, // 真实子进程报错(stdio 失败时),前端展示
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/mcp/:name/login — OAuth 授权:执行 `claude mcp login <name>`。CLI 会打开系统
// 浏览器走授权流程,本地起回调服务,收到回调后进程才退出 → 超时给足 180s 等用户在浏览器
// 完成操作。名字不存在 / 非 OAuth 服务器时 CLI 快速报错,stderr 原样透传给前端展示。
router.post('/mcp/:name/login', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);
    await runClaude(['mcp', 'login', name], { timeout: 180000 });
    invalidateMcpCache();
    res.json({ ok: true, name });
  } catch (err) {
    // execFile 超时会杀掉子进程并置 killed —— 通常是用户未在浏览器完成授权。
    if (err.killed) {
      return res.status(504).json({ error: '等待浏览器授权超时(3 分钟)。若已完成授权,点「刷新」查看状态;否则重新点登录。' });
    }
    res.status(500).json({ error: (err.stderr?.toString() || err.message || '').trim() || '登录失败' });
  }
});

// POST /api/mcp/:name/logout — 清除该服务器已存储的 OAuth 凭证(claude mcp logout)。
router.post('/mcp/:name/logout', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);
    await runClaude(['mcp', 'logout', name], { timeout: 15000 });
    invalidateMcpCache();
    res.json({ ok: true, name });
  } catch (err) {
    res.status(500).json({ error: (err.stderr?.toString() || err.message || '').trim() || '登出失败' });
  }
});

router.put('/mcp/:name/enable', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);
    const disabled = await readDisabled();
    const config = disabled[name];
    if (!config) return res.status(404).json({ error: 'Server not found in disabled list' });

    const isHttp = config.transport === 'http' || config.transport === 'sse';
    const httpUrl = config.url || config.command;
    // 旧版禁用的 http/sse 服务器可能没存 URL(命令为空)→ 无法重建连接。给出可操作的
    // 错误而不是让 claude mcp add 报晦涩错误后开关弹回。用户删掉它重新添加即可(#3)。
    if (isHttp && (!httpUrl || !String(httpUrl).trim())) {
      return res.status(400).json({
        error: `无法启用「${name}」：该 ${config.transport} 服务器的连接地址(URL)未保存(早期版本禁用 http MCP 时丢了 URL)。请点删除后用「添加」重新填写 URL 即可。`,
      });
    }
    const args = ['mcp', 'add'];
    if (isHttp) args.push('--transport', config.transport);
    if (config.scope) args.push('-s', String(config.scope));
    args.push(name);
    if (isHttp) {
      args.push(String(httpUrl).trim());
      // 禁用时存下的请求头原样带回,否则带 headers 的 server 启用后连不上。
      for (const [k, v] of Object.entries(config.headers || {})) {
        if (HEADER_KEY_RE.test(String(k).trim())) args.push('-H', `${String(k).trim()}: ${v ?? ''}`);
      }
    } else {
      args.push('--', String(config.command), ...((config.args || []).map(String)));
    }

    try {
      await runClaude(args, { timeout: 15000 });
    } catch (e) {
      // "already exists" = 它其实已在 claude 注册(disabled.json 是残留)→ 当作启用
      // 成功,清理残留即可,不再把这当失败回滚开关。
      if (!/already exists/i.test(e.message || '') && !/already configured/i.test(e.message || '')) throw e;
    }

    delete disabled[name];
    await writeDisabled(disabled);
    invalidateMcpCache();
    res.json({ ok: true, name, enabled: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/mcp/:name/disable', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);

    const details = await getServerDetails(name);
    if (!details) return res.status(404).json({ error: 'Server not found' });

    const config = { name };
    const cmdMatch = details.match(/Command:\s*(.+)/);
    const argsMatch = details.match(/Args:\s*(.+)/);
    const urlMatch = details.match(/URL:\s*(.+)/);
    const typeMatch = details.match(/Type:\s*(\S+)/);
    const scopeMatch = details.match(/Scope:\s*(.+?)(?:\s*\(|$)/m);

    config.transport = (typeMatch ? typeMatch[1] : 'stdio').toLowerCase();
    config.scope = scopeMatch ? scopeMatch[1].trim().toLowerCase().split(' ')[0] : 'user';
    if (config.transport === 'http' || config.transport === 'sse') {
      // http/sse 的连接地址在 `URL:` 字段,不是 `Command:`。以前只读 Command → http MCP
      // 被禁用后 url 丢失(存成空),再启用因缺 URL 失败、开关弹回(用户报告的 xiaohongshu #3)。
      const u = urlMatch ? urlMatch[1].trim() : (cmdMatch ? cmdMatch[1].trim() : '');
      config.url = u;
      config.command = u; // 兼容旧 enable 逻辑(它对 http 读 config.command 当 URL)
      config.args = [];
      config.headers = parseHeadersFromDetails(details); // 不存则禁用→启用会丢请求头,连不上
    } else {
      config.command = cmdMatch ? cmdMatch[1].trim() : '';
      config.args = argsMatch ? argsMatch[1].trim().split(/\s+/) : [];
    }

    const disabled = await readDisabled();
    disabled[name] = config;
    await writeDisabled(disabled);

    await runClaude(['mcp', 'remove', name]);
    invalidateMcpCache();
    res.json({ ok: true, name, enabled: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 组装 `claude mcp add` 参数(新增/编辑共用)。stdio:命令行拆成 cmd+args 跟在 -- 后;
// http/sse:直接给 URL。env 用可重复的 -e KEY=VAL。scope 用 -s。
// Windows pip 残留 uvx 垫片坑:老 pip 装的 Python*\Scripts\uvx.exe 是个启动器,只找**同目录**
// 的 uv.exe(pip 卸载不净/杀毒隔离后缺失),报 "Could not find the `uv` binary at either of:…"。
// claude 按 PATH 解析裸 `uvx` 会先撞上这个坏垫片,而 env-check 检测到的真实 uv(astral/winget
// 装的)在别处。添加/编辑 stdio MCP 时把裸 uvx/uv 改写为真实 uv 同目录的绝对路径(带引号,
// parseCommandLine 支持),claude spawn 时直接命中好的那个,与 PATH 顺序无关。
async function rewriteUvCommandLine(commandLine) {
  if (process.platform !== 'win32' || typeof commandLine !== 'string') return commandLine;
  const m = commandLine.match(/^(\s*)(uvx|uv)(\s|$)/i);
  if (!m) return commandLine;
  try {
    const hit = await detectUv();
    if (!hit?.installed || !hit.path) return commandLine;
    let uvPath = hit.path;
    if (!/[\\/]/.test(uvPath)) {
      // PATH 命中时 detectUv 返回裸名,用 where 拿绝对路径(坏垫片目录没有 uv.exe,where uv 不会命中它)
      const { stdout } = await execFileP('where', ['uv'], { timeout: 5000 });
      uvPath = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
    }
    if (!uvPath) return commandLine;
    const abs = join(dirname(uvPath), `${m[2].toLowerCase()}.exe`);
    if (!existsSync(abs)) return commandLine;
    return `${m[1]}"${abs}"${commandLine.slice(m[1].length + m[2].length)}`;
  } catch { return commandLine; }
}

// export 供单测(tests/unit/check-mcp-add-headers.mjs)直接断言参数组装。
// droppedHeaderKeys(可选,调用方传入数组):收集因键名非法被丢弃的请求头键,
// 供 add/编辑端点在响应里带 warning —— 否则用户"保存成功"但该头没提交,连接失败无线索。
export function buildAddArgs({ name, transport, commandLine, url, env, headers, scope }, droppedHeaderKeys = []) {
  const args = ['mcp', 'add'];
  if (transport === 'http' || transport === 'sse') args.push('-t', transport);
  args.push('-s', scope || 'user');
  // 名称必须在 -e 之前:`-e` 是变长参数(<env...>),若放名称前会把名称也当成 env 吞掉
  // ("Invalid environment variable format: <name>")。
  args.push(name);
  const envFlags = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (k && k.trim()) envFlags.push('-e', `${k.trim()}=${v ?? ''}`);
  }
  if (transport === 'http' || transport === 'sse') {
    if (!url || !url.trim()) throw new Error('URL 不能为空');
    // 自定义请求头:每对一个 `-H "Key: Value"`(CLI 2026-07 实抓:-H, --header <header...>)。
    // 键名限 RFC 7230 token 字符,含冒号/空格的非法键整对丢弃并记入 droppedHeaderKeys
    // (键来自表单/注册表,是数据不是指令;只记键名不记值,避免密钥进日志/响应)。
    const headerFlags = [];
    for (const [k, v] of Object.entries(headers || {})) {
      const key = String(k || '').trim();
      if (HEADER_KEY_RE.test(key)) headerFlags.push('-H', `${key}: ${v ?? ''}`);
      else if (key) droppedHeaderKeys.push(key);
    }
    // url 在前,-H/-e 放末尾(变长参数在结尾不会吞掉其它位置参数)。
    args.push(url.trim(), ...headerFlags, ...envFlags);
  } else {
    const { command, args: cargs } = parseCommandLine(commandLine);
    if (!command) throw new Error('命令不能为空');
    // -e 在 -- 之前;-- 之后是子进程命令,会终止 -e 的变长吞噬。
    args.push(...envFlags, '--', command, ...cargs);
  }
  return args;
}

// 非法请求头键被丢弃时的响应 warning 文案(只含键名,不含值)。
function droppedHeaderWarning(keys) {
  return `请求头 ${keys.join('、')} 的键名含非法字符(仅允许字母数字与 !#$%&'*+.^_\`|~-),已忽略未提交,该 server 可能因此连不上。`;
}

// 跑 `claude mcp add`。坑:同名已存在时它把 "already exists" 打到 **stderr** 且**退出码 0**
// (既不覆盖也不报错)→ runClaude 只取 stdout、execFileP 不 reject → 会"假成功"(GUI 显示
// 添加成功但其实没加上/没改)。这里捕获 stderr 显式检测,变成明确的 409 错误。
async function runMcpAdd(args, name) {
  const exists = () => {
    const err = new Error(`MCP 服务器「${name}」已存在,未做修改。请先删除它,或改用「编辑」修改配置。`);
    err.status = 409;
    return err;
  };
  let res;
  try {
    const { file, args: fullArgs } = claudeCommand(args);
    res = await execFileP(file, fullArgs, { encoding: 'utf-8', timeout: 20000, env: { ...process.env }, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    // 同名已存在时 claude mcp add **退出码非零** 且把 "already exists" 打到 stderr → 走这里。
    const stderr = (e.stderr?.toString() || e.message || '').trim();
    if (/already exists/i.test(stderr)) throw exists();
    throw new Error(stderr || '添加失败'); // 其它硬失败:抛上游 stderr,比 "Command failed" 有用
  }
  // 防御:万一某版本退出 0 仍把 already exists 打 stderr(此分支在 try 外,不会被上面 catch 吞)。
  if (/already exists/i.test(res.stderr || '')) throw exists();
}

// POST /api/mcp — 新增一个 MCP 服务器。
// body: { name, transport, commandLine?, url?, env?, scope?, autoApprove?, label? }
router.post('/mcp', async (req, res) => {
  try {
    const b = req.body || {};
    assertSafeName(b.name);
    const scope = ['user', 'project', 'local'].includes(b.scope) ? b.scope : 'user';
    const transport = ['stdio', 'http', 'sse'].includes(b.transport) ? b.transport : 'stdio';
    if (transport === 'stdio') b.commandLine = await rewriteUvCommandLine(b.commandLine);
    const droppedHeaderKeys = [];
    const args = buildAddArgs({ ...b, transport, scope }, droppedHeaderKeys);
    await runMcpAdd(args, b.name); // 检测"already exists"假成功
    await setAutoApprove(b.name, !!b.autoApprove);
    await setMeta(b.name, b.label);
    // 新增即启用:清掉可能存在的同名禁用残留
    try { const dis = await readDisabled(); if (dis[b.name]) { delete dis[b.name]; await writeDisabled(dis); } } catch {}
    try { await syncMcpToAgents({ add: [b.name] }); } catch {} // 自动让所有 agent 能用这个 MCP
    invalidateMcpCache();
    res.json({ ok: true, name: b.name, ...(droppedHeaderKeys.length ? { warning: droppedHeaderWarning(droppedHeaderKeys) } : {}) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// PUT /api/mcp/:name/config — 编辑:先 remove 再按新配置 add(claude 无 in-place 编辑)。
router.put('/mcp/:name/config', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);
    const b = req.body || {};
    assertSafeName(b.name || name);
    const newName = b.name || name;
    const scope = ['user', 'project', 'local'].includes(b.scope) ? b.scope : 'user';
    const transport = ['stdio', 'http', 'sse'].includes(b.transport) ? b.transport : 'stdio';
    if (transport === 'stdio') b.commandLine = await rewriteUvCommandLine(b.commandLine);
    const droppedHeaderKeys = [];
    const addArgs = buildAddArgs({ ...b, name: newName, transport, scope }, droppedHeaderKeys);
    // 改名场景:若目标名已被另一个服务器占用,必须在删除旧的之前拦下 —— 否则先 remove 旧的、
    // 再 add 撞 "already exists" 静默失败 → 旧服务器没了、新的没加上 = 数据丢失。
    if (newName !== name && await getServerDetails(newName)) {
      return res.status(409).json({ error: `目标名「${newName}」已被另一个 MCP 占用,换个名字或先删除它。` });
    }
    // 先移除旧的(各 scope 尽力删,忽略不存在错误),再加新的。
    for (const s of ['user', 'project', 'local']) {
      try { await runClaude(['mcp', 'remove', name, '-s', s]); } catch {}
    }
    try { const dis = await readDisabled(); if (dis[name]) { delete dis[name]; await writeDisabled(dis); } } catch {}
    await runMcpAdd(addArgs, newName);
    // 改名时迁移 autoapprove / meta
    if (newName !== name) { await setAutoApprove(name, false); await setMeta(name, ''); }
    await setAutoApprove(newName, !!b.autoApprove);
    await setMeta(newName, b.label);
    // 改名:同步各 agent 的工具引用(旧名移除、新名加入);同名编辑无需动。
    if (newName !== name) { try { await syncMcpToAgents({ add: [newName], remove: [name] }); } catch {} }
    invalidateMcpCache();
    res.json({ ok: true, name: newName, ...(droppedHeaderKeys.length ? { warning: droppedHeaderWarning(droppedHeaderKeys) } : {}) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// DELETE /api/mcp/:name — 彻底删除(不进禁用列表):各 scope remove + 清理 GUI 元数据。
router.delete('/mcp/:name', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);
    for (const s of ['user', 'project', 'local']) {
      try { await runClaude(['mcp', 'remove', name, '-s', s]); } catch {}
    }
    try { const dis = await readDisabled(); if (dis[name]) { delete dis[name]; await writeDisabled(dis); } } catch {}
    await setAutoApprove(name, false);
    await setMeta(name, '');
    try { await syncMcpToAgents({ remove: [name] }); } catch {} // 删 MCP 同步移除各 agent 的 mcp__name__*
    invalidateMcpCache();
    res.json({ ok: true, name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/mcp/:name/config — 取结构化配置供编辑表单回填(live 用 claude mcp get,
// 禁用态读 disabled.json)。返回 { name, transport, commandLine, url, env, scope, autoApprove, label }。
router.get('/mcp/:name/config', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);
    const autoApprove = (await readJsonFile(AUTOAPPROVE_FILE, [])).includes?.(name) || false;
    const label = (await readJsonFile(META_FILE, {}))[name]?.label || '';
    // 优先禁用态配置(结构化),否则解析 claude mcp get。
    const dis = await readDisabled();
    if (dis[name]) {
      const c = dis[name];
      const transport = c.transport || 'stdio';
      return res.json({
        name, transport, scope: c.scope || 'user', autoApprove, label,
        commandLine: transport === 'stdio' ? [c.command, ...(c.args || [])].filter(Boolean).join(' ') : '',
        url: transport !== 'stdio' ? (c.command || '') : '',
        env: c.env || {},
        headers: c.headers || {},
      });
    }
    const details = await getServerDetails(name);
    if (!details) return res.status(404).json({ error: 'Server not found' });
    const typeMatch = details.match(/Type:\s*(\S+)/);
    const cmdMatch = details.match(/Command:\s*(.+)/);
    const argsMatch = details.match(/Args:\s*(.+)/);
    const urlMatch = details.match(/URL:\s*(.+)/);
    const scopeMatch = details.match(/Scope:\s*(\S+)/);
    const transport = typeMatch ? typeMatch[1] : 'stdio';
    const cmd = cmdMatch ? cmdMatch[1].trim() : '';
    const cargs = argsMatch && argsMatch[1].trim() ? argsMatch[1].trim() : '';
    // 解析 Environment: 段(缩进的 KEY=value),否则编辑时会丢失已有 env。
    const env = {};
    const envSection = details.split(/Environment:/)[1];
    if (envSection) {
      for (const line of envSection.split('\n')) {
        if (/^To remove/.test(line.trim())) break;
        const em = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (em) env[em[1]] = em[2];
      }
    }
    res.json({
      name, transport,
      scope: scopeMatch ? scopeMatch[1].trim().toLowerCase() : 'user',
      autoApprove, label,
      commandLine: transport === 'stdio' ? [cmd, cargs].filter(Boolean).join(' ') : '',
      url: transport !== 'stdio' ? (urlMatch ? urlMatch[1].trim() : cmd) : '',
      env,
      headers: transport !== 'stdio' ? parseHeadersFromDetails(details) : {},
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/mcp/:name/autoapprove { on } — 单独切换"自动执行工具"。
router.put('/mcp/:name/autoapprove', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);
    await setAutoApprove(name, !!(req.body || {}).on);
    invalidateMcpListCache(); // autoapprove 运行时实时读,不换进程(不 touch 换代戳)
    res.json({ ok: true, name, autoApprove: !!(req.body || {}).on });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Plugin enable/disable — delegates to `claude plugin {enable|disable} <name>`.
// Accepts either bare name ("pua") or qualified ("pua@pua-skills"); CLI handles both.
router.put('/plugins/:name/enable', async (req, res) => {
  try {
    const { name } = req.params;
    if (!/^[A-Za-z0-9._@\-/]{1,100}$/.test(name)) throw new Error('invalid plugin name');
    await runClaude(['plugin', 'enable', name], { timeout: 15000 });
    invalidateMcpCache();
    res.json({ ok: true, name, enabled: true });
  } catch (err) {
    return sendPluginPublicError(res, err, { fallback: '启用失败' });
  }
});

router.put('/plugins/:name/disable', async (req, res) => {
  try {
    const { name } = req.params;
    if (!/^[A-Za-z0-9._@\-/]{1,100}$/.test(name)) throw new Error('invalid plugin name');
    await runClaude(['plugin', 'disable', name], { timeout: 15000 });
    invalidateMcpCache();
    res.json({ ok: true, name, enabled: false });
  } catch (err) {
    return sendPluginPublicError(res, err, { fallback: '停用失败' });
  }
});

// 更新插件到最新版:`claude plugin update <name@marketplace>`(官方说明:需重启会话生效)。
// 先 marketplace update 刷新目录再 plugin update,确保拉到真最新(与安装同一保险)。
router.post('/plugins/:name/update', async (req, res) => {
  try {
    const { name } = req.params;
    if (!/^[A-Za-z0-9._@\-/]{1,100}$/.test(name)) throw new Error('invalid plugin name');
    const mk = name.includes('@') ? name.split('@')[1] : '';
    const readVer = async () => {
      try {
        const reg = JSON.parse(await readFile(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf-8'));
        return reg?.plugins?.[name]?.[0]?.version || null;
      } catch { return null; }
    };
    const beforeVersion = await readVer(); // 更新前版本,用于判"其实没更新"
    if (mk) {
      try {
        await runClaude(['plugin', 'marketplace', 'update', mk], {
          timeout: PLUGIN_CLI_TIMEOUT_MS,
          env: await marketplaceProxyEnv(),
        });
      } catch {}
    }
    await runClaude(['plugin', 'update', name], { timeout: 90000 });
    invalidateMcpCache();
    const version = await readVer(); // 更新后版本(前端弹窗"已更新为 vX")
    // changed:版本号都在且变了=真更新;都在且没变=无更新;版本号缺失(无声明)=判不了(undefined),
    // 前端保留旧通用文案不误报版本。
    const changed = (version != null && beforeVersion != null) ? (version !== beforeVersion) : undefined;
    res.json({ ok: true, name, version, changed, note: '已更新,新会话生效' });
  } catch (err) {
    return sendPluginPublicError(res, err, { fallback: '更新失败' });
  }
});

// 卸载插件:`claude plugin uninstall <name@marketplace>`。卸载后它在「添加插件」列表回到未安装态。
router.delete('/plugins/:name', async (req, res) => {
  try {
    const { name } = req.params;
    if (!/^[A-Za-z0-9._@\-/]{1,100}$/.test(name)) throw new Error('invalid plugin name');
    await runClaude(['plugin', 'uninstall', name], { timeout: 30000 });
    invalidateMcpCache();
    res.json({ ok: true, name });
  } catch (err) {
    return sendPluginPublicError(res, err, { fallback: '卸载失败' });
  }
});

// 官方插件一键安装。CM-5:marketplace 不仅要 add,还要 **update** 刷新本地缓存——否则
// 缓存停在旧 commit(没有后加入的插件如 code-review)→ install 报 "not found / 本地副本过期"
// (Windows 上常见,Mac 缓存恰新所以能装)。
// r29:add/update 都不得 catch{} 吞错——update 失败(无代理拉不动 GitHub / git 问题 / 30s
// 超时)时缓存停在旧 commit 或根本没有,install 必然 not found,用户只看到最终 install 的错,
// 真实原因(市场刷新失败)被吞。故:add 仅忽略「已存在」类幂等报错,其余带上 stderr 原文抛出;
// update 失败一律抛出。
const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
const OFFICIAL_MARKETPLACE_REPO = 'anthropics/claude-plugins-official';
export const PLUGIN_CLI_TIMEOUT_MS = 120000;
const PLUGIN_PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
const PLUGIN_ERROR_FIELD_LIMIT = 4096;
const PLUGIN_PUBLIC_RESPONSE_LIMIT = 16 * 1024;
const PLUGIN_SECRET_KEY_SUFFIXES = new Set([
  'auth', 'authorization', 'credential', 'credentials', 'token', 'key', 'secret', 'password',
  'passwd', 'pwd', 'apikey', 'accesskey',
]);
// 全小写/全大写连写(monkey/donkey…)以 `key` 结尾却不是密钥;连写兜底的白名单。
const PLUGIN_NOT_SECRET_WORDS = new Set(['monkey', 'donkey', 'turkey', 'hockey', 'jockey', 'whiskey']);

function pluginEnvWithoutProxy(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of PLUGIN_PROXY_KEYS) delete env[key];
  return env;
}

// CLI stderr may echo repository/proxy credentials. Redact at the backend error boundary so
// every caller (including non-GUI clients) receives the same bounded, safe diagnostic.
export function stripPluginAnsi(value) {
  let text = String(value ?? '');
  // String controls first: OSC may end in BEL or ST; DCS/SOS/PM/APC end in ST.
  // 有界否定字符类替代惰性 [\s\S]*?:无终止符时后者对每个起点重扫全串(二次复杂度),
  // 400KB 恶意输入可阻塞事件循环挂死后端。字符串控制序列合法长度远小于 8192。
  text = text.replace(/(?:\x1B\]|\x9D)[^\x07\x1B\x9C]{0,8192}(?:\x07|\x1B\\|\x9C)/g, '');
  text = text.replace(/(?:\x1B[P^_X]|[\x90\x98\x9E\x9F])[^\x1B\x9C]{0,8192}(?:\x1B\\|\x9C)/g, '');
  // CSI has both the 7-bit ESC [ and single-byte C1 forms.
  text = text.replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g, '');
  text = text.replace(/\x1B[@-_]/g, '');
  return text.replace(/[\x80-\x9F]/g, '');
}

function isPluginSensitiveKey(key) {
  // 先剥零宽/控制字符,否则 `to<ZWSP>ken=` 会把敏感词劈开、绕过下面的按词判定。
  // 覆盖:控制符 + DEL、Unicode 格式类全类(Cf:软连字符/零宽/方向标记/BOM 等)、
  // CGJ、变体选择符全三段(蒙文 180B-180F + 基本面 FE00-FE0F + 增补面 E0100-E01EF)
  // ——枚举漏一个就是绕过(180B-180D/180F 是 Mn 不在 Cf 内,判官 R-1 实测劈键)。
  const raw = String(key || '').replace(/[\x00-\x1F\x7F\p{Cf}\u034F\u180B-\u180F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, '');
  const words = raw
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean);
  if (words.length > 0 && PLUGIN_SECRET_KEY_SUFFIXES.has(words.at(-1).toLowerCase())) return true;
  // 连写兜底(旧版语义):apikey/APIKEY/accesstoken/secretkey/authtoken/passwd… 无分隔符,
  // 按词切分只剩一个整词命不中后缀集 → 这里按后缀正则再兜一层。monkey 等假阳性先排除。
  const flat = raw.replace(/[^a-z\d]/gi, '').toLowerCase();
  if (PLUGIN_NOT_SECRET_WORDS.has(flat)) return false;
  return /(?:token|key|secret|password|passwd|credential)s?$/.test(flat);
}

export function sanitizePluginErrorText(value, limit = PLUGIN_ERROR_FIELD_LIMIT) {
  let text = stripPluginAnsi(value);
  // 控制符之外,零宽/软连字符也必须在下面所有键捕获/凭证正则之前剥掉,类与
  // isPluginSensitiveKey 对齐(保留 \t\n\r:行式正则依赖行边界)。否则 `au<ZWSP>th=`
  // 把键劈开后双向失灵:敏感值漏检、`mon<ZWSP>key=` 反被误遮、`Bear<ZWSP>er` 绕过。
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}\u034f\u180b-\u180f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu, '');
  text = text.replace(/\b([a-z][a-z\d+.-]*:\/\/)([^/\s@]+)@/gi, '$1[REDACTED]@');
  text = text.replace(/\b((?:Proxy-)?Authorization\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
  text = text.replace(/\b(Bearer|Basic)\s+(?:"[^"]*"|'[^']*'|[^\s"',;}\]]+)/gi, '$1 [REDACTED]');
  text = text.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, marker, key) => (
    isPluginSensitiveKey(key) ? `${marker}${key}=[REDACTED]` : match
  ));
  text = text.replace(/(["']?)([A-Za-z][A-Za-z\d_.-]*)\1(\s*[:=]\s*)(["'])(.*?)\4/g,
    (match, keyQuote, key, separator, valueQuote) => (
      isPluginSensitiveKey(key)
        ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`
        : match
    ));
  text = text.replace(/\b([A-Za-z][A-Za-z\d_.-]*)(\s*[:=]\s*)(?!\[REDACTED\])([^\r\n,;&}\]]+)/g,
    (match, key, separator) => (
      isPluginSensitiveKey(key) ? `${key}${separator}[REDACTED]` : match
    ));
  return text.trim().slice(0, Math.max(0, Math.min(Number(limit) || PLUGIN_ERROR_FIELD_LIMIT, PLUGIN_ERROR_FIELD_LIMIT)));
}

export function sanitizePluginPublicValue(value, key = '') {
  if (isPluginSensitiveKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return sanitizePluginErrorText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizePluginPublicValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    String(childKey).slice(0, 128),
    sanitizePluginPublicValue(childValue, childKey),
  ]));
}

function rawPluginErrorText(err) {
  // 保尾截断:即便正则已有界,超长 stderr 仍会拖慢逐条 replace。凭证/错误码通常在尾部;
  // 最终输出还会被 PLUGIN_ERROR_FIELD_LIMIT(4096)再截,这里 16KB 只为封住处理成本。
  const text = err?.stderr?.toString() || err?.message || String(err || '');
  if (text.length <= 16384) return text;
  // 切口可能把键值劈在中间:残尾没有键可判,脱敏正则失配 → 值尾巴裸露(判官实测)。
  // 对齐到下一行边界再交给脱敏(键值同行,整行一起丢);全文无换行时丢首 256 字符兜底
  // (>256 的裸值残尾属已接受残余,见 t12c)。
  const cut = text.slice(-16384);
  const nl = cut.search(/[\r\n]/);
  return (nl >= 0 && nl < cut.length - 1) ? cut.slice(nl + 1) : cut.slice(256);
}

function errText(err) {
  return sanitizePluginErrorText(rawPluginErrorText(err));
}
// `marketplace add` 对已注册源的幂等报错(已存在不算失败)。export 仅为可单测。
export function isMarketplaceAddIdempotent(err) {
  return /already (added|exists|registered)|已存在|已经添加/i.test(errText(err));
}
// install 报「找不到/缓存过期」形态 → 值得刷新市场重试。export 仅为可单测。
export function isMarketplaceStaleError(err) {
  return /out of date|not found|marketplace update|本地副本/i.test(errText(err));
}

// Only transient transport failures are retryable. Authentication, permission, invalid input,
// and marketplace/plugin not-found errors deliberately stay terminal.
export function isRetryablePluginNetworkError(err) {
  // CLI stderr 带 ANSI 着色:`4\x1B[0m03` 这类序列会把 403 劈开,让"认证/权限终局"的
  // 否决判据整条失效 → 401/403 被当成网络抖动无限重试。先剥控制序列再判。
  const text = stripPluginAnsi(rawPluginErrorText(err));
  if (/\b(?:EACCES|EPERM)\b|permission denied|\b(?:401|403)\b|unauthorized|forbidden|\b(?:invalid (?:argument|option|name|marketplace|plugin|scope)|unknown option)\b|\b(?:plugin|marketplace)(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;:,]+))?\s+not found\b/i.test(text)) {
    return false;
  }
  return /\b(?:ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|ETIMEDOUT)\b|connection (?:reset|refused|timed out)|request timed out|socket hang up|network is unreachable|temporary failure in name resolution|DNS (?:lookup|resolution|query) (?:failed|failure)|(?:TLS|SSL) (?:handshake|connection) (?:failed|failure|error)|temporar(?:y|ily) (?:network (?:failure|error)|unavailable)|(?:network|operation) timeout/i.test(text);
}

// 「这个代理值得带给子进程吗」。r49a-②:与 version-check.js 的 liveProxy 同设计 ——
// 【只对回环地址判死】。企业/局域网代理(proxy.corp:80、TUN 网关)探不通的原因太多
// (ACL、只认 CONNECT、探测源不同),而这里判死是有牙的(会把代理从子进程 env 删掉),
// 误杀一个能用的代理 = 插件市场整条链路改走直连挂死,比不探活更糟。故非回环一律信任;
// 回环才发 TCP 探测(本机代理软件退了就是真死),超时 2000ms —— 600ms 对冷启动偏紧。
// 解析失败/端口非法仍判不可用(原语义):那种值给谁都是坏的。
export async function probePluginProxy(proxyUrl, probe = probeTcp) {
  try {
    const raw = String(proxyUrl || '').trim();
    if (!raw) return false;
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    const defaults = { 'http:': 80, 'https:': 443, 'socks:': 1080, 'socks5:': 1080 };
    const port = Number(url.port) || defaults[url.protocol];
    if (!url.hostname || !port || port > 65535) return false;
    const host = url.hostname.replace(/^\[|\]$/g, ''); // IPv6 字面量带方括号,剥掉再探
    if (!isLoopbackProxyHost(host)) return true;
    return await probe(host, port, 2000);
  } catch {
    return false;
  }
}

// marketplace/add/update/install 共用的安全环境副本。四个继承代理逐一探活：死值只从
// 子进程副本删除，不修改父 env；可达值原样保留。自动探测结果也要可达，且只补空键。
export async function marketplaceProxyEnv(
  detect = detectLocalProxy,
  baseEnv = process.env,
  probe = probePluginProxy,
) {
  const env = { ...baseEnv };
  for (const key of PLUGIN_PROXY_KEYS) {
    const inherited = env[key];
    if (!inherited || !(await probe(inherited))) delete env[key];
  }
  const detected = await Promise.resolve().then(() => detect({ baseEnv: env })).catch(() => null);
  if (detected && await probe(detected)) {
    for (const key of PLUGIN_PROXY_KEYS) {
      if (!env[key]) env[key] = detected;
    }
  }
  return env;
}

class PluginCliError extends Error {
  constructor(details) {
    const safeDetails = sanitizePluginPublicValue(details);
    super(safeDetails.message);
    this.name = 'PluginCliError';
    this.details = safeDetails;
  }
}

function pluginCliError(stage, error, messagePrefix = '') {
  if (error instanceof PluginCliError) {
    if (!messagePrefix) return error;
    return new PluginCliError({ ...error.details, message: `${messagePrefix}${error.details.message}` });
  }
  const timedOut = error?.killed === true || error?.timedOut === true || error?.code === 'ETIMEDOUT';
  const message = `${messagePrefix}${errText(error) || 'Claude CLI 执行失败'}`;
  return new PluginCliError({
    stage,
    code: timedOut ? 'CLI_TIMEOUT' : 'CLI_EXIT_NONZERO',
    retryable: timedOut || isRetryablePluginNetworkError(error),
    timeoutMs: PLUGIN_CLI_TIMEOUT_MS,
    message,
    killed: error?.killed === true,
    timedOut,
    cliExitCode: error?.code ?? null,
    signal: error?.signal ?? null,
  });
}

function proxyPreflightError(error) {
  return new PluginCliError({
    stage: 'proxy-preflight',
    code: 'PROXY_UNREACHABLE',
    retryable: true,
    timeoutMs: PLUGIN_CLI_TIMEOUT_MS,
    message: `代理连通性检查失败:${errText(error) || '无法生成安全子进程环境'}`,
    killed: false,
    timedOut: false,
    cliExitCode: null,
    signal: null,
  });
}

function firstPluginPublicText(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstPluginPublicText(entry);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const found = firstPluginPublicText(entry);
      if (found) return found;
    }
  }
  return '';
}

function boundPluginPublicError(value, fallback) {
  const safeValue = sanitizePluginPublicValue(value);
  if (Buffer.byteLength(JSON.stringify({ error: safeValue }), 'utf8') <= PLUGIN_PUBLIC_RESPONSE_LIMIT) {
    return safeValue;
  }
  if (safeValue && typeof safeValue === 'object' && !Array.isArray(safeValue)
      && typeof safeValue.stage === 'string' && typeof safeValue.code === 'string') {
    return sanitizePluginPublicValue({
      stage: safeValue.stage,
      code: safeValue.code,
      retryable: !!safeValue.retryable,
      timeoutMs: safeValue.timeoutMs,
      message: safeValue.message || fallback,
      killed: !!safeValue.killed,
      timedOut: !!safeValue.timedOut,
      cliExitCode: safeValue.cliExitCode ?? null,
      signal: safeValue.signal ?? null,
    });
  }
  return sanitizePluginErrorText(firstPluginPublicText(safeValue) || fallback);
}

// The sole serializer for public /plugins failures. Install keeps its structured contract;
// legacy plugin routes keep their historical string/object shape, but all paths are redacted
// and bounded before Express serializes the response.
export function serializePluginPublicError(error, {
  structured = false,
  stage = 'plugin-install',
  fallback = '插件操作失败',
} = {}) {
  let publicError;
  if (structured) {
    publicError = error instanceof PluginCliError
      ? error.details
      : pluginCliError(stage, error, `${fallback}:`).details;
  } else if (error instanceof PluginCliError) {
    publicError = error.details;
  } else if (error && typeof error === 'object' && !(error instanceof Error)
      && !Buffer.isBuffer(error)) {
    publicError = error;
  } else {
    publicError = errText(error) || fallback;
  }
  const boundedError = boundPluginPublicError(publicError, fallback);
  return {
    status: structured && boundedError?.code === 'CLI_TIMEOUT' ? 504 : 500,
    body: { error: boundedError },
  };
}

function sendPluginPublicError(res, error, options) {
  const failure = serializePluginPublicError(error, options);
  return res.status(failure.status).json(failure.body);
}

async function runPluginCli(stage, args, { run = runClaude, env }) {
  try {
    return await run(args, {
      timeout: PLUGIN_CLI_TIMEOUT_MS,
      env,
      killTreeOnTimeout: true,
    });
  } catch (error) {
    throw pluginCliError(stage, error);
  }
}

// 注册(可选)+ 刷新 marketplace 缓存。失败带 stderr 原文抛出,不再静默。export 仅为可单测。
export async function ensureMarketplace({
  repo = null,
  marketplace,
  run = runClaude,
  detect = detectLocalProxy,
  env = null,
  baseEnv = process.env,
  probe = probePluginProxy,
}) {
  const childEnv = env || await marketplaceProxyEnv(detect, baseEnv, probe);
  if (repo) {
    try {
      await runPluginCli('marketplace-add', ['plugin', 'marketplace', 'add', repo], { run, env: childEnv });
    } catch (e) {
      if (!isMarketplaceAddIdempotent(e)) throw pluginCliError('marketplace-add', e, '注册插件市场失败:');
    }
  }
  try {
    await runPluginCli('marketplace-update', ['plugin', 'marketplace', 'update', marketplace], { run, env: childEnv });
  } catch (e) {
    throw pluginCliError('marketplace-update', e, `刷新插件市场「${marketplace}」失败:`);
  }
}

async function ensureOfficialMarketplace() {
  await ensureMarketplace({ repo: OFFICIAL_MARKETPLACE_REPO, marketplace: OFFICIAL_MARKETPLACE });
}

// r29:install 报「not found / out of date」形态 → 先刷新市场(刷新失败透出根因,不无谓重试),
// 再重试 install 一次;仍失败抛出完整因果链 + 可执行指引。export 仅为可单测。
export async function installPluginWithRefresh({
  name,
  marketplace,
  repo,
  run = runClaude,
  detect = detectLocalProxy,
  env = null,
  baseEnv = process.env,
  probe = probePluginProxy,
  directEnv = null,
}) {
  const target = `${name}@${marketplace}`;
  const refreshRepo = repo === undefined
    ? (marketplace === OFFICIAL_MARKETPLACE ? OFFICIAL_MARKETPLACE_REPO : null)
    : repo;
  const guide = `请检查网络/代理,或手动运行 claude plugin marketplace update ${marketplace} 后重试`;
  // 先尝试完全离线的本地缓存安装。此步不做代理探活，也不把代理传给 CLI，避免
  // CLI 即使命中缓存仍发出后台网络请求；只有缓存缺失、确需刷新时才探活并保留可达代理。
  const firstEnv = env || directEnv || pluginEnvWithoutProxy(baseEnv);
  try {
    await runPluginCli('plugin-install', ['plugin', 'install', target], { run, env: firstEnv });
    return;
  } catch (e) {
    if (!isMarketplaceStaleError(e)) throw e;
    const firstErr = errText(e);
    let childEnv = env;
    if (!childEnv) {
      try {
        childEnv = await marketplaceProxyEnv(detect, baseEnv, probe);
      } catch (error) {
        throw proxyPreflightError(error);
      }
    }
    try {
      await ensureMarketplace({ repo: refreshRepo, marketplace, run, detect, env: childEnv, baseEnv, probe });
    } catch (ue) {
      // 刷新本身就失败 = 根因在市场拉不动,直接给因果链(重试旧缓存无意义)。
      throw pluginCliError(ue?.details?.stage || 'marketplace-update', ue,
        `安装失败:${firstErr};已尝试刷新插件市场失败。${guide}；`);
    }
    try {
      await runPluginCli('plugin-install', ['plugin', 'install', target], { run, env: childEnv });
    } catch (e2) {
      throw pluginCliError('plugin-install', e2,
        `安装失败:已尝试刷新插件市场并重试仍失败(首次错误:${firstErr})。${guide}；`);
    }
  }
}

// GET /api/plugins/available?q=&fresh=1 — 全市场可装插件搜索(折叠式高级搜索)。
//   数据源:`claude plugin list --available --json`(CLI 已聚合所有已配置 marketplace 的可装项),
//   壳子原则:不自己爬网页。全量缓存 AVAILABLE_PLUGINS_TTL_MS,q 仅做内存过滤(名称/描述/来源)。
//   结果限量返回避免前端渲染上百条;total 供前端提示"细化关键词"。
async function loadAvailablePlugins(force = false) {
  if (!force && availablePluginsCache && Date.now() - availablePluginsCache.at < AVAILABLE_PLUGINS_TTL_MS) {
    return availablePluginsCache.items;
  }
  const out = await runClaude(['plugin', 'list', '--available', '--json'], { timeout: 60000 });
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw new Error('无法解析插件列表输出'); }
  const installedBare = new Set(
    (parsed.installed || []).map((p) => String(p.id || '').split('@')[0]).filter(Boolean),
  );
  const items = (parsed.available || [])
    .filter((a) => a && a.name)
    .map((a) => ({
      pluginId: a.pluginId || `${a.name}@${a.marketplaceName || ''}`,
      name: a.name,
      description: a.description || '',
      marketplace: a.marketplaceName || String(a.pluginId || '').split('@')[1] || '',
      installed: installedBare.has(a.name),
    }));
  availablePluginsCache = { at: Date.now(), items };
  return items;
}

router.get('/plugins/available', async (req, res) => {
  try {
    const items = await loadAvailablePlugins(req.query.fresh === '1');
    const q = String(req.query.q || '').trim().toLowerCase();
    const filtered = q
      ? items.filter((a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.marketplace.toLowerCase().includes(q))
      : items;
    const LIMIT = 60;
    res.json({
      total: filtered.length,
      items: filtered.slice(0, LIMIT),
      cachedAt: availablePluginsCache?.at || null,
    });
  } catch (err) {
    return sendPluginPublicError(res, err, { fallback: '获取插件列表失败' });
  }
});

// POST /api/plugins/install { name, repo?, marketplace? }
//   官方插件:`claude plugin install <name>@claude-plugins-official`(非交互)。
//   CQ批次4:支持非官方源(如 ponytail)——传 repo(owner/repo) + marketplace,先
//   `marketplace add <repo>` + `marketplace update <marketplace>` 再装 `<name>@<marketplace>`。
router.post('/plugins/install', async (req, res) => {
  try {
    const name = String(req.body?.name || '');
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error('invalid plugin name');
    const repo = req.body?.repo ? String(req.body.repo) : '';
    const marketplace = req.body?.marketplace ? String(req.body.marketplace) : OFFICIAL_MARKETPLACE;
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(marketplace)) throw new Error('invalid marketplace');
    const isCustom = !!repo && marketplace !== OFFICIAL_MARKETPLACE;
    if (isCustom && !/^[A-Za-z0-9._\/-]{1,100}$/.test(repo)) throw new Error('invalid repo');

    let childEnv = null;

    // r29:add/update 不得吞错(ensureMarketplace 失败带 stderr 原文抛出);
    // install 报「not found/out of date」时刷新市场重试一次,仍失败给完整因果链。
    // r31:不再把「注册+刷新(update)」作为安装前的硬前提 —— update 失败(断网/代理拉不动
    // GitHub/git 超时)会直接 500,挡住「本地缓存可装」的安装(r29 回归)。刷新交由
    // installPluginWithRefresh 在 install 报 not-found/过期形态时按需刷新重试。
    // 仅自定义源保留幂等 add 注册(未注册时 install 报 not found,由 installPluginWithRefresh
    // 的刷新重试兜底注册+刷新);官方源默认已注册,无需预注册/预刷新。
    if (isCustom) {
      try {
        childEnv = await marketplaceProxyEnv();
      } catch (error) {
        throw proxyPreflightError(error);
      }
      try {
        await runPluginCli('marketplace-add', ['plugin', 'marketplace', 'add', repo], {
          run: runClaude,
          env: childEnv,
        });
      } catch (e) {
        if (!isMarketplaceAddIdempotent(e)) throw pluginCliError('marketplace-add', e, '注册插件市场失败:');
      }
    }
    await installPluginWithRefresh({
      name, marketplace,
      // 显式自定义 repo 已在上方成功/幂等 add，刷新时只 update；未传 repo 时由 helper
      // 仅为 official marketplace 补官方 repo，第三方市场不会误加官方源。
      ...(isCustom ? { repo: null } : {}),
      env: childEnv,
    });
    invalidateMcpCache();
    res.json({ ok: true, name });
  } catch (err) {
    return sendPluginPublicError(res, err, {
      structured: true,
      stage: 'plugin-install',
      fallback: '安装失败',
    });
  }
});

// GET /api/plugins/:name/contents — 列出某插件带来的 skills / 命令 / agents(读插件缓存目录)。
// best-effort:目录结构由各插件自定,任何一段读不到就给空清单,不因结构不合预期而报错。
// skill 调用名 = `<插件裸名>:<skill 目录名>`(插件 skill 装在 ~/.claude/plugins 缓存,
// 不进 ~/.claude/skills,靠前缀命名调用)。
router.get('/plugins/:name/contents', async (req, res) => {
  try {
    const { name } = req.params;
    if (!/^[A-Za-z0-9._@\-/]{1,100}$/.test(name)) throw new Error('invalid plugin name');
    let root = null;
    try {
      const reg = JSON.parse(await readFile(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf-8'));
      const inst = reg?.plugins?.[name];
      root = (Array.isArray(inst) ? inst[0] : inst)?.installPath || null;
    } catch {}
    // installPath 来自 CLI 自己的注册表,但仍限定在插件缓存目录内(防注册表被改指向任意路径)。
    const base = join(CLAUDE_DIR, 'plugins');
    if (!root || !root.startsWith(base + sep)) {
      return res.status(404).json({ error: '插件未安装或缓存目录未找到' });
    }
    const listDir = async (sub, { dirs = false } = {}) => {
      try {
        const entries = await readdir(join(root, sub), { withFileTypes: true });
        return entries
          .filter((e) => (dirs ? e.isDirectory() : e.isFile() && e.name.endsWith('.md')))
          .map((e) => (dirs ? e.name : e.name.replace(/\.md$/, '')))
          .filter((n) => !n.startsWith('.'));
      } catch { return []; }
    };
    // skills 目录下常见两种布局:每个 skill 一个子目录(内含 SKILL.md),或直接平铺 <name>.md。
    const skills = [...new Set([...(await listDir('skills', { dirs: true })), ...(await listDir('skills'))])];
    const commands = await listDir('commands');
    const agents = await listDir('agents');
    let hasMcp = false;
    try { await stat(join(root, '.mcp.json')); hasMcp = true; } catch {}
    res.json({ name, bare: name.split('@')[0], skills, commands, agents, hasMcp });
  } catch (err) { return sendPluginPublicError(res, err, { fallback: '读取插件内容失败' }); }
});

// POST /api/mcp/preview-tools — **添加前**按表单草稿配置连 server 预览工具清单(不落任何配置)。
// 仅 stdio;命令同添加路径过 rewriteUvCommandLine(Windows uvx 垫片坑同样适用)。
router.post('/mcp/preview-tools', async (req, res) => {
  try {
    const b = req.body || {};
    if ((b.transport || 'stdio') !== 'stdio') {
      return res.json({ tools: null, note: '仅 stdio 类型支持查看工具清单;HTTP/SSE server 请在其平台侧管理。' });
    }
    const commandLine = await rewriteUvCommandLine(String(b.commandLine || ''));
    const { command, args } = parseCommandLine(commandLine);
    if (!command) return res.status(400).json({ error: '命令不能为空' });
    const env = (b.env && typeof b.env === 'object') ? b.env : {};
    const { tools, note } = await listToolsFromCfg({ command, args, env });
    res.json({ tools, note: note || '' });
  } catch (e) { return sendPluginPublicError(res, e, { fallback: '预览工具清单失败' }); }
});

// GET /api/mcp/registry-search?q=<关键词> — 搜索官方 MCP 注册表,返回可预填添加表单的条目。
// CLI 无对应命令(见 services/mcp-registry.js 头注),直调注册表 HTTP API;15 分钟缓存 keyed by q。
// 上游失败 502 + 可读 message(前端提示"网络不可达,可重试"),不静默回空列表。
router.get('/mcp/registry-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    res.json({ items: await searchRegistry(q) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/mcp/:name/tools — 连 server 走 tools/list 握手,返回工具清单 + 各自是否被手动禁用。
router.get('/mcp/:name/tools', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);
    const { transport, tools, note } = await listMcpTools(name);
    const disabled = new Set((await readDisabledMcpTools())[name] || []);
    res.json({
      transport,
      note: note || null,
      tools: tools ? tools.map((t) => ({ ...t, enabled: !disabled.has(t.name) })) : null,
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// PUT /api/mcp/:name/tools { disabled: ["toolName", ...] } — 保存该 server 手动禁用的工具清单。
// 禁用即 chat.js 下一回合把 mcp__name__tool 加进 disallowedTools,模型看不到该工具。
router.put('/mcp/:name/tools', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);
    const disabled = Array.isArray(req.body?.disabled)
      ? req.body.disabled.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
      : [];
    const map = await readDisabledMcpTools();
    if (disabled.length) map[name] = [...new Set(disabled)]; else delete map[name];
    await writeDisabledMcpTools(map);
    res.json({ ok: true, name, disabled: map[name] || [] });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

export default router;
