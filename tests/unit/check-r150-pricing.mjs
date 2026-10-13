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
// 数值(美元 / 百万 token:输入 / 输出 / 缓存读 / 缓存写 5m)取任务书给的那组:
//   opus 5.5 = 4 / 20 / 0.2 / 5;sonnet 5.5 = 2 / 10 / 0.1 / 2.5;haiku 5.5 = 0.5 / 2.5 / 0.05 / 0.625。
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
const { computeCost, resolvePrice, setUserPrices } = await import(root + 'client/src/utils/pricing.js');

const provider = { providerHint: 'anthropic', model: null, hasAuthKey: true };   // 按量付费(不是订阅)
const M = 1e6;
const near = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg}:实得 ${a},应为 ${b}`);
/** 换一份远程价格表(官方兼容视图 prices);quotes 为空 = 官方报价层没有命中。 */
const useRemote = (prices, quotes = []) => setPricingCatalog({ source: 'official-sources', prices, quotes, providers: [], refresh: null });
const four = (model) => {
  const r = resolvePrice(model, { provider, promptTokens: 1000 });
  return r.ok ? { tier: r.tier, exact: r.matchedExactly, in: r.prices.input, out: r.prices.output, cr: r.prices.cacheRead, cw: r.prices.cacheWrite5m } : { tier: null, reason: r.reason };
};
const expectPrice = (model, want, msg = model) => {
  const got = four(model);
  assert.equal(got.tier, want.tier, `${msg}:命中的层(实得 ${JSON.stringify(got)})`);
  near(got.in, want.in, `${msg} 输入价`);
  near(got.out, want.out, `${msg} 输出价`);
  near(got.cr, want.cr, `${msg} 缓存读价`);
  near(got.cw, want.cw, `${msg} 缓存写(5m)价`);
  if (want.exact !== undefined) assert.equal(got.exact, want.exact, `${msg}:是否逐字 / 等价命中`);
};

const V55 = {
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.2, cw: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.1, cw: 2.5 },
  'claude-haiku-5-5': { in: 0.5, out: 2.5, cr: 0.05, cw: 0.625 },
};
// 远程表里现有的写法与数值(主会话实测)
const REMOTE_55 = {
  'anthropic/claude-opus-5.5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'anthropic/claude-haiku-5.5': { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
};
// 一次调用:各 100 万 token,缓存写全部是 5 分钟档
const USAGE = {
  input_tokens: M, output_tokens: M, cache_read_input_tokens: M, cache_creation_input_tokens: M,
  cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: 0 },
};

console.log('r150 P 组:5.5 系列的费用');

// ── P2 只有内置表 ───────────────────────────────────────────
await check('P2 只有内置表:三个 5.5 模型都有价、数值正确、逐字命中(原来:haiku 未定价,opus / sonnet 借用 5 代的价)', async () => {
  useRemote({});
  for (const [model, v] of Object.entries(V55)) {
    expectPrice(model, { tier: 'offline', exact: true, ...v });
    const cost = computeCost(model, USAGE, provider);
    assert.ok(cost, `${model}:computeCost 返回了 null(界面显示未定价)`);
    near(cost.totalUsd, v.in + v.out + v.cr + v.cw, `${model} 四项各 100 万 token 的总额`);
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

// ── P1 有远程表 ─────────────────────────────────────────────
await check('P1 有远程表(键为 anthropic/claude-*-5.5):三个 5.5 模型命中远程表、数值正确、算得出总额', async () => {
  useRemote(REMOTE_55);
  for (const [model, v] of Object.entries(V55)) {
    expectPrice(model, { tier: 'official-compat', exact: true, ...v });
    const cost = computeCost(model, USAGE, provider);
    assert.ok(cost, `${model}:computeCost 返回了 null`);
    assert.equal(cost.tier, 'official-compat');
    near(cost.totalUsd, v.in + v.out + v.cr + v.cw, `${model} 四项各 100 万 token 的总额`);
  }
});
await check('P1 防假绿:远程表里的数与内置表不同时,取的是远程表的数(证明真的命中了远程表)', async () => {
  useRemote({
    'anthropic/claude-opus-5.5': { input: 40, output: 200, cacheRead: 2, cacheWrite: 50 },
    'anthropic/claude-sonnet-5.5': { input: 21, output: 101, cacheRead: 1.1, cacheWrite: 25.5 },
    'anthropic/claude-haiku-5.5': { input: 7, output: 9, cacheRead: 0.7, cacheWrite: 8 },
  });
  expectPrice('claude-opus-5-5', { tier: 'official-compat', in: 40, out: 200, cr: 2, cw: 50 });
  expectPrice('claude-sonnet-5-5', { tier: 'official-compat', in: 21, out: 101, cr: 1.1, cw: 25.5 });
  expectPrice('claude-haiku-5-5', { tier: 'official-compat', in: 7, out: 9, cr: 0.7, cw: 8 });
});
await check('P1 同一个模型的各种写法都命中远程表的同一条:[1m] 后缀、日期后缀、点写法、带 anthropic/ 前缀', async () => {
  useRemote({ 'anthropic/claude-opus-5.5': { input: 40, output: 200, cacheRead: 2, cacheWrite: 50 } });
  const want = { tier: 'official-compat', in: 40, out: 200, cr: 2, cw: 50 };
  for (const model of [
    'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5-5-20260901', 'claude-opus-5-5-20260901[1m]',
    'claude-opus-5.5', 'anthropic/claude-opus-5-5', 'anthropic/claude-opus-5.5', 'anthropic/claude-opus-5.5[1m]',
  ]) expectPrice(model, want, `写法 ${model}`);
  // 只差写法(前缀 / 点与连字符)算等价命中;剥了日期后缀或 [1m] 的沿用原有口径,记为"靠规则猜到"
  assert.equal(four('claude-opus-5-5').exact, true);
  assert.equal(four('claude-opus-5.5').exact, true);
  assert.equal(four('claude-opus-5-5-20260901').exact, false);
});
await check('P1 反过来也认:远程表的键是连字符、不带前缀的写法,模型名是 anthropic/…5.5 的写法', async () => {
  useRemote({ 'claude-haiku-5-5': { input: 7, output: 9, cacheRead: 0.7, cacheWrite: 8 } });
  expectPrice('anthropic/claude-haiku-5.5', { tier: 'official-compat', in: 7, out: 9, cr: 0.7, cw: 8 });
  expectPrice('claude-haiku-5-5', { tier: 'official-compat', exact: true, in: 7, out: 9, cr: 0.7, cw: 8 });
});
await check('P1 既有 Claude 模型同样认得(远程表键 anthropic/claude-opus-4.7、anthropic/claude-sonnet-5)', async () => {
  useRemote({
    'anthropic/claude-opus-4.7': { input: 51, output: 251, cacheRead: 5.1, cacheWrite: 6.3 },
    'anthropic/claude-sonnet-5': { input: 31, output: 151, cacheRead: 3.1, cacheWrite: 3.8 },
  });
  expectPrice('claude-opus-4-7', { tier: 'official-compat', in: 51, out: 251, cr: 5.1, cw: 6.3 });
  expectPrice('claude-sonnet-5', { tier: 'official-compat', in: 31, out: 151, cr: 3.1, cw: 3.8 });
});
await check('P1 不串型号:远程表只有 5 代(anthropic/claude-opus-5)时,claude-opus-5-5 不借它的价,落到内置表的 5.5', async () => {
  useRemote({ 'anthropic/claude-opus-5': { input: 99, output: 999, cacheRead: 9, cacheWrite: 99 } });
  expectPrice('claude-opus-5-5', { tier: 'offline', exact: true, ...V55['claude-opus-5-5'] });
  expectPrice('claude-opus-5', { tier: 'official-compat', in: 99, out: 999, cr: 9, cw: 99 });
  // 反向:远程表只有 5.5 时,5 代不借 5.5 的价
  useRemote(REMOTE_55);
  expectPrice('claude-opus-5', { tier: 'offline', exact: true, in: 5, out: 25, cr: 0.5, cw: 6.25 });
  expectPrice('claude-sonnet-5', { tier: 'offline', exact: true, in: 2, out: 10, cr: 0.2, cw: 2.5 });
});
await check('P1 优先级不变:用户自填单价 > 官方报价层 > 远程表', async () => {
  useRemote(REMOTE_55);
  setUserPrices([{ isCurrent: true, modelPrices: { 'claude-opus-5-5': { in: 7, out: 9 } } }], false);
  const manual = resolvePrice('claude-opus-5-5', { provider });
  assert.equal(manual.tier, 'manual', '用户填了价就用用户的');
  assert.equal(manual.prices.input, 7);
  setUserPrices([], false);
  assert.equal(resolvePrice('claude-opus-5-5', { provider }).tier, 'official-compat', '清掉用户价后回到远程表');
  useRemote(REMOTE_55, [{
    quoteId: 'q-opus55', provider: 'anthropic', presetIds: ['anthropic-official'], modelId: 'claude-opus-5-5', displayName: 'X', protocol: null,
    market: 'global', currency: 'USD', unit: 'per 1M tokens',
    prices: { input: 4.5, output: 20.5, cacheRead: 0.25, cacheWrite5m: 5.5, cacheWrite1h: 9 },
    conditions: null, validFrom: null, validTo: null, sourceUrl: null, sourceKind: 'official', fetchedAt: null, parserVersion: 't', status: 'fresh',
  }]);
  const official = resolvePrice('claude-opus-5-5', { provider });
  assert.equal(official.tier, 'official-quote', '官方报价层有这个模型时仍然先用它');
  assert.equal(official.prices.input, 4.5);
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
  });
  expectPrice('gpt-5.6-terra', { tier: 'official-compat', exact: true, in: 2.5, out: 12.5, cr: 0.25, cw: 2.5 });
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
await check('P1 对照:远程表里是不带前缀的旧式 Claude 键时,最长前缀兜底照旧(claude-3-5-haiku-latest 命中长键)', async () => {
  useRemote({
    ...REMOTE_55,
    'claude-3-5': { input: 100, output: 100, cacheRead: 10, cacheWrite: 125 },
    'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  });
  expectPrice('claude-3-5-haiku-latest', { tier: 'official-compat', exact: false, in: 0.8, out: 4, cr: 0.08, cw: 1 });
  expectPrice('claude-3-5-sonnet-x', { tier: 'official-compat', exact: false, in: 100, out: 100, cr: 10, cw: 125 });
});

// ── P3 裸别名 ───────────────────────────────────────────────
await check('P3 裸别名 opus / sonnet / haiku 按 5.5 的价算(原来指向 4.7 / 4.6 / 4.5);fable 不变', async () => {
  useRemote({});
  expectPrice('opus', { tier: 'offline', ...V55['claude-opus-5-5'] });
  expectPrice('sonnet', { tier: 'offline', ...V55['claude-sonnet-5-5'] });
  expectPrice('haiku', { tier: 'offline', ...V55['claude-haiku-5-5'] });
  expectPrice('fable', { tier: 'offline', in: 10, out: 50, cr: 1, cw: 12.5 });
});

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
