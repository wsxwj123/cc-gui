// r151q 第 9 项(服务端):用户消息与跨会话内部回合抢同一会话。
//   ① 内部回合在跑 → 用户 /chat 立即 409 CHAT_SESSION_BUSY,内部回合不被中止;该会话记"用户在等",期间新的内部回合 409;
//   ② 内部回合冷启时还在等旧进程退出(占位期)→ 用户 /chat 同样立即 409,不等待、不中止;旧进程退出后内部回合照常起来;
//   ③ 用户回合开始 → "用户在等"清掉;用户自己的回合仍可被后到的用户消息打断(原语义不变,只抽查 200)。
//   ④ 内部回合结果已出、只差输入预测(收尾窗最长约 4 秒)不算在跑:用户 /chat 等它收尾;到点仍没收尾 → 409,不强制中止它。
// node tests/unit/check-r151q-busy-internal.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151q-busy-')));
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
const { registerSessionRuntimeHooks, startInternalTurn, getActiveChatProcesses, closeAllPersistentProcesses, userWaitingOnSession } = chat;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 8000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = pred(); if (v) return v; await sleep(20); }
  throw new Error(`等不到:${what}`);
}
// 端口只在 6900–6999 里挑空闲的;listen 撞上被占(探测与监听之间被别人拿走)就换一个重试。
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
const snap = (pid) => getActiveChatProcesses().find((p) => p.pid === pid);
const uuid = (n) => `c9c9c9c9-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BODY = (extra) => ({ prompt: 'x', cwd: WORK, model: 'r151q-model', permissionMode: 'default', keepAlive: true, ...extra });
const INTERNAL = { kind: 'xs-auto-test' };
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const ends = [];
const unhook = registerSessionRuntimeHooks({ turnStart: () => {}, turnEnd: (info) => ends.push(info) });
ctl.reply = (input) => (String(input?.message?.content).includes('HOLD') ? 'hold' : 'ok');

try {
  // ── ① 内部回合在跑 ──────────────────────────────────────────────────────────────
  const S1 = uuid(1);
  const auto = await startInternalTurn(BODY({ sessionId: S1, prompt: 'auto HOLD' }), INTERNAL);
  eq(auto.status, 200, '内部回合起来了');
  const autoPid = auto.body.pid;
  await waitFor(() => snap(autoPid)?.busy, '内部回合在跑(busy)');
  eq(userWaitingOnSession(S1), false, '一开始没有"用户在等"');
  const user1 = await api('/chat', BODY({ sessionId: S1, prompt: 'user while auto' }));
  eq([user1.status, user1.body.ok, user1.body.code, typeof user1.body.error], [409, false, 'CHAT_SESSION_BUSY', 'string'], '用户 /chat 遇内部回合 → 409 CHAT_SESSION_BUSY');
  ok(user1.ms < 1500, `立即回(${user1.ms}ms),不等 4 秒`);
  await sleep(300);
  eq([snap(autoPid)?.busy, ends.filter((e) => e.pid === autoPid).length], [true, 0], '内部回合没被中止(仍在跑、没有结束通知)');
  eq(userWaitingOnSession(S1), true, '409 之后该会话"用户在等"');
  eq(userWaitingOnSession(S1.toUpperCase()), true, '会话 id 不分大小写');
  const auto2 = await startInternalTurn(BODY({ sessionId: S1, prompt: 'auto again' }), INTERNAL);
  eq([auto2.status, auto2.body.code], [409, 'CHAT_SESSION_BUSY'], '"用户在等"期间新的内部回合 409(退回排队)');
  // 用户点停止 / 内部回合结束之后,用户消息照常起回合,并清掉"用户在等"
  const stop = await api(`/chat/${autoPid}/stop`, {});
  ok(stop.status < 500, `停止内部回合(${stop.status})`);
  await waitFor(() => !snap(autoPid)?.busy, '内部回合已停下', 15000);
  const user2 = await api('/chat', BODY({ sessionId: S1, prompt: 'user after auto' }));
  eq(user2.status, 200, '会话空闲后用户消息照常起回合');
  eq(userWaitingOnSession(S1), false, '用户回合开始 → "用户在等"清掉');
  await waitFor(() => snap(user2.body.pid)?.idle, '用户回合收尾');

  // ── ② 冷启占位期:旧进程不能复用、迟迟不退,内部回合停在"等旧进程退出" ──────────────────────
  const S2 = uuid(2);
  const first = await api('/chat', BODY({ sessionId: S2, prompt: 'user first' }));
  eq(first.status, 200, '前置:S2 有一个空闲的常驻进程');
  const oldPid = first.body.pid;
  await waitFor(() => snap(oldPid)?.idle, '前置:旧进程空闲');
  let releaseOld = null;
  const asked = [];
  ctl.onInputEnd = (rec) => { asked.push(rec); return new Promise((r) => { releaseOld = r; }); }; // 被要求退出(关输入)后先不退
  const autoCold = startInternalTurn(BODY({ sessionId: S2, prompt: 'auto cold', effort: 'high' }), INTERNAL); // effort 不同 → 不能复用
  await waitFor(() => asked.length > 0, '前置:内部回合换下旧进程(关了它的输入)');
  const user3 = await api('/chat', BODY({ sessionId: S2, prompt: 'user during hold', effort: 'high' }));
  eq([user3.status, user3.body.code], [409, 'CHAT_SESSION_BUSY'], '占位期用户 /chat → 409 CHAT_SESSION_BUSY');
  ok(user3.ms < 1500, `占位期立即回(${user3.ms}ms)`);
  ok(snap(oldPid) && !snap(oldPid).busy, '旧进程仍在收尾(没被这条用户消息动过)');
  eq(userWaitingOnSession(S2), true, '占位期被拒也记"用户在等"');
  delete ctl.onInputEnd;
  releaseOld();
  const coldOut = await autoCold;
  eq(coldOut.status, 200, '旧进程退出后内部回合照常起来');
  await waitFor(() => snap(coldOut.body.pid)?.idle, '内部回合跑完');
  const user4 = await api('/chat', BODY({ sessionId: S2, prompt: 'user after cold', effort: 'high' }));
  eq(user4.status, 200, '内部回合跑完后用户消息照常起回合');
  eq(userWaitingOnSession(S2), false, '用户回合开始 → "用户在等"清掉');

  // ── ④ 只差输入预测的收尾窗:用户请求先等,到点仍没收尾 → 409,不中止 ─────────────────────────────
  // 收尾窗是真定时器(结果后 4 秒),用户请求的等待上限按 Date.now 算:发请求期间把 Date.now 调成 10 倍速,
  // 等待上限约 0.4 秒就到点,而收尾窗离结束还有 3 秒多 —— "到点仍未收尾"是确定的,不靠赛跑。
  const S3 = uuid(3);
  const tail = await startInternalTurn(BODY({ sessionId: S3, prompt: 'auto tail', promptSuggestions: true }), INTERNAL);
  eq(tail.status, 200, '内部回合起来了(开着输入预测)');
  const tailPid = tail.body.pid;
  await waitFor(() => snap(tailPid)?.awaitingSuggestion, '内部回合结果已出、只差输入预测');
  eq(snap(tailPid).busy, true, '收尾窗里槽仍是 busy(只是跨会话判定按空闲算)');
  const realNow = Date.now;
  const r0 = realNow();
  let user5;
  try {
    Date.now = () => r0 + (realNow() - r0) * 10;
    user5 = await api('/chat', BODY({ sessionId: S3, prompt: 'user during suggestion tail' }));
  } finally {
    Date.now = realNow;
  }
  const waitedMs = realNow() - r0;
  eq([user5.status, user5.body.ok, user5.body.code], [409, false, 'CHAT_SESSION_BUSY'], '到点仍没收尾 → 409 CHAT_SESSION_BUSY');
  ok(waitedMs >= 300, `先等了收尾窗(实际 ${waitedMs}ms),不是立即拒`);
  eq([snap(tailPid)?.busy, snap(tailPid)?.awaitingSuggestion], [true, true], '内部回合没被中止(仍在收尾窗里)');
  eq(userWaitingOnSession(S3), true, '这次 409 同样记"用户在等"');
  await waitFor(() => snap(tailPid)?.idle, '收尾窗到点,内部回合正常收尾', 15000);
  eq(ends.filter((e) => e.pid === tailPid).map((e) => e.outcome), ['completed'], '内部回合按完成结束,不是被停止');
  console.log(`PASS check-r151q-busy-internal(${checks} 项)`);
} finally {
  unhook?.();
  try { await closeAllPersistentProcesses(); } catch { /* 收尾 */ }
  server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}
