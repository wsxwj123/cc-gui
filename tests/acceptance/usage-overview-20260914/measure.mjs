// 实测「用量总览」冷启动耗时与并发放大。只读真实 ~/.claude/projects(软链进隔离
// HOME),不碰用户的 6677 / 6689,不写用户的 ~/.claude-gui。
//
//   node tests/acceptance/usage-overview-20260914/measure.mjs
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, '..', '..', '..');
const realProjects = path.join(os.homedir(), '.claude', 'projects');

function pickPort() {
  for (let p = 6700; p < 6800; p++) {
    if (p === 6677 || p === 6689) continue;
    try { const s = net.createServer().listen(p, '127.0.0.1'); s.close(); return p; } catch {}
  }
  throw new Error('no free port 6700-6799');
}

const port = Number(process.env.USAGE_PORT || 0) || pickPort();
if ([6677, 6689].includes(port)) throw new Error(`拒绝用户端口 ${port}`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgui-usage-'));
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.symlinkSync(realProjects, path.join(home, '.claude', 'projects'), 'dir');

const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(port), CGUI_DISABLE_FILE_WATCHER: '1' };
for (const k of Object.keys(env)) if (k.startsWith('ANTHROPIC_')) delete env[k];

const log = fs.openSync(path.join(home, 'server.log'), 'a');
const proc = spawn(process.execPath, [path.join(worktree, 'server', 'index.js')], {
  cwd: worktree, env, stdio: ['ignore', log, log],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function healthy() {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); return r.ok; } catch { return false; }
}
const t0 = Date.now();
while (Date.now() - t0 < 20000) { if (await healthy()) break; await sleep(200); }
console.log(`[boot] 实例起来了 pid=${proc.pid} port=${port} home=${home} bootMs=${Date.now() - t0}`);

const timed = async (label, n = 1) => {
  const ts = Date.now();
  const rs = await Promise.all(Array.from({ length: n }, () => fetch(`http://127.0.0.1:${port}/api/usage`)));
  const bodies = await Promise.all(rs.map((r) => r.json()));
  const ms = Date.now() - ts;
  console.log(`[measure] ${label}: ${n} 并发 → ${ms}ms (合计字节 ${bodies.reduce((s, b) => s + JSON.stringify(b).length, 0)})`);
  return ms;
};

// A:健康检查刚过就请求 —— 预热还没触发(setTimeout 10s)
console.log(`[t=+${Date.now() - t0}ms] A 档:冷态单发`);
await timed('A 冷态单发', 1);

// B:再等预热窗口,然后两个并发 —— 看是否各扫一遍
const sinceBoot = Date.now() - t0;
if (sinceBoot < 11000) await sleep(11000 - sinceBoot);
console.log(`[t=+${Date.now() - t0}ms] B 档:并发两发(预热已在跑)`);
await timed('B 并发两发', 2);
console.log(`[t=+${Date.now() - t0}ms] C 档:并发四发`);
await timed('C 并发四发', 4);

try { process.kill(proc.pid, 'SIGTERM'); } catch {}
await sleep(300);
try { process.kill(proc.pid, 'SIGKILL'); } catch {}
console.log(`[done] 日志 ${path.join(home, 'server.log')}`);
