// computeCost 白盒单测:Ttl 分档 / 长上下文档 / 时段 / unknownDimensions / 幂等。
// Run: node tests/unit/check-pricing-cost.mjs   —— 固定夹具喂 catalog,不联网。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = JSON.parse(readFileSync(join(root, 'tests/unit/fixtures/pricing-catalog-fixture.json'), 'utf8'));

const { setPricingCatalog } = await import('../../client/src/utils/pricingCatalog.js');
const { computeCost, resolvePrice, aggregateCost } = await import('../../client/src/utils/pricing.js');

const AT_PEAK = '2026-09-11T02:00:00.000Z';
const AT_OFF = '2026-09-12T02:00:00.000Z';
const M = 1e6;
const usd = (tokens, price) => (tokens * price) / M;
const provider = { providerHint: 'anthropic', model: null, hasAuthKey: true };
const quote = (over = {}) => ({
  quoteId: 'q', provider: 'pa', presetIds: ['pa'], modelId: 'pa-model', displayName: 'PA', protocol: null,
  market: 'global', currency: 'USD', unit: 'per 1M tokens',
  prices: { input: 1, output: 1, cacheRead: 0.1, cacheWrite5m: 1, cacheWrite1h: null },
  conditions: null, validFrom: null, validTo: null, sourceUrl: null, sourceKind: 'official',
  fetchedAt: null, parserVersion: 'pr6-1', status: 'fresh', ...over,
});
const useQuotes = (...quotes) => setPricingCatalog({ source: 'official-sources', prices: {}, quotes, providers: [], refresh: null });

// ── 1. 缓存写 TTL 两档(顶层量与分项不得相加)─────────────────────────────
const OPUS = quote({
  quoteId: 'pa-opus', modelId: 'claude-opus-5',
  prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
});
useQuotes(OPUS);
const ttl = computeCost('claude-opus-5', {
  cache_creation_input_tokens: 2000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
}, provider, { at: AT_PEAK });
assert.ok(Math.abs(ttl.breakdown.cacheWrite - (usd(1000, 6.25) + usd(1000, 10))) < 1e-12, '两档各算后相加');
assert.ok(Math.abs(ttl.breakdown.cacheWrite5m - usd(1000, 6.25)) < 1e-12);
assert.ok(Math.abs(ttl.breakdown.cacheWrite1h - usd(1000, 10)) < 1e-12);
assert.ok(Math.abs(ttl.breakdown.cacheWrite - usd(2000, 6.25)) > 1e-9, '负例:顶层 2000 不得按 5m 单档算');
assert.ok(Math.abs(ttl.breakdown.cacheWrite - usd(2000, 10)) > 1e-9, '负例:顶层 2000 不得按 1h 单档算');
assert.equal(ttl.partial, undefined);

// 只有顶层写量、无分配、两档价不同 → 写费未知(其余维度照算)
const noTtl = computeCost('claude-opus-5', { input_tokens: 1000, cache_creation_input_tokens: 2000 }, provider, { at: AT_PEAK });
assert.ok(Math.abs(noTtl.breakdown.cacheWrite) < 1e-12, '写费必须被摘出去');
assert.ok(noTtl.unknownDimensions.includes('cacheWrite'));
assert.equal(noTtl.partial, true);
assert.equal(noTtl.writeUnknown, true, '展示层按这个键说「写费未知（缺 TTL 分配）」');
// 无 TTL 分配时两档小计必须是 null(渲染判空的依据)
const noWrite = computeCost('claude-opus-5', { input_tokens: 10, output_tokens: 5 }, provider, { at: AT_PEAK });
assert.equal(noWrite.breakdown.cacheWrite5m, null);
assert.equal(noWrite.breakdown.cacheWrite1h, null);
// 数据自相矛盾:分项之和 ≠ 顶层 → 写费未知
const inconsistent = computeCost('claude-opus-5', {
  cache_creation_input_tokens: 500,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
}, provider, { at: AT_PEAK });
assert.ok(inconsistent.unknownDimensions.includes('cacheWrite'));
assert.equal(inconsistent.partial, true);
assert.ok(Math.abs(inconsistent.breakdown.cacheWrite) < 1e-12);
// 只有 5m 价(OpenAI/内置表口径)→ 单档价照算,不算未知
useQuotes(quote({ quoteId: 'pa-5m', modelId: 'pa-model', prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: null } }));
const single = computeCost('pa-model', { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100 } }, provider, { at: AT_PEAK });
assert.ok(Math.abs(single.breakdown.cacheWrite - usd(100, 6.25)) < 1e-12);
assert.ok(!(single.unknownDimensions || []).includes('cacheWrite'));
// 反向:只有 1h 价而用量是 5m 量 → 写费未知(不得拿 1h 价当 5m 价)
useQuotes(quote({ quoteId: 'pa-1h', modelId: 'pa-model', prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: null, cacheWrite1h: 10 } }));
const only1h = computeCost('pa-model', { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100 } }, provider, { at: AT_PEAK });
assert.ok(Math.abs(only1h.breakdown.cacheWrite - usd(100, 10)) > 1e-9);
assert.ok(only1h.unknownDimensions.includes('cacheWrite'));
// 读费按报价本身,代码里不得再乘倍率
useQuotes(OPUS);
const readOnly = computeCost('claude-opus-5', { cache_read_input_tokens: 1000 }, provider, { at: AT_PEAK });
assert.ok(Math.abs(readOnly.breakdown.cacheRead - usd(1000, 0.5)) < 1e-12);

// ── 2. 长上下文档(判据 = input_tokens 原值,严格大于)────────────────────
const SOL_SHORT = quote({ quoteId: 'pa-sol-s', modelId: 'gpt-5.6-sol', conditions: { context: 'short context' }, prices: { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: null } });
const SOL_LONG = quote({ quoteId: 'pa-sol-l', modelId: 'gpt-5.6-sol', conditions: { context: 'long context' }, prices: { input: 8, output: 30, cacheRead: 0.8, cacheWrite5m: 10, cacheWrite1h: null } });
useQuotes(SOL_SHORT, SOL_LONG);
const longCost = computeCost('gpt-5.6-sol', { input_tokens: 300000, output_tokens: 1000 }, provider, { at: AT_PEAK });
assert.ok(Math.abs(longCost.breakdown.input - usd(300000, 8)) < 1e-12, '长档输入价');
assert.ok(Math.abs(longCost.breakdown.output - usd(1000, 30)) < 1e-12, '长档下输出也按长档价');
assert.equal(longCost.appliedConditions[0].threshold, 272000);
assert.equal(longCost.appliedConditions[0].promptTokens, 300000);
assert.ok(Math.abs(computeCost('gpt-5.6-sol', { input_tokens: 272000 }, provider, { at: AT_PEAK }).breakdown.input - usd(272000, 4)) < 1e-12, '272000 整仍走短档');
assert.ok(Math.abs(computeCost('gpt-5.6-sol', { input_tokens: 272001 }, provider, { at: AT_PEAK }).breakdown.input - usd(272001, 8)) < 1e-12, '272001 进长档');
// 口径负例:缓存读不得加进判据
const cacheHeavy = computeCost('gpt-5.6-sol', { input_tokens: 100000, cache_read_input_tokens: 200000 }, provider, { at: AT_PEAK });
assert.ok(Math.abs(cacheHeavy.breakdown.input - usd(100000, 4)) < 1e-12, '判据只看 input_tokens 原值');

// ── 3. 时段:同一条 usage 的两档价差 2×,金额比 ≈2 ─────────────────────────
setPricingCatalog(fixture);
const peak = computeCost('deepseek-flash', { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000 }, provider, { at: AT_PEAK });
const off = computeCost('deepseek-flash', { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000 }, provider, { at: AT_OFF });
assert.equal(peak.currency, 'CNY', '官方报价保留原币种(数字就是人民币)');
assert.equal(peak.tier, 'official-quote');
assert.ok(Math.abs(peak.totalUsd / off.totalUsd - 2) < 1e-9, '高峰是空闲的 2 倍');
assert.ok(Math.abs(peak.breakdown.output / peak.breakdown.input - 4) < 1e-9, '四维同源:output/input = 8/2');
// 缺时间戳 → 不给金额(不回落成未分时段的数字)
assert.equal(computeCost('deepseek-flash', { input_tokens: 1000 }, provider), null);

// ── 4. 幂等 / 空与非法用量 ────────────────────────────────────────────────
const args = ['deepseek-flash', { input_tokens: 500, output_tokens: 50 }, provider, { at: AT_PEAK }];
assert.deepEqual(computeCost(...args), computeCost(...args));
assert.equal(computeCost('claude-opus-5', null, provider), null);
assert.equal(computeCost('claude-opus-5', {}, provider), null);
assert.equal(computeCost('claude-opus-5', { input_tokens: -1 }, provider), null);
assert.equal(computeCost('claude-opus-5', { input_tokens: Number.NaN }, provider), null);

// ── 5. aggregateCost:分时段行按桶各算一次(代表时点写死,不读「现在」)──────
const agg = aggregateCost('deepseek-flash', {
  input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 2,
  byPeriod: {
    peak: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
    offPeak: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
    unknown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
  },
}, provider);
assert.ok(agg.usd > 0, '分时段行必须有金额');
assert.ok(Math.abs(agg.usd - (usd(1000, 2) + usd(1000, 1))) < 1e-12, '两桶各自按自己的时段价');
assert.equal(agg.currency, 'CNY');
const aggUnknown = aggregateCost('deepseek-flash', {
  input: 100, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1,
  byPeriod: {
    peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
    offPeak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
    unknown: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
  },
}, provider);
assert.equal(aggUnknown.partial, true, '有时段未知的调用 → 标 partial');
assert.ok(aggUnknown.unknownDimensions.includes('period'));
// 非分时段模型:不带 byPeriod 时行为与旧版逐字一致
setPricingCatalog({ source: 'x', prices: {}, quotes: [], providers: [], refresh: null });
const plain = aggregateCost('claude-opus-5', { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 }, provider);
assert.ok(Math.abs(plain.usd - usd(1000, 5)) < 1e-12);

setPricingCatalog(null);
console.log('check-pricing-cost: OK');
