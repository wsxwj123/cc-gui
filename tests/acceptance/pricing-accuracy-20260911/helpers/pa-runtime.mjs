// PA-* suite helper layer（计价准确性 + 子代理花费 + 套餐余量 + baseURL 撞预设）。
// 黑盒原则：只用契约公布的入口 —— HTTP 路由、契约点名的纯函数模块、以及契约点名的
// catalog 载入/设置接口（`pricingCatalog.js` 的 hydrate/set，见契约 §5.1 性能约束那一句）。
// 自包含：不 import 其他 acceptance 套件的 helpers。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';

export const MODEL_FLAG = 'PA_ALLOW_MODEL';
export const UI_FLAG = 'PA_ALLOW_UI';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** worktree 根：tests/acceptance/<suite>/ → 上三级。 */
export const WORKTREE = path.resolve(suiteDir, '..', '..', '..');

export class EnvironmentBlocked extends Error {
  constructor(message) {
    super(`ENVIRONMENT_BLOCKED: ${message}`);
    this.name = 'EnvironmentBlocked';
  }
}

export function suitePath(...parts) {
  return path.join(suiteDir, ...parts);
}

export function uniqueId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`.slice(0, 64);
}

function rejectSecretFields(value, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (/(secret|password|cookie|authorization|api.?key|resume.?token)/i.test(key)) {
      throw new EnvironmentBlocked(`fixture manifest must not contain credential field ${at}`);
    }
    rejectSecretFields(child, at);
  }
}

/** 环境守卫：只允许回环、拒绝 6677/6689 用户实例、夹具数据根必须在本套件 .artifacts 下。 */
export function getRuntime({ requireManifest = false } = {}) {
  const raw = process.env.BASE_URL;
  if (!raw) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new EnvironmentBlocked('BASE_URL must use http or https');
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new EnvironmentBlocked('BASE_URL must be loopback; remote and user instances are refused');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if ([6677, 6689].includes(port)) throw new EnvironmentBlocked('ports 6677 and 6689 are protected user instances');

  const manifestPath = path.resolve(process.env.PA_FIXTURES || suitePath('fixture-manifest.local.json'));
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    rejectSecretFields(manifest);
    const dataRoot = path.resolve(manifest.dataRoot || '');
    const allowed = suitePath('.artifacts');
    if (!manifest.dataRoot || (dataRoot !== allowed && !dataRoot.startsWith(`${allowed}${path.sep}`))) {
      throw new EnvironmentBlocked('fixture dataRoot must be inside pricing-accuracy-20260911/.artifacts');
    }
  } else if (requireManifest) {
    throw new EnvironmentBlocked(`create ${manifestPath} (see README "Fixture preparation")`);
  }
  return { baseURL: url.toString().replace(/\/$/, ''), manifest, manifestPath };
}

export function fixtureSection(name) {
  const { manifest } = getRuntime({ requireManifest: true });
  const section = manifest?.[name];
  if (!section) throw new EnvironmentBlocked(`fixture manifest section ${name} is required (see README)`);
  return section;
}

export function requireField(section, key) {
  const value = section?.[key];
  if (typeof value !== 'string' || !value) {
    throw new EnvironmentBlocked(`fixture field ${key} is required and must be a non-empty string`);
  }
  return value;
}

/** 需要真实模型回合的用例（本套件默认没有可用凭证）。 */
export function requireModel() {
  if (process.env[MODEL_FLAG] !== '1') {
    throw new EnvironmentBlocked(`${MODEL_FLAG}=1 is required: this case needs a live model run in the isolated instance`);
  }
}

/** 需要在真浏览器里操作自定义 provider 表单的用例。 */
export function requireUI() {
  if (process.env[UI_FLAG] !== '1') {
    throw new EnvironmentBlocked(`${UI_FLAG}=1 is required: this case drives the custom-provider form in a browser`);
  }
}

// ---------------------------------------------------------------------------
// 契约闭集（逐字抄自 INTERFACE-20260911-pricing.md §0.1 / §5.1 / §5.5 / §4.2）
// ---------------------------------------------------------------------------

export const COST_UNAVAILABLE_REASONS = [
  'PLAN_BILLING',
  'USAGE_EMPTY',
  'USAGE_INVALID',
  'NO_PRICE',
  'PERIOD_UNRESOLVED',
  'PERIOD_NOT_EFFECTIVE',
  'CONDITIONS_AMBIGUOUS',
  'THRESHOLD_UNKNOWN',
];

/** §0.1：resolvePrice 只能产出这 6 个值。 */
export const PRICE_REASONS = [
  'NO_PRICE',
  'PLAN_BILLING',
  'PERIOD_UNRESOLVED',
  'PERIOD_NOT_EFFECTIVE',
  'CONDITIONS_AMBIGUOUS',
  'THRESHOLD_UNKNOWN',
];

export const TIERS = ['manual', 'official-quote', 'official-compat', 'community', 'offline'];
export const CURRENCIES = ['CNY', 'USD', 'EUR', null];
export const QUOTE_UNIT = 'per 1M tokens';

/** §5.5 文案（逐字）。 */
export const SHOW = {
  noPrice: '未定价 · 费用未知',
  usageInvalid: '用量异常 · 费用未知',
  periodUnresolved: '时段未知 · 费用未知',
  periodNotEffective: '时段价未生效 · 费用未知',
  conditionsAmbiguous: '条件歧义 · 费用未知',
  thresholdUnknown: '阈值未知 · 费用未知',
  writeUnknownNoTtl: '写费未知（缺 TTL 分配）',
  writeUnknownNoPrice: '写费未知（该档无价）',
  partialPeriod: '部分调用时段未知 · 费用为已知小计',
  srcManual: '手填单价',
  srcOfficialCompat: '按官网价估算',
  srcOfficialQuote: '官方价·分时段',
  srcOfficialLong: '官方价·长上下文',
  srcCommunity: '社区表（估算）',
  srcOffline: '离线旧价（估算）',
  suffixApprox: '·疑似',
  suffixRetired: '·已下架',
  notPricedSmall: '未能计价',
};

/**
 * §10.11⑦ `costUnavailableReason(...).detail` 的逐字表（第二稿澄清新增，取代 §8 的「可读短句」）。
 * 与 SHOW 的「展示词」是两串，各自断言。
 */
export const DETAIL = {
  PLAN_BILLING: '当前是按套餐计费，不显示金额',
  USAGE_EMPTY: '这条记录没有用量数据',
  USAGE_INVALID: '用量字段无法解析',
  NO_PRICE: '没有该模型的可用价格',
  PERIOD_UNRESOLVED: '该模型按时段计价，但这条记录的时间未知或无法解析',
  PERIOD_NOT_EFFECTIVE: '该模型的时段价在本次调用时间尚未生效',
  CONDITIONS_AMBIGUOUS: '该模型有多条适用条件不同的报价，无法确定用哪一条',
  THRESHOLD_UNKNOWN: '该模型的上下文阈值未登记，无法判断走哪一档',
};

/** §10.4 文案表（`note` 逐字）。 */
export const QUOTA_NOTE = {
  class2: '该 provider 有额度接口，本期尚未接入，请去官网查看',
  class3: '该 provider 未登记额度接口，请去官网查看',
  class1Network: '额度接口请求失败（网络不可达或超时）',
  class1Auth: '额度接口拒绝了当前密钥（可能未开通该接口或权限不足）',
  class1Blocked: '该 provider 的地址指向内网，已拒绝查询额度（SSRF 防护）',
  oldSingle: '该 provider 不提供额度接口',
  codexNoBinary: '本机未找到 codex（ChatGPT 应用），无法读取 OpenAI 额度，请去官网查看',
  codexNotLoggedIn: '本机 codex 未登录 ChatGPT 账户，无法读取额度，请去官网查看',
  codexFailed: 'codex 额度查询失败（超时或返回异常），请稍后重试',
};
export const QUOTA_REASONS = ['no-endpoint', 'network', 'auth', 'blocked'];
export const CLASS2_HOSTS = ['anthropic.com', 'xiaomimimo', 'aliyuncs', 'dashscope', 'volces',
  'tencentcloud', 'hunyuan', 'baidubce', 'qianfan'];

// ---------------------------------------------------------------------------
// 契约点名的纯函数模块
// ---------------------------------------------------------------------------

/**
 * 载入契约点名的模块并校验它导出了契约要求的名字。
 * 模块/导出缺失 = 产品未实现（普通断言失败，不是环境问题），消息里点名缺什么。
 */
export async function requireContract(relPath, exportNames = []) {
  const abs = path.resolve(WORKTREE, relPath);
  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (error) {
    throw new Error(
      `契约模块不可用（${relPath}）：${error.message}。契约要求该文件提供：${exportNames.join(', ')}`,
    );
  }
  const missing = exportNames.filter(name => mod[name] === undefined);
  if (missing.length) {
    throw new Error(`契约模块 ${relPath} 缺少导出：${missing.join(', ')}`);
  }
  return mod;
}

export function pricingRules() {
  return requireContract('server/utils/pricing-rules.js', [
    'PERIOD_SCHEDULES', 'periodFor', 'LONG_CONTEXT_THRESHOLDS', 'normalizeOfficialName',
    'OFFICIAL_MODEL_ALIASES',
  ]);
}

export function clientPricing() {
  return requireContract('client/src/utils/pricing.js', [
    'resolvePrice', 'computeCost', 'computeCostForMessage', 'costUnavailableReason',
  ]);
}

/**
 * §10.11① 公布的「手填单价」写入入口：`client/src/utils/pricing.js` 的具名导出 `setUserPrices`。
 * 只给需要它的用例（PA-339 起）加载，避免把它加进 clientPricing() 的必需导出集合。
 */
export function clientPricingExtra() {
  return requireContract('client/src/utils/pricing.js', [
    'resolvePrice', 'computeCost', 'computeCostForMessage', 'costUnavailableReason', 'setUserPrices',
  ]);
}

export function catalogModule() {
  return requireContract('client/src/utils/pricingCatalog.js', ['setPricingCatalog', 'loadPricingCatalog']);
}

export function presetMatch() {
  return requireContract('server/utils/builtin-providers.js', ['matchPresetByBaseURL', 'BUILTIN_PROVIDERS']);
}

// ---------------------------------------------------------------------------
// catalog 夹具（契约 §3.1 的 GET /api/pricing 形状）
// ---------------------------------------------------------------------------

export function pricingPayload({ quotes = [], prices = {}, providers = [], source = 'official-sources' } = {}) {
  return {
    source,
    fetchedAt: '2026-09-11T08:15:56.307Z',
    prices,
    schemaVersion: 2,
    providers,
    quotes,
    refresh: null,
  };
}

/** 一条 quote，字段默认取契约 §3.1 的形状；prices 用 §5.1 的五维命名。 */
export function quote(overrides = {}) {
  return {
    quoteId: 'q-default',
    provider: 'pa-synthetic',
    presetIds: ['pa-synthetic'],
    modelId: null,
    displayName: 'PA Synthetic',
    protocol: null,
    market: 'global',
    currency: 'USD',
    unit: QUOTE_UNIT,
    prices: { input: 1, output: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
    conditions: null,
    validFrom: null,
    validTo: null,
    sourceUrl: 'https://example.test/pricing',
    sourceKind: 'official',
    fetchedAt: '2026-09-11T08:15:56.307Z',
    parserVersion: 'pa-test',
    status: 'fresh',
    ...overrides,
  };
}

/** 装入一份合成 catalog（每个用到 catalog 的用例自己装，避免用例间串扰）。 */
export async function useCatalog(payload) {
  const { setPricingCatalog } = await catalogModule();
  setPricingCatalog(payload);
  return payload;
}

export async function useEmptyCatalog() {
  return useCatalog(pricingPayload());
}

/**
 * 装入被测实例自己的 catalog（客户端在真实运行时做的事：读 /api/pricing）。
 * 客户端把相对 URL 交给 fetch，Node 里必须补上 base，所以这里临时改写 globalThis.fetch。
 */
export async function useLiveCatalog(baseURL) {
  const { loadPricingCatalog } = await catalogModule();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (input, init) => {
    seen.push(String(input));
    return original(new URL(String(input), baseURL), init);
  };
  try {
    await loadPricingCatalog();
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

/** 在 fetch 被禁用的环境里跑一段代码，返回它实际发生的网络请求（探「纯函数不得发网络」）。 */
export async function withFetchDisabled(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...args) => {
    calls.push(String(args[0]));
    return Promise.reject(new Error('network disabled by test'));
  };
  try {
    const value = await fn();
    return { value, calls };
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// HTTP 探针
// ---------------------------------------------------------------------------

export async function jsonBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { __nonJsonBody__: text.slice(0, 200) }; }
}

export async function getPricing(request, baseURL, params = {}) {
  const url = new URL('/api/pricing', baseURL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await request.get(url.toString(), { failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

export async function postRefresh(request, baseURL, payload) {
  const response = await request.post(`${baseURL}/api/pricing/refresh`, {
    data: payload,
    failOnStatusCode: false,
  });
  return { status: response.status(), body: await jsonBody(response) };
}

export async function getUsage(request, baseURL) {
  const response = await request.get(`${baseURL}/api/usage`, { failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

export async function readMessages(request, baseURL, sessionId, projectHash) {
  const url = `${baseURL}/api/sessions/${encodeURIComponent(sessionId)}/messages?projectHash=${encodeURIComponent(projectHash)}`;
  const response = await request.get(url, { failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

/** 原样打 messages 路由（用于非法 projectHash / 缺参的契约用例）。 */
export async function readMessagesRaw(request, baseURL, sessionId, query) {
  const suffix = query === undefined ? '' : `?${query}`;
  const response = await request.get(`${baseURL}/api/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`, {
    failOnStatusCode: false,
  });
  return { status: response.status(), body: await jsonBody(response) };
}

export async function getProviderQuota(request, baseURL) {
  const response = await request.get(`${baseURL}/api/provider-quota`, { failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

export async function createCustomProvider(request, baseURL, payload) {
  const response = await request.post(`${baseURL}/api/custom-providers`, { data: payload, failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

export async function listCustomProviders(request, baseURL) {
  const response = await request.get(`${baseURL}/api/custom-providers`, { failOnStatusCode: false });
  const body = await jsonBody(response);
  return Array.isArray(body) ? body : (body?.providers ?? []);
}

export async function switchProvider(request, baseURL, id) {
  const response = await request.post(`${baseURL}/api/provider/switch`, { data: { id }, failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

// ---------------------------------------------------------------------------
// 实例身份预检
// ---------------------------------------------------------------------------

/**
 * 确认 `BASE_URL` 指的是**本套件自己的隔离实例**（跑套件前的一次性预检，别等到用例报一堆红才发现）。
 *
 * 判据只用本套件自己的产物、不碰契约字段：派生的分片夹具会话只写在本套件数据根里，
 * 实例读不到它 = 它的数据根不是本套件数据根。实测（2026-09-12）指错实例时 20 条红里 14 条
 * 长得像产品缺陷（缺 `byPeriod`/`usageCalls`、D 项文案是旧的），实为对着别轮遗留的旧实例跑。
 */
export async function assertSuiteInstance(baseURL) {
  const transcripts = fixtureSection('transcripts');
  const frag = transcripts?.fragmented;
  if (!frag?.sessionId) {
    throw new EnvironmentBlocked('fixture-manifest.local.json 里没有派生的分片会话（见 README「Fixture preparation」）');
  }
  const derivedFile = path.join('home', '.claude', 'projects', frag.projectHash, `${frag.sessionId}.jsonl`);
  const dataRoot = getRuntime({ requireManifest: true }).manifest?.dataRoot;
  if (dataRoot && !fs.existsSync(path.join(dataRoot, derivedFile))) {
    // 数据根在、派生夹具没生成（被清理过）：就地补一次，别把它误报成"指错实例"。
    const { ensureFixtureManifest } = await import('./pa-fixtures.mjs');
    ensureFixtureManifest({ force: true });
  }

  const health = await fetch(`${baseURL}/api/health`).then(response => response.json()).catch(() => null);
  const url = `${baseURL}/api/sessions/${encodeURIComponent(frag.sessionId)}/messages`
    + `?projectHash=${encodeURIComponent(frag.projectHash)}`;
  const status = await fetch(url).then(response => response.status).catch(() => 0);
  if (status !== 200) {
    throw new EnvironmentBlocked(
      `BASE_URL 指的实例不是本套件的隔离实例：它读不到本套件数据根里的派生夹具会话`
      + `（HTTP ${status}，会话 ${frag.sessionId}）。\n`
      + `  实例 ${baseURL}：version=${health?.version ?? '?'} serverEpoch=${health?.serverEpoch ?? '?'}\n`
      + `  本套件数据根：${dataRoot}\n`
      + `  多半是复用了别套件/别轮次留下的实例（HOME 或数据根不是本套件 .artifacts/runtime-data），`
      + `或实例进程比当前源码旧。按 README「How to run」重起一个（一条命令：./run-isolated.sh）。\n`
      + `  另一种可能（少见）：会话存在而 messages 路由返回非 200 —— 那 PA-413/PA-416 也会红，属产品问题`,
    );
  }
  return { baseURL, version: health?.version ?? null, serverEpoch: health?.serverEpoch ?? null };
}

/** 契约公共信封：{ok:false,code,error}。 */
export function expectJsonError(result, { status, code = null, mustNotContain = [] }) {
  const label = code || `HTTP ${status}`;
  expect(result.status, `HTTP status for ${label}`).toBe(status);
  expect(result.body, `JSON body for ${label}`).toBeTruthy();
  expect(result.body.ok, `ok:false envelope for ${label}`).toBe(false);
  if (code) {
    expect(result.body.code, `stable error code ${code}`).toBe(code);
  } else {
    expect(typeof result.body.code, `stable error code for ${label}`).toBe('string');
    expect(result.body.code.length, `stable error code for ${label}`).toBeGreaterThan(0);
  }
  expect(typeof result.body.error, `readable error text for ${label}`).toBe('string');
  expect(result.body.error.length, `short error text for ${label}`).toBeLessThanOrEqual(300);
  expect(result.body.error, 'no stack trace in error text').not.toMatch(/\n\s+at\s|Error:\s*\n/);
  for (const needle of mustNotContain) {
    expect(result.body.error, 'error text must not leak request content').not.toContain(needle);
  }
}

// ---------------------------------------------------------------------------
// 数值工具
// ---------------------------------------------------------------------------

export const PER_MILLION = 1e6;

export function usd(tokens, pricePerMillion) {
  return (tokens * pricePerMillion) / PER_MILLION;
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 用例里各种 usage 的骨架（Anthropic 口径）。 */
export function usage({
  input = 0, output = 0, cacheRead = 0, cacheWrite = 0, fiveMin = null, oneHour = null,
} = {}) {
  const u = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
  if (fiveMin !== null || oneHour !== null) {
    u.cache_creation = {
      ephemeral_5m_input_tokens: fiveMin ?? 0,
      ephemeral_1h_input_tokens: oneHour ?? 0,
    };
  }
  return u;
}

export function roughProvider(overrides = {}) {
  return { providerHint: 'anthropic', model: null, hasAuthKey: true, ...overrides };
}
