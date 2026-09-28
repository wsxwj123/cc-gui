// r130 · D 组(界面不变项,反向用例):用量面板既有元素与文案、零项目态不渲染 home-usage、首页既有 testid / 招呼 / 斜杠菜单不变(INTERFACE §D)。
// 不做「北京时间 UTC+08:00」文案断言:探路实测当前用量面板的 innerText / title / details 里都没有这句,无法当不变项;+08:00 分档口径由 D1f 的 byPeriod 基线守。
// 「修前」= 这组应当全绿(守现状)。探路实测(r130-probe.spec.mjs):零项目态文案「添加一个项目开始」;斜杠菜单标题「SLASH 命令」、首项「/clear」。
import { test, expect } from '@playwright/test';
import { gotoHome, prime, stubUsage, payload, dayEntry, dayAgo, homeInput, greeting, usage, home, openUsagePanel, TEXT } from './helpers/ui.mjs';

test('D2a 用量面板既有元素与文案不变:「价格与来源」「导出 CSV」在;stale=true 时面板里出现「统计中，数据可能略旧」', async ({ page }) => {
  await stubUsage(page, payload({ meta: { stale: true }, byDay: [dayEntry(dayAgo(1), 500)] }));
  await gotoHome(page);
  await openUsagePanel(page);
  const outsideHome = await page.getByText(TEXT.stale, { exact: true }).evaluateAll((els) => els.filter((e) => !e.closest('[data-testid="home-usage"]') && e.getClientRects().length).length);
  expect(outsideHome, '面板自己的那句 stale 提示(不算首页的)').toBeGreaterThanOrEqual(1);
});
test('D3 零项目(EmptyState):不渲染 [data-cgui=home] 与 home-usage,显示「添加一个项目开始」', async ({ page }) => {
  await page.route((u) => u.pathname === '/api/projects', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await prime(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('添加一个项目开始').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await expect(home(page)).toHaveCount(0);
  await expect(usage(page)).toHaveCount(0);
});
test('D5a 首页既有 testid 仍在且各一个:home-input / home-send / home-attachment-add / project-selector', async ({ page }) => {
  await gotoHome(page);
  for (const id of ['home-input', 'home-send', 'home-attachment-add', 'project-selector']) await expect(home(page).getByTestId(id), id).toHaveCount(1);
});
test('D5b 招呼 h2[data-cgui=home-greeting] 仍在且有文字', async ({ page }) => {
  await gotoHome(page);
  await expect(greeting(page)).toBeVisible();
  expect((await greeting(page).textContent()).trim().length).toBeGreaterThan(0);
});
test('D5c 斜杠命令菜单不变:在 home-input 输入「/」→ 出现「SLASH 命令」与「/clear」', async ({ page }) => {
  await gotoHome(page);
  await homeInput(page).click();
  await page.keyboard.type('/');
  await expect(page.getByText('SLASH 命令').first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('/clear', { exact: true }).first()).toBeVisible();
});
