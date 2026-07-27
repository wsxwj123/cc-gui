#!/usr/bin/env node
// 文件删除撤销窗护栏(client/src/components/FileExplorerPanel.jsx 的模块级待删表)。
// 回归对象:倒计时曾放在组件里、卸载即 flush → Esc 关面板/切面板会把「10 秒可撤销」的删除
// 当场兑现,文件永久没了(服务端 rm -r 不进废纸篓)。这里锁住:卸载不取消也不提前兑现、
// 撤销后两条触发路径都不删、beforeunload 才立即兑现、幂等不重复删。
// 做法:切出源文件的模块块【逐字执行】(非复刻),React 部分不参与。块被搬回组件内 = 切片
// 找不到标记 = 本测试红。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'client', 'src', 'components', 'FileExplorerPanel.jsx'), 'utf8');
const start = src.indexOf('// ── 待删除项');
const end = src.indexOf("window.addEventListener('beforeunload', flushPendingDeletesOnExit);") + 68;
assert.ok(start > 0 && end > start, '切片命中');
const block = src.slice(start, end);

const calls = { fetch: [], beacon: [] };
let fetchOk = true;
const stubs = {
  fetch: async (url, opt) => { calls.fetch.push([url, JSON.parse(opt.body)]); return fetchOk ? { ok: true, json: async () => ({ ok: true }) } : { ok: false, json: async () => ({ error: 'boom' }) }; },
  navigator: { sendBeacon: (url, blob) => { calls.beacon.push([url, blob.size > 0]); return true; } },
  Blob: class { constructor(parts) { this.parts = parts; this.size = parts[0].length; } },
  window: { addEventListener: () => {} },
};
const mod = await import('data:text/javascript;base64,' + Buffer.from(
  `export default async function(fetch, navigator, Blob, window){${block}\nreturn { pendingDeletes, panelSubs, firePendingDelete, undoPendingDelete, flushPendingDeletesOnExit };}`
).toString('base64'));
const M = await mod.default(stubs.fetch, stubs.navigator, stubs.Blob, stubs.window);

const schedule = (path, ms, extra = {}) => { // = 组件 deletePath 的排期部分
  const item = { name: path, parentPath: '/p', isRoot: false, rootPath: '/p', deadline: Date.now() + ms, deleting: false, timer: null, ...extra };
  item.timer = setTimeout(() => M.firePendingDelete(path), ms);
  M.pendingDeletes.set(path, item);
  return item;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ① 删除 → 面板卸载(摘订阅)→ 定时器到点才真删
{
  const h = { onChange() {}, onDone() {} };
  M.panelSubs.add(h);
  schedule('/p/a.txt', 60);
  M.panelSubs.delete(h);            // 卸载:只摘订阅
  await sleep(30);
  assert.equal(calls.fetch.length, 0, '卸载不提前兑现');
  assert.ok(M.pendingDeletes.has('/p/a.txt'), '卸载不取消');
  await sleep(60);
  assert.equal(calls.fetch.length, 1, '到点才真删');
  assert.deepEqual(calls.fetch[0][1], { path: '/p/a.txt', rootPath: '/p', confirm: true });
  assert.equal(M.pendingDeletes.size, 0, '删完摘表');
}
// ② 删除 → 卸载 → 重挂载仍看得见并可撤销
{
  calls.fetch.length = 0;
  schedule('/p/b.txt', 200);
  const seen = [];
  const h = { onChange: () => seen.push([...M.pendingDeletes.keys()]), onDone() {} };
  M.panelSubs.add(h);               // 重挂载
  assert.deepEqual([...M.pendingDeletes.keys()], ['/p/b.txt'], '重挂载读得到待删项');
  M.undoPendingDelete('/p/b.txt');
  assert.equal(M.pendingDeletes.size, 0);
  assert.deepEqual(seen, [[]], '撤销通知到挂载中的实例');
  await sleep(250);
  assert.equal(calls.fetch.length, 0, '撤销后定时器不再真删');
  M.panelSubs.delete(h);
}
// ③ 删除 → 撤销 → 卸载 → 不删(beforeunload 也不发)
{
  calls.fetch.length = 0; calls.beacon.length = 0;
  schedule('/p/c.txt', 100);
  M.undoPendingDelete('/p/c.txt');
  M.flushPendingDeletesOnExit();
  await sleep(150);
  assert.equal(calls.fetch.length + calls.beacon.length, 0, '撤销过的条目两条路径都不发');
}
// ④ 退出 app:beforeunload 立即兑现(sendBeacon),且定时器不再重复发
{
  calls.fetch.length = 0; calls.beacon.length = 0;
  schedule('/p/d.txt', 60);
  M.flushPendingDeletesOnExit();
  assert.equal(calls.beacon.length, 1, 'beforeunload 立即发 beacon');
  await sleep(100);
  assert.equal(calls.fetch.length, 0, '已 flush 的条目定时器不会再删一次');
}
// ⑤ StrictMode 双挂载:订阅两次/摘一次都不动模块表
{
  calls.fetch.length = 0;
  schedule('/p/e.txt', 80);
  const h1 = { onChange() {}, onDone() {} }; const h2 = { onChange() {}, onDone() {} };
  M.panelSubs.add(h1); M.panelSubs.delete(h1); M.panelSubs.add(h2); // mount → unmount → remount
  assert.ok(M.pendingDeletes.has('/p/e.txt'), '双挂载不清模块态,也不提前删');
  assert.equal(calls.fetch.length, 0);
  await sleep(120);
  assert.equal(calls.fetch.length, 1, '仍按原定时刻删一次(不重复)');
  M.panelSubs.delete(h2);
}
// 幂等:deleting 中再触发不重复发请求
{
  calls.fetch.length = 0;
  schedule('/p/f.txt', 10_000);
  const p = M.firePendingDelete('/p/f.txt');
  M.firePendingDelete('/p/f.txt');
  await p;
  assert.equal(calls.fetch.length, 1, 'deleting 中重入不二次删');
}
// 失败路径:条目照样摘表(不卡在删除中)
{
  fetchOk = false; calls.fetch.length = 0;
  schedule('/p/g.txt', 10_000);
  try { await M.firePendingDelete('/p/g.txt'); } catch {}
  assert.equal(M.pendingDeletes.size, 0, '失败也摘表');
  fetchOk = true;
}
console.log('✓ check-file-delete-window: 撤销窗五场景 + 幂等/失败路径 全过');
