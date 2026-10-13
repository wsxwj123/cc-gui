#!/usr/bin/env node
// 单测:r148 P2 —— 「正在运行的进程」接口全应用只轮询一份,页面不可见时停掉 1.5 秒的拍子。
//
// 现象:每个分屏窗格、根组件、Subagent 监控面板各自 setInterval 1.5 秒拉一次 /api/agents/active,
// 拿到的是同一份数据;6 分屏约 7 个请求 / 1.5 秒,窗口隐藏也照跑。
//
// 改法的落点:client/src/utils/agentsActivePoller.js 提供一个共用的轮询器,各处订阅同一份结果。
// 这里真跑这个轮询器(注入假的取数函数 / 定时器 / 可见性),数"发了几次请求"。
// 界面层(多窗格只有一份、隐藏时停)见 tests/acceptance/r148-perf 的 P2。
// Run: node tests/unit/check-r148-p2-agents-poller.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

console.log('r148 P2 运行进程接口只轮询一份');

let mod = null;
await check('共用轮询器模块存在(client/src/utils/agentsActivePoller.js 导出 createAgentsActivePoller)', async () => {
  mod = await import(root + 'client/src/utils/agentsActivePoller.js');
  assert.equal(typeof mod.createAgentsActivePoller, 'function');
  assert.equal(typeof mod.subscribeAgentsActive, 'function', '应用内各处用的订阅入口');
});

/** 一套假环境:手动放行的取数、手动拨的定时器、手动切的可见性。 */
function rig({ hiddenIntervalMs } = {}) {
  const calls = [];            // 每次取数:{ resolve, reject }
  const timers = new Map();    // id → { fn, ms }
  let nextTimer = 1;
  let hidden = false;
  const visListeners = new Set();
  const poller = mod.createAgentsActivePoller({
    fetchActive: () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); }),
    intervalMs: 1500,
    ...(hiddenIntervalMs === undefined ? {} : { hiddenIntervalMs }),
    setTimer: (fn, ms) => { const id = nextTimer; nextTimer += 1; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    isHidden: () => hidden,
    onVisibilityChange: (cb) => { visListeners.add(cb); return () => visListeners.delete(cb); },
  });
  return {
    poller, calls, timers,
    /** 拨一下所有周期为 ms 的定时器(模拟过了一个周期)。 */
    tick: (ms = 1500) => { for (const t of [...timers.values()]) if (t.ms === ms) t.fn(); },
    setHidden: (h) => { hidden = h; for (const cb of [...visListeners]) cb(); },
    /** 放行第 i 次取数。 */
    answer: async (i, data) => { calls[i].resolve(data); await settle(); },
    fail: async (i) => { calls[i].reject(new Error('net')); await settle(); },
  };
}

await check('6 个订阅者同时订阅:只发 1 次请求,结果 6 家都收到', async () => {
  assert.ok(mod, '模块不存在');
  const r = rig();
  const got = Array.from({ length: 6 }, () => []);
  got.forEach((list) => r.poller.subscribe((d) => list.push(d)));
  await settle();
  assert.equal(r.calls.length, 1, `订阅当下发了 ${r.calls.length} 次请求`);
  await r.answer(0, { agents: [{ pid: 1 }] });
  for (const list of got) assert.deepEqual(list, [{ agents: [{ pid: 1 }] }]);
});

await check('过一个周期:6 个订阅者合起来还是只发 1 次', async () => {
  assert.ok(mod, '模块不存在');
  const r = rig();
  for (let i = 0; i < 6; i += 1) r.poller.subscribe(() => {});
  await settle(); await r.answer(0, { agents: [] });
  r.tick(); await settle();
  assert.equal(r.calls.length, 2);
  await r.answer(1, { agents: [] });
  r.tick(); await settle();
  assert.equal(r.calls.length, 3);
});

await check('后来的订阅者拿到的一定是它订阅之后才发出的请求的结果(不拿在飞的旧请求顶替)', async () => {
  assert.ok(mod, '模块不存在');
  const r = rig();
  const early = []; const late = [];
  r.poller.subscribe((d) => early.push(d.tag));
  await settle();
  assert.equal(r.calls.length, 1);
  r.poller.subscribe((d) => late.push(d.tag));       // 第 1 次请求还在飞
  await settle();
  assert.equal(r.calls.length, 1, '同一时刻不该有两个请求并发');
  await r.answer(0, { tag: 'old', agents: [] });      // 旧请求回来:只给先订阅的那家
  assert.deepEqual(early, ['old']);
  assert.deepEqual(late, [], '后订阅的不该收到它订阅之前发出的那次结果');
  assert.equal(r.calls.length, 2, '旧请求回来后应立刻为后订阅者补发一次');
  await r.answer(1, { tag: 'fresh', agents: [] });
  assert.deepEqual(late, ['fresh']);
  assert.deepEqual(early, ['old', 'fresh']);
});

await check('退订的那家不再收到结果;全部退订后定时器停掉、不再发请求', async () => {
  assert.ok(mod, '模块不存在');
  const r = rig();
  const a = []; const b = [];
  const offA = r.poller.subscribe((d) => a.push(d));
  const offB = r.poller.subscribe((d) => b.push(d));
  await settle();
  offA();
  await r.answer(0, { agents: [] });
  assert.equal(a.length, 0, '已退订的不该再被回调');
  assert.equal(b.length, 1);
  offB();
  assert.equal([...r.timers.values()].filter((t) => t.ms === 1500).length, 0, '没人订阅了,1.5 秒的定时器应停');
  const n = r.calls.length;
  r.tick(); await settle();
  assert.equal(r.calls.length, n);
});

await check('取数失败:不回调任何人(各处原来就是 catch 后什么都不做),下个周期照常再取', async () => {
  assert.ok(mod, '模块不存在');
  const r = rig();
  const got = [];
  r.poller.subscribe((d) => got.push(d));
  await settle();
  await r.fail(0);
  assert.equal(got.length, 0);
  r.tick(); await settle();
  assert.equal(r.calls.length, 2);
  await r.answer(1, { agents: [] });
  assert.equal(got.length, 1);
});

await check('页面不可见:1.5 秒的拍子停;回到可见立刻补一次并恢复拍子', async () => {
  assert.ok(mod, '模块不存在');
  const r = rig({ hiddenIntervalMs: 0 });
  const got = [];
  r.poller.subscribe((d) => got.push(d));
  await settle(); await r.answer(0, { agents: [] });
  r.setHidden(true); await settle();
  assert.equal([...r.timers.values()].filter((t) => t.ms === 1500).length, 0, '不可见时 1.5 秒的定时器应停');
  assert.equal(r.timers.size, 0, 'hiddenIntervalMs=0 = 不可见时完全不取');
  const n = r.calls.length;
  r.setHidden(false); await settle();
  assert.equal(r.calls.length, n + 1, '回到可见应立刻补一次');
  assert.equal([...r.timers.values()].filter((t) => t.ms === 1500).length, 1, '回到可见应恢复 1.5 秒的拍子');
  await r.answer(n, { agents: [] });
  assert.equal(got.length, 2);
});

await check('页面不可见时的慢拍(hiddenIntervalMs>0):按慢拍取,不按 1.5 秒取', async () => {
  assert.ok(mod, '模块不存在');
  const r = rig({ hiddenIntervalMs: 20_000 });
  r.poller.subscribe(() => {});
  await settle(); await r.answer(0, { agents: [] });
  r.setHidden(true); await settle();
  assert.equal([...r.timers.values()].filter((t) => t.ms === 1500).length, 0);
  assert.equal([...r.timers.values()].filter((t) => t.ms === 20_000).length, 1);
  const n = r.calls.length;
  r.tick(20_000); await settle();
  assert.equal(r.calls.length, n + 1);
});

await check('fetchFresh():拿到的是调用之后才发出的那次结果,且与轮询共用请求(不另开并发)', async () => {
  assert.ok(mod, '模块不存在');
  const r = rig();
  r.poller.subscribe(() => {});
  await settle();
  assert.equal(r.calls.length, 1);
  let fresh = null;
  const p = r.poller.fetchFresh().then((d) => { fresh = d.tag; });
  await settle();
  assert.equal(r.calls.length, 1, '有请求在飞时不并发');
  await r.answer(0, { tag: 'old', agents: [] });
  assert.equal(fresh, null, '在飞的旧结果不算数');
  await r.answer(1, { tag: 'fresh', agents: [] });
  await p;
  assert.equal(fresh, 'fresh');
});

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
