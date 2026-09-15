// SF-4xx：搜索（窗内检索）与折叠内容的交互。
//
// 背景（INTERFACE §G / PLAN §5.1.2）：条带把可折段置 `hidden` 之后，`Range.getBoundingClientRect()`
// 在 hidden 子树里恒为 0×0，既有 paintActive 会把 rollTop 抬 `cr.top` 像素 —— 命中折叠内容
// **不得把视图顶跑** 就是这条的判据。
import { test, expect } from '@playwright/test';
import { MARKER_A, A } from './helpers/fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, turnRows, stripSnapshot, scrollBox, runSearch,
  searchHits, closeSearch, stripRootOf,
} from './helpers/runtime.mjs';

/** 过程段折行标签（只存在于渲染里，不在数据里）——用来找"被折起来的那些段"。 */
const FOLDED_LABEL = '次工具调用';

test.beforeEach(async ({ page }) => { await primeOverlays(page); });

test('SF-401 命中折叠段里的内容：不得把视图顶跑', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);

  // 前置：这句话确实落在"被折起来的"段里（否则这条用例什么也没测到）
  const folded = page.locator('[data-strip-item="group"][hidden]').filter({ hasText: FOLDED_LABEL }).first();
  await expect(folded, '前置：被折段里应当有可被搜索命中的文字').toHaveCount(1);
  expect(await folded.count()).toBe(1);

  const box = await scrollBox(page);
  await box.evaluate((el) => { el.scrollTop = Math.min(200, el.scrollHeight - el.clientHeight); });
  await page.waitForTimeout(300);
  const before = await box.evaluate((el) => el.scrollTop);

  await runSearch(page, FOLDED_LABEL);
  const hits = await searchHits(page);
  console.log('[SF-401] 命中 =', JSON.stringify(hits));
  expect(hits && hits.total, '命中折叠内容的文字至少要有 1 条命中').toBeGreaterThanOrEqual(1);
  const after = await box.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before), `命中折叠内容后视图不得无故上跳（${before} → ${after}）`).toBeLessThanOrEqual(1);
});

test('SF-402 命中摘要行自己的文字：要能命中，且不上跳', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  const box = await scrollBox(page);
  await box.evaluate((el) => { el.scrollTop = Math.min(200, el.scrollHeight - el.clientHeight); });
  await page.waitForTimeout(300);
  const before = await box.evaluate((el) => el.scrollTop);

  // 摘要行的前缀文字是新引入的可见文字（J4 的改写版：不是"过程内容可搜"）
  await runSearch(page, '思考与工具调用');
  const hits = await searchHits(page);
  console.log('[SF-402] 命中 =', JSON.stringify(hits));
  expect(hits && hits.total, '摘要行文字必须可被搜索命中').toBeGreaterThanOrEqual(1);
  const after = await box.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before), '命中摘要行不得把视图顶跑').toBeLessThanOrEqual(1);
  await closeSearch(page);
});

test('SF-403【P9 待定】命中折叠段时是否自动展开：只记事实，两面不写死', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  const box = await scrollBox(page);
  await box.evaluate((el) => { el.scrollTop = Math.min(200, el.scrollHeight - el.clientHeight); });
  await page.waitForTimeout(300);
  const before = await box.evaluate((el) => el.scrollTop);

  await runSearch(page, FOLDED_LABEL);
  const hits = await searchHits(page);
  expect(hits && hits.total).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(500);

  // 记录"命中之后这一轮是什么状态"（P9 未拍板：自动展开 / 不自动展开 都合规）
  const roots = page.locator('[data-strip-root]');
  const states = await roots.evaluateAll((els) => els.map((e) => e.getAttribute('data-strip-state')));
  console.log('[SF-403] P9 事实：命中后各轮状态 =', JSON.stringify(states));
  test.info().annotations.push({ type: 'P9-pending', description: `命中折叠段后各轮状态 = ${JSON.stringify(states)}` });

  // 无论走哪一面，这两条都必须成立：
  //   ① 视图不许被顶跑；② 条带状态必须是一个合法值（不许出现 undefined/空）
  expect(Math.abs((await box.evaluate((el) => el.scrollTop)) - before), '命中后视图不得上跳（与 P9 取值无关）').toBeLessThanOrEqual(1);
  for (const s of states) expect(['open', 'closed', 'none'], `条带状态必须是合法值，实际 ${s}`).toContain(s);
});

test('SF-404 展开之后命中同一段文字，视图同样不得跳（开合两态都不许盲跳）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  await turnRows(page).first().locator('[data-strip="head"]').click();
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
