// Q-b:官方订阅只对【Claude 系消息】隐藏价格,第三方模型的花费照常显示。
// Run: node tests/unit/check-subscription-billing.mjs
// 判据与 GET /api/provider 同源:providerHint='anthropic'(baseUrl 为空或 api.anthropic.com)
// + settings.json 无 ANTHROPIC_AUTH_TOKEN/API_KEY/apiKeyHelper(切官方时被清掉,只能走 OAuth)
// + 这条消息用的是 Claude 家族模型。
// 【为什么必须带 model】判官实测:漏掉 model 时,订阅用户切回官方后,本机 3.6 万条第三方
// 消息(k3 / gpt-5.6-sol / deepseek 系,真实花费约 ¥1.27 万)会被一起藏成 0 —— 那笔钱是
// 订阅之外真金白银付的,恰恰是订阅用户唯一需要看的费用。
// 失败方向一律"照常显示价格":hasAuthKey 未知、model 未知,都不算订阅。
import assert from 'node:assert';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { isSubscriptionBilling, isPlanBilling, computeCost, observeOfficialBilling } =
  await import('../../client/src/utils/pricing.js');

const SUB = { providerHint: 'anthropic', baseUrl: '', hasAuthKey: false };   // 订阅态
const PAID = { providerHint: 'anthropic', baseUrl: '', hasAuthKey: true };   // 官方按量付费

// ① 官方 + 无 key + Claude 系模型 → 订阅(含带日期后缀的 id 与裸别名)
for (const m of ['claude-opus-4-8', 'claude-opus-5', 'claude-fable-5', 'claude-sonnet-5',
  'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-mythos-5',
  'opus', 'sonnet', 'haiku', 'fable']) {
  assert.strictEqual(isSubscriptionBilling(SUB, m), true, `${m} 应判为订阅覆盖`);
}
// ② 官方 + 无 key + 非 Claude 模型 → **不是** Claude 订阅(本条是 P0 回归守卫)。
//    注意 isSubscriptionBilling 只判 Claude 订阅那一半;k3 / kimi-for-coding* 归不归
//    "套餐档"由 isPlanBilling 另判(见文件末尾三档断言),这里 false 是正确的。
for (const m of ['deepseek-v4-flash', 'deepseek-v4-pro', 'k3', 'kimi-for-coding',
  'kimi-for-coding-highspeed', 'moonshotai/kimi-k3', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-5.5', 'openai/gpt-5.6-sol', 'mimo-v2.5-pro', 'glm-5.2', 'qwen-plus']) {
  assert.strictEqual(isSubscriptionBilling(SUB, m), false, `${m} 是自费模型,不该被订阅判据藏掉`);
}
// ③ 官方 + 有 key(按量付费 API key / apiKeyHelper)→ 一律非订阅
assert.strictEqual(isSubscriptionBilling(PAID, 'claude-opus-4-8'), false);
// ④ 第三方 provider 一律非订阅,哪怕 hasAuthKey 为 false、哪怕模型名是 claude-*
//    (第三方中转把模型名透传成 claude-*,那是真花钱的)
for (const hint of ['deepseek', 'mimo', 'openrouter', 'siliconflow', 'bedrock', 'vertex', 'unknown']) {
  assert.strictEqual(isSubscriptionBilling({ providerHint: hint, hasAuthKey: false }, 'claude-opus-4-8'),
    false, `${hint} 被误判为订阅`);
}
// ⑤ 字段缺失 → 非订阅(不多藏)
assert.strictEqual(isSubscriptionBilling(SUB, ''), false, 'model 缺失时不该藏');
assert.strictEqual(isSubscriptionBilling(SUB, null), false, 'model 为 null 时不该藏');
assert.strictEqual(isSubscriptionBilling(SUB, undefined), false, 'model 未传时不该藏');
assert.strictEqual(isSubscriptionBilling({ providerHint: 'anthropic' }, 'claude-opus-4-8'), false,
  'hasAuthKey 缺失时不该藏');
assert.strictEqual(isSubscriptionBilling(null, 'claude-opus-4-8'), false);
assert.strictEqual(isSubscriptionBilling(undefined, 'claude-opus-4-8'), false);

// ── computeCost 是所有费用展示的唯一出口 ──────────────────────────
const IO = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
const CNY = 7.2;
// 订阅态:Claude 系不算钱
assert.strictEqual(computeCost('claude-opus-4-8', IO, SUB), null, '订阅态 Claude 消息仍在算钱');
assert.strictEqual(computeCost('claude-opus-5', IO, SUB), null, '订阅态 Claude 消息仍在算钱');
// 订阅态:按量付费的第三方照常算钱,且数值与非订阅态逐位相同
// (k3 / kimi-for-coding* 不在此列 —— 它们是 Kimi Code 套餐档,见下方三档断言)
for (const [m, want] of [['deepseek-v4-flash', 0.14 + 0.28], ['deepseek-v4-pro', 0.435 + 0.87],
  ['gpt-5.6-sol', 5 + 30], ['mimo-v2.5-pro', (3 + 6) / CNY], ['kimi-k3', (20 + 100) / CNY]]) {
  const c = computeCost(m, IO, SUB);
  assert.ok(c, `订阅态下 ${m} 的费用被藏了(P0 回归)`);
  assert.ok(Math.abs(c.totalUsd - want) < 1e-9, `订阅态 ${m} ${c.totalUsd} != ${want}`);
  assert.strictEqual(c.totalUsd, computeCost(m, IO, undefined).totalUsd, `${m} 订阅态与默认态数值不一致`);
}
// 官方按量付费:Claude 系照常算钱
const paidCost = computeCost('claude-opus-4-8', IO, PAID);
assert.ok(paidCost && Math.abs(paidCost.totalUsd - 30) < 1e-9, `按量付费 ${paidCost?.totalUsd} != 30`);
// 无 provider(默认状态)照常计价,零回归
assert.ok(computeCost('claude-opus-4-8', IO), '无 provider 时不该被当订阅');
// model 缺失(老 jsonl / 流式首帧)不走订阅隐藏这条路 —— 判据返回 false,拿不到价是
// 因为 anthropic 分支本来就只按 model 查价(既有行为,与本批无关)。
assert.strictEqual(isSubscriptionBilling({ ...SUB, model: 'claude-opus-4-8' }, null), false);

// ── 三档计费语义 ─────────────────────────────────────────────────
// 套餐包月(不显示费用)/ 按量付费(显示)/ 分不出接入方式的(显示 + title 标注估算)。
// Kimi Code 会员套餐:baseURL api.kimi.com/coding,模型 id 是套餐专属的 k3 /
// kimi-for-coding*,与开放平台按量付费的 kimi-k3 / kimi-k2.7-code* 不同名。
// 拿开放平台按量价去算包月用量是纯虚构(本机 14289 条这类消息曾被算成约 ¥7975)。
for (const m of ['k3', 'k3[1m]', 'kimi-for-coding', 'kimi-for-coding-highspeed']) {
  assert.strictEqual(isPlanBilling(SUB, m), true, `${m} 是 Kimi Code 套餐 id,不该按 token 计费`);
  assert.strictEqual(computeCost(m, IO, SUB), null, `${m} 套餐档仍在算钱`);
  // 套餐判据只看 model,与当前 provider 无关(切到任何 provider 回看都不算钱)
  assert.strictEqual(computeCost(m, IO, undefined), null, `${m} 换 provider 后又开始算钱`);
  assert.strictEqual(computeCost(m, IO, { providerHint: 'deepseek', model: 'deepseek-v4-pro' }), null);
}
// 开放平台按量 id 不受套餐白名单影响,照常计价
for (const [m, want] of [['kimi-k3', (20 + 100) / CNY], ['kimi-k2.7-code', (6.5 + 27) / CNY],
  ['moonshotai/kimi-k3', (20 + 100) / CNY]]) {
  const c = computeCost(m, IO, SUB);
  assert.ok(c && Math.abs(c.totalUsd - want) < 1e-9, `${m} 是按量付费 id,${c?.totalUsd} != ${want}`);
}
// 三档汇总:套餐不显示 / 按量显示 / 官方有 key 显示
assert.strictEqual(isPlanBilling(SUB, 'claude-opus-4-8'), true, 'Claude 订阅=套餐档');
assert.strictEqual(isPlanBilling(PAID, 'claude-opus-4-8'), false, '官方 API key=按量档');
assert.strictEqual(isPlanBilling(SUB, 'deepseek-v4-flash'), false, 'DeepSeek=按量档');
assert.strictEqual(isPlanBilling(SUB, 'mimo-v2.5-pro'), false, 'MiMo=按量档');
// 中转站的 gpt-5.6-sol 与官方同名,jsonl 也不存接入方式 → 分不出来就照常显示(不静默隐藏)
assert.strictEqual(isPlanBilling(SUB, 'gpt-5.6-sol'), false, '分不出接入方式的一律显示');
assert.ok(computeCost('gpt-5.6-sol', IO, SUB), '分不出接入方式的不该静默隐藏');

// ── R5-a:持久化 oauth 判据不许套到"按 token 真实计费的 claude-*"上 ─────────
// 【本段必须放在文件末尾】它会写入 lastOfficialBilling(模块级),之后第三方 provider 下的
// Claude 家族消息一律按最后一次观察到的官方口径判(R4-b),前面各条断言的前提就变了。
// 【覆盖面,别读成"Bedrock/Vertex 都修好了"】providerHint 只由 GET /api/provider 从
// ANTHROPIC_BASE_URL 猜出来,所以下面这两个 fixture 代表的是"把 base URL 指向
// bedrock/amazonaws/vertex/googleapis 网关"这一种接法。Claude Code 官方的标准姿势
// CLAUDE_CODE_USE_BEDROCK=1 / CLAUDE_CODE_USE_VERTEX=1 **不设 base URL**(本仓没有任何
// 地方处理这两个环境变量),那种配置下 hint 落 'anthropic'、hasAuthKey 又是 false,会在
// 官方分支就被判成订阅 —— R5-a 覆盖不到,属已知限制。
observeOfficialBilling({ providerHint: 'anthropic', hasAuthKey: false }); // 观察到:官方走 OAuth 订阅
const BEDROCK = { providerHint: 'bedrock', hasAuthKey: true };  // = base URL 指向 bedrock 网关
const VERTEX = { providerHint: 'vertex', hasAuthKey: true };    // = base URL 指向 vertex 网关
const RELAY = { providerHint: 'unknown', hasAuthKey: true };   // 中转站
// Bedrock / Vertex 的 claude-* 走 AWS / GCP 账单按 token 真花钱,与 Claude 订阅是两笔钱。
// 判官实测回归:观察到 oauth 前显示 {usd:5},之后被藏成 {subscription:true}。
for (const [name, p] of [['bedrock', BEDROCK], ['vertex', VERTEX]]) {
  assert.strictEqual(isSubscriptionBilling(p, 'claude-opus-5'), false,
    `${name} 的 claude-* 是按 token 真实计费的,不该被持久化 oauth 判据藏掉`);
  assert.strictEqual(isPlanBilling(p, 'claude-opus-5'), false, `${name} 不该被判成套餐档`);
  const c = computeCost('claude-opus-5', IO, p);
  assert.ok(c && Math.abs(c.totalUsd - 30) < 1e-9, `${name} 的 claude-opus-5 金额被藏了:${c?.totalUsd}`);
  // 裸别名与带日期后缀的 id 同样不许藏
  assert.ok(computeCost('opus', IO, p), `${name} 的裸别名 opus 被藏了`);
  assert.ok(computeCost('claude-sonnet-4-5-20250929', IO, p), `${name} 的带日期 id 被藏了`);
  // 第一道 model 判据没被绕过:非 Claude 模型本来就照常计价
  assert.ok(computeCost('deepseek-v4-flash', IO, p), `${name} 的第三方模型被藏了`);
}
// 中转站(unknown hint)与"订阅期跑的 Claude 历史"在 jsonl 里长得一模一样,分不出来 →
// 已知代价:跟着订阅一起藏。逃生口是用户自填单价(见 check-user-prices.mjs ⑧)。
// 这条断言把"代价"钉成显式契约,免得注释与实现再次背离。
assert.strictEqual(isSubscriptionBilling(RELAY, 'claude-opus-5'), true,
  '中转站 claude-* 当前按最后一次观察到的官方口径判(已知天花板)');
assert.strictEqual(computeCost('claude-opus-5', IO, RELAY), null);
// 官方分支不受持久化记录影响:有 key 仍是按量付费,照常显示
assert.strictEqual(isSubscriptionBilling(PAID, 'claude-opus-5'), false, '官方 API key 档被误藏');
assert.ok(computeCost('claude-opus-5', IO, PAID), '官方 API key 档的金额被藏了');

console.log('check-subscription-billing OK');
