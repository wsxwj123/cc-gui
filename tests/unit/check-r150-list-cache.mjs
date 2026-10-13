#!/usr/bin/env node
// 单测:r150 E3 —— MCP / 插件列表的缓存作废之后,作废之前开始的那次构建不许把旧结果写回来
// (模块 server/utils/list-cache.js,纯机制,零依赖)。
//
// 现象(探针在临时实例上实测,步骤见 .devflow/test-red-r150.txt 末尾):
//   面板冷读一次 → 后端立刻返回,同时后台起一次完整刷新(`claude mcp list` 做健康检查,几秒到几十秒)
//   → 这时停用一个账号同步的插件(后端把缓存作废)→ 那次后台刷新跑完,把"停用之前"读到的 MCP 列表
//   写回缓存 —— 已停用插件带来的 MCP 又出现在列表里,一直到 5 分钟后缓存过期。
//   原因:作废只是把缓存清空,拦不住已经在跑的构建;而且刷新在跑时新来的刷新请求被直接丢掉。
//
// 为什么这条用例是在"用例提交"之后补的:浏览器套件里那条「E3 缓存失效」靠假 claude 进程的启动先后来
// 制造这个时序,实测分不出修前修后(两个进程谁先读到状态文件不受控)。那个目录已经只读,这里用可控的
// Promise 把同一个时序钉死。
// Run: node tests/unit/check-r150-list-cache.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 14).join('\n      ')}`); }
};
/** 一个由测试决定何时完成的构建。 */
const deferred = () => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log('r150 E3:列表缓存作废后,旧的构建不许写回');

let M = null;
await check('模块存在(server/utils/list-cache.js)并导出 makeListCache', async () => {
  M = await import(root + 'server/utils/list-cache.js');
  assert.equal(typeof M.makeListCache, 'function');
});
const need = () => assert.ok(M && typeof M.makeListCache === 'function', '模块不存在');

await check('基本:写入后读得到(带写入时刻);作废后读不到', async () => {
  need();
  let clock = 1000;
  const cache = M.makeListCache({ now: () => clock });
  assert.equal(cache.peek(), null);
  assert.equal(cache.commit(cache.begin(), { n: 1 }), true);
  assert.deepEqual(cache.peek(), { value: { n: 1 }, at: 1000 });
  clock = 2000;
  cache.invalidate();
  assert.equal(cache.peek(), null);
});
await check('作废之前开始的构建:结果不写进缓存(commit 返回 false)', async () => {
  need();
  const cache = M.makeListCache();
  const token = cache.begin();        // 构建开始
  cache.invalidate();                 // 构建途中有人改了插件 / MCP
  assert.equal(cache.commit(token, { stale: true }), false);
  assert.equal(cache.peek(), null, '旧结果不许进缓存');
  assert.equal(cache.commit(cache.begin(), { fresh: true }), true, '作废之后开始的构建照常写入');
});
await check('现场时序:慢刷新在跑 → 作废 → 冷读写入新结果并再要求刷新 → 慢刷新跑完:旧结果不许盖掉新的,并且自动再刷新一次', async () => {
  need();
  const cache = M.makeListCache();
  const slow = deferred();
  const second = deferred();
  const builds = [];
  const build = () => { builds.push(builds.length + 1); return builds.length === 1 ? slow.promise : second.promise; };
  cache.commit(cache.begin(), { step: '冷读-1(快路径)' });
  cache.refresh(build);                                   // 后台完整刷新开始(读到的是停用之前的状态)
  await tick();
  assert.equal(builds.length, 1);
  cache.invalidate();                                     // 停用插件
  cache.commit(cache.begin(), { step: '冷读-2(快路径,已是停用后的状态)' });
  cache.refresh(build);                                   // 冷读之后照例要求后台刷新 —— 这时上一次还在跑
  await tick();
  assert.equal(builds.length, 1, '同一时刻只跑一次构建');
  slow.resolve({ step: '旧的完整结果(含已停用插件的 MCP)' });
  await tick(); await tick();
  assert.notDeepEqual(cache.peek()?.value, { step: '旧的完整结果(含已停用插件的 MCP)' }, '旧结果盖掉了新状态');
  assert.equal(builds.length, 2, '旧结果作废了,而且有人在等刷新:应自动再跑一次');
  second.resolve({ step: '新的完整结果' });
  await tick(); await tick();
  assert.deepEqual(cache.peek()?.value, { step: '新的完整结果' });
  assert.equal(cache.isRefreshing(), false);
});
await check('刷新在跑、期间没有作废:再来的刷新请求不重跑(结果仍然有效),跑完写入', async () => {
  need();
  const cache = M.makeListCache();
  const d = deferred();
  let runs = 0;
  const build = () => { runs += 1; return d.promise; };
  cache.refresh(build);
  cache.refresh(build);
  cache.refresh(build);
  await tick();
  d.resolve({ ok: 1 });
  await tick(); await tick();
  assert.equal(runs, 1);
  assert.deepEqual(cache.peek()?.value, { ok: 1 });
});
await check('刷新途中作废、之后没人再要求刷新:旧结果丢弃,不自己重跑(下次读取时再建)', async () => {
  need();
  const cache = M.makeListCache();
  const d = deferred();
  let runs = 0;
  cache.refresh(() => { runs += 1; return d.promise; });
  await tick();
  cache.invalidate();
  d.resolve({ stale: true });
  await tick(); await tick();
  assert.equal(cache.peek(), null);
  assert.equal(runs, 1);
  assert.equal(cache.isRefreshing(), false);
});
await check('构建抛错:不往外抛、缓存不变,之后还能再刷新', async () => {
  need();
  const cache = M.makeListCache();
  cache.commit(cache.begin(), { keep: true });
  cache.refresh(() => Promise.reject(new Error('claude mcp list 超时')));
  await tick(); await tick();
  assert.deepEqual(cache.peek()?.value, { keep: true });
  assert.equal(cache.isRefreshing(), false);
  cache.refresh(async () => ({ next: true }));
  await tick(); await tick();
  assert.deepEqual(cache.peek()?.value, { next: true });
});
await check('接线:server/routes/mcp.js 的列表缓存走这个模块(作废 / 后台刷新 / 冷读写入都经它),不再有裸的 mcpCache 赋值', async () => {
  const src = readFileSync(root + 'server/routes/mcp.js', 'utf8');
  assert.match(src, /import \{[^}]*makeListCache[^}]*\} from '\.\.\/utils\/list-cache\.js'/, 'mcp.js 没有引入 makeListCache');
  assert.ok(!/\bmcpCache\s*=[^=]/.test(src), 'mcp.js 里还有裸的 mcpCache = … 赋值(拦不住作废之前开始的构建)');
  assert.match(src, /\.commit\(/, '冷读 / 强制刷新的结果应经 commit 写入');
});
await check('接线:面板切换插件成功后重读一次列表(MCP 列表随之更新);读取结果要不要采纳的判定见 check-r150-fetch-gate.mjs', async () => {
  const src = readFileSync(root + 'client/src/components/MCPPanel.jsx', 'utf8');
  const at = src.indexOf('const handleTogglePlugin = async');
  const body = src.slice(at, src.indexOf('const handleToggle = async', at));
  assert.match(body, /fetchData\(true, true\)/, '切换成功后应静默、强制地重读一次(fetchData(true, true))');
});
await check('S7 接线:停用 / 启用命令失败时也作废列表缓存(命令可能其实已经生效)', async () => {
  const src = readFileSync(root + 'server/routes/mcp.js', 'utf8');
  for (const action of ['enable', 'disable']) {
    const at = src.indexOf(`router.put('/plugins/:name/${action}'`);
    const body = src.slice(at, src.indexOf('});', src.indexOf('sendPluginPublicError', at)));
    assert.match(body, /catch \(err\) \{[\s\S]*invalidateMcpListCache\(\)[\s\S]*sendPluginPublicError/, `${action}:失败分支里没有作废列表缓存`);
  }
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
