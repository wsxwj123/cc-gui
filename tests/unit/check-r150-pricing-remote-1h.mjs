#!/usr/bin/env node
// 单测:r150 P1 的配套 —— Claude 模型命中远程价格表之后,1 小时档的缓存写仍然算得出来。
//
// 为什么要有这一条:远程价格表(官方兼容视图 prices)每个模型只有四个数(输入 / 输出 / 缓存读 / 缓存写),
// 没有 1 小时档的缓存写价。P1 之前 Claude 模型从来命中不了远程表,走的是内置表(内置表给 Claude 家族补了
// 1 小时档 = 输入价 × 2);P1 之后它们命中远程表,若不补这一档,凡是带 1 小时档缓存写的调用都会变成
// 「写费未知」、金额只剩其余几项 —— 比修之前还差。
// 口径与内置表同一条(pricing.js:Claude 家族 1h 写价 = input × 2);本机 CLI 2.1.296 自带价目表里
// opus 5.5 的 1h 写价 = 8(= 4 × 2)、sonnet 5.5 = 4(= 2 × 2),与这条规则一致。
// 只管 Claude 家族;别的厂商的条目不补(它们没有这条规则)。
// 返工(R2)之后:内置表里有的 Claude 模型不再走远程表,这条规则只对"内置表没有、远程表有"的 Claude 模型生效,
// 所以下面用内置表里没有的型号(claude-opus-5-9 / claude-sonnet-5-9)来测。
// Run: node tests/unit/check-r150-pricing-remote-1h.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 14).join('\n      ')}`); }
};

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { setPricingCatalog } = await import(root + 'client/src/utils/pricingCatalog.js');
const { computeCost, resolvePrice } = await import(root + 'client/src/utils/pricing.js');

const provider = { providerHint: 'anthropic', model: null, hasAuthKey: true };
const M = 1e6;
const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg}:实得 ${a},应为 ${b}`);
setPricingCatalog({
  source: 'official-sources', quotes: [], providers: [], refresh: null,
  prices: {
    'anthropic/claude-opus-5.9': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    'anthropic/claude-sonnet-5.9': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
  },
});

console.log('r150 P1 配套:命中远程表的 Claude 模型,1 小时档缓存写');

await check('命中远程表的 Claude 模型(内置表没有的型号):1 小时档缓存写按 输入价 × 2 算(8 / 4),不是「写费未知」', async () => {
  for (const [model, input] of [['claude-opus-5-9', 4], ['claude-sonnet-5-9', 2]]) {
    const price = resolvePrice(model, { provider });
    assert.equal(price.tier, 'official-compat', `${model} 应命中远程表`);
    near(price.prices.cacheWrite1h, input * 2, `${model} 的 1 小时档缓存写价`);
    const cost = computeCost(model, {
      input_tokens: 1000, cache_creation_input_tokens: 3 * M,
      cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: 2 * M },
    }, provider);
    assert.ok(cost, `${model}:computeCost 返回了 null`);
    assert.equal(cost.unknownDimensions, undefined, `${model}:不应有未知维度(实得 ${JSON.stringify(cost.unknownDimensions)})`);
    near(cost.breakdown.cacheWrite1h, 2 * input * 2, `${model} 1 小时档小计(200 万 token)`);
    near(cost.breakdown.cacheWrite5m, input * 1.25, `${model} 5 分钟档小计(100 万 token)`);
  }
});
await check('命中远程表的 Claude 模型:只有顶层写量、没有两档分配 → 写费未知(两档价不同,不拿任一档去猜;与内置表、官方报价层同口径)', async () => {
  const cost = computeCost('claude-opus-5-9', { input_tokens: M, cache_creation_input_tokens: M }, provider);
  assert.ok(cost);
  assert.equal(cost.tier, 'official-compat');
  near(cost.breakdown.cacheWrite, 0, '写费应被摘出去');
  assert.ok(cost.unknownDimensions?.includes('cacheWrite'), '应点名 cacheWrite 未知');
  near(cost.totalUsd, 4, '总额只含输入那一项');
});
await check('对照:别的厂商的远程表条目不补 1 小时档(gpt-5.6-terra 仍然只有单档写价)', async () => {
  const price = resolvePrice('gpt-5.6-terra', { provider });
  assert.equal(price.tier, 'official-compat');
  assert.equal(price.prices.cacheWrite1h, null);
  const cost = computeCost('gpt-5.6-terra', { input_tokens: M, cache_creation_input_tokens: M }, provider);
  near(cost.breakdown.cacheWrite, 2, '单档写价照旧按 5 分钟档那个数算');
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
