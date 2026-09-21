// r128 · "自己起/停隔离实例"的工具(照 r122 F 组 / r126 的写法)。
// 每条用例一个全新 HOME + 一个实例:用例之间不共享文件,顺序无关。
// 铁规:HOME 指到本套件 .artifacts 下;端口只在 6700–6999 里挑空闲的,硬拒 6677/6689/6710;
//       只按自己记录的 pid 收尾(pid 也落成文件,run.sh 的 cleanup 兜底);实例挂断外网预载;
//       剥离宿主的 ANTHROPIC_* 与代理变量。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { WORKTREE, noOutboundUrl, assertIsolated } from './fixtures.mjs';

const FORBIDDEN = new Set([6677, 6689, 6710]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STRIP = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

/** 回滚点相关的"宽松基线":条数 50、天数 30、总占用 100 MB、允许极小阈值、关掉启动清扫。用例只给差异项。 */
export const LENIENT = { CGUI_CHECKPOINT_SWEEP: '0', CGUI_CHECKPOINT_MAX_COUNT: '50', CGUI_CHECKPOINT_RETENTION_DAYS: '30', CGUI_CHECKPOINT_MAX_TOTAL_BYTES: '104857600', CGUI_ALLOW_TINY_CHECKPOINT_RETENTION: '1' };

/** 在 6700–6999 里挑一个当前能绑上的端口(跳过硬拒的三个)。 */
export function freePort(start = 6900) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > 6999) { reject(new Error('6700–6999 没有空闲端口')); return; }
      if (FORBIDDEN.has(p)) { tryPort(p + 1); return; }
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

const started = [];

/**
 * 起一个隔离实例。返回 { pid, port, base, home, root, logPath, spawnedAt, healthyAt, log(), blocked(), stop() }。
 * env 只给"差异项",其余(HOME/PORT/断外网/剥离宿主变量)这里统一处理。
 */
export async function startInstance({ root, home }, env = {}, { label = 'instance', healthTimeoutMs = 40_000 } = {}) {
  assertIsolated(home);
  const port = await freePort();
  const logPath = path.join(root, `${label}.log`);
  const blockedLog = path.join(root, `${label}.blocked.log`);
  const fd = fs.openSync(logPath, 'a');
  const childEnv = {
    ...process.env, ...env,
    HOME: home, USERPROFILE: home, PORT: String(port), CGUI_DISABLE_FILE_WATCHER: '1',
    NODE_OPTIONS: `--import=${noOutboundUrl()}`, R128_BLOCKED_LOG: blockedLog,
  };
  for (const k of STRIP) delete childEnv[k];
  const child = spawn(process.execPath, [path.join(WORKTREE, 'server', 'index.js')], { cwd: root, env: childEnv, stdio: ['ignore', fd, fd] });
  const spawnedAt = Date.now();
  fs.writeFileSync(path.join(root, `instance-${child.pid}.pid`), String(child.pid));   // run.sh cleanup 的兜底线索
  let exited = false;
  child.on('exit', () => { exited = true; fs.closeSync(fd); try { fs.unlinkSync(path.join(root, `instance-${child.pid}.pid`)); } catch { /* 忽略 */ } });
  const base = `http://127.0.0.1:${port}`;
  const handle = {
    pid: child.pid, port, base, home, root, logPath, blockedLog, spawnedAt, healthyAt: null,
    log: () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } },
    blocked: () => { try { return fs.readFileSync(blockedLog, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')[1]); } catch { return []; } },
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 30 && !exited; i += 1) await sleep(100);
      if (!exited) { child.kill('SIGKILL'); for (let i = 0; i < 20 && !exited; i += 1) await sleep(100); }
    },
  };
  started.push(handle);
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`实例 ${label} 起来就退出了:看 ${logPath}`);
    try { const r = await fetch(`${base}/api/health`); if (r.ok) { handle.healthyAt = Date.now(); return handle; } } catch { /* 还没起来 */ }
    await sleep(100);
  }
  throw new Error(`实例 ${label}(pid ${child.pid},端口 ${port})${healthTimeoutMs}ms 内没就绪:看 ${logPath}`);
}

/** 停掉本进程起过的所有实例(afterEach 兜底)。 */
export async function stopAll() {
  while (started.length) await started.pop().stop();
}

/** 对某个基址直调接口,并记下耗时(ms,performance.now 精度)。 */
export async function req(base, method, url, body) {
  const t0 = performance.now();
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

// ─── 回滚点接口(INTERFACE "既有接口与位置") ───
export const snap = (base, s, cwd, label) => req(base, 'POST', '/api/checkpoints', label === undefined ? { sessionId: s, cwd } : { sessionId: s, cwd, label });
export const listOf = async (base, s) => (await req(base, 'GET', `/api/checkpoints/${s}`)).json?.entries ?? null;
export const statsOf = async (base, s) => ((await req(base, 'GET', '/api/checkpoints-stats')).json?.sessions ?? []).find((x) => x.sessionId === s) ?? null;
export const delOne = (base, s, sha) => req(base, 'DELETE', `/api/checkpoints/${s}/${sha}`);
export const delSession = (base, s) => req(base, 'DELETE', `/api/checkpoints/${s}`);
export const resolveLatest = (base, s) => req(base, 'GET', `/api/checkpoints/${s}/resolve`);
export const restore = (base, s, sha, cwd) => req(base, 'POST', `/api/checkpoints/${s}/restore`, { sha, cwd });

/** 造 n 条快照(每次改一下小文件,和用户回滚了几次等价);失败抛错(前提不成立)。返回 sha 列表(按创建顺序)。 */
export async function seed(base, ws, s, n, tag = 'seed') {
  const { touchNote } = await import('./fixtures.mjs');
  const shas = [];
  for (let i = 0; i < n; i += 1) {
    touchNote(ws, `${tag} ${s.slice(0, 8)} #${i}`);
    const r = await snap(base, s, ws);
    if (r.status !== 200 || !r.json?.sha) throw new Error(`前提失败:第 ${i + 1} 张快照 HTTP ${r.status} ${r.text.slice(0, 200)}`);
    shas.push(r.json.sha);
  }
  return shas;
}
