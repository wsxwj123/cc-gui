import { expect, test } from '@playwright/test';
import {
  FIXTURE,
  bannerParts,
  dragSidebar,
  expectBannerFits,
  openNamedSession,
  setUiZoom,
} from './session-interactions.fixture';

test.describe('未初始化 Git 横幅', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await openNamedSession(page, FIXTURE.nonGitProject);
  });

  test('正文逐字等于指定文案', async ({ page }) => {
    const { text } = await bannerParts(page);
    await expect(text).toHaveText('本文件夹未git初始化');
  });

  test('宽侧栏中正文在上且两个按钮在下方同排', async ({ page }) => {
    await dragSidebar(page, 380);
    const { text, initialize, ignore } = await bannerParts(page);
    const [textBox, initializeBox, ignoreBox] = await Promise.all([
      text.boundingBox(),
      initialize.boundingBox(),
      ignore.boundingBox(),
    ]);
    expect(textBox && initializeBox && ignoreBox).toBeTruthy();
    expect(initializeBox!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height - 1);
    expect(Math.abs(initializeBox!.y - ignoreBox!.y)).toBeLessThanOrEqual(1);
    expect(initializeBox!.x + initializeBox!.width).toBeLessThanOrEqual(ignoreBox!.x + 1);
  });

  test('窄侧栏中按钮纵排且均在正文下方', async ({ page }) => {
    await dragSidebar(page, 205);
    const { text, initialize, ignore } = await bannerParts(page);
    const [textBox, initializeBox, ignoreBox] = await Promise.all([
      text.boundingBox(),
      initialize.boundingBox(),
      ignore.boundingBox(),
    ]);
    expect(textBox && initializeBox && ignoreBox).toBeTruthy();
    expect(initializeBox!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height - 1);
    expect(ignoreBox!.y).toBeGreaterThanOrEqual(initializeBox!.y + initializeBox!.height - 1);
  });

  for (const zoom of [0.8, 1, 1.25, 1.5]) {
    test(`最窄侧栏在 ${Math.round(zoom * 100)}% zoom 下无横溢出、裁切或逐字竖排`, async ({ page }) => {
      await dragSidebar(page, 205);
      await setUiZoom(page, zoom);
      const { banner, text, initialize, ignore } = await bannerParts(page);
      await expectBannerFits(banner, text);
      await expect(initialize).toBeInViewport();
      await expect(ignore).toBeInViewport();
    });
  }

  test('点击本会话忽略后横幅在当前会话消失', async ({ page }) => {
    const { ignore, text } = await bannerParts(page);
    await ignore.click();
    await expect(text).toBeHidden();
  });

  test('点击立即初始化后横幅在合成临时项目中消失', async ({ page }) => {
    const { initialize, text } = await bannerParts(page);
    await initialize.click();
    await expect(text).toBeHidden();
  });
});
