#!/usr/bin/env node
// r151d 跨会话消息二期加固(接口 r151d-xsession-hardening-接口.md 行为清单 1–5 的服务端部分)。
//   ① 行为清单 1、2:内部回合在冷启建进程之前、复用路径置档之前再同步核对一次档位(存活进程 > 最近一次切档 > 发送档案)。
//      冷启等旧进程退出期间切到不同类别 → 不起回合、退回排队重判落 class-mismatch,之后也不回到旧档位;
//      切到同类 → 按新档位起回合;复用路径热切模型期间切档 → 不起回合、关掉那个常驻进程、重判。
//      切档时旧进程的输入流已关(真 SDK 的控制请求送不到,要等它退出才失败)→ 立即 200,不挂到旧进程退出、不报 409
//      (r151f 起:输入已关的进程不收切档请求、不计数、档位字段不动,没有可用进程 → attempted 0、200;原为"只改本地档位、算收下")。
//      判官 S2:用户切档的控制请求还没返回时到达的自动处理 → 不起回合、退回排队;切档完成后按新档位重判。
//   ② 行为清单 3:多个界面同步全局设置时,常驻进程 / 输入预测 / 生图界面取最近一次发生变化的那个界面的值;
//      值完全相同的定时重同步只刷新有效期,不改变生效值。
//   ③ 行为清单 4、5:档案写盘失败的会话 id 随偏好写入落盘(xsProfileWriteFailed)、服务启动时读回,档案成功写入一次后清除;
//      偏好文件也写不进 / 在却读不出时只记日志、内存标记照旧,不整份覆盖偏好文件;新偏好键的读取规则。
//      判官 R1:启动时偏好文件读不出、之后能读 → 被标记的会话仍按没有档案判;别的会话写失败落盘不删盘上原有的标记。
//      判官 S3:名单落盘失败后,之后再有会话被标记(含同一会话再次写失败)时重试落盘。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身(onInputEnd 模拟旧进程推迟退出、setModel 模拟热切让出事件循环);临时 HOME;端口 6930–6979。
// node tests/unit/check-r151d-xs-hardening.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151d-hardening-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
const XS_DIR = join(HOME, '.claude-gui', 'xsession');
for (const d of [join(HOME, '.claude', 'sessions'), join(XS_DIR, 'bodies'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
const PREFS = join(HOME, '.claude-gui', 'prefs.json');
writeFileSync(PREFS, JSON.stringify({ xsEnabled: true, xsEnabledAt: new Date(Date.now() - 86_400_000).toISOString() }));

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
  for (let p = 6979; p >= 6930; p--) {
    const free = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('6930-6979 没有空闲端口');
}
const deferred = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
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
const PROJ_DIR = join(HOME, '.claude', 'projects', '-tmp-r151d-hardening');
mkdirSync(PROJ_DIR, { recursive: true });
const mk = (title) => {
  const sid = randomUUID();
  TITLES.set(sid, title);
  ROWS.push({ sessionId: sid, title, project: 'work', projectDir: WORK });
  writeFileSync(join(PROJ_DIR, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${sid.slice(0, 8)}-u`, sessionId: sid, message: { role: 'user', content: title } })}\n`);
  return sid;
};
// 用户回合的全局设置(与界面同步的键同名);keepAlive 开着,回合后进程常驻
const LIVE = { globalRead: true, keepAlive: true, promptSuggestions: false, genui: true };
async function userTurn(sid, mode, extra = {}) {
  const r = await api('POST', '/chat', { sessionId: sid, prompt: 'r151d 用户回合', cwd: WORK, model: 'r151d-model', permissionMode: mode, ...LIVE, ...extra });
  eq(r.status, 200, `前置:${TITLES.get(sid)} 的回合 200(${JSON.stringify(r.body).slice(0, 160)})`);
  return r.body.pid;
}
const waitIdle = (sid) => waitFor(() => { const s = slotOf(sid); return s && s.idle ? s : null; }, `${TITLES.get(sid)} 空闲`);
async function residentWithProfile(sid, mode, extra = {}) {
  await userTurn(sid, mode, extra);
  await waitIdle(sid);
  await waitFor(async () => (await store.readXsProfiles()).sessions[sid], `${TITLES.get(sid)} 的档案`);
}
const setInbound = (ids) => prefsMod.updatePrefs((p) => { p.xsInbound = { ...(p.xsInbound || {}) }; for (const id of ids) p.xsInbound[id] = 'auto'; });
const send = (sender, to, message) => xs.sendAiMessages({ sender, to, message }, ROWS);
const lastTo = async (sid) => (await all()).filter((m) => m.from?.kind === 'session' && m.to.sessionId === sid).at(-1);
const gotText = (text) => calls.some((c) => c.inputs.some((i) => JSON.stringify(i?.message?.content ?? '').includes(text)));
const profileMode = async (sid) => (await store.readXsProfiles()).sessions[sid]?.judge.mode;
const syncUi = async (uiId, v) => eq((await api('PUT', '/xsession/send-settings', { uiId, globalRead: false, addDirs: [], maxBudgetUsd: null, keepAlive: true, promptSuggestions: false, genui: true, ...v })).status, 200, `前置:界面 ${uiId} 同步 ${JSON.stringify(v)}`);

try {
  xs.installXsessionRuntime();
  await store.loadXsInbox();
  const S = mk('发送方 S');
  const sBypass = { sessionId: S, runId: 'r-d-sender-bypass', turnEpoch: 0, guiMode: 'bypassPermissions' };
  const sDefault = { sessionId: S, runId: 'r-d-sender-default', turnEpoch: 0, guiMode: 'default' };

  // ── ① 冷启等旧进程退出期间切档(行为清单 1、2)──
  // 目标有常驻进程(按全盘读取开起的);界面把全盘读取同步为关 → 自动处理关旧开新,旧进程被关输入流后推迟退出,这期间切档。
  // 同真 SDK:输入流已关的进程收不到控制请求,热切档位要等它退出才以失败收场(不能指望它及时改掉旧进程的档位)
  ctl.setPermissionMode = (record) => (record.inputEnded
    ? (record.exitGate || Promise.resolve()).then(() => { throw new Error('r151d stub:进程已退出,控制请求没有送达'); })
    : null);
  await syncUi('ui-r151d-unit-a', { globalRead: false });
  const holdExitOf = (sid) => { // 让 sid 的常驻进程被关输入流后推迟退出;返回 { asked, release }
    const asked = deferred(); const gate = deferred();
    ctl.onInputEnd = (record) => {
      if (record.options.resume !== sid) return null;
      record.exitGate = gate.p;
      asked.open(record);
      return gate.p;
    };
    return { asked: asked.p, release: () => { gate.open(); ctl.onInputEnd = null; } };
  };
  // 1a) 「放任」目标、「放任」发送方 → auto;旧进程退出前切到「逐步确认」→ 不起回合,重判落 class-mismatch;之后再发一条同样落卡片
  const TA = mk('目标 TA 冷启等待时换类别');
  await residentWithProfile(TA, 'bypassPermissions');
  await setInbound([TA]);
  const hA = holdExitOf(TA);
  eq((await send(sBypass, [TA], 'R151D-UNIT 冷启等待 换类别')).results.map((x) => x.delivery), ['auto'], '前置:放任 → 放任 auto');
  const mA = await lastTo(TA);
  await Promise.race([hA.asked, sleep(10_000).then(() => { throw new Error('等不到:TA 的旧进程被关输入流'); })]);
  ok((await msgById(mA.id)).status === 'processing', '前置:旧进程推迟退出中,消息已 processing、新进程还没起');
  eq((await api('POST', '/chat/permission-mode', { sessionId: TA, mode: 'default' })).status, 200, '前置:旧进程退出前切到「逐步确认」→ 200');
  hA.release();
  const heldA = await waitStatus(mA.id, 'pending', 20_000);
  eq(heldA.heldReason, 'class-mismatch', '旧进程退出前切到不同类别:不按判定时的「放任」起回合,退回排队重判落 class-mismatch');
  ok(!gotText('R151D-UNIT 冷启等待 换类别'), '没有任何进程收到这条消息');
  eq(await profileMode(TA), 'default', '档案里的档位是切档后的「逐步确认」(没被判定时的旧档位写回)');
  eq((await send(sBypass, [TA], 'R151D-UNIT 冷启等待 换类别之后')).results.map((x) => x.delivery), ['card'], '之后「放任」发送方再发一条 → 卡片(不回到旧档位)');
  eq((await lastTo(TA)).heldReason, 'class-mismatch', '之后那条同样落 class-mismatch');

  // 1b) 「逐步确认」目标、「逐步确认」发送方 → auto;旧进程退出前切到「接受编辑」→ 重判后按「接受编辑」起回合
  const TB = mk('目标 TB 冷启等待时同类切档');
  await residentWithProfile(TB, 'default');
  await setInbound([TB]);
  const hB = holdExitOf(TB);
  eq((await send(sDefault, [TB], 'R151D-UNIT 冷启等待 同类')).results.map((x) => x.delivery), ['auto'], '前置:逐步确认 → 逐步确认 auto');
  const mB = await lastTo(TB);
  await Promise.race([hB.asked, sleep(10_000).then(() => { throw new Error('等不到:TB 的旧进程被关输入流'); })]);
  eq((await api('POST', '/chat/permission-mode', { sessionId: TB, mode: 'acceptEdits' })).status, 200, '前置:旧进程退出前切到「接受编辑」→ 200');
  hB.release();
  eq((await waitStatus(mB.id, 'done', 20_000)).via, 'auto', '同类切档:照常自动处理(done、via:auto)');
  ok(gotText('R151D-UNIT 冷启等待 同类'), '这条消息被一个回合处理了');
  eq([slotOf(TB)?.guiMode ?? null, await profileMode(TB)], ['acceptEdits', 'acceptEdits'], '处理它的回合按「接受编辑」起(进程档位与回合开始记下的档位都是新档位)');

  // 1c) 复用路径热切模型期间切档:目标有常驻进程、设置相同(复用),档案里的模型与进程的不同 → 热切模型,这期间切到「逐步确认」
  //     → 置档之前核对到档位变了:不起回合、关掉那个常驻进程、重判落 class-mismatch
  await syncUi('ui-r151d-unit-a', { globalRead: true });
  const TC = mk('目标 TC 热切时切档');
  await residentWithProfile(TC, 'bypassPermissions');
  await setInbound([TC]);
  await store.mutateXsProfiles((d) => { d.sessions[TC].replay.model = 'r151d-other-model'; });
  const pidC = slotOf(TC).pid;
  const swapAsked = deferred(); const swapGate = deferred();
  ctl.setModel = (record, m) => { if (record.options.resume !== TC) return null; swapAsked.open(m); return swapGate.p; };
  const nC = calls.length;
  eq((await send(sBypass, [TC], 'R151D-UNIT 热切时切档')).results.map((x) => x.delivery), ['auto'], '前置:放任 → 放任 auto');
  const mC = await lastTo(TC);
  eq(await Promise.race([swapAsked.p, sleep(10_000).then(() => 'timeout')]), 'r151d-other-model', '前置:复用常驻进程、正在热切模型');
  eq((await api('POST', '/chat/permission-mode', { sessionId: TC, mode: 'default' })).status, 200, '前置:热切期间切到「逐步确认」→ 200');
  swapGate.open(); ctl.setModel = null;
  eq((await waitStatus(mC.id, 'pending', 20_000)).heldReason, 'class-mismatch', '热切期间切到不同类别:置档之前核对到,不起回合、重判落 class-mismatch');
  ok(!gotText('R151D-UNIT 热切时切档'), '没有任何进程收到这条消息');
  await waitFor(() => !chat.getActiveChatProcesses().some((p) => p.pid === pidC && p.exitCode === null), 'TC 的常驻进程被关掉', 10_000);
  eq(calls.slice(nC).filter((c) => c.options.resume === TC).length, 0, '也没有为它冷启新进程');

  // 1d) 判官 S2:用户切档的控制请求还没返回时(槽与最近一次切档都还是旧档位)到达的自动处理 → 不起回合、退回排队;
  //     切档完成后按新档位重判(逐步确认 → 放任:「逐步确认」发送方的这条落 class-mismatch,不在「放任」下运行)
  const TS = mk('目标 TS 切档进行中');
  await residentWithProfile(TS, 'default');
  await setInbound([TS]);
  await store.mutateXsProfiles((d) => { d.sessions[TS].replay.model = 'r151d-other-model-s'; }); // 复用路径要热切模型:在这里让出事件循环
  const hS = holdExitOf(TS); // 核对不通过时那个常驻进程被关掉:让它晚点退出(挂着的切档控制请求不被中止)
  const swapS = deferred(); const swapGateS = deferred();
  ctl.setModel = (record, m) => { if (record.options.resume !== TS) return null; swapS.open(m); return swapGateS.p; };
  const prevSetMode = ctl.setPermissionMode;
  const modeAsked = deferred(); const modeGate = deferred();
  ctl.setPermissionMode = (record, m) => (record.options.resume === TS && !record.inputEnded ? (modeAsked.open(m), modeGate.p) : prevSetMode(record, m));
  try {
    eq((await send(sDefault, [TS], 'R151D-UNIT 切档进行中')).results.map((x) => x.delivery), ['auto'], '前置:逐步确认 → 逐步确认 auto');
    const mS = await lastTo(TS);
    eq(await Promise.race([swapS.p, sleep(10_000).then(() => 'timeout')]), 'r151d-other-model-s', '前置:复用常驻进程、正在热切模型');
    const switching = api('POST', '/chat/permission-mode', { sessionId: TS, mode: 'bypassPermissions' });
    await Promise.race([modeAsked.p, sleep(10_000).then(() => { throw new Error('等不到:TS 的切档控制请求'); })]);
    swapGateS.open(); ctl.setModel = null;
    eq((await waitStatus(mS.id, 'queued', 10_000)).via ?? null, null, '切档控制请求挂起期间:置档之前核对到切档正在进行,不起回合、退回排队');
    await sleep(400);
    eq((await msgById(mS.id)).status, 'queued', '切档完成之前一直排着(不按切档前的档位再投)');
    ok(!gotText('R151D-UNIT 切档进行中'), '没有任何进程收到这条消息');
    modeGate.open();
    eq((await switching).status, 200, '前置:切档完成(200)');
    eq((await waitStatus(mS.id, 'pending', 10_000)).heldReason, 'class-mismatch', '切档完成后按新档位重判:「逐步确认」发送方 vs「放任」目标 → class-mismatch');
    ok(!gotText('R151D-UNIT 切档进行中'), '始终没有进程收到这条消息(没在「放任」下运行)');
  } finally {
    ctl.setPermissionMode = prevSetMode; ctl.setModel = null;
    modeGate.open(); swapGateS.open(); hS.release();
  }

  // ── ② 多个界面:常驻进程 / 输入预测 / 生图界面三项取最近一次发生变化的那个界面的值(行为清单 3)──
  // 目标先跑一个不保活的用户回合(建档、进程退出);之后每次自动处理看回合结束后进程是否常驻(空闲进程留着)。
  xs.forgetXsSendSettings('ui-r151d-unit-a');
  const TK = mk('目标 TK 多界面');
  await userTurn(TK, 'bypassPermissions', { keepAlive: false });
  await waitFor(() => !slotOf(TK), 'TK 的进程退出', 20_000);
  await waitFor(async () => (await store.readXsProfiles()).sessions[TK], 'TK 的档案');
  await setInbound([TK]);
  const autoThenResident = async (text) => {
    eq((await send(sBypass, [TK], text)).results.map((x) => x.delivery), ['auto'], `前置:${text} → auto`);
    await waitStatus((await lastTo(TK)).id, 'done', 20_000);
    await sleep(600);
    const s = slotOf(TK);
    return !!s && s.idle;
  };
  const UA = 'ui-r151d-unit-A'; const UB = 'ui-r151d-unit-B';
  await syncUi(UA, { keepAlive: true });
  await syncUi(UB, { keepAlive: false });
  eq(await autoThenResident('R151D-UNIT 多界面 一'), false, '界面 A 开、随后 B 关:取最近一次变化的 B → 回合后不常驻');
  await syncUi(UA, { keepAlive: true });
  eq(await autoThenResident('R151D-UNIT 多界面 二'), false, 'A 用完全相同的值重同步(定时):不算变化,仍取 B → 不常驻');
  await syncUi(UB, { keepAlive: true });
  eq(await autoThenResident('R151D-UNIT 多界面 三'), true, 'B 改成开:取 B → 回合后常驻');
  await syncUi(UA, { keepAlive: false });
  eq(await autoThenResident('R151D-UNIT 多界面 四'), false, 'A 改成关:A 成了最近一次变化的界面 → 回合后不常驻(不是"取最近一次同步",也不是"取最窄")');
  await syncUi(UB, { keepAlive: true });
  eq(await autoThenResident('R151D-UNIT 多界面 五'), false, 'B 用相同的值重同步:仍取 A → 不常驻');

  // ── ③ 档案写盘失败标记落盘、启动时读回(行为清单 4、5)──
  const PROFILES = join(XS_DIR, 'profiles.json');
  const GUI_DIR = join(HOME, '.claude-gui');
  const prefsJson = () => { try { return JSON.parse(readFileSync(PREFS, 'utf8')); } catch { return null; } };
  const failedIdsOnDisk = () => prefsJson()?.xsProfileWriteFailed ?? null;
  const hasProfile = async (sid) => xs.profileCountsFor(sid, (await store.readXsProfiles()).sessions[sid], prefsMod.readXsPrefsSync().enabledAt);
  let asideN = 0;
  const blockProfiles = () => { // profiles.json 的位置被一个目录占住:档案写入最后的改名落不下去(收件箱照常可写)
    renameSync(PROFILES, join(TMP, `profiles-aside-${asideN++}.json`));
    mkdirSync(PROFILES); writeFileSync(join(PROFILES, 'keep'), 'x');
  };
  const unblockProfiles = () => renameSync(PROFILES, join(TMP, `profiles-block-${asideN++}`));
  const offTurn = async (sid, mode, extra = {}) => { // 不保活的用户回合:跑完进程退出
    await userTurn(sid, mode, { keepAlive: false, ...extra });
    await waitFor(() => !slotOf(sid), `${TITLES.get(sid)} 的进程退出`, 20_000);
  };
  const TW = mk('目标 TW 写盘失败');
  const TX = mk('目标 TX 启动读回');
  await offTurn(TW, 'bypassPermissions');
  await offTurn(TX, 'bypassPermissions');
  await waitFor(async () => { const d = await store.readXsProfiles(); return d.sessions[TW] && d.sessions[TX]; }, 'TW、TX 的档案');
  await setInbound([TW, TX]);
  eq([await hasProfile(TW), await hasProfile(TX), failedIdsOnDisk()], [true, true, null], '前置:两个会话都有可用档案,偏好文件里没有写失败标记');
  // 3a) 档案写盘失败 → 按没有档案判;会话 id(小写)随偏好写入落盘
  blockProfiles();
  await offTurn(TW, 'bypassPermissions', { model: 'r151d-model-w2' });
  await waitFor(() => (failedIdsOnDisk() || []).includes(TW.toLowerCase()), '写失败标记落进偏好文件');
  eq(failedIdsOnDisk(), [TW.toLowerCase()], '偏好文件里只记会话 id(小写),不记档案内容');
  ok(!(await hasProfile(TW)), '写失败:TW 按没有档案判');
  eq((await send(sBypass, [TW], 'R151D-UNIT 写失败之后')).results.map((x) => x.delivery), ['card'], '「放任」发送方发来 → 卡片');
  eq((await lastTo(TW)).heldReason, 'no-profile', '落 no-profile');
  // 3b) 服务启动时读回(模拟重启:偏好文件里另记着 TX 和几项非法值,重新装一次运行时)→ TX 按没有档案判
  await prefsMod.updatePrefs((p) => { p.xsProfileWriteFailed = [...(p.xsProfileWriteFailed || []), TX, 'not-a-session-id', 42]; });
  xs.installXsessionRuntime();
  eq([await hasProfile(TW), await hasProfile(TX)], [false, false], '启动时读回:偏好文件里记着的会话按没有档案判');
  // 3c) 恢复可写、TW 再跑一个回合 → 档案写成一次 → 标记清掉(偏好文件里也删掉);TX 记录成功(内容没变也算)后同样清掉
  unblockProfiles();
  await offTurn(TW, 'bypassPermissions', { model: 'r151d-model-w3' });
  await waitFor(async () => (await hasProfile(TW)) && !(failedIdsOnDisk() || []).includes(TW.toLowerCase()), 'TW 档案写成后标记清掉');
  eq(failedIdsOnDisk(), [TX.toLowerCase()], 'TW 的标记从偏好文件里删掉(只剩 TX)');
  await offTurn(TX, 'bypassPermissions');
  await waitFor(async () => (await hasProfile(TX)) && failedIdsOnDisk() === null, 'TX 记录成功后标记清掉、偏好键删掉');
  eq((await send(sBypass, [TW], 'R151D-UNIT 恢复之后')).results.map((x) => x.delivery), ['auto'], '恢复后「放任」发送方发来 → 自动处理');
  await waitStatus((await lastTo(TW)).id, 'done', 20_000);
  // 3d) 偏好文件也写不进:只记日志,内存标记照旧(按没有档案判)
  const TV = mk('目标 TV 偏好也写不进');
  await offTurn(TV, 'bypassPermissions');
  await waitFor(async () => (await store.readXsProfiles()).sessions[TV], 'TV 的档案');
  await setInbound([TV]);
  const prefsBefore = readFileSync(PREFS, 'utf8');
  blockProfiles();
  chmodSync(GUI_DIR, 0o500);
  try {
    await offTurn(TV, 'bypassPermissions', { model: 'r151d-model-v2' });
    await waitFor(async () => !(await hasProfile(TV)), 'TV 按没有档案判');
    await sleep(300);
    eq(readFileSync(PREFS, 'utf8'), prefsBefore, '偏好文件写不进:文件原样(只记日志)');
  } finally { chmodSync(GUI_DIR, 0o700); }
  unblockProfiles();
  ok(!(await hasProfile(TV)), '内存标记照旧');
  // 3e) 偏好文件在、却读不出:写失败标记不落盘,也不拿空对象把它整份覆盖
  const TU = mk('目标 TU 偏好读不出');
  const prefsGood = readFileSync(PREFS, 'utf8');
  writeFileSync(PREFS, '{broken');
  try {
    await offTurn(TU, 'bypassPermissions');
    await sleep(500);
    eq(readFileSync(PREFS, 'utf8'), '{broken', '偏好文件读不出:不被写失败标记的写入整份覆盖');
  } finally { writeFileSync(PREFS, prefsGood); }
  // 3f) 新偏好键的读取规则(同已有偏好键:读到非法值不报错、不改写文件)
  const ID1 = randomUUID(); const ID2 = randomUUID();
  for (const v of [undefined, null, 'x', 1, {}, [1, null, 'nope']]) eq(prefsMod.normalizeXsProfileWriteFailed({ xsProfileWriteFailed: v }), [], `xsProfileWriteFailed=${JSON.stringify(v)} → []`);
  eq(prefsMod.normalizeXsProfileWriteFailed({ xsProfileWriteFailed: [ID1.toUpperCase(), 'nope', ID2, ID1] }), [ID2, ID1], '只留会话 id 形状的,转小写、去重(按最后一次出现排)');
  const many = Array.from({ length: prefsMod.XS_PROFILE_WRITE_FAILED_MAX + 5 }, () => randomUUID());
  eq(prefsMod.normalizeXsProfileWriteFailed({ xsProfileWriteFailed: many }), many.slice(5), `最多留最后 ${prefsMod.XS_PROFILE_WRITE_FAILED_MAX} 个`);
  for (const bad of [null, [], 'x']) eq(prefsMod.normalizeXsProfileWriteFailed(bad), [], `偏好不是对象(${JSON.stringify(bad)})→ []`);
  const goodNow = readFileSync(PREFS, 'utf8');
  writeFileSync(PREFS, JSON.stringify({ ...JSON.parse(goodNow), xsProfileWriteFailed: 'oops' }));
  const oopsText = readFileSync(PREFS, 'utf8');
  eq([prefsMod.readXsProfileWriteFailedSync(), readFileSync(PREFS, 'utf8')], [{ ids: [], readFailed: false }, oopsText], '读到非法值:按 [] 处理、不报错、不改写文件');
  // 判官 R1:读不出时的 [] 是放宽方向,读取要区分"文件不存在"(没有标记)与其它失败(readFailed,调用方读到之前一律按没有档案判)
  writeFileSync(PREFS, '{broken');
  eq(prefsMod.readXsProfileWriteFailedSync(), { ids: [], readFailed: true }, '偏好文件损坏 → readFailed(不当作没有标记)');
  writeFileSync(PREFS, goodNow);
  chmodSync(PREFS, 0o000);
  try { eq(prefsMod.readXsProfileWriteFailedSync(), { ids: [], readFailed: true }, '偏好文件在、却读不出 → readFailed'); } finally { chmodSync(PREFS, 0o644); }
  renameSync(PREFS, `${PREFS}.aside`);
  try { eq(prefsMod.readXsProfileWriteFailedSync(), { ids: [], readFailed: false }, '偏好文件不存在 → 没有标记(不算读失败)'); } finally { renameSync(`${PREFS}.aside`, PREFS); }

  // 3g) 判官 R1:启动这一刻偏好文件在、却读不出(Windows 上被杀毒 / 备份软件占着),之后又能读了 → 读到写失败名单之前一律按没有档案判,
  //     读到之后被标记的会话仍按没有档案判;别的会话写失败落盘时先并进盘上已有的名单,不把本进程没读到的标记删掉
  const TY = mk('目标 TY 启动时名单读不出');
  const TZ = mk('目标 TZ 之后写失败');
  await offTurn(TY, 'bypassPermissions');
  await offTurn(TZ, 'bypassPermissions');
  await waitFor(async () => { const d = await store.readXsProfiles(); return d.sessions[TY] && d.sessions[TZ]; }, 'TY、TZ 的档案');
  await setInbound([TY, TZ]);
  eq([await hasProfile(TY), await hasProfile(TZ)], [true, true], '前置:TY、TZ 都有可用档案');
  writeFileSync(PREFS, JSON.stringify({ ...prefsJson(), xsProfileWriteFailed: [TY.toLowerCase()] })); // 上次运行里标记过 TY(本进程内存里没有)
  chmodSync(PREFS, 0o000);
  try { xs.installXsessionRuntime(); } finally { chmodSync(PREFS, 0o644); } // 模拟重启:启动这一刻偏好文件读不出
  xs.syncXsRuntimeHooks(true); // 启动时总开关也读成了关、回合钩子被撤;按开着重新挂上(同 PUT /api/xsession/config)
  const asideY = join(TMP, 'profiles-aside-y.json');
  renameSync(PROFILES, asideY); mkdirSync(PROFILES); writeFileSync(join(PROFILES, 'keep'), 'x'); // 只让发送档案写不进
  await offTurn(TZ, 'bypassPermissions', { model: 'r151d-model-z2' });
  await waitFor(() => (failedIdsOnDisk() || []).includes(TZ.toLowerCase()), 'TZ 的写失败标记落进偏好文件');
  ok(failedIdsOnDisk().includes(TY.toLowerCase()), '别的会话写失败落盘之后:盘上原有的 TY 标记还在(先并进盘上已有的名单再写)');
  renameSync(PROFILES, join(TMP, 'profiles-block-y')); renameSync(asideY, PROFILES); // 放回写失败之前那份档案(TY 的档案仍在、仍算新)
  eq([await hasProfile(TY), await hasProfile(TZ)], [false, false], '偏好文件能读之后:被标记的 TY 仍按没有档案判(读回了盘上的名单),TZ 同样');
  eq((await send(sBypass, [TY], 'R151D-UNIT 启动时名单读不出之后')).results.map((x) => x.delivery), ['card'], '「放任」发送方发给 TY → 卡片');
  eq((await lastTo(TY)).heldReason, 'no-profile', '落 no-profile(不按盘上那份较早的档案判)');
  // 3h) 判官 S3:名单落盘失败后会重试 —— 同一会话再次写失败(内存里已有它的标记)时,偏好文件已恢复可写就补写进去
  const TQ = mk('目标 TQ 落盘失败后重试');
  await offTurn(TQ, 'bypassPermissions');
  await waitFor(async () => (await store.readXsProfiles()).sessions[TQ], 'TQ 的档案');
  ok(await hasProfile(TQ), '前置:TQ 有可用档案');
  const profQ = (await store.readXsProfiles()).sessions[TQ];
  const asideQ = join(TMP, 'profiles-aside-q.json');
  renameSync(PROFILES, asideQ); mkdirSync(PROFILES); writeFileSync(join(PROFILES, 'keep'), 'x');
  chmodSync(GUI_DIR, 0o500);
  try {
    await offTurn(TQ, 'bypassPermissions', { model: 'r151d-model-q2' });
    await waitFor(() => !xs.profileCountsFor(TQ, profQ, prefsMod.readXsPrefsSync().enabledAt), 'TQ 写失败、被标记(按没有档案判)');
    await sleep(300);
    ok(!(failedIdsOnDisk() || []).includes(TQ.toLowerCase()), '前置:偏好文件写不进,TQ 的标记没落盘');
  } finally { chmodSync(GUI_DIR, 0o700); }
  await offTurn(TQ, 'bypassPermissions', { model: 'r151d-model-q3' }); // 偏好文件已可写,发送档案仍写不进:同一会话再次写失败
  await waitFor(() => (failedIdsOnDisk() || []).includes(TQ.toLowerCase()), '上次落盘失败:同一会话再次写失败时重试、标记落进偏好文件', 10_000);
  ok(failedIdsOnDisk().includes(TY.toLowerCase()), '重试写入同样保留盘上原有的标记');
  renameSync(PROFILES, join(TMP, 'profiles-block-q')); renameSync(asideQ, PROFILES);

  console.log(`PASS check-r151d-xs-hardening(${checks} 项)`);
} finally {
  ctl.onInputEnd = null; ctl.setModel = null; ctl.setPermissionMode = null;
  await chat.closeAllPersistentProcesses?.();
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
