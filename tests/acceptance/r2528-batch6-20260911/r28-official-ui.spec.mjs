// R28 —— 额度卡在 UI 上的可理解状态（UI 面）
//
// 合同来源：.devflow/INTERFACE.md R28 第三条：
//   「临时失败有同账户旧值则status=stale并标更新时间/原因，无旧值显示“额度暂不可用”，
//     保留“在官方CLI查看 /usage”的用户入口；这不构成真实订阅API替代已完成。
//     额度卡未有验证替代前不能被直接删除或写死全不可用后报R28通过。」
//
// 合同没有规定这块内容落在哪个面板；本套件在“用量”面板打开后按全页文本查找，落点变化时按
// README「合同歧义」调整定位，不假定组件结构。
import { test, expect } from '@playwright/test';
import * as rt from './helpers/r2528-runtime.mjs';

async function openUsagePanel(page) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await rt.dismissTransientOverlays(page);

  // 面板坞在会话视图里才展开；先用侧栏搜索开一个夹具会话（与真实用户路径一致）。
  const session = rt.fixtureSection('historySession');
  await rt.openFixtureSession(page, session);

  const settings = page.getByRole('button', { name: /^设置/ }).first();
  if (await settings.count()) await rt.clickThroughOverlays(page, settings);
  const usage = page.getByRole('button', { name: '用量', exact: true }).first();
  await expect(usage, '顶栏面板坞必须提供「用量」面板').toBeVisible();
  await rt.clickThroughOverlays(page, usage);
  await page.waitForTimeout(2_000); // 让面板完成它自己的额度查询（契约允许 60 秒缓存）
}

test.describe('R28 额度卡 UI', () => {
  test('R28-21 额度区仍然存在（反向护栏：不得在修复中删卡）', async ({ page }) => {
    rt.getRuntime({ requireManifest: true });
    await openUsagePanel(page);

    const quotaArea = page.getByText(/额度/).first();
    await expect(quotaArea, 'R28-21 用量面板必须仍有一个额度区（本轮不得直接删卡）').toBeVisible();
    const lines = (await page.evaluate(() => document.body.innerText)).split('\n');
    const at = lines.findIndex(line => /额度/.test(line));
    const context = lines.slice(at, at + 3).join(' ');
    expect(context, `R28-21 额度区必须给出具体状态（可用/失败/不可用/过期/刷新/百分比），不是空壳：${context}`)
      .toMatch(/可用|失败|不可用|过期|刷新|重置|%/);
  });

  test('R28-22 无旧值时显示「额度暂不可用」', async ({ page }) => {
    rt.getRuntime({ requireManifest: true });
    await openUsagePanel(page);

    await expect(page.getByText(/额度暂不可用/).first(),
      'R28-22 无旧值时必须显示契约文案「额度暂不可用」（不是 0、不是空白）').toBeVisible({ timeout: 10_000 });
  });

  test('R28-23 保留「在官方CLI查看 /usage」的用户入口', async ({ page }) => {
    rt.getRuntime({ requireManifest: true });
    await openUsagePanel(page);

    const entry = page.getByText(/\/usage/).first();
    await expect(entry, 'R28-23 必须保留在官方 CLI 查看 /usage 的用户入口').toBeVisible({ timeout: 10_000 });
    const clickable = await entry.evaluate(node => Boolean(node.closest('button,a,[role=button]'))).catch(() => false);
    expect(clickable, 'R28-23 该文案必须是可点的用户入口').toBe(true);
  });
});
