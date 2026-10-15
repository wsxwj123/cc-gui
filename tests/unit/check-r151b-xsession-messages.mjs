#!/usr/bin/env node
// r151b T-X4:跨会话消息核心(server/services/xsession.js)+ /api/xsession/messages*、/pending + POST /api/chat 的凭据兑换。
// 临时 HOME;SDK 换成替身(helpers/r151b-sdk-stub.mjs,不起 claude 进程);端口在 6800–6879 里挑;WS 广播用假客户端收。
// node tests/unit/check-r151b-xsession-messages.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-xsmsg-')));
const HOME = join(TMP, 'home');
const WS = join(TMP, 'ws');
mkdirSync(join(HOME, '.claude', 'projects'), { recursive: true });
mkdirSync(join(HOME, '.claude-gui'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
const BIN = join(TMP, 'bin');
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
registerR151bSdkStub();
// 替身按推进来的内容决定这一回合怎么结束:正文里带 MAKE-ERROR → 结果为错误;MAKE-HOLD → 不回应直到被停止
const ctl = (globalThis.__r151bSdkControl = {});
ctl.reply = (input) => {
  const c = String(input?.message?.content ?? '');
  return c.includes('MAKE-ERROR') ? 'error' : c.includes('MAKE-HOLD') ? 'hold' : 'ok';
};
const calls = (globalThis.__r151bSdkCalls ||= []);

let checks = 0;
const ok = (v, msg) => { assert.ok(v, msg); checks += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { default: express } = await import('express');
const { default: xsRoutes, xsessionBodyErrorHandler } = await import('../../server/routes/xsession.js');
const chat = await import('../../server/routes/chat.js');
const core = await import('../../server/services/xsession.js');
const store = await import('../../server/services/xsession-store.js');
const { buildXsEnvelope, neutralizeXsBody } = await import('../../server/services/xsession-envelope.js');
const { clients } = await import('../../server/broadcast.js');
const wsMsgs = [];
clients.add({ readyState: 1, send: (s) => wsMsgs.push(JSON.parse(s)) });

let seq = 0;
function seed(firstPrompt) {
  seq += 1;
  const sid = randomUUID();
  const cwd = join(WS, `proj-${seq}`);
  mkdirSync(cwd, { recursive: true });
  const proj = join(HOME, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(proj, { recursive: true });
  const t = Date.now() - seq * 1000;
  const b = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.296', gitBranch: '' };
  const lines = [
    { type: 'summary', summary: 's', leafUuid: `${sid}-a1` },
    { ...b, type: 'user', uuid: `${sid}-u0`, parentUuid: null, timestamp: new Date(t - 1000).toISOString(), message: { role: 'user', content: firstPrompt } },
    { ...b, type: 'assistant', uuid: `${sid}-a1`, parentUuid: `${sid}-u0`, timestamp: new Date(t).toISOString(),
      message: { id: `m${seq}`, type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'r' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  const file = join(proj, `${sid}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { sid, cwd, title: firstPrompt, file };
}

const canListen = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
let port = 0;
for (let p = 6879; p >= 6800; p -= 1) if (await canListen(p)) { port = p; break; }
assert.ok(port, '6800–6879 有空闲端口');
const app = express();
app.use(express.json());
app.use('/api', xsRoutes);
app.use('/api', xsessionBodyErrorHandler);
app.use('/api', chat.default);
core.installXsessionRuntime();
const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });

async function req(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, init);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, body: json, text };
}
const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b);
const code = (r) => [r.status, r.body?.code];
const ALL = 'pending,queued,claimed,processing,done,dismissed';
async function findMsg(sid, id) {
  const l = await get(`/xsession/messages?sessionId=${sid}&status=${ALL}`);
  return l.body?.messages?.find((m) => m.id === id) || null;
}
async function waitStatus(sid, id, status) {
  for (let i = 0; i < 300; i += 1) {
    const m = await findMsg(sid, id);
    if (m && m.status === status) return m;
    await sleep(20);
  }
  throw new Error(`等不到 ${id} 变 ${status}`);
}
async function readStream(pid) {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat/${pid}/stream`);
  const text = await r.text();
  await sleep(50);
  return text.split('\n\n').map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter(Boolean).map((s) => { try { return JSON.parse(s); } catch { return { raw: s }; } });
}
const claim = async (id) => (await post(`/xsession/messages/${id}/claim`, {})).body.token;
const send = async (body, to, fromSessionId) => {
  const r = await post('/xsession/messages', { to, body, ...(fromSessionId ? { fromSessionId } : {}) });
  assert.equal(r.status, 200, `前置:转发 200(${r.text.slice(0, 200)})`);
  return r.body.messages;
};

try {
  const A = seed('来源会话甲');
  const B = seed('目标会话乙');
  const C = seed('目标会话丙');

  // ── ① 总开关关:只有 /chat 入口钩子;两个新字段都没带 = 与改动前相同 ──────────────────────────
  eq(code(await get(`/xsession/messages?sessionId=${B.sid}`)), [409, 'XS_DISABLED'], '关:收件列表 409');
  eq(code(await get('/xsession/pending')), [409, 'XS_DISABLED'], '关:pending 409');
  eq(code(await post(`/xsession/messages/${randomUUID()}/claim`, {})), [409, 'XS_DISABLED'], '关:认领 409');
  let n0 = calls.length;
  eq(code(await post('/chat', { cwd: B.cwd, sessionId: B.sid, prompt: 'x', xsMessageId: 'bad', xsToken: 1 })), [409, 'XS_DISABLED'], '关:带新字段先回 XS_DISABLED(不判形状)');
  eq(calls.length, n0, '关:被拒不起进程');
  let r = await post('/chat', { cwd: A.cwd, prompt: 'plain-off' });
  eq(r.status, 200, '关:普通回合照常');
  await readStream(r.body.pid);
  eq(calls.at(-1).inputs.map((i) => i.message.content), ['plain-off'], '关:推入原文');
  ok(!existsSync(join(HOME, '.claude-gui', 'xsession')), '关:不产生 ~/.claude-gui/xsession/');

  eq((await req('PUT', '/xsession/config', { enabled: true })).status, 200, '打开总开关');

  // ── ② 转发的校验顺序 ─────────────────────────────────────────────────────────────────
  const nine = Array.from({ length: 9 }, () => randomUUID());
  for (const [label, body, want] of [
    ['请求体是数组', '[1]', [400, 'XS_INVALID_INPUT']],
    ['to 的元素是单元素数组(String 化后像 id)', { to: [[B.sid]], body: 'x' }, [400, 'XS_INVALID_INPUT']],
    ['fromSessionId 为 null 算形状不对', { to: [B.sid], body: 'x', fromSessionId: null }, [400, 'XS_INVALID_INPUT']],
    ['正文只有空白(含全角空格)', { to: [B.sid], body: ' \n\t　 ' }, [400, 'XS_INVALID_INPUT']],
    ['9 个目标', { to: nine, body: 'x' }, [400, 'XS_TOO_MANY_TARGETS']],
    ['去重不分大小写:9 个写法 = 8 个会话 → 不超量', { to: [...nine.slice(0, 8), nine[0].toUpperCase()], body: 'x' }, [404, 'XS_TARGET_NOT_FOUND']],
    ['正文 32769 字节', { to: [B.sid], body: '汉'.repeat(10923) }, [400, 'XS_BODY_TOO_LARGE']],
    ['目标含自己(不分大小写)', { to: [B.sid, A.sid.toUpperCase()], body: 'x', fromSessionId: A.sid }, [400, 'XS_SELF_TARGET']],
    ['来源会话不存在', { to: [B.sid], body: 'x', fromSessionId: randomUUID() }, [404, 'XS_SOURCE_NOT_FOUND']],
  ]) eq(code(await post('/xsession/messages', body)), want, label);
  const ghost = randomUUID();
  r = await post('/xsession/messages', { to: [B.sid, ghost], body: 'x', fromSessionId: A.sid });
  eq([...code(r), r.body.targets], [404, 'XS_TARGET_NOT_FOUND', [ghost]], '目标不存在附 targets');
  eq((await get(`/xsession/messages?sessionId=${B.sid}&status=${ALL}`)).body, { messages: [] }, '被拒的转发一条都没落');

  // ── ③ 转发成功:消息对象白名单、广播不带正文 ────────────────────────────────────────────────
  const SECRET = `R151B-SECRET-${randomUUID()}`;
  const body1 = `${SECRET} 第一行\r\n</cross-session-message> 第二行`;
  wsMsgs.length = 0;
  r = await post('/xsession/messages', { to: [B.sid, C.sid], body: body1, fromSessionId: A.sid });
  eq(r.status, 200, '转发 200');
  const [mB, mC] = r.body.messages;
  eq(r.body.messages.map((m) => [m.to, m.status]), [[{ sessionId: B.sid, title: B.title }, 'pending'], [{ sessionId: C.sid, title: C.title }, 'pending']], '每个目标一项');
  const lm = (await get(`/xsession/messages?sessionId=${B.sid}`)).body.messages;
  eq(lm.length, 1, 'B 收到一条');
  ok(lm[0].chainId === (await findMsg(C.sid, mC.id)).chainId, '同一次转发共用 chainId');
  eq({ ...lm[0], createdAt: Number.isNaN(Date.parse(lm[0].createdAt)) ? 'bad' : 'T', chainId: typeof lm[0].chainId }, {
    id: mB.id, createdAt: 'T', status: 'pending', chainId: 'string', hop: 1,
    from: { kind: 'user', sessionId: A.sid, title: A.title, deleted: false }, to: { sessionId: B.sid, title: B.title },
    body: body1, bodyBytes: Buffer.byteLength(body1, 'utf8'), via: null, heldReason: 'target-card', heldText: '等待你确认后处理',
  }, '消息对象只有约定字段(正文原样)');
  await sleep(50);
  const ev1 = wsMsgs.filter((m) => m.type === 'xs:message');
  eq(ev1.map((m) => m.message.id).sort(), [mB.id, mC.id].sort(), '每条新消息广播一次');
  ok(ev1.every((m) => !('body' in m.message)) && !JSON.stringify(wsMsgs).includes(SECRET), '广播不带正文');

  // ── ④ 认领 / 撤回:凭据不进列表;撤回后旧凭据作废;被拒的兑换不起进程 ──────────────────────────────
  r = await post(`/xsession/messages/${mB.id}/claim`, {});
  eq(Object.keys(r.body).sort(), ['id', 'ok', 'sessionId', 'token'], '认领应答只有 ok/id/sessionId/token');
  const tok1 = r.body.token;
  ok(/^[0-9a-f-]{36}$/.test(tok1), '凭据是 36 位 id 形状');
  const listed = await get(`/xsession/messages?sessionId=${B.sid}&status=${ALL}`);
  ok(!listed.text.includes(tok1) && !JSON.stringify(wsMsgs).includes(tok1), '凭据不出现在列表与广播里');
  eq([listed.body.messages[0].status, listed.body.messages[0].heldReason, listed.body.messages[0].heldText], ['claimed', null, null], 'claimed 时原因为空');
  eq([...code(r = await post(`/xsession/messages/${mB.id}/claim`, {})), r.body.status], [409, 'XS_NOT_PENDING', 'claimed'], '再认领 → 409 附 status');
  eq((await post(`/xsession/messages/${mB.id}/release`, {})).body, { ok: true, id: mB.id, status: 'pending' }, '撤回');
  eq([(await findMsg(B.sid, mB.id)).heldReason], ['target-card'], '撤回后原因恢复');
  eq([...code(r = await post(`/xsession/messages/${mB.id}/release`, {})), r.body.status], [409, 'XS_NOT_CLAIMED', 'pending'], '对 pending 撤回');
  const tok2 = await claim(mB.id);
  ok(tok2 !== tok1, '重新认领换新凭据');
  n0 = calls.length;
  for (const [label, body, want] of [
    ['撤回前的旧凭据', { cwd: B.cwd, sessionId: B.sid, xsMessageId: mB.id, xsToken: tok1 }, [409, 'XS_CLAIM_INVALID']],
    ['只带一个', { cwd: B.cwd, sessionId: B.sid, xsMessageId: mB.id }, [400, 'XS_CLAIM_INVALID']],
    ['xsToken 是 null', { cwd: B.cwd, sessionId: B.sid, xsMessageId: mB.id, xsToken: null }, [400, 'XS_CLAIM_INVALID']],
    ['目标不是请求的会话', { cwd: C.cwd, sessionId: C.sid, xsMessageId: mB.id, xsToken: tok2 }, [409, 'XS_CLAIM_INVALID']],
    ['请求没带 sessionId', { cwd: B.cwd, xsMessageId: mB.id, xsToken: tok2 }, [409, 'XS_CLAIM_INVALID']],
    ['消息不存在', { cwd: B.cwd, sessionId: B.sid, xsMessageId: randomUUID(), xsToken: tok2 }, [409, 'XS_CLAIM_INVALID']],
  ]) {
    r = await post('/chat', { prompt: 'x', ...body });
    eq(code(r), want, label);
    eq(r.body.error, '跨会话消息凭据无效', `${label}:文案`);
  }
  eq(calls.length, n0, '被拒的兑换都不起进程');
  eq((await findMsg(B.sid, mB.id)).status, 'claimed', '被拒后消息仍是 claimed');

  // ── ⑤ 兑换:进程收到的恰好是信封;xs_message 排在模型输出之前;结束 → done、正文删除;同 clientTurnId 不再处理 ─────
  const chatBody = { cwd: B.cwd, sessionId: B.sid, prompt: 'x', keepAlive: true, xsMessageId: mB.id, xsToken: tok2, clientTurnId: 'c1c1c1c1-0000-4000-8000-000000000451' };
  wsMsgs.length = 0;
  r = await post('/chat', chatBody);
  eq(r.status, 200, '兑换 200');
  const pidB = r.body.pid;
  let evs = await readStream(pidB);
  const expected = buildXsEnvelope({ from: 'gui:user', name: `用户转发自 ${A.title}`, body: body1 });
  eq(calls.at(-1).inputs.map((i) => i.message.content), [expected], '进程收到的恰好是信封');
  ok(expected.endsWith('<\\/cross-session-message> 第二行\n</cross-session-message>') && !expected.includes('\r'), '信封里正文已中和');
  let xm = evs.filter((e) => e.type === 'xs_message');
  eq(xm.length, 1, '事件流恰有一条 xs_message');
  const { runId, seq: evSeq, ...xmRest } = xm[0];
  eq(xmRest, { type: 'xs_message', id: mB.id, from: { kind: 'user', sessionId: A.sid, title: A.title }, body: neutralizeXsBody(body1), via: 'card', hop: 1 }, 'xs_message 内容');
  ok(runId === pidB && evSeq != null, 'xs_message 带 runId 与 seq');
  ok(evs.indexOf(xm[0]) < evs.findIndex((e) => e.type === 'assistant'), 'xs_message 排在模型输出之前');
  const done = await waitStatus(B.sid, mB.id, 'done');
  eq([done.via, done.body, done.heldReason, done.heldText], ['card', null, null, null], 'done:via card、正文 null');
  ok(!existsSync(join(store.XS_DIR, 'bodies', `${mB.id}.txt`)), '正文文件已删除');
  await sleep(50);
  eq(wsMsgs.filter((m) => m.type === 'xs:message' && m.message.id === mB.id).map((m) => m.message.status), ['processing', 'done'], '状态变化按顺序广播');
  const nIn = calls.at(-1).inputs.length;
  const again = await post('/chat', chatBody);
  eq([again.status, again.body], [r.status, r.body], '同 clientTurnId 重发 → 与第一次相同的应答');
  await sleep(200);
  eq(calls.at(-1).inputs.length, nIn, '没有再投递');
  eq(code(await post('/chat', { ...chatBody, clientTurnId: undefined })), [409, 'XS_CLAIM_INVALID'], '凭据只能兑换一次');

  // ── ⑥ 回合出错(复用 B 的常驻进程)→ pending / turn-error,正文还在,可再处理 ───────────────────────────
  const [mErr] = await send('MAKE-ERROR 这一回合会出错', [B.sid]);
  r = await post('/chat', { cwd: B.cwd, sessionId: B.sid, prompt: 'x', keepAlive: true, xsMessageId: mErr.id, xsToken: await claim(mErr.id) });
  eq([r.status, r.body.reused], [200, true], '复用常驻进程');
  evs = await readStream(r.body.pid);
  eq(evs.filter((e) => e.type === 'xs_message').map((e) => e.id), [mErr.id], '复用回合也补 xs_message');
  const back = await waitStatus(B.sid, mErr.id, 'pending');
  eq([back.heldReason, back.via, back.body, back.from.sessionId], ['turn-error', 'card', 'MAKE-ERROR 这一回合会出错', null], '出错退回 pending,via 保留');
  ok(/^处理该消息的回合出错：.+/.test(back.heldText), 'heldText = 处理该消息的回合出错：<摘要>');
  eq((await post(`/xsession/messages/${mErr.id}/claim`, {})).status, 200, '出错的可以再认领');
  eq((await post(`/xsession/messages/${mErr.id}/release`, {})).status, 200, '撤回');
  eq((await findMsg(B.sid, mErr.id)).heldReason, 'turn-error', '撤回后原因恢复为 turn-error');

  // ── ⑦ 来源会话被删 → from.deleted;pending 汇总;收件箱满(并发也不超 50) ───────────────────────────
  unlinkSync(A.file);
  eq((await findMsg(C.sid, mC.id)).from, { kind: 'user', sessionId: A.sid, title: A.title, deleted: true }, '来源被删 → deleted:true,标题用发送时存下的');
  const p1 = (await get('/xsession/pending')).body;
  const bySid = (s) => [...s].sort((x, y) => (x.sessionId < y.sessionId ? -1 : 1));
  eq([p1.total, bySid(p1.sessions)], [2, bySid([{ sessionId: B.sid, projectPath: B.cwd, pending: 1 }, { sessionId: C.sid, projectPath: C.cwd, pending: 1 }])], 'pending 汇总');
  const burst = await Promise.all(Array.from({ length: 60 }, (_, i) => post('/xsession/messages', { to: [C.sid], body: `填满 ${i}` })));
  eq([burst.filter((x) => x.status === 200).length, burst.filter((x) => x.body?.code === 'XS_INBOX_FULL').length], [49, 11], '并发转发:C 恰好到 50 条待处理');
  r = burst.find((x) => x.body?.code === 'XS_INBOX_FULL');
  eq([r.status, r.body.targets], [409, [C.sid]], '收件箱满附 targets');
  eq((await get('/xsession/pending')).body.total, 51, 'total = 各项之和');

  // ── ⑧ 忽略 ─────────────────────────────────────────────────────────────────────────
  eq((await post(`/xsession/messages/${mC.id}/dismiss`, {})).body, { ok: true, id: mC.id, status: 'dismissed' }, '忽略');
  eq([...code(r = await post(`/xsession/messages/${mC.id}/dismiss`, {})), r.body.status], [409, 'XS_NOT_PENDING', 'dismissed'], '再忽略');
  eq([(await findMsg(C.sid, mC.id)).body, existsSync(join(store.XS_DIR, 'bodies', `${mC.id}.txt`))], [null, false], '忽略后正文删除');
  eq(code(await post('/xsession/messages/not-an-id/dismiss', {})), [400, 'XS_INVALID_INPUT'], 'id 形状不对');
  eq(code(await post(`/xsession/messages/${randomUUID()}/release`, {})), [404, 'XS_MESSAGE_NOT_FOUND'], '消息不存在');
  eq(code(await get(`/xsession/messages?sessionId=${C.sid}&status=pending,expired`)), [400, 'XS_INVALID_INPUT'], 'status 非法');
  eq(code(await get('/xsession/messages')), [400, 'XS_INVALID_INPUT'], '缺 sessionId');
  ok((await get(`/xsession/messages?sessionId=${C.sid}`)).body.messages.every((m) => m.status !== 'dismissed'), '默认不含 dismissed');

  // ── ⑨ 处理中关掉总开关:回合钩子留到结算;停止 → pending / interrupted ───────────────────────────────
  const D = seed('目标会话丁');
  const [mHold] = await send('MAKE-HOLD 等停止', [D.sid]);
  r = await post('/chat', { cwd: D.cwd, sessionId: D.sid, prompt: 'x', keepAlive: true, xsMessageId: mHold.id, xsToken: await claim(mHold.id) });
  eq(r.status, 200, '兑换(会一直跑)');
  await waitStatus(D.sid, mHold.id, 'processing');
  eq((await req('PUT', '/xsession/config', { enabled: false })).status, 200, '处理中关掉总开关');
  eq((await post(`/chat/${r.body.pid}/stop`, {})).status, 200, '停止');
  let held = null;
  for (let i = 0; i < 300 && !(held && held.status === 'pending'); i += 1) {
    held = (await store.listXsMessages()).find((m) => m.id === mHold.id);
    await sleep(20);
  }
  eq([held.status, held.heldReason, held.via, 'turn' in held, 'token' in held], ['pending', 'interrupted', 'card', false, false], '关着也照样结算:停止 → interrupted');
  eq(code(await post('/chat', { cwd: D.cwd, sessionId: D.sid, prompt: 'x', xsMessageId: mHold.id, xsToken: randomUUID() })), [409, 'XS_DISABLED'], '关着时兑换回 XS_DISABLED');

  console.log(`PASS check-r151b-xsession-messages(${checks} 项)`);
} finally {
  try { await chat.closeAllPersistentProcesses(); } catch { /* */ }
  await new Promise((r) => server.close(r));
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(0);
