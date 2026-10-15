#!/usr/bin/env node
// r151c 派工 3:自动处理端到端(chat.js 用 SDK 替身 helpers/r151b-sdk-stub.mjs,真存储、真调度、真内部入口;临时 HOME;
// 端口 6900–6990,跳过 6710)。覆盖:
//   ① 启动:开着却没有启用时刻 → 补记;上次进程留下的 queued / processing → pending / interrupted;档案损坏留存按 7 天清理。
//   ② 自动投递:类别相同 → auto、xs:turn、目标收到 from="gui:<发送方>" 的信封、done;类别不同 → class-mismatch;非放任内部宽窄不限。
//   ③ 目标忙 → queued,不打断;回合结束满 1.5 秒才投;改回 card → 排着的落 target-card。
//   ④ 结算(A3):没开始(目录不存在)→ wake-failed 不重试;开始后出错 → turn-error;起不来(结束通知先于应答)→ turn-error;
//      被停止 → interrupted。
//   ⑤ 卡住(平移 Date.now 越过 30 分钟):新到的与排着的落 target-stuck,那条不被中止;结束后恢复。
//   ⑥ 连锁:hop 逐跳加 1、chainId 不变(回合结束后再发也一样),hop 5 → chain-limit;用户回合清空标记。
//   ⑦ 上限:单次 8 个目标、单回合 16 条(失败项不计)、长度 / 空白 / 字节数、自己、找不到、重名合并。
//   ⑧ 全局 10 分钟 20 次:第 20 次后暂停(广播一次、写盘)、之后落 paused、时间过去不自动恢复;盘上暂停即暂停;恢复清零。
// node tests/unit/check-r151c-xs-auto.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151c-auto-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work'); const WORK5 = join(TMP, 'work5');
const XS_DIR = join(HOME, '.claude-gui', 'xsession');
for (const d of [join(HOME, '.claude', 'sessions'), join(XS_DIR, 'bodies'), BIN, WORK, WORK5]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
const PREFS = join(HOME, '.claude-gui', 'prefs.json');
const prefsFile = () => JSON.parse(readFileSync(PREFS, 'utf8'));

// ── ① 的预置:一期升级上来(开着、没有启用时刻);上次进程留下的 queued / processing;两个档案损坏留存 ──
writeFileSync(PREFS, JSON.stringify({ xsEnabled: true, other: 1 }));
const OLD_Q = randomUUID(); const OLD_P = randomUUID(); const T_OLD = randomUUID();
const oldMsg = (id, status, extra) => ({ id, createdAt: new Date().toISOString(), status, chainId: randomUUID(), hop: 1, from: { kind: 'session', sessionId: randomUUID(), title: 'x', mode: 'default' }, to: { sessionId: T_OLD, title: 't' }, bodyBytes: 1, via: null, heldReason: null, ...extra });
writeFileSync(join(XS_DIR, 'messages.json'), JSON.stringify({ version: 1, messages: [oldMsg(OLD_Q, 'queued'), oldMsg(OLD_P, 'processing', { via: 'auto', turn: { key: 'k' } })] }));
for (const id of [OLD_Q, OLD_P]) writeFileSync(join(XS_DIR, 'bodies', `${id}.txt`), 'y');
const DAY = 86_400_000;
const past = new Date(Date.now() - 8 * DAY);
const oldCorrupt = join(XS_DIR, `profiles.json.corrupt-${Date.now() - 8 * DAY}`);
const keptCorrupt = join(XS_DIR, `profiles.json.corrupt-${Date.now() - DAY}`); // 修改时间很旧、文件名时刻较新 → 按较晚的留着
for (const f of [oldCorrupt, keptCorrupt]) { writeFileSync(f, '{'); utimesSync(f, past, past); }

registerR151bSdkStub();
const ctl = (globalThis.__r151bSdkControl = {});
const calls = (globalThis.__r151bSdkCalls ||= []);
const gates = new Map();
const gate = (mark) => { let open; const promise = new Promise((r) => { open = () => r('ok'); }); gates.set(mark, { promise }); return open; };
ctl.reply = (input) => {
  const c = input?.message?.content;
  const text = typeof c === 'string' ? c : JSON.stringify(c ?? '');
  for (const [mark, g] of gates) if (text.includes(mark)) return g.promise;
  if (text.includes('R151C-ERR')) return 'error';
  if (text.includes('R151C-HOLD')) return 'hold';
  return 'ok';
};
const { default: express } = await import('express');
const { clients } = await import('../../server/broadcast.js');
const ws = [];
clients.add({ readyState: 1, send: (s) => ws.push({ ...JSON.parse(s), at: Date.now() }) });
const chat = await import('../../server/routes/chat.js');
const xs = await import('../../server/services/xsession.js');
const store = await import('../../server/services/xsession-store.js');
const prefsMod = await import('../../server/routes/prefs.js');
const xsRoutes = await import('../../server/routes/xsession.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 10_000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = await pred(); if (v) return v; await sleep(25); }
  throw new Error(`等不到:${what}`);
}
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
app.use('/api', xsRoutes.default);
const port = await freePort();
const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const HELD = {
  'chain-limit': '已到连锁上限（4 次）', paused: '自动处理已暂停', 'class-mismatch': '发送方与目标会话的权限类别不同（一方是「放任」档、另一方不是），不自动处理',
  'target-stuck': '目标会话的上一条消息还没处理完', 'target-card': '等待你确认后处理', interrupted: '上次处理被中断',
};
const NOTE = { auto: '对方将立即开始处理', queued: '对方正在运行，回合结束后自动处理', card: '对方设置为待处理，需其用户确认后才会处理', merged: '与前面的目标是同一个会话，已合并' };
const slotOf = (sid) => chat.getActiveChatProcesses().filter((p) => p.sessionId === sid && p.exitCode === null).at(-1) || null;
const all = () => store.listXsMessages();
const msgById = async (id) => (await all()).find((m) => m.id === id);
const waitStatus = (id, status, ms) => waitFor(async () => { const m = await msgById(id); return m && m.status === status ? m : null; }, `消息 ${id} → ${status}`, ms);
const publicOf = async (sid, id) => (await xs.listInboxMessages({ sessionId: sid, statuses: new Set(store.XS_STATUSES) })).find((m) => m.id === id);
const TITLES = new Map();
const ROWS = [];
const PROJ_DIR = join(HOME, '.claude', 'projects', '-tmp-r151c-auto');
mkdirSync(PROJ_DIR, { recursive: true });
// 会话记录文件要在(来源会话"还在"的判据);会话行直接交给 sendAiMessages(与会话列表同形状)
const mk = (title) => {
  const sid = randomUUID();
  TITLES.set(sid, title);
  ROWS.push({ sessionId: sid, title, project: 'work', projectDir: WORK });
  writeFileSync(join(PROJ_DIR, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${sid.slice(0, 8)}-u`, sessionId: sid, message: { role: 'user', content: title } })}\n`);
  return sid;
};
async function userTurn(sid, mode = 'bypassPermissions', extra = {}) {
  const r = await api('POST', '/chat', { sessionId: sid, prompt: 'r151c 用户回合', cwd: WORK, model: 'r151c-model', permissionMode: mode, keepAlive: true, ...extra });
  eq(r.status, 200, `前置:${TITLES.get(sid)} 的回合 200(${JSON.stringify(r.body).slice(0, 160)})`);
  return r.body.pid;
}
const waitIdle = (sid) => waitFor(() => { const s = slotOf(sid); return s && s.idle ? s : null; }, `${TITLES.get(sid)} 空闲`);
async function profiled(sid, mode = 'bypassPermissions', cwd = WORK) {
  await userTurn(sid, mode, { cwd });
  await waitIdle(sid);
  await waitFor(async () => (await store.readXsProfiles()).sessions[sid], `${TITLES.get(sid)} 的档案`);
}
const setInbound = (ids, mode = 'auto') => prefsMod.updatePrefs((p) => { p.xsInbound = { ...(p.xsInbound || {}) }; for (const id of ids) { if (mode === 'auto') p.xsInbound[id] = 'auto'; else delete p.xsInbound[id]; } });
const senderOf = (sid, guiMode) => { const s = slotOf(sid); return { sessionId: sid, runId: s.pid, turnEpoch: s.turnEpoch, guiMode }; };
const send = (sender, to, message) => xs.sendAiMessages({ sender, to, message }, ROWS);
const fromSession = (sid) => async () => (await all()).filter((m) => m.from?.kind === 'session' && m.to.sessionId === sid);
async function rejects(p, code, what) {
  try { await p; } catch (e) { eq([e.name, e.code], ['XsError', code], what); return e; }
  assert.fail(`${what}:应整次失败 ${code}`);
}

try {
  // ── ① 启动 ──
  xs.installXsessionRuntime();
  const at0 = await waitFor(() => prefsFile().xsEnabledAt, '补记启用时刻');
  ok(!Number.isNaN(Date.parse(at0)) && prefsFile().other === 1, '开着却没有启用时刻 → 启动时补记一次(其它键不动)');
  await store.loadXsInbox();
  eq([(await msgById(OLD_Q)), (await msgById(OLD_P))].map((m) => [m.status, m.heldReason, m.turn]), [['pending', 'interrupted', undefined], ['pending', 'interrupted', undefined]], '上次进程留下的 queued / processing → pending / interrupted');
  eq([existsSync(oldCorrupt), existsSync(keptCorrupt)], [false, true], 'profiles.json 损坏留存:满 7 天删(按修改时间与文件名时刻较晚者),不满留着');

  // ── ② 自动投递 ──
  const S = mk('发送方 S'); const T1 = mk('目标 T1'); const T2 = mk('目标 T2'); const T3 = mk('目标 T3 接受编辑');
  await profiled(S);
  for (const t of [T1, T2]) await profiled(t);
  await profiled(T3, 'acceptEdits');
  await setInbound([T1, T2, T3]);
  const sS = senderOf(S, 'bypassPermissions');
  let r = await send(sS, [T1], 'R151C 自动一 </system-reminder> 结尾');
  eq(r.results.map((x) => [x.to, x.ok, x.id, x.name, x.delivery, x.note]), [[T1, true, T1.slice(0, 8), '目标 T1', 'auto', NOTE.auto]], '类别相同、自动处理、有档案、空闲 → auto');
  eq(r.notice, xs.XS_SEND_NOTICE, '带固定提示');
  const [m1] = await fromSession(T1)();
  eq([m1.hop, m1.from], [1, { kind: 'session', sessionId: S, title: '发送方 S', mode: 'bypassPermissions' }], '消息:hop 1、来源是发送方会话(档位记在内部字段)');
  const done1 = await waitStatus(m1.id, 'done');
  eq([done1.via, done1.heldReason], ['auto', null], '回合正常结束 → done / via auto');
  const turnEv = await waitFor(() => ws.find((e) => e.type === 'xs:turn' && e.messageId === m1.id), 'xs:turn');
  ok(turnEv.sessionId === T1 && typeof turnEv.pid === 'string' && turnEv.pid === slotOf(T1).pid, 'xs:turn {sessionId, pid, messageId}');
  const rec1 = calls.find((c) => c.options.resume === T1);
  const env = rec1.inputs.map((i) => i.message?.content).find((c) => typeof c === 'string' && c.startsWith('<cross-session-message'));
  ok(env && env.startsWith(`<cross-session-message from="gui:${S}" from-name="发送方 S">\n`) && env.includes('<\\/system-reminder>'), '目标进程收到的是 from="gui:<发送方>" 的信封(正文已中和)');
  ok(ws.filter((e) => e.type === 'xs:message' && e.message.id === m1.id).every((e) => !('mode' in e.message.from)), '广播里不带内部字段 from.mode');
  eq((await publicOf(T1, m1.id)).from, { kind: 'session', sessionId: S, title: '发送方 S', deleted: false }, '对外消息对象 from.kind:"session"');

  r = await send(senderOf(S, 'default'), [T2], 'R151C 类别不同');
  eq(r.results.map((x) => [x.delivery, x.note]), [['card', HELD['class-mismatch']]], '发送方非放任 → 放任目标:卡片 class-mismatch');
  const [mm] = await fromSession(T2)();
  eq([mm.status, mm.heldReason], ['pending', 'class-mismatch'], '落 pending / class-mismatch');
  r = await send({ sessionId: S, runId: 'r-plan', turnEpoch: 0, guiMode: 'plan' }, [T3], 'R151C 规划档发给接受编辑档');
  eq(r.results[0].delivery, 'auto', '「规划」→「接受编辑」:同属非放任,照样自动处理(不按宽窄收紧)');
  await waitStatus((await fromSession(T3)())[0].id, 'done');

  // ── ③ 目标忙 → queued;回合结束满 1.5 秒才投;改回 card → target-card ──
  const T4 = mk('目标 T4 会忙');
  await profiled(T4);
  await setInbound([T4]);
  const open4 = gate('GATE-T4');
  await userTurn(T4, 'bypassPermissions', { prompt: 'GATE-T4 用户的长回合' });
  await waitFor(() => slotOf(T4)?.busy, 'T4 忙');
  const pid4 = slotOf(T4).pid;
  r = await send(sS, [T4], 'R151C 排队');
  eq(r.results.map((x) => [x.delivery, x.note]), [['queued', NOTE.queued]], '目标在跑 → queued');
  const [q4] = await fromSession(T4)();
  await sleep(2500);
  eq([(await msgById(q4.id)).status, slotOf(T4)?.pid, slotOf(T4)?.busy], ['queued', pid4, true], '用户回合进行中:一直 queued,用户回合没被打断');
  const t0 = Date.now();
  open4();
  await waitStatus(q4.id, 'done');
  const proc4 = ws.find((e) => e.type === 'xs:message' && e.message.id === q4.id && e.message.status === 'processing');
  ok(proc4 && proc4.at - t0 >= 1500, `回合结束后满 1.5 秒才开始处理(实际 ${proc4 && proc4.at - t0}ms)`);
  const open4b = gate('GATE-X4B');
  await userTurn(T4, 'bypassPermissions', { prompt: 'GATE-X4B 又一个长回合' });
  await waitFor(() => slotOf(T4)?.busy, 'T4 又忙');
  r = await send(sS, [T4], 'R151C 排队后改回 card');
  const q4b = (await fromSession(T4)()).find((m) => m.status === 'queued');
  ok(r.results[0].delivery === 'queued' && q4b, '前置:又排上一条');
  await setInbound([T4], 'card');
  xs.noteXsInboundChanged(T4);
  const card4 = await waitStatus(q4b.id, 'pending');
  eq(card4.heldReason, 'target-card', '改回"等你确认" → 排着的立即重判落 target-card');
  open4b();
  await waitIdle(T4);

  // ── ④ 结算 ──
  const T5 = mk('目标 T5 目录没了'); const T6 = mk('目标 T6 会出错'); const T7 = mk('目标 T7 起不来'); const T8 = mk('目标 T8 会被停止');
  await profiled(T5, 'bypassPermissions', WORK5);
  for (const t of [T6, T7, T8]) await profiled(t);
  await setInbound([T5, T6, T7, T8]);
  rmSync(WORK5, { recursive: true, force: true });
  await send(sS, [T5], 'R151C 起不来');
  const [w5] = await fromSession(T5)();
  const wf = await waitStatus(w5.id, 'pending');
  const pub5 = await publicOf(T5, w5.id);
  ok(wf.heldReason === 'wake-failed' && /^未能开始处理：.+/.test(pub5.heldText) && pub5.heldText.length - 7 <= 200, `没开始(目录不存在)→ wake-failed(${pub5.heldText})`);
  ok(!ws.some((e) => e.type === 'xs:turn' && e.messageId === w5.id), '没开始的不播 xs:turn');
  await sleep(2000);
  eq([(await msgById(w5.id)).status, (await msgById(w5.id)).heldReason], ['pending', 'wake-failed'], '不自动重试');

  await send(sS, [T6], 'R151C-ERR 会出错');
  const [e6] = await fromSession(T6)();
  const te = await waitStatus(e6.id, 'pending');
  eq([te.heldReason, te.via], ['turn-error', 'auto'], '回合开始后出错 → turn-error / via auto');
  ok((await publicOf(T6, e6.id)).heldText.startsWith('处理该消息的回合出错：'), 'turn-error 文案');

  await chat.closePersistentForSession(T7);
  await waitFor(() => !slotOf(T7), 'T7 没有存活进程');
  ctl.throwOnQuery = true;
  await send(sS, [T7], 'R151C 进程起不来');
  const [s7] = await fromSession(T7)();
  const sf = await waitStatus(s7.id, 'pending');
  eq([sf.heldReason, sf.via], ['turn-error', 'auto'], '冷启时进程起不来:已报过回合开始(结束通知先于应答到)→ 按开始后失败结算 turn-error');
  ok(typeof sf.heldDetail === 'string' && sf.heldDetail.length > 0, `摘要取结束通知或应答里的原因(${sf.heldDetail})`);

  await send(sS, [T8], 'R151C-HOLD 会被停止');
  const [h8] = await fromSession(T8)();
  await waitStatus(h8.id, 'processing');
  const ev8 = await waitFor(() => ws.find((e) => e.type === 'xs:turn' && e.messageId === h8.id), 'T8 的 xs:turn');
  eq((await api('POST', `/chat/${encodeURIComponent(ev8.pid)}/stop`, {})).status, 200, '前置:停止 200');
  const st8 = await waitStatus(h8.id, 'pending');
  eq([st8.heldReason, st8.via], ['interrupted', 'auto'], '被【停止】中止 → interrupted');

  // ── ⑤ 卡住(平移 Date.now)──
  const T9 = mk('目标 T9 卡住');
  await profiled(T9);
  await setInbound([T9]);
  await send(sS, [T9], 'R151C-HOLD 一直不完');
  const [k1] = await fromSession(T9)();
  await waitStatus(k1.id, 'processing');
  r = await send(sS, [T9], 'R151C 卡住前排着');
  eq(r.results[0].delivery, 'queued', '卡住前:目标忙 → queued');
  const k2 = (await fromSession(T9)()).find((m) => m.id !== k1.id);
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 60_000;
  try {
    r = await send(sS, [T9], 'R151C 卡住后新到');
    eq(r.results.map((x) => [x.delivery, x.note]), [['card', HELD['target-stuck']]], '处理超过 30 分钟 → 新到的落 target-stuck');
    xs.noteXsInboundChanged(T9);
    eq((await waitStatus(k2.id, 'pending')).heldReason, 'target-stuck', '排着的也转 target-stuck');
  } finally { Date.now = realNow; }
  eq((await msgById(k1.id)).status, 'processing', '那条不被自动中止');
  const ev9 = ws.find((e) => e.type === 'xs:turn' && e.messageId === k1.id);
  eq((await api('POST', `/chat/${encodeURIComponent(ev9.pid)}/stop`, {})).status, 200, '用户点【停止】');
  eq((await waitStatus(k1.id, 'pending')).heldReason, 'interrupted', '那条结束 → interrupted');
  r = await send(sS, [T9], 'R151C 结束后恢复');
  eq(r.results[0].delivery, 'auto', '那条结束后恢复自动处理');
  await waitStatus((await fromSession(T9)()).at(-1).id, 'done', 15_000);

  // ── ⑥ 连锁 ──
  const H1 = mk('连锁 H1'); const H2 = mk('连锁 H2');
  for (const h of [H1, H2]) await profiled(h);
  await setInbound([H1, H2]);
  let sender = senderOf(S, 'bypassPermissions');
  const hops = [];
  for (const [i, target] of [H1, H2, H1, H2, H1].entries()) {
    r = await send(sender, [target], `R151C 第 ${i + 1} 跳`);
    const m = (await fromSession(target)()).at(-1);
    hops.push(m);
    if (i === 4) break;
    await waitStatus(m.id, 'done');
    await waitIdle(target);
    sender = senderOf(target, 'bypassPermissions'); // 自动处理那个回合的记录(回合已结束,模拟回合结束后再发的后台任务)
  }
  eq(hops.map((m) => m.hop), [1, 2, 3, 4, 5], 'hop 逐跳加 1');
  ok(hops.every((m) => m.chainId === hops[0].chainId), 'chainId 不变');
  eq([hops[4].status, hops[4].heldReason, r.results[0].delivery, r.results[0].note], ['pending', 'chain-limit', 'card', HELD['chain-limit']], 'hop 5 → chain-limit');
  await userTurn(H2);
  await waitIdle(H2);
  r = await send(senderOf(H2, 'bypassPermissions'), [H1], 'R151C 用户发过消息之后');
  const fresh = (await fromSession(H1)()).at(-1);
  ok(fresh.hop === 1 && fresh.chainId !== hops[0].chainId, '用户在该会话发消息后,下一次发送回到 hop 1、新链');
  await waitStatus(fresh.id, 'done');

  // ── ⑦ 上限与输入校验(目标都是"等你确认",只落卡片)──
  const C = Array.from({ length: 9 }, (_, i) => mk(`卡片 C${i + 1}`));
  const R16 = { sessionId: S, runId: 'r16', turnEpoch: 0, guiMode: 'bypassPermissions' };
  const n0 = (await all()).length;
  await rejects(send(R16, C, 'x'), 'XS_TOO_MANY_TARGETS', '去重后 9 个目标');
  await rejects(send(R16, [C[0]], 'x'.repeat(32769)), 'XS_BODY_TOO_LARGE', '正文超过 32768 字节');
  for (const [label, to, message] of [
    ['to 空数组', [], 'x'], ['to 空串', '', 'x'], ['to 全空白项', ['  '], 'x'], ['to 33 项', Array(33).fill(C[0]), 'x'], ['to 单项 257 字', ['标'.repeat(257)], 'x'],
    ['to 非字符串', [1], 'x'], ['message 空白', [C[0]], ' \n '], ['message 非字符串', [C[0]], 5], ['message 65537 字', [C[0]], 'a'.repeat(65537)],
  ]) await rejects(send(R16, to, message), 'XS_INVALID_INPUT', label);
  await rejects(send({ ...R16, sessionId: null }, [C[0]], 'x'), 'XS_INTERNAL', '取不到发送方会话');
  eq((await all()).length, n0, '整次失败一条不发');
  r = await send(R16, [C[0], C[0].slice(0, 8), '卡片 C1', S, '没有这个会话', ...C.slice(1, 7)], 'R151C 合并与单项失败');
  eq(r.results.map((x) => [x.ok, x.error ?? x.delivery, x.note ?? null]).slice(0, 5), [
    [true, 'card', NOTE.card], [true, 'card', NOTE.merged], [true, 'card', NOTE.merged], [false, 'XS_SELF_TARGET', null], [false, 'XS_TARGET_NOT_FOUND', null],
  ], '同一会话写三次只发一条、后两项注明已合并;自己与找不到的单项失败');
  eq((await all()).length, n0 + 7, '实际入箱 7 条(去重后)');
  r = await send(R16, C.slice(0, 8), 'R151C 第二批');
  eq(r.results.filter((x) => x.ok).length, 8, '同一回合再 8 条(共 15)');
  await rejects(send(R16, [C[8], C[7]], 'x'), 'XS_TURN_SEND_LIMIT', '15 + 2 > 16 → 整次失败');
  r = await send(R16, ['没有这个会话', C[8]], 'R151C 第 16 条');
  eq(r.results.map((x) => x.ok), [false, true], '失败项不计入:15 + 1 = 16 可以');
  await rejects(send(R16, [C[8]], 'x'), 'XS_TURN_SEND_LIMIT', '到 16 之后再发 → 整次失败');

  // ── ⑧ 全局 10 分钟 20 次 ──
  let cfg = await api('PUT', '/xsession/config', { autoPaused: false });
  eq([cfg.status, cfg.body], [200, { ok: true, enabled: true, autoPaused: false }], '恢复(本来没暂停也 200),清窗口');
  eq((await api('GET', '/xsession/config')).body.autoBudget, { limit: 20, windowMs: 600000, used: 0 }, '计数清零');
  const P = Array.from({ length: 10 }, (_, i) => mk(`预算 P${i + 1}`));
  for (const p of P) await profiled(p);
  await setInbound(P);
  const B1 = { sessionId: S, runId: 'rb1', turnEpoch: 0, guiMode: 'bypassPermissions' };
  const B2 = { sessionId: S, runId: 'rb2', turnEpoch: 0, guiMode: 'bypassPermissions' };
  const wsBefore = ws.length;
  await send(B1, P.slice(0, 8), 'R151C 预算一');
  await send(B1, [...P.slice(8), ...P.slice(0, 6)], 'R151C 预算二');
  await send(B2, P.slice(6), 'R151C 预算三');
  await waitFor(async () => (await api('GET', '/xsession/config')).body.autoBudget.used === 20, '自动处理满 20 次', 30_000);
  const pausedEv = await waitFor(() => ws.slice(wsBefore).filter((e) => e.type === 'xs:config' && e.autoPaused === true), '触顶广播');
  eq(pausedEv.map((e) => [e.enabled, e.autoPaused]), [[true, true]], '触顶广播一次 xs:config {enabled:true, autoPaused:true}');
  await waitFor(() => prefsFile().xsAutoPaused === true, '暂停写盘');
  r = await send(B2, [P[0]], 'R151C 第 21 条');
  eq(r.results.map((x) => [x.delivery, x.note]), [['card', HELD.paused]], '暂停后 → 卡片 paused');
  Date.now = () => realNow() + 11 * 60_000;
  try {
    cfg = (await api('GET', '/xsession/config')).body;
    eq([cfg.autoPaused, cfg.autoBudget.used], [true, 0], '10 分钟窗口过去:计数滑出,但不自动恢复');
  } finally { Date.now = realNow; }
  cfg = await api('PUT', '/xsession/config', { autoPaused: false });
  eq([cfg.status, cfg.body, prefsFile().xsAutoPaused], [200, { ok: true, enabled: true, autoPaused: false }, undefined], '恢复:200、删掉盘上的暂停');
  eq((await api('GET', '/xsession/config')).body.autoBudget.used, 0, '恢复后计数清零');
  await prefsMod.updatePrefs((p) => { p.xsAutoPaused = true; }); // 模拟重启:内存里没暂停,盘上是暂停
  eq((await api('GET', '/xsession/config')).body.autoPaused, true, '盘上暂停即暂停(重启后仍暂停)');
  r = await send(B2, [P[1]], 'R151C 盘上暂停');
  eq(r.results[0].delivery, 'card', '盘上暂停 → 落 paused 卡片');
  await api('PUT', '/xsession/config', { autoPaused: false });
  // 前 20 条里最后几条可能还在收尾:等 P3 没有处理中 / 排着的消息、进程空闲(否则会如实报 queued)
  await waitFor(async () => (await fromSession(P[2])()).every((m) => m.status !== 'processing' && m.status !== 'queued') && slotOf(P[2])?.idle, 'P3 收尾', 15_000);
  r = await send(B2, [P[2]], 'R151C 恢复后');
  eq(r.results[0].delivery, 'auto', '恢复后自动处理');
  for (const [label, b] of [['autoPaused:true', { autoPaused: true }], ['未知键', { autoPaused: false, x: 1 }], ['空对象', {}], ['enabled 非布尔', { enabled: 'true' }]]) {
    eq((await api('PUT', '/xsession/config', b)).status, 400, `PUT config ${label} → 400`);
  }

  // ── ⑨ 派工 4b 补充约定 ──
  // 1) 回合结果已出、只差输入预测(替身不发 prompt_suggestion → 4 秒收尾窗)→ 按空闲判 auto;投递等收尾再起,不退回排队
  const SX = mk('发送方 SX');
  await userTurn(SX);
  await waitIdle(SX);
  const sX = senderOf(SX, 'bypassPermissions');
  const TS = mk('目标 TS 只差输入预测');
  await profiled(TS);
  await setInbound([TS]);
  await userTurn(TS, 'bypassPermissions', { promptSuggestions: true });
  await waitFor(() => slotOf(TS)?.awaitingSuggestion, 'TS 结果已出、在等输入预测');
  eq(slotOf(TS).busy, true, '前置:只差输入预测时槽仍是 busy(findBusySlot 判据不变)');
  const wsTS = ws.length;
  const rTS = await send(sX, [TS], 'R151C 只差输入预测');
  eq(rTS.results.map((x) => [x.delivery, x.note]), [['auto', NOTE.auto]], '只差输入预测 → 按空闲判:delivery auto');
  const [mTS] = await fromSession(TS)();
  await waitStatus(mTS.id, 'processing', 3000);
  ok(slotOf(TS)?.awaitingSuggestion, '消息已 processing 时输入预测的收尾窗仍在(没被中止,回合等它收尾再起)');
  await waitStatus(mTS.id, 'done', 15_000);
  const seqTS = ws.slice(wsTS).filter((e) => e.type === 'xs:message' && e.message?.id === mTS.id).map((e) => e.message.status);
  ok(seqTS.includes('processing') && !seqTS.slice(seqTS.indexOf('processing')).includes('queued'), `开始处理后没有退回排队(没回"会话正忙"):${seqTS.join('→')}`);
  ok(ws.some((e) => e.type === 'xs:turn' && e.messageId === mTS.id), '收尾后起了回合(xs:turn)');

  // 2) 新会话拿到会话 id(init)即记发送档案:回合还在跑、还没有回合结束通知
  const rNew = await api('POST', '/chat', { prompt: 'R151C-HOLD 新会话首回合', cwd: WORK, model: 'r151c-model', permissionMode: 'bypassPermissions', keepAlive: true });
  eq(rNew.status, 200, `前置:新会话回合 200(${JSON.stringify(rNew.body).slice(0, 160)})`);
  const newSid = await waitFor(() => chat.getActiveChatProcesses().find((p) => p.pid === rNew.body.pid)?.sessionId, '新会话拿到会话 id');
  const profNew = await waitFor(async () => (await store.readXsProfiles()).sessions[newSid], '新会话的档案(回合还在跑)', 3000);
  eq([profNew.judge.mode, profNew.replay.cwd, slotOf(newSid)?.busy], ['bypassPermissions', WORK, true], '拿到会话 id 即记档案,不等回合结束');
  eq((await api('POST', `/chat/${encodeURIComponent(rNew.body.pid)}/stop`, {})).status, 200, '收尾:停止新会话的回合');

  // 3) 名字口径:结果 name、candidates[].name 与 list_sessions 同口径(会话列表标题按来源名规则清洗);清洗前后的写法都认
  const { normalizeXsSourceName: cleanName } = await import('../../server/services/xsession-envelope.js');
  const DT = mk('  R151C "脏"<标题>\u0007尾  ');
  const DN = cleanName(TITLES.get(DT));
  ok(DN !== TITLES.get(DT).trim(), `前置:清洗前后写法不同(${DN})`);
  const rN = await send(sX, [TITLES.get(DT), DN], 'R151C 名字口径');
  eq(rN.results.map((x) => [x.ok, x.name]), [[true, DN], [true, DN]], '清洗前、清洗后的写法都认;结果 name 是清洗后的标题');
  eq(rN.results[1].note, NOTE.merged, '两种写法是同一会话 → 合并');
  mk('R151C 重<名>'); mk('R151C 重名');
  const rA = await send(sX, ['R151C 重名'], 'R151C 重名');
  eq([rA.results[0].error, rA.results[0].candidates.map((c) => c.name)], ['XS_TARGET_AMBIGUOUS', ['R151C 重名', 'R151C 重名']], '清洗后撞名 → 重名;candidates[].name 也是清洗后的');

  console.log(`PASS check-r151c-xs-auto(${checks} 项)`);
} finally {
  await chat.closeAllPersistentProcesses?.();
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(0);
