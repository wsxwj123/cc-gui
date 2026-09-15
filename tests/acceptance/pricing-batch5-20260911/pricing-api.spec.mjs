// PR-01 … PR-20 — R20/R21/R24 pricing contract over public HTTP only.
// Contract: .devflow/INTERFACE.md「官方价格、用量和展示（R20–R24）」+「公共规则、身份与错误」
// + 补充边界矩阵 pricing/usage 行. Fixture-free cases; refresh cases touch the network through
// the product itself (the instance is disposable).
import { test, expect } from '@playwright/test';
import {
  CONTRACT_PRESET_IDS, PROVIDER_STATUS, QUOTE_STATUS, SOURCE_KIND, BILLING_MODES, SOURCE_ERROR_CODES,
  PROVIDER_FIELDS, getPricing, postRefresh, waitForRefresh, readRefresh, collectRefreshProviderEntries,
  expectJsonError, getRuntime, officialHostsFor, CONTRACT_CURRENCY, uniqueId,
} from './helpers/pr5-runtime.mjs';

let BASE;

test.beforeAll(() => {
  BASE = getRuntime().baseURL;
});

async function pricing(request) {
  const result = await getPricing(request, BASE);
  expect(result.status, `GET /api/pricing must answer 200; body: ${JSON.stringify(result.body).slice(0, 200)}`).toBe(200);
  const body = result.body;
  expect(body, 'GET /api/pricing body').toBeTruthy();
  return body;
}

function quoteKey(quote) {
  return JSON.stringify([quote.provider ?? quote.presetIds ?? quote.providerId ?? null, quote.modelId ?? quote.displayName ?? null, quote.currency ?? null, quote.conditions ?? null]);
}

function priceValues(quote) {
  return Object.values(quote.prices ?? {});
}

function isPriced(quote) {
  return priceValues(quote).some(value => typeof value === 'number');
}

test('PR-01 [R20/R24] GET /api/pricing 保留兼容四字段并新增 schemaVersion:2/providers/quotes/refresh', async ({ request }) => {
  const body = await pricing(request);
  expect(typeof body.source, '兼容字段 source').toBe('string');
  expect(body.fetchedAt, '兼容字段 fetchedAt').toBeTruthy();
  expect(body.prices, '兼容字段 prices').toBeTruthy();
  expect(body.schemaVersion, 'schemaVersion:2').toBe(2);
  expect(Array.isArray(body.providers), 'providers[]').toBe(true);
  expect(Array.isArray(body.quotes), 'quotes[]').toBe(true);
  expect(body.refresh, 'refresh 状态对象').toBeTruthy();
  expect(typeof body.refresh, 'refresh 类型').toBe('object');
});

test('PR-02 [R20/R24] providers 每项带合同字段、状态取自六值枚举、不用 unknown 冒充', async ({ request }) => {
  const { providers } = await pricing(request);
  expect(providers.length, 'providers 非空').toBeGreaterThan(0);
  for (const provider of providers) {
    for (const field of PROVIDER_FIELDS) {
      expect(field in provider, `provider ${provider.presetId} 缺少字段 ${field}`).toBe(true);
    }
    expect(PROVIDER_STATUS, `provider ${provider.presetId} 的 status`).toContain(provider.status);
    expect(provider.status, `provider ${provider.presetId} 不得用 unknown 作状态`).not.toBe('unknown');
    expect(BILLING_MODES, `provider ${provider.presetId} 的 billingMode`).toContain(provider.billingMode);
    expect(typeof provider.modelCount, `provider ${provider.presetId} 的 modelCount`).toBe('number');
    expect(Number.isInteger(provider.modelCount) && provider.modelCount >= 0, `modelCount 必须是非负整数`).toBe(true);
    expect(Array.isArray(provider.unresolvedModels), `provider ${provider.presetId} 的 unresolvedModels`).toBe(true);
    expect(typeof provider.sourceUrl === 'string' && provider.sourceUrl.length > 0, `provider ${provider.presetId} 的 sourceUrl`).toBe(true);
  }
});

test('PR-03 [R20] 合同 43 条预设 id 全部出现在 providers（覆盖分母无缺失、不重复）', async ({ request }) => {
  const { providers } = await pricing(request);
  const ids = providers.map(provider => provider.presetId);
  const missing = CONTRACT_PRESET_IDS.filter(id => !ids.includes(id));
  expect(missing, `下列预设没有任何 providers 状态，覆盖分母缺失: ${missing.join(', ')}`).toEqual([]);
  expect(new Set(ids).size, 'providers 不得重复同一 presetId').toBe(ids.length);
});

test('PR-04 [R24] 每个来源 URL 都指该家官方源主机，不用第三方索引冒充官方', async ({ request }) => {
  const { providers, quotes } = await pricing(request);
  const offenders = [];
  const check = (presetId, rawUrl, where) => {
    const hosts = officialHostsFor(presetId);
    if (!hosts) return;
    let host;
    try { host = new URL(rawUrl).host; } catch { offenders.push(`${where} 不是绝对 URL: ${rawUrl}`); return; }
    if (!hosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) {
      offenders.push(`${where} 指向非官方主机 ${host}（官方应为 ${hosts.join('/')}）`);
    }
  };
  for (const provider of providers) check(provider.presetId, provider.sourceUrl, `provider ${provider.presetId}`);
  for (const quote of quotes) {
    const presetId = quote.provider ?? (Array.isArray(quote.presetIds) ? quote.presetIds[0] : null);
    if (presetId && quote.sourceUrl) check(presetId, quote.sourceUrl, `quote ${quote.quoteId}`);
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
});

test('PR-05 [R24] quotes 形状合法且 quoteId 在同源两次读取间稳定', async ({ request }) => {
  const first = await pricing(request);
  const second = await pricing(request);
  const byKey = new Map();
  for (const quote of second.quotes) byKey.set(quoteKey(quote), quote.quoteId);
  for (const quote of first.quotes) {
    expect(typeof quote.quoteId === 'string' && quote.quoteId.length > 0, 'quoteId 必须是非空字符串').toBe(true);
    expect(SOURCE_KIND, `quote ${quote.quoteId} 的 sourceKind`).toContain(quote.sourceKind);
    expect(QUOTE_STATUS, `quote ${quote.quoteId} 的 status`).toContain(quote.status);
    expect(typeof quote.currency === 'string' && quote.currency.length > 0, `quote ${quote.quoteId} 的 currency`).toBe(true);
    expect(typeof quote.unit === 'string' && quote.unit.length > 0, `quote ${quote.quoteId} 的 unit`).toBe(true);
    expect(quote.fetchedAt, `quote ${quote.quoteId} 的 fetchedAt`).toBeTruthy();
    expect(typeof quote.parserVersion === 'string' && quote.parserVersion.length > 0, `quote ${quote.quoteId} 的 parserVersion`).toBe(true);
    expect(quote.modelId || quote.displayName, `quote ${quote.quoteId} 必须有官方 modelId 或未解析 displayName`).toBeTruthy();
    expect(quote.provider || (Array.isArray(quote.presetIds) && quote.presetIds.length), `quote ${quote.quoteId} 必须有 provider/presetIds`).toBeTruthy();
    expect(quote.validFrom === null || typeof quote.validFrom === 'string' || typeof quote.validFrom === 'number', 'validFrom 不明应为 null').toBe(true);
    expect(quote.validTo === null || typeof quote.validTo === 'string' || typeof quote.validTo === 'number', 'validTo 不明应为 null').toBe(true);
    const twin = byKey.get(quoteKey(quote));
    if (twin) expect(twin, `同一条报价在两次读取间 quoteId 必须稳定（${quote.quoteId}）`).toBe(quote.quoteId);
  }
  const ids = first.quotes.map(quote => quote.quoteId);
  expect(new Set(ids).size, 'quoteId 必须唯一').toBe(ids.length);
});

test('PR-06 [R24] 未知维度用 null，不得用 0 或缺省倍率顶替', async ({ request }) => {
  const { quotes } = await pricing(request);
  const bad = [];
  for (const quote of quotes) {
    if (!quote.prices || typeof quote.prices !== 'object') { bad.push(`${quote.quoteId} 缺 prices 对象`); continue; }
    if (!('input' in quote.prices) || !('output' in quote.prices)) bad.push(`${quote.quoteId} 缺普通 input/output 维度键`);
    for (const [dim, value] of Object.entries(quote.prices)) {
      if (value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        bad.push(`${quote.quoteId} 维度 ${dim} 的值 ${JSON.stringify(value)} 不是非负有限数或 null`);
      }
    }
    if (['unresolved', 'not-applicable'].includes(quote.status)) {
      const zeroed = Object.entries(quote.prices).filter(([, value]) => value === 0).map(([dim]) => dim);
      if (zeroed.length) bad.push(`${quote.quoteId} status=${quote.status} 却把未提供的维度写成 0: ${zeroed.join(',')}`);
    }
  }
  expect(bad, bad.join('\n')).toEqual([]);
});

test('PR-07 [R21/R24] 有价必须有币种与单位；0 价不得与"未提供/不支持"混用', async ({ request }) => {
  const { quotes } = await pricing(request);
  const bad = [];
  for (const quote of quotes) {
    if (!isPriced(quote)) continue;
    if (!quote.currency) bad.push(`${quote.quoteId} 有价但没有币种`);
    if (!quote.unit) bad.push(`${quote.quoteId} 有价但没有计量单位`);
    if (quote.status === 'unresolved') bad.push(`${quote.quoteId} 有价却标 unresolved`);
  }
  expect(bad, bad.join('\n')).toEqual([]);
});

test('PR-08 [R21] 币种按来源分离：合同已声明的源不得换币种，mistral 双币种并存', async ({ request }) => {
  const { quotes } = await pricing(request);
  const bad = [];
  for (const quote of quotes) {
    const presetId = quote.provider ?? (Array.isArray(quote.presetIds) ? quote.presetIds[0] : null);
    const expected = CONTRACT_CURRENCY[presetId];
    if (!expected || !isPriced(quote)) continue;
    if (!expected.includes(quote.currency)) bad.push(`${presetId} 报价币种 ${quote.currency}，合同声明 ${expected.join('/')}`);
  }
  const mistralCurrencies = new Set(quotes
    .filter(quote => (quote.provider ?? quote.presetIds?.[0]) === 'mistral' && isPriced(quote))
    .map(quote => quote.currency));
  if (mistralCurrencies.size > 1) {
    expect([...mistralCurrencies].every(c => ['USD', 'EUR'].includes(c)), 'mistral 双标价只有 USD/EUR').toBe(true);
  }
  expect(bad, bad.join('\n')).toEqual([]);
});

test('PR-09 [R20/R24 反向] 不展示无来源的价格：兼容 prices 的每个模型都能落到带 sourceUrl 的报价', async ({ request }) => {
  const { prices, quotes } = await pricing(request);
  const orphans = [];
  for (const model of Object.keys(prices || {})) {
    const matches = quotes.filter(quote => quote.modelId === model || quote.displayName === model);
    if (!matches.length) { orphans.push(`${model} 在 quotes 里没有任何来源`); continue; }
    if (!matches.some(quote => typeof quote.sourceUrl === 'string' && quote.sourceUrl.length > 0)) {
      orphans.push(`${model} 的报价没有 sourceUrl`);
    }
  }
  expect(orphans, orphans.join('\n')).toEqual([]);
});

test('PR-10 [R24] 兼容四字段只是单一明确报价的归一视图，不凭空造数', async ({ request }) => {
  const { prices, quotes } = await pricing(request);
  const bad = [];
  for (const [model, entry] of Object.entries(prices || {})) {
    const matches = quotes.filter(quote => quote.modelId === model || quote.displayName === model);
    const pool = matches.flatMap(quote => priceValues(quote)).filter(value => typeof value === 'number');
    for (const [field, value] of Object.entries(entry)) {
      if (value === null || value === undefined) continue;
      if (!pool.includes(value)) bad.push(`${model}.${field}=${value} 在 quotes 里找不到同值来源`);
    }
  }
  expect(bad, bad.join('\n')).toEqual([]);
});

test('PR-11 [R20] 汇总与明细自洽：modelCount=0 不得有已定价报价，modelCount>0 必须有价或未解析项', async ({ request }) => {
  const { providers, quotes } = await pricing(request);
  const bad = [];
  for (const provider of providers) {
    const own = quotes.filter(quote => quote.provider === provider.presetId || quote.presetIds?.includes(provider.presetId));
    const priced = own.filter(isPriced);
    if (provider.modelCount === 0 && priced.length) bad.push(`${provider.presetId} modelCount=0 但有 ${priced.length} 条有价报价`);
    if (provider.modelCount > 0 && !priced.length && !(provider.unresolvedModels || []).length) {
      bad.push(`${provider.presetId} modelCount=${provider.modelCount} 但既无有价报价也无未解析模型`);
    }
    if (provider.unresolvedModels.length > provider.modelCount) {
      bad.push(`${provider.presetId} 未解析模型数 ${provider.unresolvedModels.length} 超过 modelCount ${provider.modelCount}`);
    }
  }
  expect(bad, bad.join('\n')).toEqual([]);
});

test('PR-12 [R24] 状态/时间/错误码自洽：fresh 有时间、source-unavailable 有错误码', async ({ request }) => {
  const { providers } = await pricing(request);
  const bad = [];
  const parseTime = value => (typeof value === 'number' ? value : Date.parse(value));
  for (const provider of providers) {
    const id = provider.presetId;
    if (provider.status === 'fresh' && !provider.fetchedAt) bad.push(`${id} fresh 却没有 fetchedAt`);
    if (provider.status === 'stale' && !provider.fetchedAt) bad.push(`${id} stale 却没有保留上一次 fetchedAt`);
    if (provider.status === 'source-unavailable' && !provider.errorCode) bad.push(`${id} source-unavailable 却没有 errorCode`);
    if (provider.errorCode && !SOURCE_ERROR_CODES.includes(provider.errorCode)) bad.push(`${id} errorCode ${provider.errorCode} 不在合同枚举内`);
    for (const [field, value] of [['attemptedAt', provider.attemptedAt], ['fetchedAt', provider.fetchedAt]]) {
      if (value !== null && value !== undefined && !Number.isFinite(parseTime(value))) bad.push(`${id} 的 ${field} 无法解析为时间: ${value}`);
    }
    if (provider.fetchedAt && provider.attemptedAt && Number.isFinite(parseTime(provider.fetchedAt)) && Number.isFinite(parseTime(provider.attemptedAt))) {
      if (parseTime(provider.fetchedAt) < parseTime(provider.attemptedAt)) bad.push(`${id} fetchedAt 早于 attemptedAt`);
    }
  }
  expect(bad, bad.join('\n')).toEqual([]);
});

test('PR-13 [R21] 多档/多币种各占独立报价、条件可区分，不互相覆盖', async ({ request }) => {
  const { quotes } = await pricing(request);
  const groups = new Map();
  for (const quote of quotes) {
    const presetId = quote.provider ?? quote.presetIds?.[0] ?? '';
    const key = `${presetId}|${quote.modelId ?? quote.displayName ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(quote);
  }
  const dupes = [];
  for (const [key, list] of groups) {
    const seen = new Map();
    for (const quote of list) {
      if (!isPriced(quote)) continue;
      const signature = JSON.stringify([quote.currency, quote.prices, quote.conditions ?? null]);
      if (seen.has(signature)) dupes.push(`${key} 出现完全相同的重复报价 ${seen.get(signature)} / ${quote.quoteId}`);
      seen.set(signature, quote.quoteId);
    }
  }
  expect(dupes, dupes.join('\n')).toEqual([]);
  // 同模型多档时条件必须能区分（conditions 非空）
  const multi = [...groups.entries()].filter(([, list]) => list.filter(isPriced).length > 1);
  for (const [key, list] of multi) {
    const priced = list.filter(isPriced);
    const withoutConditions = priced.filter(quote => !quote.conditions || (typeof quote.conditions === 'object' && Object.keys(quote.conditions).length === 0));
    expect(withoutConditions.length, `${key} 有多条报价，条件必须能区分档位/TTL/时段`).toBeLessThan(priced.length);
  }
});

test('PR-14 [R20] POST /api/pricing/refresh 子集：202 running 且可观察到终态', async ({ request }) => {
  const result = await postRefresh(request, BASE, { presetIds: ['cerebras'] });
  expect([202], `refresh 合法请求应 202，实际 ${result.status}: ${JSON.stringify(result.body).slice(0, 200)}`).toContain(result.status);
  expect(result.body?.ok !== false, 'refresh 成功响应不得是 ok:false').toBe(true);
  expect(result.body?.refreshId, 'refreshId').toBeTruthy();
  expect(result.body?.status, 'refresh 初始状态').toBe('running');
  const done = await waitForRefresh(request, BASE, result.body.refreshId, { timeoutMs: 30_000 });
  const refresh = readRefresh(done, result.body.refreshId);
  expect([...['running', 'completed', 'partial', 'failed']], '顶层状态只有这四种').toContain(refresh.status);
  expect(refresh.status, '30 秒内应观察到终态（单源 15 秒超时）').not.toBe('running');
  const entries = collectRefreshProviderEntries(refresh);
  expect([...entries.keys()], '逐家结果必须覆盖被请求的源').toContain('cerebras');
});

test('PR-15 [R20] refresh 顶层语义：全成功 completed、部分 partial、无成功 failed；unmapped 不算成功', async ({ request }) => {
  const result = await postRefresh(request, BASE, { presetIds: ['cerebras', 'openrouter'] });
  expect(result.status, 'refresh 请求').toBe(202);
  const done = await waitForRefresh(request, BASE, result.body.refreshId, { timeoutMs: 30_000 });
  const refresh = readRefresh(done, result.body.refreshId);
  const entries = collectRefreshProviderEntries(refresh);
  const successStates = ['fresh', 'partial', 'not-token-priced'];
  const states = [...entries.values()].map(entry => entry.status ?? entry.state);
  if (states.length) {
    const successes = states.filter(state => successStates.includes(state)).length;
    const expected = successes === states.length ? 'completed' : successes === 0 ? 'failed' : 'partial';
    // not-token-priced 且拿到套餐规则算成功；unmapped 不算成功
    expect(states.filter(state => state === 'unmapped').length === 0 || refresh.status !== 'completed',
      'unmapped 不得算作成功源').toBe(true);
    expect(refresh.status, `顶层状态与逐家结果不符（逐家: ${states.join(',')}）`).toBe(expected);
  } else {
    expect(['completed', 'partial', 'failed'], '没有逐家明细时也要有明确终态').toContain(refresh.status);
  }
});

test('PR-16 [R20] 每家独立成败：只刷新请求的源，其他源的最后有效价不受影响', async ({ request }) => {
  const before = await pricing(request);
  expect(Array.isArray(before.providers), 'GET /api/pricing 必须返回 providers[]（R20 合同）').toBe(true);
  const beforeById = new Map(before.providers.map(provider => [provider.presetId, provider]));
  const requested = ['cerebras'];
  const result = await postRefresh(request, BASE, { presetIds: requested });
  expect(result.status).toBe(202);
  await waitForRefresh(request, BASE, result.body.refreshId, { timeoutMs: 30_000 });
  const after = await pricing(request);
  for (const provider of after.providers) {
    const previous = beforeById.get(provider.presetId);
    if (!previous) continue;
    if (!requested.includes(provider.presetId)) {
      expect(provider.status, `未请求的源 ${provider.presetId} 状态不应因别人刷新而改变`).toBe(previous.status);
      expect(provider.fetchedAt, `未请求的源 ${provider.presetId} fetchedAt 不应改变`).toBe(previous.fetchedAt);
    } else {
      expect(PROVIDER_STATUS).toContain(provider.status);
    }
  }
  const untouched = 'openrouter';
  const beforeUntouched = before.quotes.filter(quote => (quote.provider ?? quote.presetIds?.[0]) === untouched);
  const afterUntouched = after.quotes.filter(quote => (quote.provider ?? quote.presetIds?.[0]) === untouched);
  if (beforeUntouched.length) {
    expect(afterUntouched.length, `未刷新的源 ${untouched} 不得被清空报价`).toBeGreaterThan(0);
  }
});

test('PR-17 [R20 错误] 非法 presetIds 一律 400 PRICING_INVALID_PROVIDER，混入非法项整体拒绝', async ({ request }) => {
  const cases = [
    ['空数组', { presetIds: [] }],
    ['非数组', { presetIds: 'deepseek-official' }],
    ['未知 id', { presetIds: [uniqueId('no_such_preset')] }],
    ['混合合法与非法', { presetIds: ['deepseek-official', uniqueId('no_such_preset')] }],
  ];
  for (const [label, payload] of cases) {
    const result = await postRefresh(request, BASE, payload);
    expectJsonError(result, { status: 400, code: 'PRICING_INVALID_PROVIDER', mustNotContain: ['http://', 'https://'] });
    expect(label).toBeTruthy();
  }
});

test('PR-18 [R20 错误] 不接受用户传入 url/header/key，注入不改变任何来源地址', async ({ request }) => {
  const before = await pricing(request);
  expect(Array.isArray(before.providers), 'GET /api/pricing 必须返回 providers[]（R20 合同）').toBe(true);
  const beforeUrls = new Map(before.providers.map(provider => [provider.presetId, provider.sourceUrl]));
  const result = await postRefresh(request, BASE, {
    presetIds: ['cerebras'],
    url: 'http://127.0.0.1:1/evil',
    headers: { 'x-pr5': 'evil' },
    key: 'PR5_SHOULD_NEVER_BE_USED',
  });
  expect([202, 400], `带 url/header/key 的请求只能被忽略或拒绝，实际 ${result.status}`).toContain(result.status);
  if (result.status === 202) await waitForRefresh(request, BASE, result.body.refreshId, { timeoutMs: 30_000 });
  const after = await pricing(request);
  for (const provider of after.providers) {
    if (beforeUrls.has(provider.presetId)) {
      expect(provider.sourceUrl, `${provider.presetId} 的来源地址不得被请求参数改写`).toBe(beforeUrls.get(provider.presetId));
    }
  }
  expect(JSON.stringify(after.providers)).not.toContain('127.0.0.1:1');
});

test('PR-19 [R20] refreshId 生命周期：同批重复请求同一 id；未知 id 404 PRICING_REFRESH_NOT_FOUND', async ({ request }) => {
  const payload = { presetIds: ['cerebras'] };
  const first = await postRefresh(request, BASE, payload);
  expect(first.status).toBe(202);
  const again = await postRefresh(request, BASE, payload);
  expect(again.status, '同批重复请求').toBe(202);
  expect(again.body.refreshId, '同一批重复请求必须返回同 refreshId').toBe(first.body.refreshId);

  const withId = await getPricing(request, BASE, { refreshId: first.body.refreshId });
  expect(withId.status, '带 refreshId 的 GET 仍返回当前价目').toBe(200);
  expect(withId.body?.prices, '带 refreshId 的 GET 必须仍带当前价目').toBeTruthy();
  expect(withId.body?.refresh, '带 refreshId 的 GET 必须带刷新状态').toBeTruthy();

  const unknown = await getPricing(request, BASE, { refreshId: uniqueId('pr_nope') });
  expectJsonError({ status: unknown.status, body: unknown.body }, { status: 404, code: 'PRICING_REFRESH_NOT_FOUND' });
});

test('PR-20 [R20] 24 小时内用缓存：刚刷新过的源在连续读取间不重复抓取', async ({ request }) => {
  const result = await postRefresh(request, BASE, { presetIds: ['cerebras'] });
  expect(result.status).toBe(202);
  await waitForRefresh(request, BASE, result.body.refreshId, { timeoutMs: 30_000 });
  const first = await pricing(request);
  expect(Array.isArray(first.providers), 'GET /api/pricing 必须返回 providers[]（R20 合同）').toBe(true);
  const cerebras = first.providers.find(provider => provider.presetId === 'cerebras');
  expect(cerebras).toBeTruthy();
  await new Promise(resolve => setTimeout(resolve, 3_000));
  const second = await pricing(request);
  const again = second.providers.find(provider => provider.presetId === 'cerebras');
  expect(again.fetchedAt, '24 小时窗口内不得重新抓取（fetchedAt 必须不变）').toBe(cerebras.fetchedAt);
  expect(again.attemptedAt, '24 小时窗口内不得重新抓取（attemptedAt 必须不变）').toBe(cerebras.attemptedAt);
});

test('PR-21 [R24 反向] 刷新进行中读取：旧价目仍在且相应源标 stale，不清空', async ({ request }) => {
  const before = await pricing(request);
  expect(Array.isArray(before.providers), 'GET /api/pricing 必须返回 providers[]（R20 合同）').toBe(true);
  if (!Object.keys(before.prices || {}).length) {
    test.info().annotations.push({ type: 'note', description: '当前实例没有任何价目，无法验证"刷新期间旧结果可见"' });
  }
  const result = await postRefresh(request, BASE, {}); // 省略 = 全预设（慢，足以捕到 running 窗口）
  expect(result.status, '省略 presetIds 刷新全预设').toBe(202);
  const during = await pricing(request);
  const refresh = during.refresh;
  expect(refresh, '刷新期间 GET 必须带 refresh 状态').toBeTruthy();
  if (refresh.status === 'running' || (refresh.refreshId && refresh.refreshId !== result.body.refreshId)) {
    const runningIds = new Set([...collectRefreshProviderEntries(refresh).keys()].filter(id => {
      const entry = collectRefreshProviderEntries(refresh).get(id);
      return (entry.status ?? entry.state) === 'running';
    }));
    const stale = during.providers.filter(provider => runningIds.has(provider.presetId));
    for (const provider of stale) {
      expect(['stale'], `${provider.presetId} 刷新进行中必须把上一份结果标为 stale`).toContain(provider.status);
    }
  }
  expect(during.prices, '刷新进行中不得清空当前价目').toBeTruthy();
});
