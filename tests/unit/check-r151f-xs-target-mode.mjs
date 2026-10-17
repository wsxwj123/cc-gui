#!/usr/bin/env node
// r151f 修法 4:进程视图带出"可用"(usable:存活、不在关闭中、输入没关);跨会话判定的目标此刻档位只看可用进程,
// 都没有时按最近一次切档、再按档案。
//   3a) 常驻空闲进程 usable 为 true;
//   3b) 只有一个输入已关、推迟退出的旧进程(它不跟随切档,guiMode 停在旧的「放任」):切到「逐步确认」→ 200、attempted 0;
//       之后「放任」发送方的消息 → 卡片(按最近一次切档的「逐步确认」判 class-mismatch),不取旧进程的「放任」。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身(onInputEnd 模拟旧进程推迟退出);临时 HOME;端口 6780–6819。
// node tests/unit/check-r151f-xs-target-mode.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151f-xs-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
const XS_DIR = join(HOME, '.claude-gui', 'xsession');
for (const d of [join(HOME, '.claude', 'sessions'), join(XS_DIR, 'bodies'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
writeFileSync(join(HOME, '.claude-gui', 'prefs.json'), JSON.stringify({ xsEnabled: true, xsEnabledAt: new Date(Date.now() - 86_400_000).toISOString() }));

registerR151bSdkStub();
const ctl = (globalThis.__r151bSdkControl = {});
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
  for (let p = 6819; p >= 6780; p--) {
    const free = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('6780-6819 没有空闲端口');
}
const deferred = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const app = express();
app.use(express.json());
app.use('/api', chat.default);
app.use('/api', xsRoutes.default);
const port = await freePort();
await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ok = (c, m) => assert.ok(c, m);
const eq = (a, b, m) => assert.deepEqual(a, b, m);

const procOf = (sid) => chat.getActiveChatProcesses().filter((p) => p.sessionId === sid && p.exitCode === null).at(-1) || null;
const ROWS = [];
const PROJ_DIR = join(HOME, '.claude', 'projects', '-tmp-r151f-xs');
mkdirSync(PROJ_DIR, { recursive: true });
const mk = (title) => {
  const sid = randomUUID();
  ROWS.push({ sessionId: sid, title, project: 'work', projectDir: WORK });
  writeFileSync(join(PROJ_DIR, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${sid.slice(0, 8)}-u`, sessionId: sid, message: { role: 'user', content: title } })}\n`);
  return sid;
};
const LIVE = { globalRead: true, keepAlive: true, promptSuggestions: false, genui: true };
const userTurn = (sid, mode, extra = {}) => api('POST', '/chat', { sessionId: sid, prompt: 'r151f 用户回合', cwd: WORK, model: 'r151f-model', permissionMode: mode, ...LIVE, ...extra });
const send = (sender, to, message) => xs.sendAiMessages({ sender, to, message }, ROWS);
const lastTo = async (sid) => (await store.listXsMessages()).filter((m) => m.from?.kind === 'session' && m.to.sessionId === sid).at(-1);

xs.installXsessionRuntime();
const S = mk('发送方 S');
const sBypass = { sessionId: S, runId: 'r-f-sender-bypass', turnEpoch: 0, guiMode: 'bypassPermissions' };

// 3a) 常驻空闲进程:usable 为 true
{
  const T = mk('目标 3a 常驻空闲');
  eq((await userTurn(T, 'default')).status, 200, '前置:3a 回合 200');
  const p = await waitFor(() => { const v = procOf(T); return v && v.idle ? v : null; }, '3a 进程转空闲');
  eq(p.usable, true, '3a 常驻空闲进程能接新回合(usable)');
}

// 3b) 只有一个输入已关、推迟退出的旧进程:它不跟随切档;跨会话判定不取它的旧档位,按最近一次切档判
{
  const T = mk('目标 3b 只剩在等退出的旧进程');
  const gate = deferred();
  ctl.onInputEnd = (record) => (record.options.resume === T || record.options.sessionId === T ? gate.p : null);
  try {
    eq((await userTurn(T, 'bypassPermissions', { keepAlive: false })).status, 200, '前置:3b「放任」回合 200(不保活:回合结束关输入)');
    await waitFor(async () => (await store.readXsProfiles()).sessions[T], '3b 的「放任」档案');
    const old = await waitFor(() => { const v = procOf(T); return v && v.usable === false ? v : null; }, '3b 旧进程输入已关、推迟退出');
    eq([old.exitCode, old.guiMode], [null, 'bypassPermissions'], '3b 前置:旧进程还活着、档位「放任」');
    await prefsMod.updatePrefs((p) => { p.xsInbound = { ...(p.xsInbound || {}), [T]: 'auto' }; });
    const sw = await api('POST', '/chat/permission-mode', { sessionId: T, mode: 'default' });
    eq([sw.status, sw.body?.attempted], [200, 0], `3b 没有可用进程:切档 200、attempted 0(${JSON.stringify(sw.body)})`);
    eq(procOf(T)?.guiMode, 'bypassPermissions', '3b 输入已关的旧进程不跟随切档(档位字段不动)');
    eq((await send(sBypass, [T], 'R151F-UNIT 只剩旧进程')).results.map((x) => x.delivery), ['card'], '3b「放任」发送方 → 卡片(目标按最近一次切档的「逐步确认」判,不取旧进程的「放任」)');
    eq((await lastTo(T))?.heldReason, 'class-mismatch', '3b 落 class-mismatch');
  } finally {
    ctl.onInputEnd = null;
    gate.open();
  }
  await waitFor(() => !procOf(T), '3b 旧进程退出', 10_000);
}

console.log('✓ check-r151f-xs-target-mode 全部通过');
process.exit(0);
