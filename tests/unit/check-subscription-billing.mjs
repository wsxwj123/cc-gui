// Q-b:官方订阅(Pro/Max 包月)只显示用量、不显示价格。
// Run: node tests/unit/check-subscription-billing.mjs
// 判据与 GET /api/provider 同源:providerHint='anthropic'(baseUrl 为空或 api.anthropic.com)
// 且 settings.json 无 ANTHROPIC_AUTH_TOKEN/API_KEY(切官方时被显式清掉,CLI 只能走 OAuth 订阅)。
// 失败方向必须是"照常显示价格":hasAuthKey 未知(旧数据/fetchProvider 未返回)不算订阅。
import assert from 'node:assert';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { isSubscriptionBilling, computeCost } = await import('../../client/src/utils/pricing.js');

// 官方 + 无 key → 订阅
assert.strictEqual(isSubscriptionBilling({ providerHint: 'anthropic', baseUrl: '', hasAuthKey: false }), true);
// 官方 + 有 key(按量付费的 API key)→ 非订阅,照常计价
assert.strictEqual(isSubscriptionBilling({ providerHint: 'anthropic', baseUrl: '', hasAuthKey: true }), false);
// 第三方(含 anthropic 兼容中转)一律非订阅,哪怕 hasAuthKey 为 false
for (const hint of ['deepseek', 'mimo', 'openrouter', 'siliconflow', 'bedrock', 'vertex', 'unknown']) {
  assert.strictEqual(isSubscriptionBilling({ providerHint: hint, hasAuthKey: false }), false, `${hint} 被误判为订阅`);
}
// 未知/缺字段 → 非订阅(不许多藏价格)
assert.strictEqual(isSubscriptionBilling({ providerHint: 'anthropic' }), false);
assert.strictEqual(isSubscriptionBilling(null), false);
assert.strictEqual(isSubscriptionBilling(undefined), false);

// computeCost 是所有费用展示的唯一出口:订阅态返回 null → 各处 `cost &&` 条件渲染自动隐藏。
const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
const sub = { providerHint: 'anthropic', baseUrl: '', hasAuthKey: false };
const paid = { providerHint: 'anthropic', baseUrl: '', hasAuthKey: true };
assert.strictEqual(computeCost('claude-opus-4-8', usage, sub), null, '订阅态仍在算钱');
const paidCost = computeCost('claude-opus-4-8', usage, paid);
assert.ok(paidCost && Math.abs(paidCost.totalUsd - 30) < 1e-9, `按量付费 ${paidCost?.totalUsd} != 30`);
// 无 provider(默认状态)照常计价,零回归
assert.ok(computeCost('claude-opus-4-8', usage), '无 provider 时不该被当订阅');

console.log('check-subscription-billing OK');
