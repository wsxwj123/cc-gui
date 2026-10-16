#!/usr/bin/env node
// r151d 跨会话消息二期加固(接口 r151d-xsession-hardening-接口.md 行为清单 1–5 的服务端部分)。
//   ① 行为清单 1、2:内部回合在冷启建进程之前、复用路径置档之前再同步核对一次档位(存活进程 > 最近一次切档 > 发送档案)。
//      冷启等旧进程退出期间切到不同类别 → 不起回合、退回排队重判落 class-mismatch,之后也不回到旧档位;
//      切到同类 → 按新档位起回合;复用路径热切模型期间切档 → 不起回合、关掉那个常驻进程、重判。
//      切档时旧进程的输入流已关(真 SDK 的控制请求送不到,要等它退出才失败)→ 只改本地档位、立即 200,不挂到旧进程退出、不报 409。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身(onInputEnd 模拟旧进程推迟退出、setModel 模拟热切让出事件循环);临时 HOME;端口 6930–6979。
// node tests/unit/check-r151d-xs-hardening.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
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

  console.log(`PASS check-r151d-xs-hardening(${checks} 项)`);
} finally {
  ctl.onInputEnd = null; ctl.setModel = null; ctl.setPermissionMode = null;
  await chat.closeAllPersistentProcesses?.();
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
