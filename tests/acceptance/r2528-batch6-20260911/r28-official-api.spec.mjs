// R28 —— CLI 外订阅凭证辅助请求（HTTP 合同面）
//
// 合同来源：.devflow/INTERFACE.md「官方辅助能力、历史与外部项目（R25–R28）」前两条
// （GET /api/subscription-usage、POST /api/provider/fetch-models）与补充边界矩阵
// history/official-query 行 +「公共规则、身份与错误」。
//
// 观测手段：公开 HTTP + /api/model、/api/providers、/api/projects、公开 messages 读回。
// 真实订阅额度、账户切换、15 秒超时、出站请求录制都需要本机不具备的前提，见 README。
import { test, expect } from '@playwright/test';
import * as rt from './helpers/r2528-runtime.mjs';
import { startModelsStub, stubBusyHint } from './helpers/models-stub.mjs';

// 〈2026-09-21 r122〉INTERFACE-r122 C1 新增一种状态：命令行工具未登录 → status 'not-logged-in' / code 'NOT_LOGGED_IN'。
// 枚举照契约补上这一项（这台机器的 CLI 正是未登录，不补则 R28-03/06 会把契约内的新状态判成越界）；其余判据不变。
const STATUS_ENUM = ['available', 'stale', 'unavailable', 'not-subscribed', 'not-logged-in'];
const SOURCE_ENUM = ['official-cli', 'official-sdk-experimental'];
const CODE_ENUM = [
  'CLI_UNAVAILABLE', 'CLI_CAPABILITY_UNAVAILABLE', 'CLI_RESPONSE_INVALID',
  'CLI_RATE_LIMITED', 'NOT_SUBSCRIBED', 'CLI_TIMEOUT', 'NOT_LOGGED_IN',
];

function subscriptionUsage(baseURL, { probe = false } = {}) {
  const query = probe ? '?probe=1' : '';
  return `GET ${baseURL}/api/subscription-usage${query}`;
}

async function getUsage(request, baseURL, options = {}) {
  const result = await rt.getJson(request, baseURL, `/api/subscription-usage${options.probe ? '?probe=1' : ''}`);
  expect(result.status, `${subscriptionUsage(baseURL, options)} 必须 HTTP 200（已证明空消息控制可返回不可用）`)
    .toBe(200);
  expect(result.body, '额度响应必须是 JSON').toBeTruthy();
  return result;
}

function expectQuotaShape(body, label) {
  expect(typeof body.official, `${label}: official 必须是布尔`).toBe('boolean');
  expect(STATUS_ENUM, `${label}: status 必须取自枚举（got ${body.status}）`).toContain(body.status);
  expect(SOURCE_ENUM, `${label}: source 必须取自枚举（got ${body.source}）`).toContain(body.source);
  expect(Number.isNaN(Date.parse(body.fetchedAt)), `${label}: fetchedAt 必须是可解析时间（got ${body.fetchedAt}）`).toBe(false);
  expect(body.accountScope !== undefined && body.accountScope !== null, `${label}: accountScope 必须存在`).toBe(true);
  for (const key of ['session', 'weekAll', 'weekScoped']) {
    expect(key in body, `${label}: ${key} 必须存在（可以为 null）`).toBe(true);
  }
}

function quotaFields(body) {
  return ['session', 'weekAll', 'weekScoped'].map(key => [key, body[key]]);
}

test.describe('R28 官方辅助能力（HTTP）', () => {
  test('R28-01 非官方当前 provider 且不 probe → official=false，不拿第三方额度冒官方', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const officialId = await officialProviderId(request, baseURL);
    const scope = await rt.currentScope(request, baseURL);
    if (scope.currentProviderId === officialId) {
      throw new rt.EnvironmentBlocked(
        '该用例只覆盖"非官方当前 provider"分支；当前实例就是官方 provider，请先把实例切到任一自建 provider（见 README 环境守卫）',
      );
    }

    const result = await getUsage(request, baseURL, { probe: false });

    expect(result.body.official, '非官方当前 provider + 不 probe 时 official 必须为 false').toBe(false);
    // official=false 时那三个额度段属于"官方订阅"，不得填入第三方数额（字段缺失或 null 都算没冒充；
    // 字段必须存在这一条由 R28-02 单独断言）。
    for (const [key, value] of quotaFields(result.body)) {
      expect(value ?? null, `R28-01 official=false 时 ${key} 不得填第三方额度（got ${JSON.stringify(value)}）`).toBe(null);
    }
  });

  test('R28-02 不 probe 的 200 响应包含契约字段（status/source/fetchedAt/accountScope/三个额度段）', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const result = await getUsage(request, baseURL, { probe: false });

    expectQuotaShape(result.body, 'R28-02 不 probe');
    expect('modelScoped' in result.body === false || Array.isArray(result.body.modelScoped),
      'R28-02 modelScoped 出现时必须是数组').toBe(true);
  });

  test('R28-03 probe=1 → 200 字段齐全且 status/source 取自枚举', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const result = await getUsage(request, baseURL, { probe: true });

    expectQuotaShape(result.body, 'R28-03 probe');
  });

  test('R28-04 额度缺失必须是 null，不得显示 0', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const result = await getUsage(request, baseURL, { probe: true });

    if (result.body.status !== 'available' && result.body.status !== 'stale') {
      for (const [key, value] of quotaFields(result.body)) {
        expect(value, `R28-04 ${key}: 无该段额度时必须为 null，不得是 0 或 0% 占位（got ${JSON.stringify(value)}）`).toBe(null);
      }
    } else {
      for (const [key, value] of quotaFields(result.body)) {
        if (value === null) continue;
        expect(typeof value.percent, `R28-04 ${key}.percent 必须是数字`).toBe('number');
        expect(value.percent, `R28-04 ${key}.percent 必须是已用百分比 0–100`).toBeGreaterThanOrEqual(0);
        expect(value.percent, `R28-04 ${key}.percent 必须是已用百分比 0–100`).toBeLessThanOrEqual(100);
      }
    }
  });

  test('R28-05 accountScope 不得携带 email 或 token', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const result = await getUsage(request, baseURL, { probe: true });

    const serialized = JSON.stringify(result.body.accountScope);
    expect(serialized, 'R28-05 accountScope 不得包含 email（不含 @ 形式的地址）').not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(serialized.length, 'R28-05 accountScope 必须是范围标记而不是凭据').toBeLessThanOrEqual(400);
    expect(serialized, 'R28-05 accountScope 不得出现 token/凭据字样').not.toMatch(/token|secret|bearer/i);
  });

  test('R28-06 不可用时给出稳定 code，且不把缺失显示成 0', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const result = await getUsage(request, baseURL, { probe: true });

    if (result.body.status === 'available') return; // 真实订阅可用时这条不适用（见 README 环境缺口）
    expect(CODE_ENUM, `R28-06 不可用/未订阅必须给稳定 code（got ${result.body.code}）`).toContain(result.body.code);
    for (const [key, value] of quotaFields(result.body)) {
      expect(value, `R28-06 ${key} 在不可用状态下不得伪造为 0`).not.toBe(0);
    }
  });

  test('R28-07 辅助查询不改变当前 provider / 模型（反向）', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const before = await rt.currentScope(request, baseURL);

    await getUsage(request, baseURL, { probe: true });
    await getUsage(request, baseURL, { probe: false });

    const after = await rt.currentScope(request, baseURL);
    expect(after, 'R28-07 probe 不得修改当前 provider/模型').toEqual(before);
  });

  test('R28-08 辅助查询不写会话、不新增项目活动（反向）', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const before = await rt.getProjects(request, baseURL);
    const shape = (projects) => projects.map(p => `${p.hash}:${p.sessionCount}:${p.lastActivity}`).sort();

    await getUsage(request, baseURL, { probe: true });

    const after = await rt.getProjects(request, baseURL);
    expect(shape(after), 'R28-08 probe 不得新增/改写任何项目的会话数与活动时间').toEqual(shape(before));
  });

  test('R28-09 60 秒正/负缓存：连续两次调用返回同一批数据（fetchedAt 一致）', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const first = await getUsage(request, baseURL, { probe: true });
    const second = await getUsage(request, baseURL, { probe: true });

    // 前置：没有 fetchedAt 就没有可比的时间戳，"相等"只会在两个 undefined 之间空转。
    expect(Number.isNaN(Date.parse(first.body.fetchedAt)), `R28-09 必须有可比较的 fetchedAt（got ${first.body.fetchedAt}）`).toBe(false);
    expect(second.body.fetchedAt, 'R28-09 缓存窗口内的第二次调用必须复用同一抓取时间戳').toBe(first.body.fetchedAt);
    expect(second.body.status, 'R28-09 缓存窗口内状态不得抖动').toBe(first.body.status);
  });

  test('R28-10 同账户并发查询合并为一次（两个并发响应一致）', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const [a, b] = await Promise.all([
      getUsage(request, baseURL, { probe: true }),
      getUsage(request, baseURL, { probe: true }),
    ]);

    expect(Number.isNaN(Date.parse(a.body.fetchedAt)), `R28-10 必须有可比较的 fetchedAt（got ${a.body.fetchedAt}）`).toBe(false);
    expect(b.body.fetchedAt, 'R28-10 并发请求必须合并/复用同一结果').toBe(a.body.fetchedAt);
    expect(b.body.status, 'R28-10 并发响应状态必须一致').toBe(a.body.status);
  });

  test('R28-11 省略 id 的 fetch-models → 200 且带 source/status/fetchedAt/accountScope', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const result = await rt.postJson(request, baseURL, '/api/provider/fetch-models', {});

    expect(result.status, `R28-11 必须 HTTP 200（got ${JSON.stringify(result.body).slice(0, 200)}）`).toBe(200);
    expect(Array.isArray(result.body.models), 'R28-11 必须返回 models 数组（可以是空）').toBe(true);
    expect(STATUS_ENUM, `R28-11 status 必须取自枚举（got ${result.body.status}）`).toContain(result.body.status);
    expect(Number.isNaN(Date.parse(result.body.fetchedAt)), `R28-11 fetchedAt 必须是可解析时间（got ${result.body.fetchedAt}）`).toBe(false);
    expect(result.body.accountScope !== undefined && result.body.accountScope !== null, 'R28-11 accountScope 必须存在').toBe(true);
    expect(typeof result.body.source, 'R28-11 source 必须存在').toBe('string');
    expect(result.body.windows === undefined || Array.isArray(result.body.windows), 'R28-11 windows 出现时必须是数组').toBe(true);
  });

  test('R28-12 fetch-models 非法 id → 400（稳定 code 信封）', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const result = await rt.postJson(request, baseURL, '/api/provider/fetch-models', { id: 123 });

    rt.expectJsonError(result, { status: 400 });
  });

  test('R28-13 fetch-models 不存在的 provider → 404（稳定 code 信封）', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const result = await rt.postJson(request, baseURL, '/api/provider/fetch-models', { id: 'r2528-no-such-provider' });

    rt.expectJsonError(result, { status: 404 });
  });

  test('R28-14 fetch-models 官方分支未登录 → 200 models=[] 且带稳定 code/note，不误判为正常空目录', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const officialId = await officialProviderId(request, baseURL);

    const result = await rt.postJson(request, baseURL, '/api/provider/fetch-models', { id: officialId });

    expect(result.status, `R28-14 官方分支未登录必须 HTTP 200（got ${JSON.stringify(result.body).slice(0, 200)}）`).toBe(200);
    expect(Array.isArray(result.body.models), 'R28-14 models 必须是数组').toBe(true);
    if (result.body.models.length === 0) {
      const marker = result.body.code || result.body.note;
      expect(marker, 'R28-14 空目录必须带稳定 code 或 note，不能与"官方目录确实为空"混淆').toBeTruthy();
      expect(result.body.status, 'R28-14 空目录时 status 不得是 available').not.toBe('available');
    }
    expect(result.body.note === undefined || typeof result.body.note === 'string', 'R28-14 note 出现时必须是字符串').toBe(true);
  });

  test('R28-15 fetch-models 非官方分支读取实际上游目录且不注入 Claude 专用参数', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;
    const section = rt.fixtureSection('stubProvider');
    const providerId = rt.requireField(section, 'providerId');
    const baseURLOfStub = rt.requireField(section, 'baseURL');
    const port = Number(new URL(baseURLOfStub).port || 80);

    let stub;
    try {
      stub = await startModelsStub({ port, models: [section.model || 'r2528-stub-model'] });
    } catch (error) {
      if (error?.code === 'EADDRINUSE') throw new rt.EnvironmentBlocked(stubBusyHint(port));
      throw error;
    }
    try {
      const result = await rt.postJson(request, baseURL, '/api/provider/fetch-models', { id: providerId });

      expect(result.status, `R28-15 非官方分支必须读取上游目录（got ${JSON.stringify(result.body).slice(0, 200)}）`).toBe(200);
      expect(Array.isArray(result.body.models), 'R28-15 models 必须是数组').toBe(true);
      const ids = result.body.models.map(model => (typeof model === 'string' ? model : model?.value || model?.id || model?.resolvedModel));
      expect(ids, `R28-15 必须拿到上游目录里的模型（got ${JSON.stringify(result.body.models).slice(0, 200)}）`)
        .toContain(section.model || 'r2528-stub-model');
      expect(stub.requests.some(hit => hit.path === '/v1/models'),
        'R28-15 证据：上游桩必须收到这次目录读取').toBe(true);

      const anthropicHeaders = [...new Set(stub.requests.flatMap(hit => hit.headerNames))]
        .filter(name => /anthropic|claude|beta/i.test(name));
      expect(anthropicHeaders, 'R28-15 不得向非 Claude provider 注入 Anthropic 专用头/参数').toEqual([]);
    } finally {
      await stub.close();
    }
  });

  test('R28-16 目录查询不改变配额结果（反向）：两次额度读数一致', async ({ request }) => {
    const baseURL = rt.getRuntime().baseURL;

    const usageBefore = await getUsage(request, baseURL, { probe: false });
    const models = await rt.postJson(request, baseURL, '/api/provider/fetch-models', {});
    expect(models.status, 'R28-16 目录端点独立作答').toBe(200);
    const usageAfter = await getUsage(request, baseURL, { probe: false });

    expect(usageAfter.status, 'R28-16 额度端点始终自行作答').toBe(200);
    // 前置：没有这两个字段，"不改变"的比对就是两个 undefined 相等。
    expectQuotaShape(usageBefore.body, 'R28-16 变更前的额度响应');
    expect(usageAfter.body.status, 'R28-16 目录查询不得改写配额状态（两者是独立结果）').toBe(usageBefore.body.status);
    expect(usageAfter.body.fetchedAt, 'R28-16 目录查询不得改写配额抓取时间').toBe(usageBefore.body.fetchedAt);
  });

  test('R28-17 15 秒超时 → 200 status=unavailable/code=CLI_TIMEOUT 或 MODELS_TIMEOUT（需要停滞依赖）', async ({ request }) => {
    const section = rt.fixtureSection('stalledDependency');
    const baseURL = rt.getRuntime().baseURL;
    const kind = rt.requireField(section, 'kind'); // 'subscription' | 'models'

    const result = kind === 'models'
      ? await rt.postJson(request, baseURL, '/api/provider/fetch-models', { id: rt.requireField(section, 'providerId') })
      : await getUsage(request, baseURL, { probe: true });

    expect(result.status, 'R28-17 超时仍以 HTTP 200 报告').toBe(200);
    expect(result.body.code, `R28-17 超时 code 必须是 ${kind === 'models' ? 'MODELS_TIMEOUT' : 'CLI_TIMEOUT'}`)
      .toBe(kind === 'models' ? 'MODELS_TIMEOUT' : 'CLI_TIMEOUT');
    if (kind === 'models') expect(result.body.models, 'R28-17 目录超时必须 models=[]').toEqual([]);
  });

  test('R28-18 临时失败但有同账户旧值 → status=stale 并标更新时间/原因（需要先有一次成功）', async ({ request }) => {
    const section = rt.fixtureSection('staleAccount');
    const baseURL = rt.getRuntime().baseURL;

    const result = await getUsage(request, baseURL, { probe: rt.requireField(section, 'mode') === 'probe' });
    expect(result.status).toBe(200);
    expect(result.body.status, 'R28-18 有旧值时必须降级为 stale 而不是清空').toBe('stale');
    expect(result.body.fetchedAt, 'R28-18 stale 必须带上次成功时间').toBeTruthy();
    expect(String(result.body.reason || result.body.note || result.body.code || ''), 'R28-18 stale 必须给出原因').not.toBe('');
  });

  test('R28-19 切账户/认证来源改变立即失效，不显示前一账户数据（需要两个账户）', async ({ request }) => {
    const section = rt.fixtureSection('twoAccounts');
    const baseURL = rt.getRuntime().baseURL;

    const first = await getUsage(request, baseURL, { probe: true });
    const before = first.body.accountScope;

    await rt.postJson(request, baseURL, rt.requireField(section, 'switchPath'), section.switchBody || {});
    const second = await getUsage(request, baseURL, { probe: true });

    expect(JSON.stringify(second.body.accountScope), 'R28-19 切账户后不得复用前一账户的 accountScope')
      .not.toBe(JSON.stringify(before));
  });

  test('R28-20 不自行读订阅 token / 拼 OAuth 请求 / 冒充 CLI User-Agent（需要出站录制）', async ({ request }) => {
    const section = rt.fixtureSection('outboundRecording');
    const baseURL = rt.getRuntime().baseURL;
    const observed = rt.requireField(section, 'observedRequestsPath');

    await getUsage(request, baseURL, { probe: true });
    const recorded = await rt.getJson(request, baseURL, observed);
    expect(recorded.status, 'R28-20 需要可读的出站录制夹具').toBe(200);
    const hits = recorded.body?.requests || [];
    const forbidden = hits.filter(hit => /oauth|claude-code\/|user-agent: ?claude-code/i.test(JSON.stringify(hit)));
    expect(forbidden, 'R28-20 GUI 不得自带 OAuth 请求或冒充 CLI User-Agent').toEqual([]);
  });
});

async function officialProviderId(request, baseURL) {
  const providers = await rt.getProviders(request, baseURL);
  const official = providers.providers?.find(p => p.category === 'official' || p.appType === 'claude' || p.format === 'claude');
  expect(official?.id, 'R28 官方分支用例需要实例公布一个官方 provider 身份').toBeTruthy();
  return official.id;
}
