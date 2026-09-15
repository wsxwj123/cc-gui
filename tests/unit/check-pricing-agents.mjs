#!/usr/bin/env node
// A 项(2026-09-11)客户端:computeCostForAgents 白盒单测 —— 契约 §10.3。
// 覆盖:空/非数组形状、逐 agent 按自身 model、失败记 null 不计入合计、卡片求和规则、
// 畸形输入不外溢、纯函数无副作用、分时段与 TTL 两档对子代理同样生效、币种随 agent。
// Run: node tests/unit/check-pricing-agents.mjs —— 固定夹具喂 catalog,不联网。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = JSON.parse(readFileSync(join(root, 'tests/unit/fixtures/pricing-catalog-fixture.json'), 'utf8'));

const { setPricingCatalog } = await import('../../client/src/utils/pricingCatalog.js');
const { computeCostForAgents, computeCost, computeCostForMessage } = await import('../../client/src/utils/pricing.js');

const M = 1e6;
const usd = (tokens, price) => (tokens * price) / M;
const provider = { providerHint: 'anthropic', model: null, hasAuthKey: true };
const quote = (over = {}) => ({
  quoteId: 'q', provider: 'pa', presetIds: ['pa'], modelId: 'pa-model', displayName: 'PA', protocol: null,
  market: 'global', currency: 'USD', unit: 'per 1M tokens',
  prices: { input: 1, output: 1, cacheRead: 0.1, cacheWrite5m: null, cacheWrite1h: null },
  conditions: null, validFrom: null, validTo: null, sourceUrl: null, sourceKind: 'official',
  fetchedAt: null, parserVersion: 'pa-agents', status: 'fresh', ...over,
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

const OPUS = quote({ quoteId: 'pa-opus', modelId: 'claude-opus-5', prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 } });
const SONNET = quote({ quoteId: 'pa-sonnet', modelId: 'claude-sonnet-4-6', prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 } });

// ── 1. 形状:空数组与非数组 ────────────────────────────────────────────────
useQuotes(OPUS);
check('空数组 → {totalUsd:0,count:0,agents:[],partial:false}(不抛)', () => {
  assert.deepEqual(computeCostForAgents([], provider), { totalUsd: 0, count: 0, agents: [], partial: false });
});
check('非数组输入(undefined/null/字符串/数字/对象)→ 与空数组同形,不抛', () => {
  for (const bad of [undefined, null, 'agents', 42, {}]) {
    assert.deepEqual(computeCostForAgents(bad, provider), { totalUsd: 0, count: 0, agents: [], partial: false },
      `computeCostForAgents(${JSON.stringify(bad)})`);
  }
});

// ── 2. 逐 agent 按【自身】model 计价 ──────────────────────────────────────
useQuotes(OPUS, SONNET);
check('opus 子代理与 sonnet 子代理各按自己的价,不得沿用主回合 model', () => {
  const r = computeCostForAgents([
    agent({ model: 'claude-opus-5', usage: usage({ input_tokens: 1000 }) }),
    agent({ agentSessionId: 'agent-pa2', toolUseId: 'toolu_pa2', model: 'claude-sonnet-4-6', usage: usage({ input_tokens: 1000 }) }),
  ], provider);
  assert.equal(r.count, 2);
  assert.equal(r.agents[0].costUsd, usd(1000, 5));
  assert.equal(r.agents[1].costUsd, usd(1000, 3));
  assert.equal(r.totalUsd, usd(1000, 5) + usd(1000, 3));
  assert.equal(r.partial, false);
  assert.equal(r.currency, 'USD', '全部同币种时给出币种(展示层折算要用)');
  assert.deepEqual(r.breakdown, { input: usd(1000, 5) + usd(1000, 3), output: 0, cacheRead: 0, cacheWrite: 0 });
});
check('agent 上的元信息原样带出(agentSessionId/toolUseId/agentType/model)', () => {
  const [a] = computeCostForAgents([agent()], provider).agents;
  assert.equal(a.agentSessionId, 'agent-pa1');
  assert.equal(a.toolUseId, 'toolu_pa1');
  assert.equal(a.agentType, 'code-reviewer');
  assert.equal(a.model, 'claude-opus-5');
  assert.equal(a.tier, 'official-quote');
  assert.equal(a.retired, false);
});

// ── 3. 计价失败:null(不是 0)+ partial,不计入合计 ──────────────────────
check('算不出来的 agent 记 null、partial:true、原因进 unknownDimensions,不当 0 相加', () => {
  const r = computeCostForAgents([
    agent({ usage: usage({ input_tokens: 1000 }) }),
    agent({ agentSessionId: 'agent-pa9', toolUseId: 'toolu_pa9', model: 'pa-never-priced', usage: usage({ input_tokens: 1000 }) }),
  ], provider);
  assert.equal(r.agents[1].costUsd, null);
  assert.equal(r.partial, true);
  assert.equal(r.totalUsd, usd(1000, 5), 'totalUsd 只含可计价的部分');
  assert.ok(r.unknownDimensions.includes('NO_PRICE'), '失败原因进 unknownDimensions');
});
check('畸形 agent(缺 usage / 负 token / 缺 model / 空 usage)四个都算不出来,数量仍按输入条数', () => {
  const broken = [
    agent({ usage: undefined }),
    agent({ usage: usage({ input_tokens: -5 }) }),
    agent({ model: undefined }),
    agent({ model: 'claude-opus-5', usage: {} }),
  ];
  const r = computeCostForAgents(broken, provider);
  assert.equal(r.count, 4);
  assert.ok(r.agents.every((a) => a.costUsd === null), '四个都必须是 null');
  assert.equal(r.totalUsd, 0);
  assert.equal(r.partial, true);
});
check('null/字符串混进数组也不抛(整条按算不出来处理)', () => {
  const r = computeCostForAgents([null, 'x', agent({ usage: usage({ input_tokens: 1000 }) })], provider);
  assert.equal(r.count, 3);
  assert.equal(r.agents[0].costUsd, null);
  assert.equal(r.agents[1].costUsd, null);
  assert.equal(r.totalUsd, usd(1000, 5));
});

// ── 4. 卡片求和规则:同一 toolUseId 名下多个 agent 之和 ──────────────────
check('同一 toolUseId 名下 N 个 agent 各自保留金额,合计 = 各 costUsd 之和', () => {
  const r = computeCostForAgents([
    agent({ toolUseId: 'toolu_wf', agentSessionId: 'agent-w1' }),
    agent({ toolUseId: 'toolu_wf', agentSessionId: 'agent-w2' }),
    agent({ toolUseId: 'toolu_wf', agentSessionId: 'agent-w3' }),
  ], provider);
  const cardAgents = r.agents.filter((a) => a.toolUseId === 'toolu_wf');
  assert.equal(cardAgents.length, 3);
  assert.equal(r.totalUsd, cardAgents.reduce((acc, a) => acc + a.costUsd, 0));
  assert.ok(r.agents.every((a) => typeof a.costUsd === 'number'));
});
check('部分失败时合计 = 成功那部分(卡片金额规则:null 不参与求和)', () => {
  const r = computeCostForAgents([
    agent({ toolUseId: 'toolu_wf', agentSessionId: 'agent-w1' }),
    agent({ toolUseId: 'toolu_wf', agentSessionId: 'agent-w2', model: 'pa-never-priced' }),
  ], provider);
  const cardSum = r.agents.filter((a) => a.toolUseId === 'toolu_wf' && a.costUsd != null)
    .reduce((acc, a) => acc + a.costUsd, 0);
  assert.equal(r.totalUsd, cardSum);
  assert.equal(r.agents.filter((a) => a.costUsd === null).length, 1, '「另有 N 个未能计价」的 N');
});

// ── 5. B 项的口径对子代理同样生效(走同一个入口)────────────────────────
check('分时段:同一 agent 的多次调用各按自己的 at 计价', () => {
  const PEAK = quote({
    quoteId: 'pa-peak', modelId: 'pa-period', prices: { input: 10, output: 10, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
    conditions: { period: 'peak' },
  });
  const OFF = quote({
    quoteId: 'pa-off', modelId: 'pa-period', prices: { input: 5, output: 5, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
    conditions: { period: 'off-peak' },
  });
  useQuotes(PEAK, OFF);
  const single = agent({
    model: 'pa-period',
    usage: usage({ input_tokens: 2000 }), timestamp: '2026-09-11T02:00:00.000Z',
    usageCalls: [
      { at: '2026-09-11T02:00:00.000Z', usage: usage({ input_tokens: 1000 }) },   // 周五北京 10:00 = 高峰
      { at: '2026-09-11T12:00:00.000Z', usage: usage({ input_tokens: 1000 }) },   // 周五北京 20:00 = 空闲
    ],
  });
  const r = computeCostForAgents([single], provider);
  assert.equal(r.agents[0].costUsd, usd(1000, 10) + usd(1000, 5), '两段各按自己的时段价');
  assert.equal(r.agents[0].costUsd, computeCostForMessage({ model: 'pa-period', ...single }, provider).totalUsd,
    '与 computeCostForMessage 同一结果(不新开计价路径)');
  useQuotes(OPUS, SONNET);
});
check('TTL 两档:子代理的 cache_creation 分项参与写费精算', () => {
  const u = usage({
    cache_creation_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
  });
  const r = computeCostForAgents([agent({ usage: u })], provider);
  assert.equal(r.agents[0].costUsd, usd(1000, 6.25) + usd(1000, 10), '5m 与 1h 各按自己的档价');
  const direct = computeCost('claude-opus-5', u, provider, { at: '2026-09-11T02:00:00.000Z' });
  assert.equal(r.agents[0].costUsd, direct.totalUsd);
});

// ── 6. 币种随 agent(展示层折算的依据)──────────────────────────────────
check('全部同币种 → 顶层 currency;多币种混排 → 不给(单个数说不清)且各自带币种', () => {
  const CNY = quote({
    quoteId: 'pa-cny', modelId: 'pa-cny-model', currency: 'CNY',
    prices: { input: 7.2, output: 7.2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
  });
  useQuotes(OPUS, CNY);
  const one = computeCostForAgents([agent()], provider);
  assert.equal(one.currency, 'USD');
  const both = computeCostForAgents([
    agent(), agent({ agentSessionId: 'agent-cny', toolUseId: 'toolu-cny', model: 'pa-cny-model', usage: usage({ input_tokens: 1000 }) }),
  ], provider);
  assert.ok(!('currency' in both), '多币种不给顶层币种');
  assert.equal(both.agents[1].currency, 'CNY');
  assert.equal(both.agents[0].currency, 'USD');
  useQuotes(OPUS, SONNET);
});

// ── 7. 纯函数:不改入参、同输入同输出 ────────────────────────────────────
check('不改传入数组(逐字段快照相等)且同输入同输出', () => {
  const input = [agent()];
  const snapshot = JSON.parse(JSON.stringify(input));
  const a = computeCostForAgents(input, provider);
  const b = computeCostForAgents(input, provider);
  assert.deepEqual(input, snapshot, '传入的 agents 不得被改写');
  assert.deepEqual(a, b, '同输入同输出');
});
check('纯函数:不读「现在」—— 不传 timestamp 且模型不分时段时照常计价', () => {
  const at = agent({ timestamp: undefined, usageCalls: undefined, usage: usage({ input_tokens: 1000 }) });
  const r = computeCostForAgents([at], provider);
  assert.equal(r.agents[0].costUsd, usd(1000, 5));
});

// ── 8. 不污染既有出口 ───────────────────────────────────────────────────
check('新出口不改 computeCost / computeCostForMessage 的返回形状', () => {
  const c = computeCost('claude-opus-5', usage({ input_tokens: 1000 }), provider, { at: '2026-09-11T02:00:00.000Z' });
  assert.equal(typeof c.totalUsd, 'number');
  const m = computeCostForMessage({ model: 'claude-opus-5', usage: usage({ input_tokens: 1000 }) }, provider);
  assert.equal(m.totalUsd, c.totalUsd, '两处出口金额一致');
  assert.ok(!('count' in m), '既有出口不得长出 computeCostForAgents 的字段');
  assert.equal(Object.keys(computeCostForAgents([], provider)).length, 4, '空结果只回契约里的四个键');
});

console.log(failed ? `\n${failed} 条失败` : '\n✓ check-pricing-agents: 子代理逐条计价 全过');
process.exit(failed ? 1 : 0);
