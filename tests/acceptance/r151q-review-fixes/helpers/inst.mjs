// r151q 一次性隔离实例(照 r151k helpers/p2.mjs):自己的临时 HOME / 假 CLI 控制目录 / 端口,环境从零给。
// 比 r151k 多:settings(起之前写 ~/.claude/settings.json)、claudeJson(~/.claude.json)、nodeBin / pathPrefix(用指定的 node 起、PATH 前缀)、requireShims。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKTREE, dataRoot, fakebinDir, buildHome } from '../../r151b-xsession-p1/helpers/fixtures.mjs';
import { client } from '../../r151b-xsession-p1/helpers/api.mjs';
import { freePort } from '../../r151b-xsession-p1/helpers/instance.mjs';

export async function startInstanceQ(tag, { prefs = {}, envExtra = {}, settings = null, claudeJson = null, nodeBin = null, pathPrefix = '', requireShims = [] } = {}) {
  const root = path.join(dataRoot(), 'inst', `${tag}-${Date.now().toString(36)}`);
  const home = path.join(root, 'home'); const ctl = path.join(home, 'fake-claude'); const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  buildHome(home, ctl, prefs);
  if (settings) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  if (claudeJson) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(claudeJson, null, 2));
  const inst = { root, home, ctl, tmp };
  const launch = async () => {
    const port = await freePort();
    const log = fs.openSync(path.join(root, `server-${port}.log`), 'a');
    const env = {
      PATH: `${pathPrefix ? `${pathPrefix}:` : ''}${fakebinDir()}:${process.env.PATH}`, HOME: home, USERPROFILE: home,
      USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TMPDIR: tmp,
      PORT: String(port), CGUI_FAKE_CLAUDE_DIR: ctl, CGUI_DISABLE_FILE_WATCHER: '1', ...envExtra,
    };
    const args = [...requireShims.flatMap((s) => ['--require', s]), path.join(WORKTREE, 'server', 'index.js')];
    const child = spawn(nodeBin || process.execPath, args, { cwd: root, env, stdio: ['ignore', log, log] });
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
