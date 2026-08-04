// R4:用量面板与消息气泡必须是同一套计费口径;切 provider 不许改写历史金额。
// Run: node tests/unit/check-billing-consistency.mjs
//
// R4-a 起因(判官实测同一份真实历史):面板 ¥211.70 vs 气泡 ¥4,689.56,差 22 倍。
//   根因是 UsagePanel 自带一套分档:/claude|opus|sonnet|haiku/ 一律当订阅藏掉(连官方
//   API key 付费用户的钱也藏)、只有 deepseek/mimo 算钱、其余一律显 "—"。
//   修法:面板改走 computeCost 这个唯一出口(aggregateCost 只是把聚合口径包一层)。
//
// R4-b 起因:订阅态合计 ¥4,690,切到第三方 provider 立刻变 ¥498,876 —— 多出的 49 万全是
//   订阅期 Claude 消息按 API 单价算出的虚构钱。根因是"这些消息当年是不是订阅付的"要看
//   **当时**的鉴权方式,而 jsonl 里没有,原实现拿**此刻**的 provider.hasAuthKey 顶替。
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { computeCost, aggregateCost, isSubscriptionBilling, isPlanBilling, observeOfficialBilling } =
  await import('../../client/src/utils/pricing.js');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const u = (i, o, cr = 0, cw = 0) => ({
  input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw,
});

// ── R4-a:两个视图对同一批消息的合计必须逐位相等 ──────────────────────
// 判官点名的三类"面板显横杠、气泡显金额"的模型都在里面。
const HISTORY = [
  { model: 'gpt-5.6-sol', usage: u(120_000, 8_000, 900_000, 40_000) },
  { model: 'gpt-5.6-sol', usage: u(30_000, 2_500, 200_000, 0) },
  { model: 'gpt-5.5', usage: u(50_000, 4_000, 300_000, 10_000) },
  { model: 'moonshotai/kimi-k3', usage: u(80_000, 6_000, 400_000, 20_000) },
  { model: 'claude-opus-5', usage: u(60_000, 5_000, 700_000, 30_000) },
  { model: 'deepseek-v4-pro', usage: u(90_000, 7_000, 500_000, 0) },
  { model: 'mimo-v2.5-pro', usage: u(40_000, 3_000, 100_000, 5_000) },
  { model: 'k3', usage: u(70_000, 9_000, 600_000, 15_000) },                 // 套餐档:两边都不计钱
];
// 查无单价的 model 不放进这批:deepseek/mimo 分支下它会回落到 env 档位单价(既有的、
// 刻意的行为 —— 在 deepseek 上遇到没收录的 id,多半就是个 deepseek 模型,按当前档位估
// 好过什么都不显示),于是它的金额天然随当前 provider 变。这与 R4-b 要治的"Claude 历史
// 被按 API 单价重算"是两回事,别顺手把它"修"掉。下面 ⑪ 单独把这个行为钉住。
// 面板拿到的是服务端按 model 聚合后的 { input, output, cacheRead, cacheWrite }。
const aggregate = (msgs) => {
  const by = {};
  for (const m of msgs) {
    if (!by[m.model]) by[m.model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    by[m.model].input += m.usage.input_tokens;
    by[m.model].output += m.usage.output_tokens;
    by[m.model].cacheRead += m.usage.cache_read_input_tokens;
    by[m.model].cacheWrite += m.usage.cache_creation_input_tokens;
  }
  return by;
};
const bubbleTotal = (msgs, prov) =>
  msgs.reduce((s, m) => s + (computeCost(m.model, m.usage, prov)?.totalUsd || 0), 0);
const panelTotal = (msgs, prov) =>
  Object.entries(aggregate(msgs)).reduce((s, [model, t]) => s + (aggregateCost(model, t, prov).usd || 0), 0);

// ① 官方订阅态:Claude 部分两边都藏,第三方部分两边都显,合计相等。
const SUB = { providerHint: 'anthropic', baseUrl: '', hasAuthKey: false };
near(panelTotal(HISTORY, SUB), bubbleTotal(HISTORY, SUB), '订阅态下面板与气泡合计不等');
assert.ok(bubbleTotal(HISTORY, SUB) > 0, '订阅态下第三方消费不该是 0');

// ② 官方 API key 付费态:Claude 的钱是真花的,两边都必须显示(原面板一律藏 = 少算)。
const PAID = { providerHint: 'anthropic', baseUrl: '', hasAuthKey: true };
near(panelTotal(HISTORY, PAID), bubbleTotal(HISTORY, PAID), 'API key 付费态下面板与气泡合计不等');
assert.ok(panelTotal(HISTORY, PAID) > panelTotal(HISTORY, SUB), 'API key 付费态下 Claude 的钱被面板藏了');

// ③ 判官点名的三个模型在面板里必须有金额,不是 "—"。
for (const m of ['gpt-5.6-sol', 'gpt-5.5', 'moonshotai/kimi-k3']) {
  const c = aggregateCost(m, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, SUB);
  assert.ok(c.usd > 0, `${m} 在面板里仍是「—」(unknown),与气泡不一致`);
}
// ④ 套餐/订阅档在面板里是"订阅内"而不是"—",两者语义不同不能混。
assert.deepEqual(aggregateCost('k3', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, SUB),
  { subscription: true }, 'k3 套餐档应显示订阅内');
assert.deepEqual(aggregateCost('claude-opus-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, SUB),
  { subscription: true }, '订阅态 Claude 应显示订阅内');
assert.deepEqual(aggregateCost('no-such-model-xyz', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, SUB),
  { unknown: true }, '查无单价应显示 —');

// ── R4-b:切 provider 不许改写历史金额 ────────────────────────────────
// 【本段有顺序依赖】"最后一次观察到的官方计费方式"是模块级状态,用例按
// 从未观察 → apikey → oauth 的顺序推进,中间不需要重置。
const THIRD = { providerHint: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', hasAuthKey: true };

// ⑤ 从未观察过(新机器 / 清了 localStorage)→ 回落现有行为:照常显示价格。
//    失败方向永远是"多显示"不是"多藏"。
assert.equal(isSubscriptionBilling(THIRD, 'claude-opus-5'), false, '没有观察记录时不该判订阅');
assert.ok(computeCost('claude-opus-5', u(1_000_000, 0), THIRD).totalUsd > 0, '没有观察记录时应照常显示价格');

// ⑥ 观察到官方是 API key 按量付费 → 切到第三方后,Claude 历史照常显示金额。
observeOfficialBilling(PAID);
assert.equal(isSubscriptionBilling(THIRD, 'claude-opus-5'), false, 'API key 付费的历史不该被当订阅藏掉');

// ⑦ 观察到官方是订阅(OAuth)→ 切到第三方后,Claude 历史仍然是订阅档,金额不变。
observeOfficialBilling(SUB);
assert.equal(isSubscriptionBilling(THIRD, 'claude-opus-5'), true, '切到第三方后订阅期 Claude 消息被按 API 单价重算');
assert.equal(computeCost('claude-opus-5', u(1_000_000, 0), THIRD), null, '切 provider 后 Claude 历史凭空长出金额');

// ⑧ 核心断言:同一份历史,切 provider 前后合计必须【一模一样】。
const beforeSwitch = bubbleTotal(HISTORY, SUB);
const afterSwitch = bubbleTotal(HISTORY, THIRD);
near(afterSwitch, beforeSwitch, '切到第三方 provider 后历史合计变了(订阅期消息被按 API 单价重算)');
near(panelTotal(HISTORY, THIRD), bubbleTotal(HISTORY, THIRD), '切 provider 后面板与气泡又不一致了');

// ⑨ 第三方自己的模型不受影响:该算的钱照算(别为了藏 Claude 把第三方也藏了)。
assert.ok(computeCost('deepseek-v4-pro', u(1_000_000, 0), THIRD).totalUsd > 0, '第三方模型的钱被误藏');
assert.ok(computeCost('gpt-5.6-sol', u(1_000_000, 0), THIRD).totalUsd > 0, '第三方模型的钱被误藏');

// ⑩ 回到官方 provider 时仍以"此刻"为准(它就是当时),不受历史观察值影响。
assert.equal(isSubscriptionBilling(PAID, 'claude-opus-5'), false, '官方 provider 下应看此刻的 hasAuthKey');
assert.equal(isSubscriptionBilling(SUB, 'claude-opus-5'), true, '官方 provider 下应看此刻的 hasAuthKey');
// 观察函数只认官方 provider:第三方的 hasAuthKey 不是"官方计费方式",不许污染记录。
observeOfficialBilling(THIRD);
assert.equal(isSubscriptionBilling(THIRD, 'claude-opus-5'), true, '第三方 provider 的 hasAuthKey 污染了观察记录');

// ⑪ 既有行为钉住:查无单价的 id 在官方下是「—」,在 deepseek 下回落 env 档位单价。
//    两个视图对它的口径仍然一致(都走 computeCost),只是它本身随 provider 变。
const NOPRICE = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
assert.deepEqual(aggregateCost('no-such-model-xyz', NOPRICE, SUB), { unknown: true });
near(aggregateCost('no-such-model-xyz', NOPRICE, THIRD).usd,
  computeCost('no-such-model-xyz', u(1_000_000, 0), THIRD).totalUsd, '无价 id 在面板与气泡下不一致');

// ── R4-c1:Kimi 套餐白名单前缀过宽 ────────────────────────────────────
// k3 / kimi-for-coding[-highspeed] 是套餐专属 id(可带 [1m] 后缀);k30 / k3-turbo /
// k3.5 是别的模型,不能被前缀匹配静默藏掉金额。
for (const m of ['k3', 'k3[1m]', 'kimi-for-coding', 'kimi-for-coding-highspeed', 'kimi-for-coding[1m]']) {
  assert.equal(isPlanBilling(null, m), true, `${m} 应判为 Kimi 套餐档`);
}
for (const m of ['k30', 'k3-turbo', 'k3.5', 'k3-pro', 'kimi-for-coding-x', 'kimi-k3']) {
  assert.equal(isPlanBilling(null, m), false, `${m} 不是套餐 id,不该被前缀匹配藏掉金额`);
}

// ── R5:面板里"有没有价"的三处判据必须同源 ────────────────────────────
// aggregateCost 返回 {usd:0}(免费模型 / token 极少)时:组头按 `g.usd > 0` 判显「—」
// (含义是"查不到单价"),组内行按 `cost.usd != null` 判显 `<¥0.001`,柱子又是灰的 ——
// 同一份数据三种说法。groupByProvider 在 UsagePanel.jsx 内部,该文件是 JSX 且依赖
// React/store,node 里 import 不了,故按源码钉。
{
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../client/src/components/UsagePanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /if \(c\.usd != null\) \{ g\.usd \+= c\.usd; g\.priced = true; \}/,
    '组的 priced 累加判据不再是 c.usd != null,与行的判据脱钩了');
  assert.doesNotMatch(src, /g\.usd > 0/,
    '还有显示点在用旧判据 g.usd > 0(组头与柱状图都应走 g.priced)');
  assert.equal((src.match(/g\.priced/g) || []).length, 3,
    'g.priced 应恰好出现三处:累加、组头金额、柱状图颜色');
}

console.log('check-billing-consistency OK');
