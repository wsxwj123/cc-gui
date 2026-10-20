// r151k 本套件专用的一次性实例(从 r151h helpers/p2.mjs 复制并裁掉时钟 / 阈值垫片参数)。
// 起法与 r151b/r151h 完全相同:自己的临时 HOME、自己的假 CLI 控制目录、自己的端口,环境从零给;
// prefs 在起之前写进临时 HOME(prefs.json),envExtra 只给这个服务进程追加环境变量
// (K3 用 CGUI_KEEPALIVE_IDLE_MS=1500 把空闲回收窗口缩到测试可等的大小;K1/K2 用 CGUI_STALL_MS=1500)。
// 端口只在 6700–6999 里挑空闲的,硬拒 6677 / 6689 / 6710;只按自己记下的 pid 收进程。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKTREE, dataRoot, fakebinDir, buildHome } from '../../r151b-xsession-p1/helpers/fixtures.mjs';
import { client } from '../../r151b-xsession-p1/helpers/api.mjs';
import { freePort } from '../../r151b-xsession-p1/helpers/instance.mjs';

/**
 * 起一个一次性实例。prefs:合进 prefs.json 的手写偏好(起之前写好);envExtra:只给服务进程的额外环境变量。
 * 返回 { root, home, ctl, tmp, base, c(HTTP 客户端), pid, child, exited, stop(), restart() }。用完必须 stop()。
 */
export async function startInstanceP2(tag, { prefs = {}, envExtra = {} } = {}) {
  const root = path.join(dataRoot(), 'inst', `${tag}-${Date.now().toString(36)}`);
  const home = path.join(root, 'home');
  const ctl = path.join(home, 'fake-claude');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  buildHome(home, ctl, prefs);
  const inst = { root, home, ctl, tmp };
  const launch = async () => {
    const port = await freePort();
    const log = fs.openSync(path.join(root, `server-${port}.log`), 'a');
    const env = {
      PATH: `${fakebinDir()}:${process.env.PATH}`, HOME: home, USERPROFILE: home,
      USER: os.userInfo().username, LOGNAME: os.userInfo().username,
      SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TMPDIR: tmp, PORT: String(port),
      CGUI_FAKE_CLAUDE_DIR: ctl, CGUI_DISABLE_FILE_WATCHER: '1',
      ...envExtra,
    };
    const child = spawn(process.execPath, [path.join(WORKTREE, 'server', 'index.js')], { cwd: root, env, stdio: ['ignore', log, log] });
    // run.sh 的兜底收尾只看这份记录(自己实例的 pid),不按端口 / 名字批量杀。
    try { fs.appendFileSync(path.join(dataRoot(), 'instance-pids.txt'), `${child.pid}\n`); } catch { /* 忽略 */ }
    const exited = new Promise((r) => child.once('exit', r));
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`一次性实例已退出,看 ${root}/server-${port}.log`);
      try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) }); if (r.ok) break; } catch { /* 还没起来 */ }
      if (Date.now() - t0 > 40_000) { child.kill('SIGKILL'); throw new Error(`一次性实例 40 秒没起来,看 ${root}/server-${port}.log`); }
      await new Promise((r) => setTimeout(r, 300));
    }
    Object.assign(inst, { port, base, pid: child.pid, child, exited, c: client(base) });
  };
  inst.stop = async () => {
    if (!inst.child || inst.child.exitCode !== null) return;
    try { process.kill(inst.pid, 'SIGTERM'); } catch { return; }
    const done = await Promise.race([inst.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 8_000))]);
    if (!done) { try { process.kill(inst.pid, 'SIGKILL'); } catch { /* 已退 */ } await inst.exited; }
  };
  inst.restart = async () => { await inst.stop(); await launch(); return inst; };
  await launch();
  return inst;
}
