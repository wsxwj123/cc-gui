// r196 POST /api/chat 可选字段 queuedDrain(页面后台排空才带;服务端白盒单测,驱动真实 chatRoute + SDK 桩)。
//   Q1 不带这个字段(或不是布尔 true)时三条路径与改前相同:会话文件不在照常起进程;在跑、手上没有命令、到点没结束 → 中止另起;
//      在跑、手上有后台命令 → 等约 4 秒回新形态 409。
//   Q2 带它、会话文件不在 → 404 CHAT_SESSION_GONE,不起进程、不留回合记录;按工作目录编码查(另一个工作区的同名文件不算);
//      软链接路径两种编码任一存在即通过;sessionId 缺失或不是会话编号格式 → 404。
//   Q3 带它、这一轮在跑且手上没有命令 → 照旧先等约 4 秒,等满仍在跑回新形态 409(reason + 字符串 pid),那一轮不被中止;
//      4 秒内结束 → 交给原进程。
// 契约值一律写字面量,不 import 产品常量。node tests/unit/check-r196-queued-drain-server.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r196-queued-drain-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work'); const WORK2 = join(TMP, 'work2');
const WORK_LINK = join(TMP, 'work-link'); // 软链接 → WORK:规范路径编码与原样路径编码不同
for (const d of [join(HOME, '.claude', 'sessions'), join(HOME, '.claude-gui'), BIN, WORK, WORK2]) mkdirSync(d, { recursive: true });
symlinkSync(WORK, WORK_LINK);
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
const { getActiveChatProcesses, closeAllPersistentProcesses } = chat;

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
// 发请求期间把 Date.now 调成 10 倍速:冷启前 4 秒等待按 Date.now 算,约 0.4 秒到点
const realNow = Date.now;
async function fast(fn) {
  const r0 = realNow();
  Date.now = () => r0 + (realNow() - r0) * 10;
  try { return await fn(); } finally { Date.now = realNow; }
}
const snap = (pid) => getActiveChatProcesses().find((p) => p.pid === pid);
const alive = (sid) => getActiveChatProcesses().filter((p) => p.sessionId === sid && p.exitCode === null).map((p) => p.pid);
const uuid = (n) => `e196e196-0000-4000-8000-${String(n).padStart(12, '0')}`;
// 会话文件:projects/<工作目录编码>/<sid>.jsonl(编码 = 非字母数字一律换成 -)
const touchSession = (dirForEncoding, sid) => {
  const dir = join(HOME, '.claude', 'projects', String(dirForEncoding).replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), '{"type":"summary"}\n');
};
const BODY = (extra) => ({ prompt: 'x', cwd: WORK, model: 'r196-model', permissionMode: 'default', keepAlive: true, promptSuggestions: false, ...extra });
const GONE_404 = { ok: false, code: 'CHAT_SESSION_GONE', error: '会话记录不存在' };
const busyNew = (pid) => ({ ok: false, code: 'CHAT_SESSION_BUSY', reason: 'session-turn-running', pid, error: '会话这一轮还在运行' });
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// SDK 桩的回合控制(按提示原文里的标记,同 check-r199-session-one-proc):
//   [W:名字]  这一轮等闸「名字」开了才出回复;[BG:名字] 结果之后登记一条后台命令,闸「名字-revive」开了续跑,「名字-finish」开了续跑结束。
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
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: `msg_r196_${name}`, type: 'message', role: 'assistant', model: 'r196-model', content: [{ type: 'text', text: '续跑' }], stop_reason: 'end_turn', stop_sequence: null, usage: USAGE } };
    await gate(`${name}-finish`).p;
    yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: '续跑完', total_cost_usd: 0, permission_denials: [], modelUsage: {}, usage: USAGE };
  })();
};

try {
  // ── Q1 不带 queuedDrain:三条路径与改前相同 ───────────────────────────────────────────────
  // 路径一:会话文件不在 → 照常起进程(不回 404);字段不是布尔 true 时同样当作没带。
  for (const [n, extra] of [[101, {}], [102, { queuedDrain: false }], [103, { queuedDrain: 'true' }], [104, { queuedDrain: 1 }]]) {
    const S = uuid(n);
    const before = sdkCalls.length;
    const r = await api('/chat', BODY({ sessionId: S, prompt: `q1 ${n}`, ...extra }));
    eq([r.status, r.body.ok, typeof r.body.pid], [200, true, 'string'], `Q1 路径一(${JSON.stringify(extra)}):会话文件不在照常起进程`);
    eq(sdkCalls.length, before + 1, `Q1 路径一(${JSON.stringify(extra)}):起了一个进程`);
    await waitFor(() => snap(r.body.pid)?.idle, `Q1 路径一 ${n} 收尾`);
  }
  // 路径二:在跑、手上没有命令、4 秒内没结束 → 照旧中止它,新进程处理这一条(会话文件在不在都一样,这里放上文件)
  {
    const S = uuid(110);
    touchSession(WORK, S);
    const a = await api('/chat', BODY({ sessionId: S, prompt: 'q1 p2 a [W:q1g2]' }));
    const P = a.body.pid;
    await waitFor(() => snap(P)?.busy, 'Q1 路径二前置:上一轮在跑');
    const b = await fast(() => api('/chat', BODY({ sessionId: S, prompt: 'q1 p2 b' })));
    eq(b.status, 200, 'Q1 路径二:200');
    ok(b.body.pid !== P, `Q1 路径二:进程号变了(${P} → ${b.body.pid})`);
    await waitFor(() => alive(S).length === 1, 'Q1 路径二:旧进程退出');
    eq(alive(S), [b.body.pid], 'Q1 路径二:进程数 1');
    await waitFor(() => snap(b.body.pid)?.idle, 'Q1 路径二:新进程收尾');
  }
  // 路径三:在跑、手上有后台命令(命令行续跑)→ 等约 4 秒回新形态 409,不中止
  {
    const S = uuid(120);
    touchSession(WORK, S);
    const first = await api('/chat', BODY({ sessionId: S, prompt: 'q1 p3 first [BG:q1b3]' }));
    const P = first.body.pid;
    await waitFor(() => snap(P)?.idle && snap(P)?.liveTasks === 1, 'Q1 路径三前置:收尾、手上有后台命令');
    openGate('q1b3-revive');
    await waitFor(() => snap(P)?.busy, 'Q1 路径三前置:续跑中');
    const c = await fast(() => api('/chat', BODY({ sessionId: S, prompt: 'q1 p3 next' })));
    eq([c.status, c.body], [409, busyNew(P)], 'Q1 路径三:新形态 409,应答体逐字');
    eq([snap(P)?.busy, alive(S)], [true, [P]], 'Q1 路径三:那一轮没被中止,进程数 1');
    openGate('q1b3-finish');
    await waitFor(() => snap(P)?.idle, 'Q1 路径三:续跑结束');
  }

  // ── Q2 带 queuedDrain、会话文件不在 → 404,不起进程、不留回合记录 ──────────────────────────────────
  {
    const S = uuid(201);
    const DRAIN = BODY({ sessionId: S, prompt: 'q2 drain', clientTurnId: 'r196-gone-1', queuedDrain: true });
    const before = sdkCalls.length;
    const r = await api('/chat', DRAIN);
    eq([r.status, r.body], [404, GONE_404], 'Q2:会话文件不在 → 404,应答体逐字');
    eq([sdkCalls.length, alive(S)], [before, []], 'Q2:不起进程');
    // 只有另一个工作区里有同名会话文件 → 仍是 404(按本请求工作目录的编码查,与 --resume 同口径)
    touchSession(WORK2, S);
    const r2 = await api('/chat', DRAIN);
    eq([r2.status, r2.body], [404, GONE_404], 'Q2:别的工作区里的同名文件不算');
    eq(sdkCalls.length, before, 'Q2:仍不起进程');
    // 不留回合记录:文件补上之后同一 clientTurnId 原样重发 → 当新回合受理(不是命中旧记录的 duplicated)
    touchSession(WORK, S);
    const r3 = await api('/chat', DRAIN);
    eq([r3.status, r3.body.ok, r3.body.duplicated], [200, true, undefined], 'Q2:同号重发当新回合受理(之前没留回合记录)');
    eq(sdkCalls.length, before + 1, 'Q2:这一次才起进程');
    await waitFor(() => snap(r3.body.pid)?.idle, 'Q2:收尾');
  }
  // sessionId 缺失或不是会话编号格式 → 404,不起进程
  for (const [label, sid] of [['缺 sessionId', undefined], ['不是会话编号格式', '../../etc/passwd'], ['草稿键', 'draft-abc']]) {
    const before = sdkCalls.length;
    const r = await api('/chat', BODY({ sessionId: sid, prompt: 'q2 bad sid', queuedDrain: true }));
    eq([r.status, r.body], [404, GONE_404], `Q2 ${label}:404`);
    eq(sdkCalls.length, before, `Q2 ${label}:不起进程`);
  }
  // 软链接路径:会话文件放在规范路径的编码下、或放在原样路径的编码下,都算存在
  for (const [n, encodeBy] of [[211, WORK], [212, WORK_LINK]]) {
    const S = uuid(n);
    touchSession(encodeBy, S);
    const r = await api('/chat', BODY({ sessionId: S, prompt: `q2 link ${n}`, cwd: WORK_LINK, queuedDrain: true }));
    eq([r.status, r.body.ok], [200, true], `Q2 软链接(文件在 ${encodeBy === WORK ? '规范路径' : '原样路径'}编码下):受理`);
    await waitFor(() => snap(r.body.pid)?.idle, `Q2 软链接 ${n} 收尾`);
  }

  // ── Q3 带 queuedDrain、在跑且手上没有命令 → 等满约 4 秒仍在跑回新形态 409,不中止 ─────────────────────
  {
    const S = uuid(301);
    touchSession(WORK, S);
    const a = await api('/chat', BODY({ sessionId: S, prompt: 'q3 a [W:q3g1]' }));
    const P = a.body.pid;
    await waitFor(() => snap(P)?.busy, 'Q3 前置:这一轮在跑');
    const before = sdkCalls.length;
    const b = await api('/chat', BODY({ sessionId: S, prompt: 'q3 drain', queuedDrain: true }));
    eq([b.status, b.body], [409, busyNew(P)], 'Q3:新形态 409,应答体逐字');
    eq(typeof b.body.pid, 'string', 'Q3:pid 是字符串');
    ok(b.ms >= 3500 && b.ms <= 5500, `Q3:先等约 4 秒再回(${b.ms}ms)`);
    eq([snap(P)?.busy, alive(S), sdkCalls.length], [true, [P], before], 'Q3:那一轮没被中止,没另起进程');
    openGate('q3g1');
    await waitFor(() => snap(P)?.idle, 'Q3:那一轮正常结束');
    // 4 秒内结束 → 交给原进程(与不带字段时相同)
    const c = await api('/chat', BODY({ sessionId: S, prompt: 'q3 c [W:q3g2]' }));
    eq([c.status, c.body.pid], [200, P], 'Q3 前置:下一轮在原进程上跑');
    await waitFor(() => snap(P)?.busy, 'Q3 前置:下一轮在跑');
    const pending = api('/chat', BODY({ sessionId: S, prompt: 'q3 drain 2', queuedDrain: true }));
    await sleep(800);
    openGate('q3g2');
    const d = await pending;
    eq([d.status, d.body.reused, d.body.pid], [200, true, P], 'Q3:4 秒内结束 → 交给原进程');
    await waitFor(() => snap(P)?.idle, 'Q3:收尾');
    eq(alive(S), [P], 'Q3:进程数始终 1');
  }

  console.log(`✓ check-r196-queued-drain-server:${checks} 项断言全部通过`);
} finally {
  try { await closeAllPersistentProcesses(); } catch { /* 收尾 */ }
  server.close();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 收尾 */ }
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}
