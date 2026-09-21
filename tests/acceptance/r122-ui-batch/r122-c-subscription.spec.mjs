// r122 · C 组(界面层):订阅额度提示区分"命令行工具没登录"与"账户没有订阅"(INTERFACE C1/C3/C4/C5 / BRIEF R3)。
// 手段:浏览器层请求拦截给定 GET /api/subscription-usage 的返回体(INTERFACE C5 允许);身份用 GET /api/provider
// 给定"官方 Anthropic、无 API key"(= 用户的真实处境:走订阅登录)。不读写任何真实登录凭据。
// C2 的服务端纯函数不在本文件范围(INTERFACE 没给出它的名字与签名,见回报)。
// 「修前」= 当前代码:未知状态一律显示「额度暂不可用：<服务端 error>」,不会给出 claude auth login 这个办法。
import { test, expect } from '@playwright/test';
import { PLAIN } from './helpers/fixtures.mjs';
import { boot, openSessionBySearch, openUsagePanel, routeJson, subscriptionCard, cardText } from './helpers/ui.mjs';
import {
  providerOfficialSubscription, subscriptionPayload, subscriptionNotLoggedIn, subscriptionNotSubscribed,
  pricingPayload, currentResolved,
} from './helpers/payloads.mjs';

const NOT_SUBSCRIBED_SENTENCE = '额度暂不可用：该账户没有官方订阅额度（CLI 报告 plan 限额不适用）';
const USAGE_ENTRY = '在官方CLI查看 /usage';

async function openCard(page, subscription, { provider = providerOfficialSubscription() } = {}) {
  const calls = { subscription: 0 };
  await routeJson(page, '/api/provider', provider);
  await page.route((url) => url.pathname === '/api/subscription-usage', (route) => {
    calls.subscription += 1;
    return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(subscription) });
  });
  await routeJson(page, '/api/pricing', pricingPayload());
  await routeJson(page, '/api/pricing/current', currentResolved());
  await boot(page, { fold: null });
  await openSessionBySearch(page, PLAIN.mark);
  await openUsagePanel(page);
  const card = subscriptionCard(page);
  await expect(card, '订阅额度区(标题「订阅额度（官方）」+ /usage 入口)应当渲染').toHaveCount(1, { timeout: 20_000 });
  expect(calls.subscription, '自证:界面确实请求了 /api/subscription-usage(否则显示的不是我们给定的状态)').toBeGreaterThan(0);
  await expect(card.getByRole('button', { name: USAGE_ENTRY }), '/usage 入口照旧').toHaveCount(1);
  return card;
}

// ───────────────────────── C3 not-logged-in ─────────────────────────

test('C3 未登录:订阅额度区的文字含「未登录」', async ({ page }) => {
  const card = await openCard(page, subscriptionNotLoggedIn());
  await expect(card, '未登录时要明说"未登录"').toContainText('未登录');
});

test('C3 未登录:订阅额度区给出可操作的办法,文字含 claude auth login', async ({ page }) => {
  const card = await openCard(page, subscriptionNotLoggedIn());
  await expect(card, '前提:确实进入了未登录状态的提示').toContainText('未登录');
  await expect(card, '未登录时应告诉用户在终端运行 claude auth login(桩的 error 里没有这句,得由界面自己给)').toContainText('claude auth login');
});

test('C3 未登录:订阅额度区不再出现「没有官方订阅额度」', async ({ page }) => {
  const card = await openCard(page, subscriptionNotLoggedIn());
  await expect(card, '前提:确实进入了未登录状态的提示').toContainText('未登录');
  expect(await cardText(card), '未登录不得被说成"该账户没有官方订阅额度"').not.toContain('没有官方订阅额度');
});

test('C1 未登录:三段额度为 null → 不画进度条(不伪造额度)', async ({ page }) => {
  const card = await openCard(page, subscriptionNotLoggedIn());
  const text = await cardText(card);
  for (const label of ['5 小时窗口', '本周 · 全模型']) expect(text, `未登录时不得出现进度条段「${label}」`).not.toContain(label);
  expect(text, '未登录时不得出现百分比').not.toMatch(/\d+\s*%/);
});

// ───────────────────────── C3 not-subscribed:逐字不变 ─────────────────────────

test('C3 已登录但没有订阅额度(not-subscribed):那句提示逐字与今天一致', async ({ page }) => {
  const card = await openCard(page, subscriptionNotSubscribed());
  await expect(card.getByText(NOT_SUBSCRIBED_SENTENCE, { exact: true }), `应有一个元素的文字逐字等于「${NOT_SUBSCRIBED_SENTENCE}」`).toHaveCount(1);
  await expect(card, '状态行仍能读出 NOT_SUBSCRIBED').toContainText('NOT_SUBSCRIBED');
  expect(await cardText(card), 'not-subscribed 不得被说成未登录').not.toContain('未登录');
  expect(await cardText(card), 'not-subscribed 不该给 claude auth login(那是未登录的办法)').not.toContain('claude auth login');
});

// ───────────────────────── C4 其它状态不变(按今天的文字冻结)─────────────────────────

test('C4 available:三段进度条 + 状态「可用」,没有"额度暂不可用"', async ({ page }) => {
  const card = await openCard(page, subscriptionPayload({ status: 'available', segments: true }));
  for (const label of ['5 小时窗口', '本周 · 全模型', '本周 · Opus']) await expect(card, `应有进度条段「${label}」`).toContainText(label);
  await expect(card.getByText('可用', { exact: true }), '状态行「可用」').toHaveCount(1);
  expect(await cardText(card)).not.toContain('额度暂不可用');
});

test('C4 stale:三段进度条 + 「数据更新于」+ 状态「过期（显示上次数据）」', async ({ page }) => {
  const card = await openCard(page, subscriptionPayload({ status: 'stale', segments: true }));
  await expect(card).toContainText('5 小时窗口');
  await expect(card).toContainText('数据更新于');
  await expect(card.getByText('过期（显示上次数据）', { exact: true }), '状态行').toHaveCount(1);
});

test('C4 NOT_OFFICIAL_PROVIDER:提示逐字与今天一致', async ({ page }) => {
  const card = await openCard(page, subscriptionPayload({ status: 'unavailable', code: 'NOT_OFFICIAL_PROVIDER', official: false, error: '当前 provider 不是官方(R122STUB)' }));
  await expect(card.getByText('额度暂不可用：当前 provider 不是官方订阅，未查询官方额度', { exact: true })).toHaveCount(1);
  await expect(card).toContainText('不可用 · NOT_OFFICIAL_PROVIDER');
  expect(await cardText(card)).not.toContain('claude auth login');
});

test('C4 其它失败码(CLI_TIMEOUT):「额度暂不可用：<服务端 error>」+ 状态行带失败码,与今天一致', async ({ page }) => {
  const card = await openCard(page, subscriptionPayload({ status: 'unavailable', code: 'CLI_TIMEOUT', official: true, error: 'CLI 超时(R122STUB)' }));
  await expect(card.getByText('额度暂不可用：CLI 超时(R122STUB)', { exact: true })).toHaveCount(1);
  await expect(card).toContainText('不可用 · CLI_TIMEOUT');
  expect(await cardText(card)).not.toContain('claude auth login');
});
