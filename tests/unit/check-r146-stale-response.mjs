#!/usr/bin/env node
// 单测:r146 R8(及 R7 的源码锚) —— 取数结果落地前不认"过期响应"。
//
// 现象:检查点下拉(App.jsx CheckpointButton)与文件审查面板(components/FileChangesPanel.jsx)
// 取数后直接 setState,不判断"这次响应是不是最新一次请求的"。会话一换(面板跟随活动窗格 /
// 下拉开着时会话被回滚转 draft、/clear 轮换),旧会话的慢响应后到,就把别的会话的数据画上来。
//
// 为什么 R8 只能源码级 + 逻辑层:界面上切会话必然先点到"更多"菜单之外,SessionHeaderMore 收起
// 时不挂载 children,下拉随之卸载 —— 黑盒点不进"下拉开着时会话变了"这个窗口(R7 的面板不卸载,
// 已有界面用例 tests/acceptance/r146-crosstalk 的 R7)。
//
// 双层:
//   ① 逻辑层:共用的"只认最新一次"闸门 utils/latestRequest.js 真跑(旧请求晚到必须被丢弃);
//   ② 源码锚:两处取数在 setState 之前都经过闸门。
// Run: node tests/unit/check-r146-stale-response.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};

console.log('r146 R8 取数结果不认过期响应');

// ── ① 逻辑层 ──────────────────────────────────────────────
let mod = null;
await check('共用闸门模块存在(client/src/utils/latestRequest.js 导出 createLatestGate)', async () => {
  mod = await import(root + 'client/src/utils/latestRequest.js');
  assert.equal(typeof mod.createLatestGate, 'function');
});

await check('先发的 A、后发的 B:B 先回来、A 后回来 —— 只有 B 能落地', async () => {
  assert.ok(mod, '模块不存在');
  const gate = mod.createLatestGate();
  const shown = [];
  const request = (label, ms) => {
    const isLatest = gate.begin();
    return new Promise((r) => setTimeout(r, ms)).then(() => { if (isLatest()) shown.push(label); });
  };
  await Promise.all([request('A', 40), request('B', 5)]);
  assert.deepEqual(shown, ['B'], `落地的是 ${JSON.stringify(shown)}`);
});

await check('cancel() 之后在飞的请求一律作废(组件卸载 / 会话清空时用)', async () => {
  assert.ok(mod, '模块不存在');
  const gate = mod.createLatestGate();
  const a = gate.begin();
  gate.cancel();
  assert.equal(a(), false);
  const b = gate.begin();
  assert.equal(b(), true);
});

// ── ② 源码锚 ──────────────────────────────────────────────
const app = read('client/src/App.jsx');
const fcp = read('client/src/components/FileChangesPanel.jsx');

await check('CheckpointButton:load 在 setEntries 之前判"我还是最新那次"', () => {
  const start = app.indexOf('function CheckpointButton(');
  const end = app.indexOf('const snapshot = async', start);
  assert.ok(start > 0 && end > start, '找不到 CheckpointButton 的 load 段');
  const seg = app.slice(start, end);
  assert.match(seg, /createLatestGate\(\)/, 'CheckpointButton 没接共用闸门');
  const guard = seg.search(/if\s*\(\s*!isLatest\(\)\s*\)\s*return/);
  const set = seg.indexOf('setEntries(d.entries');
  assert.ok(guard > 0 && set > guard, 'setEntries 之前没有过期判断');
});

await check('FileChangesPanel:fetchChanges 的每个 setState 落地点之前判"我还是最新那次"', () => {
  const start = fcp.indexOf('const fetchChanges = async');
  const end = fcp.indexOf('useEffect(() => { fetchChanges(); }', start);
  assert.ok(start > 0 && end > start, '找不到 fetchChanges 段');
  const seg = fcp.slice(start, end);
  assert.match(fcp, /createLatestGate\(\)/, 'FileChangesPanel 没接共用闸门');
  for (const sink of ['setChanges(Array.isArray(data)', "setLoadError(d.error || `${res.status}`)", 'setLoadError(err.message)']) {
    const at = seg.indexOf(sink);
    assert.ok(at > 0, `找不到落地点 ${sink}`);
    const before = seg.slice(0, at);
    assert.ok(/isLatest\(\)/.test(before.slice(before.lastIndexOf('await'))), `${sink} 之前(最后一个 await 之后)没有过期判断`);
  }
});

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
