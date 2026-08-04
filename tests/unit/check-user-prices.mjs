// R3:用户在 provider 表单里自填的每模型单价,必须赢过所有内置来源。
// Run: node tests/unit/check-user-prices.mjs
// 为什么要有这层:内置价表永远算不准两类情况,而只有用户自己知道实付多少 ——
//   ① 中转站:同一个 gpt-5.6-sol 走中转是服务商自定价(通常低于官网),jsonl 里没有
//      baseURL/provider 字段,事后无法反推 → 只能由用户填;
//   ② 套餐包月:付的是月费不是 token 费,按单价算出的金额没有意义 → 只显示用量。
// 单位一律【人民币元 / 每百万 token】,内部按 1 USD = 7.2 CNY 折成 USD 存。
import assert from 'node:assert/strict';

const CNY = 7.2;
// REMOTE 层(LiteLLM 下发表)用 localStorage 缓存注入,用来验证"用户价赢过 REMOTE"。
const REMOTE_SEED = {
  'gpt-5.6-sol': { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
};
globalThis.localStorage = {
  getItem: (k) => (k === 'cgui-litellm-prices' ? JSON.stringify(REMOTE_SEED) : null),
  setItem: () => {},
};

const { computeCost, isPlanBilling, setUserPrices, userModelPrice } =
  await import('../../client/src/utils/pricing.js');

const IN1M = { input_tokens: 1_000_000 };
const IO1M = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const P = (modelPrices, isCurrent = false) => ({ modelPrices, isCurrent });

// ① 用户价赢过 REMOTE(LiteLLM 下发表)。REMOTE 给 999,用户填 ¥18/¥108。
setUserPrices([P({ 'gpt-5.6-sol': { in: 18, out: 108 } })]);
const relay = computeCost('gpt-5.6-sol', IO1M);
near(relay.totalUsd, (18 + 108) / CNY, '用户价没赢过 REMOTE');
assert.equal(relay.source, 'user', 'computeCost 应标注 source=user 供显示口径切换');

// ② 用户价赢过内置手抄表 PRICES(claude-opus-5 内置 $5/$25)。
setUserPrices([P({ 'claude-opus-5': { in: 7.2, out: 14.4 } })]);
near(computeCost('claude-opus-5', IO1M).totalUsd, 1 + 2, '用户价没赢过内置表');

// ③ 缓存价留空 → 按默认倍率 cacheRead=0.1×in、cacheWrite=1.25×in(与 cny()/usd() 同口径)。
setUserPrices([P({ 'my-model': { in: 72, out: 144 } })]);
const dflt = computeCost('my-model', {
  input_tokens: 1_000_000, output_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
});
near(dflt.totalUsd, 10 + 20 + 1 + 12.5, '缓存价缺省倍率不对(应 0.1×in / 1.25×in)');

// ④ 缓存价显式填了就用填的,不套倍率。
setUserPrices([P({ 'my-model': { in: 72, out: 144, cacheRead: 7.2, cacheWrite: 36 } })]);
const explicit = computeCost('my-model', {
  input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
});
near(explicit.totalUsd, 10 + 1 + 5, '显式缓存价没生效');

// ⑤ 只填了一项 → 未填项回落内置表同项(不是 0)。claude-opus-5 内置 $5/$25。
setUserPrices([P({ 'claude-opus-5': { in: 7.2 } })]);
near(computeCost('claude-opus-5', IO1M).totalUsd, 1 + 25, '未填的 output 应回落内置表 $25');

// ⑥ plan: true(套餐包月)→ computeCost 返回 null(只显示用量),isPlanBilling 为真。
setUserPrices([P({ 'my-plan-model': { plan: true } })]);
assert.equal(computeCost('my-plan-model', IO1M), null, '套餐标记应使 computeCost 返回 null');
assert.equal(isPlanBilling(null, 'my-plan-model'), true, '用户标记的套餐没被 isPlanBilling 认出');

// ⑦ 用户标记优先于内置 Kimi 套餐白名单:k3 按量付费时填了价 → 必须显示金额。
setUserPrices([P({ k3: { in: 20, out: 100 } })]);
assert.equal(isPlanBilling(null, 'k3'), false, '用户为 k3 填了单价,不该再被白名单藏成套餐');
near(computeCost('k3', IO1M).totalUsd, (20 + 100) / CNY, 'k3 用户价没生效');
// 反向:没填 k3 时白名单照旧生效(零回归)。
setUserPrices([]);
assert.equal(isPlanBilling(null, 'k3'), true, '无用户价时 Kimi 套餐白名单不该失效');

// ⑧ 用户标记优先于官方订阅判据:订阅态下为 claude 模型填了价 → 照常显示。
const SUB = { providerHint: 'anthropic', baseUrl: '', hasAuthKey: false };
setUserPrices([P({ 'claude-opus-5': { in: 7.2, out: 14.4 } })]);
assert.equal(isPlanBilling(SUB, 'claude-opus-5'), false, '用户显式填价应赢过订阅判据');
near(computeCost('claude-opus-5', IO1M, SUB).totalUsd, 1 + 2, '订阅态下用户价没生效');

// ⑨ 同一 model id 两个 provider 填了不同价 → 当前激活的赢;没有激活的取第一个匹配。
setUserPrices([
  P({ 'shared-id': { in: 72, out: 0 } }),                 // 非激活,列表第一个
  P({ 'shared-id': { in: 7.2, out: 0 } }, true),          // 激活
]);
near(computeCost('shared-id', IN1M).totalUsd, 1, '同 id 冲突时应取当前激活 provider 的价');
setUserPrices([
  P({ 'shared-id': { in: 72, out: 0 } }),
  P({ 'shared-id': { in: 7.2, out: 0 } }),
]);
near(computeCost('shared-id', IN1M).totalUsd, 10, '都不激活时应取第一个匹配');

// ⑩ 精确匹配 model id,不做前缀/去后缀兜底(免得填 gpt-5.6 把 gpt-5.6-luna 一起计价)。
setUserPrices([P({ 'gpt-5.6': { in: 720, out: 720 } })]);
assert.equal(userModelPrice('gpt-5.6-luna'), null, '用户价不该按前缀外溢到别的 model id');
near(computeCost('gpt-5.6-luna', IO1M).totalUsd, 0.2 + 1.2, '前缀外溢污染了内置价');

// ⑪ 非法/空条目一律忽略(回落内置表),不能算成 0。
for (const bad of [{}, { in: -1 }, { in: 'abc' }, { in: null, out: null }, null, 'x']) {
  setUserPrices([P({ 'claude-opus-5': bad })]);
  near(computeCost('claude-opus-5', IN1M).totalUsd, 5, `非法条目 ${JSON.stringify(bad)} 应被忽略`);
}

// ⑫ 零回归:没有任何用户价时,一切与改动前一致(REMOTE 优先 → 内置表 → 别名)。
setUserPrices([]);
near(computeCost('gpt-5.6-sol', IN1M).totalUsd, 999, 'REMOTE 层被破坏');
near(computeCost('claude-opus-5', IN1M).totalUsd, 5, '内置表层被破坏');
assert.equal(computeCost('claude-opus-5', IN1M).source, 'table', '无用户价时 source 应为 table');

// ⑬ 后端校验:sanitizeModelPrices 拒绝非法输入、丢空条目、封上界与条目数。
const { sanitizeModelPrices } = await import('../../server/routes/settings.js');
assert.deepEqual(sanitizeModelPrices({ a: { in: 1, out: 2 } }), { a: { in: 1, out: 2 } }, '合法条目应原样保留');
assert.deepEqual(sanitizeModelPrices({ a: { plan: true, in: 9 } }), { a: { plan: true } }, '套餐条目只留 plan 标记');
assert.equal(sanitizeModelPrices({ a: { in: -1 } }), null, '负数应被拒');
assert.equal(sanitizeModelPrices({ a: { in: Infinity } }), null, '非有限数应被拒');
assert.equal(sanitizeModelPrices({ a: { in: 1e9 } }), null, '超上界应被拒');
assert.equal(sanitizeModelPrices({ a: {} }), null, '全空条目应删键');
assert.equal(sanitizeModelPrices({ ['x'.repeat(300)]: { in: 1 } }), null, '超长 model id 应被拒');
assert.equal(sanitizeModelPrices('nope'), null, '非对象应返回 null');
assert.equal(sanitizeModelPrices([{ in: 1 }]), null, '数组应返回 null');
{
  const many = {};
  for (let i = 0; i < 300; i++) many[`m${i}`] = { in: 1, out: 1 };
  assert.equal(Object.keys(sanitizeModelPrices(many)).length, 200, '条目数应封在 200');
  // 部分合法 + 部分非法 → 只留合法的
  assert.deepEqual(sanitizeModelPrices({ ok: { in: 1 }, bad: { in: -3 } }), { ok: { in: 1 } }, '非法条目应被逐条丢弃');
}

console.log('check-user-prices OK');
