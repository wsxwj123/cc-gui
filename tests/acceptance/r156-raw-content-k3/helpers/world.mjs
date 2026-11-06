// r156 测试世界:隔离后端实例(假家目录 + 预加载 + 端口选择 + 杀进程 + 端口释放核对)与日志增量读取。
// 铁规:
//   · 被测后端用 NODE_OPTIONS 带 no-outbound 与 cu-preload 两个预加载,CU_TEST_HOME/HOME/USERPROFILE 全指向本套件 .artifacts 下的假家目录
//     (cu-preload 把电脑操控的家目录指到假目录,否则后端启动清理授权文件会改到真实 ~/.claude-gui);
//   · 端口只用 6700-6999,硬拒 6677 / 6689 / 6710;起服务后用 lsof 核对监听者就是刚起的 pid;杀进程只按自己记录的 pid;
//   · 从子进程环境里删掉 ANTHROPIC_*、CLAUDE_CODE_OAUTH_TOKEN、所有 *_proxy / *_PROXY,以及 CU_ALLOW_*、CGUI_TAURI、HOST、TUNNEL_HOSTNAME、PORT(再显式设置)。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const suiteDir = path.resolve(here, '..');
export const worktree = path.resolve(process.env.R156_WORKTREE || path.join(suiteDir, '..', '..', '..'));
export const artifacts = path.join(suiteDir, '.artifacts');
export const SERVER_ENTRY = path.join(worktree, 'server', 'index.js');
const NO_OUTBOUND_URL = pathToFileURL(path.join(worktree, 'tests', 'acceptance', 'r128-checkpoint-perf', 'helpers', 'no-outbound.mjs')).href;
const CU_PRELOAD_URL = pathToFileURL(path.join(worktree, 'tests', 'unit', 'q8-helpers', 'cu-preload.mjs')).href;

export const PASSWORD = 'pw-r156-123456';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 端口 ─────────────────────────
const RESERVED = new Set([6677, 6689, 6710]);
const handedOut = new Set();
export function listenerPids(port) {
  const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return String(out.stdout || '').split('\n').map((l) => Number(l.trim())).filter(Boolean);
}
/** 6700-6999 里当前空闲、且本进程没发给别人的端口;硬拒 6677 / 6689 / 6710。 */
export function pickPort() {
  const start = Math.floor(Math.random() * 300);
  for (let i = 0; i < 300; i += 1) {
    const port = 6700 + ((start + i) % 300);
    if (RESERVED.has(port) || handedOut.has(port)) continue;
    if (listenerPids(port).length) continue;
    handedOut.add(port);
    return port;
  }
  throw new Error('ENVIRONMENT_BLOCKED: 6700-6999 没有空闲端口');
}

// ───────────────────────── 进程记录与兜底 ─────────────────────────
const live = new Set();
process.on('exit', () => { for (const pid of live) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } } });
function trackPid(pid) {
  fs.mkdirSync(artifacts, { recursive: true });
  const started = String(spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout || '').trim();
  fs.appendFileSync(path.join(artifacts, 'pids.txt'), `${pid}\t${started}\n`);
  live.add(pid);
}

function cleanEnv(env) {
  const e = { ...env };
  for (const k of Object.keys(e)) {
    if (k.startsWith('ANTHROPIC_') || k.startsWith('CU_ALLOW_') || /_proxy$/i.test(k) || k === 'CLAUDE_CODE_OAUTH_TOKEN') delete e[k];
  }
  for (const k of ['HOST', 'CGUI_TAURI', 'TUNNEL_HOSTNAME', 'PORT']) delete e[k];
  return e;
}

// ───────────────────────── 实例 ─────────────────────────
async function waitHealthy(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.status === 200) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}
function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

/** 起一个隔离实例(假家目录里预写 network.json:host/port/passwordHash)。 */
export async function startInstance({ label = 'inst' } = {}) {
  const port = pickPort();
  const dir = path.join(artifacts, `${label}-${crypto.randomBytes(3).toString('hex')}`);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(PASSWORD), salt, 64).toString('hex');
  const netJson = path.join(home, '.claude-gui', 'network.json');
  fs.writeFileSync(netJson, JSON.stringify({ host: '127.0.0.1', port, passwordHash: { salt, hash } }));

  const logPath = path.join(dir, 'server.log');
  const logFd = fs.openSync(logPath, 'a');
  const env = cleanEnv({
    ...process.env,
    HOME: home, USERPROFILE: home, CU_TEST_HOME: home,
    PORT: String(port), CGUI_DISABLE_FILE_WATCHER: '1',
    NODE_OPTIONS: `--import=${NO_OUTBOUND_URL} --import=${CU_PRELOAD_URL}`,
    R128_BLOCKED_LOG: path.join(dir, 'blocked.log'),
  });
  env.HOST = '127.0.0.1';

  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: home, env, stdio: ['ignore', logFd, logFd] });
  trackPid(child.pid);
  let exited = false;
  child.on('exit', () => { exited = true; live.delete(child.pid); });

  const healthy = await waitHealthy(port, 40_000);
  const listeners = listenerPids(port);
  if (!healthy || exited || !listeners.includes(child.pid)) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退 */ }
    throw new Error(`ENVIRONMENT_BLOCKED: 实例没起来或端口被别人占了(端口 ${port},听众 ${listeners.join(',') || '无'},进程${exited ? '已退出' : '在跑'});看 ${logPath}`);
  }
  return { label, port, dir, home, logPath, netJson, pid: child.pid, child, base: `http://127.0.0.1:${port}`, isAlive: () => child.exitCode === null && child.signalCode === null };
}

/** 先 SIGTERM 再 SIGKILL(只按记录的 pid),然后核对端口已释放。 */
export async function stopInstance(inst) {
  const { child, port } = inst;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGTERM'); } catch { /* 已退 */ }
    if (!(await waitExit(child, 3000))) {
      try { child.kill('SIGKILL'); } catch { /* 已退 */ }
      await waitExit(child, 3000);
    }
  }
  for (let i = 0; i < 50; i += 1) {
    if (!listenerPids(port).length) return { released: true, listeners: [] };
    await sleep(100);
  }
  return { released: false, listeners: listenerPids(port) };
}

/** 起实例 → 跑用例体 → 无论成败都杀掉并核对端口释放。 */
export async function withInstance(opts, fn) {
  const inst = await startInstance(opts);
  let failed = false;
  try {
    return await fn(inst);
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    const r = await stopInstance(inst);
    if (!r.released && !failed) throw new Error(`端口 ${inst.port} 在杀掉实例后仍有监听者 pid=${r.listeners.join(',')}`);
  }
}

// ───────────────────────── 日志增量 ─────────────────────────
export const logSize = (inst) => { try { return fs.statSync(inst.logPath).size; } catch { return 0; } };
export const logSince = (inst, offset) => { try { return fs.readFileSync(inst.logPath).subarray(offset).toString('utf8'); } catch { return ''; } };
/** 轮询等增量满足条件(日志同步写文件,这里只给异步落盘留余量);返回最后一次读到的增量。 */
export async function waitLogSince(inst, offset, pred, ms = 2000) {
  const deadline = Date.now() + ms;
  let text = logSince(inst, offset);
  while (!pred(text) && Date.now() < deadline) { await sleep(100); text = logSince(inst, offset); }
  return text;
}
/** 增量里所有以 "[cors] blocked" 开头的整行。 */
export const blockedLines = (text) => String(text).split('\n').filter((l) => l.startsWith('[cors] blocked'));
