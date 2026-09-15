// computeCostForMessage 白盒单测:逐调用求和、部分调用时段未知、缺时间戳分支。
// Run: node tests/unit/check-pricing-message.mjs   —— 固定夹具喂 catalog,不联网。
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { setPricingCatalog } = await import('../../client/src/utils/pricingCatalog.js');
const { computeCostForMessage, costUnavailableReason } = await import('../../client/src/utils/pricing.js');

const AT_PEAK = '2026-09-11T02:00:00.000Z';    // 周五北京 10:00
const AT_OFF = '2026-09-12T02:00:00.000Z';     // 周六北京 10:00
const M = 1e6;
const usd = (tokens, price) => (tokens * price) / M;
const provider = { providerHint: 'anthropic', model: null, hasAuthKey: true };
const quote = (over = {}) => ({
  quoteId: 'q', provider: 'pa', presetIds: ['pa'], modelId: 'deepseek-flash', displayName: 'deepseek-flash',
  protocol: null, market: 'cn', currency: 'CNY', unit: 'per 1M tokens',
  prices: { input: 1, output: 4, cacheRead: 0.02, cacheWrite5m: null, cacheWrite1h: null },
  conditions: null, validFrom: null, validTo: null, sourceUrl: null, sourceKind: 'official',
  fetchedAt: null, parserVersion: 'pr6-1', status: 'fresh', ...over,
});
setPricingCatalog({
  source: 'official-sources', prices: {}, providers: [], refresh: null,
  quotes: [
    quote({ quoteId: 'pa-off', conditions: { period: 'off-peak' }, prices: { input: 1, output: 4, cacheRead: 0.02, cacheWrite5m: null, cacheWrite1h: null } }),
    quote({ quoteId: 'pa-peak', conditions: { period: 'peak' }, prices: { input: 2, output: 8, cacheRead: 0.04, cacheWrite5m: null, cacheWrite1h: null } }),
  ],
});
const usage = (over = {}) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over });

// ① 逐调用各算一次:两项各自的高峰/空闲价相加(不是拿其中一个时刻算总量)
const two = computeCostForMessage({
  model: 'deepseek-flash',
  usage: usage({ input_tokens: 2000 }),
  usageCalls: [
    { at: AT_PEAK, usage: usage({ input_tokens: 1000 }) },
    { at: AT_OFF, usage: usage({ input_tokens: 1000 }) },
  ],
}, provider);
assert.ok(two, '逐调用必须出金额');
assert.ok(Math.abs(two.breakdown.input - (usd(1000, 2) + usd(1000, 1))) < 1e-12, '两段各按自己的时段价');
assert.equal(two.partial, undefined, '两项都算得出 → 不标 partial');
assert.equal(two.appliedConditions.filter((item) => item.period === 'peak').length, 1);
assert.equal(two.appliedConditions.filter((item) => item.period === 'off-peak').length, 1);

// ② 长度 1 且消息没有时间戳 → 用 usageCalls[0].at(不得报时段未知)
const single = computeCostForMessage({
  model: 'deepseek-flash',
  usage: usage({ input_tokens: 1000, output_tokens: 100 }),
  usageCalls: [{ at: AT_PEAK, usage: usage({ input_tokens: 1000, output_tokens: 100 }) }],
}, provider);
assert.ok(single, 'usageCalls[0].at 可用就必须有金额');
assert.ok(Math.abs(single.breakdown.input - usd(1000, 2)) < 1e-12);

// ③ 部分项 at 不可解析 → 该项走 unknown 桶:不算钱 + partial + unknownDimensions 含 'period'
const partial = computeCostForMessage({
  model: 'deepseek-flash',
  usage: usage({ input_tokens: 2000 }),
  usageCalls: [
    { at: AT_PEAK, usage: usage({ input_tokens: 1000 }) },
    { at: 'not-a-timestamp', usage: usage({ input_tokens: 1000 }) },
  ],
}, provider);
assert.equal(partial.partial, true);
assert.ok(partial.unknownDimensions.includes('period'));
assert.ok(Math.abs(partial.breakdown.input - usd(1000, 2)) < 1e-12, '只算得出那一项');
assert.ok(partial.appliedConditions.some((item) => item.period === 'unknown'));

// ④ 全部 at 不可解析 + 消息无时间戳 → 回落单次 computeCost → 无价(null)
const none = computeCostForMessage({
  model: 'deepseek-flash',
  usage: usage({ input_tokens: 1000 }),
  usageCalls: [{ at: null, usage: usage({ input_tokens: 1000 }) }],
}, provider);
assert.equal(none, null);
assert.equal(costUnavailableReason('deepseek-flash', usage({ input_tokens: 1000 }), provider, { at: undefined }).reason, 'PERIOD_UNRESOLVED');

// ⑤ 没有 usageCalls(老消息)→ 单次算,时间取 message.timestamp
const legacy = computeCostForMessage({
  model: 'deepseek-flash', timestamp: AT_PEAK, usage: usage({ input_tokens: 1000 }),
}, provider);
assert.ok(Math.abs(legacy.breakdown.input - usd(1000, 2)) < 1e-12);
assert.equal(computeCostForMessage({ model: 'deepseek-flash', usage: usage({ input_tokens: 1 }) }, provider), null, '无时间戳 → 无价');

// ⑥ 非分时段模型:即使带 usageCalls 也走单次(逐调用会把 at 缺失项误判成未知)
setPricingCatalog({
  source: 'official-sources', prices: {}, providers: [], refresh: null,
  quotes: [quote({ quoteId: 'pa-plain', modelId: 'claude-opus-5', displayName: 'Claude Opus 5', market: 'global', currency: 'USD', conditions: null, prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: null } })],
});
const plain = computeCostForMessage({
  model: 'claude-opus-5',
  usage: usage({ input_tokens: 1000 }),
  usageCalls: [{ at: null, usage: usage({ input_tokens: 1000 }) }],
}, provider);
assert.ok(plain, '非分时段模型不该因为 at 缺失就没金额');
assert.ok(Math.abs(plain.breakdown.input - usd(1000, 5)) < 1e-12);
assert.equal(plain.partial, undefined);

// ⑦ 畸形输入不抛
for (const value of [null, undefined, 'x', 42]) {
  assert.doesNotThrow(() => computeCostForMessage(value, provider), `computeCostForMessage(${String(value)}) 不得抛`);
}
assert.equal(computeCostForMessage(null, provider), null);

setPricingCatalog(null);
console.log('check-pricing-message: OK');
