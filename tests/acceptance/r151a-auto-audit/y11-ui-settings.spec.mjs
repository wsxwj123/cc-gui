// S 组:设置页「权限」分区里的第三方自动档块(INTERFACE Y.3.4 "设置页")。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import {
  get, useProvider, useOfficial, useUnknownProvider, tpAutoOn, tpAutoOff, resetOverrides, readJson, snapshot, SETTINGS, OVERRIDES,
} from './helpers/api.mjs';
import { boot, openPermissionSettings, tpSection, recordRequests, openFreshSession, openSelector, autoOption, readLocal } from './helpers/ui.mjs';
import { UI, ERR, APPLY_FAILED } from './helpers/texts.mjs';
import { provider, PROVIDERS } from './helpers/scenes.mjs';

let saved = {};
test.beforeEach(async () => { saved = snapshot([SETTINGS(), OVERRIDES()]); await tpAutoOff(); resetOverrides({}); });
test.afterEach(async () => { for (const [p, c] of Object.entries(saved)) if (c !== null) fs.writeFileSync(p, c); });

const toggle = (page) => page.getByTestId('third-party-auto-toggle');
const modelSelect = (page) => page.getByTestId('auto-audit-model-select');
/** 读审核模型下拉的选项:原生 <select> 读 option;否则点开读 role=option。 */
async function selectOptions(page) {
  const sel = modelSelect(page);
  await expect(sel).toBeVisible({ timeout: 10_000 });
  if (await sel.evaluate((e) => e.tagName === 'SELECT')) {
    return sel.evaluate((e) => [...e.options].map((o) => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled })));
  }
  await sel.click();
  return page.locator('[role="option"]').evaluateAll((els) => els.map((o) => ({ value: o.getAttribute('data-value') ?? o.getAttribute('value'), text: (o.innerText || '').trim(), disabled: o.getAttribute('aria-disabled') === 'true' || o.hasAttribute('disabled') })));
}
async function pickModel(page, value) {
  const sel = modelSelect(page);
  if (await sel.evaluate((e) => e.tagName === 'SELECT')) { await sel.selectOption(value); return; }
  await sel.click();
  await page.locator('[role="option"]').filter({ hasText: value }).first().click();
}
const selectedValue = (page) => modelSelect(page).evaluate((e) => (e.tagName === 'SELECT' ? e.value : (e.getAttribute('data-value') ?? e.textContent.trim())));

async function openAt(page, setup) {
  await setup();
  await boot(page);
  await openPermissionSettings(page);
  await expect(tpSection(page), '应有第三方自动档设置块').toBeVisible({ timeout: 10_000 });
}
const thirdParty = async (key = 'main') => { const id = await provider(key); await useProvider(id); return id; };

test.describe('S 开关', () => {
  test('S1 第三方:权限分区里有设置块,开关 role=switch 且 aria-checked="false"(默认关)', async ({ page }) => {
    await openAt(page, () => thirdParty());
    await expect(page.locator('#set-third-party-auto')).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('role', 'switch');
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  });

  test('S2 点开关 → 发 PUT /api/prefs/third-party-auto {enabled:true},开关变成 aria-checked="true",服务端读到 true', async ({ page }) => {
    await openAt(page, () => thirdParty());
    const puts = recordRequests(page, '/api/prefs/third-party-auto');
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => puts.filter((r) => r.method === 'PUT').map((r) => r.body)).toEqual([{ enabled: true }]);
    expect((await get('/api/prefs/third-party-auto')).body).toEqual({ enabled: true });
  });

  test('S3 开关保存失败 → 开关回到原位,并显示错误文本', async ({ page }) => {
    await openAt(page, () => thirdParty());
    await page.route('**/api/prefs/third-party-auto', (r) => (r.request().method() === 'PUT'
      ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, code: ERR.STORAGE.code, error: ERR.STORAGE.error }) })
      : r.continue()));
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-checked', 'false', { timeout: 5_000 });
    await expect(tpSection(page)).toContainText(ERR.STORAGE.error);
  });

  test('S4 告知恒显示三行(逐字)', async ({ page }) => {
    await openAt(page, () => thirdParty());
    const n = page.getByTestId('third-party-auto-notice');
    for (const line of UI.NOTICE_LINES) await expect(n).toContainText(line);
  });

  test('S14 设置搜索「第三方 provider 的自动档」能找到并跳到这一块', async ({ page }) => {
    await thirdParty();
    await boot(page);
    await openPermissionSettings(page);
    await page.getByRole('button', { name: '更新', exact: true }).first().click();
    await page.getByPlaceholder(/搜索设置/).fill(UI.SEARCH_TITLE);
    const hit = page.getByText(UI.SEARCH_TITLE, { exact: true }).first();
    await expect(hit).toBeVisible({ timeout: 5_000 });
    await hit.click();
    await expect(tpSection(page)).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('S 审核模型下拉', () => {
  test('S5 选项 = "跟随默认模型"(值为空串)+ status.models;unusable 的项禁用并标"不可用作审核模型"', async ({ page }) => {
    await openAt(page, () => thirdParty('claude'));
    const opts = await selectOptions(page);
    expect(opts[0]).toMatchObject({ value: '', text: UI.FOLLOW_DEFAULT });
    const rest = opts.slice(1);
    expect(rest.map((o) => o.value).sort()).toEqual([...PROVIDERS.claude.models].sort());
    for (const o of rest) {
      const unusable = ['claude-sonnet-5-5', 'Claude-Opus-5-5-20261101'].includes(o.value);
      expect(o.disabled, `${o.value} 是否禁用`).toBe(unusable);
      if (unusable) expect(o.text).toContain(UI.UNUSABLE_MARK); else expect(o.text).not.toContain(UI.UNUSABLE_MARK);
    }
  });

  test('S6 选一个模型 → 发 PUT /api/auto-audit/model {providerId, model},覆盖层随之写入', async ({ page }) => {
    let id;
    await openAt(page, async () => { id = await thirdParty(); });
    const puts = recordRequests(page, '/api/auto-audit/model');
    await pickModel(page, 'r151-reasoner');
    await expect.poll(() => puts.filter((r) => r.method === 'PUT').map((r) => r.body)).toEqual([{ providerId: id, model: 'r151-reasoner' }]);
    await expect.poll(() => (readJson(OVERRIDES())[id] || {}).tierModels?.sonnet).toBe('r151-reasoner');
  });

  test('S7 保存返回 4xx → 下拉回到原选项,并显示返回的 error', async ({ page }) => {
    await openAt(page, () => thirdParty());
    const before = await selectedValue(page);
    await page.route('**/api/auto-audit/model', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, code: ERR.MODEL_NOT_IN_PROVIDER.code, error: ERR.MODEL_NOT_IN_PROVIDER.error }) }));
    await pickModel(page, 'r151-reasoner');
    await expect(tpSection(page)).toContainText(ERR.MODEL_NOT_IN_PROVIDER.error, { timeout: 5_000 });
    await expect.poll(() => selectedValue(page)).toBe(before);
  });

  test('S15 保存返回 warning:"APPLY_FAILED" → 显示「已保存,但未能写入当前配置;重新切换一次该 provider 后生效」', async ({ page }) => {
    let id;
    await openAt(page, async () => { id = await thirdParty(); });
    await page.route('**/api/auto-audit/model', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, providerId: id, auditModel: 'r151-reasoner', reapplied: false, warning: APPLY_FAILED }) }));
    await pickModel(page, 'r151-reasoner');
    await expect(tpSection(page)).toContainText(UI.APPLY_FAILED_TEXT, { timeout: 5_000 });
  });

  test('S8 共用说明(alias-note)逐字', async ({ page }) => {
    await openAt(page, () => thirdParty());
    await expect(page.getByTestId('auto-audit-alias-note')).toHaveText(UI.ALIAS_NOTE);
  });

  test('S10 选型提示(model-hint)逐字', async ({ page }) => {
    await openAt(page, () => thirdParty());
    await expect(page.getByTestId('auto-audit-model-hint')).toHaveText(UI.MODEL_HINT);
  });
});

test.describe('S 未设提示(auto-audit-model-unset)', () => {
  test('S9 开关开 + 第三方 + 来源 default → 「尚未选择审核模型,当前使用该 provider 的默认模型 r151-chat。」', async ({ page }) => {
    await openAt(page, async () => { await thirdParty(); await tpAutoOn(); });
    await expect(page.getByTestId('auto-audit-model-unset')).toHaveText(UI.modelUnset('r151-chat'));
  });

  test('S9b 来源 tier(显式设了 sonnet 档)→ 不渲染未设提示', async ({ page }) => {
    await openAt(page, async () => { await thirdParty('sonnet'); await tpAutoOn(); });
    await expect(page.getByTestId('auto-audit-alias-note'), '前置:设置块已渲染').toBeVisible();
    await expect(page.getByTestId('auto-audit-model-unset')).toHaveCount(0);
  });

  test('S9c 开关关 → 不渲染未设提示', async ({ page }) => {
    await openAt(page, () => thirdParty());
    await expect(page.getByTestId('auto-audit-alias-note'), '前置:设置块已渲染').toBeVisible();
    await expect(page.getByTestId('auto-audit-model-unset')).toHaveCount(0);
  });
});

test.describe('S 清除不可用标记', () => {
  test('S11 本地没有任何标记 → 「清除不可用标记」按钮禁用', async ({ page }) => {
    await openAt(page, () => thirdParty());
    const btn = page.getByTestId('auto-unavailable-reset');
    await expect(btn).toHaveText(UI.RESET_BTN);
    await expect(btn).toBeDisabled();
  });

  test('S11b 有标记时可点;点击后清空 cgui-auto-unavailable,选择器立刻重新出现自动档', async ({ page }) => {
    const id = await thirdParty();
    await tpAutoOn();
    await boot(page, { 'cgui-auto-unavailable': JSON.stringify({ [`tp:${id}|r151-chat`]: true }) });
    await openFreshSession(page, 's11b');
    await openPermissionSettings(page);
    const btn = page.getByTestId('auto-unavailable-reset');
    await expect(btn).toBeEnabled();
    await btn.click();
    const left = await readLocal(page, 'cgui-auto-unavailable');
    expect(left === null || left === '{}' || left === '', `剩下:${left}`).toBe(true);
    await page.keyboard.press('Escape').catch(() => {});
    await openSelector(page);
    await expect(autoOption(page)).toHaveCount(1, { timeout: 5_000 });
  });
});

test.describe('S 官方 / 认不出 provider', () => {
  test('S12 官方端点:开关与下拉都禁用,块内显示「当前是官方端点:自动档不受此开关影响。」', async ({ page }) => {
    await openAt(page, () => useOfficial());
    await expect(toggle(page)).toBeDisabled();
    await expect(modelSelect(page)).toBeDisabled();
    await expect(page.getByTestId('third-party-auto-official')).toHaveText(UI.OFFICIAL_NOTE);
  });

  test('S13 认不出当前 provider:下拉禁用并显示「未识别当前 provider,无法设置审核模型。」,开关仍可用', async ({ page }) => {
    await openAt(page, async () => useUnknownProvider());
    await expect(modelSelect(page)).toBeDisabled();
    await expect(tpSection(page)).toContainText(UI.UNKNOWN_PROVIDER_NOTE);
    await expect(toggle(page)).toBeEnabled();
  });
});
