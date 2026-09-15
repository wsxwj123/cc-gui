// 隔离实例的起停 + 计时口径。铁规(与其它验收套件同口径):
//   · 只用 127.0.0.1 上**本套件自己的**实例;用户正在用的 6677 / 6689 一律拒(启动前断言)。
//   · HOME 指到本套件 .artifacts/runtime-data/home → 索引落在那里,真实 ~/.claude 与
//     ~/.claude-gui 一个字都不碰(20 MB 夹具也一样只在本套件目录里)。
//   · 杀进程只按**记录下来的 pid**(kill(pid))——不用 pkill 那类按名字杀的写法。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homeDir, indexDir, dataRoot } from './fixtures.mjs';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const worktree = path.resolve(process.env.WORKTREE || path.join(suiteDir, '..', '..', '..'));
export const serverEntry = path.join(worktree, 'server', 'index.js');
export const serverLog = () => path.join(dataRoot(), 'server.log');

export class EnvironmentBlocked extends Error {
  constructor(msg) { super(`ENVIRONMENT_BLOCKED: ${msg}`); this.name = 'EnvironmentBlocked'; }
}

export function resolvePort() {
  const port = Number(process.env.SLOWLOAD_PORT || 0);
  if (!port) throw new EnvironmentBlocked('SLOWLOAD_PORT 未设置(用 run-isolated.sh 跑,它负责挑空闲端口)');
  if ([6677, 6689].includes(port)) throw new EnvironmentBlocked(`端口 ${port} 是用户实例,拒用`);
  if (port < 6700 || port > 6999) throw new EnvironmentBlocked(`端口 ${port} 不在保留测试段 6700-6999`);
  return port;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本次运行专用的索引目录(全新、空)。每次跑都换一个 → 「无索引」那一档不需要删任何东西。 */
let runIndexDir = null;
export function activeIndexDir() {
  if (!runIndexDir) runIndexDir = path.join(indexDir(), `run-${Date.now()}`);
  return runIndexDir;
}

function childEnv({ indexOn = true, extra = {} } = {}) {
  const env = { ...process.env };
  // 别把宿主机的 provider 配置带进去(与其它套件的 `env -u ANTHROPIC_*` 同口径)。
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_')) delete env[k];
  return Object.assign(env, {
    HOME: homeDir(),
    USERPROFILE: homeDir(), // Windows 的 os.homedir() 读 USERPROFILE
    PORT: String(port),
    CGUI_DISABLE_FILE_WATCHER: '1',   // 去抖 watcher 会把计数器搅浑(计时口径见 README)
    CGUI_ENABLE_LOCAL_ROUTES: '1',
    CGUI_SESSION_INDEX_LOG: '1',
    CGUI_SESSION_INDEX: indexOn ? 'on' : 'off',
    CGUI_SESSION_INDEX_DIR: activeIndexDir(),
    ...extra,
  });
}

let port = 0;

/** 起一个隔离实例(调用方负责 stop)。返回 { pid, proc }。 */
export async function startInstance({ indexOn = true, extra = {} } = {}) {
  port = port || resolvePort();
  const log = fs.openSync(serverLog(), 'a');
  const proc = spawn(process.execPath, [serverEntry], {
    cwd: worktree,
    env: childEnv({ indexOn, extra }),
    stdio: ['ignore', log, log],
    detached: false,
  });
  fs.writeSync(log, `\n=== spawn pid=${proc.pid} port=${port} index=${indexOn ? 'on' : 'off'} ${new Date().toISOString()} ===\n`);
  const ok = await waitHealthy(port, 20_000);
  if (!ok) throw new EnvironmentBlocked(`实例起不来(端口 ${port}),看 ${serverLog()}`);
  return { pid: proc.pid, proc };
}

export function stopInstance(inst) {
  if (!inst || !inst.pid) return;
  try { process.kill(inst.pid, 'SIGTERM'); } catch { /* 已经退了 */ }
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      let alive = true;
      try { process.kill(inst.pid, 0); } catch { alive = false; }
      if (!alive || Date.now() - t0 > 4000) {
        if (alive) { try { process.kill(inst.pid, 'SIGKILL'); } catch { /* ignore */ } }
        resolve();
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** 「重启进程」= 完全停掉再起一次(冷进程:内存画像为空,磁盘索引还在)。 */
export async function restartInstance(inst, opts) {
  await stopInstance(inst);
  await sleep(120);
  return startInstance(opts);
}

export async function waitHealthy(p, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}

export const baseURL = () => `http://127.0.0.1:${port || resolvePort()}`;

/** 计时:HTTP 全程(连到响应体读完),毫秒。样本逐次串行。 */
export async function timed(pathname, { samples = 3 } = {}) {
  const url = `${baseURL()}${pathname}`;
  const ms = [];
  let body = null;
  for (let i = 0; i < samples; i += 1) {
    const t0 = performance.now();
    const res = await fetch(url);
    const text = await res.text();
    ms.push(performance.now() - t0);
    if (!res.ok) throw new Error(`GET ${pathname} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    body = text;
  }
  const sorted = [...ms].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], samples: ms, body };
}

/** 一次请求(计时,返回 {ms, body, status})。 */
export async function hit(pathname) {
  const t0 = performance.now();
  const res = await fetch(`${baseURL()}${pathname}`);
  const text = await res.text();
  return { ms: performance.now() - t0, body: text, status: res.status };
}

export async function getJson(pathname) {
  const res = await fetch(`${baseURL()}${pathname}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${pathname} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export const stats = () => getJson('/api/session-index/stats');
export const projectsPath = '/api/projects';
export const sessionsPath = (hash) => `/api/projects/${encodeURIComponent(hash)}/sessions`;

/** 索引文件名 = <项目 hash>.json(见 session-index.js)。 */
export function indexFileMtime(hash) {
  try { return fs.statSync(path.join(activeIndexDir(), `${hash}.json`)).mtimeMs; } catch { return null; }
}

/**
 * 轮询等索引落盘(INTERFACE §D.4:≤5 s),**不用固定 sleep**。
 * baseline = 请求之前的 mtime;要求它前进(或文件从不存在的状态出现)。
 */
export async function waitForIndexFlush(hash, { baseline = null, timeoutMs = 5000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const now = indexFileMtime(hash);
    if (now !== null && (baseline === null || now > baseline)) return now;
    await sleep(100);
  }
  throw new Error(`索引文件 ${hash}.json 在 ${timeoutMs} ms 内没有落盘(基线 mtime=${baseline})`);
}

/** fd 计数(P13):lsof 行数,拿不到就返回 null(记 EnvironmentBlocked,不报产品红)。 */
export function fdCount(pid) {
  return new Promise((resolve) => {
    const p = spawn('lsof', ['-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(out.trim() ? out.trim().split('\n').length : null));
  });
}
