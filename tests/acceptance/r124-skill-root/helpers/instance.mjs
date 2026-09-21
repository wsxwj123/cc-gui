// r124 · 接口层用例"自己起/停隔离实例"的工具(照 r122 F 组的写法)。
// 每条接口用例一个全新 HOME + 一个实例:用例之间不共享技能目录与来源记录,顺序无关。
// 铁规:HOME 指到本套件 .artifacts 下;端口只在 6700–6999 里挑空闲的,硬拒 6677/6689/6710;
//       只按自己记录的 pid 收尾(pid 也落成文件,run.sh 的 cleanup 兜底);实例挂断外网预载;
//       剥离宿主的 ANTHROPIC_* 与代理变量;技能仓库请求经 CGUI_GITHUB_*_BASE 指向假 GitHub。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { WORKTREE, dataRoot, buildHome, noOutboundUrl, fakeApiBase, fakeRawBase } from './fixtures.mjs';

const FORBIDDEN = new Set([6677, 6689, 6710]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STRIP = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

/** 在 6700–6999 里挑一个当前能绑上的端口(跳过硬拒的三个)。 */
export function freePort(start = 6740) {
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

/** 每条接口用例自己的数据根:<R124_DATA_ROOT>/api/<slug>/{home,*.log,*.pid} */
export function caseRoot(slug) {
  const root = path.join(dataRoot(), 'api', slug);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const home = buildHome(path.join(root, 'home'));
  return { root, home };
}

const started = [];

/**
 * 起一个隔离实例。返回 { pid, port, base, home, root, logPath, blockedLog, log(), blocked(), stop() }。
 * env 只给"差异项",其余(HOME/PORT/假 GitHub/断外网/剥离宿主变量)这里统一处理。
 */
export async function startInstance({ root, home }, env = {}, { label = 'instance', healthTimeoutMs = 40_000 } = {}) {
  if (!fakeApiBase() || !fakeRawBase()) throw new Error('R124_FAKE_API_BASE / R124_FAKE_RAW_BASE 未设置(run.sh 负责起假 GitHub)');
  const port = await freePort();
  const logPath = path.join(root, `${label}.log`);
  const blockedLog = path.join(root, `${label}.blocked.log`);
  const fd = fs.openSync(logPath, 'a');
  const childEnv = {
    ...process.env, ...env,
    HOME: home, USERPROFILE: home, PORT: String(port), CGUI_DISABLE_FILE_WATCHER: '1',
    CGUI_GITHUB_API_BASE: fakeApiBase(), CGUI_GITHUB_RAW_BASE: fakeRawBase(),
    NODE_OPTIONS: `--import=${noOutboundUrl()}`, R124_BLOCKED_LOG: blockedLog,
  };
  for (const k of STRIP) delete childEnv[k];
  const child = spawn(process.execPath, [path.join(WORKTREE, 'server', 'index.js')], { cwd: root, env: childEnv, stdio: ['ignore', fd, fd] });
  fs.writeFileSync(path.join(root, `instance-${child.pid}.pid`), String(child.pid));   // run.sh cleanup 的兜底线索
  let exited = false;
  child.on('exit', () => { exited = true; fs.closeSync(fd); try { fs.unlinkSync(path.join(root, `instance-${child.pid}.pid`)); } catch { /* 忽略 */ } });
  const base = `http://127.0.0.1:${port}`;
  const handle = {
    pid: child.pid, port, base, home, root, logPath, blockedLog,
    log: () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } },
    /** 被断外网预载拒掉的目标(host:port 列表)。 */
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
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return handle; } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`实例 ${label}(pid ${child.pid},端口 ${port})${healthTimeoutMs}ms 内没就绪:看 ${logPath}`);
}

/** 停掉本进程起过的所有实例(afterEach 兜底)。 */
export async function stopAll() {
  while (started.length) await started.pop().stop();
}

/** 对某个基址直调接口。 */
export async function req(base, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json };
}

/** 假 GitHub 的控制口。 */
export const fake = {
  requests: async () => (await req(fakeApiBase(), 'GET', '/__control/requests')).json?.requests ?? [],
  resetRequests: () => req(fakeApiBase(), 'POST', '/__control/requests', {}),
  setRootSha: (repo, sha) => req(fakeApiBase(), 'POST', '/__control/root-sha', { repo, sha }),
};
