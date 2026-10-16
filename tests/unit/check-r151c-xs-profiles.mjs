#!/usr/bin/env node
// r151c 派工 2:发送档案、启用时刻、三个偏好键与删会话清理(方案 A5 / A6 / A12 / A13,§3 xsession-store / prefs)。
//   ① provider 指纹:加盐 HMAC、16 位十六进制、确定;每个参与字段(含凭据身份)一变即变;盐不合规抛错;档案的 replay 键
//      与 chat.js 的 TURN_PARAM_KEYS 相同。
//   ② 偏好读取:xsInbound / xsAutoPaused / xsEnabledAt 的非法值按接口 X.3.5 处理,读时不改写文件。
//   ③ 总开关关:起回合不写档案;删会话(没有收件箱、没有档案)不产生 xsession 目录下任何文件。
//   ④ PUT config 由关变开的同一次写入里记 xsEnabledAt;开着再开、关掉都不改它;应答仍是一期形状。
//   ⑤ 开着:每个回合记档案(两份:replay 请求原值、judge 档位 + 指纹 + 时刻),白名单形状、0600 / 0700、无凭据明文;
//      六种档位各发一次 judge.mode 与界面档位一致;内容没变不写盘;新会话首回合在回合结束时补记;切档同步两处档位、
//      没有档案不新建;重新打开开关后旧档案不算数、再开始一个回合即重记;写盘失败只记日志、回合照常。
//   ⑥ 删会话:清掉它的档案与接收设置(别的会话不动)。
// SDK 用 helpers/r151b-sdk-stub.mjs 替身;临时 HOME;端口 6900–6990(跳过 6710)。
// node tests/unit/check-r151c-xs-profiles.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151c-prof-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work');
const PROJECT = '-tmp-r151c-prof';
const PROJ_DIR = join(HOME, '.claude', 'projects', PROJECT);
for (const d of [join(HOME, '.claude', 'sessions'), PROJ_DIR, join(HOME, '.claude-gui'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
const XS_DIR = join(HOME, '.claude-gui', 'xsession');
const PROFILES = join(XS_DIR, 'profiles.json');
const PREFS = join(HOME, '.claude-gui', 'prefs.json');
const SETTINGS = join(HOME, '.claude', 'settings.json');
const ACCOUNT = join(HOME, '.claude.json');
const SECRET_TOKEN = 'sk-r151c-SECRET-token-0123456789abcdef';
const SECRET_HELPER = 'echo r151c-SECRET-helper';
const ACCOUNT_UUID = 'acc0acc0-r151c-SECRET-uuid';
const writeSettings = (env, extra = {}) => writeFileSync(SETTINGS, JSON.stringify({ env, ...extra }));
const writeAccount = (uuid) => writeFileSync(ACCOUNT, JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: uuid, emailAddress: 'x@example.invalid' } }));
writeSettings({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: SECRET_TOKEN, ANTHROPIC_MODEL: 'm-main' }, { apiKeyHelper: SECRET_HELPER });
writeAccount(ACCOUNT_UUID);

registerR151bSdkStub();
const { default: express } = await import('express');
const chat = await import('../../server/routes/chat.js');
const { default: xsRoutes } = await import('../../server/routes/xsession.js');
const { default: sessionRoutes } = await import('../../server/routes/sessions.js');
const xs = await import('../../server/services/xsession.js');
const store = await import('../../server/services/xsession-store.js');
const { readXsPrefsSync } = await import('../../server/routes/prefs.js');
const { providerFingerprint } = await import('../../server/services/xsession-policy.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 8000) {
  for (const t = Date.now(); Date.now() - t < ms;) { const v = await pred(); if (v) return v; await sleep(20); }
  throw new Error(`等不到:${what}`);
}
async function freePort() {
  for (let p = 6990; p >= 6900; p--) {
    if (p === 6710) continue;
    const ok = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (ok) return p;
  }
  throw new Error('6900-6990 没有空闲端口');
}
const app = express();
app.use(express.json());
app.use('/api', chat.default);
app.use('/api', xsRoutes);
app.use('/api', sessionRoutes);
const port = await freePort();
const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
const call = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const idleOf = (pid) => chat.getActiveChatProcesses().find((p) => p.pid === pid && p.idle);
const turn = async (body) => {
  const r = await call('POST', '/chat', { prompt: 'x', cwd: WORK, model: 'r151c-model', keepAlive: true, ...body });
  assert.equal(r.status, 200, `起回合:${JSON.stringify(r.body)}`);
  return waitFor(() => idleOf(r.body.pid), '回合收尾');
};
const readProfiles = () => (existsSync(PROFILES) ? JSON.parse(readFileSync(PROFILES, 'utf8')) : null);
const profileOf = (sid) => readProfiles()?.sessions?.[sid] || null;
const prefsFile = () => (existsSync(PREFS) ? JSON.parse(readFileSync(PREFS, 'utf8')) : {});
const uuid = (n) => `c3c3c3c3-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seedSession = (sid) => writeFileSync(join(PROJ_DIR, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${sid.slice(0, 8)}-u`, sessionId: sid, message: { role: 'user', content: '你好' } })}\n`);
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); origWarn(...a); };
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

try {
  // ── ① 指纹纯函数 ────────────────────────────────────────────────────────────────────
  const SALT = 'ab'.repeat(32);
  const BASE = { settingsEnv: { ANTHROPIC_BASE_URL: 'u', ANTHROPIC_MODEL: 'm', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h', ANTHROPIC_DEFAULT_SONNET_MODEL: 's', ANTHROPIC_DEFAULT_OPUS_MODEL: 'o', ANTHROPIC_DEFAULT_FABLE_MODEL: 'f', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }, apiKeyHelper: 'helper', accountId: 'acc', salt: SALT };
  const fp0 = providerFingerprint(BASE);
  ok(/^[0-9a-f]{16}$/.test(fp0), '16 位十六进制');
  eq(providerFingerprint(structuredClone(BASE)), fp0, '同内容同值');
  ok(providerFingerprint({ ...BASE, salt: 'cd'.repeat(32) }) !== fp0, '换盐即变');
  for (const k of Object.keys(BASE.settingsEnv)) ok(providerFingerprint({ ...BASE, settingsEnv: { ...BASE.settingsEnv, [k]: 'changed' } }) !== fp0, `${k} 变 → 指纹变`);
  ok(providerFingerprint({ ...BASE, apiKeyHelper: 'other' }) !== fp0, 'apiKeyHelper 变 → 指纹变');
  ok(providerFingerprint({ ...BASE, accountId: 'other' }) !== fp0, '账号 uuid 变 → 指纹变');
  eq(providerFingerprint({ ...BASE, settingsEnv: { ...BASE.settingsEnv, OTHER_KEY: 'x' } }), fp0, '别的 env 键不参与');
  eq(providerFingerprint({ salt: SALT }), providerFingerprint({ salt: SALT, settingsEnv: { ANTHROPIC_MODEL: 3 }, apiKeyHelper: null, accountId: undefined }), '缺的、不是字符串的按空串');
  for (const bad of [undefined, '', 'zz'.repeat(32), 'ab'.repeat(31)]) assert.throws(() => providerFingerprint({ ...BASE, salt: bad }), TypeError), checks++;
  eq([...store.XS_PROFILE_REPLAY_KEYS], chat.TURN_PARAM_KEYS.filter((k) => k !== 'appendSystemPrompt'), '档案 replay 键 = chat.js 回合参数键去掉 appendSystemPrompt(审计 F1)');

  // ── ② 偏好读取 ──────────────────────────────────────────────────────────────────────
  const A = uuid(1); const B = uuid(2); const C = uuid(3);
  const badPrefs = JSON.stringify({ xsEnabled: 'true', xsAutoPaused: 'yes', xsEnabledAt: 'not a date', xsInbound: { [A]: 'auto', 'bad id': 'auto', [B]: 'card', [C]: true } });
  writeFileSync(PREFS, badPrefs);
  eq(readXsPrefsSync(), { enabled: false, enabledAt: null, inbound: { [A]: 'auto' }, autoPaused: false }, '非法值按默认、只留合法条目');
  eq(readFileSync(PREFS, 'utf8'), badPrefs, '读时不改写文件');
  for (const v of [[], 'x', 1, null]) { writeFileSync(PREFS, JSON.stringify({ xsInbound: v })); eq(readXsPrefsSync().inbound, {}, `xsInbound=${JSON.stringify(v)} → {}`); }
  writeFileSync(PREFS, JSON.stringify({ xsEnabled: true, xsAutoPaused: true, xsEnabledAt: '2026-10-15T00:00:00.000Z' }));
  eq(readXsPrefsSync(), { enabled: true, enabledAt: '2026-10-15T00:00:00.000Z', inbound: {}, autoPaused: true }, '合法值原样');
  writeFileSync(PREFS, '{broken'); eq(readXsPrefsSync(), { enabled: false, enabledAt: null, inbound: {}, autoPaused: false }, '损坏按默认');
  writeFileSync(PREFS, '{}');

  // ── ③ 总开关关 ──────────────────────────────────────────────────────────────────────
  xs.installXsessionRuntime();
  const D0 = uuid(10); seedSession(D0);
  eq((await call('DELETE', `/sessions/${D0}?projectHash=${PROJECT}`)).status, 200, '关着时删会话');
  ok(!existsSync(XS_DIR), '没有收件箱与档案时删会话不产生 xsession 目录');
  await turn({ sessionId: A, permissionMode: 'default' });
  await sleep(200);
  ok(!existsSync(PROFILES), '总开关关:起回合不写档案');

  // ── ④ 启用时刻 ──────────────────────────────────────────────────────────────────────
  let t0 = Date.now();
  let r = await call('PUT', '/xsession/config', { enabled: true });
  eq(r, { status: 200, body: { ok: true, enabled: true, autoPaused: false } }, '应答形状(派工 3 起多 autoPaused)');
  const at1 = prefsFile().xsEnabledAt;
  ok(typeof at1 === 'string' && Date.parse(at1) >= t0 - 5 && Date.parse(at1) <= Date.now() + 5, '由关变开记下启用时刻');
  await sleep(5);
  await call('PUT', '/xsession/config', { enabled: true });
  eq(prefsFile().xsEnabledAt, at1, '开着再开不改启用时刻');

  // ── ⑤ 档案 ─────────────────────────────────────────────────────────────────────────
  const FULL = { cwd: WORK, model: 'r151c-full', effort: 'high', addDirs: [TMP], permissionMode: 'acceptEdits', globalRead: false, appendSystemPrompt: '附加说明', promptSuggestions: false, keepAlive: true, maxBudgetUsd: 3, genui: false };
  await turn({ ...FULL, sessionId: A, prompt: 'full', agent: 'x-agent' });
  const pA = await waitFor(() => profileOf(A), 'A 的档案');
  const file = readProfiles();
  eq(Object.keys(file).sort(), ['salt', 'sessions'], '文件顶层只有 salt 与 sessions');
  ok(/^[0-9a-f]{64}$/.test(file.salt), '盐是 32 字节十六进制');
  eq(Object.keys(pA).sort(), ['judge', 'replay'], '每条两份');
  const { appendSystemPrompt: _append, ...FULL_REPLAY } = FULL;
  eq(pA.replay, FULL_REPLAY, 'replay = 请求原值(model 为解析值;appendSystemPrompt 不记)');
  eq(Object.keys(pA.judge).sort(), ['mode', 'providerFp', 'recordedAt'], 'judge 三个键');
  eq(pA.judge.mode, 'acceptEdits', 'judge.mode = 界面档位');
  eq(pA.judge.providerFp, xs.currentProviderFp(file.salt), 'judge.providerFp = 当前配置的指纹');
  ok(xs.profileIsCurrent(pA, readXsPrefsSync().enabledAt), '启用之后记的 → 算数');
  eq([statSync(PROFILES).mode & 0o777, statSync(XS_DIR).mode & 0o777], [0o600, 0o700], '文件 0600、目录 0700');
  const text = readFileSync(PROFILES, 'utf8');
  for (const secret of [SECRET_TOKEN, SECRET_HELPER, ACCOUNT_UUID]) ok(!text.includes(secret), '档案里没有凭据 / 账号明文');
  ok(!text.includes(_append) && !text.includes('appendSystemPrompt'), '档案里没有附加系统提示(键与原文都没有)');
  // 指纹随配置变
  const fpA = pA.judge.providerFp;
  writeSettings({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: `${SECRET_TOKEN}-2`, ANTHROPIC_MODEL: 'm-main' }, { apiKeyHelper: SECRET_HELPER });
  ok(xs.currentProviderFp(file.salt) !== fpA, '换 token → 指纹不同');
  writeSettings({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: SECRET_TOKEN, ANTHROPIC_MODEL: 'm-main' }, { apiKeyHelper: SECRET_HELPER });
  eq(xs.currentProviderFp(file.salt), fpA, '换回 → 相同');
  // ~/.claude.json 有最短间隔缓存:换号后间隔内仍用上次的读数,过了间隔才看到新账号
  const pastInterval = () => sleep(xs.XS_CLAUDE_JSON_MIN_MS + 150);
  writeAccount('acc1acc1-other');
  eq(xs.currentProviderFp(file.salt), fpA, `换登录账号后 ${xs.XS_CLAUDE_JSON_MIN_MS} 毫秒内仍用上次的读数(最短间隔缓存)`);
  await pastInterval();
  ok(xs.currentProviderFp(file.salt) !== fpA, '过了最短间隔:换登录账号 → 指纹不同');
  writeAccount(ACCOUNT_UUID); await pastInterval(); eq(xs.currentProviderFp(file.salt), fpA, '账号换回 → 相同');
  // 六种档位
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
    const p = await turn({ sessionId: B, permissionMode: mode, prompt: `m-${mode}` });
    const prof = await waitFor(() => (profileOf(B)?.judge.mode === mode ? profileOf(B) : null), `${mode} 记进档案`);
    eq([prof.judge.mode, prof.replay.permissionMode, p.guiMode], [mode, mode, mode], `${mode}:judge.mode 与界面档位一致`);
  }
  // 内容没变不写盘
  const before = { text: readFileSync(PROFILES, 'utf8'), mtime: statSync(PROFILES).mtimeMs };
  await turn({ sessionId: B, permissionMode: 'bypassPermissions', prompt: 'same again' });
  await sleep(300);
  eq({ text: readFileSync(PROFILES, 'utf8'), mtime: statSync(PROFILES).mtimeMs }, before, '内容没变不写盘');
  // 新会话首回合:回合结束时补记
  const pNew = await turn({ permissionMode: 'plan', prompt: 'brand new' });
  ok(pNew.sessionId, '新会话拿到 id');
  const profNew = await waitFor(() => profileOf(pNew.sessionId), '新会话首回合补记');
  eq(profNew.judge.mode, 'plan', '补记的档位');
  // 切档同步
  const recA = profileOf(A).judge.recordedAt;
  eq((await call('POST', '/chat/permission-mode', { sessionId: A, mode: 'plan' })).status, 200, '切档 200');
  const pA2 = await waitFor(() => (profileOf(A)?.judge.mode === 'plan' ? profileOf(A) : null), '切档同步进档案');
  eq([pA2.replay.permissionMode, pA2.judge.mode, pA2.judge.recordedAt], ['plan', 'plan', recA], '两处档位同步、记录时刻不变');
  const GHOST = uuid(99);
  await call('POST', '/chat/permission-mode', { sessionId: GHOST, mode: 'plan' });
  await sleep(150);
  eq(profileOf(GHOST), null, '没有档案的会话切档不新建');
  // 重新打开开关:旧档案不算数,再开始一个回合即重记
  await call('PUT', '/xsession/config', { enabled: false });
  eq(prefsFile().xsEnabledAt, at1, '关掉不改启用时刻');
  await sleep(5);
  await call('PUT', '/xsession/config', { enabled: true });
  const at2 = readXsPrefsSync().enabledAt;
  ok(Date.parse(at2) > Date.parse(at1), '再次由关变开 → 新的启用时刻');
  ok(!xs.profileIsCurrent(profileOf(A), at2) && !xs.profileIsCurrent(profileOf(B), at2), '之前记的档案不再算数');
  ok(!xs.profileIsCurrent(profileOf(A), null), '启用时刻为 null → 一律不认');
  await turn({ sessionId: B, permissionMode: 'bypassPermissions', prompt: 'same content again' });
  await waitFor(() => xs.profileIsCurrent(profileOf(B), at2), 'B 内容没变也重记');
  ok(!xs.profileIsCurrent(profileOf(A), at2), 'A 没开始回合 → 仍不算数');
  // 写盘失败:只记日志,回合照常
  const w0 = warns.length;
  const snapshotB = readFileSync(PROFILES, 'utf8');
  chmodSync(XS_DIR, 0o500);
  try {
    await turn({ sessionId: B, permissionMode: 'default', prompt: 'write fails' });
    await waitFor(() => warns.slice(w0).some((w) => w.includes('发送档案未能落盘')), '写失败记日志');
  } finally { chmodSync(XS_DIR, 0o700); }
  eq(readFileSync(PROFILES, 'utf8'), snapshotB, '写失败时档案不变');
  ok(warns.slice(w0).every((w) => !w.includes(SECRET_TOKEN) && !w.includes(ACCOUNT_UUID)), '日志里没有凭据');
  // 总开关关:回合与切档都不动档案
  await call('PUT', '/xsession/config', { enabled: false });
  const offText = readFileSync(PROFILES, 'utf8');
  await turn({ sessionId: B, permissionMode: 'acceptEdits', prompt: 'off turn' });
  await call('POST', '/chat/permission-mode', { sessionId: B, mode: 'dontAsk' });
  await sleep(300);
  eq(readFileSync(PROFILES, 'utf8'), offText, '关着:回合与切档都不写档案');

  // ── ⑥ 删会话清档案与接收设置 ────────────────────────────────────────────────────────────
  const p = prefsFile(); p.xsInbound = { [A]: 'auto', [B]: 'auto' }; writeFileSync(PREFS, JSON.stringify(p));
  seedSession(A);
  eq((await call('DELETE', `/sessions/${A}?projectHash=${PROJECT}`)).status, 200, '删会话 A');
  await waitFor(() => !profileOf(A), 'A 的档案清掉');
  ok(Boolean(profileOf(B)), '别的会话的档案不动');
  eq(prefsFile().xsInbound, { [B]: 'auto' }, 'A 的接收设置清掉、B 的不动');
  ok(!readFileSync(PROFILES, 'utf8').includes(A), '档案文件里不再有 A');
  console.log(`PASS check-r151c-xs-profiles(${checks} 项)`);
} finally {
  console.warn = origWarn;
  try { chmodSync(XS_DIR, 0o700); } catch { /* 可能不存在 */ }
  try { await chat.closeAllPersistentProcesses(); } catch { /* 收尾 */ }
  server.close();
  rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}
