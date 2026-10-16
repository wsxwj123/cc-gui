#!/usr/bin/env node
// r151c 安全审计之后的修正(接口"审计之后的补充约定";用户裁定"照 CLI 原生:用此刻的设置")。
//   ① 审计 F1:回合专属的附加系统提示(appendSystemPrompt,重跑工具 / 风险续跑才带)不进发送档案、自动处理不带;
//      旧档案里有这个键时读到即忽略;为带着它的那一回合起的进程不复用。
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

  console.log(`PASS check-r151c-xs-audit(${checks} 项)`);
} finally {
  await chat.closeAllPersistentProcesses?.();
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(0);
