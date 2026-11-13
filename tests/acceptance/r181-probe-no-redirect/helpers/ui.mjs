// r181 界面操作层:只按用户看得见的文字 + 接口文件公布的定位办法;其余元素按运行页面后观察到的 DOM 定位。
import { expect } from '@playwright/test';

/** 进应用并压掉一次性浮层(只拦版本检查这两个与本项无关的接口,拉取模型的接口一律走真后端)。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const url of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}

export async function dismissOverlays(page, passes = 6) {
  for (let i = 0; i < passes; i += 1) {
    let hit = false;
    for (const label of ['稍后', '以后再说', '已知晓']) {
      const btn = page.locator('button').filter({ hasText: label }).last();
      if (await btn.isVisible().catch(() => false)) { await btn.click({ force: true }).catch(() => {}); await page.waitForTimeout(120); hit = true; }
    }
    if (!hit) return;
  }
}

export async function openDockPanel(page, name) {
  const btn = page.locator('[data-cgui="panel-dock"]').getByRole('button', { name, exact: true }).first();
  if (!(await btn.isVisible().catch(() => false))) { await page.locator('[data-testid="panel-dock-toggle"]').first().click({ timeout: 8_000 }); await page.waitForTimeout(400); }
  await expect(btn, `顶栏面板坞里应当有「${name}」`).toBeVisible({ timeout: 10_000 });
  await btn.click({ timeout: 8_000 });
}

// ---- 文本 Provider:Provider 管理 → 条目行的铅笔(title=编辑)→ 编辑表单 ----
export async function openProviderManager(page) {
  const manager = page.locator('[data-testid="provider-manager"]');
  if (!(await manager.count())) await page.evaluate(() => window.dispatchEvent(new CustomEvent('cgui:open-provider-manager')));
  await expect(manager, '全局事件 cgui:open-provider-manager 应打开 Provider 管理弹窗').toBeVisible({ timeout: 8_000 });
  return manager;
}

/** 按 value 找页面上的 input(编辑表单里的地址框预填着已保存地址)。 */
export async function inputWithValue(page, value) {
  const inputs = page.locator('input');
  await expect.poll(async () => inputs.evaluateAll((els, v) => els.findIndex((e) => e.value === v), value), { message: `页面上应有值为 ${value} 的输入框`, timeout: 10_000 }).toBeGreaterThanOrEqual(0);
  const idx = await inputs.evaluateAll((els, v) => els.findIndex((e) => e.value === v), value);
  return inputs.nth(idx);
}

export async function openTextProviderEdit(page, name, savedBase) {
  const manager = await openProviderManager(page);
  const row = manager.locator('div').filter({ hasText: name }).filter({ has: page.locator('button[title="编辑"]') }).last();
  await expect(row, `Provider 管理里应有条目「${name}」`).toBeVisible({ timeout: 10_000 });
  await row.locator('button[title="编辑"]').first().click({ timeout: 8_000 });
  const addr = await inputWithValue(page, savedBase);
  const key = page.getByPlaceholder(/API Key.*留空/).first();
  await expect(key, '编辑表单里应有 Key 输入框(占位文字「API Key(留空 = 不修改)」)').toBeVisible({ timeout: 10_000 });
  return { addr, key, fetchButton: page.getByRole('button', { name: '获取模型', exact: true }).first() };
}

/** 提示框:role=dialog,正文下面有「确定」。返回含「确定」按钮的那个 dialog。 */
export const alertDialog = (page) => page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '确定', exact: true }) }).last();

// ---- 勾选弹窗(拉到模型后弹出):弹窗根 = 罩住「全不选」按钮与 ≥1 个 checkbox 的最深容器 ----
export const pickModal = (page) => page.locator('div')
  .filter({ has: page.getByRole('button', { name: '全不选', exact: true }) })
  .filter({ has: page.locator('input[type=checkbox]') }).last();
export const pickCancel = (page) => pickModal(page).getByRole('button', { name: '取消', exact: true }).first();

// ---- 生图面板 ----
export const imagePanel = (page) => page.locator('[data-cgui-panel]').filter({ has: page.getByText('生图（自定义生图 provider）') }).first();
export async function openImagePanel(page) {
  const header = page.getByText('生图（自定义生图 provider）').first();
  if (!(await header.isVisible().catch(() => false))) await openDockPanel(page, '生图');
  await expect(header, '应打开生图面板').toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
}
export const imageBaseInput = (page) => imagePanel(page).getByPlaceholder('https://api.example.com/v1').first();
export const imageKeyInput = (page) => imagePanel(page).getByPlaceholder(/^sk-/).first();
export const imageFetchModelsButton = (page) => imagePanel(page).getByRole('button', { name: /拉取模型/ }).first();
export async function openImageProviderEdit(page, id) {
  await openImagePanel(page);
  const sel = imagePanel(page).locator('select').filter({ has: page.locator(`option[value="${id}"]`) }).first();
  await expect(sel, `生图页的提供方下拉里应有 ${id}`).toBeVisible({ timeout: 10_000 });
  await sel.selectOption(id);
  await imagePanel(page).locator('button[title="编辑"]').first().click({ force: true });
  await expect(imageFetchModelsButton(page), '应进入编辑表单(有「拉取模型」)').toBeVisible({ timeout: 10_000 });
}
