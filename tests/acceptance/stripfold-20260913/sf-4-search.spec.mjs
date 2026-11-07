// SF-4xx：搜索（窗内检索）与折叠内容的交互。
//
// 背景（INTERFACE §G / PLAN §5.1.2）：条带把可折段置 `hidden` 之后，`Range.getBoundingClientRect()`
// 在 hidden 子树里恒为 0×0，既有 paintActive 会把 rollTop 抬 `cr.top` 像素 —— 命中折叠内容
// **不得把视图顶跑** 就是这条的判据。
import { test, expect } from '@playwright/test';
import { MARKER_A, A } from './helpers/fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, stripSnapshot, scrollBox, runSearch, searchHits, stripRootOf,
} from './helpers/runtime.mjs';

/** 过程段折行标签（只存在于渲染里，不在数据里）——用来找"被折起来的那些段"。 */
const FOLDED_LABEL = '次工具调用';

test.beforeEach(async ({ page }) => { await primeOverlays(page); });

test('SF-404 展开态命中同一段文字，视图同样不得跳（r159 起过程块恒展开，只剩展开态）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  expect((await stripSnapshot(stripRootOf(page, A.midText))).state).toBe('open');

  const box = await scrollBox(page);
  await box.evaluate((el) => { el.scrollTop = Math.min(200, el.scrollHeight - el.clientHeight); });
  await page.waitForTimeout(300);
  const before = await box.evaluate((el) => el.scrollTop);
  await runSearch(page, FOLDED_LABEL);
  const hits = await searchHits(page);
  expect(hits && hits.total).toBeGreaterThanOrEqual(1);
  expect(Math.abs((await box.evaluate((el) => el.scrollTop)) - before), '展开态命中同样不得上跳').toBeLessThanOrEqual(1);
});
