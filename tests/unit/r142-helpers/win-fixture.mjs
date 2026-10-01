// r142 测试夹具(3/3):假 Windows 家目录 + 假 WIN venv + 伪 win32 的 MCP 子进程客户端。
//
// 铁规(照 tests/unit/q8-helpers/cu-harness.mjs 的体例):HOME/运行时目录全落 r142-helpers/.artifacts/ 下,
// 绝不碰 ~/.claude-gui、不建真 venv、不装任何包、不碰桌面。
//
// 布局按方案 §7.2 #3 + FORENSICS ② #8 钉死:Windows = `venv-win` / `venv-win.stamp` /
// `venv-win/Scripts/python.exe`。布局不对 ⇒ bootstrap 会去建环境(桩会记下来),用例据此判红。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..', '..');
export const MCP_SCRIPT = join(ROOT, 'server', 'computer-use', 'mcp-server.js');
export const WIN_HELPER_REL = 'cu_helper_windows.py';
const STUB = join(HERE, 'win-helper-stub.mjs');
export const PRELOAD = pathToFileURL(join(HERE, 'win-preload.mjs')).href;

/** 方案 §2.4 钉死的 Windows 依赖表(不许含 pyobjc)。 */
export const WIN_DEPS = ['mss', 'Pillow', 'comtypes>=1.4.0'];
/** 与 mcp-server.js:36 `createHash('sha256').update(DEPS.join('|'))` 同款算法。 */
export function depsStamp(deps) {
  return createHash('sha256').update(deps.join('|')).digest('hex');
}

export const GRANTED = { bundleId: 'C:\\Windows\\System32\\notepad.exe', pid: 5150, windowId: 7001, name: 'Notepad' };
export const TARGET = { bundleId: GRANTED.bundleId, pid: GRANTED.pid, windowId: GRANTED.windowId };
export function grantedWindow(title = 'Untitled - Notepad') {
  return { id: GRANTED.windowId, pid: GRANTED.pid, app: GRANTED.name, bundleId: GRANTED.bundleId,
    title, bounds: { x: 100, y: 100, w: 800, h: 600 }, displayId: 1 };
}

function shim(pyName, node, stub) {
  return `#!/bin/sh\nCU_STUB_PYNAME=${pyName} exec "${node}" "${stub}" "$@"\n`;
}

/**
 * 造一个假 Windows 家目录。
 *   opts.venvReady=false → 不预置 venv-win(用来观察 bootstrap 真去建环境)
 *   opts.stamp='mismatch' → 故意写错依赖戳(用来观察产品真实传给 pip 的依赖表)
 */
export function makeWinHome(name, { venvReady = true, stamp = 'match' } = {}) {
  const base = join(HERE, '.artifacts', name);
  fs.rmSync(base, { recursive: true, force: true });
  const home = join(base, 'home');
  const runtimeDir = join(home, '.claude-gui', 'cu-runtime');
  const venvDir = join(runtimeDir, 'venv-win');
  const py = join(venvDir, 'Scripts', 'python.exe');
  fs.mkdirSync(join(runtimeDir, 'shots'), { recursive: true });
  if (venvReady) {
    fs.mkdirSync(join(venvDir, 'Scripts'), { recursive: true });
    fs.writeFileSync(py, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
    fs.chmodSync(py, 0o755);
    fs.writeFileSync(join(venvDir, 'pyvenv.cfg'), 'home = C:\\Fake\n');
    const value = stamp === 'match' ? depsStamp(WIN_DEPS) : 'deadbeef'.repeat(8);
    fs.writeFileSync(join(runtimeDir, 'venv-win.stamp'), `${value}\n`);
  }
  // PATH 上的 win32 候选解释器(py -3 / python),由产品自己去找
  const binDir = join(base, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const [file, pyName] of [['py', 'py'], ['python', 'python']]) {
    fs.writeFileSync(join(binDir, file), shim(pyName, process.execPath, STUB));
    fs.chmodSync(join(binDir, file), 0o755);
  }
  const stubLog = join(base, 'argv.jsonl');
  const sigLog = join(base, 'signals.jsonl');
  const scenarioFile = join(base, 'scenario.json');
  const beatDir = join(base, 'beats');
  fs.writeFileSync(stubLog, '');
  fs.writeFileSync(sigLog, '');
  fs.writeFileSync(scenarioFile, '{}');
  const grantsFile = join(runtimeDir, 'grants.json');
  fs.mkdirSync(beatDir, { recursive: true });
  return {
    base, home, runtimeDir, venvDir, venvPy: py, binDir, shotDir: join(runtimeDir, 'shots'),
    grantsFile, stubLog, sigLog, scenarioFile, beatDir, uiaCacheFile: join(runtimeDir, 'uia-capability.json'),
    setScenario(obj) { fs.writeFileSync(scenarioFile, JSON.stringify(obj)); },
    setGrants({ apps = [GRANTED.bundleId], screenScope = true } = {}) {
      const grants = { version: 1, screenScope: { granted: screenScope, grantedAt: screenScope ? new Date().toISOString() : null }, apps: {} };
      for (const b of apps) grants.apps[b] = { name: b, grantedAt: new Date().toISOString() };
      fs.writeFileSync(grantsFile, JSON.stringify(grants));
    },
    log() {
      return fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    helperCalls(subcmd) { return this.log().filter((e) => e.kind === 'helper' && (!subcmd || e.subcmd === subcmd)); },
    /** 所有 helper 调用里出现过的 --method 取值(空数组 = 一次都没带 method)。 */
    methodsSeen() {
      return this.log().filter((e) => e.kind === 'helper')
        .map((e) => { const i = e.args.indexOf('--method'); return i >= 0 ? e.args[i + 1] : null; })
        .filter(Boolean);
    },
    signals() {
      return fs.readFileSync(sigLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    clearLogs() { fs.writeFileSync(stubLog, ''); fs.writeFileSync(sigLog, ''); },
    /** 测试侧直接造一个"helper 已按下、hold 文件已落盘"的状态(层 2 的输入条件)。 */
    writeHoldFile(pid, keys) {
      const target = join(runtimeDir, `hold-${pid}.json`);
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, pid, keys, held: keys, updatedAt: new Date().toISOString(), at: Date.now() })}\n`);
      fs.renameSync(tmp, target);
      return target;
    },
    holdFiles() {
      return fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir).filter((f) => /^hold-.*\.json$/.test(f)) : [];
    },
  };
}

/** 起一个"以为是 Windows"的 mcp-server,返回 JSON-RPC 客户端。 */
export async function startWinMcp(fake, { env = {} } = {}) {
  const child = spawn(process.execPath, ['--import', PRELOAD, MCP_SCRIPT], {
    detached: true, // 便于收尾时连 watcher 一起收掉
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: fake.home, USERPROFILE: fake.home, CU_TEST_HOME: fake.home,
      PATH: `${fake.binDir}:${process.env.PATH || ''}`,
      CU_STUB_LOG: fake.stubLog, CU_STUB_SIGLOG: fake.sigLog,
      CU_STUB_SCENARIO: fake.scenarioFile, CU_STUB_HEARTBEAT_DIR: fake.beatDir,
      CU_STUB_HOLD_DIR: fake.runtimeDir,
      ...env,
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`mcp 无应答: ${method}(${timeoutMs}ms) stderr=${stderr.slice(-300)}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r142', version: '0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    child, pid: child.pid, stderr: () => stderr,
    async call(name, args = {}, timeoutMs = 60_000) {
      const r = await rpc('tools/call', { name, arguments: args }, timeoutMs);
      const sc = r.result?.structuredContent || {};
      const text = (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { error: r.error, isError: r.result?.isError === true, sc, text, raw: r.result };
    },
    kill(signal = 'SIGKILL') { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* 已退出 */ } } },
    /** 只杀 mcp 本体,不杀同组的 watcher —— 层 2 的"父进程猝死"必须用这个。 */
    killParentOnly(signal = 'SIGKILL') { try { child.kill(signal); } catch { /* 已退出 */ } },
    waitExit(timeoutMs = 3000) {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) return resolve(true);
        const timer = setTimeout(() => resolve(false), timeoutMs);
        child.on('exit', () => { clearTimeout(timer); resolve(true); });
      });
    },
  };
}

/**
 * 读取桩日志里 release-hold 那次调用(用于"先杀后释放"的顺序判定)。
 *
 * ⚠️ 必须连 `kind === 'release-hold'` 那条记录一起取:桩对每次调用会写**两条**记录 ——
 * 一条是通用的 `{kind:'helper', subcmd, args}`(顶部),一条是 release-hold 分支专用的
 * `{kind:'release-hold', latestBeatAt, argvKeys}`(在 finish() 里,后写,**没有 subcmd 字段**)。
 * `helperCalls()` 只认 `kind === 'helper'`,而 `latestBeatAt` **只存在于专用记录里** ——
 * 只取前者会让 T4-01 的 `rel.latestBeatAt` 恒为 undefined(那条断言与实现无关地永远红)。
 */
export function releaseHoldEntry(fake) {
  const entries = fake.log().filter((e) => e.kind === 'release-hold'
    || (e.kind === 'helper' && e.subcmd === 'release-hold'));
  return entries.length ? entries[entries.length - 1] : null;
}
