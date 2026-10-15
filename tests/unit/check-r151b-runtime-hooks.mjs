#!/usr/bin/env node
// r151b T-X1:chat.js 的会话运行时钩子位(方案 X.1.9)—— 挂接后的行为。没挂接时"与改动前相同"由
// check-r151b-baseline.mjs / check-r151b-baseline-ui.mjs 钉住(改动前录制),这里不重复。
//   ① 注册校验;deliverRunEvent 的返回值。
//   ② /chat 入口改写位:返回 null 照常;reject → 回它给的应答、不起进程、同 clientTurnId 可重试;改写 → 推进输入流的
//      内容恰好是改写后的文本(冷启与复用两条路);同 clientTurnId 改写后重发命中既有幂等、钩子不再被调;抛错 / 返回值
//      不合规 → 500 CHAT_ENTRY_HOOK_FAILED、不起进程。
//   ③ 回合开始 / 结束:参数正确;turnStart 里补的事件盖了 runId + seq、排在本回合任何 CLI 输出之前;结束的
//      outcome 分 completed / failed(结果为错误、没有结果就退出、进程起不来) / stopped;每回合至多一次。
//   ④ PreToolUse 守卫位:返回 deny 即输出(只认 deny,其余与 2 秒超时见 check-r151b-audit-fixes);返回 null / 抛错按没挂接处理。
//   ⑤ 注销后恢复没挂接的行为。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身(含可选控制 __r151bSdkControl),不起 claude 进程;临时 HOME;端口 6900–6990(跳过 6710)。
// node tests/unit/check-r151b-runtime-hooks.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-hooks-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
for (const d of [join(HOME, '.claude', 'sessions'), join(HOME, '.claude-gui'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;

registerR151bSdkStub();
const calls = (globalThis.__r151bSdkCalls ||= []);
const ctl = (globalThis.__r151bSdkControl = {});
const { default: express } = await import('express');
const chat = await import('../../server/routes/chat.js');
const { registerSessionRuntimeHooks, deliverRunEvent, makePreToolUseHook, getActiveChatProcesses, closeAllPersistentProcesses } = chat;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 8000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = pred(); if (v) return v; await sleep(20); }
  throw new Error(`等不到:${what}`);
}
async function freePort() {
  for (let p = 6990; p >= 6900; p--) {
    if (p === 6710) continue;
    const ok = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (ok) return p;
  }
  throw new Error('6900-6990 没有空闲端口');
}
const app = express();
app.use(express.json());
app.use('/api', chat.default);
const port = await freePort();
const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
const api = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
/** 读一次事件流(回放缓冲 + 实时,直到 done),返回解析后的事件。 */
async function readStream(pid) {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat/${pid}/stream`);
  const text = await r.text();
  await sleep(50); // 让服务端撤掉这次连接的监听,下一回合的事件回落到缓冲
  return text.split('\n\n').map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter(Boolean).map((s) => { try { return JSON.parse(s); } catch { return { raw: s }; } });
}
const idleOf = (pid) => getActiveChatProcesses().find((p) => p.pid === pid && p.idle);
const uuid = (n) => `c1c1c1c1-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BODY = (extra) => ({ prompt: 'x', cwd: WORK, model: 'r151b-model', permissionMode: 'default', keepAlive: true, ...extra });
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

try {
  // ── ① 注册校验 / deliverRunEvent ───────────────────────────────────────────────────
  for (const bad of [null, 1, 'x']) assert.throws(() => registerSessionRuntimeHooks(bad), TypeError), checks++;
  assert.throws(() => registerSessionRuntimeHooks({ nope() {} }), TypeError); checks++;
  assert.throws(() => registerSessionRuntimeHooks({ turnStart: 1 }), TypeError); checks++;
  eq(deliverRunEvent('sdk-nope', { type: 'x' }), false, '找不到运行 → false');

  const log = [];
  const entries = () => log.filter((e) => e[0] === 'entry');
  const starts = () => log.filter((e) => e[0] === 'start').map((e) => e[1]);
  const ends = () => log.filter((e) => e[0] === 'end').map((e) => e[1]);
  let entryImpl = () => null;
  let guardImpl = () => null;
  const delivered = [];
  const unregister = registerSessionRuntimeHooks({
    chatEntry: (ctx) => { log.push(['entry', ctx]); return entryImpl(ctx); },
    turnStart: (info) => {
      log.push(['start', info]);
      if (info.tag?.emit) delivered.push(deliverRunEvent(info.pid, { type: 'xs_message', id: info.tag.id }));
    },
    turnEnd: (info) => log.push(['end', info]),
    preToolUse: (input, gctx) => { log.push(['guard', input, gctx]); return guardImpl(input, gctx); },
  });

  // ── ② 入口返回 null:照常 ─────────────────────────────────────────────────────────
  let r = await api('/chat', BODY({ prompt: 'p-plain' }));
  eq(r.status, 200, '入口返回 null 照常'); const pidPlain = r.body.pid;
  eq(calls.at(-1).inputs[0].message.content, 'p-plain', '推入原文');
  const e0 = entries().at(-1)[1];
  eq([e0.body.prompt, e0.sessionId, e0.clientTurnId, e0.principal], ['p-plain', null, null, 'local'], '入口钩子的参数');
  await waitFor(() => ends().find((x) => x.pid === pidPlain), '普通回合结束');
  const sPlain = starts().find((x) => x.pid === pidPlain);
  eq([sPlain.reused, sPlain.tag, sPlain.turnEpoch, sPlain.runId, sPlain.cwd], [false, undefined, 0, pidPlain, WORK], '冷启回合开始的参数');
  eq(ends().find((x) => x.pid === pidPlain).outcome, 'completed', '正常结果 → completed');

  // ── ② reject:回它给的应答、不起进程、同 clientTurnId 可重试 ──────────────────────────────
  entryImpl = () => ({ reject: { status: 409, body: { ok: false, code: 'XS_TEST', error: '拒绝' } } });
  let n0 = calls.length; let s0 = starts().length;
  r = await api('/chat', BODY({ clientTurnId: uuid(1) }));
  eq([r.status, r.body], [409, { ok: false, code: 'XS_TEST', error: '拒绝' }], 'reject 原样回给客户端');
  eq([calls.length, starts().length], [n0, s0], 'reject 不起进程、没有回合');
  entryImpl = () => null;
  r = await api('/chat', BODY({ clientTurnId: uuid(1), prompt: 'retry' }));
  eq(r.status, 200, '被拒后同 clientTurnId 可重试(记录已撤)');
  eq(entries().at(-1)[1].clientTurnId, uuid(1), '重试时入口钩子照常被调');
  await waitFor(() => idleOf(r.body.pid), '重试回合收尾');

  // ── ② 抛错 / 返回值不合规 → 500、不起进程 ─────────────────────────────────────────────
  for (const [label, impl] of [['抛错', () => { throw new Error('boom'); }], ['空 prompt', () => ({ prompt: '' })],
    ['reject 状态码不对', () => ({ reject: { status: 200, body: {} } })], ['什么都不是', () => ({ foo: 1 })], ['异步抛错', async () => { throw new Error('x'); }]]) {
    entryImpl = impl; n0 = calls.length;
    r = await api('/chat', BODY({}));
    eq([r.status, r.body.code], [500, 'CHAT_ENTRY_HOOK_FAILED'], `入口钩子${label} → 500`);
    eq(calls.length, n0, `入口钩子${label}时不起进程`);
  }

  // ── ② 改写(冷启)+ ③ 补事件排在最前 ────────────────────────────────────────────────────
  const SID = uuid(2);
  entryImpl = () => ({ prompt: 'ENVELOPE-1', tag: { id: 'm1', emit: true } });
  r = await api('/chat', BODY({ sessionId: SID }));
  eq(r.status, 200, '改写后照常起回合'); const pidA = r.body.pid;
  eq(calls.at(-1).inputs[0].message.content, 'ENVELOPE-1', '冷启:推进输入流的恰好是改写后的文本');
  eq(entries().at(-1)[1].sessionId, SID, '入口钩子拿到 sessionId');
  await waitFor(() => idleOf(pidA), '改写回合收尾');
  let evs = await readStream(pidA);
  const typed = evs.filter((e) => e.type);
  eq(typed[0].type, 'xs_message', '补的事件是本回合第一条');
  eq([typed[0].id, typed[0].runId, typeof typed[0].seq], ['m1', pidA, 'number'], '补的事件盖了 runId + seq');
  ok(typed.findIndex((e) => e.type === 'system' && e.subtype === 'init') > 0, 'init 在补的事件之后');
  eq(delivered, [true], 'deliverRunEvent 返回 true');
  const sA = starts().find((x) => x.pid === pidA);
  eq([sA.reused, sA.tag.id, sA.turnEpoch], [false, 'm1', 0], '改写回合的开始带 tag');
  eq(ends().filter((x) => x.pid === pidA).map((x) => [x.outcome, x.tag.id, x.turnEpoch]), [['completed', 'm1', 0]], '改写回合的结束带 tag');

  // ── ② 改写(复用) ────────────────────────────────────────────────────────────────────
  entryImpl = () => ({ prompt: 'ENVELOPE-2', tag: { id: 'm2', emit: true } });
  r = await api('/chat', BODY({ sessionId: SID }));
  eq([r.status, r.body.reused, r.body.pid], [200, true, pidA], '同会话第二条复用常驻进程');
  const recA = calls.find((c) => c.options.resume === SID);
  await waitFor(() => recA.inputs.length === 2, '复用进程收到第二条');
  eq(recA.inputs[1].message.content, 'ENVELOPE-2', '复用:推进输入流的恰好是改写后的文本');
  await waitFor(() => ends().filter((x) => x.pid === pidA).length === 2, '复用回合结束');
  const sA2 = starts().filter((x) => x.pid === pidA)[1];
  eq([sA2.reused, sA2.tag.id, sA2.turnEpoch], [true, 'm2', 1], '复用回合开始的参数');
  eq(ends().filter((x) => x.pid === pidA)[1].outcome, 'completed', '复用回合 completed');
  await waitFor(() => idleOf(pidA), '复用回合收尾');
  evs = (await readStream(pidA)).filter((e) => e.type);
  eq(evs[0].type, 'xs_message', '复用回合:补的事件排在本回合输出之前');
  ok(evs.findIndex((e) => e.type === 'assistant') > 0, '复用回合:assistant 在补的事件之后');

  // ── ② 同 clientTurnId 改写后重发:命中既有幂等,钩子不再被调 ─────────────────────────────────
  entryImpl = () => ({ prompt: 'ENVELOPE-3', tag: { id: 'm3' } });
  const before = entries().length;
  const b3 = BODY({ clientTurnId: uuid(3), prompt: 'card' });
  const r3a = await api('/chat', b3);
  const r3b = await api('/chat', b3);
  eq([r3a.status, r3b.status, r3b.body.pid], [200, 200, r3a.body.pid], '重发得到同一个运行');
  eq(entries().length, before + 1, '重发不再调入口钩子');
  await waitFor(() => idleOf(r3a.body.pid), 'm3 回合收尾');
  entryImpl = () => null;

  // ── ③ outcome:结果为错误 / 没有结果就退出 / 停止 / 进程起不来 ───────────────────────────────
  ctl.reply = (input) => ({ 'make-error': 'error', 'make-exit': 'exit', 'make-hold': 'hold' })[input?.message?.content] || 'ok';
  r = await api('/chat', BODY({ prompt: 'make-error' }));
  eq((await waitFor(() => ends().find((x) => x.pid === r.body.pid), '错误回合结束')).outcome, 'failed', '结果为错误 → failed');
  r = await api('/chat', BODY({ prompt: 'make-exit' }));
  eq((await waitFor(() => ends().find((x) => x.pid === r.body.pid), '无结果回合结束')).outcome, 'failed', '没有结果就退出 → failed');
  r = await api('/chat', BODY({ prompt: 'make-hold' }));
  const pidHold = r.body.pid;
  await waitFor(() => starts().find((x) => x.pid === pidHold), '挂住的回合开始');
  const stop = await api(`/chat/${pidHold}/stop`, {});
  eq(stop.status, 200, '停止请求被接受');
  eq((await waitFor(() => ends().find((x) => x.pid === pidHold), '停止的回合结束')).outcome, 'stopped', '停止 → stopped');
  ctl.throwOnQuery = true;
  r = await api('/chat', BODY({ prompt: 'boom' }));
  eq([r.status, r.body.code], [500, 'CHAT_START_FAILED'], '进程起不来 → 既有 500');
  const lastStart = starts().at(-1);
  eq((await waitFor(() => ends().find((x) => x.pid === lastStart.pid), '起不来的回合结束')).outcome, 'failed', '起不来 → 补报 failed');
  ctl.reply = undefined;

  // ── ③ 每回合至多一次 ──────────────────────────────────────────────────────────────────
  const endCount = ends().length;
  closeAllPersistentProcesses();
  await waitFor(() => getActiveChatProcesses().every((p) => p.exitCode !== null), '全部进程收尾');
  await sleep(100);
  eq(ends().length, endCount, '进程收尾时不再重复报已报过的回合');
  const perTurn = new Map();
  for (const e of ends()) { const k = `${e.pid}#${e.turnEpoch}`; perTurn.set(k, (perTurn.get(k) || 0) + 1); }
  ok([...perTurn.values()].every((c) => c === 1), '每个 (pid, 回合) 只有一次结束');
  eq(ends().length, starts().length, '开始与结束一一对应');

  // ── ④ PreToolUse 守卫位 ──────────────────────────────────────────────────────────────
  const slot = { thirdPartyProvider: false, guiMode: 'default', sessionId: 'S-1', cwd: '/w', runId: 'sdk-x' };
  const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'R' } };
  const hook = makePreToolUseHook(slot);
  guardImpl = () => deny;
  eq(await hook({ tool_name: 'SendMessage', tool_input: { to: 'x' } }, 'tu-1'), deny, '守卫返回 deny → 它就是输出');
  const g = log.filter((e) => e[0] === 'guard').at(-1);
  eq([g[1].tool_name, g[2]], ['SendMessage', { toolUseID: 'tu-1', sessionId: 'S-1', cwd: '/w', runId: 'sdk-x' }], '守卫收到的参数');
  guardImpl = async () => deny;
  eq(await hook({ tool_name: 'SendMessage' }, 'tu-2'), deny, '异步守卫');
  guardImpl = () => null;
  eq(await hook({ tool_name: 'SendMessage' }, 'tu-3'), { continue: true }, '守卫返回 null → 既有判定');
  guardImpl = () => { throw new Error('guard boom'); };
  eq(await hook({ tool_name: 'SendMessage' }, 'tu-4'), { continue: true }, '守卫抛错 → 既有判定');

  // ── ⑤ 注销 ─────────────────────────────────────────────────────────────────────────────
  unregister();
  const nLog = log.length;
  eq(await hook({ tool_name: 'SendMessage' }, 'tu-5'), { continue: true }, '注销后 PreToolUse 照旧');
  r = await api('/chat', BODY({ prompt: 'after-unregister' }));
  eq(r.status, 200, '注销后照常起回合');
  eq(calls.at(-1).inputs[0].message.content, 'after-unregister', '注销后推入原文');
  await waitFor(() => idleOf(r.body.pid), '注销后的回合收尾');
  eq(log.length, nLog, '注销后四个钩子都不再被调');
  ok(!('runtimeTurn' in (getActiveChatProcesses().find((p) => p.pid === r.body.pid) || {})), '注销后运行信息里没有新字段');
  console.log(`PASS check-r151b-runtime-hooks(${checks} 项)`);
} finally {
  try { closeAllPersistentProcesses(); } catch { /* */ }
  await new Promise((res) => server.close(res));
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(0);
