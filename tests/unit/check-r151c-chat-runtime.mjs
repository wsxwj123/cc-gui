#!/usr/bin/env node
// r151c 派工 2:chat.js 运行时扩展(方案 §3 chat.js、A1 / A5 / A6 / A7 / A8)。
//   ① 内部入口的适配对象是白名单 Proxy:名单外属性读 / 写即抛错;startInternalTurn 只认对象形状的 internal。
//   ② 内部入口与 HTTP 同应答:缺 prompt 400、目录不存在 400、冷启 200、复用 200;入口钩子 ctx.internal(HTTP 恒 null)。
//   ③ turnStart 的 params:body 键集合 = handleChatPost 从请求体解构的键去掉 prompt / sessionId / agent,值为请求原值、model 为
//      解析后的值;六种档位各发一次,params.guiMode 与运行快照的 guiMode 都等于界面档位;快照新字段 busy / guiMode / turnEpoch / liveTasks。
//   ④ sessionOptions:没挂接时 options 无 mcpServers、兼容键无 xs;挂接后冷启 options 带它给的 mcpServers、兼容键多 xs:1、
//      视图只读;槽级放行只对经它挂上工具的槽、且挂接点仍在位时生效(没挂上的槽、撤掉之后同名工具照既有规则弹卡);出错 / 异步 /
//      形状不对 → 什么都不挂、照常起回合。
//   ⑤ modeChange:/chat/permission-mode 回 200 时通知,400 / 409 不通知。
//   ⑥ 旁路 (a):内部请求遇同会话正在跑的回合 → 立即 409 CHAT_SESSION_BUSY,不起进程、不打断它;
//      旁路 (b):HTTP 请求等满 4 秒中止在跑的回合 → 那一回合的结束通知报 stopped。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身(不起 claude 进程);临时 HOME;端口 6900–6990(跳过 6710)。
// node tests/unit/check-r151c-chat-runtime.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151c-chat-')));
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
const { clients } = await import('../../server/broadcast.js');
const wsMsgs = [];
clients.add({ readyState: 1, send: (s) => wsMsgs.push(JSON.parse(s)) });
const chat = await import('../../server/routes/chat.js');
const { registerSessionRuntimeHooks, startInternalTurn, makeInternalTurnAdapters, getActiveChatProcesses, closeAllPersistentProcesses, chatCompatKey, TURN_PARAM_KEYS } = chat;

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
const snap = (pid) => getActiveChatProcesses().find((p) => p.pid === pid);
const idleOf = (pid) => { const p = snap(pid); return p && p.idle ? p : null; };
const uuid = (n) => `c2c2c2c2-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BODY = (extra) => ({ prompt: 'x', cwd: WORK, model: 'r151c-model', permissionMode: 'default', keepAlive: true, ...extra });
const keysOf = (o) => Object.keys(o).sort();
const FIXED_KEY_INPUT = { workingDir: WORK, effort: null, appendSystemPrompt: '', promptSuggestions: false, globalRead: false, dirs: [], maxBudgetUsd: null, acw: null, genui: true, ams: null };
const permRequests = (tool) => wsMsgs.filter((m) => m.type === 'permission:request' && (m.toolName === tool || m.request?.toolName === tool));
const settlesWithin = (p, ms) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

try {
  // ── ① 适配对象白名单 ─────────────────────────────────────────────────────────────────
  const INTERNAL = { kind: 'test', n: 1 };
  {
    const { req, res, sent } = makeInternalTurnAdapters({ prompt: 'p' }, INTERNAL);
    eq([req.body.prompt, typeof req.headers, req.socket.remoteAddress, typeof req.query], ['p', 'object', '127.0.0.1', 'object'], 'req 名单内属性可读');
    for (const prop of ['ip', 'get', 'on', 'hostname', 'params', 'cookies', 'app']) assert.throws(() => req[prop], TypeError, `req.${prop} 不在名单 → 抛错`), checks++;
    for (const prop of ['setHeader', 'send', 'end', 'headersSent', 'locals', 'write', 'on']) assert.throws(() => res[prop], TypeError, `res.${prop} 不在名单 → 抛错`), checks++;
    assert.throws(() => { res.foo = 1; }, TypeError, '写名单外属性 → 抛错'); checks++;
    assert.throws(() => { req.extra = 1; }, TypeError, 'req 写名单外属性 → 抛错'); checks++;
    assert.throws(() => 'locals' in res, TypeError, 'in 名单外属性 → 抛错'); checks++;
    eq(res.then, undefined, 'then 按"没有"答(Promise 解析探测用)');
    eq(sent(), null, '还没应答');
    res.status(418).json({ a: 1 });
    res.status(200).json({ b: 2 });
    eq(sent(), { status: 418, body: { a: 1 } }, '记第一次应答');
    const bound = res.json.bind(res); res.json = (x) => bound(x); // 主流程会这样重绑 res.json:名单内,允许
    ok(typeof res.json === 'function', 'json 可重绑');
  }
  for (const bad of [null, undefined, 'x', 1]) await assert.rejects(startInternalTurn(BODY({}), bad), TypeError), checks++;

  const log = [];
  const entries = () => log.filter((e) => e[0] === 'entry').map((e) => e[1]);
  const starts = () => log.filter((e) => e[0] === 'start').map((e) => e[1]);
  const ends = () => log.filter((e) => e[0] === 'end').map((e) => e[1]);
  const modeChanges = () => log.filter((e) => e[0] === 'mode').map((e) => e[1]);
  const unhook = registerSessionRuntimeHooks({
    chatEntry: (ctx) => { log.push(['entry', ctx]); return null; },
    turnStart: (info) => log.push(['start', info]),
    turnEnd: (info) => log.push(['end', info]),
    modeChange: (info) => log.push(['mode', info]),
  });

  // ── ② 内部入口与 HTTP 同应答 ──────────────────────────────────────────────────────────
  for (const [label, body] of [['缺 prompt', { cwd: WORK }], ['目录不存在', BODY({ cwd: join(TMP, 'nope') })], ['cwd 不是字符串', BODY({ cwd: 3 })]]) {
    const h = await api('/chat', body);
    const i = await startInternalTurn(body, INTERNAL);
    eq(i, { status: h.status, body: h.body }, `${label}:内部入口与 HTTP 应答逐字相同`);
    ok(h.status === 400, `${label} → 400`);
  }
  let n0 = calls.length;
  const hCold = await api('/chat', BODY({ prompt: 'h-cold' }));
  const iCold = await startInternalTurn(BODY({ prompt: 'i-cold' }), INTERNAL);
  eq([hCold.status, iCold.status], [200, 200], '冷启都 200');
  eq(keysOf(iCold.body), keysOf(hCold.body), '冷启应答键集合相同');
  eq([iCold.body.reused, iCold.body.delivered, iCold.body.status, iCold.body.model], [hCold.body.reused, hCold.body.delivered, hCold.body.status, hCold.body.model], '冷启应答取值相同');
  eq(calls.length, n0 + 2, '各起一个进程');
  eq(calls.at(-1).inputs[0].message.content, 'i-cold', '内部回合推进输入流的是请求的 prompt');
  const ctxH = entries().find((c) => c.body.prompt === 'h-cold');
  const ctxI = entries().find((c) => c.body.prompt === 'i-cold');
  eq(ctxH.internal, null, 'HTTP 请求的 ctx.internal 恒为 null');
  ok(ctxI.internal === INTERNAL, '内部请求的 ctx.internal 是调用方给的那个对象');
  // 复用
  const SID_R = uuid(1);
  let r = await api('/chat', BODY({ sessionId: SID_R, prompt: 'r0' }));
  await waitFor(() => idleOf(r.body.pid), '复用前置回合收尾');
  const hReuse = await api('/chat', BODY({ sessionId: SID_R, prompt: 'r1' }));
  await waitFor(() => idleOf(hReuse.body.pid), 'HTTP 复用回合收尾');
  const iReuse = await startInternalTurn(BODY({ sessionId: SID_R, prompt: 'r2' }), INTERNAL);
  eq([hReuse.status, iReuse.status, hReuse.body.reused, iReuse.body.reused], [200, 200, true, true], '复用都 200、reused:true');
  eq(keysOf(iReuse.body), keysOf(hReuse.body), '复用应答键集合相同');
  eq(iReuse.body.pid, hReuse.body.pid, '复用同一个进程');
  await waitFor(() => idleOf(iReuse.body.pid), '内部复用回合收尾');

  // ── ③ params 与快照 ─────────────────────────────────────────────────────────────────
  const src = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  const destr = /async function handleChatPost\(req, res\) \{[\s\S]*?const \{([\s\S]*?)\} = req\.body;/.exec(src);
  ok(destr, '找得到 handleChatPost 的请求体解构');
  const bodyKeys = destr[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean);
  eq([...TURN_PARAM_KEYS].sort(), bodyKeys.filter((k) => !['prompt', 'sessionId', 'agent'].includes(k)).sort(), 'params.body 键 = 解构键减 prompt/sessionId/agent');
  const FULL = { cwd: WORK, model: 'r151c-full', effort: 'high', addDirs: [TMP], permissionMode: 'acceptEdits', globalRead: false, appendSystemPrompt: '附加', promptSuggestions: false, keepAlive: true, maxBudgetUsd: 3, genui: false };
  r = await api('/chat', { ...FULL, prompt: 'full', agent: 'x-agent' });
  const sFull = starts().find((s) => s.pid === r.body.pid);
  eq(keysOf(sFull.params.body), [...TURN_PARAM_KEYS].sort(), 'params.body 恰好这 11 个键');
  eq(sFull.params.body, FULL, 'params.body 是请求原值');
  eq(sFull.params.guiMode, 'acceptEdits', 'params.guiMode = 解析后的界面档位');
  await waitFor(() => idleOf(r.body.pid), 'full 回合收尾');
  r = await api('/chat', { prompt: 'sparse', cwd: WORK, model: 'm-sparse' });
  const sSparse = starts().find((s) => s.pid === r.body.pid);
  eq(sSparse.params.body, { ...Object.fromEntries(TURN_PARAM_KEYS.map((k) => [k, null])), cwd: WORK, model: 'm-sparse' }, '没带的键为 null');
  eq(sSparse.params.guiMode, 'default', '没带档位 → default');
  await waitFor(() => idleOf(r.body.pid), 'sparse 回合收尾');
  const SID_M = uuid(2);
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
    r = await api('/chat', BODY({ sessionId: SID_M, permissionMode: mode, prompt: `m-${mode}` }));
    eq(r.status, 200, `${mode} 起回合`);
    const s = starts().filter((x) => x.pid === r.body.pid).at(-1);
    eq([s.params.guiMode, s.params.body.permissionMode], [mode, mode], `${mode}:params 档位与请求一致`);
    const p = await waitFor(() => idleOf(r.body.pid), `${mode} 回合收尾`);
    eq(p.guiMode, mode, `${mode}:快照 guiMode 与界面档位一致`);
  }
  const pM = snap(r.body.pid);
  eq([pM.busy, pM.turnEpoch, pM.liveTasks], [false, 5, 0], '快照:空闲槽 busy:false、回合代数、在飞任务数');

  // ── ④ sessionOptions ────────────────────────────────────────────────────────────────
  const keyOff = chatCompatKey(FIXED_KEY_INPUT);
  ok(!('xs' in JSON.parse(keyOff)), '没挂接:兼容键没有 xs');
  r = await api('/chat', BODY({ prompt: 'no-tools' }));
  ok(!('mcpServers' in calls.at(-1).options), '没挂接:options 没有 mcpServers');
  const canUseNoTools = calls.at(-1).options.canUseTool;
  const pidNoTools = r.body.pid;
  await waitFor(() => idleOf(pidNoTools), 'no-tools 回合收尾');
  const TOOL = 'mcp__ccgui-sessions__list_sessions';
  const OTHER = 'mcp__ccgui-sessions__send_message';
  const views = [];
  let optImpl = () => ({ mcpServers: { 'ccgui-sessions': { type: 'sdk', name: 'ccgui-sessions', instance: {} } }, autoAllow: [TOOL] });
  const unhookOpts = registerSessionRuntimeHooks({ sessionOptions: (view) => { views.push(view); return optImpl(view); } });
  eq(JSON.parse(chatCompatKey(FIXED_KEY_INPUT)).xs, 1, '挂接:兼容键多 xs:1');
  eq(JSON.parse(chatCompatKey(FIXED_KEY_INPUT)), { ...JSON.parse(keyOff), xs: 1 }, '挂接:兼容键只多这一项');
  r = await api('/chat', BODY({ prompt: 'with-tools', permissionMode: 'default' }));
  const pidTools = r.body.pid;
  eq(Object.keys(calls.at(-1).options.mcpServers || {}), ['ccgui-sessions'], '挂接:冷启 options 带 mcpServers');
  const canUseTools = calls.at(-1).options.canUseTool;
  const view = views.at(-1);
  eq([view.runId, view.cwd, view.guiMode, view.turnEpoch], [pidTools, WORK, 'default', 0], '视图取值');
  assert.throws(() => { 'use strict'; view.guiMode = 'bypassPermissions'; }, TypeError, '视图只读'); checks++;
  await waitFor(() => idleOf(pidTools), 'with-tools 回合收尾');
  eq(view.sessionId, snap(pidTools).sessionId, '视图的 sessionId 随 init 就位(取调用那一刻的值)');
  eq(await canUseTools(TOOL, { query: 'a' }, { toolUseID: 't1' }), { behavior: 'allow', updatedInput: { query: 'a' } }, '挂上工具的槽:名单内工具直接放行');
  let p = canUseTools(OTHER, { to: 'x', message: 'y' }, { toolUseID: 't2' });
  eq(await settlesWithin(p, 300), false, '挂上工具的槽:名单外的同服务工具照既有规则弹卡');
  ok(permRequests(OTHER).length >= 1, '名单外工具发了权限卡');
  p = canUseNoTools(TOOL, { query: 'a' }, { toolUseID: 't3' });
  eq(await settlesWithin(p, 300), false, '没挂上工具的槽:同名工具不放行(弹卡)');
  const permBefore = permRequests(TOOL).length;
  ok(permBefore >= 1, '没挂上工具的槽对同名工具发了权限卡');
  // 出错 / 异步 / 形状不对 → 不挂、照常起回合
  for (const [label, impl] of [['抛错', () => { throw new Error('boom'); }], ['异步', async () => ({ autoAllow: [TOOL] })],
    ['mcpServers 不是对象', () => ({ mcpServers: [1], autoAllow: [TOOL] })], ['autoAllow 不是数组', () => ({ autoAllow: TOOL })], ['null', () => null]]) {
    optImpl = impl;
    r = await api('/chat', BODY({ prompt: `bad-${label}` }));
    eq(r.status, 200, `sessionOptions ${label}:照常起回合`);
    ok(!('mcpServers' in calls.at(-1).options), `sessionOptions ${label}:不挂 mcpServers`);
    const cu = calls.at(-1).options.canUseTool;
    await waitFor(() => idleOf(r.body.pid), `${label} 回合收尾`);
    eq(await settlesWithin(cu(TOOL, {}, { toolUseID: `t-${label}` }), 300), false, `sessionOptions ${label}:不放行`);
  }
  unhookOpts();
  ok(!('xs' in JSON.parse(chatCompatKey(FIXED_KEY_INPUT))), '撤掉后兼容键回到没有 xs');
  eq(chatCompatKey(FIXED_KEY_INPUT), keyOff, '撤掉后兼容键与没挂接时逐字相同');
  p = canUseTools(TOOL, { query: 'b' }, { toolUseID: 't4' });
  eq(await settlesWithin(p, 300), false, '挂接点撤掉后,原先挂上工具的槽也不再放行');
  await closeAllPersistentProcesses(); // 清掉挂着的权限卡与进程
  await sleep(100);

  // ── ⑤ modeChange ───────────────────────────────────────────────────────────────────
  const SID_IDLE = uuid(3);
  let m = await api('/chat/permission-mode', { sessionId: SID_IDLE, mode: 'plan' });
  eq([m.status, m.body.attempted], [200, 0], '没有进程的会话切档 200');
  eq(modeChanges().at(-1), { sessionId: SID_IDLE, mode: 'plan' }, '200 → 通知 modeChange');
  const mc0 = modeChanges().length;
  m = await api('/chat/permission-mode', { sessionId: SID_IDLE, mode: 'weird' });
  eq([m.status, modeChanges().length], [400, mc0], '400 不通知');
  writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } }));
  m = await api('/chat/permission-mode', { sessionId: SID_IDLE, mode: 'auto' });
  eq([m.status, m.body.code, modeChanges().length], [409, 'THIRD_PARTY_AUTO_DISABLED', mc0], '409 不通知');
  rmSync(join(HOME, '.claude', 'settings.json'));

  // ── ⑥ 旁路 (a) / (b) ────────────────────────────────────────────────────────────────
  ctl.reply = (input) => (String(input?.message?.content).includes('HOLD') ? 'hold' : 'ok');
  const SID_B = uuid(4);
  const busy = await api('/chat', BODY({ sessionId: SID_B, prompt: 'user HOLD' }));
  eq(busy.status, 200, '用户回合起来了');
  await waitFor(() => snap(busy.body.pid)?.busy && snap(busy.body.pid)?.sessionId === SID_B, '用户回合在跑(busy)');
  n0 = calls.length;
  const ends0 = ends().length;
  const starts0 = starts().length;
  const t0 = Date.now();
  const iBusy = await startInternalTurn(BODY({ sessionId: SID_B, prompt: 'auto while busy' }), INTERNAL);
  const took = Date.now() - t0;
  eq([iBusy.status, iBusy.body.ok, iBusy.body.code], [409, false, 'CHAT_SESSION_BUSY'], '内部请求遇忙 → 409 CHAT_SESSION_BUSY');
  ok(took < 1000, `内部请求遇忙立即回(${took}ms),不等 4 秒`);
  eq(calls.length, n0, '遇忙不起进程');
  const sb = snap(busy.body.pid);
  eq([sb.busy, sb.exitCode, ends().length], [true, null, ends0], '用户回合不受影响(仍在跑、没有结束通知)');
  eq(starts().length, starts0, '遇忙没有开始新回合');
  // (b) HTTP 请求等满 4 秒中止在跑的回合 → stopped
  const busyEpoch = sb.turnEpoch;
  const late = await api('/chat', BODY({ sessionId: SID_B, prompt: 'user second' }));
  eq(late.status, 200, '后到的 HTTP 请求照常起回合(现状:等 4 秒后中止先到的)');
  const endBusy = await waitFor(() => ends().find((e) => e.pid === busy.body.pid && e.turnEpoch === busyEpoch), '被中止回合的结束通知');
  eq(endBusy.outcome, 'stopped', '被后到请求中止的回合报 stopped(旁路 b)');
  const endLate = await waitFor(() => ends().find((e) => e.pid === late.body.pid), '后到回合结束');
  eq(endLate.outcome, 'completed', '后到回合正常完成');
  ctl.reply = undefined;
  unhook();
  console.log(`PASS check-r151c-chat-runtime(${checks} 项)`);
} finally {
  try { await closeAllPersistentProcesses(); } catch { /* 收尾 */ }
  server.close();
  rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}
