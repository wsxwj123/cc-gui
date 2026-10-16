#!/usr/bin/env node
// r151c 安全审计之后的修正(接口"审计之后的补充约定";用户裁定"照 CLI 原生:用此刻的设置")。
//   ① 审计 F1:回合专属的附加系统提示(appendSystemPrompt,重跑工具 / 风险续跑才带)不进发送档案、自动处理不带;
//      旧档案里有这个键时读到即忽略;为带着它的那一回合起的进程不复用。
//   ② 审计 S1:读档案快照与收件箱事务之间切了档 → 按最新档位判(存活进程 > 最近一次切档 > 发送档案);
//      切档时偏好文件读不出 → 不再静默跳过,该会话按没有档案判(no-profile),下一次记录成功后恢复。
//   ③ 审计 I1:目标没有存活进程时按"此刻的设置"起进程 —— 全局项取界面同步来的当前值(PUT /api/xsession/send-settings),
//      没同步到时全盘读取按关、附加目录按空;关掉全盘读取、去掉附加目录后冷启的内部回合不带它们;有存活进程且设置相同时照常复用;
//      同步接口的参数校验与固定文案。
//   ④ 复审重要 1:判定之后、起回合之前(等目标上一回合的输入预测收尾)切了档 → 起回合前按同一顺序重读档位:类别变了不起回合、
//      落 class-mismatch;类别没变按新档位起;都不把判定时的旧档位写回(接口"复审之后的补充约定"第 1 条)。
//   ⑤ 复审建议 1:同步请求带界面实例标识 uiId,按界面分开记、取最窄(全盘读取全开才开、附加目录交集、花费上限取小、其余取最近
//      一次同步的);10 分钟没再同步的界面不算;没有有效界面时按最窄、其余退回档案(第 2 条)。
//   ⑥ 复审建议 2:请求体不合规(400)时删掉该 uiId 之前的记录、按其余有效界面重算;uiId 本身不合规时不删任何记录(第 3 条)。
//   ⑦ 复审建议 4:存活进程按更宽的旧设置起、设置变窄后自动处理不复用它;总开关关着时同步接口 409 XS_DISABLED。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身;临时 HOME;端口 6800–6899。
// node tests/unit/check-r151c-xs-audit.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151c-audit-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
const XS_DIR = join(HOME, '.claude-gui', 'xsession');
for (const d of [join(HOME, '.claude', 'sessions'), join(XS_DIR, 'bodies'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
const PREFS = join(HOME, '.claude-gui', 'prefs.json');
const PROFILES = join(XS_DIR, 'profiles.json');
const DAY = 86_400_000;
// 开着,启用时刻在一天前(之后记的档案都算数);旧版本记下的一条档案带着 appendSystemPrompt
writeFileSync(PREFS, JSON.stringify({ xsEnabled: true, xsEnabledAt: new Date(Date.now() - DAY).toISOString() }));
const T_OLD = randomUUID();
writeFileSync(PROFILES, JSON.stringify({ salt: 'ab'.repeat(32), sessions: { [T_OLD]: {
  replay: { cwd: WORK, model: 'm-old', effort: null, addDirs: null, permissionMode: 'default', globalRead: null, appendSystemPrompt: 'R151C-OLD-APPEND', promptSuggestions: null, keepAlive: null, maxBudgetUsd: null, genui: null },
  judge: { mode: 'default', providerFp: '0123456789abcdef', recordedAt: new Date(Date.now() - DAY / 2).toISOString() },
} } }));

registerR151bSdkStub();
const ctl = (globalThis.__r151bSdkControl = {});
const calls = (globalThis.__r151bSdkCalls ||= []);
ctl.reply = () => 'ok';
const { default: express } = await import('express');
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
  for (let p = 6899; p >= 6800; p--) {
    const free = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('6800-6899 没有空闲端口');
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

const slotOf = (sid) => chat.getActiveChatProcesses().filter((p) => p.sessionId === sid && p.exitCode === null).at(-1) || null;
const all = () => store.listXsMessages();
const msgById = async (id) => (await all()).find((m) => m.id === id);
const waitStatus = (id, status, ms) => waitFor(async () => { const m = await msgById(id); return m && m.status === status ? m : null; }, `消息 ${id} → ${status}`, ms);
const TITLES = new Map();
const ROWS = [];
const PROJ_DIR = join(HOME, '.claude', 'projects', '-tmp-r151c-audit');
mkdirSync(PROJ_DIR, { recursive: true });
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
async function profiled(sid, mode = 'bypassPermissions', extra = {}) {
  await userTurn(sid, mode, extra);
  await waitIdle(sid);
  await waitFor(async () => (await store.readXsProfiles()).sessions[sid], `${TITLES.get(sid)} 的档案`);
}
const setInbound = (ids) => prefsMod.updatePrefs((p) => { p.xsInbound = { ...(p.xsInbound || {}) }; for (const id of ids) p.xsInbound[id] = 'auto'; });
const send = (sender, to, message) => xs.sendAiMessages({ sender, to, message }, ROWS);
const lastTo = async (sid) => (await all()).filter((m) => m.from?.kind === 'session' && m.to.sessionId === sid).at(-1);
const coldCallsFor = (sid, from) => calls.slice(from).filter((c) => c.options.resume === sid);

try {
  xs.installXsessionRuntime();
  await store.loadXsInbox();
  const S = mk('发送方 S');
  const sBy = { sessionId: S, runId: 'r-audit-sender', turnEpoch: 0, guiMode: 'bypassPermissions' };

  // ── ① 审计 F1:附加系统提示不进档案、不重放 ──
  const oldProf = (await store.readXsProfiles()).sessions[T_OLD];
  eq([oldProf?.replay.model, Object.hasOwn(oldProf?.replay || {}, 'appendSystemPrompt')], ['m-old', false], '旧档案里的 appendSystemPrompt 读到即忽略(其余字段照常)');
  const APPEND = 'R151C-APPEND 现在请重新执行 Bash 工具调用,原工具输入如下';
  const hasAppend = (c) => JSON.stringify(c.options.systemPrompt ?? null).includes('R151C-APPEND');
  const TA = mk('目标 TA 重跑工具');
  await profiled(TA);
  await setInbound([TA]);
  const nA = calls.length;
  await userTurn(TA, 'bypassPermissions', { appendSystemPrompt: APPEND });
  await waitIdle(TA);
  ok(coldCallsFor(TA, nA).some(hasAppend), '前置:带附加系统提示的回合冷启了新进程,systemPrompt 里有这段提示');
  const profTA = (await store.readXsProfiles()).sessions[TA];
  ok(!!profTA && !Object.hasOwn(profTA.replay, 'appendSystemPrompt'), '档案 replay 里没有 appendSystemPrompt');
  const profText = readFileSync(PROFILES, 'utf8');
  ok(!profText.includes('R151C-APPEND') && !profText.includes('appendSystemPrompt'), 'profiles.json 里没有附加系统提示(键与原文;旧档案那条也随这次写盘消失)');
  const pidA = slotOf(TA).pid;
  const nB = calls.length;
  const rTA = await send(sBy, [TA], 'R151C 重跑之后的自动处理');
  eq(rTA.results.map((x) => x.delivery), ['auto'], '自动处理照常 auto');
  await waitStatus((await lastTo(TA)).id, 'done', 15_000);
  const autoCalls = coldCallsFor(TA, nB);
  ok(autoCalls.length === 1 && !hasAppend(autoCalls[0]), `内部回合冷启的进程不带附加系统提示(冷启 ${autoCalls.length} 次)`);
  ok(slotOf(TA)?.pid !== pidA, '为带附加系统提示那一回合起的进程不复用');

  // ── ② 审计 S1:最近一次切档排在档案之前;偏好读失败不再静默 ──
  const offTurn = async (sid, mode, extra = {}) => { // 不保活的用户回合:跑完进程退出,之后没有存活槽
    await userTurn(sid, mode, { keepAlive: false, ...extra });
    await waitFor(() => !slotOf(sid), `${TITLES.get(sid)} 的进程退出`, 20_000);
    await store.readXsProfiles(); // 同一条存储队列:返回时回合开始那次档案记录已经结束
  };
  const TB = mk('目标 TB 切档竞态');
  await offTurn(TB, 'bypassPermissions');
  await setInbound([TB]);
  eq((await store.readXsProfiles()).sessions[TB]?.judge.mode, 'bypassPermissions', '前置:TB 有「放任」档案、没有存活槽');
  let openQ = null;
  const held = store.mutateXsProfiles(() => new Promise((r) => { openQ = r; })); // 占住存储队列(档案与收件箱共用)
  await waitFor(() => openQ, '占住存储队列');
  const pSend = send(sBy, [TB], 'R151C 切档竞态');
  await sleep(80); // 让这次发送先排上"读档案快照"
  const rPm = await api('POST', '/chat/permission-mode', { sessionId: TB, mode: 'default' }); // 切档的档案写入排在那次读之后
  eq(rPm.status, 200, '前置:没有进程时切档 200');
  openQ(); await held;
  const rB = await pSend;
  eq(rB.results.map((x) => x.delivery), ['card'], '读档案快照与收件箱事务之间切了档:按最新档位判,不按快照里的旧档位');
  eq((await lastTo(TB)).heldReason, 'class-mismatch', '落 class-mismatch(「放任」发送方 → 已切到「逐步确认」的目标)');
  eq((await store.readXsProfiles()).sessions[TB]?.judge.mode, 'default', '切档照常落盘');

  const TC = mk('目标 TC 偏好读失败');
  await offTurn(TC, 'bypassPermissions');
  await setInbound([TC]);
  const prefsText = readFileSync(PREFS, 'utf8');
  let rPm2;
  writeFileSync(PREFS, '{broken');
  try {
    rPm2 = await api('POST', '/chat/permission-mode', { sessionId: TC, mode: 'bypassPermissions' });
    await store.readXsProfiles();
  } finally { writeFileSync(PREFS, prefsText); }
  eq(rPm2.status, 200, '前置:偏好文件读不出时切档照常 200');
  const rC = await send(sBy, [TC], 'R151C 偏好读失败之后');
  eq([rC.results[0].delivery, (await lastTo(TC)).heldReason], ['card', 'no-profile'], '切档时偏好读不出:不当"总开关关着"静默跳过,该会话按没有档案判');
  await offTurn(TC, 'bypassPermissions');
  const rC2 = await send(sBy, [TC], 'R151C 记录成功之后');
  eq(rC2.results.map((x) => x.delivery), ['auto'], '下一次档案记录成功(内容没变也算)后恢复');
  await waitStatus((await lastTo(TC)).id, 'done', 15_000);

  // ── ③ 审计 I1:没有存活进程时按此刻的设置起进程;有存活进程且设置相同时照常复用 ──
  const EXTRA = join(TMP, 'extra');
  mkdirSync(EXTRA, { recursive: true });
  const dirsOf = (c) => c?.options?.additionalDirectories || [];
  const wide = { globalRead: true, addDirs: [EXTRA], maxBudgetUsd: 5 };
  // 3a) 服务端还没收到界面的设置:全盘读取按关、附加目录按空,其余全局项退回档案里上次发送的值
  const TD = mk('目标 TD 没同步');
  const n0 = calls.length;
  await offTurn(TD, 'bypassPermissions', wide);
  const userD = coldCallsFor(TD, n0)[0];
  ok(dirsOf(userD).includes(HOME) && dirsOf(userD).includes(EXTRA), `前置:上次发送开着全盘读取、带附加目录(${JSON.stringify(dirsOf(userD))})`);
  await setInbound([TD]);
  const n1 = calls.length;
  eq((await send(sBy, [TD], 'R151C 没同步')).results.map((x) => x.delivery), ['auto'], '没同步:照常 auto');
  await waitStatus((await lastTo(TD)).id, 'done', 15_000);
  const [autoD] = coldCallsFor(TD, n1);
  ok(!!autoD && ![HOME, EXTRA, '/'].some((d) => dirsOf(autoD).includes(d)), `没同步到:全盘读取按关、附加目录按空(${JSON.stringify(dirsOf(autoD))})`);
  eq(autoD.options.maxBudgetUsd, 5, '没同步到:花费上限退回档案里上次发送的值');
  // 3b) 同步接口:界面实例标识 uiId 加六个键都要给、类型对、不能有别的键
  const SEND_SETTINGS_ERR = '请求体须为 { uiId, globalRead, addDirs, maxBudgetUsd, keepAlive, promptSuggestions, genui }，七个键都要给，不能带其它键（uiId 为 8–64 个字母、数字、- 或 _）';
  const U0 = 'ui-r151c-audit-0';
  const narrow = { globalRead: false, addDirs: [], maxBudgetUsd: null, keepAlive: false, promptSuggestions: false, genui: true };
  const { genui: _g, ...missing } = narrow;
  const badBodies = [[], {}, missing, { ...narrow, extra: 1 }, { ...narrow, globalRead: 'false' }, { ...narrow, addDirs: [1] }, { ...narrow, addDirs: 'x' },
    { ...narrow, addDirs: [''] }, { ...narrow, addDirs: ['x'.repeat(4097)] }, { ...narrow, addDirs: Array(65).fill('/x') }, { ...narrow, maxBudgetUsd: 0 },
    { ...narrow, maxBudgetUsd: '5' }, { ...narrow, maxBudgetUsd: 2e6 }, { ...narrow, promptSuggestions: 'on' }, { ...narrow, keepAlive: null }]
    .map((b) => (Array.isArray(b) ? b : { uiId: U0, ...b }));
  for (const uiId of [undefined, 'ui-1234', 'u'.repeat(65), 'ui r151c x', 'ui/r151c/x', `${U0}\n`, 12345678, [U0]]) badBodies.push(uiId === undefined ? { ...narrow } : { uiId, ...narrow });
  for (const bad of badBodies) {
    const r = await api('PUT', '/xsession/send-settings', bad);
    eq([r.status, r.body?.code, r.body?.error], [400, 'XS_INVALID_INPUT', SEND_SETTINGS_ERR], `不合规 → 400 固定文案(${JSON.stringify(bad).slice(0, 80)})`);
  }
  eq(await api('PUT', '/xsession/send-settings', { uiId: U0, ...narrow, ...wide, promptSuggestions: 'auto' }), { status: 200, body: { ok: true } }, '合规 → 200 {ok:true}');
  eq((await api('PUT', '/xsession/send-settings', { uiId: U0, ...narrow })).status, 200, '同一界面再同步一次:后到的为准');
  // 3c) 关掉全盘读取、去掉附加目录、清空花费上限之后:冷启的内部回合不带它们
  const TE = mk('目标 TE 同步后');
  await offTurn(TE, 'bypassPermissions', wide);
  await setInbound([TE]);
  const n2 = calls.length;
  eq((await send(sBy, [TE], 'R151C 同步后')).results.map((x) => x.delivery), ['auto'], '同步后:照常 auto');
  await waitStatus((await lastTo(TE)).id, 'done', 15_000);
  const [autoE] = coldCallsFor(TE, n2);
  ok(!!autoE && ![HOME, EXTRA, '/'].some((d) => dirsOf(autoE).includes(d)), `关掉全盘读取、去掉附加目录后:冷启的内部回合不带它们(${JSON.stringify(dirsOf(autoE))})`);
  ok(!autoE.options.maxBudgetUsd, '花费上限取界面当前值(已清空)');
  // 3d) 有存活进程、设置与它起进程时相同:照常在现有进程里处理
  const live = { globalRead: true, addDirs: [], maxBudgetUsd: null, keepAlive: true, promptSuggestions: false, genui: true };
  eq((await api('PUT', '/xsession/send-settings', { uiId: U0, ...live })).status, 200, '前置:同步与下面用户回合相同的设置');
  const TF = mk('目标 TF 有存活进程');
  await profiled(TF, 'bypassPermissions', { globalRead: true, keepAlive: true, promptSuggestions: false, genui: true });
  await setInbound([TF]);
  const pidF = slotOf(TF).pid;
  const n3 = calls.length;
  eq((await send(sBy, [TF], 'R151C 有存活进程')).results.map((x) => x.delivery), ['auto'], '有存活进程:照常 auto');
  await waitStatus((await lastTo(TF)).id, 'done', 15_000);
  eq([coldCallsFor(TF, n3).length, slotOf(TF)?.pid], [0, pidF], '有存活进程:不冷启,在现有进程里处理(同一 pid)');

  // ── ④ 复审重要 1:起回合前重读档位(接口"复审之后的补充约定"第 1 条)──
  // 替身不发 prompt_suggestion → 结果出来后有约 4 秒收尾窗;这期间到达的消息按空闲判 auto,回合等收尾之后才起。
  const profileMode = async (sid) => (await store.readXsProfiles()).sessions[sid]?.judge.mode;
  const gotText = (text) => calls.some((c) => c.inputs.some((i) => JSON.stringify(i?.message?.content ?? '').includes(text)));
  // 4a) 「放任」→「放任」判成 auto;等收尾期间目标切到「逐步确认」→ 不起回合,重新判定落 class-mismatch
  const TG = mk('目标 TG 等预测时切档');
  await profiled(TG);
  await setInbound([TG]);
  await userTurn(TG, 'bypassPermissions', { promptSuggestions: true });
  await waitFor(() => slotOf(TG)?.awaitingSuggestion, 'TG 结果已出、在等输入预测');
  eq((await send(sBy, [TG], 'R151C 等预测时切档')).results.map((x) => x.delivery), ['auto'], '前置:只差输入预测 → 按空闲判 auto');
  const mG = await lastTo(TG);
  await waitStatus(mG.id, 'processing', 3000);
  ok(slotOf(TG)?.awaitingSuggestion, '前置:消息已 processing、目标仍在等输入预测(回合还没起)');
  eq((await api('POST', '/chat/permission-mode', { sessionId: TG, mode: 'default' })).status, 200, '前置:等收尾期间切到「逐步确认」');
  const heldG = await waitStatus(mG.id, 'pending', 20_000);
  eq(heldG.heldReason, 'class-mismatch', '起回合前重读到新档位、类别变了:不起回合,重新判定落 class-mismatch');
  ok(!gotText('R151C 等预测时切档'), '没有任何进程收到这条消息');
  eq([slotOf(TG)?.guiMode ?? null, await profileMode(TG)], ['default', 'default'], '存活进程没被改回「放任」;档案里的档位仍是「逐步确认」(没把判定时的旧档位写回)');
  // 4b) 非放任 → 非放任判成 auto;等收尾期间目标从「逐步确认」切到「接受编辑」(类别没变,进程不保活、收尾后冷启)
  //     → 退回排队重新判定,内部回合按新档位起
  const TH = mk('目标 TH 等预测时同类切档');
  await offTurn(TH, 'default');
  await setInbound([TH]);
  const sDef = { sessionId: S, runId: 'r-audit-sender-def', turnEpoch: 0, guiMode: 'default' };
  await userTurn(TH, 'default', { promptSuggestions: true, keepAlive: false });
  await waitFor(() => slotOf(TH)?.awaitingSuggestion, 'TH(不保活)结果已出、在等输入预测');
  eq((await send(sDef, [TH], 'R151C 等预测时同类切档')).results.map((x) => x.delivery), ['auto'], '前置:非放任 → 非放任、只差输入预测 → auto');
  const mH = await lastTo(TH);
  await waitStatus(mH.id, 'processing', 3000);
  eq((await api('POST', '/chat/permission-mode', { sessionId: TH, mode: 'acceptEdits' })).status, 200, '前置:等收尾期间切到「接受编辑」');
  await waitStatus(mH.id, 'done', 30_000);
  ok(gotText('R151C 等预测时同类切档'), '重新判定后照常处理');
  eq(await profileMode(TH), 'acceptEdits', '内部回合按「接受编辑」起(回合开始记下的档位不是判定时的「逐步确认」)');

  // ── ⑤ 复审建议 1:多个界面同时同步时取最窄(接口"复审之后的补充约定"第 2 条)──
  // 目标没有存活进程,每次自动处理都冷启,看内部回合起进程的选项;档案里上次发送的花费上限是 5
  const EXTRA2 = join(TMP, 'extra2'); const EXTRA3 = join(TMP, 'extra3');
  for (const d of [EXTRA2, EXTRA3]) mkdirSync(d, { recursive: true });
  const UB = 'ui-r151c-audit-B';
  const sBy2 = { sessionId: S, runId: 'r-audit-sender-2', turnEpoch: 0, guiMode: 'bypassPermissions' };
  const TK = mk('目标 TK 多个界面');
  await offTurn(TK, 'bypassPermissions', wide);
  await setInbound([TK]);
  const autoCold = async (sid, text) => { // 一次自动处理、冷启的那次 SDK 调用
    await waitFor(() => !slotOf(sid), `${TITLES.get(sid)} 没有存活进程`, 20_000);
    const n = calls.length;
    eq((await send(sBy2, [sid], text)).results.map((x) => x.delivery), ['auto'], `前置:${text} → auto`);
    await waitStatus((await lastTo(sid)).id, 'done', 20_000);
    const [c] = coldCallsFor(sid, n);
    ok(!!c, `${text}:冷启了内部回合`);
    return c;
  };
  const seen = (c) => [HOME, EXTRA, EXTRA2, EXTRA3].map((d) => dirsOf(c).includes(d));
  const putAgo = async (ms, body, what) => { // 把这次同步记在 ms 毫秒之前(只在这一次请求期间平移 Date.now)
    const realNow = Date.now;
    Date.now = () => realNow() - ms;
    try { eq((await api('PUT', '/xsession/send-settings', body)).status, 200, what); } finally { Date.now = realNow; }
  };
  const uiA = { globalRead: true, addDirs: [EXTRA, EXTRA2], maxBudgetUsd: 3, keepAlive: false, promptSuggestions: false, genui: true };
  const uiB = { globalRead: false, addDirs: [EXTRA2, EXTRA3], maxBudgetUsd: null, keepAlive: false, promptSuggestions: true, genui: true };
  // 5a) 两个界面都有效:一开一关取关、附加目录取交集、花费上限取小(null 算最宽);输入预测等取最近一次同步的(界面 B)
  eq((await api('PUT', '/xsession/send-settings', { uiId: U0, ...uiA })).status, 200, '前置:界面 A 同步');
  eq((await api('PUT', '/xsession/send-settings', { uiId: UB, ...uiB })).status, 200, '前置:界面 B 同步(最近一次)');
  const c5a = await autoCold(TK, 'R151C 两个界面');
  eq(seen(c5a), [false, false, true, false], `全盘读取一开一关 → 关;附加目录取交集(${JSON.stringify(dirsOf(c5a))})`);
  eq([c5a.options.maxBudgetUsd, c5a.options.promptSuggestions], [3, true], '花费上限取小(另一个是不限);输入预测取最近一次同步的');
  // 5b) 界面 B 10 分钟没再同步 → 不算,只按界面 A
  await putAgo(11 * 60_000, { uiId: UB, ...uiB }, '前置:界面 B 的同步记在 11 分钟前');
  const c5b = await autoCold(TK, 'R151C 界面 B 过期');
  eq(seen(c5b), [true, true, true, false], `过期的界面不算:全盘读取开、附加目录是界面 A 的(${JSON.stringify(dirsOf(c5b))})`);
  eq([c5b.options.maxBudgetUsd, c5b.options.promptSuggestions], [3, undefined], '花费上限与输入预测都按界面 A');
  // 5c) 没有有效界面 → 全盘读取按关、附加目录按空,其余四项退回档案(档案按每次回合开始记,先让用户发一条把花费上限记成 7)
  await offTurn(TK, 'bypassPermissions', { ...wide, maxBudgetUsd: 7 });
  await putAgo(11 * 60_000, { uiId: U0, ...uiA }, '前置:界面 A 的同步也记在 11 分钟前');
  const c5c = await autoCold(TK, 'R151C 没有有效界面');
  eq(seen(c5c), [false, false, false, false], `没有有效界面:全盘读取按关、附加目录按空(不看档案里上次发送的;${JSON.stringify(dirsOf(c5c))})`);
  eq(c5c.options.maxBudgetUsd, 7, '其余四项退回档案(花费上限是档案里上次发送的 7,不是过期界面 A 的 3)');

  // ── ⑥ 复审建议 2:同步被拒时清掉该界面的值(接口"复审之后的补充约定"第 3 条)──
  const uiN = { globalRead: false, addDirs: [EXTRA2], maxBudgetUsd: 2, keepAlive: false, promptSuggestions: false, genui: true };
  const uiW = { globalRead: true, addDirs: [EXTRA, EXTRA2], maxBudgetUsd: null, keepAlive: false, promptSuggestions: false, genui: true };
  const put = (body) => api('PUT', '/xsession/send-settings', body);
  eq([(await put({ uiId: U0, ...uiN })).status, (await put({ uiId: UB, ...uiW })).status], [200, 200], '前置:窄的界面 0 与宽的界面 B 都同步了');
  // 6a) uiId 本身不合规:400,不删任何记录(界面 0 的窄值仍算数)
  for (const uiId of [`${U0}\n`, ` ${U0}`, U0.slice(0, 7), [U0]]) {
    eq((await put({ uiId, ...uiN, addDirs: Array(65).fill(EXTRA2) })).status, 400, `uiId 不合规 → 400(${JSON.stringify(uiId)})`);
  }
  const c6a = await autoCold(TK, 'R151C uiId 不合规之后');
  eq([seen(c6a), c6a.options.maxBudgetUsd], [[false, false, true, false], 2], `uiId 不合规时不删记录:仍按两个界面取最窄(${JSON.stringify(dirsOf(c6a))})`);
  // 6b) 界面 0 发来不合规的值(附加目录超 64 项;界面照原样发送)→ 400 并删掉界面 0 之前的记录 → 按界面 B 重算
  const r6b = await put({ uiId: U0, ...uiN, addDirs: Array(65).fill(EXTRA2) });
  eq([r6b.status, r6b.body?.code], [400, 'XS_INVALID_INPUT'], '界面 0 的值不合规 → 400');
  const c6b = await autoCold(TK, 'R151C 界面 0 被拒之后');
  eq([seen(c6b), c6b.options.maxBudgetUsd], [[true, true, true, false], undefined], `界面 0 被拒:删掉它之前的窄值,按界面 B 重算(${JSON.stringify(dirsOf(c6b))})`);
  // 6c) 界面 B 也被拒(花费上限 0)→ 没有有效界面 → 按最窄
  eq((await put({ uiId: UB, ...uiW, maxBudgetUsd: 0 })).status, 400, '界面 B 的值不合规 → 400');
  const c6c = await autoCold(TK, 'R151C 两个界面都被拒之后');
  eq(seen(c6c), [false, false, false, false], `都被拒、没有其它有效界面:全盘读取按关、附加目录按空(${JSON.stringify(dirsOf(c6c))})`);

  // ── ⑦ 复审建议 4:补两条断言 ──
  // 7a) 存活进程是按更宽的旧设置起的(全盘读取开);界面现在关掉了全盘读取 → 自动处理不复用它,按此刻的设置新起
  const liveWide = { globalRead: true, addDirs: [], maxBudgetUsd: null, keepAlive: true, promptSuggestions: false, genui: true };
  eq((await put({ uiId: U0, ...liveWide })).status, 200, '前置:界面同步与下面用户回合相同的设置(全盘读取开)');
  const TJ = mk('目标 TJ 设置变窄');
  const nJ0 = calls.length;
  await profiled(TJ, 'bypassPermissions', { globalRead: true, keepAlive: true, promptSuggestions: false, genui: true });
  await setInbound([TJ]);
  const pidJ = slotOf(TJ).pid;
  ok(dirsOf(coldCallsFor(TJ, nJ0)[0]).includes(HOME), '前置:存活进程起的时候开着全盘读取');
  eq((await put({ uiId: U0, ...liveWide, globalRead: false })).status, 200, '前置:界面关掉全盘读取');
  const nJ = calls.length;
  eq((await send(sBy2, [TJ], 'R151C 设置变窄之后')).results.map((x) => x.delivery), ['auto'], '设置变窄之后照常 auto');
  await waitStatus((await lastTo(TJ)).id, 'done', 20_000);
  const coldJ = coldCallsFor(TJ, nJ);
  ok(coldJ.length === 1 && !dirsOf(coldJ[0]).includes(HOME), `不复用按更宽设置起的存活进程:按此刻的设置新起、不带全盘读取(冷启 ${coldJ.length} 次)`);
  ok(slotOf(TJ)?.pid !== pidJ, '换了新进程');
  // 7b) 总开关关着:PUT /api/xsession/send-settings → 409 XS_DISABLED
  const prefsOn = readFileSync(PREFS, 'utf8');
  let rOff;
  writeFileSync(PREFS, JSON.stringify({ ...JSON.parse(prefsOn), xsEnabled: false }));
  try { rOff = await put({ uiId: U0, ...narrow }); } finally { writeFileSync(PREFS, prefsOn); }
  eq([rOff.status, rOff.body?.code], [409, 'XS_DISABLED'], '总开关关着:PUT /api/xsession/send-settings → 409 XS_DISABLED');

  console.log(`PASS check-r151c-xs-audit(${checks} 项)`);
} finally {
  await chat.closeAllPersistentProcesses?.();
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(0);
