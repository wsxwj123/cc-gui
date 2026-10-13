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

// ── A3 ────────────────────────────────────────────────────
// 上下文明细弹窗里的「刚刚 / N 分钟前」按当前时间算,原来靠会话组件每 1.5 秒重渲染顺带更新。
await check('A3 上下文明细弹窗:打开期间每 30 秒自己刷新一次相对时间,关着时不起定时器', async () => {
  const app = read('client/src/App.jsx');
  const start = app.indexOf('function ContextBreakdownButton(');
  assert.ok(start > 0, '找不到 ContextBreakdownButton');
  const end = app.indexOf('\nfunction ', start + 10);
  const body = app.slice(start, end > 0 ? end : start + 20000);
  assert.match(body, /relativeAgeLabel\(data\.sampledAt\)/, '弹窗里应仍用 relativeAgeLabel 显示采样时间');
  const m = body.match(/useEffect\(\(\) => \{\s*if \(!open\) return undefined;\s*const id = setInterval\(\(\) => (\w+)\(\(n\) => n \+ 1\), 30_000\);\s*return \(\) => clearInterval\(id\);\s*\}, \[open\]\);/);
  assert.ok(m, '没有找到"弹窗打开时起 30 秒定时器、关闭时清掉"的 effect');
  assert.match(body, new RegExp(`const \\[, ${m[1]}\\] = useState\\(0\\);`), '定时器推动的应是本组件自己的一个状态(触发重渲染)');
  // 定时器只在 open 为真时起:effect 第一句就是 if (!open) return(上面的正则已钉),依赖只有 open
});

// ── A4 ────────────────────────────────────────────────────
// 兜底价格表(REMOTE)在模块加载 3 秒后才载入;它也是查价的输入,换了新的要通知价格版本。
await check('A4 兜底价格表载入成功后通知价格版本(bumpPricingVersion 在赋值之后、同一个成功分支里)', async () => {
  const src = read('client/src/utils/pricing.js');
  const start = src.indexOf('async function hydrateRemotePrices()');
  assert.ok(start > 0, '找不到 hydrateRemotePrices');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  // 成功分支 = `if (j && j.prices && Object.keys(j.prices).length) { … }` 这一块(按花括号配对取出来)
  const ifAt = body.indexOf('if (j && j.prices && Object.keys(j.prices).length) {');
  assert.ok(ifAt > 0, '找不到"取到了非空价格表"的那个判断');
  let depth = 0; let blockEnd = -1;
  for (let i = body.indexOf('{', ifAt); i < body.length; i += 1) {
    if (body[i] === '{') depth += 1;
    else if (body[i] === '}') { depth -= 1; if (depth === 0) { blockEnd = i; break; } }
  }
  const block = body.slice(ifAt, blockEnd);
  const assign = block.indexOf('REMOTE = j.prices;');
  const bump = block.indexOf('bumpPricingVersion();');
  assert.ok(assign > 0, '成功分支里找不到 REMOTE = j.prices;');
  assert.ok(bump > assign, '载入成功后(赋值之后、同一个成功分支里)没有调 bumpPricingVersion() —— 失败 / 空表时不该通知');
  assert.equal(body.split('bumpPricingVersion();').length - 1, 1, '只该在成功分支里通知一次');
  assert.match(src, /import \{[^}]*\bbumpPricingVersion\b[^}]*\} from '\.\/pricingCatalog\.js';/);
});

if (failed) { console.log(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
