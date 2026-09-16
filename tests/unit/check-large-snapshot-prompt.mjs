#!/usr/bin/env node
// r120 R7(大目录首次拍快照前弹窗询问)的白盒自检:
//   ① 前端"每会话只问一次"的判定(纯函数,直接 import 断言)
//   ② 接口层:带"用户已确认保存"标记(allowOversize:true)时超阈值仍照常创建;
//      不带标记时仍是"跳过 + 原因"(既有语义不变)
//   ③ 反向守卫:未超阈值的小目录静默照拍,不吃这个标记
// 隔离:自建 HOME 与端口(6741,避开 6677/6689/6710),绝不读写真实 ~/.claude/gui/checkpoints。
// 夹具克制:filler.bin 用稀疏文件(逻辑 1 MiB / 实际写盘近 0),其余是 40 KB 小文件。
// Run: node tests/unit/check-large-snapshot-prompt.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, truncateSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimLargeSnapshotAsk, largeSnapshotDecided, largeSnapshotQuestion,
  oversizeAllowedFor, preflightLargeSnapshot, rememberLargeSnapshot, resetLargeSnapshotState, humanBytes,
} from '../../client/src/utils/largeSnapshot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PASS = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); PASS += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 4).join('\n      ')}`); }
}

// ── ① 每会话只问一次的判定 ──────────────────────────────────────────────
console.log('\nR7 每会话只问一次的判定(前端纯逻辑)');
ok('同一会话:第一次认领成功,第二次被拒(不重复弹窗)', () => {
  resetLargeSnapshotState();
  assert.equal(claimLargeSnapshotAsk('s1'), true, '第一次该由它来问');
  assert.equal(claimLargeSnapshotAsk('s1'), false, '同一会话第二次必须不再问');
});

ok('不同会话互不影响:各问各的一次', () => {
  resetLargeSnapshotState();
  assert.equal(claimLargeSnapshotAsk('s1'), true);
  assert.equal(claimLargeSnapshotAsk('s2'), true, '另一个会话该有自己的第一次');
  assert.equal(claimLargeSnapshotAsk('s1'), false);
  assert.equal(claimLargeSnapshotAsk('s2'), false);
});

ok('选过"不保存"后:不再问,也不带照存标记', () => {
  resetLargeSnapshotState();
  claimLargeSnapshotAsk('s1');
  rememberLargeSnapshot('s1', false);
  assert.equal(largeSnapshotDecided('s1'), true, '该会话已做过选择');
  assert.equal(claimLargeSnapshotAsk('s1'), false, '做过选择就不再问');
  assert.equal(oversizeAllowedFor('s1'), false, '"不保存"不得被当成照存');
  assert.equal(oversizeAllowedFor('s2'), false, '别的会话不受影响');
});

ok('选过"保存"后:不再问,但后续快照直接带照存标记', () => {
  resetLargeSnapshotState();
  claimLargeSnapshotAsk('s1');
  rememberLargeSnapshot('s1', true);
  assert.equal(claimLargeSnapshotAsk('s1'), false, '问过就不再问');
  assert.equal(oversizeAllowedFor('s1'), true, '"保存"必须被记住,否则下次被静默跳过');
});

ok('空 sessionId 不进记忆(null/undefined 不产生空键)', () => {
  resetLargeSnapshotState();
  assert.equal(claimLargeSnapshotAsk(''), false);
  assert.equal(claimLargeSnapshotAsk(null), false);
  rememberLargeSnapshot('', true);
  assert.equal(largeSnapshotDecided(''), false, '空 key 不该被记下');
});

// ── ② 弹窗文案:说清目录多大 + 会整份复制占盘 ────────────────────────────
console.log('\nR7 弹窗文案(D2)');
ok('人话量级:字节数按 KB/MB/GB 展示', () => {
  assert.equal(humanBytes(38.2 * 1024 ** 3), '38.2 GB');
  assert.equal(humanBytes(65536), '64 KB');
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(NaN), '0 B');
});

ok('文案含:目录多大、体积上限、会复制一份占磁盘;并说明只问这一次', () => {
  const t = largeSnapshotQuestion({ estimatedBytes: 41019928576, limitBytes: 2 * 1024 ** 3, truncated: false });
  assert.match(t, /38\.2 GB/, `要给出人话量级的大小,实际:${t}`);
  assert.match(t, /2 GB/, `要给出对照的阈值,实际:${t}`);
  assert.match(t, /复制一份/, `要说清保存=整目录复制一份,实际:${t}`);
  assert.match(t, /额外占用磁盘空间/, `要说清占盘,实际:${t}`);
  assert.match(t, /只询问这一次/, `要说清本会话只问一次,实际:${t}`);
  assert.match(t, /保存快照|是否|要不要/, `要让用户看得出是"要不要为大目录保存快照",实际:${t}`);
});

ok('估算被截断时不说死数:用"至少"而不是"约"', () => {
  const t = largeSnapshotQuestion({ estimatedBytes: 5 * 1024 ** 2, limitBytes: 65536, truncated: true });
  assert.match(t, /至少 5 MB/, `截断时只能给下界,实际:${t}`);
  assert.doesNotMatch(t, /约 5 MB/, '截断时不得说"约"');
  const t2 = largeSnapshotQuestion({ estimatedBytes: 0, limitBytes: 65536, truncated: true });
  assert.match(t2, /无法估算/, `一点没统计出来就别报 0 B,实际:${t2}`);
});

// ── ③ 接口层:标记从外部注入 ────────────────────────────────────────────
console.log('\nR7 接口层(allowOversize 标记)');
const TMP = mkdtempSync(join('/private/tmp', 'cgui-r7-'));
const HOME = join(TMP, 'home');
const WORK = join(HOME, 'work');
mkdirSync(WORK, { recursive: true });
const PORT = 6741;
const SNAP_ROOT = join(HOME, '.claude', 'gui', 'checkpoints');

process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.PORT = String(PORT);
process.env.CGUI_DISABLE_FILE_WATCHER = '1';
process.env.CGUI_CHECKPOINT_MAX_BYTES = '65536';       // 64 KB:夹具一超就触发
process.env.CGUI_CHECKPOINT_MAX_COUNT = '20';
process.env.CGUI_CHECKPOINT_RETENTION_DAYS = '30';

const BASE = `http://127.0.0.1:${PORT}`;
async function post(url, body, timeoutMs = 120_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, text, json };
  } finally { clearTimeout(timer); }
}
async function get(url) {
  const res = await fetch(BASE + url, { signal: AbortSignal.timeout(20_000) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const snapDir = (sid) => join(SNAP_ROOT, sid);
function realShas(sid) {
  if (!existsSync(snapDir(sid))) return [];
  const r = spawnSync('git', ['--git-dir', snapDir(sid), 'log', '--format=%H'], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}
/** 大目录夹具:1 个稀疏 1 MiB 文件 + 10 个 4 KB 小文件(实际写盘 ~40 KB)。 */
function makeBigDir(name) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const filler = join(dir, 'filler.bin');
  writeFileSync(filler, '');
  truncateSync(filler, 1024 * 1024);
  const blob = Buffer.alloc(4096, 0x61);
  for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, `data-${i}.txt`), blob);
  return dir;
}
function makeSmallDir(name) {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'note.txt'), '小目录\n');
  return dir;
}

let child = null;
let serverLog = '';
async function bootServer() {
  child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: TMP, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => { serverLog += b; });
  child.stderr.on('data', (b) => { serverLog += b; });
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`隔离实例没起来(端口 ${PORT})\n${serverLog.slice(-1500)}`);
}

const BIG = makeBigDir('big');
const SMALL = makeSmallDir('small');
const S_BIG = 'r7big000-0000-4000-8000-000000000001';
const S_SMALL = 'r7small0-0000-4000-8000-000000000002';

await bootServer();
console.log(`[r7] 隔离实例就绪:${BASE}(HOME=${HOME})`);

/** 断言块里的失败也要计入总账并保证收尾。 */
async function step(name, fn) {
  try { await fn(); PASS += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 4).join('\n      ')}`); }
}

await step('D7 不带标记 + 超阈值 → 仍是 skipped + reason,磁盘上不出现快照(既有语义不变)', async () => {
  const before = (await get(`/api/checkpoints/${S_BIG}`)).json.entries.length;
  const res = await post('/api/checkpoints', { sessionId: S_BIG, cwd: BIG });
  assert.equal(res.status, 200, `不得报错,实际 ${res.status}: ${res.text.slice(0, 160)}`);
  assert.equal(res.json.skipped, true, '不带标记时超阈值必须仍报 skipped');
  assert.ok(res.json.reason, '必须给出原因(界面弹窗要拿它说清情况)');
  assert.ok(res.json.estimatedBytes > 0 && res.json.limitBytes > 0, '要给得出体积与阈值(弹窗文案要用)');
  assert.equal(res.json.sha, undefined, '跳过时不得有 sha');
  assert.equal((await get(`/api/checkpoints/${S_BIG}`)).json.entries.length, before, '跳过时列表条数不变');
  assert.equal(realShas(S_BIG).length, 0, '跳过时磁盘上不该有快照');
});

await step('D3/D7 带标记(用户已确认保存)+ 超阈值 → 照常创建,列表 +1 且磁盘上找得到', async () => {
  const before = realShas(S_BIG).length;
  const res = await post('/api/checkpoints', { sessionId: S_BIG, cwd: BIG, allowOversize: true, label: 'before: 大目录' });
  assert.equal(res.status, 200, `带标记应照常创建,实际 ${res.status}: ${res.text.slice(0, 160)}`);
  assert.ok(res.json.sha, `必须返回 sha,实际 ${res.text.slice(0, 160)}`);
  assert.notEqual(res.json.skipped, true, '带标记时不许再报跳过');
  const after = realShas(S_BIG);
  assert.equal(after.length, before + 1, '磁盘上的快照应 +1');
  assert.ok(after.includes(res.json.sha), '返回的 sha 必须在磁盘仓里真实存在');
  const list = await get(`/api/checkpoints/${S_BIG}`);
  assert.equal(list.json.entries.length, 1, '列表应如实地多出这一条');
  assert.equal(list.json.entries[0].sha, res.json.sha, '列表里的就是刚拍的那条');
});

await step('D6 反向守卫:未超阈值的小目录不带标记也照拍,且不返回跳过字段', async () => {
  const res = await post('/api/checkpoints', { sessionId: S_SMALL, cwd: SMALL });
  assert.equal(res.status, 200, `小目录应照拍,实际 ${res.status}: ${res.text.slice(0, 160)}`);
  assert.ok(res.json.sha, '小目录该返回 sha');
  assert.notEqual(res.json.skipped, true, '小目录不该被判定为超阈值');
  assert.ok(realShas(S_SMALL).includes(res.json.sha), '小目录的快照要在磁盘上找得到');
});

await step('标记必须是明确的 true:false/缺省都仍按跳过处理(不误放开)', async () => {
  const r1 = await post('/api/checkpoints', { sessionId: S_BIG, cwd: BIG, allowOversize: false });
  assert.equal(r1.json.skipped, true, 'false 不得被当成"已确认"');
  const r2 = await post('/api/checkpoints', { sessionId: S_BIG, cwd: BIG, allowOversize: 'yes' });
  assert.equal(r2.json.skipped, true, '字符串不得被当成"已确认"');
  assert.equal(realShas(S_BIG).length, 1, '这两次都不该新增快照');
});

// ── ④ 安全门禁:allowOversize 只认本机(回环)请求 ─────────────────────────
// 体积上限护的是主机磁盘,标记不能谁带谁过关:公开版默认开局域网,远端(手机/别的
// 机器)也是"已授权客户端",一个请求就能让服务端把几十 G 目录整份复制进 ~/.claude/gui/。
// 用注入假 req 的方式直接调路由处理器(不起真实网络请求)。HOME/阈值已在上面设好。
console.log('\nR7 安全门禁(标记只信本机请求)');
const { default: cpRouter } = await import('../../server/routes/checkpoints.js');
const cpLayer = cpRouter.stack.find((l) => l.route?.path === '/checkpoints' && l.route.methods?.post);
const cpHandler = cpLayer?.route?.stack?.[0]?.handle;
const S_GATE = 'r7gate00-0000-4000-8000-000000000003';

/** 假 req/res:只为驱动路由处理器,不碰真实 socket。 */
async function callPost({ remoteAddress, headers, body }) {
  const out = { status: 0, json: undefined };
  const res = {
    status(c) { out.status = c; return this; },
    json(payload) { out.json = payload; return this; },
  };
  await cpHandler({ body, socket: { remoteAddress }, headers }, res);
  return out;
}

await step('非本机(局域网直连)带 allowOversize → 仍按超阈值跳过,磁盘上不出现快照', async () => {
  const r = await callPost({
    remoteAddress: '192.168.1.9',
    headers: { host: '192.168.1.9:6677' },
    body: { sessionId: S_GATE, cwd: BIG, allowOversize: true },
  });
  assert.equal(r.json?.skipped, true, `远端不得靠自报标记关掉体积上限,实际:${JSON.stringify(r.json)}`);
  assert.ok(r.json?.reason, '仍要给得出原因');
  assert.equal(realShas(S_GATE).length, 0, '远端带标记时磁盘上不该出现快照');
});

await step('经隧道进来的本机 socket(CF 标记头)带 allowOversize → 同样跳过', async () => {
  const r = await callPost({
    remoteAddress: '::ffff:127.0.0.1',                 // cloudflared 在本机,回流也是回环
    headers: { host: 'localhost:6677', 'cf-connecting-ip': '203.0.113.7' },
    body: { sessionId: S_GATE, cwd: BIG, allowOversize: true },
  });
  assert.equal(r.json?.skipped, true, '隧道流量只是 socket 回环,不得被当成"本机用户点了保存"');
  assert.equal(realShas(S_GATE).length, 0, '隧道流量不得创建快照');
});

await step('反向守卫:本机回环请求带 allowOversize → 照常创建(门禁不许把桌面端也挡了)', async () => {
  const r = await callPost({
    remoteAddress: '127.0.0.1',
    headers: { host: '127.0.0.1:6677' },
    body: { sessionId: S_GATE, cwd: BIG, allowOversize: true },
  });
  assert.equal(r.status || 200, 200, `本机带标记应照常创建,实际 ${JSON.stringify(r.json)}`);
  assert.ok(r.json?.sha, `本机已确认保存时必须拍到,实际:${JSON.stringify(r.json)}`);
  assert.ok(realShas(S_GATE).includes(r.json.sha), '本机拍到的 sha 要在磁盘仓里找得到');
});

// ── ⑤ 阻塞式(D 修订):顺序断言 —— 谁先谁后由事件序列钉死 ────────────────
// 直接驱动 utils/largeSnapshot.js 的 preflightLargeSnapshot(注入桩 fetch/弹窗),
// 调用方就是"发消息的人":先 await preflight,再 send。故序列里 send 必在最后。
console.log('\nR7 阻塞式(D 修订:未回答不发消息;保存先于消息)');

/** 造一套桩:events 记录每一步;confirm 可控手动 resolve。 */
function harness({ probe, onSave }) {
  const events = [];
  let releaseConfirm;
  const deps = {
    request: async (url, body) => {
      events.push({ ev: 'checkpoint', allowOversize: body?.allowOversize === true, url });
      const r = body?.allowOversize === true ? onSave : probe;
      return { ok: r?.ok !== false, data: r?.data || {} };
    },
    confirm: (message, opts) => {
      events.push({ ev: 'ask', message, opts });
      return new Promise((res) => { releaseConfirm = res; });
    },
  };
  return {
    events,
    deps,
    answer: (v) => releaseConfirm(v),
    /** 模拟真实调用方:preflight 返回后才发消息。 */
    async run(payload) {
      const sha = await preflightLargeSnapshot(payload, deps);
      events.push({ ev: 'send-message', sha: sha || null });
      return sha;
    },
  };
}
const SKIPPED = { ok: true, data: { skipped: true, estimatedBytes: 40 * 1024 ** 3, limitBytes: 2 * 1024 ** 3 } };
const SMALL_OK = { ok: true, data: { sha: 'small-sha' } };
const SAVED = { ok: true, data: { sha: 'big-sha' } };
const P = { sessionId: 's-block', cwd: '/tmp/w', label: 'before: hi' };

await step('D5 修订:用户没回答之前,消息不发(序列里 send 尚不存在)', async () => {
  resetLargeSnapshotState();
  const h = harness({ probe: SKIPPED, onSave: SAVED });
  const done = h.run(P);
  await new Promise((r) => setTimeout(r, 20));                     // 让探测请求跑完、弹窗挂上
  const kinds = h.events.map((e) => e.ev);
  assert.deepEqual(kinds, ['checkpoint', 'ask'], `未回答时只能走到弹窗,实际序列:${JSON.stringify(kinds)}`);
  assert.equal(h.events[0].allowOversize, false, '第一次只是探测,不许一上来就带照存标记');
  h.answer(true);
  await done;
  assert.deepEqual(h.events.map((e) => e.ev).slice(-2), ['checkpoint', 'send-message'], '选保存后才轮到重拍与发送');
});

await step('D3 补强:选"保存"→ 快照先于消息(第二次 checkpoint 排在 send 之前,且带照存标记)', async () => {
  resetLargeSnapshotState();
  const h = harness({ probe: SKIPPED, onSave: SAVED });
  const sha = await (async () => {
    const p = h.run(P);
    await new Promise((r) => setTimeout(r, 20));
    h.answer(true);
    return p;
  })();
  assert.deepEqual(h.events.map((e) => e.ev), ['checkpoint', 'ask', 'checkpoint', 'send-message'],
    `顺序必须是 探测→问→重拍→发送,实际:${JSON.stringify(h.events.map((e) => e.ev))}`);
  assert.deepEqual(h.events.map((e) => e.ev).indexOf('send-message'), 3, '发送必须在最后一步');
  assert.equal(h.events[2].allowOversize, true, '重拍必须带"用户已确认照存"标记');
  assert.equal(sha, 'big-sha', '推送出去的锚点就是刚拍的快照');
  assert.equal(h.events[3].sha, 'big-sha', '消息带的就是这张快照的 sha');
});

await step('D4 选"不保存"→ 不重拍(只有一次 checkpoint),直接放行消息', async () => {
  resetLargeSnapshotState();
  const h = harness({ probe: SKIPPED, onSave: SAVED });
  const sha = await (async () => {
    const p = h.run(P);
    await new Promise((r) => setTimeout(r, 20));
    h.answer(false);
    return p;
  })();
  assert.deepEqual(h.events.map((e) => e.ev), ['checkpoint', 'ask', 'send-message'],
    `不保存不得重拍,实际:${JSON.stringify(h.events.map((e) => e.ev))}`);
  assert.equal(sha, null, '不保存没有快照锚点');
  assert.equal(h.events[2].sha, null, '消息照常发出,只是没有回滚锚点');
});

await step('D6 小目录不打扰:压根不弹窗,一拍就走', async () => {
  resetLargeSnapshotState();
  const h = harness({ probe: SMALL_OK, onSave: SAVED });
  const sha = await h.run(P);
  assert.deepEqual(h.events.map((e) => e.ev), ['checkpoint', 'send-message'], '小目录不得出现任何询问');
  assert.equal(sha, 'small-sha');
});

await step('R7-5 问过一次就不再等:同会话第二次直接放行,不弹窗、不多等', async () => {
  resetLargeSnapshotState();
  const h1 = harness({ probe: SKIPPED, onSave: SAVED });
  const p1 = h1.run(P);
  await new Promise((r) => setTimeout(r, 20));
  h1.answer(false);                                                 // 本会话定调:不保存
  await p1;
  const h2 = harness({ probe: SKIPPED, onSave: SAVED });
  const sha2 = await h2.run(P);
  assert.deepEqual(h2.events.map((e) => e.ev), ['checkpoint', 'send-message'],
    `已问过的会话不得再弹窗,实际:${JSON.stringify(h2.events.map((e) => e.ev))}`);
  assert.equal(sha2, null, '记住的选择是不保存');
});

await step('D8 弹窗有两个明确可点的选项(确认=保存 / 取消=不保存)', async () => {
  resetLargeSnapshotState();
  const h = harness({ probe: SKIPPED, onSave: SAVED });
  const p = h.run(P);
  await new Promise((r) => setTimeout(r, 20));
  const ask = h.events.find((e) => e.ev === 'ask');
  assert.ok(ask, '该弹出询问');
  assert.ok(ask.opts?.confirmText, '必须给「保存」这个明确选项,不能只有关闭');
  assert.ok(ask.opts?.cancelText, '必须给「不保存」这个明确选项,不能只有关闭');
  assert.match(ask.message, /是否/, '正文要说清在问什么');
  h.answer(false);
  await p;
});

await step('反向守卫:超阈值但接口报错(非 ok)→ 不弹窗、不重拍,消息照发', async () => {
  resetLargeSnapshotState();
  const h = harness({ probe: { ok: false }, onSave: SAVED });
  const sha = await h.run(P);
  assert.deepEqual(h.events.map((e) => e.ev), ['checkpoint', 'send-message'],
    `接口报错不得卡住发送,实际:${JSON.stringify(h.events.map((e) => e.ev))}`);
  assert.equal(sha, null);
});

// ── 收尾 ────────────────────────────────────────────────────────────────
if (child) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退 */ } child = null; }
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(`\n—— check-large-snapshot-prompt:${PASS} 绿 / ${failures.length} 红 ——`);
if (failures.length) { for (const n of failures) console.log(`  ✗ ${n}`); process.exit(1); }
