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
function invalidateMcpCache() { mcpCache = null; mcpCacheAt = 0; }

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

    // 2. Also check .mcp.json files in known locations
    const mcpJsonPaths = [
      join(CLAUDE_DIR, 'channels', 'telegram', '.mcp.json'),
      join(CLAUDE_DIR, 'channels', 'bot2', '.mcp.json'),
      join(CLAUDE_DIR, 'channels', 'bot3', '.mcp.json'),
      join(CLAUDE_DIR, 'plugins', 'local', 'telegram', '.mcp.json'),
    ];
    const existingNames = new Set(result.mcpServers.map((s) => s.name));

    for (const mcpPath of mcpJsonPaths) {
      try {
        const data = JSON.parse(await readFile(mcpPath, 'utf-8'));
        const servers = data.mcpServers || {};
        for (const [name, cfg] of Object.entries(servers)) {
          if (!existingNames.has(name)) {
            existingNames.add(name);
            result.mcpServers.push({
              name,
              command: cfg.command || '',
              args: cfg.args || [],
              env: cfg.env ? Object.keys(cfg.env) : [],
              transport: cfg.transport || 'stdio',
              status: 'unknown',
              source: mcpPath.replace(homedir(), '~'),
            });
          }
        }
      } catch {}
    }

    // 3. Installed plugins (also parse `claude plugin list` for enabled state)
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

    // 5. Merge disabled state
    try {
      const disabled = JSON.parse(await readFile(DISABLED_FILE, 'utf-8'));
      for (const srv of result.mcpServers) {
        if (disabled[srv.name]) {
          srv.enabled = false;
          srv.disabledConfig = disabled[srv.name];
        } else {
          srv.enabled = true;
        }
      }
    } catch {
      for (const srv of result.mcpServers) {
        srv.enabled = true;
      }
    }

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

async function getServerDetails(name) {
  try {
    assertSafeName(name);
    return await runClaude(['mcp', 'get', name]);
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

    const args = ['mcp', 'add'];
    if (config.transport === 'http') args.push('--transport', 'http');
    if (config.scope) args.push('-s', String(config.scope));
    args.push(name);
    if (config.transport === 'http') {
      args.push(String(config.command));
    } else {
      args.push('--', String(config.command), ...((config.args || []).map(String)));
    }

    await runClaude(args, { timeout: 15000 });

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
    const typeMatch = details.match(/Type:\s*(\S+)/);
    const scopeMatch = details.match(/Scope:\s*(.+?)(?:\s*\(|$)/m);

    config.transport = typeMatch ? typeMatch[1] : 'stdio';
    config.command = cmdMatch ? cmdMatch[1].trim() : '';
    config.args = argsMatch ? argsMatch[1].trim().split(/\s+/) : [];
    config.scope = scopeMatch ? scopeMatch[1].trim().toLowerCase().split(' ')[0] : 'user';

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
