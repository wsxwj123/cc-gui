#!/usr/bin/env node
// A 项(2026-09-11)展示层索引:buildSubagentCostIndex 白盒单测。
// 卡片金额规则(同一 toolUseId 名下全部 agent 之和)、失败条数与原因词、workflow 内层行
// 的 byAgentId 键、币种折算依据、以及对「agents[] 顺序与输入对齐」这条依赖的钉死。
// Run: node tests/unit/check-subagent-cost.mjs —— 固定夹具喂 catalog,不联网。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
readFileSync(join(root, 'tests/unit/fixtures/pricing-catalog-fixture.json'), 'utf8');

const { setPricingCatalog } = await import('../../client/src/utils/pricingCatalog.js');
const { buildSubagentCostIndex, costReasonOf, MISSING_TITLE } = await import('../../client/src/utils/subagentCost.js');

const M = 1e6;
const usd = (tokens, price) => (tokens * price) / M;
const provider = { providerHint: 'anthropic', model: null, hasAuthKey: true };
const quote = (over = {}) => ({
  quoteId: 'q', provider: 'pa', presetIds: ['pa'], modelId: 'pa-model', displayName: 'PA', protocol: null,
  market: 'global', currency: 'USD', unit: 'per 1M tokens',
  prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: null, cacheWrite1h: null },
  conditions: null, validFrom: null, validTo: null, sourceUrl: null, sourceKind: 'official',
  fetchedAt: null, parserVersion: 'pa-cost', status: 'fresh', ...over,
});
const useQuotes = (...quotes) => setPricingCatalog({ source: 'official-sources', prices: {}, quotes, providers: [], refresh: null });
const usage = (o = {}) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o });
const agent = (o = {}) => ({
  agentSessionId: 'agent-pa1', toolUseId: 'toolu_pa1', agentType: 'code-reviewer',
  model: 'claude-opus-5', timestamp: '2026-09-11T02:00:00.000Z', usage: usage({ input_tokens: 1000 }), ...o,
});

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 5).join('\n      ')}`); }
};

useQuotes(quote({ quoteId: 'pa-opus', modelId: 'claude-opus-5' }));

check('卡片金额 = 同一 toolUseId 名下全部 agent 之和(普通卡片只有 1 个)', () => {
  const { byToolUseId } = buildSubagentCostIndex([
    agent({ toolUseId: 'toolu_a', agentSessionId: 'agent-1' }),
    agent({ toolUseId: 'toolu_b', agentSessionId: 'agent-2' }),
    agent({ toolUseId: 'toolu_b', agentSessionId: 'agent-3' }),
  ], provider);
  assert.equal(byToolUseId.get('toolu_a').usd, usd(1000, 5));
  assert.equal(byToolUseId.get('toolu_b').usd, usd(2000, 5), 'workflow 卡片 = 内部全部 agent 的合计');
  assert.equal(byToolUseId.get('toolu_b').priced, 2);
  assert.equal(byToolUseId.get('toolu_b').failed, 0);
});

check('算不出来的不计入求和,只记 failed 条数与原因词(¥0 与"没算出来"必须能分辨)', () => {
  const { byToolUseId } = buildSubagentCostIndex([
    agent({ toolUseId: 'toolu_wf', agentSessionId: 'agent-1' }),
    agent({ toolUseId: 'toolu_wf', agentSessionId: 'agent-2', model: 'pa-never-priced' }),
    agent({ toolUseId: 'toolu_wf', agentSessionId: 'agent-3', usage: undefined }),
  ], provider);
  const entry = byToolUseId.get('toolu_wf');
  assert.equal(entry.usd, usd(1000, 5), '合计只含算得出来的那一个');
  assert.equal(entry.priced, 1);
  assert.equal(entry.failed, 2, '「另有 N 个未能计价」的 N');
  assert.equal(entry.reason, '没有该模型的可用价格', '原因词取 §10.11⑦ 的 detail');
});

check('全部算不出来 → priced:0(调用方据此画「未能计价」小标),reason 照样有', () => {
  const { byToolUseId } = buildSubagentCostIndex([agent({ toolUseId: 'toolu_x', model: 'pa-never-priced' })], provider);
  const entry = byToolUseId.get('toolu_x');
  assert.equal(entry.priced, 0);
  assert.equal(entry.failed, 1);
  assert.ok(entry.reason.length > 0);
});

check('一条记录都没有的 toolUseId 不在索引里(调用方按"缺席"判 0 条记录)', () => {
  const { byToolUseId } = buildSubagentCostIndex([], provider);
  assert.equal(byToolUseId.size, 0);
  assert.equal(byToolUseId.get('toolu_never_seen'), undefined);
});

check('byAgentId 键 = agentSessionId 去掉 agent- 前缀(监控面板 wf 内层行的 id)', () => {
  const { byAgentId } = buildSubagentCostIndex([
    agent({ agentSessionId: 'agent-a009bb2f80dbeb605', toolUseId: 'toolu_wf' }),
  ], provider);
  assert.ok(byAgentId.has('a009bb2f80dbeb605'));
  assert.equal(byAgentId.get('a009bb2f80dbeb605').usd, usd(1000, 5));
});

check('非数组 / 畸形条目都不抛,索引为空或按条记 failed', () => {
  assert.equal(buildSubagentCostIndex(null, provider).byToolUseId.size, 0);
  assert.equal(buildSubagentCostIndex('agents', provider).byToolUseId.size, 0);
  const { byToolUseId } = buildSubagentCostIndex([null, 'x'], provider);
  assert.equal(byToolUseId.size, 0, '两条都没有 toolUseId → 不进任何键');
});

check('顺序对齐:agents[] 与输入逐位对应(原因词取的是自己那一条,不是别人的)', () => {
  const bad = { agentSessionId: 'agent-bad', toolUseId: 'toolu_bad', model: undefined, usage: undefined, timestamp: undefined };
  const good = agent({ toolUseId: 'toolu_good' });
  const list = [bad, good];
  const { byToolUseId } = buildSubagentCostIndex(list, provider);
  assert.equal(byToolUseId.get('toolu_bad').failed, 1);
  assert.equal(byToolUseId.get('toolu_bad').reason, '这条记录没有用量数据', 'USAGE_EMPTY 取的是 bad 那条的用量');
  assert.equal(byToolUseId.get('toolu_good').priced, 1);
  assert.equal(costReasonOf(list[0], provider), '这条记录没有用量数据');
});

check('币种:同币种留一种;混币种记空串(按原数显示,不折算)', () => {
  useQuotes(quote({ quoteId: 'pa-usd', modelId: 'claude-opus-5', currency: 'USD' }),
    quote({ quoteId: 'pa-cny', modelId: 'pa-cny-model', currency: 'CNY' }));
  const one = buildSubagentCostIndex([agent({ toolUseId: 'toolu_1' })], provider).byToolUseId.get('toolu_1');
  assert.equal(one.currency, 'USD');
  const mixed = buildSubagentCostIndex([
    agent({ toolUseId: 'toolu_m', agentSessionId: 'agent-1' }),
    agent({ toolUseId: 'toolu_m', agentSessionId: 'agent-2', model: 'pa-cny-model' }),
  ], provider).byToolUseId.get('toolu_m');
  assert.equal(mixed.currency, '', '混币种不给可折算的币种');
  useQuotes(quote({ quoteId: 'pa-opus', modelId: 'claude-opus-5' }));
});

check('纯函数:不改传入的 agents 数组', () => {
  const list = [agent()];
  const snapshot = JSON.parse(JSON.stringify(list));
  buildSubagentCostIndex(list, provider);
  assert.deepEqual(list, snapshot);
});

check('「未能计价」小标的默认说明文案不是"算不出来"', () => {
  assert.ok(MISSING_TITLE.includes('未读到'), MISSING_TITLE);
  assert.ok(!MISSING_TITLE.includes('无法计算') && !MISSING_TITLE.includes('算不出来'), MISSING_TITLE);
});

console.log(failed ? `\n${failed} 条失败` : '\n✓ check-subagent-cost: 子代理花费展示层索引 全过');
process.exit(failed ? 1 : 0);
