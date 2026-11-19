// r199 本套件辅助(只走 HTTP / SSE / 页面 / 文件 / 外部进程记录,不 import 产品代码,也不 import 别的套件)。
// 一个共享后端(端口 6971,run.sh 起)+ 页面(6972);每条用例用自己新建的会话,互不串。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SUITE = path.resolve(here, '..');
export const WORKTREE = path.resolve(SUITE, '..', '..', '..');
export const FAKE = path.join(here, 'fake-claude.mjs');
export const dataRoot = () => process.env.R199_DATA_ROOT || path.join(SUITE, '.artifacts', 'runtime-data');
export const homeDir = () => path.join(dataRoot(), 'home');
export const ctlDir = () => process.env.R199_CTL || path.join(homeDir(), 'fake-claude');
export const fakebinDir = () => path.join(dataRoot(), 'fakebin');
export const wsRoot = () => path.join(dataRoot(), 'ws');
export const API = process.env.R199_API_BASE || 'http://127.0.0.1:6971';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uniq = (tag = '') => `${tag}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

// ---------------- 夹具 ----------------
export function buildFixtures() {
  const home = homeDir();
  const ctl = ctlDir();
  const gui = path.join(home, '.claude-gui');
  const claude = path.join(home, '.claude');
  for (const d of [gui, claude, path.join(claude, 'projects'), ctl, path.join(ctl, 'scripts'), path.join(ctl, 'r199', 'auto'), path.join(ctl, 'r199', 'hold'), path.join(ctl, 'r199', 'release'), wsRoot(), fakebinDir()]) fs.mkdirSync(d, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(WORKTREE, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(gui, 'prefs.json'), JSON.stringify({ releaseNotesSeen: version }, null, 2));
  fs.writeFileSync(path.join(gui, 'permission-guide-shown.flag'), '2026-09-15T00:00:00.000Z');
  fs.writeFileSync(path.join(gui, 'network.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ env: {} }, null, 2));
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const shim = path.join(fakebinDir(), 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\n# r199 claude 垫片:一律交给本套件的假命令行(没有真 CLI 车道)。\nunset NODE_OPTIONS\nexec ${q(process.execPath)} ${q(FAKE)} "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

/** 新建一个已有旧记录的会话(工作区在本次运行的数据根下,不在 /tmp)。返回 { sid, cwd, title, reply, tag }。 */
export function newSession(name) {
  const tag = `${name}-${uniq()}`;
  const sid = crypto.randomUUID();
  const dir = path.join(wsRoot(), tag);
  fs.mkdirSync(dir, { recursive: true });
  const cwd = fs.realpathSync(dir);
  const proj = path.join(homeDir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const title = `R199 ${tag}`;
  const reply = `${title} 这是已有的旧回复。`;
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.296', gitBranch: '' };
  const lines = [
    { type: 'summary', summary: title, leafUuid: `${sid}-a1` },
    { ...base, type: 'user', uuid: `${sid}-u0`, parentUuid: null, timestamp: '2026-10-01T08:00:00.000Z', message: { role: 'user', content: title } },
    { ...base, type: 'assistant', uuid: `${sid}-a1`, parentUuid: `${sid}-u0`, timestamp: '2026-10-01T08:00:01.000Z', requestId: `req_${sid.slice(0, 8)}`,
      message: { id: `msg_${sid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'r199-chat', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { sid, cwd, title, reply, tag };
}
export function newWorkspace(name) {
  const dir = path.join(wsRoot(), `${name}-${uniq()}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

// ---------------- HTTP ----------------
export async function http(method, p, body, timeoutMs = 30_000) {
  const t0 = Date.now();
  const init = { method, headers: {}, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(API + p, init);
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: r.status, body: parsed, text, ms: Date.now() - t0 };
}
/** POST /api/chat。默认关输入预测(promptSuggestions:false),要打开的用例自己传 extra.promptSuggestions:true。 */
export const chat = (T, prompt, extra = {}, timeoutMs = 30_000) =>
  http('POST', '/api/chat', { sessionId: T.sid, cwd: T.cwd, prompt, permissionMode: 'default', promptSuggestions: false, ...extra }, timeoutMs);
export const stopPid = (pid) => http('POST', `/api/chat/${encodeURIComponent(pid)}/stop`, {}, 20_000);

export async function waitFor(fn, ms = 15_000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

// ---------------- 回合流(带到达时刻) ----------------
export function openStream(pid) {
  const ctrl = new AbortController();
  const events = [];
  const st = { events, closed: false };
  (async () => {
    try {
      const r = await fetch(`${API}/api/chat/${encodeURIComponent(pid)}/stream`, { signal: ctrl.signal });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          try { events.push({ t: Date.now(), ev: JSON.parse(data) }); } catch { /* 非 JSON */ }
        }
      }
    } catch { /* 中止 / 断开 */ }
    st.closed = true;
  })();
  st.abort = () => ctrl.abort();
  st.find = (pred) => events.find((e) => pred(e.ev)) || null;
  st.has = (pred) => Boolean(st.find(pred));
  st.waitFor = (pred, ms = 15_000) => waitFor(() => st.find(pred), ms, 50);
  st.doneAt = () => { const d = st.find((e) => e && e.type === 'done'); return d ? d.t : null; };
  st.summary = () => JSON.stringify(events.map((e) => `${e.ev && e.ev.type}${e.ev && e.ev.subtype ? `/${e.ev.subtype}` : ''}`));
  return st;
}
export const isText = (text) => (e) => e && e.type === 'assistant' && JSON.stringify(e).includes(text);
export const isResult = (e) => e && e.type === 'result';
export const isDone = (e) => e && e.type === 'done';
/** 压缩完成事件:SDK 的 system/compact_boundary(或服务端改写成的名字里带 compact 的事件)。 */
export const isCompactDone = (e) => Boolean(e) && ((e.type === 'system' && e.subtype === 'compact_boundary') || /^compact/i.test(String(e.type || '')) || /compact_boundary/.test(JSON.stringify(e)));

// ---------------- 假命令行的记录与控制 ----------------
const jsonl = (f) => { try { return fs.readFileSync(path.join(ctlDir(), f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const rec = (file, sid) => jsonl(file).filter((x) => !sid || x.sid === sid);
export const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); } };
/** 这个会话的命令行进程(假命令行的系统进程号):起过且还活着的。= 接口文件说的"进程数"。 */
export const osProcs = (sid) => [...new Set(rec('spawn.jsonl', sid).filter((x) => x.interactive).map((x) => x.pid))].filter(alive);
export const allOsPids = (sid) => [...new Set(rec('spawn.jsonl', sid).filter((x) => x.interactive).map((x) => x.pid))];
/** 等活着的进程数到 n(最多 ms)。返回最后一次读到的活进程列表。 */
export async function procsSettled(sid, n, ms = 12_000) {
  let live = osProcs(sid);
  await waitFor(() => { live = osProcs(sid); return live.length === n; }, ms, 150);
  return live;
}
export const turnStarts = (sid, marker) => rec('turns.jsonl', sid).filter((x) => !marker || String(x.text).includes(marker));
export const turnEnds = (sid, marker) => rec('turn-ends.jsonl', sid).filter((x) => !marker || String(x.text).includes(marker));
export const inputsOf = (sid) => rec('inputs.jsonl', sid);
export const autoRecs = (sid, ev) => rec('auto.jsonl', sid).filter((x) => !ev || x.ev === ev);

export function writeScript(name, steps) { fs.mkdirSync(path.join(ctlDir(), 'scripts'), { recursive: true }); fs.writeFileSync(path.join(ctlDir(), 'scripts', `${name}.json`), JSON.stringify(steps)); }
export const touchFile = (name) => fs.writeFileSync(path.join(ctlDir(), name), String(Date.now()));
const putCtl = (kind, key, obj) => { const d = path.join(ctlDir(), 'r199', kind); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, String(key)), JSON.stringify(obj)); };
/** 让会话 sid 的进程(pid 不给 = 谁先遇到谁发)吐后台命令结束通知、再自己接着回复 sleepMs 毫秒。 */
export const fxAuto = (sid, opts) => putCtl('auto', sid, opts);
/** 进程 osPid 被要求退出(关 stdin)后挂着不退、无视终止信号,直到 fxRelease。 */
export const fxHold = (osPid, opts = { signals: true }) => putCtl('hold', osPid, opts);
export const fxRelease = (osPid) => putCtl('release', osPid, { at: Date.now() });
/** 用例收尾:放行并结束这个会话起过的所有进程(只处理本套件假命令行记录里的 pid)。 */
export async function cleanupSession(T, files = []) {
  for (const f of files) { try { touchFile(f); } catch { /* 忽略 */ } }
  for (const pid of allOsPids(T.sid)) fxRelease(pid);
  await sleep(300);
  for (const pid of allOsPids(T.sid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
}

/**
 * 前置:会话 T 第一回合起一个进程,回合里放出 bgTasks 个没结束的后台命令(taskId = `<tag>-bg<i>`),回合结束后留 8 秒空闲。
 * 返回 { r1, pid1, osPid1, taskIds }。pid1 = 应答里的进程号(字符串)。
 */
export async function primeProcess(T, { bgTasks = 2, extra = {} } = {}) {
  const taskIds = Array.from({ length: bgTasks }, (_, i) => `${T.tag}-bg${i}`);
  const steps = [...taskIds.map((taskId) => ({ bgStart: { taskId, description: 'sleep 120' } })), { say: `R199 ${T.tag} 第一回合完(后台命令还在跑)` }];
  writeScript(`${T.tag}-prime`, steps);
  const r1 = await chat(T, `R199 ${T.tag} 第一回合 R199S:${T.tag}-prime`, extra);
  if (r1.status !== 200 || !r1.body || !r1.body.pid) throw new Error(`前置失败:第一回合应 200 且带 pid(实际 ${r1.status}:${r1.text.slice(0, 240)})`);
  const s = openStream(r1.body.pid);
  const done = await s.waitFor(isDone, 25_000);
  s.abort();
  if (!done) throw new Error(`前置失败:第一回合 25 秒内没收到结束事件(${s.summary()})`);
  await sleep(8_000);
  const live = osProcs(T.sid);
  if (live.length !== 1) throw new Error(`前置失败:第一回合之后应恰有 1 个进程(实际 ${JSON.stringify(live)})`);
  return { r1, pid1: r1.body.pid, osPid1: live[0], taskIds };
}
/** 让会话 T 的进程开始"后台命令结束后自己接着回复"的一段,等假命令行记下 start。 */
export async function startAutoTurn(T, { taskId, sleepMs = 12_000, say = `R199 ${T.tag} 自己接着回复` }) {
  const before = autoRecs(T.sid, 'start').length;
  fxAuto(T.sid, { taskId, say, sleepMs });
  const hit = await waitFor(() => autoRecs(T.sid, 'start').length > before, 8_000, 50);
  if (!hit) throw new Error('前置失败:假命令行没开始自己接着回复');
  return Date.now();
}
export const waitAutoEnd = (T, n = 1, ms = 40_000) => waitFor(() => autoRecs(T.sid, 'end').length >= n, ms, 100);

