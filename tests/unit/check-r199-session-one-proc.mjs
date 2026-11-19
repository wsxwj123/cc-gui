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
// 输入预测默认关(没带这个字段时按官方供应商默认开:结果之后还有约 4 秒收尾窗,会把"上一轮 4 秒内结束"拖过 4 秒);第 19 条单独开。
const BODY = (extra) => ({ prompt: 'x', cwd: WORK, model: 'r199-model', permissionMode: 'default', keepAlive: true, promptSuggestions: false, ...extra });
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

  // ── T2 复用途中入口复核拒绝:只回一次应答、不起进程 ─────────────────────────────────────────
  // 早期核对(锁外)与锁内核对拒绝时都已回过应答,复用闭包必须交回 'handled'。交回别的会接着走等待段与冷启:
  // 冷启前那次核对会被再调一次(再回一次应答,或起进程)—— 核对次数与 SDK query() 次数据此能看出来。
  {
    const REJECT = { ok: false, code: 'R199_RECHECK_REJECT', error: '核对不通过' };
    let rejectFrom = Infinity; // 第几次核对起拒绝(Infinity = 一直放行)
    let recheckCalls = 0;
    const unhookEntry = registerSessionRuntimeHooks({
      chatEntry: (ctx) => ({
        prompt: String(ctx.body.prompt),
        recheck: () => (++recheckCalls >= rejectFrom ? { reject: { status: 409, body: REJECT } } : null),
      }),
    });
    try {
      for (const [label, from, n] of [['早期核对', 1, 21], ['锁内核对', 2, 22]]) {
        const S = uuid(n);
        rejectFrom = Infinity;
        const first = await api('/chat', BODY({ sessionId: S, prompt: `t2 ${n} first` }));
        eq(first.status, 200, `${label} 前置:起一个常驻进程`);
        await waitFor(() => snap(first.body.pid)?.idle, `${label} 前置:进程空闲`);
        recheckCalls = 0; rejectFrom = from;
        const queriesBefore = sdkCalls.length;
        const r = await api('/chat', BODY({ sessionId: S, prompt: `t2 ${n} reuse` }));
        eq([r.status, r.body], [409, REJECT], `${label}拒绝:回入口钩子给的应答`);
        await sleep(300);
        eq(recheckCalls, from, `${label}拒绝后不再往下走(核对只被调 ${from} 次,冷启前那次没被调)`);
        eq(sdkCalls.length, queriesBefore, `${label}拒绝:不起新进程`);
      }
    } finally { unhookEntry(); }
  }

  // ── T3 第 1、2、3、15 条:手上有一条还在跑的后台命令,命令行续跑(这一轮在运行)时发 /compact ──────────────
  {
    const S = uuid(1);
    const first = await api('/chat', BODY({ sessionId: S, prompt: 'p1 first [BG:b1]' }));
    eq(first.status, 200, '前置:起一个常驻进程');
    const P = first.body.pid;
    await waitFor(() => snap(P)?.idle && snap(P)?.liveTasks === 1, '前置:回合收尾、手上有一条后台命令');
    openGate('b1-revive');
    await waitFor(() => snap(P)?.busy, '前置:命令行续跑(这一轮在运行)');
    const COMPACT = BODY({ sessionId: S, prompt: '/compact', clientTurnId: 'r199-ct-1' });
    const c1 = await api('/chat', COMPACT);
    eq([c1.status, c1.body], [409, { ok: false, code: 'CHAT_SESSION_BUSY', reason: 'session-turn-running', pid: P, error: '会话这一轮还在运行' }],
      '第 1 条:新形态 409,应答体逐字');
    eq(typeof c1.body.pid, 'string', 'pid 是字符串');
    ok(c1.ms >= 3500 && c1.ms <= 5500, `第 1 条:先等约 4 秒再回(${c1.ms}ms)`);
    eq([snap(P)?.busy, alive(S)], [true, [P]], '第 1 条:那一轮没被中止,没另起进程(进程数 1)');
    openGate('b1-finish');
    await waitFor(() => snap(P)?.idle, '那一轮结束');
    const c2 = await api('/chat', COMPACT);
    eq([c2.status, c2.body.reused, c2.body.pid], [200, true, P], '第 2、15 条:同一 clientTurnId 原样重发 → 200,交给原进程');
    await waitFor(() => snap(P)?.idle, '压缩那一轮收尾');
    const c3 = await api('/chat', BODY({ sessionId: S, prompt: 'p1 after compact' }));
    eq([c3.status, c3.body.reused, c3.body.pid], [200, true, P], '第 3 条:之后的消息仍交给原进程');
    await waitFor(() => snap(P)?.idle, '收尾');
    eq(alive(S), [P], '第 1–3 条:进程数始终 1');
  }
  // 第 4、5 条:上一轮还在跑(上游慢、不跑命令)、4 秒内结束时发下一条 → 等到它结束,交给原进程
  {
    const S = uuid(4);
    const first = await api('/chat', BODY({ sessionId: S, prompt: 'p4 first' }));
    const P = first.body.pid;
    await waitFor(() => snap(P)?.idle, '前置:进程空闲');
    const a = await api('/chat', BODY({ sessionId: S, prompt: 'p4 a [W:g4]' }));
    eq([a.status, a.body.pid], [200, P], '前置:上一轮在原进程上跑');
    await waitFor(() => snap(P)?.busy, '前置:上一轮在跑');
    const pendingB = api('/chat', BODY({ sessionId: S, prompt: 'p4 b' }));
    await sleep(800);
    openGate('g4');
    const b = await pendingB;
    eq([b.status, b.body.reused, b.body.pid], [200, true, P], '第 4 条:上一轮 4 秒内结束 → 交给原进程');
    ok(b.ms < 3500, `等到上一轮结束就交,不等满 4 秒(${b.ms}ms)`);
    await waitFor(() => snap(P)?.idle, 'B 收尾');
    const c = await api('/chat', BODY({ sessionId: S, prompt: 'p4 c' }));
    eq([c.status, c.body.reused, c.body.pid], [200, true, P], '第 5 条:再发仍是原进程');
    await waitFor(() => snap(P)?.idle, 'C 收尾');
    eq(alive(S), [P], '第 4、5 条:进程数 1');
  }
  // 第 19 条:结果已出、还在等输入预测(收尾窗 4 秒,真定时器)时发下一条 → 等它收尾后交给原进程
  {
    const S = uuid(19);
    const a = await api('/chat', BODY({ sessionId: S, prompt: 'p19 a', promptSuggestions: true }));
    const P = a.body.pid;
    await waitFor(() => snap(P)?.awaitingSuggestion, '前置:结果已出、在等输入预测');
    const b = await api('/chat', BODY({ sessionId: S, prompt: 'p19 b', promptSuggestions: true }));
    eq([b.status, b.body.reused, b.body.pid], [200, true, P], '第 19 条:收尾后交给原进程');
    eq(alive(S), [P], '第 19 条:进程数 1');
  }
  // 第 12 条(回归):上一轮还在跑、手上没有命令、4 秒内没结束 → 照旧中止它,新进程处理这一条
  {
    const S = uuid(12);
    const a = await api('/chat', BODY({ sessionId: S, prompt: 'p12 a [W:g12]' }));
    const P = a.body.pid;
    await waitFor(() => snap(P)?.busy, '前置:上一轮在跑');
    const b = await fast(() => api('/chat', BODY({ sessionId: S, prompt: 'p12 b' })));
    eq(b.status, 200, '第 12 条:200');
    ok(b.body.pid !== P, `第 12 条:进程号变了(${P} → ${b.body.pid})`);
    await waitFor(() => alive(S).length === 1, '旧进程退出');
    eq(alive(S), [b.body.pid], '第 12 条:进程数 1');
    await waitFor(() => snap(b.body.pid)?.idle, '新进程这一轮收尾');
  }
  // 第 14 条(回归):普通连续对话,每一轮结束后再发 → 每条都 reused,进程号不变
  {
    const S = uuid(14);
    const first = await api('/chat', BODY({ sessionId: S, prompt: 'p14 first' }));
    const P = first.body.pid;
    for (const n of [1, 2, 3]) {
      await waitFor(() => snap(P)?.idle, `第 ${n} 条之前上一轮收尾`);
      const r = await api('/chat', BODY({ sessionId: S, prompt: `p14 ${n}` }));
      eq([r.status, r.body.reused, r.body.pid], [200, true, P], `第 14 条:第 ${n} 条复用原进程`);
    }
    eq(alive(S), [P], '第 14 条:进程数 1');
  }
  // 第 13、16 条:进程空闲、手上有后台命令,换工作目录 → 关旧开新(旧进程为后台命令挂着);新进程这一轮在跑(不跑命令)、
  // 4 秒内没结束时再发 → 挂着的旧进程不挡判断:照第 12 条中止新进程另起;再发 → 交给最新的那个。
  {
    const S = uuid(16);
    const first = await api('/chat', BODY({ sessionId: S, prompt: 'p16 first [BG:b16]' }));
    const P1 = first.body.pid;
    await waitFor(() => snap(P1)?.idle && snap(P1)?.liveTasks === 1, '前置:空闲、手上有后台命令');
    const a = await api('/chat', BODY({ sessionId: S, prompt: 'p16 a [W:g16]', cwd: WORK2 }));
    eq(a.status, 200, '换工作目录后发一条:200');
    const P2 = a.body.pid;
    ok(P2 !== P1, `第 13 条:关旧开新(${P1} → ${P2})`);
    eq([snap(P1)?.exitCode, snap(P1)?.usable], [null, false], '旧进程为后台命令挂着(活着、不再接消息)');
    await waitFor(() => snap(P2)?.busy, '前置:新进程这一轮在跑');
    const b = await fast(() => api('/chat', BODY({ sessionId: S, prompt: 'p16 b', cwd: WORK2 })));
    eq(b.status, 200, '第 16 条:200');
    const P3 = b.body.pid;
    ok(P3 !== P1 && P3 !== P2, `第 16 条:进程号与前两个都不同(${P1} / ${P2} / ${P3})`);
    await waitFor(() => snap(P3)?.idle, '最新进程这一轮收尾');
    const c = await api('/chat', BODY({ sessionId: S, prompt: 'p16 c', cwd: WORK2 }));
    eq([c.status, c.body.pid], [200, P3], '第 16 条:再发一条 → 交给最新的那个');
    await waitFor(() => !alive(S).includes(P2), '被中止的新进程退出');
    eq(alive(S).sort(), [P1, P3].sort(), '第 16 条:进程数 2(含为后台命令挂着的旧进程)');
  }

  console.log(`✓ check-r199-session-one-proc:${checks} 项断言全部通过`);
} finally {
  try { await closeAllPersistentProcesses(); } catch { /* 收尾 */ }
  server.close();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 收尾 */ }
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}
