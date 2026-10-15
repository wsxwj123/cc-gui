#!/usr/bin/env node
// r151b T-X6:原生 SendMessage 引导(PLAN X.1.1;接口行为清单 25、X.3.1 nativeGuard.lastFailureAt)。
//   ① 纯判定 nativeGuardShouldDeny:按登记表的 name(去掉结尾" [短号]")/ messagingSocketPath(uds: 前缀、/private/tmp = /tmp)
//      认目标;目标会话属于 GUI 存活进程槽且不是自己才拒;其它种类(main 等)、不是 GUI 会话、自己 → 不拒。
//   ② 接线:总开关开 → syncXsRuntimeHooks 挂上,经 makePreToolUseHook 拒绝发给 GUI 另一个会话的调用,原因逐字;
//      目标不是 GUI 会话 / 不是 SendMessage → 原判定照常;偏好文件里开关是关的 → 不管;读不到登记表 → 放行并记 lastFailureAt;
//      syncXsRuntimeHooks(false) 立即撤下。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身,不起 claude 进程;临时 HOME;端口 6900–6990(跳过 6710)。
// node tests/unit/check-r151b-native-guard.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-guard-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
const REG = join(HOME, '.claude', 'sessions');
for (const d of [join(HOME, '.claude-gui'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
const setEnabled = (v) => writeFileSync(join(HOME, '.claude-gui', 'prefs.json'), JSON.stringify({ xsEnabled: v }));

registerR151bSdkStub();
const { default: express } = await import('express');
const chat = await import('../../server/routes/chat.js');
const { makePreToolUseHook, getActiveChatProcesses, closeAllPersistentProcesses } = chat;
const xs = await import('../../server/services/xsession.js');
const { nativeGuardShouldDeny, xsNativeGuard, syncXsRuntimeHooks, nativeGuardLastFailure, NATIVE_GUARD_REASON } = xs;

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); passed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 8000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = pred(); if (v) return v; await sleep(20); }
  throw new Error(`等不到:${what}`);
}

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const C = 'cccccccc-0000-4000-8000-000000000003';
const T = 'dddddddd-0000-4000-8000-000000000004';
const entries = [
  { pid: 101, sessionId: A, name: 'proj-a1', messagingSocketPath: '/tmp/cc-socks/101.sock' },
  { pid: 103, sessionId: C, name: 'proj-c3', messagingSocketPath: '/tmp/cc-socks/103.sock' },
  { pid: 104, sessionId: T, name: 'term-d4', messagingSocketPath: '/tmp/cc-socks/104.sock' },
];
const gui = [A, C];
const byName = (n) => ({ to: n, summary: 's', message: 'm', type: 'message', recipient: n, recipient_kind: 'name', content: 'm' });

// ── ① 纯判定 ──────────────────────────────────────────────────────────────────────────────
eq(nativeGuardShouldDeny(byName('proj-c3'), entries, gui, A), true, '按名字发给 GUI 另一个会话 → 拒');
eq(nativeGuardShouldDeny(byName('proj-c3 [ab12cd]'), entries, gui, A), true, 'ListAgents 写法"名字 [短号]"也认');
eq(nativeGuardShouldDeny(byName('term-d4'), entries, gui, A), false, '目标不是 GUI 会话 → 不拒');
eq(nativeGuardShouldDeny(byName('proj-a1'), entries, gui, A), false, '发给自己 → 不拒(CLI 自己处理)');
eq(nativeGuardShouldDeny(byName('nobody'), entries, gui, A), false, '登记表里没有 → 不拒');
eq(nativeGuardShouldDeny(byName('proj-c3'), entries, [C.toUpperCase()], A), true, 'GUI 会话 id 比较不分大小写');
eq(nativeGuardShouldDeny({ to: 'uds:/private/tmp/cc-socks/103.sock', recipient: 'uds:/private/tmp/cc-socks/103.sock', recipient_kind: 'session' }, entries, gui, A), true,
  '按地址发:uds: 前缀、/private/tmp 与 /tmp 视为同一处');
eq(nativeGuardShouldDeny({ to: 'uds:/tmp/cc-socks/104.sock', recipient_kind: 'session' }, entries, gui, A), false, '地址指向终端会话 → 不拒');
eq(nativeGuardShouldDeny({ to: 'main', recipient: 'main', recipient_kind: 'main' }, entries, gui, A), false, '其它种类(main / 子代理等)→ 不拒');
eq(nativeGuardShouldDeny({ to: 'proj-c3' }, entries, gui, A), true, '没有 recipient_kind 时按 to 当名字');
eq(nativeGuardShouldDeny({ to: 'uds:/tmp/cc-socks/103.sock' }, entries, gui, A), true, '没有 recipient_kind 且 to 是 uds: 地址');
eq(nativeGuardShouldDeny({}, entries, gui, A), false, '没有目标 → 不拒');

// ── ② 接线 ────────────────────────────────────────────────────────────────────────────────
async function freePort() {
  for (let p = 6990; p >= 6900; p--) {
    if (p === 6710) continue;
    const free = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('6900-6990 没有空闲端口');
}
const app = express();
app.use(express.json());
app.use('/api', chat.default);
const port = await freePort();
const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
try {
  // 起一个 GUI 会话(常驻),它就是"GUI 的另一个会话"
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'x', cwd: WORK, model: 'r151b-model', permissionMode: 'default', keepAlive: true }) });
  const { pid } = await res.json();
  const slot = await waitFor(() => getActiveChatProcesses().find((p) => p.pid === pid && p.idle && p.sessionId), 'GUI 会话进入空闲');
  const guiSid = slot.sessionId;
  const sender = { sessionId: A, cwd: WORK, runId: 'sdk-r151b-sender', guiMode: 'default', thirdPartyProvider: false };
  const hook = makePreToolUseHook(sender);
  const call = (toolInput, toolName = 'SendMessage') => hook({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }, 'toolu_r151b_1');
  const DENY = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NATIVE_GUARD_REASON } };
  eq(NATIVE_GUARD_REASON, '这个会话由 CC-GUI 管理，不接收经 SendMessage 发来的消息。如需把内容交给它，请告诉用户在 CC-GUI 里转发。', '拒绝原因逐字');

  setEnabled(true);
  mkdirSync(REG, { recursive: true });
  writeFileSync(join(REG, '201.json'), JSON.stringify({ pid: 201, sessionId: guiSid, name: 'gui-c', messagingSocketPath: '/tmp/cc-socks/201.sock' }));
  writeFileSync(join(REG, '202.json'), JSON.stringify({ pid: 202, sessionId: T, name: 'term-d', messagingSocketPath: '/tmp/cc-socks/202.sock' }));
  writeFileSync(join(REG, '203.json'), '{ 正在写一半');
  eq(await call(byName('gui-c')), { continue: true }, '没挂上之前:原判定照常');
  syncXsRuntimeHooks(true);
  eq(await call(byName('gui-c')), DENY, '开关开:发给 GUI 另一个会话 → 拒,原因逐字(坏掉的登记文件跳过)');
  eq(await call(byName('term-d')), { continue: true }, '目标不是 GUI 会话 → 原判定照常');
  eq(await call(byName('gui-c'), 'Bash'), { continue: true }, '别的工具 → 原判定照常');
  eq(nativeGuardLastFailure(), null, '正常检查不记失效');
  eq(await xsNativeGuard({ tool_name: 'SendMessage', tool_input: byName('gui-c') }, { sessionId: guiSid }), null, '发给自己 → 不拒');

  setEnabled(false);
  eq(await call(byName('gui-c')), { continue: true }, '偏好文件里开关关着 → 不管(即便钩子还挂着)');
  setEnabled(true);

  rmSync(REG, { recursive: true, force: true });
  const before = Date.now();
  eq(await call(byName('gui-c')), { continue: true }, '读不到登记表 → 放行');
  const at = nativeGuardLastFailure();
  ok(typeof at === 'string' && Date.parse(at) >= before - 5, `读不到登记表 → 记下 lastFailureAt(实际 ${at})`);

  syncXsRuntimeHooks(false);
  mkdirSync(REG, { recursive: true });
  writeFileSync(join(REG, '201.json'), JSON.stringify({ pid: 201, sessionId: guiSid, name: 'gui-c' }));
  eq(await call(byName('gui-c')), { continue: true }, 'syncXsRuntimeHooks(false) → 立即撤下');
} finally {
  try { closeAllPersistentProcesses(); } catch { /* */ }
  server.close();
}
console.log(`check-r151b-native-guard: ${passed} 项通过`);
process.exit(0);
