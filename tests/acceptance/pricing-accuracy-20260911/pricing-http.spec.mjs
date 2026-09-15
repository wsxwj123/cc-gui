// PA-4xx：HTTP 面 —— GET /api/pricing、POST /api/pricing/refresh、GET /api/usage（byPeriod）、
// GET /api/sessions/:id/messages（usageCalls 与错误契约）。契约 §3.1–§3.4、§10.1、§10.5。
import { test, expect } from '@playwright/test';
import {
  getRuntime, getPricing, postRefresh, getUsage, readMessages, readMessagesRaw, jsonBody,
  expectJsonError, pricingPayload, EnvironmentBlocked,
} from './helpers/pa-runtime.mjs';
import { ensureFixtureManifest } from './helpers/pa-fixtures.mjs';

const TOP_LEVEL_KEYS = ['source', 'fetchedAt', 'prices', 'schemaVersion', 'providers', 'quotes', 'refresh'];
const PROVIDER_STATUS = ['fresh', 'partial', 'stale', 'source-unavailable', 'not-token-priced', 'unmapped'];
const USAGE_BUCKETS = ['peak', 'offPeak', 'unknown'];
const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'calls'];

function transcripts() {
  return ensureFixtureManifest().transcripts;
}

function turnSessions() {
  const fixture = transcripts();
  const list = [
    { label: 'single', sessionId: fixture.sessionId, projectHash: fixture.projectHash },
    { label: 'fragmented', sessionId: fixture.fragmented.sessionId, projectHash: fixture.fragmented.projectHash },
  ];
  if (fixture.ttl) list.push({ label: 'ttl', sessionId: fixture.ttl.sessionId, projectHash: fixture.projectHash });
  if (fixture.bigInput) list.push({ label: 'bigInput', sessionId: fixture.bigInput.sessionId, projectHash: fixture.projectHash });
  return list;
}

// ---------------------------------------------------------------------------
// GET /api/pricing
// ---------------------------------------------------------------------------

test('PA-401 GET /api/pricing：200 且顶层仍是契约固定的 7 个键', async ({ request }) => {
  const { baseURL } = getRuntime();
  const result = await getPricing(request, baseURL);
  expect(result.status).toBe(200);
  expect(Object.keys(result.body).sort()).toEqual([...TOP_LEVEL_KEYS].sort());
});

test('PA-402 GET /api/pricing：默认不含 community 键（不是 null、不是空对象）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const result = await getPricing(request, baseURL);
  expect(Object.prototype.hasOwnProperty.call(result.body, 'community'),
    'community 是可选扩展，未启用时该键必须不出现').toBe(false);
});

test('PA-403 GET /api/pricing：providers[] 每条的字段齐备，status 落在契约闭集内', async ({ request }) => {
  const { baseURL } = getRuntime();
  const result = await getPricing(request, baseURL);
  const providers = result.body.providers;
  expect(Array.isArray(providers)).toBe(true);
  expect(providers.length, '预设状态表').toBeGreaterThan(0);
  for (const row of providers) {
    expect(typeof row.presetId, 'presetId').toBe('string');
    expect(PROVIDER_STATUS, `未知 status：${row.status}`).toContain(row.status);
    expect(typeof row.market === 'string' && row.market.length > 0, 'market').toBe(true);
    expect(['payg', 'subscription', 'points', 'contract']).toContain(row.billingMode);
    expect(row.errorCode === null || typeof row.errorCode === 'string', 'errorCode').toBe(true);
  }
});

test('PA-404 GET /api/pricing?refreshId=未知 → 404 PRICING_REFRESH_NOT_FOUND', async ({ request }) => {
  const { baseURL } = getRuntime();
  const result = await getPricing(request, baseURL, { refreshId: 'pa-no-such-refresh' });
  expectJsonError(result, { status: 404, code: 'PRICING_REFRESH_NOT_FOUND' });
});

// ---------------------------------------------------------------------------
// POST /api/pricing/refresh（错误契约与幂等，契约 §3.2）
// ---------------------------------------------------------------------------

async function pricingFingerprint(request, baseURL) {
  const result = await getPricing(request, baseURL);
  return `${result.body.fetchedAt}|${Object.keys(result.body.prices || {}).length}`;
}

test('PA-405 POST /api/pricing/refresh：空数组 → 400 PRICING_INVALID_PROVIDER 且零抓取', async ({ request }) => {
  const { baseURL } = getRuntime();
  const before = await pricingFingerprint(request, baseURL);
  const result = await postRefresh(request, baseURL, { presetIds: [] });
  expectJsonError(result, { status: 400, code: 'PRICING_INVALID_PROVIDER' });
  expect(await pricingFingerprint(request, baseURL), '非法请求不得触发任何抓取').toBe(before);
});

test('PA-406 POST /api/pricing/refresh：presetIds 非数组 → 400 PRICING_INVALID_PROVIDER 且零抓取', async ({ request }) => {
  const { baseURL } = getRuntime();
  const before = await pricingFingerprint(request, baseURL);
  const result = await postRefresh(request, baseURL, { presetIds: 'deepseek-official' });
  expectJsonError(result, { status: 400, code: 'PRICING_INVALID_PROVIDER' });
  expect(await pricingFingerprint(request, baseURL)).toBe(before);
});

test('PA-407 POST /api/pricing/refresh：未知 preset id → 400 PRICING_INVALID_PROVIDER 且零抓取', async ({ request }) => {
  const { baseURL } = getRuntime();
  const before = await pricingFingerprint(request, baseURL);
  const result = await postRefresh(request, baseURL, { presetIds: ['pa-not-a-preset'] });
  expectJsonError(result, { status: 400, code: 'PRICING_INVALID_PROVIDER' });
  expect(await pricingFingerprint(request, baseURL)).toBe(before);
});

test('PA-408 POST /api/pricing/refresh：合法 id 混入非法项 → 400 PRICING_INVALID_PROVIDER 且零抓取', async ({ request }) => {
  const { baseURL } = getRuntime();
  const before = await pricingFingerprint(request, baseURL);
  const result = await postRefresh(request, baseURL, { presetIds: ['deepseek-official', 'pa-not-a-preset'] });
  expectJsonError(result, { status: 400, code: 'PRICING_INVALID_PROVIDER' });
  expect(await pricingFingerprint(request, baseURL), '混入非法项必须整批拒绝').toBe(before);
});

test('PA-409 POST /api/pricing/refresh：同批重复请求 → 两次 202 且 refreshId 相同（幂等）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const first = await postRefresh(request, baseURL, { presetIds: ['deepseek-official'] });
  const second = await postRefresh(request, baseURL, { presetIds: ['deepseek-official'] });
  expect(first.status, `第一次刷新应被受理：${JSON.stringify(first.body).slice(0, 160)}`).toBe(202);
  expect(second.status).toBe(202);
  expect(typeof first.body.refreshId === 'string' && first.body.refreshId.length > 0).toBe(true);
  expect(second.body.refreshId, '同一批进行中的刷新必须复用同一个 refreshId').toBe(first.body.refreshId);
});

test('PA-410 POST /api/pricing/refresh：请求体里的 url/header/key 一律被忽略（不得成为来源）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const accepted = await postRefresh(request, baseURL, {
    presetIds: ['deepseek-official'],
    url: 'https://evil.invalid/pricing.json',
    headers: { authorization: 'Bearer pa-should-be-ignored' },
    apiKey: 'pa-should-be-ignored',
  });
  expect(accepted.status, '多给的字段既不该报错也不该改变来源').toBe(202);
  const rejected = await postRefresh(request, baseURL, {
    presetIds: ['pa-not-a-preset'], url: 'https://evil.invalid/pricing.json',
  });
  expectJsonError(rejected, { status: 400, code: 'PRICING_INVALID_PROVIDER' });
  const pricing = await getPricing(request, baseURL);
  expect(JSON.stringify(pricing.body), '响应里不得出现请求体给的地址').not.toContain('evil.invalid');
});

// ---------------------------------------------------------------------------
// GET /api/usage：byPeriod（契约 §3.3）
// ---------------------------------------------------------------------------

test('PA-411 GET /api/usage：每行 byPeriod 三桶之和 === 该行四字段 + calls（逐字段）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { status, body } = await getUsage(request, baseURL);
  expect(status).toBe(200);
  const rows = body.byModel || [];
  expect(Array.isArray(rows)).toBe(true);
  for (const row of rows) {
    expect(row.byPeriod, `${row.model} 缺 byPeriod`).toBeTruthy();
    for (const field of USAGE_FIELDS) {
      const sum = USAGE_BUCKETS.reduce((acc, bucket) => acc + (row.byPeriod[bucket]?.[field] ?? 0), 0);
      expect(sum, `${row.model} 的 ${field} 恒等式不成立`).toBeCloseTo(row[field] ?? 0, 6);
    }
  }
});

test('PA-412 GET /api/usage：byPeriod 对每一行都产出三个桶（不按模型名白名单）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { body } = await getUsage(request, baseURL);
  for (const row of body.byModel || []) {
    expect(Object.keys(row.byPeriod || {}).sort(), `${row.model} 的桶名`).toEqual([...USAGE_BUCKETS].sort());
    for (const bucket of USAGE_BUCKETS) {
      for (const field of USAGE_FIELDS) {
        expect(typeof row.byPeriod[bucket][field], `${row.model}.${bucket}.${field}`).toBe('number');
      }
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/messages：usageCalls（契约 §3.4、§10.1）与错误契约
// ---------------------------------------------------------------------------

test('PA-413 messages：顶层键仍恰为 4 个（回归安全线，本次只追加字段）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const fixture = transcripts();
  const result = await readMessages(request, baseURL, fixture.sessionId, fixture.projectHash);
  expect(result.status).toBe(200);
  expect(Object.keys(result.body).sort()).toEqual(['messages', 'owner', 'usageTotals', 'view']);
});

/** 有真实用量的回合：契约 §3.4 要求这类 turn 带 usageCalls（无 usage 的回合允许没有）。 */
function turnsWithUsage(body) {
  const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  return (body.messages || [])
    .filter(message => message.type === 'turn')
    .map(turn => ({ turn, hasUsage: fields.some(field => Number(turn.usage?.[field]) !== 0) }));
}

test('PA-414 messages：每个 turn 的 usageCalls 各条四字段之和 === 该 turn 的 usage（逐字段）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  for (const item of turnSessions()) {
    const result = await readMessages(request, baseURL, item.sessionId, item.projectHash);
    expect(result.status, `夹具会话 ${item.label} 必须可读`).toBe(200);
    for (const { turn, hasUsage } of turnsWithUsage(result.body)) {
      if (hasUsage) {
        expect(Array.isArray(turn.usageCalls),
          `${item.label}/${turn.uuid} 有用量却没有 usageCalls（契约 §3.4 要求逐条列出 API 调用）`).toBe(true);
      }
      for (const field of fields) {
        const sum = (turn.usageCalls || []).reduce((acc, call) => acc + (call?.usage?.[field] ?? 0), 0);
        expect(sum, `${item.label}/${turn.uuid} 的 ${field} 不变量不成立`).toBeCloseTo(turn.usage?.[field] ?? 0, 6);
      }
    }
  }
});

test('PA-415 messages：usageCalls 每项的 at 可被 Date.parse，且形状与契约一致', async ({ request }) => {
  const { baseURL } = getRuntime();
  let checked = 0;
  for (const item of turnSessions()) {
    const result = await readMessages(request, baseURL, item.sessionId, item.projectHash);
    for (const { turn, hasUsage } of turnsWithUsage(result.body)) {
      if (hasUsage && !Array.isArray(turn.usageCalls)) {
        throw new Error(`${item.label}/${turn.uuid} 有用量却没有 usageCalls —— 本用例要验的形状不存在`);
      }
      for (const call of turn.usageCalls || []) {
        checked += 1;
        expect(Number.isFinite(Date.parse(call.at)), `usageCalls[].at 不可解析：${call.at}`).toBe(true);
        expect(call.usage, 'usageCalls[].usage 必填').toBeTruthy();
      }
    }
  }
  expect(checked, '夹具里至少要有一个可观察的 usageCalls 项').toBeGreaterThan(0);
});

test('PA-416 messages：同一 message.id 分片多次出现 → usageCalls 只一项且取首次出现（不得取末条）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const fixture = transcripts();
  const frag = fixture.fragmented;
  const result = await readMessages(request, baseURL, frag.sessionId, frag.projectHash);
  expect(result.status, '派生夹具会话必须可读').toBe(200);
  const turn = (result.body.messages || []).find(message => message.type === 'turn');
  expect(turn, '派生会话必须至少有一个 turn').toBeTruthy();
  // 先验夹具本身成立（今天的行为就要求「首次出现为准」），再看 usageCalls ——
  // 这样失败时读起来是「缺 usageCalls」，而不是含糊的夹具问题。
  expect(turn.usage.input_tokens, '汇总 usage 取首次出现那条').toBe(frag.firstInput);
  expect(turn.usage.input_tokens, '不得取到后插入的分片值').not.toBe(frag.laterInput);
  expect(Array.isArray(turn.usageCalls), '分片会话的 turn 必须有 usageCalls').toBe(true);
  expect(turn.usageCalls.length, '同一 message.id 只算一次').toBe(1);
  expect(turn.usageCalls[0].usage.input_tokens, '取首次出现的 usage，不得取末条')
    .toBe(frag.firstInput);
  expect(turn.usageCalls[0].usage.input_tokens, '不得取到后插入的分片值').not.toBe(frag.laterInput);
  expect(Date.parse(turn.usageCalls[0].at), 'usageCalls[0].at 取首次出现那条记录的时间')
    .toBe(Date.parse(frag.firstAt));
});

test('PA-417 messages 错误契约：缺 projectHash → 400 HISTORY_INVALID_INPUT「projectHash query param required」', async ({ request }) => {
  const { baseURL } = getRuntime();
  const result = await readMessagesRaw(request, baseURL, transcripts().sessionId, undefined);
  expectJsonError(result, { status: 400, code: 'HISTORY_INVALID_INPUT' });
  expect(result.body.error).toBe('projectHash query param required');
});

test('PA-418 messages 错误契约：projectHash / sessionId 形状非法 → 400 HISTORY_INVALID_INPUT「invalid projectHash or sessionId」', async ({ request }) => {
  const { baseURL } = getRuntime();
  const result = await readMessagesRaw(request, baseURL, '../../etc/passwd', 'projectHash=../../etc/passwd');
  expectJsonError(result, { status: 400, code: 'HISTORY_INVALID_INPUT' });
  expect(result.body.error).toBe('invalid projectHash or sessionId');
});

test('PA-419 messages 错误契约：会话不存在 → 404 SESSION_NOT_FOUND「会话不存在」', async ({ request }) => {
  const { baseURL } = getRuntime();
  const result = await readMessages(request, baseURL, '00000000-0000-4000-8000-0000000000ff', '-tmp-pa-nonexistent');
  expectJsonError(result, { status: 404, code: 'SESSION_NOT_FOUND' });
  expect(result.body.error).toBe('会话不存在');
});

test('PA-420 messages 降级：没有 subagents 目录的会话 → subUsage 键不出现（不是 {agents:[]}）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const fixture = transcripts();
  const result = await readMessages(request, baseURL, fixture.sessionId, fixture.projectHash);
  expect(result.status).toBe(200);
  const withSubUsage = (result.body.messages || []).filter(message => 'subUsage' in message);
  for (const message of withSubUsage) {
    expect(Array.isArray(message.subUsage?.agents), 'subUsage 出现时 agents 必须是非空数组')
      .toBe(true);
    expect(message.subUsage.agents.length).toBeGreaterThan(0);
  }
  const raw = JSON.stringify(result.body);
  if (raw.includes('"unattributed"')) {
    throw new Error('契约 §10.1 v3：unattributed 桶已作废，不得再出现');
  }
});

test('PA-421 /api/pricing 的 refresh 形状：status 落在现行状态闭集内', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { body } = await getPricing(request, baseURL);
  const refresh = body.refresh;
  if (refresh === null || refresh === undefined) {
    throw new EnvironmentBlocked('该实例还没有刷新记录（refresh 为 null），无法观察 refresh 形状');
  }
  expect(['running', 'completed', 'partial', 'failed']).toContain(refresh.status);
});

test('PA-422 community 层未启用时：客户端不得因为缺这一层而报错（读 pricing 后仍可用内置表）', async ({ request }) => {
  const { baseURL } = getRuntime();
  const { body } = await getPricing(request, baseURL);
  expect(Object.prototype.hasOwnProperty.call(body, 'community')).toBe(false);
  const response = await request.get(`${baseURL}/api/pricing`, { failOnStatusCode: false });
  expect(response.status()).toBe(200);
});
