// r122 请求拦截用的返回体(INTERFACE B7 / C1 / C5 允许的测试手段)。形状照 INTERFACE 点名的字段
// + 隔离实例上真实接口的公开返回形状(探路实测,只抄形状,数字是自造的)。
export const PROVIDER_LABEL = 'R122 甲方 Provider';

/** GET /api/pricing/current:判得出身份。 */
export const currentResolved = (label = PROVIDER_LABEL) => ({ ok: true, presetIds: ['r122-alpha'], label, resolved: true, reason: null });
/** GET /api/pricing/current:判不出身份(INTERFACE B5)。 */
export const currentUnresolved = (reason = 'R122 判不出当前 provider 的价目身份(自定义端点未映射到任何预设)') => ({ ok: true, presetIds: [], label: null, resolved: false, reason });

const providerRow = (presetId, status, extra = {}) => ({
  presetId, billingProvider: presetId, market: 'global', billingMode: status === 'not-token-priced' ? 'subscription' : 'payg',
  sourceUrl: `https://example.invalid/${presetId}/pricing`, status,
  attemptedAt: '2026-09-20T02:00:00.000Z', fetchedAt: status === 'unmapped' ? null : '2026-09-20T02:00:00.000Z',
  errorCode: null, modelCount: status === 'unmapped' ? 0 : 2, unresolvedModels: [], ...extra,
});
const quote = (id, provider, currency, input, output) => ({
  quoteId: id, provider, presetIds: [provider], modelId: null, displayName: `${provider}-model`, protocol: null, market: 'global',
  currency, unit: 'per 1M tokens', prices: { input, output, cacheRead: input / 10, cacheWrite5m: null, cacheWrite1h: null },
  conditions: null, validFrom: null, validTo: null, sourceUrl: `https://example.invalid/${provider}/pricing`, sourceKind: 'official',
  fetchedAt: '2026-09-20T02:00:00.000Z', parserVersion: 'r122', status: 'fresh',
});

/** 五家预设:2 已更新 + 1 部分取得 + 1 套餐计价 + 1 未映射;报价 CNY 2 条 + USD 1 条。 */
export const PRICING_PROVIDER_COUNT = 5;
export const PRICING_STATUS_COUNTS = { 已更新: 2, 部分取得: 1, 套餐计价: 1, 未映射: 1 };
export const PRICING_QUOTE_COUNTS = { CNY: 2, USD: 1 };
export const PRICING_FETCHED_AT = '2026-09-20T02:00:00.000Z';

/** GET /api/pricing(价目目录)。refreshEntries = 本次刷新条目数(0 = 没有「本次刷新逐家结果」块)。 */
export function pricingPayload({ refreshEntries = 3, refreshStatus = 'completed', refreshId = 'r122-refresh-0' } = {}) {
  const providers = [
    providerRow('r122-alpha', 'fresh'), providerRow('r122-beta', 'fresh'), providerRow('r122-gamma', 'partial'),
    providerRow('r122-plan', 'not-token-priced'), providerRow('r122-unmapped', 'unmapped'),
  ];
  const quotes = [quote('r122q1', 'r122-alpha', 'CNY', 1, 4), quote('r122q2', 'r122-beta', 'CNY', 2, 8), quote('r122q3', 'r122-gamma', 'USD', 3, 15)];
  const entries = [
    { presetId: 'r122-alpha', status: 'fresh', errorCode: null, attemptedAt: PRICING_FETCHED_AT, fetchedAt: PRICING_FETCHED_AT },
    { presetId: 'r122-gamma', status: 'partial', errorCode: 'FETCH_TIMEOUT', attemptedAt: PRICING_FETCHED_AT, fetchedAt: PRICING_FETCHED_AT },
    { presetId: 'r122-beta', status: 'fresh', errorCode: null, attemptedAt: PRICING_FETCHED_AT, fetchedAt: PRICING_FETCHED_AT },
  ].slice(0, refreshEntries);
  return {
    source: 'official-sources', fetchedAt: PRICING_FETCHED_AT, schemaVersion: 2, prices: {}, providers, quotes,
    refresh: refreshEntries > 0
      ? { refreshId, status: refreshStatus, startedAt: PRICING_FETCHED_AT, finishedAt: refreshStatus === 'running' ? null : PRICING_FETCHED_AT, providers: entries }
      : null,
  };
}

/** GET /api/provider 的成功形状(身份 = 官方 Anthropic 走订阅登录:providerHint anthropic + 无 API key)。 */
export const providerOfficialSubscription = () => ({ baseUrl: '', providerHint: 'anthropic', model: null, protocol: 'anthropic', hasAuthKey: false });
/** 身份 = 官方 Anthropic 但用 API key(按量计费)。 */
export const providerOfficialApiKey = () => ({ baseUrl: '', providerHint: 'anthropic', model: null, protocol: 'anthropic', hasAuthKey: true });

/** GET /api/subscription-usage 的返回体。 */
export function subscriptionPayload({ status, code, official = true, segments = false, error } = {}) {
  const body = { official, status, source: 'official-cli', fetchedAt: '2026-09-21T02:00:00.000Z', accountScope: 'r122', session: null, weekAll: null, weekScoped: null };
  if (segments) {
    body.session = { percent: 12, resetText: '3 小时后重置' };
    body.weekAll = { percent: 34, resetText: '周一重置' };
    body.weekScoped = { percent: 56, resetText: '周一重置', label: 'Opus' };
  }
  if (code) body.code = code;
  if (error) body.error = error;
  return body;
}
/** INTERFACE C1:命令行工具未登录。error 只按 C1 的最低要求"含未登录",刻意**不**带 claude auth login(那句由界面自己保证,见 C3)。 */
export const subscriptionNotLoggedIn = () => subscriptionPayload({ status: 'not-logged-in', code: 'NOT_LOGGED_IN', official: false, error: '命令行工具未登录(R122STUB)' });
export const subscriptionNotSubscribed = () => subscriptionPayload({ status: 'not-subscribed', code: 'NOT_SUBSCRIBED', official: true, error: '该账户没有订阅额度(R122STUB)' });
