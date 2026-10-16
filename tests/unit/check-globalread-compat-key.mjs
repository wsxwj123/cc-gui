#!/usr/bin/env node
// globalread-compat-key 验收:请求不带 globalRead / 带 null 一律按"关"处理(复用键与冷启目录都按关算)。
// 唯一依据:.devflow/globalread-compat-key-接口.md 的行为清单 K1、K2、C1、C2、C3,每条一个独立检查块,
// 单块失败不中断后续;全部跑完按有无失败设置退出码(有失败 = 1)。
// 只走对外入口:公开函数 chatCompatKey、挂在 /api 下的 chat 路由(POST /api/chat);SDK 用 r151b 替身,
// 不起任何 claude 进程;"是否新起进程"用替身记录数 globalThis.__r151bSdkCalls 的增量判断。
// 运行:node tests/unit/check-globalread-compat-key.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, parse, delimiter } from 'node:path';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

// HOME / USERPROFILE 必须在 import chat.js 之前指到临时目录(chatCompatKey 会读 HOME 下配置文件的 mtime)。
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-globalread-compat-')));
const HOME = join(TMP, 'home');
const BIN = join(TMP, 'bin');
const WORK = join(TMP, 'work');
for (const d of [join(HOME, '.claude', 'sessions'), join(HOME, '.claude-gui'), BIN, WORK]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = [BIN, '/usr/bin', '/bin'].join(delimiter);

registerR151bSdkStub();
const calls = (globalThis.__r151bSdkCalls ||= []);
const { default: express } = await import('express');
const chat = await import('../../server/routes/chat.js');
const { chatCompatKey, getActiveChatProcesses, closeAllPersistentProcesses } = chat;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// posix 的"整盘"是 "/";win32 是 HOME 所在盘根。
const DISK_ROOT = process.platform === 'win32' ? parse(HOME).root : '/';

// 端口只在 6700–6999 里挑,跳过 6710(6677、6689、8000、8798、8799 都不在这个区间内)。
async function freePort() {
  for (let p = 6899; p >= 6700; p--) {
    if (p === 6710) continue;
    const ok = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (ok) return p;
  }
  throw new Error('6700-6899 没有空闲端口');
}

const app = express();
app.use(express.json());
app.use('/api', chat.default);
const port = await freePort();
const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
const postChat = async (body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, body: await r.json() };
};
/** 等进程槽 pid 转入空闲(回合结束后常驻),返回该槽(含 sessionId)。 */
async function waitIdle(pid) {
  for (let i = 0; i < 200; i++) {
    const p = getActiveChatProcesses().find((x) => x.pid === pid);
    if (p && p.idle) return p;
    await sleep(25);
  }
  throw new Error(`进程槽 ${pid} 没有转入空闲`);
}
/** 关掉全部常驻进程并等它们收尾(下一条同会话请求才会冷启而不是复用)。 */
async function closeAllAndWait() {
  closeAllPersistentProcesses();
  for (let i = 0; i < 200; i++) {
    if (getActiveChatProcesses().every((x) => x.exitCode !== null)) return;
    await sleep(25);
  }
  throw new Error('常驻进程没有收尾');
}

// ---- 检查块骨架:每块单独 try/catch,通过打印 PASS <编号>,失败打印 FAIL <编号>: <断言信息>,不中断后续 ----
const failures = [];
async function check(id, fn) {
  try { await fn(); console.log(`PASS ${id}`); }
  catch (e) { failures.push(id); console.log(`FAIL ${id}: ${e && e.message ? e.message : String(e)}`); }
}
/** C 组每条之间调用:关掉全部常驻进程并等收尾,保证下一条从冷启开始;关不掉也算失败。 */
async function settle(tag) {
  try { await closeAllAndWait(); }
  catch (e) { failures.push(tag); console.log(`FAIL ${tag}: 收尾失败 ${e.message}`); }
}

// ---- 复用键:每组比较除 globalRead 外其余字段完全相同(包括 dirs) ----
const KEY_BASE = {
  workingDir: WORK, effort: 'high', appendSystemPrompt: '', promptSuggestions: false,
  dirs: [WORK], maxBudgetUsd: null, acw: null, genui: false, ams: null,
};
const keyWith = (gr) => chatCompatKey(gr === undefined ? { ...KEY_BASE } : { ...KEY_BASE, globalRead: gr });

// K1:globalRead: true 与 不带 / null / false 三者分别比较 → 返回值都不同
await check('K1', () => {
  const kTrue = keyWith(true);
  assert.equal(typeof kTrue, 'string', 'chatCompatKey 返回字符串');
  assert.notEqual(kTrue, keyWith(undefined), 'globalRead: true 与不带 globalRead 的复用键必须不同');
  assert.notEqual(kTrue, keyWith(null), 'globalRead: true 与 globalRead: null 的复用键必须不同');
  assert.notEqual(kTrue, keyWith(false), 'globalRead: true 与 globalRead: false 的复用键必须不同');
});

// K2:不带 / null / false 三者两两比较 → 返回值都相同
await check('K2', () => {
  const kOmit = keyWith(undefined);
  const kNull = keyWith(null);
  const kFalse = keyWith(false);
  assert.equal(typeof kOmit, 'string', 'chatCompatKey 返回字符串');
  assert.equal(kOmit, kFalse, '不带 globalRead 与 globalRead: false 的复用键必须相同');
  assert.equal(kNull, kFalse, 'globalRead: null 与 globalRead: false 的复用键必须相同');
  assert.equal(kOmit, kNull, '不带 globalRead 与 globalRead: null 的复用键必须相同');
});

// ---- POST /api/chat:同一会话先发首条,等进程转空闲,再带同一 sessionId 发第二条;两条除 globalRead 外参数相同 ----
// promptSuggestions: false 关掉服务端默认开启的"输入预测":不关时每个回合结束后要多等约 4 秒才转空闲,逼近 waitIdle 的 5 秒上限,慢机器上会误报"没有转入空闲";两条消息共用本常量,除 globalRead 外参数仍相同。
const BODY = { prompt: 'globalread-compat-key 首条', cwd: WORK, keepAlive: true, promptSuggestions: false };
/** 发一对消息;firstExtra / secondExtra 只放 globalRead(空对象 = 不带)。返回第二条应答、第二条新起的进程数、最新进程记录。 */
async function sendPair(firstExtra, secondExtra) {
  const before = calls.length;
  const r1 = await postChat({ ...BODY, ...firstExtra });
  assert.equal(r1.status, 200, `首条应答状态码应为 200:${JSON.stringify(r1.body)}`);
  assert.equal(r1.body.ok, true, `首条应答 ok 应为 true:${JSON.stringify(r1.body)}`);
  assert.equal(calls.length, before + 1, '首条冷启应新起恰好一个进程');
  const live = await waitIdle(r1.body.pid);
  assert.ok(live.sessionId, '首条进程转空闲后应有会话 id');
  const mid = calls.length;
  const r2 = await postChat({ ...BODY, prompt: 'globalread-compat-key 第二条', sessionId: live.sessionId, ...secondExtra });
  assert.equal(r2.status, 200, `第二条应答状态码应为 200:${JSON.stringify(r2.body)}`);
  assert.equal(r2.body.ok, true, `第二条应答 ok 应为 true:${JSON.stringify(r2.body)}`);
  await waitIdle(r2.body.pid);
  return { r2, newProcs: calls.length - mid, newest: calls[calls.length - 1] };
}
/** 进程被放开的读取目录(替身记录的 options.additionalDirectories),规范化后比较。 */
const readDirsOf = (record) => (record?.options?.additionalDirectories || []).map((d) => resolve(d));

// C1:首条 globalRead: false、第二条不带 → 第二条 reused: true 且没有新起进程;反过来(首条不带、第二条 false)同样复用
await check('C1', async () => {
  const a = await sendPair({ globalRead: false }, {});
  assert.equal(a.r2.body.reused, true, `首条 false、第二条不带:第二条应复用常驻进程,应答 ${JSON.stringify(a.r2.body)}`);
  assert.equal(a.newProcs, 0, '首条 false、第二条不带:第二条不得新起进程');
  await closeAllAndWait();
  const b = await sendPair({}, { globalRead: false });
  assert.equal(b.r2.body.reused, true, `首条不带、第二条 false:第二条应复用常驻进程,应答 ${JSON.stringify(b.r2.body)}`);
  assert.equal(b.newProcs, 0, '首条不带、第二条 false:第二条不得新起进程');
});
await settle('C1-收尾');

// C2:首条 globalRead: true、第二条不带 → 第二条不复用(新起一个进程);新进程读取目录里既没有 "/"(盘根)也没有 HOME
await check('C2', async () => {
  const { r2, newProcs, newest } = await sendPair({ globalRead: true }, {});
  assert.notEqual(r2.body.reused, true, `首条 true、第二条不带:第二条不得复用,应答 ${JSON.stringify(r2.body)}`);
  assert.equal(newProcs, 1, '首条 true、第二条不带:第二条应新起恰好一个进程');
  const dirs = readDirsOf(newest);
  assert.equal(dirs.includes(DISK_ROOT), false, `不带 globalRead 新起的进程不得放开整盘 ${DISK_ROOT},实际读取目录 ${JSON.stringify(dirs)}`);
  assert.equal(dirs.includes(HOME), false, `不带 globalRead 新起的进程不得放开 HOME,实际读取目录 ${JSON.stringify(dirs)}`);
});
await settle('C2-收尾');

// C3:首条不带、第二条 globalRead: true → 第二条不复用;新进程读取目录里有 "/"(posix;win32 为盘根)和 HOME
await check('C3', async () => {
  const { r2, newProcs, newest } = await sendPair({}, { globalRead: true });
  assert.notEqual(r2.body.reused, true, `首条不带、第二条 true:第二条不得复用,应答 ${JSON.stringify(r2.body)}`);
  assert.equal(newProcs, 1, '首条不带、第二条 true:第二条应新起恰好一个进程');
  const dirs = readDirsOf(newest);
  assert.equal(dirs.includes(DISK_ROOT), true, `globalRead: true 新起的进程应放开整盘 ${DISK_ROOT},实际读取目录 ${JSON.stringify(dirs)}`);
  assert.equal(dirs.includes(HOME), true, `globalRead: true 新起的进程应放开 HOME,实际读取目录 ${JSON.stringify(dirs)}`);
});
await settle('C3-收尾');

// ---- 收尾:只收自己起的东西(HTTP 服务、常驻进程、临时 HOME),最后 process.exit 防挂住 ----
await new Promise((r) => server.close(() => r()));
rmSync(TMP, { recursive: true, force: true });
console.log(failures.length ? `globalread-compat-key: ${failures.length} 项失败(${failures.join(', ')})` : 'globalread-compat-key: 5 项全部通过');
process.exit(failures.length ? 1 : 0);
