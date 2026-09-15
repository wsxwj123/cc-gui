// PA-1xx / PA-2xx：时间分时段、长上下文档、缓存写 TTL 分档（契约 §1 / §4.1–4.3 / §5.2）。
// 全部是契约点名的纯函数入口：server/utils/pricing-rules.js 与 client/src/utils/pricing.js。
import { test, expect } from '@playwright/test';
import {
  pricingRules, clientPricing, pricingPayload, quote, useCatalog,
  usage, roughProvider, usd, QUOTE_UNIT, CURRENCIES,
} from './helpers/pa-runtime.mjs';

// ---------------------------------------------------------------------------
// PA-1xx 时间与时段（契约 §1、§4.1、§4.2）
// ---------------------------------------------------------------------------

const PERIOD_BOUNDARIES = [
  ['PA-101', '工作日 08:59:59（北京）= 高峰窗口下界前一秒', '2026-09-11T00:59:59.000Z', 'off-peak'],
  ['PA-102', '工作日 09:00:00 整 = 下界含', '2026-09-11T01:00:00.000Z', 'peak'],
  ['PA-103', '工作日 11:59:59（窗口内最后整点前）', '2026-09-11T03:59:59.000Z', 'peak'],
  ['PA-104', '工作日 12:00:00 整 = 上界不含', '2026-09-11T04:00:00.000Z', 'off-peak'],
  ['PA-105', '工作日 13:59:59（午休窗口末尾）', '2026-09-11T05:59:59.000Z', 'off-peak'],
  ['PA-106', '工作日 14:00:00 整 = 下界含', '2026-09-11T06:00:00.000Z', 'peak'],
  ['PA-107', '工作日 17:59:59（窗口中最后）', '2026-09-11T09:59:59.000Z', 'peak'],
  ['PA-108', '工作日 18:00:00 整 = 上界不含', '2026-09-11T10:00:00.000Z', 'off-peak'],
  ['PA-109', '周六 10:00（在 UTC 是周五，验「按北京星期几」）', '2026-09-12T02:00:00.000Z', 'off-peak'],
  ['PA-110', '周日 10:00（全天空闲）', '2026-09-13T02:00:00.000Z', 'off-peak'],
  ['PA-111', '跨午夜：北京 00:00:00（UTC 还是前一天）', '2026-09-10T16:00:00.000Z', 'off-peak'],
  ['PA-112', '北京 23:59:59（跨日窗口末尾）', '2026-09-10T15:59:59.000Z', 'off-peak'],
];

for (const [id, label, input, expected] of PERIOD_BOUNDARIES) {
  test(`${id} periodFor：${label} → ${expected}`, async () => {
    const { periodFor } = await pricingRules();
    const result = periodFor(input);
    expect(result?.key, `${input} 的时段`).toBe(expected);
    expect(typeof result?.localISO, 'peak/off-peak 必须带 localISO').toBe('string');
  });
}

test('PA-113 periodFor：带 +08:00 偏移的输入与 Z 输入等价', async () => {
  const { periodFor } = await pricingRules();
  expect(periodFor('2026-09-11T01:00:00.000Z')).toEqual(periodFor('2026-09-11T09:00:00+08:00'));
  expect(periodFor('2026-09-11T09:00:00+08:00').key).toBe('peak');
});

test('PA-114 periodFor：epoch 毫秒数输入与 ISO 输入等价', async () => {
  const { periodFor } = await pricingRules();
  const iso = '2026-09-11T01:00:00.000Z';
  expect(periodFor(Date.parse(iso)).key).toBe('peak');
  expect(periodFor(Date.parse('2026-09-12T02:00:00.000Z')).key).toBe('off-peak');
});

test('PA-115 periodFor：缺参/空串/非法字符串/NaN/Infinity/对象/超范围日期一律 → unknown/INVALID_TIMESTAMP，且不抛', async () => {
  const { periodFor } = await pricingRules();
  const bad = [undefined, null, '', '   ', 'abc', '2026-13-45T99:99:99Z', NaN, Infinity, -Infinity, {}, []];
  for (const value of bad) {
    let result;
    expect(() => { result = periodFor(value); }, `periodFor(${String(value)}) 不得抛异常`).not.toThrow();
    expect(result, `periodFor(${String(value)}) 的返回`).toEqual({ key: 'unknown', reason: 'INVALID_TIMESTAMP' });
  }
});

test('PA-116 periodFor：localISO 是固定 +08:00 的当地时间（跨日也要对）', async () => {
  const { periodFor } = await pricingRules();
  expect(periodFor('2026-09-10T16:00:00.000Z').localISO).toBe('2026-09-11T00:00:00+08:00');
  expect(periodFor('2026-09-11T01:00:00.000Z').localISO).toBe('2026-09-11T09:00:00+08:00');
});

test('PA-117 periodFor：判定只来自入参，不读「现在」（两个互斥输入必须各自成立）', async () => {
  const { periodFor } = await pricingRules();
  const monday = periodFor('2026-01-05T02:00:00.000Z'); // 周一北京 10:00
  const saturday = periodFor('2026-01-03T02:00:00.000Z'); // 周六北京 10:00
  expect(monday.key, '周一北京 10:00 必须是高峰').toBe('peak');
  expect(saturday.key, '周六北京 10:00 必须是空闲').toBe('off-peak');
});

test('PA-118 PERIOD_SCHEDULES：只有一个 key，且内容逐字符合契约 §4.1', async () => {
  const { PERIOD_SCHEDULES } = await pricingRules();
  expect(Object.keys(PERIOD_SCHEDULES), '当前只允许 deepseek-cn-peak 一个 key').toEqual(['deepseek-cn-peak']);
  const schedule = PERIOD_SCHEDULES['deepseek-cn-peak'];
  expect(schedule.timezone).toBe('Asia/Shanghai');
  expect(schedule.utcOffsetMinutes).toBe(480);
  expect(schedule.weekdays).toEqual([1, 2, 3, 4, 5]);
  expect(schedule.peakWindows).toEqual([[540, 720], [840, 1080]]);
  expect(typeof schedule.note === 'string' && schedule.note.length > 0, 'note 非空').toBe(true);
});

// ---------------------------------------------------------------------------
// PA-2xx 长上下文档（契约 §4.3、§5.1.1、§5.2 第 3 条）
// ---------------------------------------------------------------------------

const SOL_SHORT = quote({
  quoteId: 'pa-sol-short', modelId: 'gpt-5.6-sol',
  prices: { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: null },
  conditions: { context: 'short context' },
});
const SOL_LONG = quote({
  quoteId: 'pa-sol-long', modelId: 'gpt-5.6-sol',
  prices: { input: 8, output: 30, cacheRead: 0.8, cacheWrite5m: 10, cacheWrite1h: null },
  conditions: { context: 'long context' },
});

async function costWithSolCatalog(usageTokens, at = '2026-09-11T02:00:00.000Z') {
  const { computeCost } = await clientPricing();
  await useCatalog(pricingPayload({ quotes: [SOL_SHORT, SOL_LONG] }));
  return computeCost('gpt-5.6-sol', usageTokens, roughProvider(), { at });
}

test('PA-201 长档：input_tokens = 300000 → 整条走 (long context) 档的输入价（×8 而不是 ×4）', async () => {
  const cost = await costWithSolCatalog(usage({ input: 300000, output: 100 }));
  expect(cost?.breakdown?.input, '长档输入小计').toBeCloseTo(usd(300000, 8), 9);
  expect(cost?.breakdown?.input, '不得按短档计的同一数值').not.toBeCloseTo(usd(300000, 4), 9);
});

test('PA-202 阈值边界：input_tokens = 272000 正好等于阈值 → 仍走短档（严格大于）', async () => {
  const cost = await costWithSolCatalog(usage({ input: 272000, output: 10 }));
  expect(cost?.breakdown?.input, '272000 仍是短档').toBeCloseTo(usd(272000, 4), 9);
});

test('PA-203 阈值边界：input_tokens = 272001 → 走长档', async () => {
  const cost = await costWithSolCatalog(usage({ input: 272001, output: 10 }));
  expect(cost?.breakdown?.input, '272001 进长档').toBeCloseTo(usd(272001, 8), 9);
});

test('PA-204 短档：input_tokens = 200000 → 短档输入价', async () => {
  const cost = await costWithSolCatalog(usage({ input: 200000, output: 10 }));
  expect(cost?.breakdown?.input).toBeCloseTo(usd(200000, 4), 9);
});

test('PA-205 口径负例：input_tokens=100000 + cache_read=200000 → 仍是短档（判据不得把缓存读加上去）', async () => {
  const cost = await costWithSolCatalog(usage({ input: 100000, output: 10, cacheRead: 200000 }));
  expect(cost?.breakdown?.input, '输入小计按 100000 短档').toBeCloseTo(usd(100000, 4), 9);
  expect(cost?.breakdown?.input, '不得因 cache_read 凑过阈值而变长档').not.toBeCloseTo(usd(100000, 8), 9);
});

test('PA-206 长档四维：长档下 output 也按长档价（×30 而不是 ×20）', async () => {
  const cost = await costWithSolCatalog(usage({ input: 300000, output: 1000 }));
  expect(cost?.breakdown?.output).toBeCloseTo(usd(1000, 30), 9);
});

test('PA-207 appliedConditions：长档调用必须记录 context/threshold（恒为数组）', async () => {
  const cost = await costWithSolCatalog(usage({ input: 300000, output: 10 }));
  expect(Array.isArray(cost?.appliedConditions), 'appliedConditions 恒为数组').toBe(true);
  const longEntry = (cost.appliedConditions || []).find(item => item?.context === 'long context');
  expect(longEntry, '必须有 long context 的条件记录').toBeTruthy();
  expect(longEntry.promptTokens).toBe(300000);
  expect(longEntry.threshold).toBe(272000);
});

test('PA-208 LONG_CONTEXT_THRESHOLDS：sol/terra/luna = 272000，cyber 不登记', async () => {
  const { LONG_CONTEXT_THRESHOLDS } = await pricingRules();
  expect(LONG_CONTEXT_THRESHOLDS['gpt-5.6-sol']).toBe(272000);
  expect(LONG_CONTEXT_THRESHOLDS['gpt-5.6-terra']).toBe(272000);
  expect(LONG_CONTEXT_THRESHOLDS['gpt-5.6-luna']).toBe(272000);
  expect(LONG_CONTEXT_THRESHOLDS['gpt-5.6-cyber'], 'cyber 官方页长档为 "-"，不得登记').toBeUndefined();
});

test('PA-209 阈值未登记：只存在长档报价且无短档可用 → reason = THRESHOLD_UNKNOWN（不猜一档）', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-longonly', modelId: 'pa-synthetic-long-only',
      prices: { input: 8, output: 30, cacheRead: 0.8, cacheWrite5m: null, cacheWrite1h: null },
      conditions: { context: 'long context' },
    })],
  }));
  const result = await resolvePrice('pa-synthetic-long-only', { promptTokens: 300000, at: '2026-09-11T02:00:00.000Z' });
  expect(result.ok, '不得用一个来路不明的档位成交').toBe(false);
  expect(result.reason).toBe('THRESHOLD_UNKNOWN');
});

test('PA-210 反向：阈值未登记但有短档可用 → 正常用短档（宁缺勿猜不等于拒绝出价）', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({
    quotes: [quote({
      quoteId: 'pa-shortonly', modelId: 'pa-synthetic-short-only',
      prices: { input: 3, output: 9, cacheRead: 0.3, cacheWrite5m: null, cacheWrite1h: null },
      conditions: { context: 'short context' },
    })],
  }));
  const result = await resolvePrice('pa-synthetic-short-only', { promptTokens: 300000, at: '2026-09-11T02:00:00.000Z' });
  expect(result.ok).toBe(true);
  expect(result.prices.input).toBe(3);
});

// ---------------------------------------------------------------------------
// PA-22x 缓存写 TTL 分档与读费（契约 §5.2 第 1/2 条、§7 #14）
// ---------------------------------------------------------------------------

const OPUS_QUOTE = quote({
  quoteId: 'pa-opus', modelId: 'claude-opus-5',
  prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
});
const AT = '2026-09-11T02:00:00.000Z';

async function opusCost(u, overrides = {}) {
  const { computeCost } = await clientPricing();
  await useCatalog(pricingPayload({ quotes: [{ ...OPUS_QUOTE, ...overrides }] }));
  return computeCost('claude-opus-5', u, roughProvider(), { at: AT });
}

test('PA-221 TTL 分档精算：5m 与 1h 各 1000 → 写费 = 1000×6.25/1M + 1000×10/1M', async () => {
  const cost = await opusCost(usage({ cacheWrite: 2000, fiveMin: 1000, oneHour: 1000 }));
  expect(cost?.breakdown?.cacheWrite, '写费合计').toBeCloseTo(usd(1000, 6.25) + usd(1000, 10), 9);
  expect(cost?.breakdown?.cacheWrite5m, '5m 档小计').toBeCloseTo(usd(1000, 6.25), 9);
  expect(cost?.breakdown?.cacheWrite1h, '1h 档小计').toBeCloseTo(usd(1000, 10), 9);
  expect(cost?.breakdown?.cacheWrite, '不得把顶层 2000 当单档价算')
    .not.toBeCloseTo(usd(2000, 6.25), 9);
  expect(cost?.breakdown?.cacheWrite, '不得把顶层 2000 按 1h 单档价算')
    .not.toBeCloseTo(usd(2000, 10), 9);
});

test('PA-222 反向：只有顶层写量、无 TTL 分配而两档价不同 → 写费未知，不按任一单档价计', async () => {
  const cost = await opusCost(usage({ cacheWrite: 2000 }));
  expect(cost, '其余维度有价时仍应给出金额').toBeTruthy();
  expect(cost.unknownDimensions, 'unknownDimensions 必须点名 cacheWrite').toContain('cacheWrite');
  expect(cost.partial, '未知维度 → partial').toBe(true);
  expect(cost.breakdown.cacheWrite ?? 0, '写费不得被算成一个数').toBe(0);
});

test('PA-223 数据自相矛盾：5m+1h ≠ 顶层写量 → 写费未知 + partial，不猜', async () => {
  const cost = await opusCost(usage({ cacheWrite: 500, fiveMin: 1000, oneHour: 1000 }));
  expect(cost.unknownDimensions).toContain('cacheWrite');
  expect(cost.partial).toBe(true);
  expect(cost.breakdown.cacheWrite ?? 0).toBe(0);
});

test('PA-224 无 TTL 分配时 breakdown.cacheWrite5m / cacheWrite1h 必须是 null（渲染判空的依据）', async () => {
  const cost = await opusCost(usage({ input: 10, output: 5 }));
  expect(cost.breakdown.cacheWrite5m, '无分配 → null 而不是 0').toBeNull();
  expect(cost.breakdown.cacheWrite1h).toBeNull();
});

test('PA-225 只有 5m 价（OpenAI 口径）→ 单档价照算，不算未知维度', async () => {
  const cost = await opusCost(
    usage({ cacheWrite: 100, fiveMin: 100 }),
    { prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: null } },
  );
  expect(cost.breakdown.cacheWrite).toBeCloseTo(usd(100, 6.25), 9);
  expect(cost.unknownDimensions || []).not.toContain('cacheWrite');
});

test('PA-226 反向：只有 1h 价而用量是 5m 量 → 写费未知（不得拿 1h 价当 5m 价）', async () => {
  const cost = await opusCost(
    usage({ cacheWrite: 100, fiveMin: 100 }),
    { prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: null, cacheWrite1h: 10 } },
  );
  expect(cost.breakdown.cacheWrite ?? 0, '不得按 1h 价算 5m 量').not.toBeCloseTo(usd(100, 10), 9);
  expect(cost.unknownDimensions).toContain('cacheWrite');
});

test('PA-227 读费按报价本身的 cacheRead 计，代码里不得再乘倍率', async () => {
  const cost = await opusCost(usage({ cacheRead: 1000 }));
  expect(cost.breakdown.cacheRead).toBeCloseTo(usd(1000, 0.5), 9);
  expect(cost.breakdown.cacheRead).not.toBeCloseTo(usd(1000, 0.5 * 1.25), 9);
  expect(cost.breakdown.cacheRead).not.toBeCloseTo(usd(1000, 0.5 * 0.1), 9);
});

test('PA-228 quote 单位逐字为 per 1M tokens，币种落在契约闭集内', async () => {
  const { resolvePrice } = await clientPricing();
  await useCatalog(pricingPayload({ quotes: [OPUS_QUOTE] }));
  const result = await resolvePrice('claude-opus-5', { at: AT });
  expect(result.ok).toBe(true);
  expect(result.unit).toBe(QUOTE_UNIT);
  expect(CURRENCIES).toContain(result.currency);
});
