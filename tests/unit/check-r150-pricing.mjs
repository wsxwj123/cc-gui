#!/usr/bin/env node
// 单测:r150 P 组 —— 5.5 系列(claude-opus-5-5 / claude-sonnet-5-5 / claude-haiku-5-5)的费用。
//
// 现象(用户实报):新模型的费用显示「未定价」或算错。主会话实测:
//   claude-haiku-5-5  computeCost 返回 null(界面显示未定价);
//   claude-opus-5-5 / claude-sonnet-5-5 靠最长前缀落到内置表的 claude-opus-5 / claude-sonnet-5(价不同);
//   远程价格表里 Claude 模型的键是 anthropic/claude-opus-5.5 这种写法(带 anthropic/ 前缀、版本号用点),
//   而 CLI 报的模型名是 claude-opus-5-5 —— 逐字 / startsWith 匹配从来对不上。
//
//   P1 远程表查找认得同一个模型的两种写法(anthropic/ 前缀有无、版本号 . 与 -、[1m] 之类后缀、日期后缀)
//   P2 内置兜底表补上三个 5.5 模型(远程表拿不到时也有价)
//   P3 裸别名 opus / sonnet / haiku 指向 5.5(依据:本机 CLI 2.1.296 自带模型目录的 aliases.*.default)
// 返工(r150b):
//   R1 haiku 5.5 分两档:提示不超过 10 万 token 是 0.1 / 0.5 / 0.01 / 0.125(1 小时写 0.2);超过 10 万的那次调用
//      整次按 0.5 / 2.5 / 0.05 / 0.625(1 小时写 1)。「提示 token」= input_tokens + cache_read_input_tokens
//      + cache_creation_input_tokens(Anthropic 的 input_tokens 不含缓存部分;CLI 2.1.296 自带的计费函数就是
//      这三项相加、严格大于 100000 才走高档)。档位按每次调用各自判,不按一轮的合计判。
//   R2 Claude 模型:内置表里有这个模型(逐字 / 去日期 / 去 […] 后缀后逐字)就用内置表;远程表只在内置表没有
//      这个模型时才用(等价写法排在最长前缀之前)。原因:远程表对带分档的模型只给高档价。
//   R3 裸别名 fable 指向 claude-fable-5-1(同一份 CLI 目录)。
// 数值(美元 / 百万 token:输入 / 输出 / 缓存读 / 缓存写 5m):
//   opus 5.5 = 4 / 20 / 0.2 / 5;sonnet 5.5 = 2 / 10 / 0.1 / 2.5;haiku 5.5 见 R1。
// Run: node tests/unit/check-r150-pricing.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').slice(0, 14).join('\n      ')}`); }
};

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { setPricingCatalog } = await import(root + 'client/src/utils/pricingCatalog.js');
const { computeCost, computeCostForMessage, aggregateCost, resolvePrice, setUserPrices } = await import(root + 'client/src/utils/pricing.js');

const provider = { providerHint: 'anthropic', model: null, hasAuthKey: true };   // 按量付费(不是订阅)
const M = 1e6;
const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg}:实得 ${a},应为 ${b}`);
/** 换一份远程价格表(官方兼容视图 prices);quotes 为空 = 官方报价层没有命中。 */
const useRemote = (prices, quotes = []) => setPricingCatalog({ source: 'official-sources', prices, quotes, providers: [], refresh: null });
/** fullPromptTokens = 这次调用的提示 token(三项之和);不给 = 不知道(汇总场景)。 */
const four = (model, fullPromptTokens) => {
  const r = resolvePrice(model, { provider, promptTokens: 1000, fullPromptTokens });
  return r.ok
    ? { tier: r.tier, exact: r.matchedExactly, in: r.prices.input, out: r.prices.output, cr: r.prices.cacheRead, cw: r.prices.cacheWrite5m, w1h: r.prices.cacheWrite1h, applied: r.appliedConditions }
    : { tier: null, reason: r.reason };
};
const expectPrice = (model, want, msg = model, fullPromptTokens) => {
  const got = four(model, fullPromptTokens);
  assert.equal(got.tier, want.tier, `${msg}:命中的层(实得 ${JSON.stringify(got)})`);
  near(got.in, want.in, `${msg} 输入价`);
  near(got.out, want.out, `${msg} 输出价`);
  near(got.cr, want.cr, `${msg} 缓存读价`);
  near(got.cw, want.cw, `${msg} 缓存写(5m)价`);
  if (want.w1h !== undefined) near(got.w1h, want.w1h, `${msg} 缓存写(1h)价`);
  if (want.exact !== undefined) assert.equal(got.exact, want.exact, `${msg}:是否逐字 / 等价命中`);
};

const HAIKU = 'claude-haiku-5-5';
const HAIKU_BASE = { in: 0.1, out: 0.5, cr: 0.01, cw: 0.125, w1h: 0.2 };
const HAIKU_LONG = { in: 0.5, out: 2.5, cr: 0.05, cw: 0.625, w1h: 1 };
const V55 = {
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.2, cw: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.1, cw: 2.5 },
  [HAIKU]: HAIKU_BASE,
};
// 远程表里现有的写法与数值(主会话实测;haiku 那条是远程表给出的高档价)
const REMOTE_55 = {
  'anthropic/claude-opus-5.5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'anthropic/claude-haiku-5.5': { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
};
// 一次调用:各 1 万 token(提示合计 3 万,不到 10 万),缓存写全部是 5 分钟档
const K = 10_000;
const USAGE = {
  input_tokens: K, output_tokens: K, cache_read_input_tokens: K, cache_creation_input_tokens: K,
  cache_creation: { ephemeral_5m_input_tokens: K, ephemeral_1h_input_tokens: 0 },
};

console.log('r150 P 组:5.5 系列的费用');

// ── P2 只有内置表 ───────────────────────────────────────────
await check('P2 只有内置表:三个 5.5 模型都有价、数值正确、逐字命中(原来:haiku 未定价,opus / sonnet 借用 5 代的价)', async () => {
  useRemote({});
  for (const [model, v] of Object.entries(V55)) {
    expectPrice(model, { tier: 'offline', exact: true, ...v });
    const cost = computeCost(model, USAGE, provider);
    assert.ok(cost, `${model}:computeCost 返回了 null(界面显示未定价)`);
    near(cost.totalUsd, (v.in + v.out + v.cr + v.cw) * K / M, `${model} 四项各 1 万 token 的总额`);
    assert.equal(cost.unknownDimensions, undefined, `${model}:不应有未知维度`);
  }
});
await check('P2 只有内置表:带 [1m] 后缀、带日期后缀的 5.5 模型按 5.5 的价算(不是 5 代的价)', async () => {
  useRemote({});
  for (const [model, v] of Object.entries(V55)) {
    expectPrice(`${model}[1m]`, { tier: 'offline', ...v });
    expectPrice(`${model}-20260901`, { tier: 'offline', ...v });
  }
});
await check('P2 对照:内置表里既有模型的价不变(claude-opus-5 / sonnet-5 / haiku-4-5 / opus-4-7 / fable-5-1 / gpt-5.6-sol / kimi-k3)', async () => {
  useRemote({});
  expectPrice('claude-opus-5', { tier: 'offline', exact: true, in: 5, out: 25, cr: 0.5, cw: 6.25 });
  expectPrice('claude-sonnet-5', { tier: 'offline', exact: true, in: 2, out: 10, cr: 0.2, cw: 2.5 });
  expectPrice('claude-haiku-4-5', { tier: 'offline', exact: true, in: 1, out: 5, cr: 0.1, cw: 1.25 });
  expectPrice('claude-opus-4-7', { tier: 'offline', exact: true, in: 5, out: 25, cr: 0.5, cw: 6.25 });
  expectPrice('claude-fable-5-1', { tier: 'offline', exact: true, in: 10, out: 50, cr: 0.25, cw: 12.5 });
  expectPrice('gpt-5.6-sol', { tier: 'offline', exact: true, in: 4, out: 20, cr: 0.4, cw: 4 });
  expectPrice('kimi-k3', { tier: 'offline', exact: true, in: 20 / 7.2, out: 100 / 7.2, cr: 2 / 7.2, cw: 20 / 7.2 });
});

// ── R1 haiku 5.5 两档 ───────────────────────────────────────
await check('R1 haiku 5.5 单价:不知道提示量 / 不超过 10 万 → 0.1 / 0.5 / 0.01 / 0.125(1h 写 0.2);超过 10 万 → 0.5 / 2.5 / 0.05 / 0.625(1h 写 1)', async () => {
  useRemote({});
  expectPrice(HAIKU, { tier: 'offline', exact: true, ...HAIKU_BASE }, '不知道提示量');
  expectPrice(HAIKU, { tier: 'offline', exact: true, ...HAIKU_BASE }, '提示 5 万', 50_000);
  expectPrice(HAIKU, { tier: 'offline', exact: true, ...HAIKU_BASE }, '提示恰好 10 万(不算超过)', 100_000);
  expectPrice(HAIKU, { tier: 'offline', exact: true, ...HAIKU_LONG }, '提示 100001', 100_001);
  expectPrice(`${HAIKU}[1m]`, { tier: 'offline', ...HAIKU_LONG }, '带 [1m] 后缀、提示 30 万', 300_000);
  expectPrice(`${HAIKU}-20260901`, { tier: 'offline', ...HAIKU_LONG }, '带日期后缀、提示 30 万', 300_000);
  assert.deepEqual(four(HAIKU, 100_001).applied, [{ minPromptTokens: 100_000 }], '走高档时应写明适用条件');
  assert.deepEqual(four(HAIKU, 50_000).applied, [], '基础档没有适用条件');
});
await check('R1「提示 token」的口径 = 输入 + 缓存读 + 缓存写,三项相加;输出不算', async () => {
  useRemote({});
  // 输入 1000 + 缓存读 99500 = 100500 → 高档(只看输入的话会误判成基础档)
  let c = computeCost(HAIKU, { input_tokens: 1000, cache_read_input_tokens: 99_500, output_tokens: 2000 }, provider);
  near(c.totalUsd, (1000 * 0.5 + 99_500 * 0.05 + 2000 * 2.5) / M, '输入 1000 + 缓存读 99500');
  assert.deepEqual(c.appliedConditions, [{ minPromptTokens: 100_000 }]);
  // 输入 60000 + 缓存读 40000 = 恰好 100000 → 基础档
  c = computeCost(HAIKU, { input_tokens: 60_000, cache_read_input_tokens: 40_000, output_tokens: 2000 }, provider);
  near(c.totalUsd, (60_000 * 0.1 + 40_000 * 0.01 + 2000 * 0.5) / M, '输入 60000 + 缓存读 40000');
  assert.deepEqual(c.appliedConditions, []);
  // 缓存写也算提示:输入 500 + 写 100000 → 高档,写按高档的 5 分钟价
  c = computeCost(HAIKU, { input_tokens: 500, cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_5m_input_tokens: 100_000 } }, provider);
  near(c.totalUsd, (500 * 0.5 + 100_000 * 0.625) / M, '输入 500 + 缓存写 100000');
  // 1 小时档的写:高档 1、基础档 0.2
  c = computeCost(HAIKU, { input_tokens: 500, cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_1h_input_tokens: 100_000 } }, provider);
  near(c.breakdown.cacheWrite1h, 100_000 * 1 / M, '高档 1h 写');
  c = computeCost(HAIKU, { input_tokens: 500, cache_creation_input_tokens: 50_000, cache_creation: { ephemeral_1h_input_tokens: 50_000 } }, provider);
  near(c.breakdown.cacheWrite1h, 50_000 * 0.2 / M, '基础档 1h 写');
  // 只有输入就超过
  c = computeCost(HAIKU, { input_tokens: 200_000, output_tokens: 10 }, provider);
  near(c.totalUsd, (200_000 * 0.5 + 10 * 2.5) / M, '输入 200000');
  // 输出再多也不算提示
  c = computeCost(HAIKU, { input_tokens: 10, output_tokens: 300_000 }, provider);
  near(c.totalUsd, (10 * 0.1 + 300_000 * 0.5) / M, '输出 300000');
});
await check('R1 档位按每次调用各自判:一轮 3 次调用、每次提示 5 万(合计 15 万)→ 三次都是基础档,不因为合计超过 10 万就按高档', async () => {
  useRemote({});
  const one = { input_tokens: 1000, cache_read_input_tokens: 49_000, output_tokens: 500 };
  const message = {
    model: HAIKU, timestamp: '2026-10-13T08:00:00.000Z',
    usage: { input_tokens: 3000, cache_read_input_tokens: 147_000, output_tokens: 1500 },
    usageCalls: [0, 1, 2].map((i) => ({ at: `2026-10-13T08:00:0${i}.000Z`, usage: one })),
  };
  const c = computeCostForMessage(message, provider);
  assert.ok(c);
  near(c.totalUsd, 3 * (1000 * 0.1 + 49_000 * 0.01 + 500 * 0.5) / M, '三次基础档相加');
  assert.deepEqual(c.appliedConditions, []);
  assert.equal(c.tier, 'offline');
});
await check('R1 一轮里只有一次调用超过 10 万:只有那一次按高档,其余按基础档;逐次明细里没有时刻也照算', async () => {
  useRemote({});
  const big = { input_tokens: 2000, cache_read_input_tokens: 118_000, output_tokens: 800 };
  const small = { input_tokens: 1000, cache_read_input_tokens: 19_000, output_tokens: 300 };
  const message = {
    model: HAIKU,
    usage: { input_tokens: 4000, cache_read_input_tokens: 156_000, output_tokens: 1400 },
    usageCalls: [{ usage: small }, { usage: big }, { usage: small }],
  };
  const c = computeCostForMessage(message, provider);
  const want = (2000 * 0.5 + 118_000 * 0.05 + 800 * 2.5) / M + 2 * (1000 * 0.1 + 19_000 * 0.01 + 300 * 0.5) / M;
  near(c.totalUsd, want, '一次高档 + 两次基础档');
  assert.deepEqual(c.appliedConditions, [{ minPromptTokens: 100_000 }], '适用条件只写一次');
  assert.equal(c.unknownDimensions, undefined, '没有时刻不算"时段未知"(这个模型不分时段)');
});
await check('R1 没有逐次明细的记录按它自己的量判;逐次明细里有一项用量坏了 → 不抛,退回按这条记录的合计算', async () => {
  useRemote({});
  const usage = { input_tokens: 3000, cache_read_input_tokens: 147_000, output_tokens: 1500 };
  let c = computeCostForMessage({ model: HAIKU, usage }, provider);
  near(c.totalUsd, (3000 * 0.5 + 147_000 * 0.05 + 1500 * 2.5) / M, '单条记录提示 15 万 → 高档');
  c = computeCostForMessage({ model: HAIKU, usage, usageCalls: [{ usage: { input_tokens: 1000, output_tokens: 5 } }, { usage: null }] }, provider);
  near(c.totalUsd, (3000 * 0.5 + 147_000 * 0.05 + 1500 * 2.5) / M, '明细不全 → 按合计');
});
await check('R1 用量面板(按模型汇总的 token,没有单次提示量):haiku 5.5 按基础档算,不拿汇总量去判档', async () => {
  useRemote({});
  const r = aggregateCost(HAIKU, { input: 5 * M, output: 1 * M, cacheRead: 50 * M, cacheWrite: 0 }, provider);
  near(r.usd, 5 * 0.1 + 1 * 0.5 + 50 * 0.01, '汇总 500 万输入 / 100 万输出 / 5000 万缓存读');
});
await check('R1 对照:别的模型不分档 —— 提示再大也是同一组价(opus 5.5、sonnet 5.5、haiku 4.5、gpt-5.6-sol)', async () => {
  useRemote({});
  expectPrice('claude-opus-5-5', { tier: 'offline', ...V55['claude-opus-5-5'] }, 'opus 5.5 提示 50 万', 500_000);
  expectPrice('claude-sonnet-5-5', { tier: 'offline', ...V55['claude-sonnet-5-5'] }, 'sonnet 5.5 提示 50 万', 500_000);
  expectPrice('claude-haiku-4-5', { tier: 'offline', in: 1, out: 5, cr: 0.1, cw: 1.25 }, 'haiku 4.5 提示 50 万', 500_000);
  expectPrice('gpt-5.6-sol', { tier: 'offline', in: 4, out: 20, cr: 0.4, cw: 4 }, 'gpt-5.6-sol 提示 50 万', 500_000);
  assert.deepEqual(four('claude-opus-5-5', 500_000).applied, []);
});

// ── R2 Claude 模型:内置表有就用内置表 ────────────────────────
await check('R2 内置表有这个模型时用内置表:远程表里的数不同也不取(三个 5.5、opus-4-7、sonnet-5、opus-5;带 [1m]、带日期的写法同样)', async () => {
  useRemote({
    'anthropic/claude-opus-5.5': { input: 40, output: 200, cacheRead: 2, cacheWrite: 50 },
    'anthropic/claude-sonnet-5.5': { input: 21, output: 101, cacheRead: 1.1, cacheWrite: 25.5 },
    'anthropic/claude-haiku-5.5': { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },   // 远程表只有高档价
    'anthropic/claude-opus-4.7': { input: 51, output: 251, cacheRead: 5.1, cacheWrite: 6.3 },
    'anthropic/claude-sonnet-5': { input: 31, output: 151, cacheRead: 3.1, cacheWrite: 3.8 },
    'anthropic/claude-opus-5': { input: 99, output: 999, cacheRead: 9, cacheWrite: 99 },
    'claude-sonnet-5-5': { input: 22, output: 102, cacheRead: 1.2, cacheWrite: 26 },                 // 连逐字同名的键也不取
  });
  for (const [model, v] of Object.entries(V55)) {
    expectPrice(model, { tier: 'offline', exact: true, ...v });
    expectPrice(`${model}[1m]`, { tier: 'offline', ...v });
    expectPrice(`${model}-20260901`, { tier: 'offline', ...v });
    expectPrice(`${model}-20260901[1m]`, { tier: 'offline', ...v });
  }
  expectPrice('claude-opus-4-7', { tier: 'offline', exact: true, in: 5, out: 25, cr: 0.5, cw: 6.25 });
  expectPrice('claude-sonnet-5', { tier: 'offline', exact: true, in: 2, out: 10, cr: 0.2, cw: 2.5 });
  expectPrice('claude-opus-5', { tier: 'offline', exact: true, in: 5, out: 25, cr: 0.5, cw: 6.25 });
  // haiku 5.5 短提示的一次调用:按基础档算(远程表那组高档价不许顶上来)
  const cost = computeCost(HAIKU, USAGE, provider);
  near(cost.totalUsd, (0.1 + 0.5 + 0.01 + 0.125) * K / M, 'haiku 5.5 四项各 1 万 token');
});
await check('R2 内置表没有这个模型、远程表有它的另一种写法 → 取远程表的数,不去猜前缀(远程表里的短键、内置表里的上一代都不借)', async () => {
  useRemote({
    'anthropic/claude-opus-5.9': { input: 7, output: 9, cacheRead: 0.7, cacheWrite: 8 },
    'claude-opus-5': { input: 99, output: 999, cacheRead: 9, cacheWrite: 99 },      // 远程表里能被 startsWith 猜中的短键
    'anthropic/claude-haiku-6': { input: 0.3, output: 1.3, cacheRead: 0.03, cacheWrite: 0.4 },
  });
  const want = { tier: 'official-compat', in: 7, out: 9, cr: 0.7, cw: 8 };
  for (const model of [
    'claude-opus-5-9', 'claude-opus-5-9[1m]', 'claude-opus-5-9-20260901', 'claude-opus-5-9-20260901[1m]',
    'claude-opus-5.9', 'anthropic/claude-opus-5-9', 'anthropic/claude-opus-5.9', 'anthropic/claude-opus-5.9[1m]',
  ]) expectPrice(model, want, `写法 ${model}`);
  // 只差写法(前缀 / 点与连字符)算等价命中;剥了日期后缀或 [1m] 的沿用原有口径,记为"靠规则猜到"
  assert.equal(four('claude-opus-5-9').exact, true);
  assert.equal(four('claude-opus-5.9').exact, true);
  assert.equal(four('claude-opus-5-9-20260901').exact, false);
  expectPrice('claude-haiku-6', { tier: 'official-compat', exact: true, in: 0.3, out: 1.3, cr: 0.03, cw: 0.4 });
});
await check('R2 反过来也认:远程表的键是连字符、不带前缀的写法,模型名是 anthropic/…5.9 的写法', async () => {
  useRemote({ 'claude-opus-5-9': { input: 7, output: 9, cacheRead: 0.7, cacheWrite: 8 } });
  expectPrice('anthropic/claude-opus-5.9', { tier: 'official-compat', in: 7, out: 9, cr: 0.7, cw: 8 });
  expectPrice('claude-opus-5-9', { tier: 'official-compat', exact: true, in: 7, out: 9, cr: 0.7, cw: 8 });
});
await check('R2 不串型号:远程表只有 5 代时,内置表没有的 claude-opus-5-9 不借它的价;内置表有的 5.5 / 5 代各用各的', async () => {
  useRemote({ 'anthropic/claude-opus-5': { input: 99, output: 999, cacheRead: 9, cacheWrite: 99 } });
  expectPrice('claude-opus-5-5', { tier: 'offline', exact: true, ...V55['claude-opus-5-5'] });
  expectPrice('claude-opus-5', { tier: 'offline', exact: true, in: 5, out: 25, cr: 0.5, cw: 6.25 });
  // 内置表、远程表都没有 5.9:最后才是内置表的最长前缀(记为猜到)
  expectPrice('claude-opus-5-9', { tier: 'offline', exact: false, in: 5, out: 25, cr: 0.5, cw: 6.25 });
});
await check('R2 模型名本身带 anthropic/ 前缀(经聚合平台接入时的写法):内置表里没有这个写法,按远程表里那个键的价', async () => {
  useRemote({ 'anthropic/claude-opus-5.5': { input: 40, output: 200, cacheRead: 2, cacheWrite: 50 } });
  expectPrice('anthropic/claude-opus-5.5', { tier: 'official-compat', exact: true, in: 40, out: 200, cr: 2, cw: 50 });
});
await check('R2 优先级不变:用户自填单价 > 官方报价层 > 内置表(内置表有这个模型)/ 远程表(内置表没有)', async () => {
  useRemote({ ...REMOTE_55, 'anthropic/claude-opus-5.9': { input: 7, output: 9, cacheRead: 0.7, cacheWrite: 8 } });
  setUserPrices([{ isCurrent: true, modelPrices: { 'claude-opus-5-5': { in: 7, out: 9 }, 'claude-opus-5-9': { in: 3, out: 4 } } }], false);
  assert.equal(resolvePrice('claude-opus-5-5', { provider }).tier, 'manual', '用户填了价就用用户的');
  assert.equal(resolvePrice('claude-opus-5-9', { provider }).tier, 'manual');
  setUserPrices([], false);
  assert.equal(resolvePrice('claude-opus-5-5', { provider }).tier, 'offline', '清掉用户价后:内置表有 → 内置表');
  assert.equal(resolvePrice('claude-opus-5-9', { provider }).tier, 'official-compat', '清掉用户价后:内置表没有 → 远程表');
  const quote = (modelId, input) => ({
    quoteId: `q-${modelId}`, provider: 'anthropic', presetIds: ['anthropic-official'], modelId, displayName: `X ${modelId}`, protocol: null,
    market: 'global', currency: 'USD', unit: 'per 1M tokens',
    prices: { input, output: 20.5, cacheRead: 0.25, cacheWrite5m: 5.5, cacheWrite1h: 9 },
    conditions: null, validFrom: null, validTo: null, sourceUrl: null, sourceKind: 'official', fetchedAt: null, parserVersion: 't', status: 'fresh',
  });
  useRemote(REMOTE_55, [quote('claude-opus-5-5', 4.5), quote(HAIKU, 0.15)]);
  const official = resolvePrice('claude-opus-5-5', { provider });
  assert.equal(official.tier, 'official-quote', '官方报价层有这个模型时仍然先用它');
  assert.equal(official.prices.input, 4.5);
  assert.equal(resolvePrice(HAIKU, { provider, fullPromptTokens: 300_000 }).prices.input, 0.15, '官方报价层命中时不套内置表的分档');
});
await check('P1 非 Claude 模型的命中结果不变:带 / 不带厂商前缀、点与连字符不同的键一律不互认(维持原来的回退链)', async () => {
  useRemote({
    ...REMOTE_55,
    'gpt-5.6-terra': { input: 2.5, output: 12.5, cacheRead: 0.25, cacheWrite: 2.5 },          // 逐字键:照旧命中
    'openai/gpt-5.6-sol': { input: 99, output: 999, cacheRead: 9, cacheWrite: 99 },             // 只有带前缀的键
    'gpt-5.6-luna': { input: 0.3, output: 1.3, cacheRead: 0.03, cacheWrite: 0.3 },              // 只有不带前缀的键
    'moonshotai/kimi-k3': { input: 99, output: 999, cacheRead: 9, cacheWrite: 99 },
    'google/gemini-2.5-pro': { input: 99, output: 999, cacheRead: 9, cacheWrite: 99 },
    'deepseek/deepseek-v3-1': { input: 99, output: 999, cacheRead: 9, cacheWrite: 99 },         // 点 / 连字符写法不同
    'step-3': { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
    'step-3.7-flash': { input: 2, output: 2, cacheRead: 0.2, cacheWrite: 2 },
    'gpt-5.5': { input: 55, output: 555, cacheRead: 5.5, cacheWrite: 55 },                      // 内置表也有的非 Claude 模型:远程表逐字键照旧优先
  });
  expectPrice('gpt-5.6-terra', { tier: 'official-compat', exact: true, in: 2.5, out: 12.5, cr: 0.25, cw: 2.5 });
  expectPrice('gpt-5.5', { tier: 'official-compat', exact: true, in: 55, out: 555, cr: 5.5, cw: 55 });
  // 模型不带前缀、远程表只有带前缀的键 → 原来就不命中远程表,走内置表
  expectPrice('gpt-5.6-sol', { tier: 'offline', exact: true, in: 4, out: 20, cr: 0.4, cw: 4 });
  expectPrice('kimi-k3', { tier: 'offline', exact: true, in: 20 / 7.2, out: 100 / 7.2, cr: 2 / 7.2, cw: 20 / 7.2 });
  expectPrice('gemini-2.5-pro', { tier: 'offline', exact: true, in: 1.25, out: 10, cr: 0.125, cw: 1.25 * 1.25 });
  expectPrice('deepseek-v3.1', { tier: 'offline', exact: true, in: 0.14, out: 0.28, cr: 0.0028, cw: 0.14 });
  // 模型带前缀、远程表只有不带前缀的键 → 原来就不命中远程表,走内置表(剥命名空间,记为猜到)
  expectPrice('openai/gpt-5.6-luna', { tier: 'offline', exact: false, in: 0.2, out: 1.2, cr: 0.02, cw: 0.2 });
  // 最长前缀兜底照旧
  expectPrice('step-3.7-flash-preview', { tier: 'official-compat', exact: false, in: 2, out: 2, cr: 0.2, cw: 2 });
  expectPrice('gpt-5.6-terra-20260901', { tier: 'official-compat', exact: false, in: 2.5, out: 12.5, cr: 0.25, cw: 2.5 });
});
await check('P1 对照:远程表里是不带前缀的旧式 Claude 键、内置表没有这个模型时,最长前缀兜底照旧(claude-3-5-haiku-latest 命中长键)', async () => {
  useRemote({
    ...REMOTE_55,
    'claude-3-5': { input: 100, output: 100, cacheRead: 10, cacheWrite: 125 },
    'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  });
  expectPrice('claude-3-5-haiku-latest', { tier: 'official-compat', exact: false, in: 0.8, out: 4, cr: 0.08, cw: 1 });
  expectPrice('claude-3-5-sonnet-x', { tier: 'official-compat', exact: false, in: 100, out: 100, cr: 10, cw: 125 });
});

// ── P3 / R3 裸别名 ──────────────────────────────────────────
await check('P3 / R3 裸别名:opus / sonnet / haiku 按 5.5 的价算(原来指向 4.7 / 4.6 / 4.5);fable 按 5.1 的价算(原来指向 5)', async () => {
  useRemote({});
  expectPrice('opus', { tier: 'offline', ...V55['claude-opus-5-5'] });
  expectPrice('sonnet', { tier: 'offline', ...V55['claude-sonnet-5-5'] });
  expectPrice('haiku', { tier: 'offline', ...HAIKU_BASE });
  expectPrice('haiku', { tier: 'offline', ...HAIKU_LONG }, '别名 haiku、提示 30 万', 300_000);
  expectPrice('fable', { tier: 'offline', in: 10, out: 50, cr: 0.25, cw: 12.5 });
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
