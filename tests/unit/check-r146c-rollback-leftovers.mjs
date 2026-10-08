#!/usr/bin/env node
// 单测:r146c(R3 第二轮返工)两处纯逻辑 / 结构锁。
//   ① 草稿合并 mergeDraftText(client/src/utils/sessionNotice.js):判"已在输入框里"只认整串相等或结尾那段
//      相等;中间碰巧包含同样的字不算(原来用 includes,很短的"继续"就会被误判成已在、什么都不留)。
//   ② 「No conversation found」支路:窗格已不是发起会话时,这条提问不能静默丢 —— 记成首页「未发出的
//      消息」(源码锚:界面上造不出"错误到达时窗格已换走"的时序,理由同 check-r146b-sibling-guards)。
// Run: node tests/unit/check-r146c-rollback-leftovers.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n')[0]}`); }
};

console.log('r146c 回退中途切走的留回与同族支路');
let mod = null;
await check('草稿合并函数存在(utils/sessionNotice.js 导出 mergeDraftText)', async () => {
  mod = await import(root + 'client/src/utils/sessionNotice.js');
  assert.equal(typeof mod.mergeDraftText, 'function');
});
await check('空草稿 → 直接放回', () => {
  assert.ok(mod, '函数不存在');
  assert.deepEqual(mod.mergeDraftText('', '要重发的内容'), { next: '要重发的内容', outcome: 'placed' });
});
await check('草稿中间碰巧含同样的字 → 照样追加在后面(不算已在)', () => {
  assert.ok(mod, '函数不存在');
  assert.deepEqual(mod.mergeDraftText('先看一下再继续往下写', '继续'), { next: '先看一下再继续往下写\n\n继续', outcome: 'appended' });
});
await check('整串相等或结尾那段相等 → 已在,不重复', () => {
  assert.ok(mod, '函数不存在');
  assert.equal(mod.mergeDraftText('继续', '继续').outcome, 'same');
  assert.deepEqual(mod.mergeDraftText('草稿\n\n继续', '继续'), { next: '草稿\n\n继续', outcome: 'same' });
});
await check('没有要留的内容 → 草稿原样', () => {
  assert.ok(mod, '函数不存在');
  assert.deepEqual(mod.mergeDraftText('草稿', ''), { next: '草稿', outcome: 'none' });
});

const app = readFileSync(root + 'client/src/App.jsx', 'utf8');
await check('「No conversation found」:窗格已换走时把提问记成首页「未发出的消息」,不静默丢', () => {
  const start = app.indexOf("if (/No conversation found/i.test(msg) && !opts.freshRetry && prompt) {");
  assert.ok(start > 0, '找不到支路');
  const seg = app.slice(start, start + 3000);
  const elseAt = seg.search(/\}\s*else if \([^)]*prompt[^)]*\)\s*\{/);
  assert.ok(elseAt > 0, '窗格已换走那一侧没有任何处置(只有"仍在本会话"的分支)');
  const tail = seg.slice(elseAt, elseAt + 900);
  assert.match(tail, /addOrphanDraftMessage\(/, '窗格已换走时没有把这条提问留下');
});

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
