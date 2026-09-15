// PA-3xx：价源层级、命中口径（精确/疑似）、已下架标注、失败原因闭集（契约 §5.1 / §5.1.1 / §5.2 / §4.4 / §5.3）。
import { test, expect } from '@playwright/test';
import {
  clientPricing, clientPricingExtra, pricingPayload, quote, useCatalog, useLiveCatalog, getRuntime,
  useEmptyCatalog, pricingRules, usage, roughProvider, withFetchDisabled, PRICE_REASONS,
  COST_UNAVAILABLE_REASONS, EnvironmentBlocked, usd, DETAIL,
} from './helpers/pa-runtime.mjs';

const AT_PEAK = '2026-09-11T02:00:00.000Z'; // 周五北京 10:00

/** 用运行实例自己的 catalog（并断言它里面确有本用例要找的报价，否则报环境不成立）。 */
async function liveCatalogWith(baseURL, predicate, hint) {
  const pricing = await (await fetch(`${baseURL}/api/pricing`)).json();
  const { normalizeOfficialName } = await pricingRules();
  if (!predicate(pricing, normalizeOfficialName)) throw new EnvironmentBlocked(hint);
  await useLiveCatalog(baseURL);
  return pricing;
}

/** §10.11③ 的官方层比较键：归一化显示名 + ASCII 小写（测试侧照抄契约口径，不 import 实现）。 */
const officialKey = (normalize, value) => normalize(value || '').toLowerCase();

function deepseekPeriodQuotes() {
  // §10.11③：displayName 是可命中的候选（DeepSeek 的时段报价 modelId 为 null），比较键大小写不敏感。
  return (payload, normalize) => (payload.quotes || []).filter(
    item => officialKey(normalize, item?.displayName) === 'deepseek-flash'
      && typeof item?.conditions?.period === 'string',
  ).length >= 2;
}

// ---------------------------------------------------------------------------
// 层级与命中
// ---------------------------------------------------------------------------

test('PA-301 层级：同一 model 同时有官方报价与 compat prices → 取 official-quote', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-layer-official', modelId: 'pa-layer-model',
      prices: { input: 7, output: 9, cacheRead: 0.7, cacheWrite5m: null, cacheWrite1h: null },
    })],
    prices: { 'pa-layer-model': { input: 100, output: 200, cacheRead: 10, cacheWrite: 10 } },
  }));
  const result = await resolvePrice('pa-layer-model', { at: AT_PEAK });
  expect(result.ok).toBe(true);
  expect(result.tier).toBe('official-quote');
  expect(result.prices.input, '必须取官方那一条').toBe(7);
  expect(result.matchedExactly, '§10.11③ 规则 1：modelId 逐字相等属精确命中').toBe(true);
});

test('PA-302 层级：官方层没有该模型 → 落到 official-compat（compat prices）', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [],
    prices: { 'pa-layer-model': { input: 100, output: 200, cacheRead: 10, cacheWrite: 10 } },
  }));
  const result = await resolvePrice('pa-layer-model', { at: AT_PEAK });
  expect(result.ok).toBe(true);
  expect(result.tier).toBe('official-compat');
  expect(result.prices.input).toBe(100);
  expect(result.matchedExactly, '§5.1 第 3 层：compat 的键与 model 逐字相等 → 精确命中').toBe(true);
});

test('PA-303 层级：catalog 遮空 → offline 内置表照常出价，且不抛异常', async () => {
  const { resolvePrice } = await clientPricing();
  await useEmptyCatalog();
  const result = await resolvePrice('claude-opus-5', { at: AT_PEAK });
  expect(result.ok, '内置表是最后一层，必须仍有价').toBe(true);
  expect(result.tier).toBe('offline');
  expect(result.prices.input).toBeGreaterThan(0);
});

test('PA-304 deepseek-flash：高峰（周五北京 10:00）→ 官方 CNY 2/8/0.04，命中属精确', async () => {
  const { baseURL } = getRuntime();
  await liveCatalogWith(baseURL, deepseekPeriodQuotes(), '隔离实例的 catalog 里没有 deepseek-flash 的时段报价');
  const { resolvePrice } = await clientPricing();
  const result = await resolvePrice('deepseek-flash', { at: AT_PEAK });
  expect(result.ok).toBe(true);
  expect(result.tier).toBe('official-quote');
  expect(result.currency).toBe('CNY');
  expect(result.prices.input).toBe(2);
  expect(result.prices.output).toBe(8);
  expect(result.prices.cacheRead).toBe(0.04);
  expect(result.matchedExactly).toBe(true);
});

test('PA-305 deepseek-flash：空闲（周六北京 10:00）→ 官方 CNY 1/4/0.02', async () => {
  const { baseURL } = getRuntime();
  await liveCatalogWith(baseURL, deepseekPeriodQuotes(), '隔离实例的 catalog 里没有 deepseek-flash 的时段报价');
  const { resolvePrice } = await clientPricing();
  const result = await resolvePrice('deepseek-flash', { at: '2026-09-12T02:00:00.000Z' });
  expect(result.ok).toBe(true);
  expect(result.currency).toBe('CNY');
  expect(result.prices.input).toBe(1);
  expect(result.prices.output).toBe(4);
  expect(result.prices.cacheRead).toBe(0.02);
});

test('PA-306 时段未定就不出价：deepseek-flash 不传 at → resolvePrice 失败 PERIOD_UNRESOLVED', async () => {
  const { baseURL } = getRuntime();
  await liveCatalogWith(baseURL, deepseekPeriodQuotes(), '隔离实例的 catalog 里没有 deepseek-flash 的时段报价');
  const { resolvePrice } = await clientPricing();
  const result = await resolvePrice('deepseek-flash', {});
  expect(result.ok, '不得回落成一个未分时段的数字').toBe(false);
  expect(result.reason).toBe('PERIOD_UNRESOLVED');
  expect(PRICE_REASONS).toContain(result.reason);
});

test('PA-307 时段未定就不出价：computeCost 同样返回 null，且原因可解释', async () => {
  const { baseURL } = getRuntime();
  await liveCatalogWith(baseURL, deepseekPeriodQuotes(), '隔离实例的 catalog 里没有 deepseek-flash 的时段报价');
  const { computeCost, costUnavailableReason } = await clientPricing();
  const cost = await computeCost('deepseek-flash', usage({ input: 1000, output: 10 }), roughProvider());
  expect(cost, '缺时间戳不得给出金额').toBeNull();
  const reason = await costUnavailableReason('deepseek-flash', usage({ input: 1000, output: 10 }), roughProvider());
  expect(reason?.reason).toBe('PERIOD_UNRESOLVED');
});

test('PA-308 反向：at 早于峰谷价生效日（2026-08-17 +08:00）→ 不得套用峰谷价', async () => {
  const { baseURL } = getRuntime();
  await liveCatalogWith(baseURL, deepseekPeriodQuotes(), '隔离实例的 catalog 里没有 deepseek-flash 的时段报价');
  const { resolvePrice } = await clientPricing();
  const result = await resolvePrice('deepseek-flash', { at: '2026-08-01T02:00:00.000Z' });
  if (result.ok) {
    const periodApplied = (result.appliedConditions || []).some(item => item?.period);
    expect(periodApplied, '生效日之前的调用不得带时段条件').toBe(false);
    expect([1, 2], '不得取到峰谷价的两个 CNY 输入价之一').not.toContain(result.prices.input);
  } else {
    expect(['PERIOD_NOT_EFFECTIVE', 'NO_PRICE']).toContain(result.reason);
  }
});

test('PA-309 glm-5.3-flash：精确行 CNY 0.8/2.8/0.23，且不等于 glm-5 旧高价档', async () => {
  const { baseURL } = getRuntime();
  await useLiveCatalog(baseURL);
  const { resolvePrice } = await clientPricing();
  const result = await resolvePrice('glm-5.3-flash', { at: AT_PEAK });
  expect(result.ok, 'glm-5.3-flash 必须有价').toBe(true);
  expect(result.matchedExactly, '精确行命中不许标「疑似」').toBe(true);
  expect(result.prices.input).toBe(0.8);
  expect(result.prices.output).toBe(2.8);
  expect(result.prices.cacheRead).toBe(0.23);
  expect(result.prices.output, '不得落到 glm-5 的 22').not.toBe(22);
  expect(result.prices.cacheRead, '不得落到 glm-5 的 1.5').not.toBe(1.5);
});

test('PA-310 matchedExactly 反例：只能靠最长前缀命中的 id → false 且 tier = offline', async () => {
  const { baseURL } = getRuntime();
  await useLiveCatalog(baseURL);
  const { resolvePrice } = await clientPricing();
  const result = await resolvePrice('step-3.7-flash-9999', { at: AT_PEAK });
  expect(result.ok).toBe(true);
  expect(result.tier).toBe('offline');
  expect(result.matchedExactly, '前缀命中必须标「疑似」').toBe(false);
});

test('PA-311 claude-fable-5-1：别名/官方价命中 → cacheRead 0.25（0.025×），不是 1', async () => {
  const { baseURL } = getRuntime();
  await useLiveCatalog(baseURL);
  const { resolvePrice } = await clientPricing();
  const result = await resolvePrice('claude-fable-5-1', { at: AT_PEAK });
  expect(result.ok).toBe(true);
  expect(result.prices.cacheRead).toBe(0.25);
  expect(result.matchedExactly, '别名表命中属精确').toBe(true);
});

test('PA-312 claude-fable-5：命中价 cacheRead = 1', async () => {
  const { baseURL } = getRuntime();
  await useLiveCatalog(baseURL);
  const { resolvePrice } = await clientPricing();
  const result = await resolvePrice('claude-fable-5', { at: AT_PEAK });
  expect(result.ok).toBe(true);
  expect(result.prices.cacheRead).toBe(1);
});

test('PA-313 已下架标注：deepseek-v4-flash 精确命中 retired 行，note 说明下架', async () => {
  const { baseURL } = getRuntime();
  await useLiveCatalog(baseURL);
  const { resolvePrice } = await clientPricing();
  const result = await resolvePrice('deepseek-v4-flash', { at: AT_PEAK });
  expect(result.ok).toBe(true);
  expect(result.tier).toBe('offline');
  expect(result.retired).toBe(true);
  expect(result.matchedExactly).toBe(true);
  expect(typeof result.note === 'string' && result.note.includes('下架'), 'note 必须写明已下架').toBe(true);
});

test('PA-314 已下架标注：deepseek-v4-flash-vision-exp 同样精确命中（不靠前缀）', async () => {
  const { baseURL } = getRuntime();
  await useLiveCatalog(baseURL);
  const { resolvePrice } = await clientPricing();
  const result = await resolvePrice('deepseek-v4-flash-vision-exp', { at: AT_PEAK });
  expect(result.ok).toBe(true);
  expect(result.retired).toBe(true);
  expect(result.matchedExactly).toBe(true);
  expect(result.note).toContain('下架');
});

test('PA-315 命名空间不同价：openai/gpt-oss-120b 与 gpt-oss-120b 各自精确取值，不得互相覆盖', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [
      quote({
        quoteId: 'pa-oss-ns', modelId: 'openai/gpt-oss-120b',
        prices: { input: 0.15, output: 0.6, cacheRead: 0.02, cacheWrite5m: null, cacheWrite1h: null },
      }),
      quote({
        quoteId: 'pa-oss-bare', modelId: 'gpt-oss-120b',
        prices: { input: 0.35, output: 1.4, cacheRead: 0.05, cacheWrite5m: null, cacheWrite1h: null },
      }),
    ],
  }));
  const withNs = await resolvePrice('openai/gpt-oss-120b', { at: AT_PEAK });
  const bare = await resolvePrice('gpt-oss-120b', { at: AT_PEAK });
  expect(withNs.prices.input).toBe(0.15);
  expect(bare.prices.input).toBe(0.35);
  expect(withNs.prices.input, '两个 id 必须给出不同结果').not.toBe(bare.prices.input);
  // §10.11③：官方 modelId 原文自带 vendor/ 时「照字面比」也算精确命中，不属于「剥命名空间」那条回退路径。
  expect(withNs.tier, '带 vendor/ 的 modelId 原文逐字相等 → 官方层命中').toBe('official-quote');
  expect(withNs.matchedExactly).toBe(true);
  expect(bare.tier).toBe('official-quote');
  expect(bare.matchedExactly).toBe(true);
});

test('PA-316 同一条消息的四维必须同源：deepseek 高峰 breakdown 比例 = 该 quote 的比例', async () => {
  const { baseURL } = getRuntime();
  await liveCatalogWith(baseURL, deepseekPeriodQuotes(), '隔离实例的 catalog 里没有 deepseek-flash 的时段报价');
  const { computeCost } = await clientPricing();
  const cost = await computeCost('deepseek-flash', usage({ input: 1000, output: 1000, cacheRead: 1000 }), roughProvider(), { at: AT_PEAK });
  expect(cost).toBeTruthy();
  expect(cost.currency).toBe('CNY');
  const ratio = cost.breakdown.output / cost.breakdown.input;
  expect(ratio, '高峰档 output/input = 8/2').toBeCloseTo(4, 6);
  const readRatio = cost.breakdown.cacheRead / cost.breakdown.input;
  expect(readRatio, '高峰档 cacheRead/input = 0.04/2').toBeCloseTo(0.02, 6);
});

test('PA-317 幂等：同一 (model, usage, at) 连调两次结果逐字段相等（含 quoteId）', async () => {
  const { baseURL } = getRuntime();
  await liveCatalogWith(baseURL, deepseekPeriodQuotes(), '隔离实例的 catalog 里没有 deepseek-flash 的时段报价');
  const { computeCost } = await clientPricing();
  const args = ['deepseek-flash', usage({ input: 500, output: 50 }), roughProvider(), { at: AT_PEAK }];
  const first = await computeCost(...args);
  const second = await computeCost(...args);
  expect(second).toEqual(first);
});

test('PA-318 resolvePrice 是纯函数：全程不发起任何网络请求', async () => {
  const { resolvePrice } = await clientPricing();
  await useEmptyCatalog();
  const { value, calls } = await withFetchDisabled(() => resolvePrice('claude-opus-5', { at: AT_PEAK }));
  expect(calls, 'resolvePrice 不得发网络请求').toEqual([]);
  expect(value.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// 条件词表（§5.1.1）：不解释的条件、别的 schedule、冲突条件、生效期
// ---------------------------------------------------------------------------

const condQuote = (id, conditions, prices, extra = {}) => quote({
  quoteId: id, modelId: 'pa-cond-model', conditions, prices, ...extra,
});

test('PA-319 条件闭集：不认识的 inputLength 条件 → 该 quote 不适用，落到下一层', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [condQuote('pa-cond-inputlength', { inputLength: '输入长度 ≥32K' }, { input: 99, output: 99, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null })],
    prices: { 'pa-cond-model': { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3 } },
  }));
  const result = await resolvePrice('pa-cond-model', { at: AT_PEAK });
  expect(result.tier, '不可解释的条件必须跳过该层').toBe('official-compat');
  expect(result.prices.input).toBe(3);
});

test('PA-320 条件闭集：schedule 不是 deepseek-cn-peak → 该 quote 不适用（宁缺勿猜）', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [condQuote('pa-cond-other-schedule',
      { period: 'peak', schedule: 'some-other-schedule' },
      { input: 99, output: 99, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null })],
    prices: { 'pa-cond-model': { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3 } },
  }));
  const result = await resolvePrice('pa-cond-model', { at: AT_PEAK });
  expect(result.tier).toBe('official-compat');
  expect(result.prices.input).toBe(3);
});

test('PA-321 条件冲突：两条都适用但取值不一致 → 跳过官方层并记 skipped，最终给 CONDITIONS_AMBIGUOUS', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [
      condQuote('pa-amb-a', null, { input: 1, output: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null }),
      condQuote('pa-amb-b', null, { input: 5, output: 6, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null }),
    ],
  }));
  const result = await resolvePrice('pa-cond-model', { at: AT_PEAK });
  expect(result.ok, '取值不一致不得随手挑一条').toBe(false);
  expect(result.reason).toBe('CONDITIONS_AMBIGUOUS');
});

test('PA-322 多命中且四维完全一致 → 取 quoteId 字典序最小者（可复现）', async () => {
  const { resolvePrice } = await clientPricing();
  const samePrices = { input: 2, output: 4, cacheRead: 0.2, cacheWrite5m: null, cacheWrite1h: null };
  await useCatalog(pricingPayload({
    quotes: [
      condQuote('pa-same-zzz', null, samePrices),
      condQuote('pa-same-aaa', null, samePrices),
    ],
  }));
  const first = await resolvePrice('pa-cond-model', { at: AT_PEAK });
  const second = await resolvePrice('pa-cond-model', { at: AT_PEAK });
  expect(first.ok).toBe(true);
  expect(first.quoteId, '取字典序最小').toBe('pa-same-aaa');
  expect(second.quoteId).toBe(first.quoteId);
});

test('PA-323 validFrom 未生效的报价被排除 → 官方层跳过，落到下一层（历史消息取当时价）', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [condQuote('pa-future', null,
      { input: 1, output: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
      { validFrom: '2027-01-01T00:00:00.000Z' })],
    prices: { 'pa-cond-model': { input: 4, output: 8, cacheRead: 0.4, cacheWrite: 4 } },
  }));
  const result = await resolvePrice('pa-cond-model', { at: AT_PEAK });
  expect(result.tier, '未生效的官方价不得参与').toBe('official-compat');
  expect(result.prices.input).toBe(4);
});

test('PA-324 validTo 已过期的报价被排除（validTo <= at 不适用）', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [condQuote('pa-expired', null,
      { input: 1, output: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
      { validTo: '2026-09-01T00:00:00.000Z' })],
    prices: { 'pa-cond-model': { input: 4, output: 8, cacheRead: 0.4, cacheWrite: 4 } },
  }));
  const result = await resolvePrice('pa-cond-model', { at: AT_PEAK });
  expect(result.tier).toBe('official-compat');
  expect(result.prices.input).toBe(4);
});

test('PA-325 特例：官方候选只有时段条件而 at 缺失 → 不落下一层，直接 PERIOD_UNRESOLVED', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [condQuote('pa-period-only', { period: 'off-peak' },
      { input: 1, output: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null })],
    prices: { 'pa-cond-model': { input: 4, output: 8, cacheRead: 0.4, cacheWrite: 4 } },
  }));
  const result = await resolvePrice('pa-cond-model', {});
  expect(result.ok, '下层的价必然是错的时段价，不得回落').toBe(false);
  expect(result.reason).toBe('PERIOD_UNRESOLVED');
});

test('PA-326 skipped 记录被跳过的层与原因（与最终 reason 不是一回事）', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [
      condQuote('pa-amb-a', null, { input: 1, output: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null }),
      condQuote('pa-amb-b', null, { input: 5, output: 6, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null }),
    ],
  }));
  const result = await resolvePrice('pa-cond-model', { at: AT_PEAK });
  expect(result.ok).toBe(false);
  expect(Array.isArray(result.skipped)).toBe(true);
  const entry = (result.skipped || []).find(item => item?.tier === 'official-quote');
  expect(entry, 'skipped 必须点名 official-quote').toBeTruthy();
  expect(entry.reason).toBe('CONDITIONS_AMBIGUOUS');
});

// ---------------------------------------------------------------------------
// 官方层候选条件与 matchedExactly 语义（契约 §10.11③，取代 §5.1 原第一句）
// ---------------------------------------------------------------------------

test('PA-340 官方层候选：modelId 为 null 时靠 displayName 命中，且大小写不敏感（officialKey 口径）', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-display-only', modelId: null, displayName: 'GLM-5.3-Flash', currency: 'CNY',
      prices: { input: 11, output: 22, cacheRead: 1.1, cacheWrite5m: null, cacheWrite1h: null },
    })],
  }));
  const result = await resolvePrice('glm-5.3-flash', { at: AT_PEAK });
  expect(result.ok, '§10.11③ 规则 2：显示名归一后相等必须算候选').toBe(true);
  expect(result.tier).toBe('official-quote');
  expect(result.prices.input, '必须取该官方报价的值').toBe(11);
  expect(result.matchedExactly, '显示名命中恒为精确命中').toBe(true);
});

test('PA-341 官方层不剥 vendor/ 命名空间：anthropic/claude-opus-5 不得命中只登记了裸 id 的官方报价', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-bare-opus', modelId: 'claude-opus-5',
      prices: { input: 999, output: 999, cacheRead: 99, cacheWrite5m: null, cacheWrite1h: null },
    })],
  }));
  const result = await resolvePrice('anthropic/claude-opus-5', { at: AT_PEAK });
  expect(result.tier, '§10.11③：官方层不剥命名空间，这一层必须落空').not.toBe('official-quote');
  expect(result.ok, '落到兼容层/内置表仍有价').toBe(true);
  expect(result.prices.input, '不得取到官方那一条').not.toBe(999);
  expect(result.matchedExactly, '靠剥 vendor/ 命中 = 疑似').toBe(false);
});

test('PA-342 官方层规则 1 大小写敏感：modelId 只差大小写不算逐字相等', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-case-only', modelId: 'PA-ONLYCASE-MODEL', displayName: 'PA Unrelated Label',
      prices: { input: 7, output: 8, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
    })],
  }));
  const result = await resolvePrice('pa-onlycase-model', { at: AT_PEAK });
  expect(result.ok, 'modelId 与显示名都对不上 → 五层都不命中').toBe(false);
  expect(result.reason, '不得拿大小写不同的 modelId 当命中').toBe('NO_PRICE');
  expect(result.prices, '失败必须没有价格').toBeFalsy();
});

test('PA-343 官方层候选：别名表给出的目标键再按显示名匹配（claude-fable-5-1 → Claude Fable 5.1）', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-alias-fable', modelId: null, displayName: 'Claude Fable 5.1',
      prices: { input: 30, output: 40, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
    })],
  }));
  const result = await resolvePrice('claude-fable-5-1', { at: AT_PEAK });
  expect(result.ok, '§10.11③ 规则 3：别名表目标键必须参与匹配').toBe(true);
  expect(result.tier).toBe('official-quote');
  expect(result.prices.input, '必须取官方那份报价').toBe(30);
  expect(result.prices.cacheRead).toBe(0.25);
  expect(result.matchedExactly, '显式登记表命中属精确').toBe(true);
});

// ---------------------------------------------------------------------------
// normalizeOfficialName / 别名表（§4.4）
// ---------------------------------------------------------------------------

test('PA-327 normalizeOfficialName：丢掉尾部括号段（含 markdown 链接）、trim、折叠连续空白', async () => {
  const { normalizeOfficialName } = await pricingRules();
  expect(normalizeOfficialName('Claude Mythos 5.1 ([limited availability](https://anthropic.com/glasswing))'))
    .toBe('Claude Mythos 5.1');
  expect(normalizeOfficialName('Claude   Opus   5')).toBe('Claude Opus 5');
  expect(normalizeOfficialName('  Claude Fable 5  ')).toBe('Claude Fable 5');
});

test('PA-328 normalizeOfficialName：没括号原样保留，中间括号不动，非字符串返回空串且不抛', async () => {
  const { normalizeOfficialName } = await pricingRules();
  expect(normalizeOfficialName('Claude Sonnet 5')).toBe('Claude Sonnet 5');
  expect(normalizeOfficialName('Claude (Pro) Sonnet 5')).toBe('Claude (Pro) Sonnet 5');
  for (const value of [null, undefined, 123, {}, []]) {
    let out;
    expect(() => { out = normalizeOfficialName(value); }, `normalizeOfficialName(${String(value)}) 不得抛`).not.toThrow();
    expect(out, `normalizeOfficialName(${String(value)})`).toBe('');
  }
});

test('PA-329 OFFICIAL_MODEL_ALIASES：只登记有证据的条目（抽查契约列举的名字）', async () => {
  const { OFFICIAL_MODEL_ALIASES } = await pricingRules();
  expect(OFFICIAL_MODEL_ALIASES['claude-fable-5-1']).toBe('Claude Fable 5.1');
  expect(OFFICIAL_MODEL_ALIASES['claude-mythos-5-1']).toBe('Claude Mythos 5.1');
  expect(OFFICIAL_MODEL_ALIASES['claude-opus-5']).toBe('Claude Opus 5');
  expect(OFFICIAL_MODEL_ALIASES['claude-sonnet-4-6']).toBe('Claude Sonnet 4.6');
  expect(OFFICIAL_MODEL_ALIASES['claude-haiku-4-5']).toBe('Claude Haiku 4.5');
  expect(OFFICIAL_MODEL_ALIASES['deepseek-flash'], '同名模型不要伪造别名').toBeUndefined();
});

// ---------------------------------------------------------------------------
// 失败原因闭集（§0.1 / §5.2 表 / §8）
// ---------------------------------------------------------------------------

const NO_PRICE_USAGE = usage({ input: 1, output: 1 });

test('PA-330 原因闭集：resolvePrice 的每个 reason 必须落在 6 值集合内', async () => {
  const { resolvePrice } = await clientPricing();
  // 第三个探针要覆盖「已知模型（内置表里有价）但这次真的失败」。
  // catalog 遮空**不是**这种情况：契约 §7 #4 / #19 写死「屏蔽 quotes（空 catalog）→ tier==='offline'、
  // 仍 ok:true、值等于内置表」（内置表是最后一层，恒可用，见 §5.1 第 5 层）——那是 PA-303 / PA-318 的场景。
  // 真正「已知模型也失败」的情形是 §5.1 第 2 层特例：官方层命中 ≥1 条、但全部只带时段条件而 at 未知
  // → 不得落到下一层，直接 ok:false / PERIOD_UNRESOLVED（与 PA-325 同一条契约）。
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-opus-period-only', modelId: 'claude-opus-5',
      conditions: { period: 'peak' },
      prices: { input: 1, output: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
    })],
  }));
  const probes = [
    ['pa-unknown-model-xyz', {}],               // 未知模型：五层都不命中 → NO_PRICE
    ['pa-unknown-model-xyz', { at: AT_PEAK }],  // 同上，带时间也不改变
    ['claude-opus-5', {}, 'PERIOD_UNRESOLVED'], // 已知模型但真的失败（时段未知，不得回落到内置表）
  ];
  for (const [model, opts, expectedReason] of probes) {
    const result = await resolvePrice(model, opts);
    expect(result.ok).toBe(false);
    expect(PRICE_REASONS, `resolvePrice(${model}) 的 reason 越界：${result.reason}`).toContain(result.reason);
    if (expectedReason) {
      expect(result.reason, `resolvePrice(${model}) 的失败原因（§5.1 第 2 层特例）`).toBe(expectedReason);
    }
  }
});

test('PA-331 原因闭集：costUnavailableReason 的 reason 落在 8 值集合内，且与 computeCost 的 null 一一对应', async () => {
  const { computeCost, costUnavailableReason } = await clientPricing();
  await useEmptyCatalog();
  const probes = [
    ['pa-unknown-model-xyz', NO_PRICE_USAGE],
    ['claude-opus-5', null],
    ['claude-opus-5', {}],
    ['claude-opus-5', usage({ input: -5 })],
  ];
  for (const [model, u] of probes) {
    const cost = await computeCost(model, u, roughProvider(), { at: AT_PEAK });
    const reason = await costUnavailableReason(model, u, roughProvider(), { at: AT_PEAK });
    if (cost === null) {
      expect(reason, `computeCost 为 null 时必须有原因（model=${model}）`).toBeTruthy();
      expect(COST_UNAVAILABLE_REASONS, `原因越界：${reason?.reason}`).toContain(reason.reason);
      // §10.11⑦：detail 是逐字表，不是「可读短句」的自由文本。
      expect(reason.detail, `reason=${reason.reason} 的 detail 必须逐字等于契约 §10.11⑦`).toBe(DETAIL[reason.reason]);
      expect(reason.detail, 'detail 不得含 URL').not.toMatch(/https?:\/\//);
      expect(reason.detail, 'detail 不得含本地路径').not.toMatch(/\/Users\/|[A-Za-z]:\\/);
    } else {
      expect(reason, '有金额时不得给出失败原因').toBeNull();
    }
  }
});

test('PA-332 原因闭集：usage 缺失/为空 → USAGE_EMPTY（渲染层据此不显示 0 元）', async () => {
  const { computeCost, costUnavailableReason } = await clientPricing();
  await useEmptyCatalog();
  for (const u of [undefined, null, {}]) {
    const cost = await computeCost('claude-opus-5', u, roughProvider(), { at: AT_PEAK });
    expect(cost).toBeNull();
    const reason = await costUnavailableReason('claude-opus-5', u, roughProvider(), { at: AT_PEAK });
    expect(reason?.reason, `usage=${JSON.stringify(u)}`).toBe('USAGE_EMPTY');
    expect(reason?.detail, `usage=${JSON.stringify(u)} 的 detail`).toBe(DETAIL.USAGE_EMPTY);
  }
});

test('PA-333 原因闭集：负数/非有限/超上限的用量 → USAGE_INVALID（不计费）', async () => {
  const { computeCost, costUnavailableReason } = await clientPricing();
  await useEmptyCatalog();
  const bad = [
    usage({ input: -1 }),
    usage({ input: Number.NaN }),
    usage({ input: Number.POSITIVE_INFINITY }),
    usage({ input: Number.MAX_SAFE_INTEGER + 10 }),
  ];
  for (const u of bad) {
    const cost = await computeCost('claude-opus-5', u, roughProvider(), { at: AT_PEAK });
    expect(cost, `非法用量不得计费：${JSON.stringify(u)}`).toBeNull();
    const reason = await costUnavailableReason('claude-opus-5', u, roughProvider(), { at: AT_PEAK });
    expect(reason?.reason).toBe('USAGE_INVALID');
    expect(reason?.detail).toBe(DETAIL.USAGE_INVALID);
  }
});

test('PA-334 原因闭集：五层都没命中 → NO_PRICE', async () => {
  const { computeCost, costUnavailableReason } = await clientPricing();
  await useEmptyCatalog();
  const cost = await computeCost('pa-unknown-model-xyz', NO_PRICE_USAGE, roughProvider(), { at: AT_PEAK });
  expect(cost).toBeNull();
  const reason = await costUnavailableReason('pa-unknown-model-xyz', NO_PRICE_USAGE, roughProvider(), { at: AT_PEAK });
  expect(reason?.reason).toBe('NO_PRICE');
  expect(reason?.detail).toBe(DETAIL.NO_PRICE);
});

test('PA-335 PLAN_BILLING：官方 OAuth 态（anthropic + 无 key）判套餐档，且 bedrock/vertex 网关不得误判', async () => {
  const { computeCost, costUnavailableReason } = await clientPricing();
  await useEmptyCatalog();
  const usageTokens = usage({ input: 1000, output: 100 });

  // §10.11① 判据 ③：providerHint anthropic（缺省即 anthropic）+ hasAuthKey === false → 官方 OAuth 态
  const oauth = { providerHint: 'anthropic', hasAuthKey: false };
  expect(await computeCost('claude-opus-5', usageTokens, oauth, { at: AT_PEAK }), '套餐档不出金额').toBeNull();
  const reason = await costUnavailableReason('claude-opus-5', usageTokens, oauth, { at: AT_PEAK });
  expect(reason?.reason).toBe('PLAN_BILLING');

  // 反向：同一个 model 在计费型网关上必须照常出价（套餐判定不得外溢）
  const gateway = { providerHint: 'bedrock', hasAuthKey: false };
  const billed = await computeCost('claude-opus-5', usageTokens, gateway, { at: AT_PEAK });
  expect(billed, '§10.11①：bedrock/vertex 类网关按 token 真实计费，不判套餐').not.toBeNull();
});

test('PA-346 PLAN_BILLING：k3 / kimi-for-coding 系列按模型名判定（含 [1m] 后缀）', async () => {
  const { computeCost, costUnavailableReason } = await clientPricing();
  await useEmptyCatalog();
  const usageTokens = usage({ input: 1000, output: 100 });
  for (const model of ['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed', 'k3[1m]']) {
    expect(await computeCost(model, usageTokens, roughProvider(), { at: AT_PEAK }), `${model} 判套餐档`).toBeNull();
    const reason = await costUnavailableReason(model, usageTokens, roughProvider(), { at: AT_PEAK });
    expect(reason?.reason, `${model} 的原因`).toBe('PLAN_BILLING');
  }
});

// ---------------------------------------------------------------------------
// computeCostForMessage（§5.3）
// ---------------------------------------------------------------------------

const DS_QUOTES = [
  quote({
    quoteId: 'pa-ds-off', modelId: 'deepseek-flash', displayName: 'deepseek-flash',
    currency: 'CNY', conditions: { period: 'off-peak' },
    prices: { input: 1, output: 4, cacheRead: 0.02, cacheWrite5m: null, cacheWrite1h: null },
  }),
  quote({
    quoteId: 'pa-ds-peak', modelId: 'deepseek-flash', displayName: 'deepseek-flash',
    currency: 'CNY', conditions: { period: 'peak' },
    prices: { input: 2, output: 8, cacheRead: 0.04, cacheWrite5m: null, cacheWrite1h: null },
  }),
];

test('PA-336 computeCostForMessage：usageCalls 长度 1 且消息无时间戳时，用该项的 at（不得报时段未知）', async () => {
  const { computeCostForMessage } = await clientPricing();
  await useCatalog(pricingPayload({ quotes: DS_QUOTES }));
  const message = {
    type: 'turn',
    model: 'deepseek-flash',
    usage: usage({ input: 1000, output: 100 }),
    usageCalls: [{ at: AT_PEAK, usage: usage({ input: 1000, output: 100 }) }],
  };
  const cost = await computeCostForMessage(message, roughProvider());
  expect(cost, 'usageCalls[0].at 可用就必须有金额').toBeTruthy();
  expect(cost.breakdown.input, '按高峰价算').toBeCloseTo(usd(1000, 2), 9);
});

test('PA-337 computeCostForMessage：两项中一项 at 不可解析 → partial + unknownDimensions 含 period', async () => {
  const { computeCostForMessage } = await clientPricing();
  await useCatalog(pricingPayload({ quotes: DS_QUOTES }));
  const message = {
    type: 'turn',
    model: 'deepseek-flash',
    usage: usage({ input: 2000, output: 200 }),
    usageCalls: [
      { at: AT_PEAK, usage: usage({ input: 1000, output: 100 }) },
      { at: 'not-a-timestamp', usage: usage({ input: 1000, output: 100 }) },
    ],
  };
  const cost = await computeCostForMessage(message, roughProvider());
  expect(cost).toBeTruthy();
  expect(cost.partial, '有一项没算进去 → partial').toBe(true);
  expect(cost.unknownDimensions).toContain('period');
  expect(cost.breakdown.input, '只算得出那一项').toBeCloseTo(usd(1000, 2), 9);
});

test('PA-338 computeCostForMessage：全部 at 都不可解析且消息无时间戳 → PERIOD_UNRESOLVED', async () => {
  const { computeCostForMessage, costUnavailableReason } = await clientPricing();
  await useCatalog(pricingPayload({ quotes: DS_QUOTES }));
  const message = {
    type: 'turn',
    model: 'deepseek-flash',
    usage: usage({ input: 1000, output: 100 }),
    usageCalls: [{ at: null, usage: usage({ input: 1000, output: 100 }) }],
  };
  const cost = await computeCostForMessage(message, roughProvider());
  expect(cost).toBeNull();
  const reason = await costUnavailableReason('deepseek-flash', message.usage, roughProvider(), { at: undefined });
  expect(reason?.reason).toBe('PERIOD_UNRESOLVED');
  expect(reason?.detail).toBe(DETAIL.PERIOD_UNRESOLVED);
});

const MANUAL_MODEL = 'pa-manual-model';

/** §10.11① 的手填单价夹具：写入口 = 具名导出 `setUserPrices(entries, persist=false)`。 */
async function withUserPrices(modelPrices, fn) {
  const { setUserPrices } = await clientPricingExtra();
  setUserPrices([{ isCurrent: true, modelPrices }], false);
  try {
    return await fn();
  } finally {
    setUserPrices([], false); // 手填价是模块级状态：用完即清，保证用例可任意顺序跑
  }
}

test('PA-339 手填单价层（manual）：命中即最高优先、matchedExactly 为真、盖过官方与 compat 层', async () => {
  const { resolvePrice } = await clientPricingExtra();
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-manual-official', modelId: MANUAL_MODEL,
      prices: { input: 99, output: 99, cacheRead: 9, cacheWrite5m: 9, cacheWrite1h: null },
    })],
    prices: { [MANUAL_MODEL]: { input: 88, output: 88, cacheRead: 8, cacheWrite: 8 } },
  }));
  const result = await withUserPrices(
    { [MANUAL_MODEL]: { in: 10, out: 50, cacheRead: 1, cacheWrite: 2 } },
    () => resolvePrice(MANUAL_MODEL, { at: AT_PEAK }),
  );
  expect(result.ok).toBe(true);
  expect(result.tier, '手填价是第一层，命中即返回').toBe('manual');
  expect(result.matchedExactly).toBe(true);
  expect(result.prices.input, '取手填的 10').toBe(10);
  expect(result.prices.output).toBe(50);
  expect(result.prices.input, '不得落到官方报价的 99').not.toBe(99);
  expect(result.prices.input, '不得落到 compat 的 88').not.toBe(88);
});

test('PA-344 手填单价层：{plan:true} 的条目 → 套餐档 PLAN_BILLING（不出金额）', async () => {
  const { computeCost, costUnavailableReason } = await clientPricingExtra();
  await useEmptyCatalog();
  const usageTokens = usage({ input: 1000, output: 100 });
  const { cost, reason } = await withUserPrices({ [MANUAL_MODEL]: { plan: true } }, async () => ({
    cost: await computeCost(MANUAL_MODEL, usageTokens, roughProvider(), { at: AT_PEAK }),
    reason: await costUnavailableReason(MANUAL_MODEL, usageTokens, roughProvider(), { at: AT_PEAK }),
  }));
  expect(cost).toBeNull();
  expect(reason?.reason).toBe('PLAN_BILLING');
});

test('PA-345 手填单价层：缺 in 与 out 的条目按「没填」丢弃，不得占用 manual 层', async () => {
  const { resolvePrice } = await clientPricingExtra();
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-manual-fallback', modelId: MANUAL_MODEL,
      prices: { input: 3, output: 6, cacheRead: 0.3, cacheWrite5m: null, cacheWrite1h: null },
    })],
  }));
  const result = await withUserPrices(
    { [MANUAL_MODEL]: {} },
    () => resolvePrice(MANUAL_MODEL, { at: AT_PEAK }),
  );
  expect(result.tier, 'in/out 都没填 → 该条目丢弃，落到下一层').not.toBe('manual');
  expect(result.tier).toBe('official-quote');
  expect(result.prices.input).toBe(3);
});

test('PA-347 手填单价层：只填部分维度（in/out）→ 未填的缓存读写按未知（null），不回落别的层、也不用默认倍率猜数', async () => {
  const { resolvePrice, computeCost } = await clientPricingExtra();
  // 同一个 model 在官方层（cacheRead 9）与 compat 层（cacheRead 8）都有值：
  // 这些值一旦被借进 manual 层，就是「跨层拼维度」（§5.1 不变量 / §10.12③）。
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-manual-partial-official', modelId: MANUAL_MODEL,
      prices: { input: 99, output: 99, cacheRead: 9, cacheWrite5m: 9, cacheWrite1h: 9 },
    })],
    prices: { [MANUAL_MODEL]: { input: 88, output: 88, cacheRead: 8, cacheWrite: 8 } },
  }));
  // 读写量都小于输入量（不触发「读写超总量」的另一种标注）
  const usageTokens = usage({ input: 1_000_000, output: 100, cacheRead: 500_000, cacheWrite: 400_000 });
  const { price, cost } = await withUserPrices(
    { [MANUAL_MODEL]: { in: 10, out: 50 } }, // 只填了输入/输出，缓存读写没填
    async () => ({
      price: await resolvePrice(MANUAL_MODEL, { at: AT_PEAK }),
      cost: await computeCost(MANUAL_MODEL, usageTokens, roughProvider(), { at: AT_PEAK }),
    }),
  );

  expect(price.ok).toBe(true);
  expect(price.tier, '手填是第一层，命中即返回').toBe('manual');
  expect(price.prices.input, '填了的维度照抄用户填的值').toBe(10);
  expect(price.prices.output).toBe(50);
  // §10.12③：未填的维度 = null（未知）——「null」与「一个数」即本用例的判定分界
  expect(price.prices.cacheRead, '未填的缓存读必须是 null（未知），不是 in×0.1=1、不是官方 9、也不是 compat 8').toBeNull();
  expect(price.prices.cacheWrite5m, '未填的缓存写 5m 必须是 null（未知），不是 in×1.25=12.5').toBeNull();
  expect(price.prices.cacheWrite1h, '未填的缓存写 1h 必须是 null（未知）').toBeNull();

  // 未知维度不计费：金额只含已填的输入/输出（1_000_000×10 + 100×50，单位 per 1M token）
  const knownSubtotal = usd(1_000_000, 10) + usd(100, 50);
  expect(cost, '已知维度有价 → 必须给出已知小计，不是 null').toBeTruthy();
  expect(cost.totalUsd, '总额 = 已知小计（含猜出来的读费就绝对不是这个数）').toBeCloseTo(knownSubtotal, 9);
  expect(cost.totalUsd, '反向：不得用 in×0.1 猜读价（500k 读量会多出 0.5）').not.toBeCloseTo(knownSubtotal + usd(500_000, 10 * 0.1), 9);
  expect(cost.totalUsd, '反向：不得用 in×1.25 猜写价（400k 写量会多出 5）').not.toBeCloseTo(knownSubtotal + usd(400_000, 10 * 1.25), 9);
  expect(cost.breakdown.cacheRead ?? 0, '读费不得被算成一个数').toBe(0);
  expect(cost.unknownDimensions, '未填的写档必须点名（§10.12③）').toContain('cacheWrite');
  expect(cost.partial, '有未知维度 → partial（现行 INTERFACE：部分单价缺失显示已知小计 + 未知费用项）').toBe(true);
});
