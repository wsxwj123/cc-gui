import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGuiHost } from './gui-host.mjs';

const EXPECTED_CLI_VERSION = '2.1.240';
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
const SYSTEM_PATH = [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);

export class TestInfraError extends Error {
  constructor(message, kind = 'TEST_INFRA') {
    super(`${kind}: ${message}`);
    this.name = 'TestInfraError';
    this.kind = kind;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new TestInfraError(`missing ${name}`);
  return value;
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw new TestInfraError(`missing ${name}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new TestInfraError(`${name} is not valid JSON: ${error.message}`);
  }
}

function renderUrl(template, port) {
  return template.replaceAll('{port}', String(port));
}

async function allocateLoopbackPort() {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    await new Promise((resolve) => server.close(resolve));
    if (!port) throw new Error('no port returned');
    return port;
  } catch (error) {
    throw new TestInfraError(`loopback port allocation unavailable: ${error.code || error.message}`);
  }
}

async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function runProcess(binary, args, { env, cwd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function createClaudeWrapper(binDir) {
  const wrapperPath = path.join(binDir, 'claude');
  const source = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
const selectedEnv = Object.fromEntries(proxyKeys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
selectedEnv.HOME = process.env.HOME;
selectedEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
appendFileSync(process.env.R33_CLI_RECORD_FILE, JSON.stringify({ args, env: selectedEnv, at: Date.now(), pid: process.pid }) + '\\n');

const isAdd = args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add';
const isUpdate = args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'update';
const mode = process.env.R33_CLI_WRAPPER_MODE || 'record';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if ((mode === 'slow-add' && isAdd) || (mode === 'slow-update' && isUpdate)) await delay(35_000);
if (mode === 'timeout-update' && isUpdate) {
  await delay(125_000);
  process.exit(124);
}

const child = spawn(process.env.R33_REAL_CLAUDE_BIN, args, { env: process.env, stdio: 'inherit' });
child.once('error', (error) => {
  process.stderr.write(String(error.message || error));
  process.exit(127);
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`;
  await writeFile(wrapperPath, source, 'utf8');
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function sanitizeBackendEnv(sandbox, port, wrapperMode, overrides = {}) {
  const env = {
    HOME: sandbox.homeDir,
    CLAUDE_CONFIG_DIR: sandbox.claudeConfigDir,
    XDG_CONFIG_HOME: sandbox.xdgConfigDir,
    XDG_CACHE_HOME: sandbox.xdgCacheDir,
    PATH: `${sandbox.binDir}${path.delimiter}${SYSTEM_PATH}`,
    PORT: String(port),
    HOST: '127.0.0.1',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    R33_REAL_CLAUDE_BIN: sandbox.realClaudeBin,
    R33_CLI_RECORD_FILE: sandbox.cliRecordFile,
    R33_CLI_WRAPPER_MODE: wrapperMode,
    ...overrides,
  };
  for (const key of PROXY_KEYS) {
    if (overrides[key] === undefined) delete env[key];
  }
  return env;
}

async function startRejectingProxy() {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end('r33 offline proxy');
  });
  server.on('connect', (_request, socket) => {
    requestCount += 1;
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    throw new TestInfraError(`rejecting proxy fixture unavailable: ${error.code || error.message}`);
  }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) throw new TestInfraError('could not start rejecting proxy');
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requestCount,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startForwardingProxy(expectedHost) {
  let requestCount = 0;
  let connectionCount = 0;
  const server = http.createServer((request, response) => {
    let target;
    try {
      target = new URL(request.url);
    } catch {
      response.writeHead(400).end('absolute proxy URL required');
      return;
    }
    if (target.hostname !== expectedHost || !target.port) {
      response.writeHead(502).end('unexpected proxy target');
      return;
    }
    requestCount += 1;
    const upstream = http.request({
      host: '127.0.0.1',
      port: Number(target.port),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...request.headers, host: target.host },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', (error) => {
      if (!response.headersSent) response.writeHead(502);
      response.end(error.message);
    });
    request.pipe(upstream);
  });
  server.on('connection', () => { connectionCount += 1; });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    throw new TestInfraError(`forwarding proxy fixture unavailable: ${error.code || error.message}`);
  }
  const address = server.address();
  if (!address || typeof address !== 'object') throw new TestInfraError('forwarding proxy fixture has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => requestCount,
    connections: () => connectionCount,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startSmartGitHttpServer(bareDir, env) {
  const rootDir = path.dirname(bareDir);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const child = spawn('/usr/bin/git', ['http-backend'], {
      cwd: rootDir,
      env: {
        ...env,
        GIT_PROJECT_ROOT: rootDir,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'] || '',
        CONTENT_LENGTH: request.headers['content-length'] || '0',
        REMOTE_ADDR: request.socket.remoteAddress || '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(error.message);
    });
    child.once('exit', (code) => {
      if (code !== 0) {
        if (!response.headersSent) response.writeHead(500);
        response.end(stderr || `git http-backend exited ${code}`);
        return;
      }
      const output = Buffer.concat(stdout);
      let separator = output.indexOf('\r\n\r\n');
      let separatorLength = 4;
      if (separator < 0) {
        separator = output.indexOf('\n\n');
        separatorLength = 2;
      }
      if (separator < 0) {
        response.writeHead(500).end('invalid git CGI response');
        return;
      }
      const headerText = output.subarray(0, separator).toString('utf8');
      const headers = {};
      let status = 200;
      for (const line of headerText.split(/\r?\n/)) {
        const index = line.indexOf(':');
        if (index < 0) continue;
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else headers[key] = value;
      }
      response.writeHead(status, headers);
      response.end(output.subarray(separator + separatorLength));
    });
    request.pipe(child.stdin);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    throw new TestInfraError(`smart git HTTP fixture unavailable: ${error.code || error.message}`);
  }
  const address = server.address();
  if (!address || typeof address !== 'object') throw new TestInfraError('smart git HTTP fixture has no port');
  return {
    url: `http://127.0.0.1:${address.port}/${path.basename(bareDir)}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function runAcceptanceCase(testContext, options, callback) {
  let host;
  try {
    if (options.network && process.env.R33_RUN_NETWORK !== '1') {
      throw new TestInfraError('set R33_RUN_NETWORK=1 to run real marketplace cases', 'TEST_INFRA_NETWORK');
    }
    if (options.long && process.env.R33_RUN_LONG !== '1') {
      throw new TestInfraError('set R33_RUN_LONG=1 to run the 120-second timeout case', 'TEST_INFRA_LONG');
    }
    host = await PluginAcceptanceHost.create(options);
    await callback(host);
  } catch (error) {
    if (error instanceof TestInfraError) {
      testContext.diagnostic(error.message);
      testContext.skip(error.message);
      return;
    }
    throw error;
  } finally {
    await host?.close();
  }
}

export class PluginAcceptanceHost {
  static async create({ wrapperMode = 'record', backendEnv = {} } = {}) {
    const backendBin = requiredEnv('R33_BACKEND_BIN');
    if (!path.isAbsolute(backendBin)) throw new TestInfraError('R33_BACKEND_BIN must be absolute');
    const backendArgs = parseJsonEnv('R33_BACKEND_ARGS', ['server/index.js']);
    if (!Array.isArray(backendArgs) || backendArgs.some((arg) => typeof arg !== 'string')) {
      throw new TestInfraError('R33_BACKEND_ARGS must be a JSON string array');
    }
    const configuredCli = requiredEnv('R33_CLI_BIN');
    if (!path.isAbsolute(configuredCli)) throw new TestInfraError('R33_CLI_BIN must be absolute');
    const realClaudeBin = await realpath(configuredCli).catch(() => null);
    if (!realClaudeBin) throw new TestInfraError('R33_CLI_BIN does not exist');

    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cgui-plugin-r33-'));
    const sandbox = {
      rootDir,
      homeDir: path.join(rootDir, 'home'),
      claudeConfigDir: path.join(rootDir, 'claude-config'),
      xdgConfigDir: path.join(rootDir, 'xdg-config'),
      xdgCacheDir: path.join(rootDir, 'xdg-cache'),
      binDir: path.join(rootDir, 'bin'),
      artifactDir: path.join(rootDir, 'artifacts'),
      marketplaceDir: path.join(rootDir, 'marketplace'),
      staleMarketplaceDir: path.join(rootDir, 'stale-marketplace'),
      staleBareDir: path.join(rootDir, 'stale-marketplace.git'),
      cliRecordFile: path.join(rootDir, 'artifacts', 'cli-records.jsonl'),
      realClaudeBin,
    };
    await Promise.all(Object.values(sandbox)
      .filter((value) => typeof value === 'string' && value.startsWith(rootDir) && !value.endsWith('.jsonl'))
      .map((directory) => mkdir(directory, { recursive: true })));
    await createClaudeWrapper(sandbox.binDir);
    await PluginAcceptanceHost.writeLocalMarketplaceFixture(sandbox.marketplaceDir);
    const initialHomeEntries = await readdir(sandbox.homeDir);
    const initialClaudeConfigEntries = await readdir(sandbox.claudeConfigDir);

    const port = await allocateLoopbackPort();
    const host = new PluginAcceptanceHost({
      backendBin,
      backendArgs,
      backendCwd: process.env.R33_BACKEND_CWD || process.cwd(),
      backendEnv,
      port,
      sandbox,
      wrapperMode,
      initialHomeEntries,
      initialClaudeConfigEntries,
    });
    try {
      await host.verifyCliVersion();
      await host.startBackend();
      return host;
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  constructor(state) {
    Object.assign(this, state);
    this.backend = null;
    this.guiHost = null;
    this.gitServer = null;
    this.forwardingProxy = null;
    this.backendOutput = '';
    this.keepArtifacts = process.env.R33_KEEP_ARTIFACTS === '1';
    this.localFixtureValidated = false;
  }

  static async writeLocalMarketplaceFixture(marketplaceDir) {
    await PluginAcceptanceHost.writeMarketplaceFixture(
      marketplaceDir,
      'r33-third-party-marketplace',
      'r33-third-party-plugin',
    );
  }

  static async writeMarketplaceFixture(marketplaceDir, marketplaceName, pluginName) {
    const marketplaceManifestDir = path.join(marketplaceDir, '.claude-plugin');
    const pluginDir = path.join(marketplaceDir, 'plugin');
    const pluginManifestDir = path.join(pluginDir, '.claude-plugin');
    await Promise.all([
      mkdir(marketplaceManifestDir, { recursive: true }),
      mkdir(pluginManifestDir, { recursive: true }),
    ]);
    await writeFile(path.join(marketplaceManifestDir, 'marketplace.json'), JSON.stringify({
      name: marketplaceName,
      owner: { name: 'r33 acceptance' },
      plugins: [{
        name: pluginName,
        source: './plugin',
        description: 'Isolated r33 acceptance fixture',
        version: '1.0.0',
      }],
    }), 'utf8');
    await writeFile(path.join(pluginManifestDir, 'plugin.json'), JSON.stringify({
      name: pluginName,
      description: 'Isolated r33 acceptance fixture',
      version: '1.0.0',
      author: { name: 'r33 acceptance' },
    }), 'utf8');
  }

  static async writeStaleMarketplaceFixture(marketplaceDir, includeTarget) {
    const marketplaceManifestDir = path.join(marketplaceDir, '.claude-plugin');
    const pluginNames = ['r33-stale-seed'];
    if (includeTarget) pluginNames.push('r33-stale-target');
    await mkdir(marketplaceManifestDir, { recursive: true });
    for (const pluginName of pluginNames) {
      const pluginManifestDir = path.join(marketplaceDir, pluginName, '.claude-plugin');
      await mkdir(pluginManifestDir, { recursive: true });
      await writeFile(path.join(pluginManifestDir, 'plugin.json'), JSON.stringify({
        name: pluginName,
        description: 'Isolated stale marketplace fixture',
        version: '1.0.0',
        author: { name: 'r33 acceptance' },
      }), 'utf8');
    }
    await writeFile(path.join(marketplaceManifestDir, 'marketplace.json'), JSON.stringify({
      name: 'r33-stale-marketplace',
      owner: { name: 'r33 acceptance' },
      plugins: pluginNames.map((pluginName) => ({
        name: pluginName,
        source: `./${pluginName}`,
        description: 'Isolated stale marketplace fixture',
        version: '1.0.0',
      })),
    }), 'utf8');
  }

  isolatedEnv(overrides = {}) {
    return sanitizeBackendEnv(this.sandbox, this.port, this.wrapperMode, { ...this.backendEnv, ...overrides });
  }

  async verifyCliVersion() {
    const result = await runProcess(this.sandbox.realClaudeBin, ['--version'], {
      cwd: this.sandbox.rootDir,
      env: this.isolatedEnv(),
    });
    if (result.code !== 0 || !result.stdout.trim().startsWith(`${EXPECTED_CLI_VERSION} `)) {
      throw new TestInfraError(`Claude CLI must be ${EXPECTED_CLI_VERSION}; got ${result.stdout.trim() || result.stderr.trim()}`);
    }
  }

  async startBackend(extraEnv = {}) {
    if (this.backend) throw new Error('backend already started');
    this.backendOutput = '';
    this.backend = spawn(this.backendBin, this.backendArgs, {
      cwd: this.backendCwd,
      env: this.isolatedEnv(extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [this.backend.stdout, this.backend.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => { this.backendOutput += chunk; });
    }
    this.backend.once('error', (error) => { this.backendOutput += `\n${error.message}`; });
    const readinessTemplate = process.env.R33_HEALTH_URL || 'http://127.0.0.1:{port}/api/health';
    const readinessUrl = renderUrl(readinessTemplate, this.port);
    const deadline = Date.now() + Number(process.env.R33_BACKEND_READY_TIMEOUT_MS || 20_000);
    while (Date.now() < deadline) {
      if (this.backend.exitCode !== null) {
        throw new TestInfraError(`backend exited before ready: ${this.backendOutput.slice(-1000)}`);
      }
      try {
        const response = await fetch(readinessUrl);
        if (response.status < 500) return;
      } catch {
        // Readiness polling is expected to fail while the loopback server starts.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new TestInfraError(`backend not ready at ${readinessUrl}`);
  }

  async stopBackend() {
    if (!this.backend) return;
    const child = this.backend;
    this.backend = null;
    child.kill('SIGTERM');
    await waitForExit(child, 3_000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child, 2_000);
    }
  }

  url(name) {
    const defaults = {
      R33_AVAILABLE_URL: 'http://127.0.0.1:{port}/api/plugins/available?fresh=1',
      R33_INSTALL_URL: 'http://127.0.0.1:{port}/api/plugins/install',
    };
    return renderUrl(process.env[name] || defaults[name] || requiredEnv(name), this.port);
  }

  async requestAvailable() {
    const response = await fetch(this.url('R33_AVAILABLE_URL'));
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  }

  async fetchAvailableRaw() {
    const result = await this.requestAvailable();
    assert.equal(result.response.ok, true, `available request failed: HTTP ${result.response.status}`);
    return result.body;
  }

  normalizeAvailable(raw) {
    const items = raw?.items;
    if (!Array.isArray(items)) throw new TestInfraError('available.items is not an array');
    if (!Number.isInteger(raw.total) || raw.total < items.length) {
      throw new TestInfraError(`available.total ${raw.total} is invalid for ${items.length} returned items`);
    }
    return items.map((item, index) => {
      const normalized = {
        pluginId: item?.pluginId,
        id: item?.name,
        marketplace: item?.marketplace,
        installed: item?.installed,
        installPayload: { name: item?.name, marketplace: item?.marketplace },
      };
      if (typeof normalized.id !== 'string' || normalized.id.length === 0) {
        throw new TestInfraError(`available.items[${index}] has no name`);
      }
      if (typeof normalized.marketplace !== 'string' || normalized.marketplace.length === 0) {
        throw new TestInfraError(`available.items[${index}] has no marketplace`);
      }
      return normalized;
    });
  }

  async available() {
    return this.normalizeAvailable(await this.fetchAvailableRaw());
  }

  async availableByQuery(query) {
    const url = new URL(this.url('R33_AVAILABLE_URL'));
    url.searchParams.delete('fresh');
    url.searchParams.set('q', query);
    const response = await fetch(url);
    assert.equal(response.ok, true, `available query failed: HTTP ${response.status}`);
    return this.normalizeAvailable(await response.json());
  }

  payloadFromEnv(name) {
    const raw = requiredEnv(name)
      .replaceAll('{{TEMP_ROOT}}', this.sandbox.rootDir)
      .replaceAll('{{MARKETPLACE_DIR}}', this.sandbox.marketplaceDir);
    try {
      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
      return payload;
    } catch (error) {
      throw new TestInfraError(`${name} is invalid: ${error.message}`);
    }
  }

  argsFromEnv(name) {
    const rendered = requiredEnv(name)
      .replaceAll('{{TEMP_ROOT}}', this.sandbox.rootDir)
      .replaceAll('{{MARKETPLACE_DIR}}', this.sandbox.marketplaceDir);
    let args;
    try {
      args = JSON.parse(rendered);
    } catch (error) {
      throw new TestInfraError(`${name} is invalid JSON: ${error.message}`);
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new TestInfraError(`${name} must be a JSON string array`);
    }
    return args;
  }

  async validateLocalFixture() {
    if (this.localFixtureValidated) return;
    const checkHome = path.join(this.sandbox.rootDir, 'fixture-check-home');
    const checkConfig = path.join(this.sandbox.rootDir, 'fixture-check-config');
    const checkXdgConfig = path.join(this.sandbox.rootDir, 'fixture-check-xdg-config');
    const checkXdgCache = path.join(this.sandbox.rootDir, 'fixture-check-xdg-cache');
    await Promise.all([checkHome, checkConfig, checkXdgConfig, checkXdgCache].map((directory) => mkdir(directory, { recursive: true })));
    const env = this.isolatedEnv({
      HOME: checkHome,
      CLAUDE_CONFIG_DIR: checkConfig,
      XDG_CONFIG_HOME: checkXdgConfig,
      XDG_CACHE_HOME: checkXdgCache,
    });
    const add = await runProcess(this.sandbox.realClaudeBin, ['plugin', 'marketplace', 'add', this.sandbox.marketplaceDir], {
      cwd: this.sandbox.rootDir,
      env,
      timeoutMs: 30_000,
    });
    if (add.code !== 0) throw new TestInfraError(`local marketplace fixture add failed: ${add.stderr}`);
    const install = await runProcess(
      this.sandbox.realClaudeBin,
      ['plugin', 'install', 'r33-third-party-plugin@r33-third-party-marketplace', '--scope', 'user'],
      { cwd: this.sandbox.rootDir, env, timeoutMs: 30_000 },
    );
    if (install.code !== 0) throw new TestInfraError(`local plugin fixture install failed: ${install.stderr}`);
    this.localFixtureValidated = true;
  }

  async requireValidatedLocalPayload(name = 'R33_LOCAL_VALID_PAYLOAD_JSON') {
    await this.validateLocalFixture();
    const payload = this.payloadFromEnv(name);
    const serialized = JSON.stringify(payload);
    if (!serialized.includes(this.sandbox.marketplaceDir)) {
      throw new TestInfraError(`${name} does not reference {{MARKETPLACE_DIR}}`);
    }
    if (!serialized.includes('r33-third-party-plugin') || !serialized.includes('r33-third-party-marketplace')) {
      throw new TestInfraError(`${name} does not preserve the local plugin ID and marketplace name`);
    }
    return payload;
  }

  async submitInstall(payload) {
    const response = await fetch(this.url('R33_INSTALL_URL'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  }

  errorFrom(body) {
    const error = body?.error;
    assert.ok(error && typeof error === 'object' && !Array.isArray(error), 'missing top-level error object');
    return error;
  }

  assertStructuredError(error, expected) {
    assert.deepEqual(
      {
        stage: error.stage,
        code: error.code,
        retryable: error.retryable,
        timeoutMs: error.timeoutMs,
      },
      expected,
    );
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.trim().length > 0, 'error.message must be visible');
  }

  async cli(args, { timeoutMs = 30_000, acceptNonZero = false } = {}) {
    const result = await runProcess(this.sandbox.realClaudeBin, args, {
      cwd: this.sandbox.rootDir,
      env: this.isolatedEnv(),
      timeoutMs,
    });
    if (!acceptNonZero) assert.equal(result.code, 0, `claude ${args.join(' ')} failed: ${result.stderr}`);
    return result;
  }

  async installedIdentities() {
    const result = await this.cli(['plugin', 'list', '--json']);
    let entries;
    try {
      entries = JSON.parse(result.stdout);
    } catch (error) {
      throw new TestInfraError(`claude plugin list --json returned invalid JSON: ${error.message}`);
    }
    if (!Array.isArray(entries)) throw new TestInfraError('claude plugin list --json must return an array');
    return entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
        throw new TestInfraError(`claude plugin list entry ${index} has no id`);
      }
      return entry.id;
    });
  }

  async cliAvailable() {
    const result = await this.cli(['plugin', 'list', '--available', '--json'], { timeoutMs: 60_000 });
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch (error) {
      throw new TestInfraError(`claude plugin list --available --json returned invalid JSON: ${error.message}`);
    }
    if (!value || !Array.isArray(value.available)) {
      throw new TestInfraError('claude plugin list --available --json has no available array');
    }
    return value.available.map((entry, index) => {
      if (!entry || typeof entry.name !== 'string' || typeof entry.marketplaceName !== 'string') {
        throw new TestInfraError(`CLI available[${index}] lacks name/marketplaceName`);
      }
      return { id: entry.name, marketplace: entry.marketplaceName };
    });
  }

  async prepareOfficialMarketplace() {
    const result = await runProcess(
      this.sandbox.realClaudeBin,
      ['plugin', 'marketplace', 'add', 'https://github.com/anthropics/claude-plugins-official.git'],
      {
        cwd: this.sandbox.rootDir,
        env: this.isolatedEnv(),
        timeoutMs: 120_000,
      },
    );
    if (result.code !== 0) {
      throw new TestInfraError(
        `official marketplace prepare failed: ${(result.stderr || result.stdout).slice(-1_000)}`,
        'TEST_INFRA_NETWORK',
      );
    }
  }

  async prepareStaleMarketplace() {
    const git = '/usr/bin/git';
    await access(git).catch(() => {
      throw new TestInfraError(`git binary missing: ${git}`);
    });
    const gitEnv = this.isolatedEnv({
      GIT_AUTHOR_NAME: 'r33 acceptance',
      GIT_AUTHOR_EMAIL: 'r33-acceptance@example.invalid',
      GIT_COMMITTER_NAME: 'r33 acceptance',
      GIT_COMMITTER_EMAIL: 'r33-acceptance@example.invalid',
    });
    const runGit = async (args) => {
      const result = await runProcess(git, args, {
        cwd: this.sandbox.staleMarketplaceDir,
        env: gitEnv,
        timeoutMs: 30_000,
      });
      if (result.code !== 0) throw new TestInfraError(`git ${args.join(' ')} failed: ${result.stderr}`);
    };

    await PluginAcceptanceHost.writeStaleMarketplaceFixture(this.sandbox.staleMarketplaceDir, false);
    await runGit(['init', '--quiet', '--initial-branch=main']);
    await runGit(['add', '.']);
    await runGit(['commit', '--quiet', '-m', 'marketplace A']);

    const clone = await runProcess(git, ['clone', '--quiet', '--bare', this.sandbox.staleMarketplaceDir, this.sandbox.staleBareDir], {
      cwd: this.sandbox.rootDir,
      env: gitEnv,
      timeoutMs: 30_000,
    });
    if (clone.code !== 0) throw new TestInfraError(`git clone --bare failed: ${clone.stderr}`);
    const updateServerInfo = async () => {
      const result = await runProcess(git, [`--git-dir=${this.sandbox.staleBareDir}`, 'update-server-info'], {
        cwd: this.sandbox.rootDir,
        env: gitEnv,
        timeoutMs: 30_000,
      });
      if (result.code !== 0) throw new TestInfraError(`git update-server-info failed: ${result.stderr}`);
    };
    await updateServerInfo();
    this.gitServer = await startSmartGitHttpServer(this.sandbox.staleBareDir, gitEnv);

    const add = await runProcess(
      this.sandbox.realClaudeBin,
      ['plugin', 'marketplace', 'add', this.gitServer.url],
      {
        cwd: this.sandbox.rootDir,
        env: this.isolatedEnv(),
        timeoutMs: 30_000,
      },
    );
    if (add.code !== 0) throw new TestInfraError(`stale marketplace add failed: ${add.stderr}`);

    await PluginAcceptanceHost.writeStaleMarketplaceFixture(this.sandbox.staleMarketplaceDir, true);
    await runGit(['add', '.']);
    await runGit(['commit', '--quiet', '-m', 'marketplace B adds target']);
    const push = await runProcess(git, ['push', '--quiet', this.sandbox.staleBareDir, 'HEAD:refs/heads/main'], {
      cwd: this.sandbox.staleMarketplaceDir,
      env: gitEnv,
      timeoutMs: 30_000,
    });
    if (push.code !== 0) throw new TestInfraError(`git push marketplace B failed: ${push.stderr}`);
    await updateServerInfo();
    return { name: 'r33-stale-target', marketplace: 'r33-stale-marketplace' };
  }

  async createForwardingProxy() {
    this.forwardingProxy = await startForwardingProxy('r33-proxy-target.invalid');
    return this.forwardingProxy;
  }

  async startGui() {
    if (this.guiHost) return this.guiHost.url;
    const guiPort = await allocateLoopbackPort();
    this.guiHost = await startGuiHost({
      distDir: path.join(this.backendCwd, 'client', 'dist'),
      backendPort: this.port,
      port: guiPort,
    }).catch((error) => {
      throw new TestInfraError(`GUI host unavailable: ${error.code || error.message}`);
    });
    return this.guiHost.url;
  }

  async captureGuiDefaultPayloads() {
    const guiUrl = await this.startGui();
    const loaderPath = process.env.R33_PLAYWRIGHT_LOADER || '/tmp/r33-acceptance-host/playwright-loader.mjs';
    const chromeExecutable = process.env.R33_CHROME_EXECUTABLE
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    await access(loaderPath).catch(() => {
      throw new TestInfraError(`Playwright loader missing: ${loaderPath}`);
    });
    await access(chromeExecutable).catch(() => {
      throw new TestInfraError(`system Chrome missing: ${chromeExecutable}`);
    });
    const probePath = fileURLToPath(new URL('./gui-defaults-probe.mjs', import.meta.url));
    const result = await runProcess(process.execPath, [`--experimental-loader=${loaderPath}`, probePath], {
      cwd: this.backendCwd,
      env: {
        HOME: this.sandbox.homeDir,
        CLAUDE_CONFIG_DIR: this.sandbox.claudeConfigDir,
        XDG_CONFIG_HOME: this.sandbox.xdgConfigDir,
        XDG_CACHE_HOME: this.sandbox.xdgCacheDir,
        PATH: SYSTEM_PATH,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        R33_GUI_URL: guiUrl,
        R33_CHROME_EXECUTABLE: chromeExecutable,
      },
      timeoutMs: 60_000,
    });
    if (result.code !== 0) {
      throw new TestInfraError(`GUI default probe failed: ${(result.stderr || result.stdout).slice(-2_000)}`);
    }
    try {
      const observation = JSON.parse(result.stdout);
      if (!observation || typeof observation !== 'object' || !Array.isArray(observation.payloads)) {
        throw new Error('result has no payloads array');
      }
      return observation;
    } catch (error) {
      throw new TestInfraError(`GUI default probe returned invalid JSON: ${error.message}`);
    }
  }

  async assertInstalled(plugin) {
    const identities = await this.installedIdentities();
    assert.ok(
      identities.includes(`${plugin.id}@${plugin.marketplace}`),
      `CLI list does not contain ${plugin.id}@${plugin.marketplace}: ${JSON.stringify(identities)}`,
    );
  }

  async cliRecords() {
    return readJsonLines(this.sandbox.cliRecordFile);
  }

  async assertRecordedIsolation() {
    const records = await this.cliRecords();
    assert.ok(records.length > 0, 'backend did not invoke the recorded Claude CLI');
    for (const record of records) {
      assert.ok(record.env.HOME.startsWith(this.sandbox.rootDir));
      assert.ok(record.env.CLAUDE_CONFIG_DIR.startsWith(this.sandbox.rootDir));
    }
  }

  async assertFreshConfig() {
    assert.deepEqual(this.initialHomeEntries, []);
    assert.deepEqual(this.initialClaudeConfigEntries, []);
  }

  async restartBackend(extraEnv = {}) {
    await this.stopBackend();
    await this.startBackend(extraEnv);
  }

  async createRejectingProxy() {
    const proxy = await startRejectingProxy();
    this.rejectingProxy = proxy;
    return proxy;
  }

  async close() {
    await this.guiHost?.close();
    await this.stopBackend();
    await this.rejectingProxy?.close();
    await this.forwardingProxy?.close();
    await this.gitServer?.close();
    if (this.keepArtifacts) {
      await appendFile(path.join(this.sandbox.artifactDir, 'backend.log'), this.backendOutput, 'utf8');
      process.stderr.write(`TEST_INFRA artifact retained at ${this.sandbox.rootDir}\n`);
      return;
    }
    const resolved = await realpath(this.sandbox.rootDir).catch(() => null);
    const prefix = path.join(await realpath(os.tmpdir()), 'cgui-plugin-r33-');
    assert.ok(resolved?.startsWith(prefix), `refusing to clean unexpected path: ${resolved}`);
    await rm(resolved, { recursive: true, force: true });
  }
}

export async function unusedLoopbackProxyUrl() {
  return `http://127.0.0.1:${await allocateLoopbackPort()}`;
}

export function assertSuccess(result) {
  assert.equal(result.response.ok, true, `expected success, got HTTP ${result.response.status}: ${JSON.stringify(result.body)}`);
}

export function assertCliStageRecorded(records, stage) {
  const expectedArgs = stage === 'marketplace-add'
    ? ['plugin', 'marketplace', 'add']
    : ['plugin', 'marketplace', 'update'];
  assert.ok(records.some((record) => expectedArgs.every((arg, index) => record.args[index] === arg)), `CLI did not record ${stage}`);
}
