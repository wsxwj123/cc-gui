// T-3xx · 生图面板点「清空」后，切到别的面板再切回来，图片预览不得复现
//（用户实报：清空后提示词和预览都清了，切走再切回，预览又自己冒出来）。
//
// 观测锚点：面板里指向 /api/image/preview 的**可见** <img> 个数。
//   1 = 正在显示上一张完成图；0 = 预览已收起。
//   （面板里另有一张藏在"任务列表"折叠区里的同款图，显示与否用 :visible 区分，不会被它干扰。）
//
// 夹具：一条 status=done 的出图历史 + 一张真实 PNG + 一个生图 provider 配置
//（历史是服务端持久化的，面板重开会重新拉它 —— 这正是"切回来又出现"的现场）。
import { test, expect } from '@playwright/test';
import { ensureFixtures } from './helpers/fixtures.mjs';
import { getRuntime, openApp, openPanel, openDockRail, dismissOverlays } from './helpers/runtime.mjs';

const fx = ensureFixtures();
const previewImages = (page) => page.locator('img[src*="/api/image/preview"]:visible');
/** 含"任务列表"折叠区里那张藏起来的同款图 —— 它出现 = 历史已经拉回来并渲染完了。 */
const anyPreviewImage = (page) => page.locator('img[src*="/api/image/preview"]');

async function openImagePanel(page) {
  const { baseURL } = getRuntime();
  await openApp(page);
  await dismissOverlays(page);
  await openPanel(page, '生图');
  // 前置：夹具那张已完成图必须真的显示出来（否则这条用例什么也没测到）
  await expect(previewImages(page).first()).toBeVisible({ timeout: 20_000 });
  expect(await previewImages(page).count(), '前置：面板里应正好显示 1 张预览图').toBe(1);
  return { baseURL };
}

test('T-301 清空后切走再切回，图片预览不得复现', async ({ page }) => {
  await openImagePanel(page);

  await page.getByRole('button', { name: /清空/ }).first().click();
  await expect.poll(async () => await previewImages(page).count(), {
    timeout: 10_000, message: '点了清空，预览应当立刻收起',
  }).toBe(0);

  await openDockRail(page);
  await openPanel(page, '文件');
  await openPanel(page, '生图');

  // 判"没复现"之前先等一个正向信号：历史已经拉回来并渲染完（折叠区那张图出现）。
  // 有了它才谈得上"预览本该出现却没有"，不是趁面板还没加载完抢答。
  await expect.poll(async () => await anyPreviewImage(page).count(), {
    timeout: 20_000, message: '切回来后生图历史应当重新拉回来（前置信号）',
  }).toBeGreaterThan(0);

  const count = await previewImages(page).count();
  const src = count ? await previewImages(page).first().getAttribute('src') : null;
  expect(count, `切面板再切回来后，预览图又出现了 ${count} 张（${String(src).slice(0, 80)}…）—— 清空应当保持生效`).toBe(0);
});

test('T-302 没点过清空时，切走再切回仍显示最近一张完成图（既有特性不许打掉）', async ({ page }) => {
  await openImagePanel(page);

  await openDockRail(page);
  await openPanel(page, '文件');
  await openPanel(page, '生图');

  await expect.poll(async () => await previewImages(page).count(), {
    timeout: 20_000, message: '没点清空时，切回来应当照旧显示最近一张完成图',
  }).toBe(1);
});

test('T-303 清空后连续换两次面板再回来，预览仍不得复现（重复切换也一样）', async ({ page }) => {
  await openImagePanel(page);
  await page.getByRole('button', { name: /清空/ }).first().click();
  await expect.poll(async () => await previewImages(page).count(), { timeout: 10_000 }).toBe(0);

  await openDockRail(page);
  await openPanel(page, '文件');
  await openPanel(page, '生图');
  await openPanel(page, '通用');
  await openPanel(page, '生图');
  await expect.poll(async () => await anyPreviewImage(page).count(), { timeout: 20_000 }).toBeGreaterThan(0);

  expect(await previewImages(page).count(), '换了两轮面板回来，预览仍必须是清空态').toBe(0);
});
