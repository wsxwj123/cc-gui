// resolvePrice 白盒单测(价源层级 / 官方候选口径 / 条件词表 / matchedExactly / 失败原因闭集)。
// Run: node tests/unit/check-pricing-quotes.mjs   —— 用固定夹具喂 catalog,不联网、不碰实例。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = JSON.parse(readFileSync(join(root, 'tests/unit/fixtures/pricing-catalog-fixture.json'), 'utf8'));

const { setPricingCatalog } = await import('../../client/src/utils/pricingCatalog.js');
const {
  resolvePrice, computeCost, costUnavailableReason, setUserPrices, COST_UNAVAILABLE_REASONS,
} = await import('../../client/src/utils/pricing.js');

const PRICE_REASONS = ['NO_PRICE', 'PLAN_BILLING', 'PERIOD_UNRESOLVED', 'PERIOD_NOT_EFFECTIVE', 'CONDITIONS_AMBIGUOUS', 'THRESHOLD_UNKNOWN'];
const AT_PEAK = '2026-09-11T02:00:00.000Z';     // 周五北京 10:00
const AT_OFF = '2026-09-12T02:00:00.000Z';      // 周六北京 10:00

const useFixture = () => setPricingCatalog(fixture);
const useEmpty = () => setPricingCatalog({ source: 'official-sources', prices: {}, quotes: [], providers: [], refresh: null });
const quote = (over = {}) => ({
  quoteId: 'q-default', provider: 'pa-synthetic', presetIds: ['pa-synthetic'], modelId: null,
  displayName: 'PA Synthetic', protocol: null, market: 'global', currency: 'USD', unit: 'per 1M tokens',
  prices: { input: 1, output: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
  conditions: null, validFrom: null, validTo: null, sourceUrl: 'https://example.test/pricing',
  sourceKind: 'official', fetchedAt: '2026-09-11T08:15:56.307Z', parserVersion: 'pr6-1', status: 'fresh',
  ...over,
});
const useQuotes = (...quotes) => setPricingCatalog({ source: 'official-sources', prices: {}, quotes, providers: [], refresh: null });

// ── 1. 层级:手填 > 官方报价 > compat prices > 内置表 ─────────────────────
useFixture();
const dsPeak = resolvePrice('deepseek-flash', { at: AT_PEAK });
assert.equal(dsPeak.ok, true);
assert.equal(dsPeak.tier, 'official-quote', '官方分时段价必须真的被用上(不是只读 compat prices)');
assert.equal(dsPeak.matchedExactly, true, 'displayName 命中恒为精确');
assert.equal(dsPeak.currency, 'CNY', '官方报价保留原币种');
assert.equal(dsPeak.prices.input, 2, '高峰 CN ¥2');
assert.equal(dsPeak.prices.output, 8);
assert.equal(dsPeak.prices.cacheRead, 0.04);
assert.equal(dsPeak.appliedConditions[0].period, 'peak');
assert.deepEqual(dsPeak.skipped, []);
assert.equal(dsPeak.unit, 'per 1M tokens');

const dsOff = resolvePrice('deepseek-flash', { at: AT_OFF });
assert.equal(dsOff.prices.input, 1, '空闲 CN ¥1');
assert.equal(dsOff.appliedConditions[0].period, 'off-peak');

// 官方层没有该模型 → compat prices;两者都没有 → 内置表
useQuotes();
setPricingCatalog({ quotes: [], prices: { 'pa-compat': { input: 100, output: 200, cacheRead: 10, cacheWrite: 10 } } });
const compat = resolvePrice('pa-compat', { at: AT_PEAK });
assert.equal(compat.tier, 'official-compat');
assert.equal(compat.prices.input, 100);
assert.equal(compat.matchedExactly, true, 'compat 键与 model 逐字相等 = 精确');

useEmpty();
const offline = resolvePrice('claude-opus-5', { at: AT_PEAK });
assert.equal(offline.tier, 'offline');
assert.equal(offline.matchedExactly, true, '内置表精确键 = 精确');
assert.ok(offline.prices.input > 0);

// ── 2. matchedExactly:靠规则猜到的命中必须标出来 ─────────────────────────
useEmpty();
assert.equal(resolvePrice('step-3.7-flash-9999', { at: AT_PEAK }).matchedExactly, false, '最长前缀 = 疑似');
assert.equal(resolvePrice('step-3.7-flash-9999', { at: AT_PEAK }).tier, 'offline');
assert.equal(resolvePrice('anthropic/claude-opus-5', { at: AT_PEAK }).matchedExactly, false, '剥命名空间 = 疑似');
assert.equal(resolvePrice('claude-sonnet-4-5-20250929', { at: AT_PEAK }).matchedExactly, true, '精确键');
assert.equal(resolvePrice('opus', { at: AT_PEAK }).matchedExactly, true, 'ALIASES 是显式登记表 → 精确');

// ── 3. 已下架标注(O-2)与「官方层不剥命名空间」(§10.11③)───────────────────
useEmpty();
for (const model of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
  const r = resolvePrice(model, { at: AT_PEAK });
  assert.equal(r.tier, 'offline', `${model} 无官方现价 → 落内置表`);
  assert.equal(r.retired, true, `${model} 必须带已下架标注`);
  assert.ok(r.note.includes('下架'), `${model} 的 note 要写明下架`);
  assert.equal(r.matchedExactly, true, `${model} 是精确行(vision-exp 不再走前缀)`);
}
useQuotes(quote({ quoteId: 'pa-bare', modelId: 'claude-opus-5', prices: { input: 999, output: 999, cacheRead: 99, cacheWrite5m: null, cacheWrite1h: null } }));
const ns = resolvePrice('anthropic/claude-opus-5', { at: AT_PEAK });
assert.notEqual(ns.tier, 'official-quote', '官方层不剥 vendor/ 命名空间');
assert.notEqual(ns.prices.input, 999);
useQuotes(
  quote({ quoteId: 'pa-ns', modelId: 'openai/gpt-oss-120b', prices: { input: 0.15, output: 0.6, cacheRead: 0.02, cacheWrite5m: null, cacheWrite1h: null } }),
  quote({ quoteId: 'pa-bare2', modelId: 'gpt-oss-120b', prices: { input: 0.35, output: 1.4, cacheRead: 0.05, cacheWrite5m: null, cacheWrite1h: null } }),
);
assert.equal(resolvePrice('openai/gpt-oss-120b', { at: AT_PEAK }).prices.input, 0.15);
assert.equal(resolvePrice('gpt-oss-120b', { at: AT_PEAK }).prices.input, 0.35, '两个 id 不得互相覆盖');

// ── 4. 官方候选三条规则与大小写口径(§10.11③)─────────────────────────────
// 规则 1:modelId 逐字相等,大小写敏感
useQuotes(quote({ quoteId: 'pa-case', modelId: 'PA-ONLYCASE-MODEL', displayName: 'PA Unrelated' }));
const caseOnly = resolvePrice('pa-onlycase-model', { at: AT_PEAK });
assert.equal(caseOnly.ok, false);
assert.equal(caseOnly.reason, 'NO_PRICE', '大小写不同不算逐字相等');
assert.ok(!caseOnly.prices, '失败时不得带价格');
// 规则 2:显示名大小写不敏感
useQuotes(quote({ quoteId: 'pa-display', modelId: null, displayName: 'GLM-5.3-Flash', currency: 'CNY', prices: { input: 11, output: 22, cacheRead: 1.1, cacheWrite5m: null, cacheWrite1h: null } }));
const byDisplay = resolvePrice('glm-5.3-flash', { at: AT_PEAK });
assert.equal(byDisplay.tier, 'official-quote');
assert.equal(byDisplay.prices.input, 11);
assert.equal(byDisplay.matchedExactly, true);
// 规则 3:别名表目标键
useQuotes(quote({ quoteId: 'pa-alias', modelId: null, displayName: 'Claude Fable 5.1', prices: { input: 30, output: 40, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 } }));
const byAlias = resolvePrice('claude-fable-5-1', { at: AT_PEAK });
assert.equal(byAlias.tier, 'official-quote');
assert.equal(byAlias.prices.cacheRead, 0.25);
assert.equal(byAlias.matchedExactly, true, '别名表命中属精确');

// ── 5. 条件词表(§5.1.1):不认识的条件 / 别的 schedule / 冲突 / 生效期 ─────
useQuotes(quote({ quoteId: 'pa-inputlength', modelId: 'pa-cond', conditions: { inputLength: '输入长度 ≥32K' }, prices: { input: 99, output: 99, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null } }));
setPricingCatalog({ quotes: [quote({ quoteId: 'pa-inputlength', modelId: 'pa-cond', conditions: { inputLength: 'x' }, prices: { input: 99, output: 99, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null } })], prices: { 'pa-cond': { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3 } } });
assert.equal(resolvePrice('pa-cond', { at: AT_PEAK }).tier, 'official-compat', '不认识的条件 → 该 quote 不适用');

setPricingCatalog({ quotes: [quote({ quoteId: 'pa-sched', modelId: 'pa-cond', conditions: { period: 'peak', schedule: 'some-other' }, prices: { input: 99, output: 99 } })], prices: { 'pa-cond': { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3 } } });
assert.equal(resolvePrice('pa-cond', { at: AT_PEAK }).tier, 'official-compat', '别的 schedule → 不适用');

setPricingCatalog({ quotes: [
  quote({ quoteId: 'pa-amb-a', modelId: 'pa-cond', prices: { input: 1, output: 2 } }),
  quote({ quoteId: 'pa-amb-b', modelId: 'pa-cond', prices: { input: 5, output: 6 } }),
] });
const ambiguous = resolvePrice('pa-cond', { at: AT_PEAK });
assert.equal(ambiguous.ok, false);
assert.equal(ambiguous.reason, 'CONDITIONS_AMBIGUOUS');
assert.equal(ambiguous.skipped[0].tier, 'official-quote');
assert.equal(ambiguous.skipped[0].reason, 'CONDITIONS_AMBIGUOUS');

setPricingCatalog({ quotes: [
  quote({ quoteId: 'pa-same-zzz', modelId: 'pa-cond', prices: { input: 2, output: 4 } }),
  quote({ quoteId: 'pa-same-aaa', modelId: 'pa-cond', prices: { input: 2, output: 4 } }),
] });
assert.equal(resolvePrice('pa-cond', { at: AT_PEAK }).quoteId, 'pa-same-aaa', '多命中且价一致 → 取 quoteId 字典序最小');

setPricingCatalog({ quotes: [quote({ quoteId: 'pa-future', modelId: 'pa-cond', validFrom: '2027-01-01T00:00:00.000Z', prices: { input: 1, output: 2 } })], prices: { 'pa-cond': { input: 4, output: 8, cacheRead: 0.4, cacheWrite: 4 } } });
const notYet = resolvePrice('pa-cond', { at: AT_PEAK });
assert.equal(notYet.tier, 'official-compat', '未生效的官方价不参与,落下一层取当时价');
setPricingCatalog({ quotes: [quote({ quoteId: 'pa-expired', modelId: 'pa-cond', validTo: '2026-09-01T00:00:00.000Z', prices: { input: 1, output: 2 } })], prices: { 'pa-cond': { input: 4, output: 8, cacheRead: 0.4, cacheWrite: 4 } } });
assert.equal(resolvePrice('pa-cond', { at: AT_PEAK }).tier, 'official-compat', 'validTo ≤ at 不适用');

// 只有时段条件而时刻未知:不落下一层,直接 PERIOD_UNRESOLVED
setPricingCatalog({ quotes: [quote({ quoteId: 'pa-period-only', modelId: 'pa-cond', conditions: { period: 'off-peak' }, prices: { input: 1, output: 2 } })], prices: { 'pa-cond': { input: 4, output: 8, cacheRead: 0.4, cacheWrite: 4 } } });
const noTime = resolvePrice('pa-cond', {});
assert.equal(noTime.ok, false);
assert.equal(noTime.reason, 'PERIOD_UNRESOLVED', '下层必然是错的时段价,不得回落');
assert.equal(noTime.detail, '该模型按时段计价，但这条记录的时间未知或无法解析');

// 时段报价在生效日之前 → 五层都没命中时给 PERIOD_NOT_EFFECTIVE
useFixture();
const beforePolicy = resolvePrice('deepseek-flash', { at: '2026-08-01T02:00:00.000Z' });
assert.equal(beforePolicy.ok, false);
assert.equal(beforePolicy.reason, 'PERIOD_NOT_EFFECTIVE', '早于峰谷生效日 + 下层无价');
assert.ok(beforePolicy.skipped.some((item) => item.reason === 'PERIOD_NOT_EFFECTIVE'));

// 长上下文档:阈值未登记 → THRESHOLD_UNKNOWN(不猜一档);有短档则正常用短档
setPricingCatalog({ quotes: [quote({ quoteId: 'pa-longonly', modelId: 'pa-long-only', conditions: { context: 'long context' }, prices: { input: 8, output: 30 } })] });
const longOnly = resolvePrice('pa-long-only', { at: AT_PEAK, promptTokens: 300000 });
assert.equal(longOnly.ok, false);
assert.equal(longOnly.reason, 'THRESHOLD_UNKNOWN');
setPricingCatalog({ quotes: [quote({ quoteId: 'pa-shortonly', modelId: 'pa-short-only', conditions: { context: 'short context' }, prices: { input: 3, output: 9 } })] });
assert.equal(resolvePrice('pa-short-only', { at: AT_PEAK, promptTokens: 300000 }).prices.input, 3);
// 阈值已登记:sol 的长短档互补
useFixture();
assert.equal(resolvePrice('gpt-5.6-sol', { at: AT_PEAK, promptTokens: 300000 }).prices.input, 8, '长档');
assert.equal(resolvePrice('gpt-5.6-sol', { at: AT_PEAK, promptTokens: 100000 }).prices.input, 4, '短档');
assert.equal(resolvePrice('gpt-5.6-sol', { at: AT_PEAK, promptTokens: null }).tier, 'offline', '输入量未知 → 两档都不适用,落内置表');

// ── 6. 国内外双价:同一模型 cn/global 两组时取 cn(与内置表「取国内价」同一条约定)──
useFixture();
const glmFlash = resolvePrice('glm-5.3-flash', { at: AT_PEAK });
assert.equal(glmFlash.tier, 'official-quote');
assert.equal(glmFlash.prices.input, 0.8, '取国内站人民币价,不是国际站 $0.15');
assert.equal(glmFlash.prices.output, 2.8);
assert.equal(glmFlash.prices.cacheRead, 0.23);

// ── 7. 手填单价层(manual):命中即最高优先,未填维度 = null ────────────────
useFixture();
setUserPrices([{ isCurrent: true, modelPrices: { 'deepseek-flash': { in: 10, out: 50, cacheRead: 1, cacheWrite: 2 } } }], false);
const manual = resolvePrice('deepseek-flash', { at: AT_PEAK });
assert.equal(manual.tier, 'manual');
assert.equal(manual.matchedExactly, true);
assert.equal(manual.prices.input, 10, '照抄用户填的值(原币种 CNY)');
assert.equal(manual.prices.cacheWrite1h, null);
setUserPrices([{ isCurrent: true, modelPrices: { 'deepseek-flash': { in: 10, out: 50 } } }], false);
const partialManual = resolvePrice('deepseek-flash', { at: AT_PEAK });
assert.equal(partialManual.prices.cacheRead, null, '未填的维度 = 未知(不回落官方/compat/内置,不猜倍率)');
assert.equal(partialManual.prices.cacheWrite5m, null);
setUserPrices([{ isCurrent: true, modelPrices: { 'deepseek-flash': { plan: true } } }], false);
const plan = resolvePrice('deepseek-flash', { at: AT_PEAK });
assert.equal(plan.ok, false);
assert.equal(plan.reason, 'PLAN_BILLING');
setUserPrices([], false);

// ── 8. 失败原因闭集 + 幂等 + 纯函数(不发网络)─────────────────────────────
// 注:契约 PA-330 的第三条探针 ['claude-opus-5', {}] 期望"空 catalog + 不给 at 时也失败",
// 与 PA-303(空 catalog 下内置表照常出价)直接冲突 —— 本仓按 §5.1 第 5 层(内置表恒可用)实现,
// 该探针会红;此处改用真正无价的模型验闭集。
useEmpty();
for (const [model, opts] of [['pa-unknown-xyz', {}], ['pa-unknown-xyz', { at: AT_PEAK }]]) {
  const r = resolvePrice(model, opts);
  assert.equal(r.ok, false);
  assert.ok(PRICE_REASONS.includes(r.reason), `${model} 的 reason 越界:${r.reason}`);
  assert.equal(typeof r.detail, 'string');
}
assert.equal(resolvePrice('claude-opus-5', {}).tier, 'offline', '空 catalog + 无 at:内置表恒可用(PA-303)');
useFixture();
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = (...args) => { calls.push(String(args[0])); return Promise.reject(new Error('no network')); };
const pure = resolvePrice('deepseek-flash', { at: AT_PEAK });
globalThis.fetch = originalFetch;
assert.deepEqual(calls, [], 'resolvePrice 不得发网络请求');
assert.equal(pure.ok, true);
assert.deepEqual(pure, resolvePrice('deepseek-flash', { at: AT_PEAK }), '同一 (model, opts) 结果确定');

// 原因闭集:costUnavailableReason 覆盖 8 值,且 computeCost 为 null 时必有原因
const reasonSet = new Set(COST_UNAVAILABLE_REASONS);
assert.equal(reasonSet.size, 8);
for (const [model, usage, opts] of [
  ['pa-unknown-xyz', { input_tokens: 5 }, { at: AT_PEAK }],
  ['deepseek-flash', { input_tokens: 5 }, {}],
  ['claude-opus-5', null, { at: AT_PEAK }],
  ['claude-opus-5', { input_tokens: -5 }, { at: AT_PEAK }],
  ['claude-opus-5', { input_tokens: 5 }, { at: AT_PEAK }],
]) {
  const cost = computeCost(model, usage, { providerHint: 'anthropic', hasAuthKey: true }, opts);
  const reason = costUnavailableReason(model, usage, { providerHint: 'anthropic', hasAuthKey: true }, opts);
  if (cost === null) {
    assert.ok(reason && reasonSet.has(reason.reason), `computeCost 为 null 必须有闭集内的原因(${model})`);
  } else {
    assert.equal(reason, null, `有金额时不得给原因(${model})`);
  }
}
// 套餐档:reason 逐字
const planReason = costUnavailableReason('claude-opus-5', { input_tokens: 5 }, { providerHint: 'anthropic', hasAuthKey: false }, { at: AT_PEAK });
assert.equal(planReason.reason, 'PLAN_BILLING');
assert.equal(planReason.detail, '当前是按套餐计费，不显示金额');

setPricingCatalog(null);
console.log('check-pricing-quotes: OK');
