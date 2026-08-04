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

const { computeCost, isPlanBilling, setUserPrices, userModelPrice, costTitle } =
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

// ⑬ 显示口径:三处费用显示共用的说明文案,按来源切换措辞(用户价不再说"按官网价估算")。
setUserPrices([P({ 'my-model': { in: 7.2, out: 7.2 } })]);
assert.match(costTitle(computeCost('my-model', IN1M)), /按你为该模型填写的单价/, '用户价的说明文案没切换');
setUserPrices([]);
assert.match(costTitle(computeCost('claude-opus-5', IN1M)), /官网价目/, '内置价仍应说明是按官网价估算');
assert.equal(costTitle(null), '', '无 cost 时不产生文案');

// ⑮ R5-c:查找前归一化 model id(trim / 小写 / 剥 [1m] 后缀 / 剥命名空间前缀)。
// 原先是纯精确匹配,而同一个模型在历史里两种形态并存:'gpt-5.6-sol' 3071 条 +
// 'openai/gpt-5.6-sol' 29 条、'kimi-k3' + 'moonshotai/kimi-k3' 63 条。填了单价后带前缀的
// 那部分**静默**按官网价算,用户看不出来。
setUserPrices([P({ 'gpt-5.6-sol': { in: 18, out: 108 } })]);
near(computeCost('openai/gpt-5.6-sol', IO1M).totalUsd, (18 + 108) / CNY, '带命名空间的 id 没命中用户价');
// 反向:表单里填的带前缀,历史里是裸 id。
setUserPrices([P({ 'moonshotai/kimi-k3': { in: 7.2, out: 7.2 } })]);
near(computeCost('kimi-k3', IO1M).totalUsd, 2, '表单填带前缀 id 时,裸 id 没命中');
// [1m] 是 CLI 通用的 1M 上下文后缀(同一个模型)。内置 Kimi 套餐白名单特意留了 (\[1m\])?,
// 用户价原先不认 → "给 k3 填按量单价盖过套餐白名单"在 1M 会话里失效。
setUserPrices([P({ k3: { in: 20, out: 100 } })]);
assert.equal(isPlanBilling(null, 'k3[1m]'), false, 'k3[1m] 没命中用户价,仍被套餐白名单藏掉');
near(computeCost('k3[1m]', IO1M).totalUsd, (20 + 100) / CNY, 'k3[1m] 的用户价没生效');
// 无用户价时,[1m] 仍走内置白名单(零回归)。
setUserPrices([]);
assert.equal(isPlanBilling(null, 'k3[1m]'), true, '无用户价时 k3[1m] 应仍是套餐档');
// 空白与大小写。
setUserPrices([P({ '  Claude-Opus-5 ': { in: 7.2, out: 14.4 } })]);
near(computeCost('claude-opus-5', IO1M).totalUsd, 1 + 2, 'trim / 小写归一没生效');
// 归一化后为空的键直接丢弃,不能变成"匹配一切"。
setUserPrices([P({ '/': { in: 720, out: 720 } })]);
assert.equal(userModelPrice('claude-opus-5'), null, '空键不该匹配任何 model');
near(computeCost('claude-opus-5', IO1M).totalUsd, 5 + 25, '空键污染了内置价');

// ⑯ R5-c 红线:归一化**不许**顺带放开去日期后缀 / 最长前缀兜底(⑩ 那条理由至今成立)。
setUserPrices([P({ 'gpt-5.6': { in: 720, out: 720 } })]);
assert.equal(userModelPrice('gpt-5.6-luna'), null, '用户价按前缀外溢到了别的 model id');
assert.equal(userModelPrice('openai/gpt-5.6-luna'), null, '剥完命名空间后又按前缀外溢了');
near(computeCost('gpt-5.6-luna', IO1M).totalUsd, 0.2 + 1.2, '前缀外溢污染了内置价');
setUserPrices([P({ 'claude-sonnet-4-5': { in: 720, out: 720 } })]);
assert.equal(userModelPrice('claude-sonnet-4-5-20250929'), null, '不该做去日期后缀兜底');
near(computeCost('claude-sonnet-4-5-20250929', IO1M).totalUsd, 3 + 15, '去日期后缀兜底污染了内置价');

// ⑱ R5-c 的另一条红线:剥命名空间**不许**把内置表刻意区分的两个模型合并。
// 'openai/gpt-oss-120b' 是 Groq($0.15/$0.60),'gpt-oss-120b' 是 Cerebras($0.35/$0.75)——
// 同一份 PRICES 里就是两个价不同的模型。无条件剥前缀会让用户填的 Cerebras 价被 Groq 的
// 顶掉,差 23 倍且完全静默(而且口径标签还写着"按你填写的单价",比少算成官网价更隐蔽)。
// 装填两遍(精确键先全部落位)+ 查询按 精确 → 归一,两者缺一这组就红。
const GROQ = { 'openai/gpt-oss-120b': { in: 1.08, out: 4.32 } };   // ¥1.08/¥4.32 = $0.15/$0.60
const CEREBRAS = { 'gpt-oss-120b': { in: 25.2, out: 54.0 } };      // ¥25.2/¥54.0 = $3.50/$7.50
for (const order of [[GROQ, CEREBRAS], [CEREBRAS, GROQ]]) {  // 结果不许依赖 provider 列表顺序
  setUserPrices(order.map((mp) => P(mp)));
  near(computeCost('openai/gpt-oss-120b', IO1M).totalUsd, 0.15 + 0.60, 'Groq 那行被串了');
  near(computeCost('gpt-oss-120b', IO1M).totalUsd, 3.50 + 7.50, 'Cerebras 那行被 Groq 的价顶掉');
}
// 命名空间不同、基名相同的一般情形同样各归各。
setUserPrices([P({ 'groq/foo': { in: 7.2, out: 0 } }), P({ 'cerebras/foo': { in: 72, out: 0 } })]);
near(computeCost('groq/foo', IN1M).totalUsd, 1, 'groq/foo 被串');
near(computeCost('cerebras/foo', IN1M).totalUsd, 10, 'cerebras/foo 被 groq/foo 顶掉');
// 精确整体优先于"当前激活":激活的是 Groq,但消息的 model 精确等于 Cerebras 那个 id。
// 精确讲的是模型身份,isCurrent 只是同一身份撞车时的裁决规则。
setUserPrices([P(CEREBRAS), P(GROQ, true)]);
near(computeCost('gpt-oss-120b', IO1M).totalUsd, 3.50 + 7.50, '激活 provider 的归一键抢了别人的精确键');
// C 的正当收益不能丢:只配了一个时,另一种写法仍靠归一层命中。
setUserPrices([P(GROQ)]);
near(computeCost('gpt-oss-120b', IO1M).totalUsd, 0.15 + 0.60, '只配一个时归一层兜底失效');

// ⑰ R5-d:provider 编辑表单的 dirty 判据必须覆盖所有会被保存的字段。漏一个,只填了那个
// 字段就点下拉外面 = 下拉静默关掉、输入丢失(ctxWindow 是老问题,modelPrices 是 R3 新增)。
// 判据是组件内部的派生值、没法单独 import,这里按源码断言 —— 抓的是"加了字段忘了加进 dirty"
// 这类回归。
{
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../client/src/App.jsx', import.meta.url), 'utf8');
  const m = src.match(/const dirty = \(open \|\| isEdit\)[\s\S]*?;\n/);
  assert.ok(m, '没找到 CustomProviderForm 的 dirty 判据(改写法了就同步这条断言)');
  for (const f of ['name', 'baseURL', 'apiKey', 'modelsText', 'ctxWindow', 'modelPrices']) {
    assert.ok(m[0].includes(f), `dirty 判据漏了表单字段 ${f} —— 只填它再点外面会静默丢输入`);
  }
}

// ⑭ 后端校验:sanitizeModelPrices 拒绝非法输入、丢空条目、封上界与条目数。
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
