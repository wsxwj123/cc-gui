// r151f 本套件辅助(只走 HTTP / WS / 文件 / 外部进程记录,不 import 产品代码)。
// 一期 helpers/、二期 helpers/p2.mjs、r151d helpers/d.mjs、r151e helpers/e.mjs 原样复用;这里只放本轮新增:
//   对假 claude 外壳 fx-claude.mjs 的控制(吞 / 压住 / 拒绝切档请求、推迟客气退出、定时执行命令)与它的记录、
//   造"双进程"、第三方 provider + 「自动」档的场景、不读事件流的发消息、带"压着这一回合"脚本的发消息、「放任」发送方发消息。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { uniq, makeWorkspace, seedSession } from '../../r151b-xsession-p1/helpers/fixtures.mjs';
import { waitFor, spawnRecords, writeScript, touchCtl, MOCK } from '../../r151b-xsession-p1/helpers/api.mjs';
import { procPids, turnsOf, lastTurnPid, switchMode, userTurn, sendAndSettle, sleep } from '../../r151e-prefs-read-hardening/helpers/e.mjs';

export { sleep, procPids, turnsOf, lastTurnPid, switchMode, userTurn };

const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// ---------------- 对 fx-claude.mjs 的控制(约定见 fx-claude.mjs 开头) ----------------
const fxPut = (ctl, kind, key, obj) => {
  const d = path.join(ctl, 'r151f', kind);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, String(key)), JSON.stringify(obj));
};
/** 从现在起,会话 sid 的进程 pid 收到切档请求一律不回应。 */
export const fxMute = (ctl, sid, pid) => fxPut(ctl, 'mute', sid, { pid });
/** 会话 sid 的进程 pid 收到的第一条切档请求压住 ms 毫秒再交给假 claude,之后的照常。 */
export const fxDelayFirst = (ctl, sid, pid, ms) => fxPut(ctl, 'delay', sid, { pid, ms });
/** 会话 sid 的进程 pid 收到切到 modes 里档位的请求时,回"命令行明确拒绝"。 */
export const fxReject = (ctl, sid, pid, modes, error) => fxPut(ctl, 'reject', sid, { pid, modes, error });
/** 进程 pid 被客客气气要求退出(关 stdin)后先不退(模拟被它起的后台命令吊着);信号照常能结束它。 */
export const fxHold = (ctl, pid, opts = {}) => fxPut(ctl, 'hold', pid, { at: Date.now(), ...opts });
export const fxRelease = (ctl, pid) => fxPut(ctl, 'release', pid, { at: Date.now() });
/** 到 runAt(毫秒时间戳),会话 sid 的进程 pid 若还活着且自认为是 auto 档,就直接执行 cmd。 */
export const fxExec = (ctl, sid, { pid, runAt, cmd }) => fxPut(ctl, 'exec', sid, { pid, runAt, cmd });
/** 会话 sid 的进程(pid 不给 = 谁先遇到谁发)在下一次吐出 result 之前,先报一条后台任务开始(之后不报结束):模拟"被它起的后台命令吊着"。一次性。 */
export const fxBgTask = (ctl, sid, opts = {}) => fxPut(ctl, 'bgtask', sid, opts);
/** 假 claude 外壳记下的切档请求处理 { at, t, pid, sid, mode, action }。 */
export const switchLog = (ctl, sid) => jsonl(path.join(ctl, 'r151f-switch.jsonl')).filter((x) => !sid || x.sid === sid);
export const bgTaskLog = (ctl, sid) => jsonl(path.join(ctl, 'r151f-bgtask.jsonl')).filter((x) => !sid || x.sid === sid);
export const execLog = (ctl, sid) => jsonl(path.join(ctl, 'r151f-exec.jsonl')).filter((x) => !sid || x.sid === sid);
export const exitLog = (ctl, sid) => jsonl(path.join(ctl, 'r151f-exit.jsonl')).filter((x) => !sid || x.sid === sid);
/** 放行会话 sid 起过的所有进程(含 extraPids)的"推迟客气退出"。用例的 finally 里调用。 */
export function releaseAll(inst, sid, extraPids = []) {
  const pids = new Set([...spawnRecords(inst.ctl).filter((r) => r.sid === sid).map((r) => r.pid), ...extraPids]);
  for (const p of pids) fxRelease(inst.ctl, p);
}
/** 结束一个进程(只用于结束本实例进程列表里看到的、会话 T 的进程)。已经没了不报错。 */
export function killPid(pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { if (!e || e.code !== 'ESRCH') throw e; } }

// ---------------- 会话 / 发消息 ----------------
/** 一次性实例里的假 CLI 会话 T(已落盘的旧记录,工作目录在本用例自己的工作区)。 */
/**
 * 一个回合结束后留一段空闲时间。2026-10-17 在当前代码上实测:回合结束后约 5 秒内,宿主还不把这个进程当"空闲进程"——这时发下一条消息不会复用它、
 * 而是另起新进程(旧进程原样留着);空闲 8 秒后再发才复用(应答里 reused:true、pid 不变)。要"下一条消息由同一个进程处理"的用例都先留这段空闲。
 */
export const settle = (ms = 8_000) => sleep(ms);
export const newT = (inst, tag) => seedSession(`${tag}-t-${uniq('')}`, { home: inst.home });
/** 改一下临时 HOME 下的 .claude/settings.json(内容与修改时间都变):让空闲的老进程不能再被复用。保留文件里原有的键。 */
export function touchSettings(home) {
  const f = path.join(home, '.claude', 'settings.json');
  let o = {};
  try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { o = {}; }
  o.env = { ...(o.env || {}), R151F_NONCE: uniq('n') };
  fs.writeFileSync(f, JSON.stringify(o, null, 2));
}
/** POST /api/chat,不读事件流(用于回合被压着、一时不会结束的场景)。超时不抛。 */
export async function chatStart(c, T, { prompt, mode, postMs = 30_000 }) {
  try {
    return await c.post('/api/chat', { sessionId: T.sid, cwd: T.cwd, prompt, ...(mode ? { permissionMode: mode } : {}) }, { timeoutMs: postMs });
  } catch (e) {
    return { status: 'timeout', body: null, text: String(e) };
  }
}
/**
 * 写一个"假模型压着这一回合"的脚本:先等 <CTL>/<name>-never 出现(最多 60 秒),再演 steps,最后说一句收尾。
 * 返回 { name, never, release() }。消息里带 `R151S:<name>` 即用它。
 */
export function writeHeldScript(inst, name, steps = []) {
  const never = `${name}-never`;
  writeScript(name, [{ waitFile: never }, ...steps, { say: `R151F ${name} 回合完` }], inst.ctl);
  return { name, never, release: () => touchCtl(never, inst.ctl) };
}
/** 等假 claude 记下"跑了带 marker 的回合",返回那条回合记录 { pid, sid, mode, text }。 */
export const waitTurn = (inst, T, marker, ms = 15_000) => waitFor(() => turnsOf(inst.ctl, T.sid).find((x) => String(x.text).includes(marker)) || null, ms, 100);
/** 脚本:请求写一个文件(Write)。 */
export function writeFileScript(inst, name, file, toolUseId) {
  writeScript(name, [
    { canUseTool: { tool_name: 'Write', tool_use_id: toolUseId, input: { file_path: file, content: 'R151F' } } },
    { say: `R151F ${name} 回合完` },
  ], inst.ctl);
}
/** 切档应答里的 failed(不是数组 = null)。 */
export const failedOf = (sw) => (sw && sw.body && Array.isArray(sw.body.failed) ? sw.body.failed : null);

/**
 * 造"双进程"的第一步(老进程):T 在 mode 档跑一个回合 → 空闲 8 秒(宿主把它当空闲进程)→ 让它"被后台命令吊着"(fxHold:被要求退出也不退、无视 SIGTERM,
 * 宿主约 12 秒后才能用 SIGKILL 结束它)→ 改 settings.json 让它不能复用。返回 oldPid。
 */
export async function prepareOld(inst, T, { mode }) {
  const c = inst.c;
  const t1 = await userTurn(c, T, { mode, note: '双进程:老进程的回合' });
  expect(t1.status, `前置:T 跑第一个回合(${String(t1.text).slice(0, 200)})`).toBe(200);
  const oldPid = lastTurnPid(inst.ctl, T.sid);
  expect(oldPid, '前置:假 claude 记下了 T 这一回合的进程号').toBeTruthy();
  let pids = [];
  await waitFor(async () => { pids = await procPids(c, T.sid); return pids.length === 1 && pids[0] === oldPid; }, 8_000, 200);
  expect(pids, `前置:进程列表里 T 恰有一个存活进程,就是跑第一个回合的 ${oldPid}`).toEqual([oldPid]);
  await settle();
  fxHold(inst.ctl, oldPid, { signals: true });
  touchSettings(inst.home);
  return oldPid;
}
/**
 * 造"双进程"的第二步:发出落在新进程上的消息(prompt 里要带 marker,用来在假 claude 的回合记录里找到它;要压着这个回合就带脚本标记)。
 * 宿主这时要换下老进程:关它的 stdin(被要求退出)、等它最多约 5 秒、起新进程跑这条。返回 { newPid }。此刻进程列表里 T 恰有两个进程:
 * 旧的(已被要求退出、没退)与新的。
 * 与接口文件的差别:接口文件写"新进程正在跑它的第二个回合"。当前代码上新进程刚起、空闲不到 5 秒时,下一条消息不会复用它,而旧进程至多再活约 12 秒
 * (被要求退出后宿主约 6 秒发 SIGTERM、约 12 秒 SIGKILL),等不到"空闲后复用",所以这里让新进程的第一个回合就是被压着的那个。
 */
export async function swapIn(inst, T, oldPid, { mode, prompt, marker }) {
  const start = await chatStart(inst.c, T, { prompt, mode, postMs: 40_000 });
  expect(start.status, `前置:发出落在新进程上的消息(${String(start.text).slice(0, 200)})`).toBe(200);
  const running = await waitTurn(inst, T, marker, 25_000);
  expect(running, `前置:新进程开始跑这条消息(回合记录:${JSON.stringify(turnsOf(inst.ctl, T.sid).slice(-3))})`).toBeTruthy();
  const newPid = running.pid;
  expect(newPid, `前置:这条消息由新进程跑(新 ${newPid},旧 ${oldPid})`).not.toBe(oldPid);
  const asked = exitLog(inst.ctl, T.sid).find((e) => e.pid === oldPid && e.ev === 'exit-requested') || null;
  expect(asked, `前置:宿主换下老进程 ${oldPid} 时关了它的 stdin(被要求退出、正推迟退出);退出记录:${JSON.stringify(exitLog(inst.ctl, T.sid).slice(-4))}`).toBeTruthy();
  const pids = await procPids(inst.c, T.sid);
  expect([...pids].sort((a, b) => a - b), `前置:进程列表里 T 恰有两个存活进程:旧 ${oldPid}(已被要求退出、没退)与新 ${newPid}`).toEqual([oldPid, newPid].sort((a, b) => a - b));
  return { newPid };
}

// ---------------- 第三方 provider + 「自动」档 ----------------
/** 打开第三方「自动」档总开关,建一个 anthropic 协议的第三方 provider(地址 = 本地假模型接口的一条车道)并切过去。 */
export async function thirdPartyAuto(inst) {
  const c = inst.c;
  const on = await c.put('/api/prefs/third-party-auto', { enabled: true });
  expect(on.status, `前置:打开第三方 provider 的「自动」档(${on.text.slice(0, 200)})`).toBe(200);
  const lane = `tp-f${uniq('')}`;
  const body = { name: `R151F-${lane}`, type: 'anthropic', baseURL: `${MOCK}/lane/${lane}`, apiKey: 'dummy-r151-key', models: ['r151-chat', 'r151-reasoner'], defaultModel: 'r151-chat', tierModels: null };
  const created = await c.post('/api/custom-providers', body);
  expect(created.status, `前置:建第三方 provider(${created.text.slice(0, 200)})`).toBe(200);
  const sw = await c.post('/api/provider/switch', { id: created.body.id });
  expect(sw.status, `前置:切到第三方 provider(${sw.text.slice(0, 200)})`).toBe(200);
}

// ---------------- 「放任」发送方发一条跨会话消息 ----------------
/** 发送方(真 CLI 会话,「放任」,工作目录 ws/real-*)给 T 发一条消息并等它落定;返回 sendAndSettle 的结果({ r, m, fin, turns })。 */
export async function senderSend(inst, T, tag) {
  const S = { cwd: makeWorkspace(`real-${tag}-${uniq('')}`) };
  return sendAndSettle(inst, S, T, `R151F ${tag} ${uniq('')}`, { settleMs: 2_000 });
}
