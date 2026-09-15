// T-2xx · 点「终端」后，设置坞那个按钮不得变成"终端"（用户实报：图标变终端、提示写「当前:终端」、还点亮）。
//
// 为什么这是缺陷：终端按钮是顶栏的独立常驻开关，**不属于**设置坞（坞的按钮条里没有它）。
// 坞按钮代表"当前开着哪个坞面板"，终端不在其中 —— 所以终端开着时它应当保持"设置"身份。
//
// 观测锚点：坞按钮 [data-cgui="panel-dock"] [data-testid="panel-dock-toggle"]
//   · 文字子节点 = 它当前显示的名字（常态是"设置"）
//   · title 属性 = 同一句话的完整版
//   · class 里有没有 bg-accent-subtle = 是否点亮
//   · 里面那枚 svg 的 lucide-* 类名 = 显示的是哪枚图标（lucide-layout-grid / lucide-terminal）
import { test, expect } from '@playwright/test';
import { ensureFixtures } from './helpers/fixtures.mjs';
import { openApp, openSession, openDockRail, openPanel, dockIdentity, terminalToggle, closePanelTerminals, dismissOverlays } from './helpers/runtime.mjs';

const fx = ensureFixtures();

async function openSessionWithDock(page) {
  await openApp(page);
  await openSession(page, fx.markers.small);
  await dismissOverlays(page);
}

test.afterEach(async ({ page }) => {
  await closePanelTerminals(page).catch(() => {});
});

test('T-201 打开终端后，坞按钮仍是「设置」身份：不点亮、提示不含"当前:终端"、图标不是终端', async ({ page }) => {
  await openSessionWithDock(page);

  const before = await dockIdentity(page);
  expect(before.text, '前置：终端未打开时坞按钮显示"设置"').toBe('设置');
  expect(before.classes, '前置：终端未打开时坞按钮不点亮').not.toContain('bg-accent-subtle');

  await terminalToggle(page).click();
  // 终端面板真开了（有标签的关闭按钮）才算测到点上
  await expect(page.getByRole('button', { name: /关闭此标签/ }).first()).toBeVisible({ timeout: 20_000 });

  // 一次把四处偏差都列出来（只断言第一处的话，每次修完都还要再跑一轮才知道还有别处）
  const after = await dockIdentity(page);
  const problems = [];
  if (after.classes.includes('bg-accent-subtle')) problems.push(`坞按钮被点亮了：${after.classes}`);
  if (after.title.includes('当前:终端')) problems.push(`坞按钮提示写着"当前:终端"：${after.title}`);
  if (after.iconClass.includes('lucide-terminal')) problems.push(`坞按钮图标变成了终端图标：${after.iconClass}`);
  if (!after.iconClass.includes('lucide-layout-grid')) problems.push(`坞按钮图标没有回落成设置坞的宫格图标：${after.iconClass}`);
  if (after.text !== '设置') problems.push(`坞按钮文字不是"设置"：${after.text}`);
  expect(problems, `终端开着时，坞按钮的身份不对：\n- ${problems.join('\n- ')}`).toEqual([]);
});

test('T-202 打开坞内「文件」面板时，坞按钮仍正常显示面板身份（既有能力不许被改坏）', async ({ page }) => {
  await openSessionWithDock(page);
  await openPanel(page, '文件');
  const identity = await dockIdentity(page);
  expect(identity.title, '开了坞内面板，提示里应写出当前面板').toContain('当前:文件浏览器');
  expect(identity.classes, '开了坞内面板，坞按钮应点亮').toContain('bg-accent-subtle');
  expect(identity.iconClass, '图标应换成该面板的图标，不再是宫格').not.toContain('lucide-layout-grid');
  expect(identity.text).toBe('文件');
});

test('T-203 关掉终端后，坞按钮回到未点亮的「设置」身份', async ({ page }) => {
  await openSessionWithDock(page);

  await terminalToggle(page).click();
  await expect(page.getByRole('button', { name: /关闭此标签/ }).first()).toBeVisible({ timeout: 20_000 });
  await terminalToggle(page).click();    // 再点一次收起终端面板（shell 由 afterEach 收掉）

  await expect.poll(async () => (await dockIdentity(page)).title, { timeout: 20_000 })
    .not.toContain('当前:终端');
  const identity = await dockIdentity(page);
  expect(identity.classes).not.toContain('bg-accent-subtle');
  expect(identity.iconClass).toContain('lucide-layout-grid');
  expect(identity.text).toBe('设置');
});

test('T-204 坞的按钮条里本来就没有"终端"这一项（坞身份回落的前提）', async ({ page }) => {
  await openApp(page);
  await openDockRail(page);
  const rail = page.locator('span.cgui-dock-rail').first();
  await expect(rail.getByRole('button', { name: '文件', exact: true })).toBeVisible();
  expect(await rail.getByRole('button', { name: '终端', exact: true }).count(), '坞里不该有终端按钮').toBe(0);
});
