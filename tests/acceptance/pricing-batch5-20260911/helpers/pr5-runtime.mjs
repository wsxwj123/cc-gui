// PR-* suite helper layer (R20–R24, 官方价格/用量与展示).
// Black-box only: public HTTP routes and public UI hooks named in .devflow/INTERFACE.md.
// Self-contained on purpose — other suites in tests/acceptance are locked and are not imported.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

export const MODEL_FLAG = 'PRICING_ALLOW_MODEL';
export const STUB_FLAG = 'PRICING_ALLOW_STUB';
export const STUB_PORT = Number(process.env.PR5_STUB_PORT || 57881);

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  return `${prefix}_${suffix}`.slice(0, 64);
}

function rejectSecretFields(value, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (/(secret|password|cookie|authorization|api.?key|token)/i.test(key)) {
      throw new EnvironmentBlocked(`fixture manifest must not contain credential field ${at}`);
    }
    rejectSecretFields(child, at);
  }
}

/**
 * Environment guard: loopback only, user instances 6677/6689 refused, fixture data root must
 * live under some "tests/acceptance/.../.artifacts" directory (never a real user profile).
 */
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

  const manifestPath = path.resolve(process.env.PRICING5_FIXTURES || suitePath('fixture-manifest.local.json'));
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    rejectSecretFields(manifest);
    if (!manifest.dataRoot) throw new EnvironmentBlocked('fixture manifest must declare dataRoot');
    const dataRoot = path.resolve(manifest.dataRoot);
    const parts = dataRoot.split(path.sep);
    if (!parts.includes('tests') || !parts.includes('acceptance') || !parts.includes('.artifacts')) {
      throw new EnvironmentBlocked('fixture dataRoot must be inside tests/acceptance/*/.artifacts of this worktree');
    }
  } else if (requireManifest) {
    throw new EnvironmentBlocked(`create ${manifestPath} from fixture-manifest.example.json`);
  }
  return { baseURL: url.toString().replace(/\/$/, ''), manifest, manifestPath };
}

export function fixtureSection(name) {
  const { manifest } = getRuntime({ requireManifest: true });
  const section = manifest?.[name];
  if (!section) {
    throw new EnvironmentBlocked(`fixture manifest section ${name} is required (see README "Fixture preparation")`);
  }
  return section;
}

export function requireField(section, key) {
  const value = section?.[key];
  if (typeof value !== 'string' || !value) {
    throw new EnvironmentBlocked(`fixture field ${key} is required and must be a non-empty string`);
  }
  return value;
}

/** Cases that need a live CLI/model run stay out of the way until the operator says the account exists. */
export function requireModel() {
  if (process.env[MODEL_FLAG] !== '1') {
    throw new EnvironmentBlocked(
      `${MODEL_FLAG}=1 is required: this case needs a live model run against the isolated instance (see README)`,
    );
  }
}

/**
 * Cases that need the operator-prepared stub provider (usage fixtures).
 * `protocol` picks the manifest section: 'openai' → stubProvider（Chat Completions 口径，经产品自己的
 * Anthropic↔OpenAI 代理）, 'anthropic' → stubProviderClaude（Anthropic Messages 口径，直连 stub）。
 * 协议与场景的对应关系由用例逐条声明（见 usage-normalize.spec.mjs 的 SCENARIO_PROTOCOL）——
 * 缺哪一段就对该组用例报 ENVIRONMENT_BLOCKED，不换协议凑数。
 */
export function requireStubFixture(protocol = 'openai') {
  if (process.env[STUB_FLAG] !== '1') {
    throw new EnvironmentBlocked(
      `${STUB_FLAG}=1 is required: this case needs the operator-prepared stub provider (see README "Stub upstream fixture")`,
    );
  }
  const section = protocol === 'anthropic' ? 'stubProviderClaude' : 'stubProvider';
  return fixtureSection(section);
}

// ---------------------------------------------------------------------------
// HTTP probes: GET /api/pricing, POST /api/pricing/refresh
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

/** Polls GET /api/pricing?refreshId=… until the refresh reaches a terminal top-level state. */
export async function waitForRefresh(request, baseURL, refreshId, { timeoutMs = 30_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await getPricing(request, baseURL, { refreshId });
    const state = last.body?.refresh?.status ?? last.body?.refresh?.state;
    if (last.status === 200 && state && state !== 'running') return last;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return last;
}

export function readRefresh(result, refreshId) {
  const refresh = result?.body?.refresh;
  expect(refresh, `GET /api/pricing?refreshId=${refreshId} must report the refresh under a "refresh" object`).toBeTruthy();
  return refresh;
}

/**
 * INTERFACE fixes the refresh *semantics* (每家独立成败, terminal top-level state) but not the
 * per-provider field spelling. Walk the refresh object and collect every entry that carries a
 * presetId plus some terminal marker, so the case can assert per-provider outcomes without
 * inventing a field name.
 */
export function collectRefreshProviderEntries(refresh) {
  const found = new Map();
  const visit = (node, depth = 0) => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) { node.forEach(item => visit(item, depth + 1)); return; }
    if (typeof node !== 'object') return;
    const id = node.presetId || node.provider || node.id;
    if (typeof id === 'string' && (node.status || node.state || node.ok !== undefined || node.errorCode || node.error)) {
      found.set(id, node);
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(refresh);
  return found;
}

/** INTERFACE 公共规则: `{ok:false,code,error}` with a stable short code and no stack trace. */
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
    expect(result.body.code.length, `stable error code for ${label}`).toBeLessThanOrEqual(64);
  }
  expect(typeof result.body.error, `readable error text for ${label}`).toBe('string');
  expect(result.body.error.length, `short error text for ${label}`).toBeLessThanOrEqual(300);
  expect(result.body.error, 'no stack trace in error text').not.toMatch(/\n\s+at\s|Error:\s*\n/);
  for (const needle of mustNotContain) {
    expect(result.body.error, 'error text must not leak request content').not.toContain(needle);
  }
}

// ---------------------------------------------------------------------------
// Contract vocabulary (verbatim from .devflow/INTERFACE.md「官方价格、用量和展示」)
// ---------------------------------------------------------------------------

export const PROVIDER_STATUS = ['fresh', 'partial', 'stale', 'source-unavailable', 'not-token-priced', 'unmapped'];
export const QUOTE_STATUS = ['fresh', 'partial', 'stale', 'unresolved', 'not-applicable'];
export const SOURCE_KIND = ['official', 'community', 'manual', 'offline'];
export const REFRESH_STATE = ['running', 'completed', 'partial', 'failed'];
export const SOURCE_ERROR_CODES = [
  'SOURCE_TIMEOUT', 'SOURCE_UNAVAILABLE', 'SOURCE_INVALID_CONTENT', 'MODEL_UNRESOLVED', 'PRICE_DIMENSION_UNKNOWN',
];

export const PROVIDER_FIELDS = [
  'presetId', 'billingProvider', 'market', 'billingMode', 'sourceUrl', 'status',
  'attemptedAt', 'fetchedAt', 'errorCode', 'modelCount', 'unresolvedModels',
];

export const BILLING_MODES = ['payg', 'subscription', 'points', 'contract'];

/** The 43 preset ids of the contract's baseline coverage table (每行所有 id 都必须有 providers 状态). */
export const CONTRACT_PRESET_IDS = [
  'deepseek-official', 'deepseek-anthropic', 'anthropic-official', 'openai', 'gemini', 'moonshot',
  'xai-grok', 'zhipu-glm', 'minimax', 'minimax-anthropic', 'qwen-dashscope', 'qwen-dashscope-anthropic',
  'doubao-volc', 'ernie-qianfan', 'hunyuan', 'stepfun', 'stepfun-anthropic', 'mistral', 'perplexity',
  'zai-intl', 'siliconflow', 'groq', 'together', 'fireworks', 'fireworks-anthropic', 'cerebras',
  'hyperbolic', 'openrouter', 'openrouter-anthropic', '302ai', '302ai-anthropic', 'aihubmix',
  'aihubmix-anthropic', 'mimo-tokenplan', 'mimo-tokenplan-anthropic', 'kimi-code', 'kimi-code-anthropic',
  'glm-coding', 'glm-anthropic', 'zai-coding', 'zai-coding-anthropic', 'qwen-coding-anthropic', 'poe',
];

/** sourceUrl host allowlist per preset family — contract table「官方来源」column. */
export const OFFICIAL_HOSTS = {
  deepseek: ['api-docs.deepseek.com'],
  'anthropic-official': ['platform.claude.com', 'docs.anthropic.com', 'claude.com'],
  openai: ['developers.openai.com', 'platform.openai.com', 'openai.com'],
  gemini: ['ai.google.dev'],
  moonshot: ['platform.kimi.com', 'platform.moonshot.cn', 'moonshot.cn'],
  'xai-grok': ['docs.x.ai', 'x.ai'],
  'zhipu-glm': ['docs.bigmodel.cn', 'open.bigmodel.cn', 'bigmodel.cn'],
  minimax: ['platform.minimaxi.com', 'minimaxi.com'],
  'qwen-dashscope': ['help.aliyun.com', 'www.alibabacloud.com', 'bailian.console.aliyun.com'],
  'doubao-volc': ['docs.volcengine.com', 'www.volcengine.com'],
  'ernie-qianfan': ['cloud.baidu.com'],
  hunyuan: ['cloud.tencent.cn', 'cloud.tencent.com'],
  stepfun: ['platform.stepfun.com', 'stepfun.com'],
  mistral: ['mistral.ai'],
  perplexity: ['docs.perplexity.ai'],
  'zai-intl': ['docs.z.ai', 'z.ai'],
  siliconflow: ['siliconflow.cn', 'cloud.siliconflow.cn'],
  groq: ['console.groq.com', 'groq.com'],
  together: ['www.together.ai', 'together.ai'],
  fireworks: ['docs.fireworks.ai', 'fireworks.ai'],
  cerebras: ['api.cerebras.ai', 'inference-docs.cerebras.ai'],
  hyperbolic: ['docs.hyperbolic.xyz', 'hyperbolic.ai', 'www.hyperbolic.ai'],
  openrouter: ['openrouter.ai'],
  '302ai': ['api.302.ai', '302.ai', 'doc.302.ai'],
  aihubmix: ['aihubmix.com'],
  'mimo-tokenplan': ['mimo.mi.com'],
  'kimi-code': ['www.kimi.com', 'kimi.com'],
  'glm-coding': ['docs.bigmodel.cn', 'bigmodel.cn'],
  'zai-coding': ['docs.z.ai', 'z.ai'],
  'qwen-coding-anthropic': ['help.aliyun.com'],
  poe: ['creator.poe.com', 'poe.com'],
};

export function officialHostsFor(presetId) {
  const base = presetId.replace(/-(anthropic|official)$/, '');
  return OFFICIAL_HOSTS[presetId] || OFFICIAL_HOSTS[base] || null;
}

/** Currency the contract states for that source; null = the contract does not state one. */
export const CONTRACT_CURRENCY = {
  'deepseek-official': ['CNY'], 'deepseek-anthropic': ['CNY'],
  'anthropic-official': ['USD'], openai: ['USD'], moonshot: ['CNY'], 'zhipu-glm': ['CNY'],
  minimax: ['CNY'], 'minimax-anthropic': ['CNY'], 'zai-intl': ['USD'], siliconflow: ['CNY'],
  aihubmix: ['USD'], 'aihubmix-anthropic': ['USD'],
  mistral: ['USD', 'EUR'],
};

// ---------------------------------------------------------------------------
// Stub routing: verify the switch really took effect, and repair the one
// machine-specific hop that the isolated instance cannot reach.
// ---------------------------------------------------------------------------

/** What the CLI would actually talk to right now, via the public provider endpoint. */
export async function currentProviderRoute(request, baseURL) {
  const response = await request.get(`${baseURL}/api/provider`, { failOnStatusCode: false });
  const body = await jsonBody(response);
  return {
    status: response.status(),
    baseUrl: String(body?.baseUrl ?? ''),
    model: body?.model ?? null,
    protocol: body?.protocol ?? null,
  };
}

function loopbackHost(rawUrl) {
  try { return new URL(rawUrl).hostname; } catch { return null; }
}

/** TCP 连通性探测:只判端口在听,不发数据不读内容(与 GUI 自己的 pickProxyPort 同口径)。 */
function probeTcpPort(host, port, timeoutMs = 400) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/**
 * Fixture integrity: the named provider must exist with the declared type/baseURL/model, so a
 * case cannot silently run against a provider that does not match the protocol it claims to
 * exercise. Missing/mismatched → ENVIRONMENT_BLOCKED (points at README "Stub upstream fixture").
 */
export async function assertStubProviderConfigured(request, baseURL, fixture) {
  const name = requireField(fixture, 'displayName');
  const modelId = requireField(fixture, 'modelId');
  const type = requireField(fixture, 'protocol') === 'openai' ? 'openai' : 'anthropic';
  const baseURLDeclared = requireField(fixture, 'baseURL');
  const response = await request.get(`${baseURL}/api/custom-providers`, { failOnStatusCode: false });
  const list = await jsonBody(response);
  const rows = Array.isArray(list) ? list : (list?.providers ?? []);
  const hit = rows.find(row => row?.name === name);
  if (!hit) {
    throw new EnvironmentBlocked(
      `自定义 provider「${name}」不在隔离实例里；按 README「Stub upstream fixture」先建这一段（协议 ${type}，baseURL ${baseURLDeclared}）`,
    );
  }
  if (hit.type !== type) {
    throw new EnvironmentBlocked(`provider「${name}」的 type=${hit.type}，本场景需要 ${type} 协议段（见 README 场景↔协议映射）`);
  }
  if (hit.baseURL !== baseURLDeclared) {
    throw new EnvironmentBlocked(`provider「${name}」的 baseURL=${hit.baseURL}，夹具声明 ${baseURLDeclared}`);
  }
  if (!(hit.models ?? []).includes(modelId)) {
    throw new EnvironmentBlocked(`provider「${name}」的 models 里没有 ${modelId}`);
  }
  return hit;
}

/** Writes ANTHROPIC_BASE_URL through the public settings endpoint; returns the stored value. */
export async function setProviderBaseUrl(request, baseURL, value) {
  const response = await request.put(`${baseURL}/api/settings-env`, {
    data: { set: { ANTHROPIC_BASE_URL: value } },
    failOnStatusCode: false,
  });
  const body = await jsonBody(response);
  if (response.status() !== 200) {
    throw new EnvironmentBlocked(
      `PUT /api/settings-env 无法把 CLI 上行指回本套件夹具（HTTP ${response.status()}: ${JSON.stringify(body).slice(0, 160)}）`,
    );
  }
  return String(body?.env?.ANTHROPIC_BASE_URL ?? '');
}

/**
 * 夹具修复,不是产品判定:本机若装着常驻代理 daemon（`App.jsx`「原理(协议路由)」写明切换会改写成
 * daemon 的 8798/8799）,隔离实例的自定义 provider 在 daemon 里不存在 → CLI 打过去 503。公开版没有
 * 这个 daemon,所以这是本机部署件的产物,不是产品缺陷。修复只做一件事:经公开 settings 接口把 CLI
 * 要打的地址指回夹具声明的 cliBaseURL（anthropic 段 = stub 直连;openai 段 = 本实例进程内 openai 代理,
 * 协议翻译仍走产品自己的代理）。只允许回环→回环;一旦发现上行指向远端就报错,不掩盖真实改路。
 */
export async function ensureStubRoute(request, baseURL, fixture) {
  const expected = requireField(fixture, 'cliBaseURL');
  const expectedHost = loopbackHost(expected);
  if (!expectedHost) throw new EnvironmentBlocked(`夹具 cliBaseURL 必须是回环地址: ${expected}`);
  // 夹具自检:声明地址没人听(实例重启后进程内代理端口会变)时给明确结论,不让回合超时兜底。
  const expectedPort = Number(new URL(expected).port || 80);
  if (!(await probeTcpPort(expectedHost, expectedPort))) {
    throw new EnvironmentBlocked(
      `夹具声明的 CLI 上行 ${expected} 没有在监听 —— 实例重启后进程内代理端口会变，按 README 重新记录 cliBaseURL`,
    );
  }
  const current = await currentProviderRoute(request, baseURL);
  if (current.baseUrl === expected) return { repaired: false, baseUrl: current.baseUrl };

  const seenHost = loopbackHost(current.baseUrl);
  if (seenHost !== '127.0.0.1' && seenHost !== 'localhost' && seenHost !== '::1') {
    throw new EnvironmentBlocked(
      `切换后 CLI 上行是 ${current.baseUrl || '(空)'} —— 不是回环地址,拒绝改写(这是真实改路或 provider 配错,不是本机的 daemon 抢占用)`,
    );
  }
  const applied = await setProviderBaseUrl(request, baseURL, expected);
  if (applied !== expected) {
    throw new EnvironmentBlocked(`settings 接口写入后读回 ${applied || '(空)'},期望 ${expected}`);
  }
  return { repaired: true, previous: current.baseUrl, baseUrl: applied };
}

// ---------------------------------------------------------------------------
// Public-UI helpers
// ---------------------------------------------------------------------------

export async function ensureAppLoaded(page) {
  if (page.url() === 'about:blank') {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  }
}

export async function dismissOverlays(page) {
  for (const name of ['关闭指引', '跳过', '稍后']) {
    const button = page.getByRole('button', { name, exact: true });
    if ((await button.count()) && (await button.first().isVisible().catch(() => false))) {
      await button.first().click().catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

export async function clickThroughOverlays(page, target, { attempts = 4, timeout = 4_000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await dismissOverlays(page);
    try {
      await target.click({ timeout });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await page.waitForTimeout(300);
    }
  }
}

/** Expands the top-bar dock (设置) if the named panel button is not visible yet. */
export async function expandDock(page) {
  const settings = page.getByRole('button', { name: /^设置/ }).first();
  if (await settings.count()) await clickThroughOverlays(page, settings);
  await page.waitForTimeout(400);
}

/** Opens a dock panel by its published top-bar name (用量 / 文件 / 监控 / …). */
export async function openDockPanel(page, name) {
  await ensureAppLoaded(page);
  // 指引/更新提示是整屏浮层,会拦截所有点击 —— 先收掉再开面板。顺序不能反:面板开着时点浮层按钮
  // (clickThroughOverlays 每轮都会先 dismiss)会把刚开的面板一起收掉,面板按钮随即消失。
  await dismissOverlays(page);
  const button = page.getByRole('button', { name, exact: true }).first();
  if (!(await button.count())) await expandDock(page);
  await expect(button, `the top-bar ${name} panel button must exist`).toBeVisible();
  try {
    await button.click({ timeout: 6_000 });
  } catch {
    // 浮层也可能在面板打开之后才冒出来(更新检查是异步的):收一次再点,实测 dock 不会因此收起
    await dismissOverlays(page);
    await button.click({ timeout: 6_000 });
  }
}

/** 用量 panel; asserts its published heading so a silent no-op cannot pass as "panel opened". */
export async function openUsagePanel(page) {
  await openDockPanel(page, '用量');
  await expect(page.getByText(/用量统计/).first(), 'the 用量 panel heading').toBeVisible();
}

/** Opens a fixture session the way a user does: sidebar search → result row. */
export async function openFixtureSession(page, section, { markerKey = 'sessionSearchMarker' } = {}) {
  const marker = requireField(section, markerKey);
  await ensureAppLoaded(page);
  await dismissOverlays(page);
  const search = page.getByRole('textbox', { name: /搜索项目/ }).first();
  await clickThroughOverlays(page, search);
  await search.fill(marker);
  const row = page.getByRole('button', { name: new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
  await expect(row, `sidebar search must list the fixture session for ${marker}`).toBeVisible();
  await clickThroughOverlays(page, row);
  await page.keyboard.press('Escape').catch(() => {});
  await expect(page.getByRole('textbox', { name: /打开命令/ }).first(), 'the session composer').toBeVisible();
}

/** Sends one prompt in the currently open session through the public composer. */
export async function sendPrompt(page, text) {
  const composer = page.getByRole('textbox', { name: /打开命令/ }).first();
  await composer.click();
  await composer.fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).first().click();
}

/** Waits until the current turn leaves the running state (stop affordance gone). */
export async function waitForTurnEnd(page, { timeoutMs = 30_000 } = {}) {
  const stop = page.getByRole('button', { name: /停止/ });
  const deadline = Date.now() + timeoutMs;
  await page.waitForTimeout(1_500);
  while (Date.now() < deadline) {
    if ((await stop.count()) === 0) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}

/** Reads the session usage totals through the public messages endpoint. */
export async function readUsageTotals(request, baseURL, sessionId, projectHash) {
  const url = `${baseURL}/api/sessions/${encodeURIComponent(sessionId)}/messages?projectHash=${encodeURIComponent(projectHash)}`;
  const response = await request.get(url, { failOnStatusCode: false });
  const body = await jsonBody(response);
  return { status: response.status(), body, usageTotals: body?.usageTotals ?? null };
}

export function allText(page) {
  return page.evaluate(() => document.body.innerText);
}

/**
 * 页面上**当前渲染出来**的悬停提示(`title`)。R42 起价格来源词从行内移进金额的 `title`，
 * 这些词按原读法（只看可见文本）就取不到了 —— 探针的读法从「可见文本」扩成
 * 「可见文本 ∪ 悬停提示」。**只扩 haystack：断言的判据、字面量与数值一律不变。**
 * 只收渲染出来的元素：隐藏面板里的 `title` 用户看不到，不能当证据。
 */
export function allVisibleTitles(page) {
  return page.evaluate(() => [...document.querySelectorAll('[title]')]
    .filter(el => el.getClientRects().length > 0)
    .map(el => (el.getAttribute('title') || '').trim())
    .filter(Boolean)
    .join('\n'));
}

/** 可见文本 ∪ 悬停提示 —— 整页级别的口径名断言（PR-26）用这个读法。 */
export async function allTextAndTitles(page) {
  return `${await allText(page)}\n${await allVisibleTitles(page)}`;
}

/**
 * 「金额元素自己这一片」的悬停提示：金额叶节点自身 + 直接父 + 祖父三层里带 `title` 的文案
 * （R42 把来源词放在金额自己的 `title` 首行；P2 里金额外面还包了一层容器，故多走两层）。
 *
 * 刻意**不**取整页的 `title`：页面上别处的悬停文案里也有「官方」二字
 * （实测「远程」按钮的 title =「当前 provider 非官方 Anthropic，远程控制不可用。」），
 * 取整页会让 PR-28「金额不得无标注」在来源词被整个删掉之后**依然恒真** —— 那是假绿。
 */
export function moneyTips(page) {
  return page.evaluate(() => {
    const isMoney = text => /(?:¥|￥|\$)\s?\d/.test(text);
    const tips = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.querySelector('*') !== null) continue;            // 只看叶节点
      if (!el.getClientRects().length) continue;               // 只看渲染出来的
      if (!isMoney((el.textContent || '').trim())) continue;
      let cur = el;
      for (let depth = 0; cur && depth < 3; depth += 1, cur = cur.parentElement) {
        const tip = (cur.getAttribute?.('title') || '').trim();
        if (tip) tips.push(tip);
      }
    }
    return tips.join('\n');
  });
}

export function parsePercent(text) {
  const match = String(text).match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}
