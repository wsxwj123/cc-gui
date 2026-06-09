import { Router } from 'express';
import { readFile, readdir, stat, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

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

    const match = line.match(/^(\S+):\s+(.+?)(?:\s+-\s+(✓|✗)\s+(Connected|Disconnected|Error))?$/);
    if (match) {
      const [, name, command, statusIcon, statusText] = match;
      const isHttp = command.includes('(HTTP)') || command.startsWith('http');
      const cleanCommand = command.replace(/\s*\(HTTP\)\s*$/, '').trim();

      servers.push({
        name,
        command: cleanCommand,
        transport: isHttp ? 'http' : 'stdio',
        status: statusIcon === '✓' ? 'connected' : statusIcon === '✗' ? 'disconnected' : 'unknown',
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

// GET /api/mcp — list all MCP servers and plugins
router.get('/mcp', async (req, res) => {
  const now = Date.now();
  if (req.query.fresh !== '1' && mcpCache && (now - mcpCacheAt) < MCP_CACHE_TTL_MS) {
    return res.json(mcpCache);
  }
  try {
    const result = { mcpServers: [], plugins: [], external: [] };

    // 1. MCP servers from `claude mcp list` (the authoritative source)
    try {
      const output = await runClaude(['mcp', 'list']);
      result.mcpServers = parseMcpList(output);
    } catch (err) {
      // Fallback: try reading from settings.json
      try {
        const settings = JSON.parse(await readFile(join(CLAUDE_DIR, 'settings.json'), 'utf-8'));
        const servers = settings.mcpServers || {};
        for (const [name, cfg] of Object.entries(servers)) {
          result.mcpServers.push({
            name,
            command: cfg.command || '',
            args: cfg.args || [],
            env: cfg.env ? Object.keys(cfg.env) : [],
            transport: cfg.transport || 'stdio',
            status: 'unknown',
            source: 'settings.json',
          });
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

    mcpCache = result;
    mcpCacheAt = Date.now();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    res.json({
      name, status,
      ms: Date.now() - start,
      httpStatus,
      output: (output || '').slice(0, 1500),
      detail,
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

// POST /api/mcp — 新增一个 MCP 服务器。
// body: { name, transport, commandLine?, url?, env?, scope?, autoApprove?, label? }
router.post('/mcp', async (req, res) => {
  try {
    const b = req.body || {};
    assertSafeName(b.name);
    const scope = ['user', 'project', 'local'].includes(b.scope) ? b.scope : 'user';
    const transport = ['stdio', 'http', 'sse'].includes(b.transport) ? b.transport : 'stdio';
    const args = buildAddArgs({ ...b, transport, scope });
    await runClaude(args, { timeout: 20000 });
    await setAutoApprove(b.name, !!b.autoApprove);
    await setMeta(b.name, b.label);
    // 新增即启用:清掉可能存在的同名禁用残留
    try { const dis = await readDisabled(); if (dis[b.name]) { delete dis[b.name]; await writeDisabled(dis); } } catch {}
    invalidateMcpCache();
    res.json({ ok: true, name: b.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    // 先移除旧的(各 scope 尽力删,忽略不存在错误),再加新的。
    for (const s of ['user', 'project', 'local']) {
      try { await runClaude(['mcp', 'remove', name, '-s', s]); } catch {}
    }
    try { const dis = await readDisabled(); if (dis[name]) { delete dis[name]; await writeDisabled(dis); } } catch {}
    await runClaude(addArgs, { timeout: 20000 });
    // 改名时迁移 autoapprove / meta
    if (newName !== name) { await setAutoApprove(name, false); await setMeta(name, ''); }
    await setAutoApprove(newName, !!b.autoApprove);
    await setMeta(newName, b.label);
    invalidateMcpCache();
    res.json({ ok: true, name: newName });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
