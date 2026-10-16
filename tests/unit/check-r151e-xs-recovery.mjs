#!/usr/bin/env node
// r151e 偏好文件读失败加固:跨会话部分(任务文件修法 ①③⑤④)。
//   ① 启动时偏好文件在、却读不出:按"开着"挂上全部跨会话钩子(读不出期间的切档照样记、新起的进程带跨会话工具);
//      切档钩子在读不出时把新档位写进该会话已有的档案(只改两处档位,不改记录时刻,不新建档案),写失败标记也照打(主会话裁定 B);
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
  // 裁定 B:读不出时切档,档案照写、写失败标记也照打 —— 恢复可读后 T1 按没有档案判;标记由恢复定时器补存进偏好文件(重启后同样按没有档案判)
  ok(!xs.profileCountsFor(T1, await profileOf(T1), ENABLED_AT), '读不出期间切过档的 T1:恢复可读后按没有档案判(写失败标记照打)');
  await waitFor(() => (prefsJson()?.xsProfileWriteFailed ?? []).includes(T1.toLowerCase()), 'T1 的写失败标记由恢复定时器补存进偏好文件', 25_000);
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

  // ── ③ 名单落盘失败:偏好文件恢复后恢复定时器自己补存(不靠下一次有会话被标记);日志只在首次失败与恢复时各记一行 ──
  const failedIdsOnDisk = () => prefsJson()?.xsProfileWriteFailed ?? [];
  const FAIL_LINE = '档案写失败标记未能写进偏好文件';
  const RECOVERED_LINE = '偏好文件已恢复可读';
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); origWarn(...a); };
  const countWarns = (s) => warns.filter((w) => w.includes(s)).length;
  try {
    const T3 = mk('目标 T3 名单落盘失败');
    await offTurn(T3, 'bypassPermissions');
    await waitFor(() => profileOf(T3), 'T3 的档案');
    warns.length = 0;
    chmodSync(PREFS, 0o000);
    try {
      await offTurn(T3, 'bypassPermissions', { model: 'r151e-model-t3' }); // 偏好文件读不出:按没有档案判,标记落不了盘
      await sleep(3_500); // 这期间恢复定时器重读过两次(1 秒、再 2 秒),都读不出
    } finally { chmodSync(PREFS, 0o644); }
    ok(!failedIdsOnDisk().includes(T3.toLowerCase()), '前置:读不出期间标记没落盘');
    eq(countWarns(FAIL_LINE), 1, '首次失败记一行');
    await waitFor(() => failedIdsOnDisk().includes(T3.toLowerCase()), '偏好文件恢复后不做任何操作,标记被补存进偏好文件', 25_000);
    await sleep(300);
    eq([countWarns(FAIL_LINE), countWarns(RECOVERED_LINE)], [1, 1], '重试期间不再记日志;恢复时记一行');

    // 偏好文件内容坏了:后台补存一直抛 PREFS_UNREADABLE,不重建、不动文件,按最长间隔安静地重试;内容恢复后补存
    const T3b = mk('目标 T3b 偏好内容坏了');
    await offTurn(T3b, 'bypassPermissions');
    await waitFor(() => profileOf(T3b), 'T3b 的档案');
    const good = readFileSync(PREFS, 'utf8');
    warns.length = 0;
    writeFileSync(PREFS, '{broken');
    try {
      await offTurn(T3b, 'bypassPermissions', { model: 'r151e-model-t3b' });
      await sleep(2_500);
      eq(readFileSync(PREFS, 'utf8'), '{broken', '内容坏了:后台补存不重建、不覆盖偏好文件');
      ok(countWarns(FAIL_LINE) <= 1, '内容坏了:重试不刷日志');
    } finally { writeFileSync(PREFS, good); }
    await waitFor(() => failedIdsOnDisk().includes(T3b.toLowerCase()), '内容恢复后补存进偏好文件', 25_000);
    ok(failedIdsOnDisk().includes(T3.toLowerCase()), '补存时盘上原有的标记还在');
  } finally { console.warn = origWarn; }

  // ── 主会话裁定:切档接口等新档位写进发送档案再回 200,最多等 MODE_CHANGE_PERSIST_WAIT_MS(回 200 后立即重启时盘上不再是旧档位)──
  const PROFILES = join(XS_DIR, 'profiles.json');
  const diskModeOf = (sid) => { try { return JSON.parse(readFileSync(PROFILES, 'utf8')).sessions?.[sid]?.judge?.mode ?? null; } catch { return null; } };
  const holdStore = async () => { // 占住存储队列(档案与收件箱共用):切档的档案写入排在它后面
    let open = null;
    const held = store.mutateXsProfiles(() => new Promise((r) => { open = r; }));
    await waitFor(() => open, '占住存储队列');
    return async () => { open(); await held; };
  };
  const T2 = mk('目标 T2 切档等落盘');
  await offTurn(T2, 'bypassPermissions');
  await waitFor(() => profileOf(T2), 'T2 的档案');
  let release = await holdStore();
  let modeAtAnswer = null;
  const pA = api('POST', '/chat/permission-mode', { sessionId: T2, mode: 'default' }).then((r) => { modeAtAnswer = diskModeOf(T2); return r; });
  await sleep(600);
  eq(modeAtAnswer, null, '档案还没写盘:切档接口先不回应答');
  await release();
  eq((await pA).status, 200, '档案写盘后回 200');
  eq(modeAtAnswer, 'default', '回 200 的那一刻盘上档案已是新档位');
  release = await holdStore();
  const t2 = Date.now();
  const rSlow = await api('POST', '/chat/permission-mode', { sessionId: T2, mode: 'acceptEdits' });
  const waited = Date.now() - t2;
  eq(rSlow.status, 200, '档案迟迟写不进:照常回 200');
  ok(waited >= chat.MODE_CHANGE_PERSIST_WAIT_MS - 100 && waited < chat.MODE_CHANGE_PERSIST_WAIT_MS + 1_500, `最多等 ${chat.MODE_CHANGE_PERSIST_WAIT_MS}ms(实际 ${waited}ms)`);
  eq(diskModeOf(T2), 'default', '前置:超时回 200 时档案还没写');
  await release();
  await waitFor(() => diskModeOf(T2) === 'acceptEdits', '超时之后写入在后台继续完成', 5_000);
  const tNoProc = Date.now();
  eq((await api('POST', '/chat/permission-mode', { sessionId: randomUUID(), mode: 'plan' })).status, 200, '没有档案的会话切档照常 200');
  ok(Date.now() - tNoProc < 1_000, '没有要写的档案:不多等');

  // ── ⑤ 名单读到之前本进程清掉的标记:读到名单的那一刻补落盘,把它从盘上的名单里删掉(否则重启后又按没有档案判)──
  // 清标记用 forgetXsSession(同步清):读到名单之前清掉、再读到名单,两步之间不让出事件循环,不依赖恢复定时器的时机。
  const onDiskFailed = () => prefsJson()?.xsProfileWriteFailed ?? [];
  const T5 = mk('目标 T5 判定时读到名单');
  const T5b = mk('目标 T5b 恢复定时器读到名单');
  setPrefs({ ...prefsJson(), xsProfileWriteFailed: [...onDiskFailed(), T5.toLowerCase(), T5b.toLowerCase()] }); // 上一个进程留在盘上的标记
  const before5 = onDiskFailed();
  chmodSync(PREFS, 0o000);
  try { xs.installXsessionRuntime(); } finally { chmodSync(PREFS, 0o644); } // 模拟重启:启动这一刻偏好文件读不出,随后恢复
  const forgot5 = xs.forgetXsSession(T5); // 名单读到之前清掉 T5
  ok(!xs.profileCountsFor(T5, null, ENABLED_AT), '判定时读到名单');
  await forgot5;
  await waitFor(() => !onDiskFailed().includes(T5.toLowerCase()), '5a:读到名单的那一刻补落盘,T5 从盘上的名单里删掉', 5_000);
  eq([...onDiskFailed()].sort(), before5.filter((k) => k !== T5.toLowerCase()).sort(), '5a:盘上其它标记都还在(先后按本进程标记的排后,不比顺序)');
  setPrefs({ ...prefsJson(), xsProfileWriteFailed: [...onDiskFailed().filter((k) => k !== T5b.toLowerCase()), T5b.toLowerCase()] });
  const before5b = onDiskFailed();
  ok(before5b.length >= 2, '5b 前置:盘上除 T5b 外还有别的标记');
  chmodSync(PREFS, 0o000);
  try { xs.installXsessionRuntime(); } finally { chmodSync(PREFS, 0o644); }
  await xs.forgetXsSession(T5b); // 读到名单之前清掉 T5b,之后不做任何判定,只等恢复定时器读到名单
  ok(onDiskFailed().includes(T5b.toLowerCase()), '5b 前置:清掉时盘上还有 T5b');
  await waitFor(() => !onDiskFailed().includes(T5b.toLowerCase()), '5b:恢复定时器读到名单后补落盘,T5b 从盘上的名单里删掉', 10_000);
  eq([...onDiskFailed()].sort(), before5b.filter((k) => k !== T5b.toLowerCase()).sort(), '5b:盘上其它标记都还在');

  console.log(`PASS check-r151e-xs-recovery(${checks} 项)`);
} finally {
  ctl.onInputEnd = null; ctl.setModel = null; ctl.setPermissionMode = null;
  await chat.closeAllPersistentProcesses?.();
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
