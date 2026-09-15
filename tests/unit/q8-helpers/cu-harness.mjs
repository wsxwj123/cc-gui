// computer-use MCP 进程级测试夹具:假家目录 + 假 python3(cu-stub.mjs)+ JSON-RPC 客户端。
// 铁规:HOME/运行时目录全部落在本目录 .artifacts/ 下,绝不碰 ~/.claude-gui;不建 venv、不装包。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..', '..');
export const MCP_SCRIPT = join(ROOT, 'server', 'computer-use', 'mcp-server.js');
export const HELPER_PY = join(ROOT, 'server', 'computer-use', 'cu_helper.py');
const STUB = join(HERE, 'cu-stub.mjs');
const PRELOAD = pathToFileURL(join(HERE, 'cu-preload.mjs')).href;

// 授权应用与它的窗口(pid/windowId 都是不存在的假值;target 匹配只看 pid/id/bundleId)
export const GRANTED = { bundleId: 'com.example.granted', pid: 4242, windowId: 5001, name: 'Granted' };
export const TARGET = { bundleId: GRANTED.bundleId, pid: GRANTED.pid, windowId: GRANTED.windowId };

export function grantedWindow(title = 'Granted Doc') {
  return { id: GRANTED.windowId, pid: GRANTED.pid, app: GRANTED.name, bundleId: GRANTED.bundleId, title, bounds: { x: 10, y: 20, w: 300, h: 200 }, displayId: 1 };
}

/** 从产品源码里取 PY_DEPS 算 stamp:stamp 对上,mcp-server 才不会去建 venv / pip install。 */
function depsStamp() {
  const src = fs.readFileSync(MCP_SCRIPT, 'utf8');
  const m = /const PY_DEPS = \[([^\]]*)\]/.exec(src);
  if (!m) throw new Error('mcp-server.js 里找不到 PY_DEPS 常量,夹具无法保证不触发 pip install');
  const deps = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return createHash('sha256').update(deps.join('|')).digest('hex');
}

export function makeFakeHome(name) {
  const base = join(HERE, '.artifacts', name);
  fs.rmSync(base, { recursive: true, force: true });
  const home = join(base, 'home');
  const runtimeDir = join(home, '.claude-gui', 'cu-runtime');
  const venv = join(runtimeDir, 'venv');
  const py = join(venv, 'bin', 'python3');
  fs.mkdirSync(join(venv, 'bin'), { recursive: true });
  fs.mkdirSync(join(runtimeDir, 'shots'), { recursive: true });
  fs.writeFileSync(py, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
  fs.chmodSync(py, 0o755);
  fs.writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /nonexistent\n'); // 有 cfg + 有 python3 → 跳过 venv 创建
  fs.writeFileSync(join(runtimeDir, 'venv.stamp'), `${depsStamp()}\n`);   // stamp 对上 → 跳过 pip
  const stubLog = join(base, 'argv.jsonl');
  const sigLog = join(base, 'signals.jsonl');
  const scenarioFile = join(base, 'scenario.json');
  fs.writeFileSync(stubLog, '');
  fs.writeFileSync(sigLog, '');
  fs.writeFileSync(scenarioFile, '{}');
  const grantsFile = join(runtimeDir, 'grants.json');
  const api = {
    base, home, runtimeDir, shotDir: join(runtimeDir, 'shots'), grantsFile, stubLog, sigLog, scenarioFile,
    setScenario(obj) { fs.writeFileSync(scenarioFile, JSON.stringify(obj)); },
    setGrants({ apps = [GRANTED.bundleId], screenScope = false } = {}) {
      const grants = { version: 1, screenScope: { granted: screenScope, grantedAt: screenScope ? new Date().toISOString() : null }, apps: {} };
      for (const b of apps) grants.apps[b] = { name: b, grantedAt: new Date().toISOString() };
      fs.writeFileSync(grantsFile, JSON.stringify(grants));
    },
    argv() {
      return fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    signals() {
      return fs.readFileSync(sigLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    clearLogs() { fs.writeFileSync(stubLog, ''); fs.writeFileSync(sigLog, ''); },
  };
  return api;
}

/** 起一个 mcp-server 进程(家目录被预加载指到假目录),返回 JSON-RPC 客户端。 */
export async function startMcp(fake) {
  const child = spawn(process.execPath, ['--import', PRELOAD, MCP_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: fake.home, USERPROFILE: fake.home, CU_TEST_HOME: fake.home,
      CU_STUB_LOG: fake.stubLog, CU_STUB_SIGLOG: fake.sigLog, CU_STUB_SCENARIO: fake.scenarioFile,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const entry = pending.get(msg.id);
      if (entry) { pending.delete(msg.id); entry(msg); }
    }
  });
  let nextId = 1;
  const rpc = (method, params, timeoutMs = 60_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`mcp 无应答: ${method}(${timeoutMs}ms)stderr=${stderr.slice(-300)}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'q8', version: '0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    child,
    pid: child.pid,
    instanceId: init.result?.instanceId,
    stderr: () => stderr,
    async call(name, args = {}, timeoutMs = 60_000) {
      const r = await rpc('tools/call', { name, arguments: args }, timeoutMs);
      const sc = r.result?.structuredContent || {};
      const text = (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { error: r.error, isError: r.result?.isError === true, sc, text, raw: r.result };
    },
    kill() { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } },
  };
}

/** 两段式 `--flag value` 里 value 以 '-' 开头的实例(argparse 会把它当选项)。 */
export function dashValuesAfterFlags(args, flags = ['--text', '--title', '--unicode']) {
  const hits = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (flags.includes(args[i]) && /^-/.test(String(args[i + 1]))) hits.push([args[i], args[i + 1]]);
  }
  return hits;
}
