// r185:新会话的会话文件「够列会话门槛(≥3 个非空行)」才补发一次 file-change。
// 白盒行为测:server/utils/new-session-file-watch.js 的 countNonEmptyLinesUpTo / watchNewSessionFile,
// 用系统临时目录里的真文件,不数源码文本。
// 跑法:node tests/unit/check-r185-new-session-file-watch.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { countNonEmptyLinesUpTo, watchNewSessionFile, LISTABLE_MIN_LINES } from '../../server/utils/new-session-file-watch.js';

const dir = mkdtempSync(join(tmpdir(), 'r185-watch-'));
const SID = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 只数本进程里活着的定时器(不认识这个接口的老 Node 返回 null,相关断言跳过)
const activeTimeouts = () => (typeof process.getActiveResourcesInfo === 'function'
  ? process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length : null);
const assertNoLeftoverTimer = (base, msg) => {
  const now = activeTimeouts();
  if (now !== null) assert.equal(now, base, msg);
};
// 照真实命令行 2.1.323 一轮开头的写法:入队、出队、用户消息
const enqueue = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-14T00:00:00.000Z', sessionId: SID, content: 'hi' });
const dequeue = JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: '2026-11-14T00:00:00.001Z', sessionId: SID });
const userLine = JSON.stringify({ type: 'user', sessionId: SID, message: { role: 'user', content: 'hi' } });

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ')}`); }
}

console.log('r185 · 数非空行(与列会话的 totalLines 同口径)');
await check('文件不存在 → 0', async () => {
  assert.equal(await countNonEmptyLinesUpTo(join(dir, 'nope.jsonl'), 3), 0);
});
await check('空行、只含空白的行不算;CRLF 行尾照常算一行', async () => {
  const f = join(dir, 'blank.jsonl');
  writeFileSync(f, 'a\n\n   \n\t\r\nb\r\n\r\n');
  assert.equal(await countNonEmptyLinesUpTo(f, 10), 2);
});
await check('末尾没换行的半行也算', async () => {
  const f = join(dir, 'partial.jsonl');
  writeFileSync(f, `${enqueue}\n${dequeue}\n${userLine}`);
  assert.equal(await countNonEmptyLinesUpTo(f, 3), 3);
  writeFileSync(f, `${enqueue}\n${dequeue}`);
  assert.equal(await countNonEmptyLinesUpTo(f, 3), 2);
});
await check('数到上限就停(返回值不超过上限)', async () => {
  const f = join(dir, 'many.jsonl');
  writeFileSync(f, 'a\nb\nc\nd\ne\n');
  assert.equal(await countNonEmptyLinesUpTo(f, 3), 3);
});
await check('首行超过一次读取的块大小(200KB)也数得对', async () => {
  const f = join(dir, 'big.jsonl');
  writeFileSync(f, `${'x'.repeat(200 * 1024)}\n\n${dequeue}\n${userLine}\n`);
  assert.equal(await countNonEmptyLinesUpTo(f, 3), 3);
});
await check('门槛常量是 3(与 listSessions 跳过 totalLines < 3 对齐)', async () => {
  assert.equal(LISTABLE_MIN_LINES, 3);
});

console.log('r185 · 盯新会话文件');
await check('文件晚出现、先只有 2 行 → 不通知;第 3 行写下后通知且只通知一次,之后不留定时器', async () => {
  const file = join(dir, 'late.jsonl');
  const spy = { calls: 0 };
  const ready = [];
  const base = activeTimeouts();
  const w = watchNewSessionFile({ sessionId: SID, locate: (sid) => { spy.calls++; assert.equal(sid, SID); return existsSync(file) ? file : null; }, onReady: (p) => ready.push(p), intervalMs: 20, timeoutMs: 5000 });
  await sleep(80);
  assert.equal(ready.length, 0, '文件还没出现就不该通知');
  assert.ok(spy.calls >= 2, `文件没出现时应反复去找,实际 ${spy.calls} 次`);
  writeFileSync(file, `${enqueue}\n${dequeue}\n`);
  await sleep(100);
  assert.equal(ready.length, 0, '只有 2 行(不够列会话门槛)不该通知');
  appendFileSync(file, `${userLine}\n`);
  await sleep(100);
  assert.deepEqual(ready, [file], '够 3 行应通知一次,带文件路径');
  appendFileSync(file, `${userLine}\n`);
  await sleep(100);
  assert.equal(ready.length, 1, '通知过之后不再通知');
  assertNoLeftoverTimer(base, '通知后不应留下定时器');
  w.stop(); // 已停之后再停无害
});
await check('文件一开始就够格 → 立刻通知,不等第一个间隔', async () => {
  const file = join(dir, 'ready.jsonl');
  writeFileSync(file, `${enqueue}\n${dequeue}\n${userLine}\n`);
  const ready = [];
  const base = activeTimeouts();
  watchNewSessionFile({ sessionId: SID, locate: () => file, onReady: (p) => ready.push(p), intervalMs: 10000, timeoutMs: 30000 });
  await sleep(60);
  assert.deepEqual(ready, [file]);
  assertNoLeftoverTimer(base, '通知后不应留下定时器(间隔 10 秒的那个也不该挂着)');
});
await check('stop() 之后不再检查;文件随后够格也不通知,不留定时器', async () => {
  const file = join(dir, 'stopped.jsonl');
  let calls = 0;
  const ready = [];
  const base = activeTimeouts();
  const w = watchNewSessionFile({ sessionId: SID, locate: () => { calls++; return existsSync(file) ? file : null; }, onReady: (p) => ready.push(p), intervalMs: 20, timeoutMs: 5000 });
  await sleep(70);
  w.stop();
  assertNoLeftoverTimer(base, 'stop() 后不应留下定时器');
  const callsAtStop = calls;
  writeFileSync(file, `${enqueue}\n${dequeue}\n${userLine}\n`);
  await sleep(100);
  assert.equal(calls, callsAtStop, 'stop() 后不应再去找文件');
  assert.equal(ready.length, 0, 'stop() 后不应通知');
});
await check('检查进行到一半时 stop() → 那次结果作废,不通知', async () => {
  const file = join(dir, 'inflight.jsonl');
  writeFileSync(file, `${enqueue}\n${dequeue}\n${userLine}\n`);
  const ready = [];
  const w = watchNewSessionFile({ sessionId: SID, locate: () => sleep(60).then(() => file), onReady: (p) => ready.push(p), intervalMs: 20, timeoutMs: 5000 });
  await sleep(20);
  w.stop();
  await sleep(120);
  assert.equal(ready.length, 0);
});
await check('到上限仍没出现 → 不通知、自己停,不留定时器', async () => {
  let calls = 0;
  const ready = [];
  const base = activeTimeouts();
  watchNewSessionFile({ sessionId: SID, locate: () => { calls++; return null; }, onReady: (p) => ready.push(p), intervalMs: 20, timeoutMs: 120 });
  await sleep(250);
  const callsAtEnd = calls;
  assert.ok(callsAtEnd >= 3, `上限内应反复去找,实际 ${callsAtEnd} 次`);
  await sleep(100);
  assert.equal(calls, callsAtEnd, '到上限后不应再去找');
  assert.equal(ready.length, 0);
  assertNoLeftoverTimer(base, '到上限后不应留下定时器');
});
await check('找文件 / 读文件出错 → 当作还没好继续看,不抛出', async () => {
  const file = join(dir, 'flaky.jsonl');
  writeFileSync(file, `${enqueue}\n${dequeue}\n${userLine}\n`);
  let calls = 0;
  const ready = [];
  watchNewSessionFile({ sessionId: SID, locate: () => { calls++; if (calls < 3) throw new Error('EACCES'); return file; }, onReady: (p) => ready.push(p), intervalMs: 20, timeoutMs: 5000 });
  await sleep(150);
  assert.deepEqual(ready, [file]);
});
await check('通知回调抛错 → 不变成未处理的拒绝(不掀翻进程)', async () => {
  const file = join(dir, 'throws.jsonl');
  writeFileSync(file, `${enqueue}\n${dequeue}\n${userLine}\n`);
  const before = unhandled;
  const origError = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  try {
    watchNewSessionFile({ sessionId: SID, locate: () => file, onReady: () => { throw new Error('boom'); }, intervalMs: 20, timeoutMs: 5000 });
    await sleep(60);
  } finally { console.error = origError; }
  assert.equal(unhandled, before, '不应有未处理的拒绝');
  assert.equal(logged, 1, '回调出错应记一条日志');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
