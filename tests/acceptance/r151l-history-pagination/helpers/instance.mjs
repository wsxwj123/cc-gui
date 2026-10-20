// r151l:用例内自起的"一次性隔离实例"(自己的临时 HOME、自己的端口)。
// 照 r151b-xsession-p1/helpers/instance.mjs 的结构裁剪:历史分页只读接口,不需要假模型接口。
// 端口只在 6700–6999 里挑空闲的(从高往低,避开 run.sh 从低往高挑的那几个),硬拒 6677 / 6689 / 6710。
// 只按自己记下的 pid 收进程。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WORKTREE, dataRoot, fakebinDir, buildHome } from './fixtures.mjs';

const canListen = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

export async function freePort() {
  for (let p = 6999; p >= 6700; p -= 1) {
    if ([6677, 6689, 6710].includes(p)) continue;
    if (await canListen(p)) return p;
  }
  throw new Error('6700–6999 没有空闲端口');
}

async function launch(inst) {
  const port = await freePort();
  const log = fs.openSync(path.join(inst.root, `server-${port}.log`), 'a');
  const env = {
    PATH: `${fakebinDir()}:${process.env.PATH}`, HOME: inst.home, USERPROFILE: inst.home,
    USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: '/bin/sh', LANG: 'en_US.UTF-8',
    TMPDIR: inst.tmp, PORT: String(port), CGUI_FAKE_CLAUDE_DIR: inst.ctl, CGUI_DISABLE_FILE_WATCHER: '1',
  };
  const child = spawn(process.execPath, [path.join(WORKTREE, 'server', 'index.js')], { cwd: inst.root, env, stdio: ['ignore', log, log] });
  const exited = new Promise((r) => child.once('exit', r));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`一次性实例已退出,看 ${inst.root}/server-${port}.log`);
    try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) }); if (r.ok) break; } catch { /* 还没起来 */ }
    if (Date.now() - t0 > 40_000) { child.kill('SIGKILL'); throw new Error(`一次性实例 40 秒没起来,看 ${inst.root}/server-${port}.log`); }
    await new Promise((r) => setTimeout(r, 300));
  }
  Object.assign(inst, { port, base, pid: child.pid, child, exited });
}

/**
 * 起一个一次性实例。prefs 合进 prefs.json(起之前写好)。
 * 返回 { base, home, ctl, root, pid, stop(), restart() }。用完必须 stop()。
 */
export async function startInstance(tag, { prefs = {} } = {}) {
  const root = path.join(dataRoot(), 'inst', `${tag}-${Date.now().toString(36)}`);
  const home = path.join(root, 'home');
  const ctl = path.join(home, 'fake-claude');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  buildHome(home, ctl, prefs);
  const inst = { root, home, ctl, tmp };
  inst.stop = async () => {
    if (!inst.child || inst.child.exitCode !== null) return;
    try { process.kill(inst.pid, 'SIGTERM'); } catch { return; }
    const done = await Promise.race([inst.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 8_000))]);
    if (!done) { try { process.kill(inst.pid, 'SIGKILL'); } catch { /* 已退 */ } await inst.exited; }
  };
  inst.restart = async () => { await inst.stop(); await launch(inst); return inst; };
  await launch(inst);
  return inst;
}
