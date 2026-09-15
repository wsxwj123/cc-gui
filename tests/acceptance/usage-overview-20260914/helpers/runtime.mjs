// 隔离实例的起停 + 计时口径 + 磁盘缓存文件的操作。铁规(与其它验收套件同口径):
//   · 只用 127.0.0.1 上**本套件自己的**实例,端口硬拒用户正在用的 6677 / 6689。
//   · HOME 指到本套件 .artifacts/runtime-data/home* → 用户的 ~/.claude、~/.claude-gui
//     一个字节都不碰(U8 的只读软链除外,那条也只用不写)。
//   · 杀进程只按**记录下来的 pid**(process.kill(pid)),绝不用 pkill 那类按名字杀的写法。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, homeDir, projectsDir } from './fixtures.mjs';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const worktree = path.resolve(process.env.WORKTREE || path.join(suiteDir, '..', '..', '..'));
export const serverEntry = path.join(worktree, 'server', 'index.js');
export const usageStatsPath = path.join(worktree, 'server', 'services', 'usage-stats.js');
// BRIEF §3.2 指定的落点(与 pricing-catalog.js 同目录)
export const CACHE_NAME = 'usage-stats-cache.json';
export const cachePath = (home) => path.join(home, '.claude-gui', CACHE_NAME);
export const logsDir = () => path.join(ROOT, 'logs');

export class EnvironmentBlocked extends Error {
  constructor(msg) { super(`ENVIRONMENT_BLOCKED: ${msg}`); this.name = 'EnvironmentBlocked'; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function resolvePort() {
  const port = Number(process.env.USAGE_PORT || 0);
  if (!port) throw new EnvironmentBlocked('USAGE_PORT 未设置(用 run-isolated.sh 跑,它负责挑空闲端口)');
  if (port === 6677 || port === 6689) throw new EnvironmentBlocked(`端口 ${port} 是用户实例,拒用`);
  if (port < 6700 || port > 6999) throw new EnvironmentBlocked(`端口 ${port} 不在保留测试段 6700-6999`);
  return port;
}

/** 起实例前的 HOME 预备:network.json 必须钉成回环免密,否则公开版会自愈成 0.0.0.0+随机密码(会写盘、会占 6677)。 */
function ensureHomePrereqs(home) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  const net = path.join(home, '.claude-gui', 'network.json');
  if (!fs.existsSync(net)) fs.writeFileSync(net, JSON.stringify({ host: '127.0.0.1' }));
}

let port = 0;

export async function startInstance({ home = homeDir(), label = 'main', extra = {} } = {}) {
  port = port || resolvePort();
  ensureHomePrereqs(home);
  fs.mkdirSync(logsDir(), { recursive: true });
  const logPath = path.join(logsDir(), `${label}.log`);
  const log = fs.openSync(logPath, 'a');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(port), CGUI_DISABLE_FILE_WATCHER: '1', ...extra };
  // 别把宿主机的 provider 配置带进去(同其它套件口径)
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_')) delete env[k];
  const proc = spawn(process.execPath, [serverEntry], { cwd: worktree, env, stdio: ['ignore', log, log] });
  fs.writeSync(log, `\n=== spawn pid=${proc.pid} port=${port} home=${home} label=${label} ${new Date().toISOString()} ===\n`);
  const ok = await waitHealthy(port, 20_000);
  if (!ok) throw new EnvironmentBlocked(`实例起不来(端口 ${port},HOME ${home}),看 ${logPath}`);
  // spawnedAt:CPU 类断言的观测窗口要从这个时刻起算 —— 实例启动后头十几秒本来就在烧 CPU
  // (pricing-catalog 的多源定时刷新),窗口落在那段里量到的是无关噪声(见 U3a 的注释)。
  return { pid: proc.pid, proc, port, home, label, logPath, spawnedAt: Date.now() };
}

/** 只按 pid 杀。先 SIGTERM,4 秒不退再 SIGKILL(同 slowload 套件口径)。 */
export async function stopInstance(inst) {
  if (!inst?.pid) return;
  try { process.kill(inst.pid, 'SIGTERM'); } catch { return; }
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    try { process.kill(inst.pid, 0); } catch { return; }
    await sleep(100);
  }
  try { process.kill(inst.pid, 'SIGKILL'); } catch { /* 已经退了 */ }
  await sleep(200);
}

export async function waitHealthy(p, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${p}/api/health`)).ok) return true; } catch { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}

export const baseURL = () => `http://127.0.0.1:${port || resolvePort()}`;

/** 一次 /api/usage(记墙钟 + 状态码 + 原文)。 */
export async function getUsage({ timeoutMs = 120_000 } = {}) {
  const t0 = performance.now();
  const res = await fetch(`${baseURL()}/api/usage`, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  const ms = performance.now() - t0;
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON 也要把原文带出去 */ }
  return { ms, status: res.status, text, body };
}

/** 并发 N 发 /api/usage(墙钟 = 从第一发起算到全部读完)。 */
export async function getUsageConcurrent(n, { timeoutMs = 120_000 } = {}) {
  const t0 = performance.now();
  const out = await Promise.all(Array.from({ length: n }, () => getUsage({ timeoutMs })));
  return { ms: performance.now() - t0, results: out };
}

/**
 * 服务端进程自身的累计 CPU 毫秒。拿不到返回 null —— 这是环境问题,不是产品红。
 *
 * 两个坑都踩过(macOS ps):
 *   1. 必须用 `time`,不能用 `cputime` —— cputime 连它 wait 过的子进程一起算,
 *      实测拿到的基线是秒级以上的子进程账,会让 CPU 断言变成空断言。
 *   2. 格式是 `MM:SS.ss`(只一个冒号!超过 1 小时才是 `HH:MM:SS`,带天数才是 `D-HH:MM:SS`)。
 *      按 HH:MM:SS 解会把 "0:00.27"(0.27 秒)读成 27.27 秒 —— 差 100 倍。
 */
export function cpuMs(pid) {
  const r = spawnSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const raw = String(r.stdout).trim();
  if (!raw) return null;
  const m = raw.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return ((Number(days || 0) * 24 + Number(hours || 0)) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
}

// ── 磁盘缓存文件的读写(变体构造给 U5)────────────────────────────────────
export const readCache = (home) => { try { return fs.readFileSync(cachePath(home), 'utf8'); } catch { return null; } };
export const writeCache = (home, text) => {
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  fs.writeFileSync(cachePath(home), text);
};
export const rmCache = (home) => fs.rmSync(cachePath(home), { force: true });
export const cacheStat = (home) => { try { const s = fs.statSync(cachePath(home)); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } };

export async function waitForCache(home, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const raw = readCache(home);
    if (raw) return raw;
    await sleep(100);
  }
  return null;
}

// ── HOME 变体 ────────────────────────────────────────────────────────────
export const mainHome = () => homeDir();

/** 干净 HOME:真 `.claude` 目录 + `projects` 软链到主夹具(只读用法),`.claude-gui` 放指定缓存内容。 */
export function scratchHome(name, { cache = null, roGuiDir = false } = {}) {
  const home = path.join(ROOT, `home-${name}`);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(projectsDir(), path.join(home, '.claude', 'projects'), 'dir');
  ensureHomePrereqs(home);
  if (cache !== null) writeCache(home, cache);
  if (roGuiDir) fs.chmodSync(path.join(home, '.claude-gui'), 0o555);
  return home;
}

export const restoreWritable = (home) => {
  try { fs.chmodSync(path.join(home, '.claude-gui'), 0o755); } catch { /* 已经删了 */ }
};

export function rmHome(home) {
  restoreWritable(home);
  fs.rmSync(home, { recursive: true, force: true });
}

/**
 * 子进程冷扫:在 home 下 import usage-stats.js,并发打 n 次 getUsageStats()。
 * 纯读,不写夹具。返回 { concurrentMs, sameRef, distinctRefs, total, ... }。
 */
export function scanProbe(home, n = 1) {
  const outPath = path.join(ROOT, `probe-${n}-${Date.now()}.json`);
  fs.mkdirSync(ROOT, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_')) delete env[k];
  const r = spawnSync(process.execPath,
    [path.join(suiteDir, 'helpers', 'probe.mjs'), home, usageStatsPath, String(n), outPath],
    { env, cwd: worktree, encoding: 'utf8' });
  if (r.status !== 0) throw new EnvironmentBlocked(`探针进程失败(${r.status}): ${r.stderr?.slice(0, 400)}`);
  const json = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  fs.rmSync(outPath, { force: true });
  return json;
}
