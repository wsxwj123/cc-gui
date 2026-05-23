import { Router } from 'express';
import { readFile, readdir, stat, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

// All `claude ...` invocations go through execFileSync with an args array — no shell, no injection.
function runClaude(args, { timeout = 10000 } = {}) {
  return execFileSync('claude', args, {
    encoding: 'utf-8',
    timeout,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

// GET /api/mcp — list all MCP servers and plugins
router.get('/mcp', async (req, res) => {
  try {
    const result = { mcpServers: [], plugins: [], external: [] };

    // 1. MCP servers from `claude mcp list` (the authoritative source)
    try {
      const output = runClaude(['mcp', 'list']);
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

    // 3. Installed plugins
    try {
      const pluginsData = JSON.parse(
        await readFile(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf-8')
      );
      const plugins = pluginsData.plugins || {};
      for (const [name, instances] of Object.entries(plugins)) {
        const inst = Array.isArray(instances) ? instances[0] : instances;
        result.plugins.push({
          name,
          version: inst.version || '?',
          scope: inst.scope || 'user',
          installPath: inst.installPath || '',
          installedAt: inst.installedAt || null,
          lastUpdated: inst.lastUpdated || null,
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

function getServerDetails(name) {
  try {
    assertSafeName(name);
    return runClaude(['mcp', 'get', name]);
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
      output = runClaude(['mcp', 'get', name]);
    } catch (err) {
      output = err.stderr?.toString() || err.message;
      status = 'error';
      detail = err.message;
    }
    // If it's an HTTP transport, attempt a HEAD ping too.
    const urlMatch = output && output.match(/URL:\s*(https?:\/\/\S+)/);
    let httpStatus = null;
    if (urlMatch) {
      try {
        const r = await fetch(urlMatch[1], { method: 'HEAD', redirect: 'follow' });
        httpStatus = r.status;
      } catch (err) {
        httpStatus = -1;
        status = status === 'ok' ? 'error' : status;
        detail = err.message;
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

    runClaude(args, { timeout: 15000 });

    delete disabled[name];
    await writeDisabled(disabled);
    res.json({ ok: true, name, enabled: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/mcp/:name/disable', async (req, res) => {
  try {
    const { name } = req.params;
    assertSafeName(name);

    const details = getServerDetails(name);
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

    runClaude(['mcp', 'remove', name]);
    res.json({ ok: true, name, enabled: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
