// r151u 一次性隔离实例:自己的临时 HOME / 假命令行控制目录 / 端口,环境从零给(不继承本机 ANTHROPIC_* / CGUI_*)。
// 只走 HTTP / SSE / WebSocket / 文件 / 外部进程记录,不 import 产品代码。
// 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710 / 8000 / 8788 / 8789 / 8798 / 8799;只按自己记下的 pid 收进程(且先核对命令行)。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SUITE = path.resolve(here, '..');
export const WORKTREE = path.resolve(SUITE, '..', '..', '..');
export const FX_CLI = path.join(here, 'fx-cli.mjs');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const dataRoot = () => process.env.R151U_DATA_ROOT || path.join(SUITE, '.artifacts', 'runtime-data');
export const fakebinDir = () => path.join(dataRoot(), 'fakebin');

function ensureShim() {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  fs.mkdirSync(fakebinDir(), { recursive: true });
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\n# r151u claude 垫片:一律交给本套件的假命令行(没有真 CLI 车道)。\nunset NODE_OPTIONS\nexec ${q(process.execPath)} ${q(FX_CLI)} "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

const BAD_PORTS = new Set([6677, 6689, 6710, 8000, 8788, 8789, 8798, 8799]);
const canListen = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
export async function freePort() {
  for (let p = 6999; p >= 6700; p -= 1) {
    if (BAD_PORTS.has(p)) continue;
    if (await canListen(p)) return p;
  }
  throw new Error('6700–6999 没有空闲端口');
}

/** pid 的命令行(进程不在就返回空串)。 */
export function commandOf(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; }
}
export const isAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
/** 只在 pid 的命令行含 needle(确是本套件起的进程)时才发信号,防 pid 复用误伤。 */
export function killIfOurs(pid, needle, sig = 'SIGTERM') {
  if (!pid || !commandOf(pid).includes(needle)) return false;
  try { process.kill(Number(pid), sig); return true; } catch { return false; }
}

const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

function buildHome(home, ctl) {
  for (const d of [path.join(home, '.claude-gui'), path.join(home, '.claude', 'projects'), ctl, path.join(ctl, 'scripts')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-gui', 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }, null, 2));
}

/**
 * 起一个一次性实例。envExtra 只给这个服务进程追加环境变量(例 CGUI_STALL_MS)。
 * 返回 { root, home, ctl, port, base, pid, stop(), emits(sid), stdinLines(sid), fakePids(sid), writeScript(name, def), release(name) };用完必须 stop()。
 */
export async function startInstance(tag, { envExtra = {} } = {}) {
  ensureShim();
  const root = path.join(dataRoot(), 'inst', `${tag}-${Date.now().toString(36)}`);
  const home = path.join(root, 'home'); const ctl = path.join(home, 'fake-cli'); const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  buildHome(home, ctl);
  const port = await freePort();
  const logFile = path.join(root, `server-${port}.log`);
  const fd = fs.openSync(logFile, 'a');
  const env = {
    PATH: `${fakebinDir()}:${process.env.PATH}`, HOME: home, USERPROFILE: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username,
    SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TMPDIR: tmp, PORT: String(port), CGUI_FAKE_CLAUDE_DIR: ctl, CGUI_DISABLE_FILE_WATCHER: '1', ...envExtra,
  };
  const child = spawn(process.execPath, [path.join(WORKTREE, 'server', 'index.js')], { cwd: root, env, stdio: ['ignore', fd, fd] });
  try { fs.appendFileSync(path.join(dataRoot(), 'instance-pids.txt'), `${child.pid}\n`); } catch { /* 忽略 */ }
  const exited = new Promise((r) => child.once('exit', r));
  const base = `http://127.0.0.1:${port}`;
  const inst = { root, home, ctl, port, base, pid: child.pid, logFile };
  const rec = (name, sid) => jsonl(path.join(ctl, name)).filter((x) => !sid || x.sid === sid);
  inst.emits = (sid) => rec('emit.jsonl', sid);
  inst.stdinLines = (sid) => rec('stdin.jsonl', sid);
  inst.fakePids = (sid) => [...new Set(rec('spawn.jsonl', sid).filter((x) => x.interactive).map((x) => x.pid))];
  inst.writeScript = (name, def) => fs.writeFileSync(path.join(ctl, 'scripts', `${name}.json`), JSON.stringify(def));
  inst.release = (name) => fs.writeFileSync(path.join(ctl, name), String(Date.now()));
  inst.stop = async () => {
    for (const x of rec('spawn.jsonl')) killIfOurs(x.pid, 'fx-cli.mjs');
    if (child.exitCode === null) {
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* 已退 */ }
      const done = await Promise.race([exited.then(() => true), sleep(8_000).then(() => false)]);
      if (!done) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退 */ } await exited; }
    }
    for (const x of rec('spawn.jsonl')) killIfOurs(x.pid, 'fx-cli.mjs', 'SIGKILL');
  };
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`一次性实例已退出,看 ${logFile}`);
    try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) }); if (r.ok) break; } catch { /* 还没起来 */ }
    if (Date.now() - t0 > 40_000) { await inst.stop(); throw new Error(`一次性实例 40 秒没起来,看 ${logFile}`); }
    await sleep(300);
  }
  return inst;
}

/** 在实例的临时 HOME 里落一个已有记录的会话(工作目录在实例自己的 ws/ 下)。返回 { sid, cwd }。 */
export function seedSession(inst, name) {
  const sid = crypto.randomUUID();
  const wsDir = path.join(inst.root, 'ws', name);
  fs.mkdirSync(wsDir, { recursive: true });
  const cwd = fs.realpathSync(wsDir);
  const proj = path.join(inst.home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.296', gitBranch: '' };
  const lines = [
    { type: 'summary', summary: `R151U ${name}`, leafUuid: `${sid}-a1` },
    { ...base, type: 'user', uuid: `${sid}-u0`, parentUuid: null, timestamp: '2026-10-01T08:00:00.000Z', message: { role: 'user', content: `R151U ${name}` } },
    { ...base, type: 'assistant', uuid: `${sid}-a1`, parentUuid: `${sid}-u0`, timestamp: '2026-10-01T08:00:01.000Z', requestId: `req_${sid.slice(0, 8)}`,
      message: { id: `msg_${sid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'r151u-chat', content: [{ type: 'text', text: '这是已有的旧回复。' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { sid, cwd };
}
