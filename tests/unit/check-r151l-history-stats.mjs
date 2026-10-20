#!/usr/bin/env node
// r151l 判官修正 —— 会话**全量**历史统计(historyStats)单测。
//
// 覆盖四件事:
//   1. buildHistoryStats(messages) 纯函数:工具数/模型去重/按模型 + 峰谷时段的用量汇总,
//      与客户端逐条口径一致(usageCalls 优先、无明细回落到整条 usage、非法用量不并入);
//   2. aggregateHistoryCost(usageByModel, provider) 与逐条 computeCostForMessage 求和相等
//      (含分时段模型与两档 TTL 缓存写);
//   3. /messages?limit=2 的响应里 historyStats 仍是全量(与窗口无关);
//   4. 统计口径标签与费用同一判据 + 费用估算说明写清偏差来源(窄复审②)。
// Run: node tests/unit/check-r151l-history-stats.mjs
// 变异哨兵:把 historyStats 放在切窗之后算 → t3 红;按模型汇总丢掉 byPeriod → t2 分时段金额
// 不等;aggregateCost 不读 cacheWrite5m/1h → t2 的 Claude 写费变「未知」。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { buildHistoryStats } = await import('../../server/utils/history-stats.js');
const { setPricingCatalog } = await import('../../client/src/utils/pricingCatalog.js');
const { aggregateHistoryCost, computeCostForMessage, displayUsd } = await import('../../client/src/utils/pricing.js');
const { HISTORY_COST_ESTIMATE_NOTE, hasFullHistoryStats, historyStatsScopeLabel } = await import('../../client/src/utils/historyStatsScope.js');

const fixture = JSON.parse(readFileSync(join(root, 'tests/unit/fixtures/pricing-catalog-fixture.json'), 'utf8'));
setPricingCatalog(fixture);
const provider = { providerHint: 'anthropic', baseUrl: '', model: null, hasAuthKey: true };
const usage = (o = {}) => ({
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o,
});

// ── t1 纯函数:工具数 / 模型去重 / 全量用量 / 峰谷分桶 / 旧数据回落 ─────────────
{
  const messages = [
    { type: 'user', uuid: 'u1', text: 'hi' },
    {
      type: 'turn', model: 'deepseek-flash', toolCalls: [{}, {}],
      usage: usage({ input_tokens: 100, output_tokens: 10 }),
      usageCalls: [
        { at: '2026-09-11T02:00:00.000Z', usage: usage({ input_tokens: 40, output_tokens: 4 }) },  // 周五 10:00 北京 = 高峰
        { at: '2026-09-12T02:00:00.000Z', usage: usage({ input_tokens: 60, output_tokens: 6 }) },  // 周六 10:00 北京 = 空闲
      ],
    },
    {
      type: 'turn', model: 'deepseek-flash', toolCalls: [{}],
      usage: usage({ input_tokens: 7, output_tokens: 3 }),
      usageCalls: [{ at: '2026-09-11T03:00:00.000Z', usage: usage({ input_tokens: 7, output_tokens: 3 }) }],
    },
    // 没有 usageCalls 的旧形态:按整条 usage + timestamp 算一次(客户端回落分支同口径)。
    {
      type: 'turn', model: 'claude-opus-5', timestamp: '2026-09-12T02:00:00.000Z',
      usage: usage({ input_tokens: 5, cache_creation_input_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 2 } }),
    },
    // 非法用量:不并入行(否则整行模型 USAGE_INVALID,连正常调用都算不出钱)。
    { type: 'turn', model: 'deepseek-flash', usage: usage({ input_tokens: -1 }) },
    // 脏条目不应让统计抛错。
    null,
    { type: 'goal' },
  ];
  const stats = buildHistoryStats(messages);
  assert.equal(stats.total, 7, 'total = 完整消息列表长度');
  assert.equal(stats.totalUserMessages, 1);
  assert.equal(stats.totalToolCalls, 3);
  assert.deepEqual(stats.models, ['deepseek-flash', 'claude-opus-5'], '模型去重且保持首次出现顺序');
  assert.equal(stats.invalidUsageCalls, 1, '负数用量被跳过并计数');

  const ds = stats.usageByModel.find((row) => row.model === 'deepseek-flash');
  assert.ok(ds, 'deepseek-flash 行必须存在');
  assert.equal(ds.input, 107, '两条 turn 的三次调用全量相加');
  assert.equal(ds.output, 13);
  assert.equal(ds.apiCalls, 3);
  assert.equal(ds.byPeriod.peak.apiCalls, 2, '周五 10:00/11:00 两次高峰');
  assert.equal(ds.byPeriod.offPeak.apiCalls, 1, '周六一次空闲');
  assert.equal(ds.byPeriod.peak.input, 47);
  assert.equal(ds.byPeriod.unknown.apiCalls, 0);
  assert.equal(ds.byPeriod.peak.apiCalls + ds.byPeriod.offPeak.apiCalls + ds.byPeriod.unknown.apiCalls, ds.apiCalls);

  const opus = stats.usageByModel.find((row) => row.model === 'claude-opus-5');
  assert.equal(opus?.cacheCreation5m, 2, '旧形态没有 usageCalls → 整条 usage 的 TTL 分项照收');
  assert.equal(buildHistoryStats([]).total, 0, '空列表');
  assert.equal(buildHistoryStats(null).usageByModel.length, 0, '非数组不抛');
}

// ── t2 费用:按模型汇总 → aggregateHistoryCost === 逐条 computeCostForMessage ─────
{
  // ① 分时段模型(官方价目夹具):逐次调用按自己的峰/谷价 → 按模型分桶后金额必须相等。
  const dsMessages = [{
    type: 'turn', model: 'deepseek-flash', timestamp: '2026-09-11T02:00:00.000Z',
    usage: usage({ input_tokens: 1000, output_tokens: 100 }),
    usageCalls: [
      { at: '2026-09-11T02:00:00.000Z', usage: usage({ input_tokens: 600, output_tokens: 60, cache_read_input_tokens: 100 }) },
      { at: '2026-09-12T02:00:00.000Z', usage: usage({ input_tokens: 400, output_tokens: 40 }) },
    ],
  }];
  const dsStats = buildHistoryStats(dsMessages);
  const dsGot = aggregateHistoryCost(dsStats.usageByModel, provider);
  const dsExpected = dsMessages.reduce((acc, m) => {
    const c = computeCostForMessage(m, provider);
    return acc + (c ? displayUsd(c.totalUsd, c.currency) : 0);
  }, 0);
  assert.ok(dsExpected > 0, '夹具应算出金额');
  near(dsGot.usd, dsExpected, '分时段模型:全量按模型聚合的费用必须等于逐条计算之和');
  assert.equal(dsGot.partial, false, '峰/谷两桶都有价 → 无未知维度');

  const row = dsStats.usageByModel.find((r) => r.model === 'deepseek-flash');
  const allPeak = aggregateHistoryCost([{
    ...row,
    byPeriod: {
      peak: { ...row.byPeriod.peak, input: 1000, output: 100, cacheRead: 100, apiCalls: 2 },
      offPeak: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0, apiCalls: 0 },
      unknown: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0, apiCalls: 0 },
    },
  }], provider).usd;
  assert.ok(dsGot.usd < allPeak, '峰谷混合应比全部按高峰价便宜(证明 byPeriod 真的被用上)');

  // ② 两档 TTL 缓存写:aggregateCost 必须消费 cacheWrite5m/1h,否则写费被标未知、金额少算。
  const ttlQuote = {
    quoteId: 'q-ttl', provider: 'pa', presetIds: ['pa'], modelId: 'pa-ttl-model', displayName: 'PA TTL',
    protocol: null, market: 'global', currency: 'USD', unit: 'per 1M tokens',
    prices: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    conditions: null, validFrom: null, validTo: null, sourceUrl: null, sourceKind: 'official',
    fetchedAt: null, parserVersion: 'pr6-1', status: 'fresh',
  };
  setPricingCatalog({ source: 'official-sources', prices: {}, quotes: [ttlQuote], providers: [], refresh: null });
  const ttlMessages = [{
    type: 'turn', model: 'pa-ttl-model', timestamp: '2026-09-11T02:00:00.000Z',
    usage: usage({
      input_tokens: 3000, output_tokens: 500, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
    }),
    usageCalls: [{
      at: '2026-09-11T02:00:00.000Z',
      usage: usage({
        input_tokens: 3000, output_tokens: 500, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 },
      }),
    }],
  }];
  const ttlStats = buildHistoryStats(ttlMessages);
  const ttlGot = aggregateHistoryCost(ttlStats.usageByModel, provider);
  const ttlCost = computeCostForMessage(ttlMessages[0], provider);
  assert.ok(ttlCost && ttlCost.totalUsd > 0, 'TTL 夹具应算出金额');
  near(ttlGot.usd, displayUsd(ttlCost.totalUsd, ttlCost.currency), '两档 TTL 写费:聚合口径必须与逐条一致');
  assert.equal(ttlGot.partial, false, '有 TTL 分项 → 写费不应变未知');
}

// ── t3 端点:limit=2 时 historyStats / total 仍是全量 ─────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'cgui-r151l-stats-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const HASH = '-Users-x-r151l-stats';
  const SID = '77777777-7777-4777-8777-777777777777';
  const dir = join(home, '.claude', 'projects', HASH);
  mkdirSync(dir, { recursive: true });
  const records = [];
  for (let i = 0; i < 6; i += 1) {
    records.push({ type: 'user', uuid: `u${i}`, timestamp: `2026-09-11T0${i}:00:00.000Z`, message: { role: 'user', content: `问题 ${i}` } });
    records.push({
      type: 'assistant', uuid: `a${i}`, timestamp: `2026-09-11T0${i}:30:00.000Z`,
      message: {
        id: `m${i}`, model: i < 3 ? 'deepseek-flash' : 'claude-opus-5',
        content: [{ type: 'text', text: `回答 ${i}` }, { type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }],
        usage: usage({ input_tokens: 10, output_tokens: 2 }),
      },
    });
  }
  writeFileSync(join(dir, `${SID}.jsonl`), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

  const express = (await import('express')).default;
  const { default: sessionRoutes } = await import('../../server/routes/sessions.js');
  const app = express();
  app.use(express.json());
  app.use('/api', sessionRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(SID)}/messages?projectHash=${encodeURIComponent(HASH)}&limit=2`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.messages.length, 2, '窗口生效');
    assert.equal(body.hasMore, true);
    assert.equal(body.total, 12, '6 组 user/turn = 12 条消息');
    assert.ok(body.historyStats, '响应必须带 historyStats');
    assert.equal(body.historyStats.total, 12, '全量 total 不受窗口影响');
    assert.equal(body.historyStats.totalToolCalls, 6, '全量工具调用数不受窗口影响');
    assert.deepEqual(body.historyStats.models, ['deepseek-flash', 'claude-opus-5']);
    const sum = body.historyStats.usageByModel.reduce((acc, row) => ({
      input: acc.input + row.input, output: acc.output + row.output, cacheRead: acc.cacheRead + row.cacheRead,
      cacheCreation: acc.cacheCreation + row.cacheCreation, apiCalls: acc.apiCalls + row.apiCalls,
    }), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, apiCalls: 0 });
    assert.deepEqual(sum, {
      input: body.usageTotals.input, output: body.usageTotals.output,
      cacheRead: body.usageTotals.cacheRead, cacheCreation: body.usageTotals.cacheCreation,
      apiCalls: body.usageTotals.apiCalls,
    }, '主会话全量统计与 usageTotals 同源同值(此夹具无子代理)');
    // 不带 limit 的旧调用同样带全量统计字段(纯新增,不改旧字段)。
    const full = await (await fetch(`${base}/api/sessions/${encodeURIComponent(SID)}/messages?projectHash=${encodeURIComponent(HASH)}`)).json();
    assert.deepEqual(full.historyStats, body.historyStats, '分页与全量的 historyStats 逐值相等');
  } finally {
    server.close();
  }
}

// ── t4 请求代号:见 tests/unit/check-r151l-history-page.mjs(客户端分页纯逻辑)──

// ── t5 统计口径:label 与费用用同一个判据(窄复审②)──────────────────────────
{
  // 正常全量统计 → 全量口径可算费用,标签也必须说全量。
  const full = { total: 300, models: ['m'], usageByModel: [{ model: 'm' }] };
  assert.equal(hasFullHistoryStats(full), true);
  assert.match(historyStatsScopeLabel(full, 120, 300), /统计范围:全量 300 条消息/);

  // historyStats 存在但字段异常:费用会回退到已加载窗口 → 标签必须同步标"仅已加载",
  // 不能因为 `!!serverHistoryStats` 为真就误标全量(两套判据的原始 bug)。
  const noUsage = { total: 300, models: ['m'] };
  assert.equal(hasFullHistoryStats(noUsage), false, '缺 usageByModel → 费用不可按全量算');
  assert.equal(hasFullHistoryStats({ total: 300, usageByModel: [] }), false, '缺 models → 同上');
  assert.equal(hasFullHistoryStats({ total: 300, models: [], usageByModel: {} }), false, 'usageByModel 非数组 → 同上');
  assert.equal(hasFullHistoryStats(null), false);
  assert.equal(hasFullHistoryStats(undefined), false);
  assert.match(historyStatsScopeLabel(noUsage, 120, 300), /统计范围:仅已加载的最近 120 条消息/);
  assert.match(historyStatsScopeLabel(null, 120, 300), /仅已加载/);
  // 全量统计但 total 缺失 → 条数回落到已加载,不显示 NaN。
  assert.match(historyStatsScopeLabel({ models: [], usageByModel: [] }, 120, undefined), /全量 120 条/);

  // 费用估算口径必须写清三类偏差来源 + 子代理口径差异(弹层/手机条直接显示这句)。
  assert.match(HISTORY_COST_ESTIMATE_NOTE, /估算/, '必须明说是估算');
  assert.match(HISTORY_COST_ESTIMATE_NOTE, /价目/, '必须提跨价目生效日');
  assert.match(HISTORY_COST_ESTIMATE_NOTE, /分档|TTL/, '必须提分档/TTL 分项缺失');
  assert.match(HISTORY_COST_ESTIMATE_NOTE, /子代理/, '必须提子代理口径差异');
}

console.log('check-r151l-history-stats: all passed');
