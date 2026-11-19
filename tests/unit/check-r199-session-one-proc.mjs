// r199 一个会话同一时间只有一个能接新消息的命令行进程(服务端白盒单测,驱动真实 chatRoute + SDK 桩)。
//   T1 旧形态 409 逐字不变:同会话有别的请求正在派发(占位)→ 409 只带 ok / code / error(第 17 条);跨会话回合占着 → 同上(第 9 条)。
//   T2 复用块包成闭包后,复用途中入口复核拒绝:只回一次应答、不起进程(早期核对 / 锁内核对两处)。
//   T3 第 1–5、12、14–16、19 条:在忙带命令 → 等约 4 秒回新形态 409(reason + 字符串 pid);4 秒内收尾 → 交给原进程;
//      不带命令到点 → 照旧中止另起;关旧开新后为后台命令挂着的旧进程不挡判断。
// 契约值一律写字面量,不 import 产品常量。node tests/unit/check-r199-session-one-proc.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r199-one-proc-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work'); const WORK2 = join(TMP, 'work2');
for (const d of [join(HOME, '.claude', 'sessions'), join(HOME, '.claude-gui'), BIN, WORK, WORK2]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;

registerR151bSdkStub();
const ctl = (globalThis.__r151bSdkControl = {});
const sdkCalls = globalThis.__r151bSdkCalls;
const { default: express } = await import('express');
const chat = await import('../../server/routes/chat.js');
const { registerSessionRuntimeHooks, startInternalTurn, getActiveChatProcesses, closeAllPersistentProcesses } = chat;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 8000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = pred(); if (v) return v; await sleep(20); }
  throw new Error(`等不到:${what}`);
}
async function listenFree(app) {
  for (let p = 6999; p >= 6900; p--) {
    const s = await new Promise((r) => { const srv = app.listen(p, '127.0.0.1'); srv.once('listening', () => r(srv)).once('error', () => r(null)); });
    if (s) return { server: s, port: p };
  }
  throw new Error('6900-6999 没有空闲端口');
}
const app = express();
app.use(express.json());
app.use('/api', chat.default);
const { server, port } = await listenFree(app);
const api = async (path, body) => {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json(), ms: Date.now() - t0 };
};
// 发请求期间把 Date.now 调成 10 倍速:冷启前 4 秒等待按 Date.now 算,约 0.4 秒到点(收尾窗等真定时器不受影响)
const realNow = Date.now;
async function fast(fn) {
  const r0 = realNow();
  Date.now = () => r0 + (realNow() - r0) * 10;
  try { return await fn(); } finally { Date.now = realNow; }
}
const snap = (pid) => getActiveChatProcesses().find((p) => p.pid === pid);
const alive = (sid) => getActiveChatProcesses().filter((p) => p.sessionId === sid && p.exitCode === null).map((p) => p.pid);
const uuid = (n) => `d1d1d1d1-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BODY = (extra) => ({ prompt: 'x', cwd: WORK, model: 'r199-model', permissionMode: 'default', keepAlive: true, ...extra });
const OLD_409 = { ok: false, code: 'CHAT_SESSION_BUSY', error: '会话正在运行' };
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// SDK 桩的回合控制(按提示原文里的标记):
//   [W:名字]  这一轮等闸「名字」开了才出回复(上游慢,不跑命令);
//   [BG:名字] 结果之后登记一条后台 Bash 命令(task_started local_bash),闸「名字-revive」开了吐一条主 agent 正文(续跑),
//             闸「名字-finish」开了吐续跑的结果。闸不开时桩停在这里、不读新输入(关输入也不退出 = 为后台命令挂着)。
const gates = new Map();
const gate = (name) => {
  if (!gates.has(name)) { let open; const p = new Promise((r) => { open = r; }); gates.set(name, { p, open }); }
  return gates.get(name);
};
const openGate = (name) => gate(name).open();
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
ctl.reply = (input) => {
  const m = /\[W:([\w-]+)\]/.exec(String(input?.message?.content));
  return m ? gate(m[1]).p.then(() => 'ok') : 'ok';
};
ctl.afterResult = (record) => {
  const m = /\[BG:([\w-]+)\]/.exec(String(record.inputs.at(-1)?.message?.content));
  if (!m) return null;
  const name = m[1];
  return (async function* () {
    yield { type: 'system', subtype: 'task_started', task_id: `task-${name}`, tool_use_id: `tu-${name}`, task_type: 'local_bash', description: 'sleep 100' };
    await gate(`${name}-revive`).p;
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: `msg_r199_${name}`, type: 'message', role: 'assistant', model: 'r199-model', content: [{ type: 'text', text: '续跑' }], stop_reason: 'end_turn', stop_sequence: null, usage: USAGE } };
    await gate(`${name}-finish`).p;
    yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: '续跑完', total_cost_usd: 0, permission_denials: [], modelUsage: {}, usage: USAGE };
  })();
};

try {
  // ── T1 旧形态 409 逐字不变 ──────────────────────────────────────────────────────────────
  // 第 17 条:进程空闲时两条几乎同时到 —— 前一条选中进程、换模型途中(桩把换模型挡住)后一条到 → 409 旧形态,前一条照常复用。
  {
    const S = uuid(17);
    const first = await api('/chat', BODY({ sessionId: S, prompt: 'p17 first' }));
    eq(first.status, 200, '前置:起一个常驻进程');
    const P = first.body.pid;
    await waitFor(() => snap(P)?.idle, '前置:进程空闲');
    let releaseSwitch = null;
    ctl.setModel = () => new Promise((r) => { releaseSwitch = r; });
    const pending = api('/chat', BODY({ sessionId: S, prompt: 'p17 a', model: 'r199-other' }));
    await waitFor(() => releaseSwitch, '前一条选中进程、正在换模型');
    const b = await api('/chat', BODY({ sessionId: S, prompt: 'p17 b' }));
    eq([b.status, b.body], [409, OLD_409], '后一条 409:应答体逐字是旧形态(没有 reason、没有 pid)');
    ok(b.ms < 1500, `占位时立即回(${b.ms}ms)`);
    delete ctl.setModel;
    releaseSwitch();
    const a = await pending;
    eq([a.status, a.body.reused, a.body.pid], [200, true, P], '前一条照常复用原进程');
    await waitFor(() => snap(P)?.idle, '前一条收尾');
    eq(alive(S), [P], '进程数 1');
  }
  // 第 9 条(回归):跨会话自动处理的回合占着会话 → 用户消息立即 409 旧形态
  {
    const S = uuid(9);
    const auto = await startInternalTurn(BODY({ sessionId: S, prompt: 'auto [W:g9]' }), { kind: 'xs-auto-test' });
    eq(auto.status, 200, '前置:跨会话回合起来了');
    await waitFor(() => snap(auto.body.pid)?.busy, '前置:跨会话回合在跑');
    const u = await api('/chat', BODY({ sessionId: S, prompt: 'user while auto' }));
    eq([u.status, u.body], [409, OLD_409], '用户消息 409:旧形态逐字不变');
    ok(u.ms < 1500, `立即回(${u.ms}ms)`);
    eq([snap(auto.body.pid)?.busy, alive(S)], [true, [auto.body.pid]], '跨会话回合没被中止,进程数 1');
    openGate('g9');
    await waitFor(() => snap(auto.body.pid)?.idle, '跨会话回合收尾');
  }

  // @@T2@@

  // @@T3@@

  console.log(`✓ check-r199-session-one-proc:${checks} 项断言全部通过`);
} finally {
  try { await closeAllPersistentProcesses(); } catch { /* 收尾 */ }
  server.close();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 收尾 */ }
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}
