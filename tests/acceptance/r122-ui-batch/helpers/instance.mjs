// r122 · F 组用的"自己起隔离实例"工具:回滚点启动清扫发生在**服务启动后**,所以用例得自己起/停实例
// (先用宽松上限的实例造回滚点,停掉,改 meta.json 修改时间,再用严上限 + 短延迟的实例观察)。
// 铁规:HOME 指到本套件 .artifacts 下;端口只在 6700–6999 里挑空闲的,硬拒 6677/6689/6710;
//       只按自己记录的 pid 收尾(pid 也落成文件,run.sh 的 cleanup 兜底);PATH 上挂本套件的假 claude。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { WORKTREE, suitePath, dataRoot } from './fixtures.mjs';

const FORBIDDEN = new Set([6677, 6689, 6710]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在 6700–6999 里挑一个当前能绑上的端口(跳过硬拒的三个)。 */
export function freePort(start = 6730) {
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

/** F 组每条用例自己的数据根:<R122_DATA_ROOT>/f/<slug>/ */
export function fHome(slug) {
  const root = path.join(dataRoot(), 'f', slug);
  const home = path.join(root, 'home');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.claude-gui'), { recursive: true });
  // 钉成回环免密(公开版会自愈成 0.0.0.0+随机密码,会写盘)
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  const ws = path.join(home, 'work', 'ws');          // 回滚点只认 $HOME 之下的目录(探路实测:外面报 path outside $HOME)
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'note.txt'), 'r122 sweep fixture\n');
  return { root, home, ws };
}

/** 回滚点目录(INTERFACE F2)。 */
export const checkpointDir = (home, sid) => path.join(home, '.claude', 'gui', 'checkpoints', sid);
export const metaPath = (home, sid) => path.join(checkpointDir(home, sid), 'meta.json');

const started = [];

/**
 * 起一个隔离实例。env 只给"差异项",其余(HOME/PORT/假 claude/剥离宿主 ANTHROPIC_*)这里统一处理。
 * 返回 { pid, port, base, logPath, spawnedAt, healthyAt, stop() }。
 */
export async function startInstance({ root, home }, env = {}, { label = 'instance', healthTimeoutMs = 40_000 } = {}) {
  const port = await freePort();
  const logPath = path.join(root, `${label}.log`);
  const fd = fs.openSync(logPath, 'a');
  const childEnv = { ...process.env, ...env, HOME: home, USERPROFILE: home, PORT: String(port),
    PATH: `${suitePath('.artifacts', 'fakebin')}:${process.env.PATH || ''}`,
    CGUI_FAKE_CLAUDE_DIR: path.join(home, 'fake-claude'), CGUI_DISABLE_FILE_WATCHER: '1' };
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete childEnv[k];
  const child = spawn(process.execPath, [path.join(WORKTREE, 'server', 'index.js')], { cwd: root, env: childEnv, stdio: ['ignore', fd, fd] });
  const spawnedAt = Date.now();
  fs.writeFileSync(path.join(root, `instance-${child.pid}.pid`), String(child.pid));   // run.sh cleanup 的兜底线索
  let exited = false;
  child.on('exit', () => { exited = true; fs.closeSync(fd); try { fs.unlinkSync(path.join(root, `instance-${child.pid}.pid`)); } catch { /* 忽略 */ } });
  const base = `http://127.0.0.1:${port}`;
  const handle = {
    pid: child.pid, port, base, logPath, spawnedAt, healthyAt: null,
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
    try { const r = await fetch(`${base}/api/health`); if (r.ok) { handle.healthyAt = Date.now(); return handle; } } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`实例 ${label}(pid ${child.pid},端口 ${port})${healthTimeoutMs}ms 内没就绪:看 ${logPath}`);
}

/** 停掉本进程起过的所有实例(afterEach 兜底)。 */
export async function stopAll() {
  while (started.length) await started.pop().stop();
}

/** 对某个实例直调接口,并记下耗时。 */
export async function req(base, method, url, body) {
  const t0 = Date.now();
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json, ms: Date.now() - t0 };
}

export const listOf = async (base, sid) => (await req(base, 'GET', `/api/checkpoints/${sid}`)).json?.entries ?? null;
export const statsOf = async (base, sid) => ((await req(base, 'GET', '/api/checkpoints-stats')).json?.sessions ?? []).find((s) => s.sessionId === sid) ?? null;
