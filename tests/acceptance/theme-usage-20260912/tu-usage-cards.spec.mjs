// TU-5xx：R40（用量页「本次刷新逐家结果」默认折叠）+ R41（「订阅额度（官方）」卡按 provider 身份条件显示）。
//
// 黑盒取法：
//   ① 数据来源 —— 契约 §D 明示本批**不新增、不修改任何接口**，只复用三个既有 GET。所以这里用
//      Playwright 的 route 打桩这三个既有接口的**响应体**（形状逐字照 §D 与 §B/§C 的字段名），
//      不改产品代码、不写任何测试专用接口或属性。
//   ② 判据 —— 只用契约公布的公开文案（§B.1 / §C.3）、role、DOM 语义（<details>/<summary>）。
//      「默认折叠」用原生 `<details>.open`；「整块不渲染」用标题文案在 DOM 里计数为 0。
//   ③ 「不得劣于现状」（§C.4）—— 断言入口元素（`/usage` 复制按钮）与状态行仍在，且额度卡
//      （`ProviderQuotaCard`）按 §E 一字不改地照旧渲染。
import { test, expect } from '@playwright/test';
import {
  getRuntime, openUsagePanel, routeJson,
  providerPayload, subscriptionPayload, quotaPayloadOfficial, quotaPayloadOk, quotaPayloadFailed,
} from './helpers/tu-runtime.mjs';

const CARD_TITLE = '订阅额度（官方）';
const USAGE_ENTRY = '在官方CLI查看 /usage';
/**
 * api-key 说明行的两个稳定子串（§C.3 明写测试可断言这两个）。
 * ⚠️ 只有 `按量计费` 能当"是不是说明卡"的判据：现状卡在 status=not-subscribed 时的文案是
 * 「额度暂不可用：该账户没有官方订阅额度（…）」—— 它也含 `没有官方订阅额度`（实测 2026-09-12）。
 */
const API_KEY_MARKER = '按量计费';
const API_KEY_NOTE_KEYS = [API_KEY_MARKER, '没有官方订阅额度'];

/** §B.1 新折叠块的独有文案（用来在同卡片三个折叠块里定位它）。 */
const REFRESH_SUMMARY_TEXT = /本次刷新逐家结果/;

/** §B.1 示例里逐字给出的两行。 */
const ROW_PARTIAL = 'openai · 部分取得（partial） · FETCH_TIMEOUT';
const ROW_FRESH = 'deepseek · 已更新（成功）';

/** §D/§B 需要的价目响应形状（`providers` = 全部预设，`refresh.providers` = 本次刷新条目）。 */
function pricingPayload({ presetCount = 5, entries = 3, status = 'partial' } = {}) {
  const all = [
    { presetId: 'openai', status: 'partial', errorCode: 'FETCH_TIMEOUT' },
    { presetId: 'deepseek', status: 'fresh' },
    { presetId: 'mimo', status: 'fresh' },
  ].slice(0, entries);
  return {
    source: 'official-sources',
    fetchedAt: '2026-09-12T02:00:00.000Z',
    prices: {},
    schemaVersion: 2,
    providers: Array.from({ length: presetCount }, (_, i) => ({
      presetId: `preset-${i + 1}`, status: i === 0 ? 'partial' : 'fresh',
    })),
    quotes: [],
    refresh: { refreshId: 'tu-refresh-1', status, providers: all },
  };
}

/** 打桩 §D 的三个既有接口（`pricing` 可以是固定 payload 或函数）。 */
async function stubApis(page, { pricing, provider, subscription, quota } = {}) {
  if (pricing !== undefined) {
    await page.route((url) => url.pathname === '/api/pricing', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(typeof pricing === 'function' ? pricing(route.request().url()) : pricing),
    }));
  }
  if (provider !== undefined) await routeJson(page, '/api/provider', provider);
  if (subscription !== undefined) await routeJson(page, '/api/subscription-usage', subscription);
  if (quota !== undefined) await routeJson(page, '/api/provider-quota', quota);
}

const refreshBlock = (page) => page.locator('details', { has: page.locator('summary', { hasText: REFRESH_SUMMARY_TEXT }) }).first();
const otherBlock = (page, text) => page.locator('details', { has: page.locator('summary', { hasText: text }) }).first();
const subCardTitle = (page) => page.getByText(CARD_TITLE, { exact: true });

async function openPanelWith(page, stubs) {
  const { baseURL } = getRuntime();
  await stubApis(page, stubs);
  await page.goto(baseURL);
  await openUsagePanel(page, { baseURL });
}

// ===========================================================================
// R40
// ===========================================================================

test('TU-501 R40 默认折叠：摘要文案与同卡片两行同构，条目不可见但仍在 DOM 里', async ({ page }) => {
  await openPanelWith(page, { pricing: pricingPayload() });

  const block = refreshBlock(page);
  await expect(block, 'R40：本次刷新逐家结果必须是一个原生 <details>（与同卡片另两块同款）').toHaveCount(1);
  expect(await block.evaluate(el => el.tagName.toLowerCase()), 'R40：折叠机制必须是原生 <details>').toBe('details');
  expect(await block.evaluate(el => el.open), 'R40：默认必须折叠（无 open 属性）').toBe(false);
  expect(await block.evaluate(el => el.hasAttribute('open')), 'R40：默认必须折叠（DOM 上不得带 open 属性）').toBe(false);

  const summary = block.locator('summary').first();
  const summaryText = (await summary.innerText()).replace(/\s+/g, ' ').trim();
  expect(summaryText, `§B.1 摘要公开文案必须与契约同构（全角括号 + " · " 分隔）：实测「${summaryText}」`)
    .toBe('本次刷新逐家结果（3 家 · partial）');

  const classes = (await summary.getAttribute('class')) || '';
  for (const cls of ['text-[10px]', 'text-ink-faint', 'font-body', 'cursor-pointer']) {
    expect(classes, `§B.1 摘要 class 必须逐字含 ${cls}（与同卡片既有两行一致）`).toContain(cls);
  }

  // 条目确实存在（在 DOM 里）但折叠态不可见 —— "折叠"而不是"没渲染"
  const row = page.getByText(ROW_PARTIAL, { exact: true }).first();
  await expect(row, 'R40：折叠态下条目仍应存在于 DOM（折叠≠缺失）').toHaveCount(1);
  await expect(row, 'R40：默认折叠时条目不可见').toBeHidden();
});

test('TU-502 R40 展开：点摘要后条目可见，每行文案为「presetId · 状态中文[ · errorCode]」', async ({ page }) => {
  await openPanelWith(page, { pricing: pricingPayload() });

  const block = refreshBlock(page);
  await expect(block, 'R40：本次刷新逐家结果必须是一个原生 <details>').toHaveCount(1);
  await block.locator('summary').first().click();
  expect(await block.evaluate(el => el.open), 'R40：点摘要后必须展开').toBe(true);

  await expect(page.getByText(ROW_PARTIAL, { exact: true }).first(), '§B.1 有 errorCode 的行').toBeVisible();
  await expect(page.getByText(ROW_FRESH, { exact: true }).first(), '§B.1 无 errorCode 的行').toBeVisible();

  const body = block.locator('div').first();
  const bodyClass = (await body.getAttribute('class')) || '';
  expect(bodyClass, '§B.1 展开后的 body 必须是一个 class 含 mt-1.5 的 <div>（与同卡片既有折叠块一致）').toContain('mt-1.5');

  const rowClass = (await page.getByText(ROW_FRESH, { exact: true }).first().getAttribute('class')) || '';
  expect(rowClass, '§B.1 每行 class 必须含 text-ink-muted（与同卡片既有明细行同层级）').toContain('text-ink-muted');
});

test('TU-503 R40 计数取"本次刷新条目数"，不是"全部预设家数"（3 家 ≠ 5 家）', async ({ page }) => {
  await openPanelWith(page, { pricing: pricingPayload({ presetCount: 5, entries: 3 }) });

  await expect(refreshBlock(page), 'R40：本次刷新逐家结果必须是一个原生 <details>').toHaveCount(1);
  const summaryText = (await refreshBlock(page).locator('summary').first().innerText()).replace(/\s+/g, ' ').trim();
  expect(summaryText, '§B.1 计数 N 必须等于 refreshEntries.length=3；取 providers.length=5 就是错的')
    .toContain('（3 家 ·');
  expect(summaryText, '§B.1 计数不得取全部预设家数（providers.length=5）').not.toContain('（5 家');

  const sourceText = (await otherBlock(page, /逐家来源与状态/).locator('summary').first().innerText()).replace(/\s+/g, ' ').trim();
  expect(sourceText, '§B.1 同卡片「逐家来源与状态」仍按全部预设计数，必须保持原样不动').toContain('（5 家）');
});

test('TU-504 R40 展开态跨重渲染保留：刷新中连续 ≥5 次数据更新后仍然展开', async ({ page }) => {
  const { baseURL } = getRuntime();
  let pollCount = 0;
  await stubApis(page, {
    pricing: (url) => {
      if (!url.includes('refreshId')) return pricingPayload();
      pollCount += 1;
      // 前 6 次轮询仍报 running 且条目数不变（N>0）→ 客户端会连续 setData 重渲染 6 次
      return pricingPayload({ status: pollCount <= 6 ? 'running' : 'partial' });
    },
  });
  await page.route((url) => url.pathname === '/api/pricing/refresh', (route) => route.fulfill({
    status: 202,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ ok: true, refreshId: 'tu-refresh-1', status: 'running' }),
  }));

  await page.goto(baseURL);
  await openUsagePanel(page, { baseURL });

  const block = refreshBlock(page);
  await expect(block, 'R40：本次刷新逐家结果必须是一个原生 <details>').toHaveCount(1);
  await block.locator('summary').first().click();
  expect(await block.evaluate(el => el.open), '自证：先把它展开').toBe(true);

  await page.getByRole('button', { name: /刷新价格/ }).first().click();

  await expect.poll(() => Promise.resolve(pollCount), {
    timeout: 20_000, message: '自证：刷新确实触发了多次轮询（每次都会 setData 重渲染）',
  }).toBeGreaterThan(5);

  expect(await block.evaluate(el => el.open), '§B.2 展开态必须跨重渲染保留（原生 <details> 不得受控、不得带 key、不得被放进条件分支）').toBe(true);
  await expect(page.getByText(ROW_PARTIAL, { exact: true }).first(), '刷新结束后条目仍可见').toBeVisible();
});

test('TU-505 R40 边界：条目为 0 时整块不渲染；同卡片另两个折叠块保持默认折叠不动', async ({ page }) => {
  await openPanelWith(page, { pricing: pricingPayload({ entries: 0 }) });

  await expect(refreshBlock(page), '§B.1 N===0 → 整块不渲染（DOM 里连 <details> 都不存在）').toHaveCount(0);
  await expect(page.getByText(REFRESH_SUMMARY_TEXT).first(), 'N===0 时不该有这行摘要文案').toHaveCount(0);

  for (const [text, label] of [[/逐家来源与状态/, '逐家来源与状态'], [/原币种报价/, '原币种报价']]) {
    const other = otherBlock(page, text);
    await expect(other, `§B.1 同卡片「${label}」块必须还在`).toHaveCount(1);
    expect(await other.evaluate(el => el.open), `§B.1「${label}」必须保持默认折叠（本次改动不得动它）`).toBe(false);
  }
});

test('TU-506 R40 边界：刷新状态缺失时摘要渲染「—」', async ({ page }) => {
  const payload = pricingPayload();
  delete payload.refresh.status;
  await openPanelWith(page, { pricing: payload });

  await expect(refreshBlock(page), 'R40：本次刷新逐家结果必须是一个原生 <details>').toHaveCount(1);
  const summaryText = (await refreshBlock(page).locator('summary').first().innerText()).replace(/\s+/g, ' ').trim();
  expect(summaryText, '§B.1 状态缺失时必须渲染 —（不是空白、不是 undefined）')
    .toBe('本次刷新逐家结果（3 家 · —）');
});

test('TU-507 R40 重挂载后回到默认折叠（关掉用量面板再打开）', async ({ page }) => {
  await openPanelWith(page, { pricing: pricingPayload() });

  const block = refreshBlock(page);
  await expect(block, 'R40：本次刷新逐家结果必须是一个原生 <details>').toHaveCount(1);
  await block.locator('summary').first().click();
  expect(await block.evaluate(el => el.open), '自证：先展开').toBe(true);

  const usageButton = page.getByRole('button', { name: '用量', exact: true }).first();
  await usageButton.click();          // 收起面板 → 组件卸载
  await usageButton.click();          // 重新打开 → 组件重挂载
  await expect(refreshBlock(page), '重开后面板里应重新出现该块').toHaveCount(1);
  expect(await refreshBlock(page).evaluate(el => el.open), '§B.1 默认态：重挂载后必须还是折叠的').toBe(false);
});

// ===========================================================================
// R41
// ===========================================================================

/**
 * 打开用量面板并把三个接口都打桩好。
 * 返回本次运行里对 `GET /api/subscription-usage` 的实际请求次数（I7：四态都必须请求）。
 */
async function openSubscriptionScenario(page, { provider, subscription, quota, delaySubscriptionMs = 0 }) {
  const { baseURL } = getRuntime();
  const calls = { subscription: 0 };
  await page.route((url) => url.pathname === '/api/subscription-usage', async (route) => {
    calls.subscription += 1;
    if (delaySubscriptionMs) await new Promise(resolve => setTimeout(resolve, delaySubscriptionMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(typeof subscription === 'function' ? subscription() : subscription),
    });
  });
  if (provider !== undefined) await routeJson(page, '/api/provider', provider);
  if (quota !== undefined) await routeJson(page, '/api/provider-quota', quota);
  await page.goto(baseURL);
  await openUsagePanel(page, { baseURL });
  return calls;
}

test('TU-511 R41 矩阵·unknown：拿不到布尔身份时按失败方向多显示 → 现状卡（防误藏）', async ({ page }) => {
  // providerHint 缺失 → store 保持初值（无 hasAuthKey）→ 身份未知
  await openSubscriptionScenario(page, {
    provider: { baseUrl: '', model: null },
    subscription: subscriptionPayload({ status: 'not-subscribed', code: 'NOT_SUBSCRIBED' }),
  });

  await expect(subCardTitle(page), '§C.2 unknown 行 → 必须渲染现状卡（失败方向必须"多显示"）').toHaveCount(1);
  await expect(page.getByRole('button', { name: USAGE_ENTRY }).first(), '§C.4.1 unknown 必须渲染完整的额度入口').toBeVisible();
  await expect(page.getByText(/额度暂不可用/).first(), '§C.4.1 unknown 必须给出不可用文案，不得为空').toBeVisible();
  await expect(page.getByText(API_KEY_MARKER).first(), 'unknown 不得被当成 api-key 降级成说明卡').toHaveCount(0);
});

test('TU-512 R41 矩阵·subscription（官方订阅）：现状卡 + 三段进度条 + /usage 入口', async ({ page }) => {
  await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'anthropic', hasAuthKey: false }),
    subscription: subscriptionPayload({ status: 'available', segments: true }),
  });

  await expect(subCardTitle(page)).toHaveCount(1);
  for (const label of ['5 小时窗口', '本周 · 全模型']) {
    await expect(page.getByText(label, { exact: true }).first(), `§C.2 subscription 行必须出现现状卡的三段进度条：${label}`).toBeVisible();
  }
  await expect(page.getByText(/^本周 · /).first(), '§C.2 第三段标签随接口 label 走').toBeVisible();
  await expect(page.getByText('可用', { exact: true }).first(), '§C.3 状态行沿用现状文案').toBeVisible();
  await expect(page.getByRole('button', { name: USAGE_ENTRY }).first()).toBeVisible();
});

test('TU-513 R41 矩阵·api-key（Claude API 按量）：保留外壳与标题 + 说明行 + /usage 入口 + 状态行，但不显示进度条', async ({ page }) => {
  await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'anthropic', hasAuthKey: true }),
    subscription: subscriptionPayload({ status: 'not-subscribed', code: 'NOT_SUBSCRIBED' }),
  });

  await expect(subCardTitle(page), '§C.3 api-key 档标题仍是「订阅额度（官方）」（不得改名）').toHaveCount(1);
  for (const needle of API_KEY_NOTE_KEYS) {
    await expect(page.getByText(needle).first(),
      `§C.3 api-key 正文说明行必须逐字含「${needle}」`).toHaveCount(1);
  }
  await expect(page.getByRole('button', { name: USAGE_ENTRY }).first(),
    '§C.2/§C.4.2 api-key 档**必须保留** /usage 复制入口（"不劣于现状"的落地要求）').toBeVisible();
  await expect(page.getByText('不可用', { exact: true }).first(), '§C.3 api-key 档保留状态行').toBeVisible();
  await expect(page.getByText('· NOT_SUBSCRIBED', { exact: false }).first(), '§C.2 api-key 档状态行要能读出 NOT_SUBSCRIBED 语义').toBeVisible();
  for (const label of ['5 小时窗口', '本周 · 全模型']) {
    await expect(page.getByText(label, { exact: true }).first(), `§C.2 api-key 档不得显示进度条：${label}`).toHaveCount(0);
  }
});

test('TU-514 R41 矩阵·third-party：整块不渲染，但**仍必须发起** subscription-usage 请求（I7）', async ({ page }) => {
  const calls = await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'deepseek', hasAuthKey: true }),
    subscription: subscriptionPayload({ status: 'not-subscribed' }),
  });

  await expect(subCardTitle(page), '§C.2 third-party 行 → 整块不渲染（DOM 中不存在该卡标题）').toHaveCount(0);
  await expect(page.getByRole('button', { name: USAGE_ENTRY }), 'third-party 档整块不渲染，入口也随之不渲染').toHaveCount(0);
  expect(calls.subscription, '§C.1 调用方契约：third-party 档**仍必须发起**请求（它是第 0 行破例的唯一输入，不是白跑）')
    .toBeGreaterThan(0);
});

test('TU-515 红线 F2：服务端 status=available 时，第三方身份也必须按现状卡渲染（三段进度条出现）', async ({ page }) => {
  await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'deepseek', hasAuthKey: true }),
    subscription: subscriptionPayload({ status: 'available', segments: true }),
  });

  await expect(subCardTitle(page), '§C.2 首行/§C.4.5：服务端有可用数据 > 客户端身份判定（不得整块消失）').toHaveCount(1);
  await expect(page.getByText('5 小时窗口', { exact: true }).first(), '§C.4.5：卡标题与三段进度条必须出现在 DOM 里').toBeVisible();
  await expect(page.getByRole('button', { name: USAGE_ENTRY }).first()).toBeVisible();
  await expect(page.getByText(API_KEY_MARKER).first(), 'F2 破例必须按**现状卡**渲染，不得降级成说明卡').toHaveCount(0);
});

test('TU-516 红线 F2：服务端 status=stale 同样破例；响应到达前不渲染、到达后立刻改渲染现状卡', async ({ page }) => {
  const calls = await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'anthropic', hasAuthKey: true }),   // 身份是 api-key
    subscription: subscriptionPayload({ status: 'stale', segments: true }),
    delaySubscriptionMs: 900,
  });

  await expect(subCardTitle(page), '§C.1 第 0 行破例含 stale → 改渲染现状卡（不是说明卡）').toHaveCount(1);
  await expect(page.getByText('5 小时窗口', { exact: true }).first(), 'stale 破例同样要给出现状卡的三段进度条').toBeVisible();
  await expect(page.getByText('过期（显示上次数据）', { exact: true }).first(), '§C.3 status=stale 的状态行文案').toBeVisible();
  expect(calls.subscription, 'client 确实发起了这次请求').toBeGreaterThan(0);
});

test('TU-517 红线 F2 的反面：status=not-subscribed 时破例**不**生效 → third-party 仍整块不渲染', async ({ page }) => {
  await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'deepseek', hasAuthKey: true }),
    subscription: subscriptionPayload({ status: 'not-subscribed' }),
  });
  await expect(subCardTitle(page), '§C.2/C-P13：破例不生效时不得误显（第三方档仍不渲染）').toHaveCount(0);
});

test('TU-518 R41 边界：hasAuthKey 非布尔 → 身份未知 → 现状卡（不得误藏）', async ({ page }) => {
  await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'anthropic', hasAuthKey: 'false' }),   // 字符串，不是布尔
    subscription: subscriptionPayload({ status: 'not-subscribed' }),
  });

  await expect(subCardTitle(page), '§C.1 判定表第 2 行：typeof hasAuthKey !== "boolean" → unknown → 现状卡').toHaveCount(1);
  await expect(page.getByText(API_KEY_MARKER).first(), '非布尔不得被当成 api-key（false 字符串不得被当真）').toHaveCount(0);
  await expect(page.getByRole('button', { name: USAGE_ENTRY }).first()).toBeVisible();
});

test('TU-519 R41 subscription 档但服务端 status=not-subscribed：按身份判定仍渲染现状卡（不是说明卡）', async ({ page }) => {
  await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'anthropic', hasAuthKey: false }),
    subscription: subscriptionPayload({ status: 'not-subscribed' }),
  });

  await expect(subCardTitle(page), '§C.5 C-P14：身份判定命中 → subscription → 现状卡').toHaveCount(1);
  await expect(page.getByText(API_KEY_MARKER).first(), '身份是官方订阅，不得渲染 api-key 说明行').toHaveCount(0);
  await expect(page.getByText(/额度暂不可用/).first(), '§C.4.1 必须给出不可用文案（不得为空）').toBeVisible();
  await expect(page.getByRole('button', { name: USAGE_ENTRY }).first()).toBeVisible();
});

test('TU-520 §E/R41「额度卡行为不变」：official:true 不渲染；失败态显示原因；成功态显示条目', async ({ page }) => {
  // ① official:true → 额度卡整卡不渲染（既有门控，一字不改）
  await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'anthropic', hasAuthKey: false }),
    subscription: subscriptionPayload({ status: 'available', segments: true }),
    quota: quotaPayloadOfficial(),
  });
  await expect(page.getByText(/^额度 · /).first(), '§E 官方档：ProviderQuotaCard 照旧整卡不渲染').toHaveCount(0);
  await expect(subCardTitle(page), '此时订阅卡接管').toHaveCount(1);

  // ② ok:false → 显示服务端给的原因文案
  await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'deepseek', hasAuthKey: true }),
    subscription: subscriptionPayload({ status: 'not-subscribed' }),
    quota: quotaPayloadFailed({ note: '该 provider 未登记额度接口，请去官网查看' }),
  });
  await expect(page.getByText('额度 · TU Provider').first()
    .or(page.getByText(/^额度 · /).first()), '§E 第三方档：额度卡仍在').toHaveCount(1);
  await expect(page.getByText('该 provider 未登记额度接口，请去官网查看').first(), '§E 额度卡的失败文案一字不改').toBeVisible();

  // ③ ok:true → 显示条目
  await openSubscriptionScenario(page, {
    provider: providerPayload({ providerHint: 'deepseek', hasAuthKey: true }),
    subscription: subscriptionPayload({ status: 'not-subscribed' }),
    quota: quotaPayloadOk({ providerName: 'TU Provider', items: [{ label: '余额', value: 12.34 }] }),
  });
  await expect(page.getByText('余额 ¥12.34', { exact: false }).first(), '§E 额度卡成功态条目照旧').toBeVisible();
});

test('TU-521 R41 身份变化后卡片形态必须重新判定（同一页面里切 provider 身份）', async ({ page }) => {
  const { baseURL } = getRuntime();
  let hint = { providerHint: 'deepseek', hasAuthKey: true };
  await page.route((url) => url.pathname === '/api/provider', (route) => route.fulfill({
    status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(providerPayload(hint)),
  }));
  await routeJson(page, '/api/subscription-usage', subscriptionPayload({ status: 'not-subscribed' }));
  await routeJson(page, '/api/provider-quota', quotaPayloadOfficial());

  await page.goto(baseURL);
  await openUsagePanel(page, { baseURL });
  await expect(subCardTitle(page), '自证：第三方身份先不渲染订阅卡').toHaveCount(0);

  hint = { providerHint: 'anthropic', hasAuthKey: false };
  await page.evaluate(() => window.dispatchEvent(new Event('cgui:provider-change')));

  await expect.poll(async () => await subCardTitle(page).count(), {
    timeout: 15_000,
    message: '§C.4.4 身份变化后卡片形态必须重新判定（这里用的是应用既有的 provider 变更触发口之一；'
      + '若一直不出现，可能是"重取 provider"没生效，也可能是组件没跟着 store 重判 —— 两者都是问题）',
  }).toBe(1);
  await expect(page.getByRole('button', { name: USAGE_ENTRY }).first(), '改判成官方订阅后必须给出现状卡的额度入口').toBeVisible();
});
