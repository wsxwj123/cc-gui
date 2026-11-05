// r154-cu-grant-hardening 的测试世界:假家目录 + 假 helper + 隔离的服务实例 + HTTP / WebSocket / MCP 客户端。
//
// 铁规:
//   · 被测进程(server/index.js、mcp-server.js)用 `--import helpers/preload.mjs` 起,家目录被指到本套件
//     .artifacts 下的假目录 → 授权文件 grants.json 落在假目录里,真实 ~/.claude-gui、~/.claude.json 一个字节不碰;
//   · python3 被换成假 helper(helpers/fake-helper.mjs):窗口列表、光标命中都由剧本给,不碰桌面、不投递任何事件;
//   · 端口只用 6700-6999,硬拒 6677 / 6689 / 6710;杀进程只按记录下来的 pid;
//   · 观测只用公开面:HTTP 状态码/响应体、WebSocket 帧、MCP stdio 回执、授权文件、服务日志、文档。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import WebSocket from 'ws';
import { stopInstance, waitHealthy } from '../../cu-grant-ui-20260913/helpers/harness.mjs';

export { stopInstance };
const here = path.dirname(fileURLToPath(import.meta.url));
export const suiteDir = path.resolve(here, '..');
export const worktree = path.resolve(process.env.WORKTREE || path.join(suiteDir, '..', '..', '..'));
export const artifacts = path.join(suiteDir, '.artifacts');
const PRELOAD_URL = pathToFileURL(path.join(here, 'preload.mjs')).href;
const STUB = path.join(here, 'fake-helper.mjs');
export const SERVER_ENTRY = path.join(worktree, 'server', 'index.js');
export const MCP_ENTRY = path.join(worktree, 'server', 'computer-use', 'mcp-server.js');
export const TOKEN_HEADER = 'X-CGUI-Grant-Token';

export const ID = {
  textedit: 'com.apple.TextEdit', terminal: 'com.apple.Terminal', notes: 'com.apple.Notes',
  gui: 'com.claudegui.desktop', guiDs: 'com.claudegui.desktop.ds',
};
const win = (id, pid, app, bundleId, title, x) => ({ id, pid, app, bundleId, title, bounds: { x, y: 60, w: 600, h: 400 }, displayId: 1 });
export const WIN = {
  textedit: win(6001, 4101, 'TextEdit', ID.textedit, 'R154-TEXTEDIT-DOC', 50),
  terminal: win(6002, 4102, 'Terminal', ID.terminal, 'R154-TERMINAL-SECRET', 700),
  gui: win(6003, 4103, 'CC-GUI', ID.gui, 'R154-GUI-SECRET', 1300),
  guiDs: win(6004, 4104, 'CC-GUI-DS', ID.guiDs, 'R154-GUIDS-SECRET', 1900),
  notes: win(6005, 4105, 'Notes', ID.notes, 'R154-NOTES-DOC', 2500),
};

// ───────────────────────── 假世界 ─────────────────────────

/** 子进程环境:去掉宿主的 ANTHROPIC_*,以及一切 CU_ALLOW_*(本套件不真输入、不开夹具窗口,宿主 shell 里设了也不透传)。 */
const cleanEnv = (env) => {
  const e = { ...env };
  for (const k of Object.keys(e)) if (k.startsWith('ANTHROPIC_') || k.startsWith('CU_ALLOW_')) delete e[k];
  return e;
};

export function makeWorld(label) {
  const base = path.join(artifacts, `${label}-${crypto.randomBytes(3).toString('hex')}`);
  const home = path.join(base, 'home');
  const runtime = path.join(home, '.claude-gui', 'cu-runtime');
  const venv = path.join(runtime, 'venv');
  const stubLog = path.join(base, 'stub.jsonl');
  const scenarioFile = path.join(base, 'scenario.json');
  fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // 钉成回环:公开版首启会自愈成 0.0.0.0 + 随机密码
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  const py = path.join(venv, 'bin', 'python3');
  // 壳脚本自带环境变量:不依赖被测一侧把 env 透传给 helper 子进程
  fs.writeFileSync(py, `#!/bin/sh\nR154_STUB_LOG='${stubLog}' R154_STUB_SCENARIO='${scenarioFile}' exec '${process.execPath}' '${STUB}' "$@"\n`);
  fs.chmodSync(py, 0o755);
  fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = /nonexistent\n'); // 有 cfg + 有 python3 → 不建 venv
  fs.writeFileSync(path.join(runtime, 'venv.stamp'), 'r154-fixture\n');     // stamp 即便对不上,pip 也是假的(见 fake-helper)
  // 面板只在 registered:true 时渲染"应用授权"区块
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'ccgui-computer-use': { type: 'stdio', command: process.execPath, args: [MCP_ENTRY] } },
  }, null, 2));
  fs.writeFileSync(stubLog, '');
  fs.writeFileSync(scenarioFile, '{}');
  const w = {
    label, base, home, runtime, grantsFile: path.join(runtime, 'grants.json'), stubLog, scenarioFile,
    env: { HOME: home, USERPROFILE: home, R154_FAKE_HOME: home, R154_STUB_LOG: stubLog, R154_STUB_SCENARIO: scenarioFile },
    /** 直接写授权文件(播种:模拟"旧数据"/"用户在别处操作过")。 */
    setGrants({ apps = [], screenScope = false } = {}) {
      const now = new Date().toISOString();
      const g = { version: 1, screenScope: { granted: !!screenScope, grantedAt: screenScope ? now : null }, apps: {} };
      for (const id of apps) g.apps[id] = { name: id, grantedAt: now };
      fs.writeFileSync(w.grantsFile, JSON.stringify(g, null, 2));
    },
    rawGrants() { try { return fs.readFileSync(w.grantsFile, 'utf8'); } catch { return null; } },
    fileAppIds() { try { return Object.keys(JSON.parse(w.rawGrants()).apps || {}); } catch { return []; } },
    setScenario(obj) { fs.writeFileSync(scenarioFile, JSON.stringify(obj)); },
    clearStubLog() { fs.writeFileSync(stubLog, ''); },
    /** 假 helper 收到过的全部真调用(排除 `-m pip` 之类的解释器调用)。 */
    helperCalls() {
      return fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'helper');
    },
    /** 只读子命令之外的一切都算"可能投递了事件"。 */
    dispatchCalls() {
      const readOnly = new Set(['windows', 'cursor', 'doctor', 'apps', 'app-info', 'screenshot', 'ax-state', 'release-hold', 'uia-probe']);
      return w.helperCalls().filter((e) => !readOnly.has(e.subcmd)).map((e) => e.subcmd);
    },
  };
  w.setGrants({});
  return w;
}

// ───────────────────────── 服务实例 ─────────────────────────

const RESERVED = new Set([6677, 6689, 6710]);
export function pickPort() {
  const start = Math.floor(Math.random() * 300);
  for (let i = 0; i < 300; i += 1) {
    const port = 6700 + ((start + i) % 300);
    if (RESERVED.has(port)) continue;
    const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (!String(out.stdout || '').trim()) return port;
  }
  throw new Error('ENVIRONMENT_BLOCKED: 6700-6999 没有空闲端口');
}

export function trackPid(pid) {
  fs.mkdirSync(artifacts, { recursive: true });
  fs.appendFileSync(path.join(artifacts, 'pids.txt'), `${pid}\n`);
}

function listenerPids(port) {
  const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return String(out.stdout || '').split('\n').map((l) => Number(l.trim())).filter(Boolean);
}

/** 起一个隔离的后端实例(HTTP + /ws)。返回 { pid, port, base, logPath, readLog }。 */
export async function startServer(world, { label = 'server', env = {} } = {}) {
  const port = pickPort();
  const logPath = path.join(world.base, `${label}.log`);
  const log = fs.openSync(logPath, 'a');
  const childEnv = cleanEnv({ ...process.env, ...world.env, PORT: String(port), CGUI_DISABLE_FILE_WATCHER: '1', ...env });
  let exited = false;
  const proc = spawn(process.execPath, ['--import', PRELOAD_URL, SERVER_ENTRY], {
    cwd: path.dirname(SERVER_ENTRY), env: childEnv, stdio: ['ignore', log, log],
  });
  trackPid(proc.pid);
  proc.on('exit', () => { exited = true; });
  const healthy = await waitHealthy(port, 40_000);
  const listeners = listenerPids(port);
  if (!healthy || exited || !listeners.includes(proc.pid)) {
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* 已退 */ }
    throw new Error(`ENVIRONMENT_BLOCKED: 实例没起来或端口被别人占了(端口 ${port},听众 ${listeners.join(',') || '无'},进程${exited ? '已退出' : '在跑'});看 ${logPath}`);
  }
  return { pid: proc.pid, port, base: `http://127.0.0.1:${port}`, logPath, readLog: () => fs.readFileSync(logPath, 'utf8') };
}

// ───────────────────────── HTTP ─────────────────────────

/** 原始 HTTP 请求(用 node:http:能精确控制请求头,包括"同名头发两次")。 */
export function httpRequest(base, { method = 'GET', pathname, headers = {}, body } = {}) {
  const u = new URL(base);
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, method, path: pathname,
      headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 也是有效观测 */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('请求超时 30s')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** token: undefined=不带头;string=带一次;数组=同名头重复发送。 */
export const postGrants = (base, body, token) => httpRequest(base, {
  method: 'POST', pathname: '/api/computer-use/grants', body, headers: token === undefined ? {} : { [TOKEN_HEADER]: token },
});
export const getGrants = (base) => httpRequest(base, { pathname: '/api/computer-use/grants' });
export const getStatus = (base) => httpRequest(base, { pathname: '/api/computer-use/status' });
export const postDoctor = (base) => httpRequest(base, { method: 'POST', pathname: '/api/computer-use/doctor', body: {} });
export async function grantedIds(base) {
  const r = await getGrants(base);
  return (r.json?.apps || []).map((a) => (typeof a === 'string' ? a : a?.bundleId));
}
export async function screenScopeGranted(base) {
  return (await getGrants(base)).json?.screenScope?.granted;
}
/** 在任意形状的响应里收集"应用 id"(bundleId 字段、apps 数组/对象的元素)。 */
export function collectIds(node, out = new Set()) {
  if (Array.isArray(node)) { node.forEach((x) => collectIds(x, out)); return out; }
  if (node && typeof node === 'object') {
    if (typeof node.bundleId === 'string') out.add(node.bundleId);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'apps' && Array.isArray(v)) v.forEach((x) => { if (typeof x === 'string') out.add(x); });
      if (k === 'apps' && v && typeof v === 'object' && !Array.isArray(v)) Object.keys(v).forEach((id) => out.add(id));
      collectIds(v, out);
    }
  }
  return out;
}
export const lower = (ids) => [...ids].map((s) => String(s).toLowerCase());

// ───────────────────────── WebSocket 与面板凭证 ─────────────────────────

/** 开一个 /ws 连接,收帧;默认带同源 Origin(像面板那样)。永不抛错,所有结果都在返回值里。 */
export function openWs(base, { origin, waitMs = 2500, lingerMs = 0 } = {}) {
  const u = new URL(base);
  return new Promise((resolve) => {
    const out = { opened: false, frames: [], status: undefined, error: undefined, closeCode: undefined };
    let settled = false;
    let lingerTimer = null;
    const ws = new WebSocket(`ws://${u.host}/ws`, { origin: origin ?? `http://${u.host}` });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(lingerTimer);
      try { ws.terminate(); } catch { /* 已关 */ }
      resolve(out);
    };
    const timer = setTimeout(finish, waitMs);
    ws.on('open', () => { out.opened = true; });
    ws.on('message', (data) => {
      const text = data.toString();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON 帧 */ }
      out.frames.push({ text, json });
      if (json?.type === 'cu:grant-token' && !lingerTimer) lingerTimer = setTimeout(finish, lingerMs);
    });
    ws.on('unexpected-response', (_req, res) => { out.status = res.statusCode; finish(); });
    ws.on('error', (e) => { out.error = String(e?.message || e); if (!out.opened) finish(); });
    ws.on('close', (code) => { out.closeCode = code; finish(); });
  });
}
export const tokenFrames = (r) => r.frames.filter((f) => f.json?.type === 'cu:grant-token');
/** 取面板凭证;收不到就返回 undefined(由调用方用具体断言失败,而不是超时/抛错)。 */
export async function getToken(base) {
  return tokenFrames(await openWs(base))[0]?.json?.token;
}
export function expectValidToken(token, { soft = false, who = '' } = {}) {
  const shown = token === undefined ? 'undefined(服务端没发 cu:grant-token 帧)' : `${typeof token},长度 ${String(token).length}`;
  const ok = typeof token === 'string' && token.length >= 32;
  (soft ? expect.soft : expect)(ok, `${who}期望收到长度≥32 的字符串(cu:grant-token 帧里的 token),实际 ${shown}`).toBe(true);
  return ok;
}

// ───────────────────────── MCP(stdio JSON-RPC)─────────────────────────

/** 起一个 mcp-server 进程(家目录被预加载指到假目录),返回 JSON-RPC 客户端。 */
export async function startMcp(world) {
  const child = spawn(process.execPath, ['--import', PRELOAD_URL, MCP_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(MCP_ENTRY), env: cleanEnv({ ...process.env, ...world.env }),
  });
  trackPid(child.pid);
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
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg); }
    }
  });
  let nextId = 1;
  const rpc = (method, params, timeoutMs = 60_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP 无应答:${method}(${timeoutMs}ms)stderr=${stderr.slice(-300)}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r154', version: '0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    pid: child.pid,
    stderr: () => stderr,
    async call(name, args = {}, timeoutMs = 60_000) {
      const r = await rpc('tools/call', { name, arguments: args }, timeoutMs);
      const sc = r.result?.structuredContent || {};
      const text = (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { rpcError: r.error, isError: r.result?.isError === true, sc, text, raw: r.result };
    },
    kill() { try { child.kill('SIGKILL'); } catch { /* 已退 */ } },
  };
}

const WINDOW_RE = /^#(\d+)\s+pid=(\d+)\s+\[([^\]]*)\]\s+(.*?)\s+\((-?\d+),\s*(-?\d+)\s+(\d+)x(\d+)\)\s*$/gm;
/** 解析 window_list 的文本行:`#<windowId> pid=<pid> [<app>] <title> (<x>,<y> <w>x<h>)`。 */
export function parseWindows(text) {
  const out = [];
  WINDOW_RE.lastIndex = 0;
  let m;
  while ((m = WINDOW_RE.exec(text)) !== null) out.push({ windowId: Number(m[1]), pid: Number(m[2]), app: m[3], title: m[4] });
  return out;
}
/** 副作用工具的合法参数壳(坐标类要 snapshotId;这里没有真截图,用占位值)。 */
export const clickArgs = (target, over = {}) => ({
  actionId: `r154_${crypto.randomBytes(5).toString('hex')}`,
  target: { bundleId: target.bundleId, pid: target.pid, windowId: target.id ?? target.windowId },
  snapshotId: 'r154_snap_0001', foreground: false, x: 1, y: 1, ...over,
});
