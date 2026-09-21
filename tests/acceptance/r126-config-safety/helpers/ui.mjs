// r126 界面操作层:只按用户看得见的东西 + INTERFACE-r126 §B2 公布的锚点定位(照 r125 套件的写法)。
// 依据只有 .devflow/BRIEF-r126.md 与 .devflow/INTERFACE-r126.md;没看实现代码。既有入口(r125 套件实测)在各处注明。
import { expect } from '@playwright/test';

export async function prime(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const url of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
}

/** 进应用并压掉一次性浮层。 */
export async function boot(page) {
  await prime(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}

/** 反复点掉「稍后 / 以后再说 / 已知晓」这类一次性浮层。 */
export async function dismissOverlays(page, passes = 6) {
  for (let i = 0; i < passes; i += 1) {
    let hit = false;
    for (const label of ['稍后', '以后再说', '已知晓']) {
      const btn = page.locator('button').filter({ hasText: label }).last();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(120);
        hit = true;
      }
    }
    if (!hit) return;
  }
}

/** 刷新页面并等应用重新挂好(刷新页面 ≠ 重启服务端;Q4 说的"不用重启"指服务端)。 */
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}

export const textOf = (loc) => loc.evaluate((el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());

// ---------------------------------------------------------------------------
// 顶栏 provider 按钮(r125 实测的 title 前缀)与切换浮层(INTERFACE B2 锚点 provider-switch-list;r125 §D 契约同名)
// 兜底形态只用于"打开浮层"这一步;警告元素本身严格按 INTERFACE 的 data-testid 找,不兜底。
// ---------------------------------------------------------------------------
export const providerButton = (page) => page.locator('button[title^="Provider:"]').first();
export const switchList = (page) => page.locator('[data-testid="provider-switch-list"]');
export const switchRows = (page) => switchList(page).locator('[data-provider-id]');
export const legacySwitchList = (page) => page.locator('div')
  .filter({ has: page.getByRole('button', { name: /管理 Provider/ }) })
  .filter({ hasText: /provider\s*[·•・]\s*当前/i }).last();
export const switchListAny = (page) => switchList(page).or(legacySwitchList(page));
export const switchRowsAny = (page) => switchRows(page).or(legacySwitchList(page).locator('button:has(div[title])'));

export async function openProviderList(page) {
  if (!(await switchListAny(page).isVisible().catch(() => false))) await providerButton(page).click({ force: true });
  await expect(switchListAny(page), 'provider 切换浮层应打开').toBeVisible({ timeout: 10_000 });
}
export async function closeProviderList(page) {
  await page.keyboard.press('Escape');
  await expect(switchListAny(page)).toHaveCount(0, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
// Provider 管理弹窗(既有入口,照 pricing-accuracy / r125 套件:全局事件 cgui:open-provider-manager;testid provider-manager)
// ---------------------------------------------------------------------------
export const manager = (page) => page.locator('[data-testid="provider-manager"]');
export async function openProviderManager(page) {
  if (!(await manager(page).count())) await page.evaluate(() => window.dispatchEvent(new CustomEvent('cgui:open-provider-manager')));
  await expect(manager(page), '全局事件 cgui:open-provider-manager 应打开 Provider 管理弹窗').toBeVisible({ timeout: 8_000 });
  return manager(page);
}

// ---------------------------------------------------------------------------
// 手机页(探路实测,视口 390×844):没有 panel-dock;banner 里 title=会话 的按钮开菜单 →「Provider / 模型」进 provider 页
// (页内有「返回」「管理 Provider」与「全部 PROVIDER · 点行展开模型,选模型即切换」)。今天该页没有 provider-switch-list 锚点。
// ---------------------------------------------------------------------------
export const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
export async function bootMobile(page) {
  await prime(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: '新建会话' }).first(), '手机页应挂好(banner 里有「新建会话」)').toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}
export async function openMobileProviderPage(page) {
  await page.getByRole('button', { name: '会话', exact: true }).first().click({ force: true });
  const entry = page.locator('button').filter({ hasText: /Provider \/ 模型/ }).first();
  await expect(entry, '手机菜单里应有「Provider / 模型」').toBeVisible({ timeout: 10_000 });
  await entry.click({ force: true });
  await expect(page.getByText(/全部 provider/i).first(), '应进入手机 provider 页(有「全部 PROVIDER」)').toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// INTERFACE §B2 新增锚点:provider-list-warning(当前代码还没有 → 用例红在"锚点不存在"属预期)
// ---------------------------------------------------------------------------
export const listWarning = (page) => page.locator('[data-testid="provider-list-warning"]');
export const listWarningIn = (root) => root.locator('[data-testid="provider-list-warning"]');
