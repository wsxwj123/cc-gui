// r151s 本套件辅助(只走 HTTP / SSE / 文件 / 外部进程记录,不 import 产品代码)。
// 复用 r151b 的临时 HOME 常量 / 假 CLI 记录读取 / 端口探测;这里只放本轮要用的:
//   临时 HOME(偏好文件可缺失 / 原始字节 / 对象三种写法)、一次性实例(标准输出与标准错误分开落盘、可挂时长垫片)、
//   SSE 收集(带每条事件的到达时刻)、进程列表、"起过子代理后静默"的场景、偏好文件字节读取。
// 端口只在 6700–6999 里挑空闲的(freePort 硬拒 6677 / 6689 / 6710);只按自己记下的 pid 收进程。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { WORKTREE, dataRoot, fakebinDir, guiDir, claudeDir, prefsPath, uniq, seedSession } from '../../r151b-xsession-p1/helpers/fixtures.mjs';
import { client, waitFor, turnRecords, writeScript, touchCtl } from '../../r151b-xsession-p1/helpers/api.mjs';
import { freePort } from '../../r151b-xsession-p1/helpers/instance.mjs';
import { buildHomeS, writeShimS } from './home.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHIM = path.join(here, 'stall-dur-shim.cjs');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { uniq, waitFor, prefsPath, guiDir };

/** 接口文件第 5 条:两种 stall_notice 文字末尾都有这一句(逐字)。 */
export const SENTENCE = '时长可在 设置 → 会话 → 静默超时 中修改。';
/** 远长于任何测试等待的时长(50 分钟,小于 setTimeout 的 2^31-1 上限):用来把"不该被选中的那一档"垫成永远等不到。 */
export const FAR_MS = 3_000_000;

// ---------------- 临时 HOME(定义在 home.mjs,这里再导出给用例用) ----------------
export { buildHomeS, writeShimS };

export const prefsBytes = (home) => fs.readFileSync(prefsPath(home));
export const prefsText = (home) => prefsBytes(home).toString('utf8');
/** 偏好文件解析成 JSON(去掉 BOM);读不了 / 解析不了返回 null。 */
export function prefsJson(home) { try { return JSON.parse(prefsText(home).replace(/^\uFEFF/, '')); } catch { return null; } }
/** 文件里含 needle 的行数(文件不存在 = 0)。 */
export function countLines(file, needle) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes(needle)).length; } catch { return 0; }
}
export const tailOf = (file, n = 20) => { try { return fs.readFileSync(file, 'utf8').split('\n').slice(-n).join('\n'); } catch { return '(读不到)'; } };

// ---------------- 一次性实例 ----------------
/**
 * 起一个一次性实例(自己的临时 HOME / 假 CLI 控制目录 / 端口,环境从零给,不继承本机 CGUI_* / ANTHROPIC_*)。
 *   prefs     见 buildHomeS;
 *   envExtra  只给这个服务进程追加的环境变量(例 CGUI_STALL_MS);
 *   timerMap  给了就 --require stall-dur-shim.cjs 并把映射表经 R151S_TIMER_MAP 传进去,例 { 300000: 2500, 600000: FAR_MS }。
 * 标准输出 → inst.outFile,标准错误 → inst.errFile(S06 要单看标准错误)。
 * 返回 { root, home, ctl, tmp, port, base, pid, c(HTTP 客户端), outFile, errFile, stop() };用完必须 stop()。
 */
export async function startInstanceS(tag, { prefs, envExtra = {}, timerMap = null } = {}) {
  const root = path.join(dataRoot(), 'inst', `${tag}-${Date.now().toString(36)}`);
  const home = path.join(root, 'home'); const ctl = path.join(home, 'fake-claude'); const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  buildHomeS(home, ctl, prefs);
  const port = await freePort();
  const outFile = path.join(root, `server-${port}.out.log`);
  const errFile = path.join(root, `server-${port}.err.log`);
  const outFd = fs.openSync(outFile, 'a'); const errFd = fs.openSync(errFile, 'a');
  const env = {
    PATH: `${fakebinDir()}:${process.env.PATH}`, HOME: home, USERPROFILE: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username,
    SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TMPDIR: tmp, PORT: String(port), CGUI_FAKE_CLAUDE_DIR: ctl, CGUI_DISABLE_FILE_WATCHER: '1',
    ...(timerMap ? { R151S_TIMER_MAP: JSON.stringify(timerMap) } : {}),
    ...envExtra,
  };
  const args = [...(timerMap ? ['--require', SHIM] : []), path.join(WORKTREE, 'server', 'index.js')];
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', outFd, errFd] });
  try { fs.appendFileSync(path.join(dataRoot(), 'instance-pids.txt'), `${child.pid}\n`); } catch { /* 忽略 */ }
  const exited = new Promise((r) => child.once('exit', r));
  const base = `http://127.0.0.1:${port}`;
  const inst = { root, home, ctl, tmp, port, base, pid: child.pid, child, exited, outFile, errFile, c: client(base) };
  inst.stop = async () => {
    if (child.exitCode !== null) return;
    try { process.kill(inst.pid, 'SIGTERM'); } catch { return; }
    const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 8_000))]);
    if (!done) { try { process.kill(inst.pid, 'SIGKILL'); } catch { /* 已退 */ } await exited; }
  };
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`一次性实例已退出,看 ${errFile}:\n${tailOf(errFile)}`);
    try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) }); if (r.ok) break; } catch { /* 还没起来 */ }
    if (Date.now() - t0 > 40_000) { await inst.stop(); throw new Error(`一次性实例 40 秒没起来,看 ${errFile}:\n${tailOf(errFile)}`); }
    await sleep(300);
  }
  return inst;
}

// ---------------- 偏好接口 ----------------
export const STALL_PATH = '/api/prefs/stall-timeout';
export const IDLE_PATH = '/api/prefs/keep-alive-idle';

// ---------------- SSE:实时收集一个 chat 的事件(带到达时刻) ----------------
export function streamT(base, pid) {
  const events = [];
  const stamps = new WeakMap();
  const ctrl = new AbortController();
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  let ended = false;
  const done = (async () => {
    try {
      const r = await fetch(`${base}/api/chat/${encodeURIComponent(pid)}/stream`, { signal: ctrl.signal });
      resolveReady(true);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: fin } = await reader.read();
        if (fin) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          try { const ev = JSON.parse(data); stamps.set(ev, Date.now()); events.push(ev); } catch { /* 非 JSON */ }
        }
      }
    } catch { /* 中止 / 断流:保留已收到的 */ } finally { ended = true; resolveReady(false); }
  })();
  return {
    events, ready, done,
    get ended() { return ended; },
    stampOf: (ev) => stamps.get(ev) || null,
    waitFor: (pred, ms = 10_000) => waitFor(() => events.find(pred), ms, 50),
    stop: () => { try { ctrl.abort(); } catch { /* */ } },
  };
}

export const isTaskToolUseEvent = (e) => Boolean(e && e.type === 'assistant' && e.message && Array.isArray(e.message.content)
  && e.message.content.some((b) => b && b.type === 'tool_use' && b.name === 'Task'));
export const stallNotices = (events) => events.filter((e) => e && e.type === 'stall_notice');
export const stallText = (ev) => String((ev && ev.text) || '');

// ---------------- 进程列表 / 假 claude 的回合记录 ----------------
/** 进程列表(GET /api/processes 的 claudeProcesses)里命令行带 sid 的进程的 pid(数字)。 */
export async function procPids(c, sid) {
  const r = await c.get('/api/processes');
  expect(r.status, `GET /api/processes 应 200(${String(r.text).slice(0, 200)})`).toBe(200);
  const list = r.body && Array.isArray(r.body.claudeProcesses) ? r.body.claudeProcesses : [];
  return list.filter((p) => String((p && p.command) || '').includes(sid)).map((p) => Number(p && p.pid));
}
export const turnsOf = (ctl, sid) => turnRecords(ctl).filter((t) => t && t.sid === sid);
export const lastTurnPid = (ctl, sid) => { const t = turnsOf(ctl, sid); return t.length ? t[t.length - 1].pid : null; };
export const waitTurn = (inst, sid, marker, ms = 20_000) =>
  waitFor(() => turnsOf(inst.ctl, sid).find((x) => String(x.text).includes(marker)) || null, ms, 80);
export const isGone = (inst, sid, cliPid, ms = 6_000) => waitFor(async () => (!(await procPids(inst.c, sid)).includes(Number(cliPid)) ? true : null), ms, 100);

// ---------------- "起过子代理后静默"的场景 ----------------
const taskToolUse = (tag, run) => ({
  toolUse: { id: `toolu_${tag}_task_${run}`, name: 'Task', input: { subagent_type: 'general-purpose', description: `${tag} 起过的子代理`, prompt: '等一会儿再返回' } },
});

/**
 * 起一次性实例 + 一个会话,发一条消息让假 claude 先吐出一次 Task 子代理调用,然后静默(脚本 waitFile 吊住回合)。
 * 返回 { inst, T, pid, cliPid, stream, never, t0 }:t0 = 事件流里收到那条 Task 调用的时刻(静默从这里算起)。
 * 前置(实例起来、消息发出、SSE 连上、假 claude 开始回合、进程列表里有它、事件流里有 Task 调用)任一不成立就直接失败。
 */
export async function startSilence({ tag, prefs, envExtra = {}, timerMap = null }) {
  let inst = null;
  try {
    inst = await startInstanceS(`s-${tag}`, { prefs, envExtra, timerMap });
    const run = uniq('');
    const T = seedSession(`${tag}-t-${run}`, { home: inst.home });
    const mark = `R151S-${tag}-${run}`;
    const scriptName = `${tag}-${run}`;
    const never = `${scriptName}-never`;
    writeScript(scriptName, [taskToolUse(tag, run), { waitFile: never }], inst.ctl);
    const r = await inst.c.post('/api/chat', { sessionId: T.sid, cwd: T.cwd, permissionMode: 'default', prompt: `${mark} R151S:${scriptName}` }, { timeoutMs: 30_000 });
    expect(r.status, `前置:发出这一条消息(${String(r.text).slice(0, 240)})`).toBe(200);
    const pid = r.body && r.body.pid;
    expect(pid, `前置:应答里有 chat 的 pid(${String(r.text).slice(0, 240)})`).toBeTruthy();
    const stream = streamT(inst.base, pid);
    expect(await stream.ready, '前置:SSE 已连上').toBe(true);
    const turn = await waitTurn(inst, T.sid, mark);
    expect(turn, `前置:假 CLI 开始跑这一回合(回合记录:${JSON.stringify(turnsOf(inst.ctl, T.sid))})`).toBeTruthy();
    const cliPid = lastTurnPid(inst.ctl, T.sid);
    expect(cliPid, `前置:回合记录里有假 CLI 的 pid`).toBeTruthy();
    const listed = await waitFor(async () => ((await procPids(inst.c, T.sid)).includes(Number(cliPid)) ? true : null), 5_000, 100);
    expect(listed, `前置:进程列表里有假 CLI pid ${cliPid}(进程列表:${JSON.stringify(await procPids(inst.c, T.sid))})`).toBe(true);
    const taskEv = await stream.waitFor(isTaskToolUseEvent, 10_000);
    expect(taskEv, `夹具生效:SSE 里有带 Task 工具调用的 assistant 消息(事件类型:${JSON.stringify(stream.events.map((e) => e && e.type))})`).toBeTruthy();
    return { inst, T, pid, cliPid, stream, never, t0: stream.stampOf(taskEv) || Date.now() };
  } catch (e) {
    if (inst) await inst.stop().catch(() => null);
    throw e;
  }
}

/** 收尾:放行脚本里的 waitFile、断开 SSE、停实例(只停自己的 pid)。 */
export async function disposeSilence(s) {
  if (!s) return;
  try { touchCtl(s.never, s.inst.ctl); } catch { /* 忽略 */ }
  try { s.stream.stop(); } catch { /* 忽略 */ }
  await s.inst.stop().catch(() => null);
}

/** 等第 n(从 1 数)条 stall_notice,返回 { ev, text, at(到达时刻) };等不到返回 null。 */
export async function waitNotice(s, n = 1, ms = 10_000) {
  const ev = await waitFor(() => stallNotices(s.stream.events)[n - 1] || null, ms, 50);
  return ev ? { ev, text: stallText(ev), at: s.stream.stampOf(ev) || Date.now() } : null;
}

export const dump = (s) => `SSE 事件:${JSON.stringify(s.stream.events.map((e) => ({ type: e.type, subtype: e.subtype, text: e.text })).slice(-12))};进程列表 pid:假 CLI=${s.cliPid}`;
export { client, writeScript, touchCtl };
