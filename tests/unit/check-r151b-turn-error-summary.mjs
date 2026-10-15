#!/usr/bin/env node
// r151b:回合结束通知带错误摘要(接口 X.3.6 末尾 2026-10-15 补的第二条)。
//   ① summarizeTurnError:抹掉像密钥 / 令牌的片段、空白压成一行、超 200 字截短加"…"(不切开代理对);非字符串 / 空 → null。
//   ② turnEnd 的 errorSummary:入口钩子改写过(带 tag)的回合 failed 时取本回合最后一条错误(错误终态的 result / error 行);
//      completed、stopped、没有任何错误输出的 failed、没带 tag 的回合(审计 I2:只给兑换回合算)→ null。
//   ③ 跨会话结算:处理消息的回合出错 → heldText = "处理该消息的回合出错：<摘要>";取不到摘要 → 原来的固定文案。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身,不起 claude 进程;临时 HOME;端口 6900–6990(跳过 6710)。
// node tests/unit/check-r151b-turn-error-summary.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-turnerr-')));
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
const { summarizeTurnError, registerSessionRuntimeHooks, closeAllPersistentProcesses } = chat;

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); passed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 8000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = await pred(); if (v) return v; await sleep(20); }
  throw new Error(`等不到:${what}`);
}

// ── ① 纯函数 ──────────────────────────────────────────────────────────────────────────────
const API401 = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
eq(summarizeTurnError(API401), API401, '普通错误原样(没有可疑片段)');
const leaks = [
  ['key sk-ant-api03-AbCdEfGhIjKlMnOp-1234 rejected', 'sk-ant-api03-AbCdEfGhIjKlMnOp-1234'],
  ['Authorization: Bearer eyJhbGciOi.payload_part.sig-part', 'eyJhbGciOi'],
  ['ANTHROPIC_AUTH_TOKEN=plain-secret-value failed', 'plain-secret-value'],
  ['{"api_key":"k-123456","x":1}', 'k-123456'],
  ['x-api-key: hunter2-hunter2 bad', 'hunter2-hunter2'],
  ['password=abc123 at login', 'abc123'],
  ['blob 0123456789abcdef0123456789abcdef01234567 end', '0123456789abcdef0123456789abcdef'],
];
for (const [text, secret] of leaks) {
  const s = summarizeTurnError(text);
  ok(typeof s === 'string' && !s.includes(secret) && s.includes('***'), `抹掉凭据片段:${text} → ${s}`);
}
eq(summarizeTurnError('第一行\n\n  第二行\t第三行  '), '第一行 第二行 第三行', '空白压成一行');
const long = '错误 '.repeat(150);
const sLong = summarizeTurnError(long);
ok(sLong.length <= 201 && sLong.endsWith('…'), `超 200 字截短加省略号(长度 ${sLong.length})`);
const emoji = `${'甲'.repeat(199)}😀尾`;
const sEmoji = summarizeTurnError(emoji);
ok(sEmoji.endsWith('甲…') && !/[\uD800-\uDBFF]…$/.test(sEmoji), '截点落在代理对中间时整个字符不要');
eq([summarizeTurnError(''), summarizeTurnError('  \n '), summarizeTurnError(null), summarizeTurnError(42)], [null, null, null, null], '空 / 非字符串 → null');

// ── ② turnEnd 的 errorSummary ────────────────────────────────────────────────────────────
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
const post = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const BODY = (extra) => ({ prompt: 'x', cwd: WORK, model: 'r151b-model', permissionMode: 'default', keepAlive: true, ...extra });
const textOf = (input) => String(input?.message?.content || '');
ctl.reply = (input) => (textOf(input).includes('MAKE-ERROR') ? 'error' : textOf(input).includes('MAKE-EXIT') ? 'exit' : textOf(input).includes('MAKE-HOLD') ? 'hold' : 'ok');

try {
  const ends = []; const starts = [];
  let tagTurns = true; // 入口钩子给回合打 tag(= 兑换回合);摘要只给带 tag 的回合算
  const unhook = registerSessionRuntimeHooks({
    chatEntry: (ctx) => (tagTurns ? { prompt: ctx.body.prompt, tag: { r151b: 'turn-error-summary' } } : null),
    turnStart: (info) => starts.push(info), turnEnd: (info) => ends.push(info),
  });
  const endOf = (pid) => waitFor(() => ends.find((x) => x.pid === pid), `回合 ${pid} 结束`);
  let r = await post('/chat', BODY({ prompt: 'MAKE-ERROR 1' }));
  let e = await endOf(r.body.pid);
  eq([e.outcome, e.errorSummary], ['failed', 'R151B-STUB-REPLY'], '结果为错误 → failed,摘要取 result 的错误文本');
  r = await post('/chat', BODY({ prompt: 'ok 1' }));
  e = await endOf(r.body.pid);
  eq([e.outcome, e.errorSummary], ['completed', null], '正常结束 → 没有摘要');
  r = await post('/chat', BODY({ prompt: 'MAKE-EXIT 1' }));
  e = await endOf(r.body.pid);
  eq([e.outcome, e.errorSummary], ['failed', null], '没有结果、也没有错误输出就退出 → failed,摘要 null');
  r = await post('/chat', BODY({ prompt: 'MAKE-HOLD 1' }));
  const pidHold = r.body.pid;
  await waitFor(() => starts.find((x) => x.pid === pidHold), '挂住的回合开始');
  await post(`/chat/${pidHold}/stop`, {});
  e = await endOf(pidHold);
  eq([e.outcome, e.errorSummary], ['stopped', null], '停止 → 没有摘要');
  tagTurns = false;
  r = await post('/chat', BODY({ prompt: 'MAKE-ERROR 没带 tag' }));
  e = await endOf(r.body.pid);
  eq([e.outcome, e.errorSummary, e.tag], ['failed', null, undefined], '没带 tag 的回合出错 → failed,不算摘要');
  unhook();
  closeAllPersistentProcesses();

  // ── ③ 跨会话结算用摘要 ─────────────────────────────────────────────────────────────────
  writeFileSync(join(HOME, '.claude-gui', 'prefs.json'), JSON.stringify({ xsEnabled: true }));
  const xs = await import('../../server/services/xsession.js');
  xs.installXsessionRuntime();
  const B = 'bbbbbbbb-0000-4000-8000-0000000000b2';
  const rows = [{ sessionId: B, title: '会话乙', projectDir: WORK }];
  const pendingOf = async (id) => (await xs.listInboxMessages({ sessionId: B, statuses: new Set(['pending']) })).find((m) => m.id === id);
  async function processOnce(body) {
    const [m] = await xs.sendManualMessages({ to: [B], body, fromSessionId: null }, rows);
    const { token } = await xs.claimMessage(m.id);
    const res = await post('/chat', BODY({ sessionId: B, xsMessageId: m.id, xsToken: token }));
    eq(res.status, 200, '兑换后起回合');
    return waitFor(() => pendingOf(m.id), `消息 ${m.id} 退回 pending`);
  }
  let back = await processOnce('MAKE-ERROR 这一回合会出错');
  eq([back.heldReason, back.heldText], ['turn-error', '处理该消息的回合出错：R151B-STUB-REPLY'], '出错 → heldText 带本回合的错误摘要');
  back = await processOnce('MAKE-EXIT 这一回合没有结果');
  eq([back.heldReason, back.heldText], ['turn-error', '处理该消息的回合出错：模型返回了错误或进程提前退出'], '取不到摘要 → 原来的固定文案');
  // r151c 先修 5:来源会话已删(记录文件不在)、消息之后才正常结算成 done → 同一事务里 from.title 抹成空串
  {
    const S = 'eeeeeeee-0000-4000-8000-0000000000e5'; // 没有记录文件 = 已删
    const [sm] = await xs.sendManualMessages({ to: [B], body: '来源已删的一条', fromSessionId: S }, [...rows, { sessionId: S, title: '会话戊', projectDir: WORK }]);
    const { token } = await xs.claimMessage(sm.id);
    eq((await post('/chat', BODY({ sessionId: B, xsMessageId: sm.id, xsToken: token }))).status, 200, '兑换后起回合(来源已删)');
    const done = await waitFor(async () => (await xs.listInboxMessages({ sessionId: B, statuses: new Set(['done']) })).find((m) => m.id === sm.id), `消息 ${sm.id} 结算成 done`);
    eq([done.from.title, done.from.deleted], ['', true], '删会话之后才结算的:来源标题抹成空串');
  }
  xs.syncXsRuntimeHooks(false);
} finally {
  try { closeAllPersistentProcesses(); } catch { /* */ }
  server.close();
}
console.log(`check-r151b-turn-error-summary: ${passed} 项通过`);
process.exit(0);
