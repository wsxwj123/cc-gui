#!/usr/bin/env node
// 单测:r148b A2 —— 共用的「运行进程」轮询,在飞请求要有超时。
//
// 现象:轮询器同一时刻只允许一个请求在飞,定时的那一拍撞上在飞的请求就跳过。一次请求要是挂住不回
// (后端卡住、连接半开),"在飞"就永远不结束 —— 全应用的轮询从此停掉:各窗格的后台横幅、排队消息
// 自动发出、自动重连、Dock 角标都不再更新。改成各处共用一份之前,一个窗格挂住只影响它自己。
//
// 可数的量:请求挂住之后,过了超时点再拨一拍,发出去的请求数有没有 +1。
// Run: node tests/unit/check-r148b-poller-timeout.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

console.log('r148b A2 运行进程轮询:在飞请求超时');

const mod = await import(root + 'client/src/utils/agentsActivePoller.js');

/** 假环境:手动放行的取数、手动拨的拍子、手动触发的超时。 */
function rig({ timeoutMs = 10_000 } = {}) {
  const calls = [];             // { resolve, reject, signal }
  const intervals = new Map();  // id → fn
  const timeouts = new Map();   // id → { fn, ms }
  let nextId = 1;
  const poller = mod.createAgentsActivePoller({
    fetchActive: (opts) => new Promise((resolve, reject) => { calls.push({ resolve, reject, signal: opts && opts.signal }); }),
    intervalMs: 1500,
    timeoutMs,
    setTimer: (fn) => { const id = nextId; nextId += 1; intervals.set(id, fn); return id; },
    clearTimer: (id) => { intervals.delete(id); },
    setTimeoutFn: (fn, ms) => { const id = nextId; nextId += 1; timeouts.set(id, { fn, ms }); return id; },
    clearTimeoutFn: (id) => { timeouts.delete(id); },
    isHidden: () => false,
    onVisibilityChange: () => () => {},
  });
  return {
    poller, calls, timeouts,
    tick: async () => { for (const fn of [...intervals.values()]) fn(); await settle(); },
    /** 让所有挂着的超时到点。 */
    expire: async () => { for (const [id, t] of [...timeouts]) { timeouts.delete(id); t.fn(); } await settle(); },
    answer: async (i, data) => { calls[i].resolve(data); await settle(); },
  };
}

await check('模块导出超时常量 AGENTS_ACTIVE_TIMEOUT_MS(有限正数,且不短于一拍)', async () => {
  assert.ok(Number.isFinite(mod.AGENTS_ACTIVE_TIMEOUT_MS) && mod.AGENTS_ACTIVE_TIMEOUT_MS >= mod.AGENTS_ACTIVE_INTERVAL_MS,
    `AGENTS_ACTIVE_TIMEOUT_MS = ${mod.AGENTS_ACTIVE_TIMEOUT_MS}`);
});

await check('请求挂住不回:没到超时点时拍子照旧跳过(不并发);到点之后下一拍照常发出新请求', async () => {
  const r = rig();
  const got = [];
  r.poller.subscribe((d) => got.push(d.tag));
  await settle();
  assert.equal(r.calls.length, 1);
  await r.tick(); await r.tick();
  assert.equal(r.calls.length, 1, '在飞的请求还没超时,不该并发再发');
  await r.expire();                       // 第 1 次请求超时:放弃这一拍
  assert.equal(got.length, 0, '超时 = 这一拍没取到,不回调任何人');
  await r.tick();
  assert.equal(r.calls.length, 2, '超时之后下一拍应照常发出(原来:永远卡在 1,全应用轮询停掉)');
  await r.answer(1, { tag: 'second', agents: [] });
  assert.deepEqual(got, ['second']);
  await r.tick();
  assert.equal(r.calls.length, 3, '之后拍子恢复正常');
});

await check('超时那一刻取消这次请求(交给取数函数的 signal 被 abort)', async () => {
  const r = rig();
  r.poller.subscribe(() => {});
  await settle();
  assert.ok(r.calls[0].signal, '取数函数应拿到一个 signal');
  assert.equal(r.calls[0].signal.aborted, false);
  await r.expire();
  assert.equal(r.calls[0].signal.aborted, true);
});

await check('已经超时放弃的那次请求,晚到的结果不交给任何人(不拿旧数据顶替后来的新数据)', async () => {
  const r = rig();
  const got = [];
  r.poller.subscribe((d) => got.push(d.tag));
  await settle();
  await r.expire();
  await r.tick();
  assert.equal(r.calls.length, 2);
  await r.answer(1, { tag: 'fresh', agents: [] });
  await r.answer(0, { tag: 'stale-late', agents: [] });   // 第 1 次的结果这时才到
  assert.deepEqual(got, ['fresh']);
  await r.tick();
  assert.equal(r.calls.length, 3, '晚到的旧结果不能把"在飞"状态弄乱');
});

await check('超时时,正在等新鲜结果的 fetchFresh 调用以失败告终(调用方原本就有 catch)', async () => {
  const r = rig();
  let outcome = null;
  const p = r.poller.fetchFresh().then(() => { outcome = 'ok'; }, () => { outcome = 'failed'; });
  await settle();
  assert.equal(r.calls.length, 1);
  await r.expire();
  await p;
  assert.equal(outcome, 'failed');
});

await check('超时期间又有人要新鲜数据(新订阅者):超时后立刻补发,不必等下一拍', async () => {
  const r = rig();
  r.poller.subscribe(() => {});
  await settle();
  const late = [];
  r.poller.subscribe((d) => late.push(d.tag));           // 第 1 次还在飞
  await settle();
  assert.equal(r.calls.length, 1);
  await r.expire();
  assert.equal(r.calls.length, 2, '超时后应立刻为后订阅者补发');
  await r.answer(1, { tag: 'fresh', agents: [] });
  assert.deepEqual(late, ['fresh']);
});

await check('请求正常返回:它的超时计时被清掉,不留挂着的定时器', async () => {
  const r = rig();
  r.poller.subscribe(() => {});
  await settle();
  assert.equal(r.timeouts.size, 1, '在飞时应挂着一个超时计时');
  assert.equal([...r.timeouts.values()][0].ms, 10_000);
  await r.answer(0, { agents: [] });
  assert.equal(r.timeouts.size, 0);
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
