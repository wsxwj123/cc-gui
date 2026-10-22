// r151q 第 9 项(安全复审后):跨会话回合复用常驻进程时的停止。
//   跨会话回合不带 clientTurnId,复用进程时没有自己的回合记录,pid 上挂的还是上一条用户回合留下的(已结束,保留 24 小时)。
//   ① 槽上当前回合是跨会话回合:界面带旧 owner 停止 → 停下它(stopped:true),旧记录不改写;随后用户消息 200;别的 owner 仍 409 RUN_STALE。
//   ② 当前回合是另一条用户回合(有自己的记录):带旧回合身份停止仍 409 RUN_STALE、不停。
//   ③ 当前回合是用户回合但没带 clientTurnId(没有自己的记录):原有核对不变 —— 旧记录已结束,回终态、不停(收紧版的范围)。
//   ④ 跨会话回合复用进程后复活续跑:上一条用户回合的记录不被翻回"在跑";此时停止照样停下跨会话回合。
// node tests/unit/check-r151q-stop-internal-reuse.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151q-stopreuse-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
for (const d of [join(HOME, '.claude', 'sessions'), join(HOME, '.claude-gui'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;

registerR151bSdkStub();
const ctl = (globalThis.__r151bSdkControl = {});
const { default: express } = await import('express');
const chat = await import('../../server/routes/chat.js');
const { registerSessionRuntimeHooks, startInternalTurn, getActiveChatProcesses, closeAllPersistentProcesses, findTurnRecord } = chat;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 8000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = pred(); if (v) return v; await sleep(20); }
  throw new Error(`等不到:${what}`);
}
// 端口只在 6900–6999 里挑空闲的;listen 撞上被占就换一个重试。
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
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const snap = (pid) => getActiveChatProcesses().find((p) => p.pid === pid);
const uuid = (n) => `d7d7d7d7-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BODY = (extra) => ({ prompt: 'x', cwd: WORK, model: 'r151q-model', permissionMode: 'default', keepAlive: true, ...extra });
const INTERNAL = { kind: 'xs-auto-test' };
const turnRec = (id) => findTurnRecord('local', id);
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
// 提示词带 CONT:结果之后主 agent 先停着,wake 打开才续跑(一条顶层 assistant),finish 打开才出续跑的结果。
const conts = new Map();
ctl.reply = (input) => (String(input?.message?.content).includes('HOLD') ? 'hold' : 'ok');
ctl.afterResult = (rec) => {
  const text = String(rec.inputs.at(-1)?.message?.content);
  if (!text.includes('CONT')) return null;
  const c = { wake: gate(), finish: gate() };
  conts.set(text, c);
  return (async function* () {
    await c.wake.p;
    yield {
      type: 'assistant', parent_tool_use_id: null,
      message: { id: `msg_cont_${conts.size}`, type: 'message', role: 'assistant', model: 'r151q-model', content: [{ type: 'text', text: '续跑' }], stop_reason: 'end_turn', stop_sequence: null, usage: USAGE },
    };
    await c.finish.p;
    yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: '续跑完', total_cost_usd: 0, permission_denials: [], modelUsage: {}, usage: USAGE };
  })();
};
const unhook = registerSessionRuntimeHooks({ turnStart: () => {}, turnEnd: () => {} });

// 前置:会话先跑完一条带 clientTurnId 的用户回合,留下空闲的常驻进程与那条已结束的记录
async function userTurnThenIdle(sessionId, clientTurnId) {
  const r = await api('/chat', BODY({ sessionId, clientTurnId, prompt: `user ${clientTurnId}` }));
  eq(r.status, 200, `前置:用户回合 ${clientTurnId} 起来了`);
  await waitFor(() => snap(r.body.pid)?.idle, `前置:用户回合 ${clientTurnId} 收尾`);
  eq(turnRec(clientTurnId)?.status, 'completed', `前置:${clientTurnId} 的记录已结束`);
  return r.body.pid;
}

try {
  // ── ① 跨会话回合复用进程,界面带旧 owner 停止 ─────────────────────────────────────────
  const S1 = uuid(1);
  const p1 = await userTurnThenIdle(S1, 'r151q-stop-a1');
  const auto = await startInternalTurn(BODY({ sessionId: S1, prompt: 'auto HOLD' }), INTERNAL);
  eq([auto.status, auto.body.pid, auto.body.reused], [200, p1, true], '跨会话回合复用了这个进程');
  await waitFor(() => snap(p1)?.busy, '跨会话回合在跑');
  const foreign = await api(`/chat/${p1}/stop`, { owner: uuid(90) });
  eq([foreign.status, foreign.body.code], [409, 'RUN_STALE'], '别的会话的 owner 仍 409 RUN_STALE');
  eq(snap(p1)?.busy, true, '身份不符没停它');
  const stop1 = await api(`/chat/${p1}/stop`, { owner: S1 });
  eq([stop1.status, stop1.body.ok, stop1.body.stopped], [200, true, true], `带旧 owner 停止 → 停下跨会话回合(${JSON.stringify(stop1.body)})`);
  await waitFor(() => !snap(p1)?.busy, '跨会话回合已停下', 15000);
  eq([turnRec('r151q-stop-a1')?.status, turnRec('r151q-stop-a1')?.stopRequested], ['completed', false], '上一条用户回合的记录没被改写');
  const after1 = await api('/chat', BODY({ sessionId: S1, prompt: 'user after stop' }));
  eq(after1.status, 200, '随后用户消息照常起回合');
  await waitFor(() => snap(after1.body.pid)?.idle, '用户回合收尾');

  // ── ② 当前回合是另一条用户回合(有自己的记录):带旧回合身份停止 → RUN_STALE、不停 ───────────────
  const S2 = uuid(2);
  const p2 = await userTurnThenIdle(S2, 'r151q-stop-b1');
  const u2 = await api('/chat', BODY({ sessionId: S2, clientTurnId: 'r151q-stop-b2', prompt: 'user HOLD b2' }));
  eq([u2.status, u2.body.pid, u2.body.reused], [200, p2, true], '另一条用户回合复用了这个进程');
  await waitFor(() => snap(p2)?.busy, '另一条用户回合在跑');
  const stale = await api(`/chat/${p2}/stop`, { owner: S2, clientTurnId: 'r151q-stop-b1' });
  eq([stale.status, stale.body.code], [409, 'RUN_STALE'], '带旧回合身份停止 → 409 RUN_STALE');
  await sleep(300);
  eq([snap(p2)?.busy, turnRec('r151q-stop-b2')?.stopRequested], [true, false], '没停它');

  // ── ③ 当前回合是用户回合但没有自己的记录:原有核对不变(旧记录已结束 → 回终态、不停)────────────────
  const S3 = uuid(3);
  const p3 = await userTurnThenIdle(S3, 'r151q-stop-c1');
  const u3 = await api('/chat', BODY({ sessionId: S3, prompt: 'user HOLD no id' }));
  eq([u3.status, u3.body.pid], [200, p3], '不带 clientTurnId 的用户回合复用了这个进程');
  await waitFor(() => snap(p3)?.busy, '这条用户回合在跑');
  const st3 = await api(`/chat/${p3}/stop`, { owner: S3 });
  eq([st3.status, st3.body.stopped, st3.body.status], [200, false, 'completed'], '用户回合照旧以记录为准:回终态、不停');
  await sleep(300);
  eq(snap(p3)?.busy, true, '没停它');

  // ── ④ 跨会话回合复用进程后复活续跑:旧记录不翻回"在跑",停止照样停下它 ──────────────────────────
  const S4 = uuid(4);
  const p4 = await userTurnThenIdle(S4, 'r151q-stop-d1');
  const rv = await startInternalTurn(BODY({ sessionId: S4, prompt: 'auto REVIVE CONT' }), INTERNAL);
  eq([rv.status, rv.body.pid], [200, p4], '跨会话回合复用了这个进程');
  await waitFor(() => snap(p4)?.idle && conts.has('auto REVIVE CONT'), '跨会话回合(中间结果)收尾、转空闲');
  conts.get('auto REVIVE CONT').wake.open();
  await waitFor(() => snap(p4)?.busy, '主 agent 复活续跑');
  const d1 = turnRec('r151q-stop-d1');
  eq([d1?.status, !!d1?.settledAt], ['completed', true], '上一条用户回合的记录没被翻回"在跑"');
  const stop4 = await api(`/chat/${p4}/stop`, { owner: S4 });
  eq([stop4.status, stop4.body.stopped], [200, true], '复活续跑的跨会话回合带旧 owner 也能停下');
  await waitFor(() => !snap(p4)?.busy, '续跑已停下', 15000);
  eq(turnRec('r151q-stop-d1')?.status, 'completed', '旧记录仍是 completed');

  console.log(`PASS check-r151q-stop-internal-reuse(${checks} 项)`);
} finally {
  unhook?.();
  try { await closeAllPersistentProcesses(); } catch { /* 收尾 */ }
  server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}
