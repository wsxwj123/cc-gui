import { Router } from 'express';
import { readFile, readdir, stat, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

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
  const { stdout } = await execFileP('claude', args, {
    encoding: 'utf-8',
    timeout,
    env: { ...process.env },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

const NAME_RE = /^[A-Za-z0-9_.:@/-]{1,128}$/;
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
    const match = line.match(/^(\S+):\s+(.+?)(?:\s+-\s+([✓✔✗✘!])\s+(.+))?$/);
    if (match) {
      const [, name, command, statusIcon] = match;
      const isHttp = command.includes('(HTTP)') || command.startsWith('http');
      const cleanCommand = command.replace(/\s*\(HTTP\)\s*$/, '').trim();
      const status = (statusIcon === '✓' || statusIcon === '✔') ? 'connected'
        : (statusIcon === '✗' || statusIcon === '✘') ? 'disconnected'
        : 'unknown'; // ! = 需认证 / 无图标 = 未知

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
function invalidateMcpCache() { mcpCache = null; mcpCacheAt = 0; try { invalidateDetailsCache(); } catch {} }

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
    try {
      output = await runClaude(['mcp', 'get', name]);
    } catch (err) {
      output = err.stderr?.toString() || err.message;
      status = 'error';
      detail = err.message;
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
    res = await execFileP('claude', args, { encoding: 'utf-8', timeout: 20000, env: { ...process.env }, maxBuffer: 8 * 1024 * 1024 });
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
    const args = buildAddArgs({ ...b, transport, scope });
    await runMcpAdd(args, b.name); // 检测"already exists"假成功
    await setAutoApprove(b.name, !!b.autoApprove);
    await setMeta(b.name, b.label);
    // 新增即启用:清掉可能存在的同名禁用残留
    try { const dis = await readDisabled(); if (dis[b.name]) { delete dis[b.name]; await writeDisabled(dis); } } catch {}
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
    invalidateMcpCache();
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

export default router;
