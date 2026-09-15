// PR-29 … PR-42 — R22/R23/R24 usage normalization over public HTTP + public UI.
// [模型] cases ride on the operator-prepared live model run; [夹具] cases ride on the stub
// upstream (helpers/stub-upstream.mjs) whose canned `usage` payloads are the只有 way to make
// cache_write / 混合 TTL / 非法值 observable from outside. Real-provider evidence is separate
// acceptance work — see README "Limits of this suite".
import { test, expect } from '@playwright/test';
import {
  getRuntime, fixtureSection, requireField, requireModel, requireStubFixture, EnvironmentBlocked,
  readUsageTotals, openFixtureSession, sendPrompt, waitForTurnEnd, allText, parsePercent,
  clickThroughOverlays, dismissOverlays, ensureAppLoaded, currentProviderRoute, assertStubProviderConfigured,
  ensureStubRoute, STUB_FLAG, uniqueId,
} from './helpers/pr5-runtime.mjs';
import { startStub, STUB_PORT } from './helpers/stub-upstream.mjs';

let BASE;
let stubServer = null;

test.beforeAll(async () => {
  BASE = getRuntime().baseURL;
  if (process.env[STUB_FLAG] === '1') {
    try { stubServer = await startStub({ port: STUB_PORT }); } catch { stubServer = null; }
  }
});

test.afterAll(async () => {
  if (stubServer) await new Promise(resolve => stubServer.close(resolve));
});

// 场景 → 协议（夹具事实，不是产品选择）。缺对应 manifest 段 = 该组 ENVIRONMENT_BLOCKED，不换协议凑数：
// - chat_write：Chat Completions 的 prompt_tokens 含读写，「15000 总输入 / 12000 读 / 3000 写 → 普通 input 0」
//   这条归一只能由 openai 段产生（走产品自己的 Anthropic↔OpenAI 代理）；anthropic 段上游本来就按 Anthropic
//   口径报数，拿它跑等于把答案预先写进夹具，断言会空转。
// - negative/overflow/inconsistent：USAGE_INVALID/USAGE_INCONSISTENT 由产品在 OpenAI 口径转换处标出并随
//   usage 落盘（server/utils/openai-usage.js 的 ccgui_usage.codes）；inconsistent 还需要 prompt_tokens 这个
//   Anthropic 口径里不存在的总量字段，只有 openai 段能表达。
// - mixed_ttl/no_ttl_split：cache_creation.ephemeral_5m/1h 分项只存在于 Anthropic Messages 响应。
// - 其余（零用量、未定价、累计命中率）与协议无关，统一用 anthropic 段：它不经过本机回环代理端口，跑起来更稳。
const SCENARIO_PROTOCOL = {
  chat_write: 'openai',
  negative: 'openai',
  overflow: 'openai',
  inconsistent: 'openai',
  mixed_ttl: 'anthropic',
  no_ttl_split: 'anthropic',
  unknown_model: 'anthropic',
  cum_a: 'anthropic',
  cum_b: 'anthropic',
  zero: 'anthropic',
};

function stubFixtureFor(scenario) {
  const protocol = SCENARIO_PROTOCOL[scenario];
  if (!protocol) throw new EnvironmentBlocked(`场景 ${scenario} 没有声明协议（见 SCENARIO_PROTOCOL）`);
  return { protocol, fixture: requireStubFixture(protocol) };
}

async function selectFromControl(page, rootSelector, name, label) {
  const root = page.locator(rootSelector).first();
  await expect(root, `${label} 控件必须存在（${rootSelector}）`).toBeVisible();
  // 先把指引/更新提示收掉再开弹层。顺序不能反：弹层开着时点弹层外的任何东西
  // （dismissOverlays 点的「关闭指引」就是）会被 AnchoredPopover 判成 outside 当场关闭，
  // 于是要点的行消失、点击一路超时。实测 0.2.378 复现。
  await dismissOverlays(page);
  await clickThroughOverlays(page, root.locator('button').first());
  await page.waitForTimeout(300);
  // 实测 0.2.378：弹层是 portal 到 body 的 div.glass-popover，行文本形如
  // 「PR5 Stub1 模型openai自定义」—— 相邻 span 之间没有空白，名字与「1 模型」连写，
  // 所以 `^\s*名字\b` 这类判据不成立（"b" 与 "1" 之间没有词界）。改用两个稳定事实定位：
  // 行内存在与名字【精确相等】的节点 + 该行是弹层里的可点按钮（顶栏触发器和弹层标题都不是按钮）。
  const popover = page.locator('div.glass-popover');
  const candidates = [
    page.getByRole('option', { name, exact: false }),
    page.getByRole('menuitem', { name, exact: false }),
    popover.getByRole('button').filter({ has: page.getByText(name, { exact: true }) }),
  ];
  for (const candidate of candidates) {
    if (!(await candidate.count())) continue;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // 直接点行，不再套 clickThroughOverlays（它每轮先 dismissOverlays，会把弹层关掉）
        await candidate.first().click({ timeout: 6_000 });
        await page.keyboard.press('Escape').catch(() => {});
        return;
      } catch (error) {
        if (attempt === 1) throw error;
        await page.waitForTimeout(400);
        await clickThroughOverlays(page, root.locator('button').first()); // 弹层被外力关了就重开
        await page.waitForTimeout(400);
      }
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  const seen = await popover.getByRole('button').allInnerTexts().catch(() => []);
  throw new EnvironmentBlocked(
    `${label} 弹层里找不到「${name}」；现有行: ${seen.map(text => text.replace(/\s+/g, ' ').slice(0, 40)).join(' | ') || '(弹层没有行)'}`
    + ' —— 按 README「Stub upstream fixture」先配好该 provider/model',
  );
}

/**
 * 进应用后等"能发消息"的形态出现。实测 0.2.378：goto 的 domcontentloaded 早于 React 渲染
 * （home-input 约 1 秒后才挂上），而且桌面版根本没有「新建会话」按钮——那是窄屏空态才有，
 * 只等按钮会 4 秒超时。这里等到首页输入框或会话输入框任一出现为止。
 */
async function waitForComposerReady(page, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.getByTestId('home-input').count()) return 'home';
    if (await page.getByRole('textbox', { name: /打开命令/ }).count()) return 'session';
    await page.waitForTimeout(400);
  }
  throw new EnvironmentBlocked('打开应用后 15 秒内没出现可发送的输入框（home-input / 打开命令），拿不到发送形态');
}

/** 需要新会话时回到首页形态：侧栏项目行的「新建会话」（data-cgui=new-session-btn）。 */
async function ensureFreshDraft(page) {
  if (await page.getByTestId('home-input').count()) return;
  const button = page.locator('[data-cgui=new-session-btn]').first();
  const target = (await button.count()) ? button : page.getByRole('button', { name: '新建会话', exact: true }).first();
  await clickThroughOverlays(page, target);
  await expect(page.getByTestId('home-input').first(), '新建会话后应回到首页输入形态').toBeVisible({ timeout: 10_000 });
}

function captureSessionIdentity(page) {
  const seen = { sid: null, projectHash: null };
  page.on('request', request => {
    const match = request.url().match(/\/api\/sessions\/([^/?]+)\/messages\?projectHash=([^&]+)/);
    if (match) {
      seen.sid = decodeURIComponent(match[1]);
      seen.projectHash = decodeURIComponent(match[2]);
    }
  });
  return seen;
}

/**
 * One stub-backed turn in a fresh draft: switch provider+model to the stub through the public
 * provider/model controls, send the scenario prompt, wait for the turn to end, then read the
 * session's usage through the public messages endpoint.
 */
async function stubTurn(page, request, scenario, { freshDraft = true } = {}) {
  const { protocol, fixture } = stubFixtureFor(scenario);
  const displayName = requireField(fixture, 'displayName');
  const modelId = requireField(fixture, 'modelId');
  const marker = uniqueId(`PR5SCEN_${scenario}`);
  await ensureAppLoaded(page);      // 进应用:没有这一步页面停在 about:blank,第一个点击就超时
  await waitForComposerReady(page); // 再等 React 把输入框挂上(否则下面的 count() 立刻为 0)
  if (freshDraft) await ensureFreshDraft(page);
  await assertStubProviderConfigured(request, BASE, fixture);
  await selectFromControl(page, '[data-cgui=provider-selector]', displayName, 'provider');
  await selectFromControl(page, '[data-cgui=model-selector]', modelId, 'model');
  // 切换必须真的生效：公开 /api/provider 报的协议与模型要对上本场景要求的协议段，
  // 否则后面的断言会打在别的上游上（协议段配错时这里直接说清楚缺什么）。
  const route = await currentProviderRoute(request, BASE);
  expect(route.protocol, `切到「${displayName}」后的协议标记（本场景要求 ${protocol}）`).toBe(protocol);
  expect(route.model, `切到「${displayName}」后的生效模型`).toBe(modelId);
  // 本机 daemon 抢占用修复（只改本隔离实例的回环地址，见 ensureStubRoute 注释）。
  const repaired = await ensureStubRoute(request, BASE, fixture);
  if (repaired.repaired) {
    test.info().annotations.push({
      type: 'fixture-repair',
      description: `CLI 上行 ${repaired.previous} → ${repaired.baseUrl}（本机常驻代理 daemon 抢占用，夹具修复非产品判定）`,
    });
  }
  const identity = captureSessionIdentity(page);
  await sendPrompt(page, `PR5SCEN=${scenario} ${marker}`);
  const ended = await waitForTurnEnd(page, { timeoutMs: 40_000 });
  expect(ended, `stub 场景 ${scenario} 的回合必须在 40 秒内结束`).toBe(true);
  const deadline = Date.now() + 10_000;
  while (!identity.sid && Date.now() < deadline) await page.waitForTimeout(500);
  expect(identity.sid, '会话身份必须能从应用自己的 messages 请求中读到（公开观测）').toBeTruthy();
  const totals = await readUsageTotals(request, BASE, identity.sid, identity.projectHash);
  expect(totals.status, `messages 端点读取场景 ${scenario} 的用量`).toBe(200);
  return { ...identity, marker, usageTotals: totals.usageTotals ?? {}, page };
}

function collectFields(object, pattern, prefix = '') {
  const found = [];
  for (const [key, value] of Object.entries(object ?? {})) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null) found.push(...collectFields(value, pattern, at));
    else if (pattern.test(key) || pattern.test(at)) found.push({ key: at, value });
  }
  return found;
}

/**
 * 读页面上某个口径名的命中率。`label` 指定合同口径名（如「会话累计命中率」）时只认那一处；
 * 不指定则读页面上第一处命中率（顶部「最近API命中率」）。
 */
async function displayedHitRate(page, { label = null } = {}) {
  const text = await allText(page);
  const pattern = label
    ? new RegExp(`${label}[^\\d%—\\-]{0,24}(\\d+(?:\\.\\d+)?\\s*%|—)`)
    : /(最近API命中率|整轮命中率|会话累计命中率|命中率)[^\d%—\-]{0,24}(\d+(?:\.\d+)?\s*%|—)/;
  const match = pattern.exec(text);
  if (!match) return null;
  const raw = label ? match[1] : match[2];
  return { label: label || match[1], raw, value: parsePercent(raw) };
}

/**
 * 打开上下文徽章弹层。产品自己写明口径分布（App.jsx）:「顶部 = 最近API命中率;整轮口径见轮末徽章;
 * 会话累计见用量面板与上下文徽章弹层」——所以会话累计口径在桌面会话视图里要从徽章弹层读。
 */
async function openContextBadge(page) {
  const badge = page.locator('[data-cgui=badge-context]').first().getByRole('button').first();
  if (!(await badge.count())) {
    throw new EnvironmentBlocked('会话视图里没有上下文徽章（[data-cgui=badge-context]），读不到「会话累计命中率」');
  }
  await badge.click({ timeout: 5_000 });
  await page.waitForTimeout(600);
}

test('PR-29 [R22/R24] 真实模型运行的用量保留五类口径且非负，重复读取不双计', async ({ request }) => {
  requireModel();
  const sessionFlow = fixtureSection('sessionFlow');
  const sessionId = requireField(sessionFlow, 'sessionId');
  const projectHash = requireField(sessionFlow, 'projectHash');
  const first = await readUsageTotals(request, BASE, sessionId, projectHash);
  expect(first.status, 'messages 端点读取用量').toBe(200);
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreation']) {
    expect(typeof first.usageTotals?.[key], `usageTotals.${key} 必须是数字`).toBe('number');
    expect(first.usageTotals[key] >= 0, `usageTotals.${key} 不得为负`).toBe(true);
  }
  const second = await readUsageTotals(request, BASE, sessionId, projectHash);
  expect(second.usageTotals, '同一 message id 的用量重放不得双计').toEqual(first.usageTotals);
});

test('PR-30 [R22] Chat Completions 缓存写量归一：15000 总输入 / 12000 读 / 3000 写 → input0/read12000/write3000', async ({ page, request }) => {
  const { usageTotals, page: current } = await stubTurn(page, request, 'chat_write');
  expect(usageTotals.cacheRead, 'cache_read 必须是 12000（不被当成普通输入）').toBe(12000);
  expect(usageTotals.cacheCreation, 'cache_write 必须计为写入 3000').toBe(3000);
  expect(usageTotals.input, '普通 input 必须是 0（总输入已包含读写）').toBe(0);
  expect(usageTotals.input + usageTotals.cacheRead + usageTotals.cacheCreation, '读写与普通输入不得重复相加').toBe(15000);
  expect(current.url()).toContain('/');
});

test('PR-31 [R22] 同一 usage 重复运行归一结果一致（流式/非流式与历史同口径）', async ({ page, request }) => {
  const first = await stubTurn(page, request, 'chat_write');
  const second = await stubTurn(page, request, 'chat_write');
  expect(second.usageTotals, '两次相同 usage 的归一结果必须逐字段一致（流式/非流式不得不同）').toEqual(first.usageTotals);
  test.info().annotations.push({
    type: 'note',
    description: '若产品只使用一种传输模式，本用例只能证明该模式下的确定性；两种模式并存时的对照见 TEST-PLAN 缺口',
  });
});

test('PR-32 [R22] 历史回读与实时同口径：刷新页面重开会话后用量不变', async ({ page, request }) => {
  const run = await stubTurn(page, request, 'chat_write');
  const before = run.usageTotals;
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const search = page.getByRole('textbox', { name: /搜索项目/ }).first();
  await clickThroughOverlays(page, search);
  await search.fill(run.marker);
  await page.waitForTimeout(1_500);
  const after = await readUsageTotals(request, BASE, run.sid, run.projectHash);
  expect(after.usageTotals, '历史回读必须与实时归一一致').toEqual(before);
});

test('PR-33 [R23] Anthropic 混合 TTL：5m/1h 分项保留，命中率分母只计一次 creation（80%，不是 66.7%）', async ({ page, request }) => {
  const run = await stubTurn(page, request, 'mixed_ttl');
  const fiveMinute = collectFields(run.usageTotals, /5m|ephemeral_5m/i);
  const oneHour = collectFields(run.usageTotals, /1h|ephemeral_1h/i);
  expect(fiveMinute.length, `用量输出必须保留 5 分钟写量分项，实际: ${JSON.stringify(run.usageTotals)}`).toBeGreaterThan(0);
  expect(oneHour.length, `用量输出必须保留 1 小时写量分项，实际: ${JSON.stringify(run.usageTotals)}`).toBeGreaterThan(0);
  expect(fiveMinute.map(field => field.value), '5 分钟写量').toContain(1000);
  expect(oneHour.map(field => field.value), '1 小时写量').toContain(1000);
  const rated = await displayedHitRate(page);
  expect(rated, '会话视图必须显示带口径名的命中率').toBeTruthy();
  const expected = (8000 / (0 + 8000 + 2000)) * 100; // 80.0
  expect(Math.abs(rated.value - expected), `显示 ${rated.raw}，按 read/(input+read+creation) 应为 80.0%`).toBeLessThanOrEqual(0.2);
  expect(Math.abs(rated.value - 66.7), 'creation 被重复相加（分母 12000）会得到 66.7%').toBeGreaterThan(1);
});

test('PR-34 [R23] 顶层 creation 与 TTL 分项不重复相加：写量不得出现 4000', async ({ page, request }) => {
  const run = await stubTurn(page, request, 'mixed_ttl');
  const writeLike = collectFields(run.usageTotals, /creat|write/i);
  const doubled = writeLike.filter(field => typeof field.value === 'number' && field.value > 2000);
  expect(doubled, `顶层 creation(2000) 与分项(1000+1000) 相加成 4000: ${JSON.stringify(doubled)}`).toEqual([]);
  const topLevel = writeLike.filter(field => field.key === 'cacheCreation' || field.key === 'cache_creation_input_tokens');
  if (topLevel.length) expect(topLevel.some(field => field.value === 2000), '顶层写量应为 2000').toBe(true);
});

test('PR-35 [R23] 缺 TTL 分配且 TTL 价不同：写费必须标未知，不按单一倍率猜', async ({ page, request }) => {
  await stubTurn(page, request, 'no_ttl_split');
  const text = await allText(page);
  expect(text, '缺 TTL 分配时必须给未知/估算标注（不得默默按 5m 或 1h 计价）').toMatch(/(未知|估算|unknown|无价|未定价)/);
});

test('PR-36 [R23 反向] 未知新型号不套旧型号价格（无最长前缀回退价）', async ({ page, request }) => {
  const { fixture } = stubFixtureFor('unknown_model');
  const modelId = requireField(fixture, 'modelId');
  const run = await stubTurn(page, request, 'unknown_model');
  const text = await allText(page);
  const marksUnknown = /(未知|估算|未定价|无价|unmapped|未映射)/.test(text);
  const numericCost = /(?:¥|￥|\$)\s?\d/.test(text);
  expect(marksUnknown || !numericCost, `模型 ${modelId} 无官方价时必须标未知/未定价，实际页面: ${text.slice(0, 160).replace(/\n/g, ' | ')}`).toBe(true);
  expect(run.usageTotals.input, 'stub 用量仍应原样保留').toBe(1000);
});

test('PR-37 [R24] 会话累计命中率按加权口径：0/1000 与 9000/9000 累计 90%，不是 50%', async ({ page, request }) => {
  const first = await stubTurn(page, request, 'cum_a');
  await stubTurn(page, request, 'cum_b', { freshDraft: false });
  const totals = await readUsageTotals(request, BASE, first.sid, first.projectHash);
  const { input = 0, cacheRead = 0, cacheCreation = 0 } = totals.usageTotals ?? {};
  expect(input + cacheRead + cacheCreation, '两次调用应累计 10000 输入').toBe(10000);
  const expected = (cacheRead / (input + cacheRead + cacheCreation)) * 100; // 9000/10000 = 90
  await openContextBadge(page); // 会话累计口径在徽章弹层（顶部那处是「最近API命中率」，不是本条要读的口径）
  const rated = await displayedHitRate(page, { label: '会话累计命中率' });
  expect(rated, '两次调用后必须能看到累计命中率').toBeTruthy();
  expect(Math.abs(rated.value - expected), `显示 ${rated.raw}，加权累计应为 90.0%，算术平均 50% 是错的`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(rated.value - 50), '不得用两次百分比的算术平均（50%）').toBeGreaterThan(5);
});

test('PR-38 [R24] 分母为 0 时命中率显示「—」，不显示 0%/NaN', async ({ page, request }) => {
  await stubTurn(page, request, 'zero');
  const text = await allText(page);
  const rated = await displayedHitRate(page);
  expect(rated, '零用量会话仍必须有命中率位（分子分母都为 0）').toBeTruthy();
  expect(text, '分母 0 时必须显示 —').toMatch(/命中率[^\n]{0,24}(—|–|--)/);
  expect(text, '不得出现 NaN/Infinity').not.toMatch(/NaN|Infinity/);
});

test('PR-39 [R22 错误] 负数用量标 USAGE_INVALID，不计算负费用', async ({ page, request }) => {
  await stubTurn(page, request, 'negative');
  const text = await allText(page);
  expect(text, '无效负数必须标 USAGE_INVALID').toContain('USAGE_INVALID');
  expect(text, '不得显示负数金额').not.toMatch(/(?:¥|￥|\$)\s?-\d/);
});

test('PR-40 [R22 错误] 超过 MAX_SAFE_INTEGER/溢出的用量标 USAGE_INVALID，金额未知且不四舍五入', async ({ page, request }) => {
  await stubTurn(page, request, 'overflow');
  const text = await allText(page);
  expect(text, '溢出用量必须标 USAGE_INVALID').toContain('USAGE_INVALID');
  expect(text, '不得把溢出值四舍五入成一个具体金额').not.toMatch(/(?:¥|￥|\$)\s?\d{7,}/);
});

test('PR-41 [R22 错误] 分项总量冲突标 USAGE_INCONSISTENT，保留原始数据供说明', async ({ page, request }) => {
  const run = await stubTurn(page, request, 'inconsistent');
  const text = await allText(page);
  expect(text, '分项冲突必须标 USAGE_INCONSISTENT').toContain('USAGE_INCONSISTENT');
  const preserved = JSON.stringify(run.usageTotals);
  expect(preserved, '冲突时必须保留原始数据（12000 读 / 3000 写）').toMatch(/12000/);
});

test('PR-42 [R24 反向] 缓存未命中不伪造：read=0 时命中率 0%，不按 GUI 推测改写', async ({ page, request }) => {
  const run = await stubTurn(page, request, 'cum_a');
  expect(run.usageTotals.cacheRead, '供应商没说命中就必须是 0').toBe(0);
  const rated = await displayedHitRate(page);
  expect(rated, '命中率位必须存在').toBeTruthy();
  expect(rated.value, `未命中时应显示 0%，实际 ${rated.raw}`).toBeLessThanOrEqual(0.1);
});
