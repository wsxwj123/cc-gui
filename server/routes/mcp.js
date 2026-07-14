import { Router } from 'express';
import { readFile, readdir, stat, writeFile, mkdir } from 'fs/promises';
import { join, sep, dirname } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { syncMcpToAgents } from './agents.js';
import { claudeCommand } from '../utils/claude-resolver.js';
import { detectUv } from './version-check.js';

const execFileP = promisify(execFile);

// 读 ~/.claude.json 里某个 MCP 的原始配置(含 env 值,用于 spawn 探测)。
async function readRawMcpConfig(name) {
  try {
    const j = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf-8'));
    return j.mcpServers?.[name] || null;
  } catch { return null; }
}

// 直接 spawn stdio MCP 的命令抓早期 stderr —— `claude mcp get` 只报 "Failed to connect",
// 不吐子进程真因(命令未找到 / 包无可执行入口 / 缺依赖 / realpath 缺失等)。最多等 timeoutMs:
// stdio MCP 正常启动会静默等 stdin(无 stderr、不退出)→ 视为无早期错误;快速退出 + stderr = 真错误。
function probeStdioStderr(cfg, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!cfg || !cfg.command) return resolve('');
    const isWin = process.platform === 'win32';
    let stderr = '', done = false, child, timer;
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
    try {
      child = spawn(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], {
        env: { ...process.env, ...(cfg.env || {}) },
        stdio: ['ignore', 'ignore', 'pipe'],
        // Windows:npx/uvx/uv 实为 .cmd,不经 shell spawn 会 ENOENT 误报"命令未找到"。
        shell: isWin,
        // 非 Win:独立进程组,便于负 pid 杀掉命令 fork 出的真实 server 子进程,不留孤儿。
        detached: !isWin,
      });
    } catch (e) { return resolve(`spawn 失败: ${e.message}`); }
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
async function runClaude(args, { timeout = 10000 } = {}) {
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
    timeout: isWin ? 0 : timeout,
    env: { ...process.env },
    maxBuffer: 8 * 1024 * 1024,
  });
  let timedOut = false, timer = null;
  if (isWin && timeout > 0) {
    const child = p.child;
    timer = setTimeout(() => {
      timedOut = true;
      if (child?.pid != null) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
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
  if (!cfg.command) return { transport: cfg.type || 'http', tools: null, note: '仅 stdio 类型支持查看工具清单;HTTP/SSE server 请在其平台侧管理。' };
  return await new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let child, done = false, buf = '', timer; // timer 提前声明:finish 里 clearTimeout(timer) 在
    // 同步 spawn 失败路径会先于末尾赋值执行,用 const 声明会 TDZ ReferenceError 污染错误文案。
    const finish = (tools, note) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { if (isWin && child?.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child?.kill('SIGKILL'); } catch {}
      resolve({ transport: 'stdio', tools, note });
    };
    try {
      child = spawn(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], {
        env: { ...process.env, ...(cfg.env || {}) }, stdio: ['pipe', 'pipe', 'ignore'],
        shell: isWin, // uv/npx 在 Win 是 .cmd,不经 shell 会 ENOENT
      });
    } catch (e) { return finish(null, `启动失败: ${e.message}`); }
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
function invalidateMcpListCache() {
  mcpCache = null; mcpCacheAt = 0;
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
        const r = await fetch(urlMatch[1], { method: 'HEAD', redirect: 'follow' });
        httpStatus = r.status;
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

function buildAddArgs({ name, transport, commandLine, url, env, scope }) {
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
    // url 在前,-e 放末尾(变长参数在结尾不会吞掉其它位置参数)。
    args.push(url.trim(), ...envFlags);
  } else {
    const { command, args: cargs } = parseCommandLine(commandLine);
    if (!command) throw new Error('命令不能为空');
    // -e 在 -- 之前;-- 之后是子进程命令,会终止 -e 的变长吞噬。
    args.push(...envFlags, '--', command, ...cargs);
  }
  return args;
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
    const args = buildAddArgs({ ...b, transport, scope });
    await runMcpAdd(args, b.name); // 检测"already exists"假成功
    await setAutoApprove(b.name, !!b.autoApprove);
    await setMeta(b.name, b.label);
    // 新增即启用:清掉可能存在的同名禁用残留
    try { const dis = await readDisabled(); if (dis[b.name]) { delete dis[b.name]; await writeDisabled(dis); } } catch {}
    try { await syncMcpToAgents({ add: [b.name] }); } catch {} // 自动让所有 agent 能用这个 MCP
    invalidateMcpCache();
    res.json({ ok: true, name: b.name });
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
    const addArgs = buildAddArgs({ ...b, name: newName, transport, scope });
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
    res.json({ ok: true, name: newName });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    if (mk) { try { await runClaude(['plugin', 'marketplace', 'update', mk], { timeout: 30000 }); } catch {} }
    await runClaude(['plugin', 'update', name], { timeout: 90000 });
    invalidateMcpCache();
    const version = await readVer(); // 更新后版本(前端弹窗"已更新为 vX")
    // changed:版本号都在且变了=真更新;都在且没变=无更新;版本号缺失(无声明)=判不了(undefined),
    // 前端保留旧通用文案不误报版本。
    const changed = (version != null && beforeVersion != null) ? (version !== beforeVersion) : undefined;
    res.json({ ok: true, name, version, changed, note: '已更新,新会话生效' });
  } catch (err) {
    res.status(500).json({ error: (err.stderr?.toString() || err.message || '').trim() || '更新失败' });
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
    res.status(500).json({ error: (err.stderr?.toString() || err.message || '').trim() || '卸载失败' });
  }
});

// 官方插件一键安装。CM-5:marketplace 不仅要 add,还要 **update** 刷新本地缓存——否则
// 缓存停在旧 commit(没有后加入的插件如 code-review)→ install 报 "not found / 本地副本过期"
// (Windows 上常见,Mac 缓存恰新所以能装)。add 幂等(已存在忽略),update 是 git pull 较快。
const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
async function ensureOfficialMarketplace() {
  try { await runClaude(['plugin', 'marketplace', 'add', 'anthropics/claude-plugins-official'], { timeout: 30000 }); } catch {}
  try { await runClaude(['plugin', 'marketplace', 'update', OFFICIAL_MARKETPLACE], { timeout: 30000 }); } catch {}
}

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

    if (isCustom) {
      // 非官方源:先注册其 marketplace(幂等)+ update 刷新缓存。
      try { await runClaude(['plugin', 'marketplace', 'add', repo], { timeout: 30000 }); } catch {}
      try { await runClaude(['plugin', 'marketplace', 'update', marketplace], { timeout: 30000 }); } catch {}
    } else {
      await ensureOfficialMarketplace();
    }
    try {
      await runClaude(['plugin', 'install', `${name}@${marketplace}`], { timeout: 90000 });
    } catch (e) {
      // 仍失败且像"缓存过期/找不到"→ 强制再 update 一次后重试(兜底)。
      const msg = (e.stderr?.toString() || e.message || '');
      if (/out of date|not found|marketplace update|本地副本/i.test(msg)) {
        try { await runClaude(['plugin', 'marketplace', 'update', marketplace], { timeout: 30000 }); } catch {}
        await runClaude(['plugin', 'install', `${name}@${marketplace}`], { timeout: 90000 });
      } else throw e;
    }
    invalidateMcpCache();
    res.json({ ok: true, name });
  } catch (err) {
    res.status(500).json({ error: (err.stderr?.toString() || err.message || '').trim() || '安装失败' });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
