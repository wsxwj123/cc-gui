#!/usr/bin/env node
// r151f 切档没切成时怎么处理(任务文件 .devflow/r151f-mode-divergence.md 修法 1–5 的服务端部分)。
//   ① 修法 1–3(切档接口 applyPermissionModeToSlots):只给可用进程(存活、不在关闭中、输入没关)发切档请求、只按它们计数,
//      没有可用进程 → attempted 0;没回应的中止(failed 那一项带 aborted:true),档位字段不改(撤掉 r151e 判官修复的回写);
//      回 200 时被命令行明确拒绝的也中止,回 409 时被拒的照旧保留、一个字段都不改(r49b①)。
//   ② 修法 3 后半 + 修法 5:一次请求里各可用进程同时发、同时等;同一会话的切档请求与复用热切共用按会话的锁、按发起顺序逐个执行,
//      "切档进行中"标记覆盖排队时间;复用热切 5 秒没回应 → 中止旧进程,明确失败照旧置关闭中、关输入。端口 6820–6869。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身;临时 HOME。
// node tests/unit/check-r151f-mode-divergence.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151f-unit-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
for (const d of [join(HOME, '.claude', 'sessions'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
registerR151bSdkStub();
const ctl = (globalThis.__r151bSdkControl = {});
const calls = (globalThis.__r151bSdkCalls ||= []);
ctl.reply = () => 'ok';
const { default: express } = await import('express');
const chat = await import('../../server/routes/chat.js');

const eq = (a, b, msg) => assert.deepEqual(a, b, msg);
const ok = (v, msg) => assert.ok(v, msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 切档限时的定时器是 unref 的(不拖住服务退出):没有别的活动句柄时事件循环会提前退出,这里用一个常驻定时器撑住,结尾 process.exit
setInterval(() => {}, 1_000);

// ── ① 切档接口:可用进程判据、没回应就中止、撤掉回写、被拒按整体结果定去留 ──
{
  const SID = 'sid-r151f-1';
  const mkInput = (closed = false) => ({ close() { closed = true; }, isClosed: () => closed });
  const seen = [];
  const answering = (tag) => ({ setPermissionMode: async (m) => { seen.push([tag, m]); } });
  const refusing = (tag) => ({ setPermissionMode: async () => { seen.push([tag, 'refused']); throw new Error('Cannot set permission mode to auto'); } });
  const hanging = (tag, onLate) => ({ setPermissionMode: () => { seen.push([tag, 'hung']); return new Promise((r) => { onLate?.(r); }); } });
  const mk = (query, over = {}) => ({
    sessionId: SID, exitCode: null, guiMode: 'bypassPermissions', permissionMode: 'bypassPermissions', sdkMode: 'default',
    input: mkInput(), abort: new AbortController(), runtimeTurn: { stopRequested: false }, query, ...over,
  });
  const fields = (s) => [s.guiMode, s.permissionMode, s.sdkMode];
  const untouched = ['bypassPermissions', 'bypassPermissions', 'default'];
  const killed = (s) => [!!s.closing, s.abort.signal.aborted, s.input.isClosed(), s.runtimeTurn.stopRequested];

  // 1a) 输入已关、关闭中、泵已收尾的进程:不发请求、不计数、档位字段不动;只有它们 → attempted 0(接口回 200)
  {
    seen.length = 0;
    const closedIn = mk(answering('closedIn'), { input: mkInput(true) });
    const closing = mk(answering('closing'), { closing: true });
    const ended = mk(answering('ended'), { pumpEnded: true });
    const r = await chat.applyPermissionModeToSlots(new Map([[1, closedIn], [2, closing], [3, ended]]), SID, 'default', { timeoutMs: 200 });
    eq(r, { attempted: 0, delivered: 0, failed: [] }, '1a 没有可用进程:attempted 0、delivered 0、failed 空(不算收下)');
    eq(seen, [], '1a 不可用的进程一个切档请求都不发');
    for (const s of [closedIn, closing, ended]) eq(fields(s), untouched, '1a 不可用进程的档位字段不动(不再"只改本地档位")');
    eq(closedIn.abort.signal.aborted || closing.abort.signal.aborted || ended.abort.signal.aborted, false, '1a 不可用的进程不被中止');
  }

  // 1b) 一个切成、一个没回应(回 200):没回应的被中止,failed 那一项带 aborted:true,档位字段不改(没有回写),晚到的结果也不改
  {
    seen.length = 0;
    let late = null;
    const closedIn = mk(answering('closedIn'), { input: mkInput(true) });
    const fine = mk(answering('fine'));
    const hung = mk(hanging('hung', (r) => { late = r; }));
    const t0 = Date.now();
    const r = await chat.applyPermissionModeToSlots(new Map([[1, closedIn], [2, fine], [3, hung]]), SID, 'plan', { timeoutMs: 200 });
    ok(Date.now() - t0 < 1_500, `1b 超时之后就返回(${Date.now() - t0}ms)`);
    eq([r.attempted, r.delivered, r.failed.length], [2, 1, 1], '1b 只数两个可用进程:一个切成、一个没回应(接口回 200)');
    eq([r.failed[0].sessionId, /超时/.test(r.failed[0].error), r.failed[0].aborted], [SID, true, true], `1b 没回应的那一项写明超时并带 aborted:true(${JSON.stringify(r.failed[0])})`);
    eq(fields(fine), ['plan', 'plan', 'plan'], '1b 按时回应的照常切过去');
    eq(fields(hung), untouched, '1b 没回应的进程档位字段不改(撤掉 r151e 判官修复的回写)');
    eq(killed(hung), [true, true, true, true], '1b 没回应的进程:置关闭中、中止 SDK、关输入、本回合按收到停止请求结束');
    eq(killed(fine), [false, false, false, false], '1b 切成的进程照常可用');
    eq(fields(closedIn), untouched, '1b 输入已关的进程不跟随切档(不算收下)');
    eq(seen.some(([t]) => t === 'closedIn'), false, '1b 输入已关的进程没收到切档请求');
    late();
    await sleep(50);
    eq(fields(hung), untouched, '1b 超时之后才到的结果不改档位字段');
  }

  // 1c) 一个切成、一个被明确拒绝(回 200):被拒的同样中止(与界面不一致),failed 那一项带 aborted:true,档位字段不改
  {
    const fine = mk(answering('fine'));
    const bad = mk(refusing('bad'));
    const r = await chat.applyPermissionModeToSlots(new Map([[1, bad], [2, fine]]), SID, 'auto', { timeoutMs: 200 });
    eq([r.attempted, r.delivered, r.failed.length], [2, 1, 1], '1c 一个切成、一个被拒(接口回 200)');
    eq([r.failed[0].error, r.failed[0].aborted], ['Cannot set permission mode to auto', true], '1c 被拒的那一项带命令行原文与 aborted:true');
    eq(fields(bad), untouched, '1c 被拒的进程档位字段不改');
    eq(killed(bad), [true, true, true, true], '1c 回 200 时被拒的进程被中止');
    eq(fields(fine), ['auto', 'auto', 'auto'], '1c 切成的照常落位');
  }

  // 1d) 只有被明确拒绝的(回 409):照旧保留、一个字段都不改、不中止,failed 那一项没有 aborted(r49b①)
  {
    const bad = mk(refusing('bad'));
    const r = await chat.applyPermissionModeToSlots(new Map([[1, bad]]), SID, 'auto', { timeoutMs: 200 });
    eq(r, { attempted: 1, delivered: 0, failed: [{ sessionId: SID, error: 'Cannot set permission mode to auto' }] }, '1d 全部被拒:409,failed 原样、没有 aborted');
    eq(fields(bad), untouched, '1d 被拒的进程档位不变');
    eq(killed(bad), [false, false, false, false], '1d 被拒的进程照旧可用(不中止、不关输入)');
  }

  // 1e) 一个没回应 + 一个被拒(都没切成,回 409):没回应的照样中止,被拒的照旧保留;failed 按进程顺序记
  {
    const hung = mk(hanging('hung'));
    const bad = mk(refusing('bad'));
    const r = await chat.applyPermissionModeToSlots(new Map([[1, hung], [2, bad]]), SID, 'acceptEdits', { timeoutMs: 200 });
    eq([r.attempted, r.delivered], [2, 0], '1e 两个都没切成(接口回 409)');
    eq([/超时/.test(r.failed[0].error), r.failed[0].aborted, r.failed[1].error, 'aborted' in r.failed[1]], [true, true, 'Cannot set permission mode to auto', false], '1e failed 按进程顺序:没回应的带 aborted,被拒的没有');
    eq(killed(hung), [true, true, true, true], '1e 回 409 时没回应的照样中止');
    eq(killed(bad), [false, false, false, false], '1e 回 409 时被拒的照旧保留');
    eq([fields(hung), fields(bad)], [untouched, untouched], '1e 两个的档位字段都不改');
  }
}

// ── ② 并发发送、按会话串行、复用热切没回应就中止 ──
// 2a) 一次请求里多个可用进程都不回应:同时发、同时等,总用时约一个超时(不逐个累加);failed 仍按进程顺序逐个记
{
  const SID = 'sid-r151f-2a';
  const mkInput = () => { let closed = false; return { close() { closed = true; }, isClosed: () => closed }; };
  const hung = (tag) => ({ tag, sessionId: SID, exitCode: null, guiMode: 'default', permissionMode: 'default', sdkMode: 'default', input: mkInput(), abort: new AbortController(), query: { setPermissionMode: () => new Promise(() => {}) } });
  const slots = [hung('a'), hung('b'), hung('c')];
  const t0 = Date.now();
  const r = await chat.applyPermissionModeToSlots(new Map(slots.map((x, i) => [i, x])), SID, 'plan', { timeoutMs: 300 });
  const took = Date.now() - t0;
  ok(took < 600, `2a 三个进程都不回应:同时等,总用时约一个超时(实际 ${took}ms,逐个累加会是 900ms 以上)`);
  eq([r.attempted, r.delivered, r.failed.map((f) => f.aborted)], [3, 0, [true, true, true]], '2a 三个都没回应:都计入 failed、都带 aborted');
  eq(slots.map((x) => x.abort.signal.aborted), [true, true, true], '2a 三个都被中止');
}

// 服务端部分:真路由 + SDK 替身
const deferred = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
async function waitFor(pred, what, ms = 10_000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = await pred(); if (v) return v; await sleep(25); }
  throw new Error(`等不到:${what}`);
}
async function freePort() {
  for (let p = 6869; p >= 6820; p--) {
    const free = await new Promise((r) => { const sv = net.createServer().once('error', () => r(false)).once('listening', () => sv.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('6820-6869 没有空闲端口');
}
const app = express();
app.use(express.json());
app.use('/api', chat.default);
const port = await freePort();
await new Promise((r) => { const sv = app.listen(port, '127.0.0.1', () => r(sv)); });
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const PROJ_DIR = join(HOME, '.claude', 'projects', '-tmp-r151f-unit');
mkdirSync(PROJ_DIR, { recursive: true });
const mkSession = (title) => {
  const sid = randomUUID();
  writeFileSync(join(PROJ_DIR, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${sid.slice(0, 8)}-u`, sessionId: sid, message: { role: 'user', content: title } })}\n`);
  return sid;
};
const LIVE = { globalRead: true, keepAlive: true, promptSuggestions: false, genui: true };
const chatTurn = (sid, mode) => api('POST', '/chat', { sessionId: sid, prompt: 'r151f 用户回合', cwd: WORK, model: 'r151f-model', permissionMode: mode, ...LIVE });
const slotOf = (sid) => chat.getActiveChatProcesses().filter((p) => p.sessionId === sid && p.exitCode === null).at(-1) || null;
const recordOf = (sid) => calls.filter((c) => c.options.resume === sid || c.options.sessionId === sid).at(-1) || null;
async function idleResident(sid, mode) {
  const r = await chatTurn(sid, mode);
  eq(r.status, 200, `前置:回合 200(${JSON.stringify(r.body).slice(0, 160)})`);
  await waitFor(() => slotOf(sid) && slotOf(sid).idle, '回合结束、进程转空闲');
  return { pid: r.body.pid, record: recordOf(sid) };
}

// 2b) 同一会话两次切档:第一次的控制请求被压住时,第二次排队(控制请求不发)、"切档进行中"一直为真;按发起顺序执行、按发起顺序应答,
//     最后发起的那次说了算
{
  const T = mkSession('r151f 2b 连续切档');
  await idleResident(T, 'default');
  const asked = []; const firstAsked = deferred(); const gate = deferred();
  ctl.setPermissionMode = (record, m) => {
    if (record.options.resume !== T && record.options.sessionId !== T) return null;
    asked.push(m);
    if (asked.length === 1) { firstAsked.open(); return gate.p; }
    return null;
  };
  try {
    const done = [];
    const a = api('POST', '/chat/permission-mode', { sessionId: T, mode: 'bypassPermissions' }).then((r) => { done.push('a'); return r; });
    await Promise.race([firstAsked.p, sleep(5_000).then(() => { throw new Error('等不到:第一次切档的控制请求'); })]);
    const b = api('POST', '/chat/permission-mode', { sessionId: T, mode: 'plan' }).then((r) => { done.push('b'); return r; });
    await sleep(400);
    eq(asked, ['default'], '2b 第一次切档没完成时,第二次排队:它的控制请求还没发');
    eq(chat.permissionModeSwitchPending(T), true, '2b 排队期间"切档进行中"为真');
    gate.open();
    const [ra, rb] = await Promise.all([a, b]);
    eq([ra.status, rb.status, done], [200, 200, ['a', 'b']], '2b 两次都回 200,先发起的先应答');
    eq(asked, ['default', 'plan'], '2b 控制请求按发起顺序逐个发');
    eq([slotOf(T).guiMode, chat.permissionModeSwitchPending(T)], ['plan', false], '2b 最后发起的那次说了算;都完成后"切档进行中"清掉');
  } finally { ctl.setPermissionMode = null; gate.open(); }
}

// 2c) 复用派发与切档请求共用一把锁:切档请求的控制请求被压住时进来说的消息排在锁后(它自己的热切控制请求不发);
//     切档完成后按那次切档的确认档位复用原进程(r151g 项2:消息进来之后完成的切档说了算,不再用消息里的档位热切)。
//     r151g 前这里断言"热切排队 → 5 秒没回应 → 中止旧进程、换新进程";r151g 起这条消息会先用切档的确认档位,
//     plan 热切不再发生(热切超时中止的覆盖仍在 check-r151e-xs-recovery 4b 与本轮验收 E10)。
{
  const T = mkSession('r151f 2c 复用派发排队与切档对齐');
  const { pid: oldPid, record: oldRec } = await idleResident(T, 'default');
  const asked = []; const firstAsked = deferred(); const gate = deferred();
  ctl.setPermissionMode = (record, m) => {
    if (record !== oldRec) return null;
    asked.push(m);
    if (asked.length === 1) { firstAsked.open(); return gate.p; }
    return null;
  };
  try {
    const sw = api('POST', '/chat/permission-mode', { sessionId: T, mode: 'acceptEdits' });
    await Promise.race([firstAsked.p, sleep(5_000).then(() => { throw new Error('等不到:切档请求的控制请求'); })]);
    const turn = chatTurn(T, 'plan');
    await sleep(400);
    eq(asked, ['default'], '2c 切档请求没完成时,复用派发排队:它自己的热切控制请求还没发');
    gate.open();
    eq((await sw).status, 200, '2c 切档请求照常 200');
    const r = await turn;
    eq(r.status, 200, `2c 这条消息照常 200(${JSON.stringify(r.body).slice(0, 120)})`);
    eq(r.body.pid, oldPid, '2c 切档完成后复用原进程(按那次切档的确认档位,不再用消息里的档位热切)');
    eq([slotOf(T).guiMode, asked], ['acceptEdits', ['default']], '2c 两层档位是切档的确认档位,没有额外的热切控制请求');
    eq(oldRec.options.abortController.signal.aborted, false, '2c 旧进程没有被中止');
  } finally { ctl.setPermissionMode = null; gate.open(); }
}

// 2d) 复用热切被明确拒绝:照旧置关闭中、关输入(回合间空闲,手上没有回合),不中止;这条消息由新进程处理
{
  const T = mkSession('r151f 2d 复用热切被拒');
  const { pid: oldPid, record: oldRec } = await idleResident(T, 'default');
  ctl.setPermissionMode = (record) => (record === oldRec ? Promise.reject(new Error('Cannot set permission mode to plan')) : null);
  try {
    const r = await chatTurn(T, 'plan');
    eq([r.status, r.body.pid !== oldPid], [200, true], '2d 换新进程处理这条消息');
    await waitFor(() => oldRec.inputEnded, '2d 旧进程的输入被关');
    eq(oldRec.options.abortController.signal.aborted, false, '2d 明确被拒不中止(只关输入)');
  } finally { ctl.setPermissionMode = null; }
}

console.log('✓ check-r151f-mode-divergence 全部通过');
process.exit(0);
