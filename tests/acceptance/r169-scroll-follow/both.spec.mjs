// S01~S02：Chromium 与 WebKit 各跑一次（同一个文件被两个 Playwright 项目各吃一遍，用例名后面会带项目名）。
// 这两条是"复现"用例：当前代码上消息区变高后不再跟随，应当红。
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';
import {
  boot, ensureRow, openAndWait, openSplitAC, focusPane, sleep, freshState, finishRounds, restoreViewport,
  sendAndWaitRunning, ensureAtBottom, watchUntilStopGone, expectFollowing,
} from './helpers/app.mjs';

test.describe.configure({ timeout: 240_000 });
test.beforeEach(() => { freshState(); });
test.afterEach(async ({ page }) => { await finishRounds(); await restoreViewport(page); });

test('S01 单窗格：回复进行中、停在底部，发送 3 秒后视口从 1500×1000 变成 1500×1150，之后到停止键消失一直跟随', async ({ page }) => {
  await boot(page);
  await ensureRow(page, 'A');
  await openAndWait(page, 'A');
  const tSend = await sendAndWaitRunning(page, null, `${SESSIONS.A.beg} S01 请开始一段长回复`);
  await ensureAtBottom(page, null);
  await sleep(Math.max(0, 3_000 - (Date.now() - tSend)));
  await page.setViewportSize({ width: 1500, height: 1150 });
  const samples = await watchUntilStopGone(page, null);
  expectFollowing(samples, 'S01 视口变高之后');
});

test('S02 分屏（左 A 右 C）：右窗格发消息，3 秒后点左窗格输入框再把视口变高，右窗格到停止键消失一直跟随', async ({ page }) => {
  await openSplitAC(page);
  await focusPane(page, 1);
  const tSend = await sendAndWaitRunning(page, 1, `${SESSIONS.C.beg} S02 请开始一段长回复`);
  await ensureAtBottom(page, 1);
  await sleep(Math.max(0, 3_000 - (Date.now() - tSend)));
  await focusPane(page, 0);
  await page.setViewportSize({ width: 1500, height: 1150 });
  const samples = await watchUntilStopGone(page, 1);
  expectFollowing(samples, 'S02 右窗格（非当前窗格）视口变高之后');
});
