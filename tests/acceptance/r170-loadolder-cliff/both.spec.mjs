// 行为 1 与行为 4(复现用例):WebKit 与 Chromium 各跑一次 = 行为 5(同一个文件被两个 Playwright 项目各吃一遍)。
// 修复前这两条必须因断言失败而红。每条自己造会话、自己摆场景,互不依赖。
import { test, expect } from '@playwright/test';
import {
  openFixture, clickLoadOlderAtTop, clickAndTrackFirstRow, wheelDownTo, metricsOrFail, firstVisibleRow,
  rowDist, rowCount, placeholderFacts, appendAndRefresh, sleep,
} from './helpers/ui.mjs';

test.describe.configure({ timeout: 300_000 });

test('行为1 看历史期间点第3次「加载更早」:眼前那条消息留在原位(偏差≤4px),共480行,无提示行', async ({ page }) => {
  const { errors } = await openFixture(page, 'b1');
  await clickLoadOlderAtTop(page);
  await clickLoadOlderAtTop(page);
  expect(await rowCount(page), '前置:点 2 次入口后应已加载 360 条').toBe(360);
  const { before, afterDist } = await clickAndTrackFirstRow(page);
  const rowsAfter = await rowCount(page);
  const ph = await placeholderFacts(page);
  const shift = afterDist === null ? null : Math.abs(afterDist - before.dist);
  const facts = {
    mStillOnPage: afterDist !== null,
    shiftWithin4px: shift !== null && shift <= 4,
    rowsAfter,
    placeholderMarked: ph.marked,
    placeholderByText: ph.byText,
    pageErrors: errors,
  };
  expect(facts, `M=${before.uuid}「${before.text}」点击前距顶 ${before.dist.toFixed(1)}px,点击后 ${afterDist === null ? '已不在页面上' : `${afterDist.toFixed(1)}px(偏差 ${shift.toFixed(1)}px)`};行数 ${rowsAfter};提示行 ${JSON.stringify(ph)}`).toEqual({
    mStillOnPage: true, shiftWithin4px: true, rowsAfter: 480, placeholderMarked: 0, placeholderByText: 0, pageErrors: [],
  });
});

test('行为4 看历史停在中间时会话追加60条并刷新:眼前那条消息留在原位(偏差≤4px),行数不少于追加前', async ({ page }) => {
  const { S, errors } = await openFixture(page, 'b4');
  await clickLoadOlderAtTop(page);
  await clickLoadOlderAtTop(page);
  expect(await rowCount(page), '前置:点 2 次入口后应已加载 360 条').toBe(360);
  const m0 = await metricsOrFail(page);
  await wheelDownTo(page, Math.floor((m0.sh - m0.ch) / 2));
  await sleep(600);
  const mid = await metricsOrFail(page);
  expect(mid.top, `前置:应停在中间,不在顶部一屏以内(scrollTop ${mid.top.toFixed(0)},一屏 ${mid.ch})`).toBeGreaterThan(mid.ch);
  expect(mid.dist, `前置:应停在中间,不在底部(离底 ${mid.dist.toFixed(0)}px)`).toBeGreaterThan(mid.ch);
  const before = await firstVisibleRow(page);
  expect(before, '前置:停住后视口里应有消息行').not.toBeNull();
  const rowsBefore = await rowCount(page);

  await appendAndRefresh(page, S, 60);

  const afterDist = await rowDist(page, before.uuid);
  const rowsAfter = await rowCount(page);
  const shift = afterDist === null ? null : Math.abs(afterDist - before.dist);
  const facts = { mStillOnPage: afterDist !== null, shiftWithin4px: shift !== null && shift <= 4, rowsNotLess: rowsAfter >= rowsBefore, pageErrors: errors };
  expect(facts, `M=${before.uuid}「${before.text}」刷新前距顶 ${before.dist.toFixed(1)}px,刷新后 ${afterDist === null ? '已不在页面上' : `${afterDist.toFixed(1)}px(偏差 ${shift.toFixed(1)}px)`};行数 ${rowsBefore} → ${rowsAfter}`).toEqual({
    mStillOnPage: true, shiftWithin4px: true, rowsNotLess: true, pageErrors: [],
  });
});
