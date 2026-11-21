// r207 验收助手(接口测试部分):一次性隔离后端、CPU 时间测量、历史接口请求。只走 HTTP 与文件系统,不 import 产品代码。
// 端口只在 6700–6799 里挑空闲的,硬拒 6677 / 6689 / 6710 / 8788 / 8789 / 8798 / 8799。
// 收尾只按自己记录的进程号;pid 同时追加到 <运行目录>/pids.txt,供 run.sh 兜底收尾。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SUITE = path.resolve(here, '..');
export const WORKTREE = path.resolve(SUITE, '..', '..', '..');
export const RUN_ROOT = process.env.R207_RUN_ROOT || path.join(SUITE, '.artifacts', 'runs', `adhoc-${process.pid}`);
const PRELOAD = path.join(WORKTREE, 'tests', 'unit', 'q8-helpers', 'cu-preload.mjs');
const FORBIDDEN_PORTS = [6677, 6689, 6710, 8788, 8789, 8798, 8799];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uuid = () => crypto.randomUUID();
export const encodeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function recordPid(pid) {
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  fs.appendFileSync(path.join(RUN_ROOT, 'pids.txt'), `${pid}\n`);
}
const canListen = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
async function freePort() {
  for (let p = 6799; p >= 6700; p -= 1) {
    if (FORBIDDEN_PORTS.includes(p)) continue;
    if (await canListen(p)) return p;
  }
  throw new Error('6700–6799 没有空闲端口');
}
function writeShim(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'claude');
  fs.writeFileSync(shim, '#!/bin/sh\ncase "$1" in\n  --version|-v|version) echo "2.1.296 (Claude Code)"; exit 0;;\nesac\nexit 0\n');
  fs.chmodSync(shim, 0o755);
}

/** 后端进程已用的 CPU 秒数(ps -o time=,格式 分:秒.百分秒 或 时:分:秒.百分秒)。 */
export function cpuSeconds(pid) {
  const t = execFileSync('/bin/ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const parts = t.split(':').map(Number);
  if (!t || parts.some((x) => Number.isNaN(x))) throw new Error(`读不到 pid ${pid} 的 CPU 时间:「${t}」`);
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

/** 等后端启动满 12 秒、且 CPU 时间连续 2 秒不再增长;返回此时的 CPU 秒数。 */
export async function settleCpu(inst, { minUptimeMs = 12_000, stableMs = 2_000, capMs = 400_000 } = {}) {
  const rem = inst.t0 + minUptimeMs - Date.now();
  if (rem > 0) await sleep(rem);
  const start = Date.now();
  let last = cpuSeconds(inst.pid);
  let since = Date.now();
  for (;;) {
    await sleep(250);
    const c = cpuSeconds(inst.pid);
    if (c !== last) { last = c; since = Date.now(); } else if (Date.now() - since >= stableMs) return c;
    if (Date.now() - start > capMs) throw new Error(`后端 CPU 时间 ${capMs / 1000} 秒内一直没有稳定下来(看 ${inst.errLog})`);
  }
}

export async function startBackend(tag) {
  const root = path.join(RUN_ROOT, `${tag}-${Date.now().toString(36)}`);
  const home = path.join(root, 'home');
  const ctl = path.join(home, 'fake-claude');
  const tmp = path.join(root, 'tmp');
  const fakebin = path.join(root, 'fakebin');
  for (const d of [path.join(home, '.claude-gui'), path.join(home, '.claude', 'projects'), ctl, tmp, path.join(root, 'ws')]) fs.mkdirSync(d, { recursive: true });
  writeShim(fakebin);
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(home, '.claude-gui', 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }, null, 2));
  fs.writeFileSync(path.join(home, '.claude-gui', 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }, null, 2));

  const port = await freePort();
  const outLog = path.join(root, `server-${port}.out.log`);
  const errLog = path.join(root, `server-${port}.err.log`);
  const outFd = fs.openSync(outLog, 'a');
  const errFd = fs.openSync(errLog, 'a');
  // 干净环境:不继承宿主的任何 ANTHROPIC_*;不设 CGUI_ENABLE_LOCAL_ROUTES。
  const env = {
    PATH: `${fakebin}:${process.env.PATH}`, HOME: home, USERPROFILE: home,
    USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: '/bin/sh', LANG: 'en_US.UTF-8',
    TMPDIR: tmp, PORT: String(port), HOST: '127.0.0.1', CGUI_DISABLE_FILE_WATCHER: '1', CU_TEST_HOME: home,
  };
  const t0 = Date.now();
  const child = spawn(process.execPath, ['--import', pathToFileURL(PRELOAD).href, path.join(WORKTREE, 'server', 'index.js')], {
    cwd: root, env, stdio: ['ignore', outFd, errFd],
  });
  recordPid(child.pid);
  const exited = new Promise((r) => child.once('exit', r));
  const base = `http://127.0.0.1:${port}`;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`后端已退出,看 ${errLog}`);
    try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) }); if (r.ok) break; } catch { /* 还没起来 */ }
    if (Date.now() - t0 > 40_000) { child.kill('SIGKILL'); throw new Error(`后端 40 秒没起来,看 ${errLog}`); }
    await sleep(300);
  }
  const inst = { base, home, root, port, pid: child.pid, errLog, outLog, t0 };
  inst.makeWorkspace = (name) => {
    const dir = path.join(root, 'ws', name);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  };
  inst.stop = async () => {
    if (child.exitCode !== null) return;
    try { process.kill(child.pid, 'SIGTERM'); } catch { return; }
    const done = await Promise.race([exited.then(() => true), sleep(8_000).then(() => false)]);
    if (!done) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退 */ } await exited; }
  };
  await settleCpu(inst);   // 启动预热(10 秒后读一遍所有会话文件)跑完、CPU 稳定后才交给用例
  return inst;
}

/** GET /api/sessions/:sid/messages。返回 { status, body, text }。 */
export async function getHistory(inst, sid, projectHash, { limit, before } = {}) {
  const u = new URLSearchParams({ projectHash });
  if (limit !== undefined) u.set('limit', String(limit));
  if (before !== undefined) u.set('before', String(before));
  const r = await fetch(`${inst.base}/api/sessions/${encodeURIComponent(sid)}/messages?${u}`, { signal: AbortSignal.timeout(180_000) });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, text };
}

/** 发一次历史请求并量后端 CPU 时间(请求发出前 / 响应收完后各取一次 ps)。返回 { cpu, status, body, text }。 */
export async function measuredHistory(inst, sid, projectHash, opts) {
  const c0 = cpuSeconds(inst.pid);
  const r = await getHistory(inst, sid, projectHash, opts);
  const c1 = cpuSeconds(inst.pid);
  return { ...r, cpu: c1 - c0 };
}
/** 同一请求连做 n 次,返回 { min, all, last }(last = 最后一次的完整返回)。 */
export async function minCpuOf(n, inst, sid, projectHash, opts) {
  const all = []; let last = null;
  for (let i = 0; i < n; i += 1) {
    last = await measuredHistory(inst, sid, projectHash, opts);
    if (last.status !== 200) throw new Error(`历史接口应回 200,实际 ${last.status}:${last.text.slice(0, 200)}`);
    all.push(last.cpu);
    last = { status: last.status };
  }
  return { min: Math.min(...all), all };
}

/** 比较两次返回:深比较,只把 owner.sessionId 排除在外。返回第一处不同的路径描述或 null。 */
export function firstDiff(a, b, p = '') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${p || '(根)'}:${JSON.stringify(a)?.slice(0, 120)} ≠ ${JSON.stringify(b)?.slice(0, 120)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}:数组与对象不同`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${p}.length:${a.length} ≠ ${b.length}`;
    for (let i = 0; i < a.length; i += 1) { const d = firstDiff(a[i], b[i], `${p}[${i}]`); if (d) return d; }
    return null;
  }
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  if (ka.join('\u0001') !== kb.join('\u0001')) return `${p}:键不同 ${ka.join(',')} ≠ ${kb.join(',')}`;
  for (const k of ka) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  return null;
}
export function withoutOwnerSessionId(body) {
  const copy = { ...body };
  if (copy.owner && typeof copy.owner === 'object') { copy.owner = { ...copy.owner }; delete copy.owner.sessionId; }
  return copy;
}
/** 子代理用量:{ toolUseId → usage }(从 type 为 turn 的消息的 subUsage.agents[] 收集)。 */
export function subUsageMap(body) {
  const map = new Map();
  for (const m of (body && body.messages) || []) {
    if (!m || m.type !== 'turn' || !m.subUsage || !Array.isArray(m.subUsage.agents)) continue;
    for (const a of m.subUsage.agents) if (a && a.toolUseId) map.set(a.toolUseId, a.usage);
  }
  return map;
}
