// G 组:权限档选择器(INTERFACE Y.3.4 "权限档选择器")。真实界面(dev server 源码直出)+ 隔离实例。
import { test, expect } from '@playwright/test';
import { useProvider, useOfficial, useUnknownProvider, tpAutoOn, tpAutoOff, resetOverrides, setTpAuto, snapshot, SETTINGS } from './helpers/api.mjs';
import { boot, openFreshSession, readOptions, autoOption, openSelector, closeSelector } from './helpers/ui.mjs';
import { UI, OFFICIAL_OPTION_TITLES_BEFORE, MODE_OF_TITLE } from './helpers/texts.mjs';
import { provider } from './helpers/scenes.mjs';
import fs from 'node:fs';

let saved = {};
test.beforeEach(async () => { saved = snapshot([SETTINGS()]); await tpAutoOff(); resetOverrides({}); });
test.afterEach(async () => { for (const [p, c] of Object.entries(saved)) if (c !== null) fs.writeFileSync(p, c); });

const auditLine = (page) => page.locator('[role="listbox"] [data-testid="auto-audit-model"]');

test('G1 第三方 + 开关关:每个选项都带 data-mode,其中没有 data-mode="auto"', async ({ page }) => {
  await useProvider(await provider('main'));
  await boot(page);
  await openFreshSession(page, 'g1');
  const opts = await readOptions(page);
  expect(opts.length, '应有若干选项').toBeGreaterThan(0);
  for (const o of opts) expect(o.mode, `选项「${o.title}」应带 data-mode`).not.toBeNull();
  expect(opts.map((o) => o.mode)).not.toContain('auto');
});

test('G2 第三方 + 开关开:出现 data-mode="auto" 选项,说明文字逐字为第三方版本', async ({ page }) => {
  await useProvider(await provider('main'));
  await tpAutoOn();
  await boot(page);
  await openFreshSession(page, 'g2');
  await openSelector(page);
  await expect(autoOption(page)).toHaveCount(1);
  await expect(autoOption(page)).toContainText(UI.AUTO_DESC);
});

test('G2b 第三方 + 开关开 + 显式设了 sonnet 档:自动档下有一行「审核模型:<名字>」', async ({ page }) => {
  await useProvider(await provider('sonnet'));
  await tpAutoOn();
  await boot(page);
  await openFreshSession(page, 'g2b');
  await openSelector(page);
  await expect(auditLine(page)).toHaveText(UI.auditModelLine('r151-reasoner'));
});

test('G3 第三方 + 开关开 + 没单独设(来源 default):显示「审核模型:<默认模型>(未单独设置)」', async ({ page }) => {
  await useProvider(await provider('main'));
  await tpAutoOn();
  await boot(page);
  await openFreshSession(page, 'g3');
  await openSelector(page);
  await expect(auditLine(page)).toHaveText(UI.auditModelDefaultLine('r151-chat'));
});

test('G4 第三方 + 开关开 + 审核模型为 null:显示「审核模型:未知」', async ({ page }) => {
  await useProvider(await provider('nodef'));
  await tpAutoOn();
  await boot(page);
  await openFreshSession(page, 'g4');
  await openSelector(page);
  await expect(auditLine(page)).toHaveText(UI.AUDIT_MODEL_UNKNOWN);
});

test('G5 第三方 + 开关开 + 本地记了"tp:<providerId>|<模型>"不可用:没有自动档', async ({ page }) => {
  const id = await provider('main');
  await useProvider(id);
  await tpAutoOn();
  await boot(page, { 'cgui-auto-unavailable': JSON.stringify({ [`tp:${id}|r151-chat`]: true }) });
  await openFreshSession(page, 'g5');
  const opts = await readOptions(page);
  expect(opts.every((o) => o.mode !== null), '选项应带 data-mode').toBe(true);
  expect(opts.map((o) => o.mode)).not.toContain('auto');
});

test('G5c 不可用标记按 provider 区分:别的 provider 的同名模型被记不可用,当前 provider 仍有自动档', async ({ page }) => {
  const id = await provider('main');
  const other = await provider('other');
  await useProvider(id);
  await tpAutoOn();
  await boot(page, { 'cgui-auto-unavailable': JSON.stringify({ [`tp:${other}|r151-chat`]: true }) });
  await openFreshSession(page, 'g5c');
  await openSelector(page);
  await expect(autoOption(page)).toHaveCount(1);
});

test('G5d 认不出 provider 时按 "tp:unknown|<模型>" 记:记了就没有自动档', async ({ page }) => {
  useUnknownProvider();
  await tpAutoOn();
  await boot(page, { 'cgui-auto-unavailable': JSON.stringify({ 'tp:unknown|r151-chat': true }) });
  await openFreshSession(page, 'g5d');
  const opts = await readOptions(page);
  expect(opts.every((o) => o.mode !== null), '选项应带 data-mode').toBe(true);
  expect(opts.map((o) => o.mode)).not.toContain('auto');
});

test('G5e 认不出 provider + 开关开 + 没被记不可用:有自动档', async ({ page }) => {
  useUnknownProvider();
  await tpAutoOn();
  await boot(page);
  await openFreshSession(page, 'g5e');
  await openSelector(page);
  await expect(autoOption(page)).toHaveCount(1);
});

test('G6 官方:选项集合与改动前相同(同样 6 个、同样顺序),且每项的 data-mode 与档位对应', async ({ page }) => {
  await useOfficial();
  await boot(page);
  await openFreshSession(page, 'g6');
  const opts = await readOptions(page);
  expect(opts.map((o) => o.title)).toEqual(OFFICIAL_OPTION_TITLES_BEFORE);
  expect(opts.map((o) => o.mode)).toEqual(OFFICIAL_OPTION_TITLES_BEFORE.map((t) => MODE_OF_TITLE[t]));
});

test('G6b 官方:自动档说明文字与改动前相同,也没有「审核模型」那一行', async ({ page }) => {
  await useOfficial();
  await boot(page);
  await openFreshSession(page, 'g6b');
  const opts = await readOptions(page);
  const auto = opts.find((o) => o.title === '自动');
  expect(auto, '官方下应有自动档').toBeTruthy();
  expect(auto.text).toContain('由后台安全分类器逐动作审查，通过即执行、有风险才询问；少弹窗但非零风险');
  await expect(page.locator('[role="listbox"] [data-testid="auto-audit-model"]')).toHaveCount(0);
});

test('G8 不刷新页面:总开关被打开后(WS 广播),再打开选择器就出现自动档', async ({ page }) => {
  await useProvider(await provider('main'));
  await boot(page);
  await openFreshSession(page, 'g8');
  await openSelector(page);
  await expect(page.locator('[role="listbox"] [role="option"]').first()).toBeVisible();
  await closeSelector(page);
  const r = await setTpAuto(true);
  expect(r.status, '前置:打开开关').toBe(200);
  await expect(async () => {
    await openSelector(page);
    await expect(autoOption(page)).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
});

test('G9 不刷新页面:从官方切到第三方(开关关)后,选择器里的自动档消失', async ({ page }) => {
  await useOfficial();
  await boot(page);
  await openFreshSession(page, 'g9');
  const before = await readOptions(page);
  expect(before.map((o) => o.title), '前置:官方下有自动档').toContain('自动');
  await closeSelector(page);
  await useProvider(await provider('main'));
  await expect(async () => {
    const opts = await readOptions(page);
    await closeSelector(page);
    expect(opts.every((o) => o.mode !== null)).toBe(true);
    expect(opts.map((o) => o.mode)).not.toContain('auto');
  }).toPass({ timeout: 15_000 });
});
