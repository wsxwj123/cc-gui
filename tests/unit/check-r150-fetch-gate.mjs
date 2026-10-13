#!/usr/bin/env node
// 单测:r150c M1 —— 工具面板"读取结果该不该采纳"的判定(模块 client/src/utils/fetchGate.js,纯机制,零依赖)。
//
// 现象(审查实测):打开工具面板 → 5 秒内点「刷新」(?fresh=1,要等健康检查,几秒到几十秒)→ 挂载后第 5 秒的
// 静默读取发起,它读后端缓存、立刻返回并被采纳 → 「刷新」的结果回来时已经不是"最后发起的那次",被丢弃。
// 界面停在缓存里的旧列表,要再点一次。原因:上一轮的判定只有一个序号,谁最后发起谁算数,不分读取的种类。
//
// 现在分两种读取:
//   强制读取(?fresh=1):后端现读现建,结果是权威的。读缓存的读取抢不走它。
//   缓存读取:读后端缓存。不许盖掉比它晚发起的结果,也不许盖掉它发起之后才落地的强制读取的结果。
// 另有"作废":界面刚做了乐观更新(切换插件)或刚改完东西时调用,此前发起的读取一律不采纳。
// 界面层见 tests/acceptance/r150c-panel。
// Run: node tests/unit/check-r150-fetch-gate.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 14).join('\n      ')}`); }
};

console.log('r150c M1:工具面板读取结果的采纳判定');

let M = null;
await check('模块存在(client/src/utils/fetchGate.js)并导出 makeFetchGate', async () => {
  M = await import(root + 'client/src/utils/fetchGate.js');
  assert.equal(typeof M.makeFetchGate, 'function');
});
const gate = () => { assert.ok(M && typeof M.makeFetchGate === 'function', '模块不存在'); return M.makeFetchGate(); };

await check('M1 现场时序:挂载读 → 慢的强制读取在路上 → 第 5 秒的缓存读取先回(采纳)→ 强制读取后回:仍然采纳(界面是强制读取的结果)', async () => {
  const g = gate();
  const mount = g.begin({ fresh: false });
  assert.equal(g.accept(mount), true, '挂载时的读取');
  const refresh = g.begin({ fresh: true });       // 用户点「刷新」
  const silent = g.begin({ fresh: false });       // 第 5 秒的静默读取
  assert.equal(g.accept(silent), true, '缓存读取先回来:采纳无妨');
  assert.equal(g.accept(refresh), true, '强制读取后回来:必须采纳(原来:被丢弃)');
});
await check('强制读取落地之后,在它之前就发起、之后才回来的缓存读取:丢弃(它读到的可能是旧缓存,不许盖掉强制读取的结果)', async () => {
  const g = gate();
  const refresh = g.begin({ fresh: true });
  const silent = g.begin({ fresh: false });       // 强制读取还在路上时发起
  assert.equal(g.accept(refresh), true);
  assert.equal(g.accept(silent), false);
  const early = gate();
  const cachedFirst = early.begin({ fresh: false });
  const thenFresh = early.begin({ fresh: true });
  assert.equal(early.accept(thenFresh), true);
  assert.equal(early.accept(cachedFirst), false, '比强制读取更早发起的缓存读取,晚回来也丢弃');
});
await check('强制读取落地之后才发起的缓存读取:照常采纳', async () => {
  const g = gate();
  assert.equal(g.accept(g.begin({ fresh: true })), true);
  assert.equal(g.accept(g.begin({ fresh: false })), true);
});
await check('两次强制读取乱序回来:只采纳后发起的那次', async () => {
  const g = gate();
  const a = g.begin({ fresh: true });
  const b = g.begin({ fresh: true });
  assert.equal(g.accept(b), true);
  assert.equal(g.accept(a), false);
});
await check('两次缓存读取乱序回来:只采纳后发起的那次', async () => {
  const g = gate();
  const a = g.begin({ fresh: false });
  const b = g.begin({ fresh: false });
  assert.equal(g.accept(b), true);
  assert.equal(g.accept(a), false);
});
await check('作废(切换插件 / 刚改完东西):此前发起的读取 —— 强制的、读缓存的 —— 一律不采纳;之后发起的照常', async () => {
  const g = gate();
  const oldFresh = g.begin({ fresh: true });
  const oldCached = g.begin({ fresh: false });
  g.invalidate();
  const reread = g.begin({ fresh: true });        // 切换成功后的重读
  assert.equal(g.accept(oldCached), false);
  assert.equal(g.accept(oldFresh), false);
  assert.equal(g.accept(reread), true);
});
await check('切换后的重读在路上、静默缓存读取先回:两个都采纳,最后落地的是重读的结果(MCP 列表不缺)', async () => {
  const g = gate();
  g.invalidate();
  const reread = g.begin({ fresh: true });
  const silent = g.begin({ fresh: false });
  assert.equal(g.accept(silent), true);
  assert.equal(g.accept(reread), true);
});
await check('接线:MCPPanel 的读取经 makeFetchGate 判定;强制读取标 fresh;切换插件时作废;不再用单一序号', async () => {
  const src = readFileSync(root + 'client/src/components/MCPPanel.jsx', 'utf8');
  assert.match(src, /import \{ makeFetchGate \} from '\.\.\/utils\/fetchGate\.js'/, 'MCPPanel 没有引入 makeFetchGate');
  assert.match(src, /\.begin\(\{ fresh: force \}\)/, 'fetchData 发起时应按是否强制读取登记');
  assert.match(src, /\.accept\(/, 'fetchData 应经 accept 判定要不要采纳');
  assert.ok(!/fetchSeq/.test(src), 'MCPPanel 里还在用单一序号 fetchSeq');
  const at = src.indexOf('const handleTogglePlugin = async');
  const body = src.slice(at, src.indexOf('const handleToggle = async', at));
  assert.match(body, /\.invalidate\(\)/, '切换插件时应作废还在路上的读取');
  assert.match(body, /fetchData\(true, true\)/, '切换成功后应静默、强制地重读一次');
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
