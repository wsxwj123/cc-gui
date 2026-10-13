#!/usr/bin/env node
// 单测:r148b A 组返工(判官对 r148 的复核意见)。每条一个小节,随各自的提交逐条加进来。
//
// A1 / A3 / A4 是"某处该有的一行有没有"——界面外数不出量,钉源码;A2 的行为(在飞请求超时)
// 在 check-r148b-poller-timeout.mjs 里真跑。
// Run: node tests/unit/check-r148b-rework.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
};

console.log('r148b A 组返工');

// ── A1 ────────────────────────────────────────────────────
// 用量面板在渲染时算金额(aggregateCost),查价数据是异步到达的;不订阅价格版本,价格晚到后金额不更新。
await check('A1 用量面板订阅了价格版本,且订阅在提前 return(if (loading))之前', async () => {
  const src = read('client/src/components/UsagePanel.jsx');
  const start = src.indexOf('export function UsagePanel()');
  assert.ok(start > 0, '找不到 UsagePanel 组件');
  const body = src.slice(start);
  const sub = body.search(/^\s*usePricingVersion\(\);/m);
  const early = body.search(/^\s*if \(loading\)/m);
  assert.ok(sub > 0, '组件函数体里没有 usePricingVersion();');
  assert.ok(early > 0, '找不到 if (loading) 提前 return');
  assert.ok(sub < early, 'usePricingVersion() 必须在 if (loading) 之前(之后加 hook 会在加载态切换时崩)');
  assert.match(src, /import \{ usePricingVersion \} from '\.\.\/hooks\/usePricingVersion\.js';/);
});

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
