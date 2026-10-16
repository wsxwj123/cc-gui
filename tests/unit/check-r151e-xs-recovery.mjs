#!/usr/bin/env node
// r151e 偏好文件读失败加固:跨会话部分(任务文件修法 ①③⑤④)。
//   ① 启动时偏好文件在、却读不出:按"开着"挂上全部跨会话钩子(读不出期间的切档照样记、新起的进程带跨会话工具);
//      切档钩子在读不出时把新档位写进该会话已有的档案(只改两处档位,不改记录时刻,不新建档案);
//      恢复可读后由恢复定时器按实际总开关挂或撤(撤走 syncXsRuntimeHooks(false) 的现有路径)。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身;临时 HOME;端口 6880–6929。
// node tests/unit/check-r151e-xs-recovery.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151e-recovery-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
const XS_DIR = join(HOME, '.claude-gui', 'xsession');
for (const d of [join(HOME, '.claude', 'sessions'), join(XS_DIR, 'bodies'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
const PREFS = join(HOME, '.claude-gui', 'prefs.json');
const ENABLED_AT = new Date(Date.now() - 86_400_000).toISOString();
writeFileSync(PREFS, JSON.stringify({ xsEnabled: true, xsEnabledAt: ENABLED_AT }));

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
const { XS_TOOLS_SERVER } = await import('../../server/services/xsession-tools.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 10_000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = await pred(); if (v) return v; await sleep(25); }
  throw new Error(`等不到:${what}`);
}
async function freePort() {
  for (let p = 6929; p >= 6880; p--) {
    const free = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('6880-6929 没有空闲端口');
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
const PROJ_DIR = join(HOME, '.claude', 'projects', '-tmp-r151e-recovery');
mkdirSync(PROJ_DIR, { recursive: true });
const TITLES = new Map();
const mk = (title) => {
  const sid = randomUUID();
  TITLES.set(sid, title);
  writeFileSync(join(PROJ_DIR, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${sid.slice(0, 8)}-u`, sessionId: sid, message: { role: 'user', content: title } })}\n`);
  return sid;
};
const LIVE = { globalRead: true, keepAlive: true, promptSuggestions: false, genui: true };
async function userTurn(sid, mode, extra = {}) {
  const r = await api('POST', '/chat', { sessionId: sid, prompt: 'r151e 用户回合', cwd: WORK, model: 'r151e-model', permissionMode: mode, ...LIVE, ...extra });
  eq(r.status, 200, `前置:${TITLES.get(sid)} 的回合 200(${JSON.stringify(r.body).slice(0, 160)})`);
  return r.body.pid;
}
const offTurn = async (sid, mode, extra = {}) => { // 不保活的用户回合:跑完进程退出;返回这次冷启的 SDK 记录
  const n = calls.length;
  await userTurn(sid, mode, { keepAlive: false, ...extra });
  await waitFor(() => !slotOf(sid), `${TITLES.get(sid)} 的进程退出`, 20_000);
  return calls.slice(n).find((c) => c.options.resume === sid || c.options.sessionId === sid) || calls.at(-1);
};
const profileOf = async (sid) => (await store.readXsProfiles()).sessions[sid] ?? null;
const withXsTools = (rec) => !!rec?.options?.mcpServers?.[XS_TOOLS_SERVER];
const setPrefs = (obj) => writeFileSync(PREFS, JSON.stringify(obj));
const prefsJson = () => { try { return JSON.parse(readFileSync(PREFS, 'utf8')); } catch { return null; } };

try {
  xs.installXsessionRuntime();
  await store.loadXsInbox();

  // ── ① 启动时偏好文件读不出 ──
  const T1 = mk('目标 T1 读不出期间切档');
  const U1 = mk('会话 U1 没有档案');
  await offTurn(T1, 'bypassPermissions');
  const before1 = await waitFor(() => profileOf(T1), 'T1 的档案');
  eq(before1.judge.mode, 'bypassPermissions', '前置:T1 有「放任」档案');
  chmodSync(PREFS, 0o000);
  try {
    xs.installXsessionRuntime(); // 模拟重启:启动这一刻偏好文件读不出
    eq((await api('POST', '/chat/permission-mode', { sessionId: T1, mode: 'default' })).status, 200, '读不出期间把 T1 切到「逐步确认」→ 200(没有进程)');
    const after1 = await waitFor(async () => { const p = await profileOf(T1); return p && p.judge.mode === 'default' ? p : null; }, '读不出期间的切档写进 T1 的档案', 5_000);
    eq([after1.replay.permissionMode, after1.judge.recordedAt], ['default', before1.judge.recordedAt], '两处档位都是新档位,记录时刻不变');
    eq(after1.replay.model, before1.replay.model, '其余重放参数不变');
    eq((await api('POST', '/chat/permission-mode', { sessionId: U1, mode: 'plan' })).status, 200, '读不出期间切没有档案的 U1 → 200');
    await sleep(200);
    eq(await profileOf(U1), null, '没有档案的会话不新建档案');
    const V1 = mk('会话 V1 读不出期间新起');
    ok(withXsTools(await offTurn(V1, 'default')), '读不出期间新起的进程带跨会话工具(钩子按开着挂)');
  } finally { chmodSync(PREFS, 0o644); }
  const V2 = mk('会话 V2 恢复后');
  ok(withXsTools(await offTurn(V2, 'default')), '恢复可读、总开关开着:钩子照旧挂着');
  // 总开关实际关着:读不出时先按开着挂,恢复可读后恢复定时器撤掉
  setPrefs({ ...prefsJson(), xsEnabled: false });
  chmodSync(PREFS, 0o000);
  try {
    xs.installXsessionRuntime();
    ok(withXsTools(await offTurn(mk('会话 V3 关着、读不出'), 'default')), '总开关实际关着、启动时读不出:先按开着挂');
  } finally { chmodSync(PREFS, 0o644); }
  const V4 = mk('会话 V4 关着、恢复后');
  await waitFor(async () => {
    if (!withXsTools(await offTurn(V4, 'default'))) return true;
    await sleep(500);
    return false;
  }, '恢复可读后按实际总开关(关)撤掉钩子', 25_000);
  setPrefs({ ...prefsJson(), xsEnabled: true });
  xs.installXsessionRuntime();
  ok(withXsTools(await offTurn(mk('会话 V5 重新打开'), 'default')), '前置:偏好可读、总开关开 → 钩子挂上');

  console.log(`PASS check-r151e-xs-recovery(${checks} 项)`);
} finally {
  ctl.onInputEnd = null; ctl.setModel = null; ctl.setPermissionMode = null;
  await chat.closeAllPersistentProcesses?.();
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
