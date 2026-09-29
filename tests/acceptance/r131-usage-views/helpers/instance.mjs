// r131 · 隔离实例的起/停 + /api/usage 直调 + WS 抓广播(照 r128 helpers/instance.mjs 的写法)。
// 铁规:HOME 指到本套件 .artifacts 下;端口只在 6700–6999 里挑空闲的,硬拒 6677/6689/6710;
//       只按自己记录的 pid 收尾(pid 落成文件,run.sh 的 cleanup 兜底);实例挂断外网预载;剥离宿主 ANTHROPIC_* 与代理变量;
//       实例进程注入 TZ=Asia/Shanghai(INTERFACE §0)。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { WORKTREE, TZ, noOutboundUrl, assertIsolated } from './fixtures.mjs';

const FORBIDDEN = new Set([6677, 6689, 6710]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STRIP = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

export function freePort(start = 6800) {
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

/** 起一个隔离实例。env 只给差异项。返回 { pid, port, base, home, root, logPath, log(), stop() }。 */
export async function startInstance({ root, home }, env = {}, { label = 'instance', healthTimeoutMs = 40_000 } = {}) {
  assertIsolated(home);
  const port = await freePort();
  const logPath = path.join(root, `${label}.log`);
  const fd = fs.openSync(logPath, 'a');
  const childEnv = {
    ...process.env, ...env,
    HOME: home, USERPROFILE: home, PORT: String(port), TZ, CGUI_DISABLE_FILE_WATCHER: '1',
    NODE_OPTIONS: `--import=${noOutboundUrl()}`, R128_BLOCKED_LOG: path.join(root, `${label}.blocked.log`),
  };
  for (const k of STRIP) delete childEnv[k];
  const child = spawn(process.execPath, [path.join(WORKTREE, 'server', 'index.js')], { cwd: root, env: childEnv, stdio: ['ignore', fd, fd] });
  fs.writeFileSync(path.join(root, `instance-${child.pid}.pid`), String(child.pid));
  let exited = false;
  child.on('exit', () => { exited = true; fs.closeSync(fd); try { fs.unlinkSync(path.join(root, `instance-${child.pid}.pid`)); } catch { /* 忽略 */ } });
  const base = `http://127.0.0.1:${port}`;
  const handle = {
    pid: child.pid, port, base, home, root, logPath,
    log: () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } },
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
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return handle; } catch { /* 还没起来 */ }
    await sleep(100);
  }
  throw new Error(`实例 ${label}(pid ${child.pid},端口 ${port})${healthTimeoutMs}ms 内没就绪:看 ${logPath}`);
}

/** 停掉本进程起过的所有实例(afterEach 兜底)。 */
export async function stopAll() { while (started.length) await started.pop().stop(); }

/** GET /api/usage(或任意路径),返回 { status, text, json, ms }。 */
export async function req(base, url = '/api/usage', { method = 'GET', body } = {}) {
  const t0 = performance.now();
  const res = await fetch(base + url, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json, ms: Math.round((performance.now() - t0) * 10) / 10 };
}
export const getUsage = (base) => req(base, '/api/usage');

/** 轮询直到 fn 返回真值(返回该值);超时返回 undefined(不抛,由用例自己断言)。 */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}
/** 连续采样 /api/usage:每 intervalMs 一次,持续 durationMs;返回 [{ t(相对起点 ms), status, body }]。 */
export async function sampleUsage(base, { durationMs, intervalMs = 100 }) {
  const t0 = Date.now(); const out = [];
  while (Date.now() - t0 < durationMs) {
    const r = await getUsage(base);
    out.push({ t: Date.now() - t0, status: r.status, body: r.json });
    await sleep(intervalMs);
  }
  return out;
}

/** 抓 WS 广播:返回 { messages, ofType(type), close() }。连上后再返回(300 ms 内连不上也返回,用例自行判断)。 */
export async function wsCapture(port) {
  const messages = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('message', (buf) => { try { messages.push(JSON.parse(String(buf))); } catch { /* 非 JSON 帧忽略 */ } });
  ws.on('error', () => { /* 由用例判断 */ });
  await new Promise((resolve) => { ws.once('open', resolve); setTimeout(resolve, 3000); });
  return { messages, ofType: (t) => messages.filter((m) => m?.type === t), close: () => { try { ws.close(); } catch { /* 已关 */ } } };
}

/** 读磁盘缓存文件(解析失败返回 { raw, json:null });不存在返回 null。 */
export function readCacheFile(file) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let json = null; try { json = JSON.parse(raw); } catch { /* 半截 */ }
  return { raw, json };
}
