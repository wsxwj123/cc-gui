// r151l 历史消息分页 —— 前端按需加载验收。依据 .devflow/r151l-history-pagination-接口.md 行为 5、7
// 与行为 6(静默刷新)。
// B1–B4 在未修复代码上应因结果断言而红;短会话回归 B3 修复前应绿。
// 界面用例用 run.sh 起的共享实例 + dev server;每个用例在共享 HOME 里落自己的会话,互不串。
import { test, expect } from '@playwright/test';
import { seedHistory, appendUserRecord, uniq } from './helpers/fixtures.mjs';
import { boot, openSessionBySearch, messageList, messageRows, loadOlderCandidates, watchHistoryRequests } from './helpers/ui.mjs';
import { waitFor } from './helpers/history.mjs';

test.describe.configure({ timeout: 240_000 });

const UI_READY = () => Boolean(process.env.R151L_UI_BASE);

/** 打开会话后收集该会话已经发出的历史请求;等最后一屏消息出现后再取,避免和加载竞速。 */
async function historyRequestsFor(page, reqs, sid) {
  await expect.poll(() => reqs.filter((r) => r.sid === sid).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  return reqs.filter((r) => r.sid === sid);
}

test('B1 行为5 300 条历史打开:首屏只取 120 条、DOM 消息行≈120(±20)、顶部有含"更早"的加载入口', async ({ page }) => {
  test.skip(!UI_READY(), '需要 run.sh 起的共享实例 + dev server');
  const S = seedHistory(`b1-${uniq('')}`, { count: 300 });
  const reqs = watchHistoryRequests(page);
  await boot(page);
  await openSessionBySearch(page, S.firstText, S.lastText);
  const initialReqs = await historyRequestsFor(page, reqs, S.sid);
  await expect(messageRows(page).first(), '消息区应有已挂载的消息行').toBeVisible({ timeout: 30_000 });
  const count = await messageRows(page).count();
  const entryCount = await loadOlderCandidates(page).count();
  const limits = initialReqs.map((r) => r.params.limit ?? null);
  expect({
    initialReqCount: initialReqs.length,
    allInitialLimits120: limits.every((v) => v === '120'),
    limits,
    countInRange: count >= 100 && count <= 140,
    count,
    hasLoadOlderEntry: entryCount > 0,
    entryCount,
  }, `首屏历史请求:${initialReqs.map((r) => r.url).join(' | ')};DOM 消息行 ${count};入口候选 ${entryCount}`).toEqual({
    initialReqCount: expect.any(Number),
    allInitialLimits120: true,
    limits: expect.any(Array),
    countInRange: true,
    count: expect.any(Number),
    hasLoadOlderEntry: true,
    entryCount: expect.any(Number),
  });
});

test('B2 行为5 点「加载更早」两次:第一次 +≈120 且入口仍在;第二次到 300、入口消失、最早一条消息出现', async ({ page }) => {
  test.skip(!UI_READY(), '需要 run.sh 起的共享实例 + dev server');
  const S = seedHistory(`b2-${uniq('')}`, { count: 300 });
  const reqs = watchHistoryRequests(page);
  await boot(page);
  await openSessionBySearch(page, S.firstText, S.lastText);
  await historyRequestsFor(page, reqs, S.sid);
  await expect(messageRows(page).first(), '首屏应有已挂载的消息行').toBeVisible({ timeout: 30_000 });

  const before = await messageRows(page).count();
  const entryCount = await loadOlderCandidates(page).count();
  expect(entryCount, `首屏应出现可点击的「加载更早」入口(实际候选 ${entryCount};首屏消息行 ${before})`).toBeGreaterThan(0);

  await loadOlderCandidates(page).first().dispatchEvent('click');
  await expect.poll(() => messageRows(page).count(), { timeout: 40_000 }).toBeGreaterThan(before);
  // 加载中入口文案可能短暂变成 loading;等这一批落地再数(不在这里断言,失败统一落到下面的聚合断言)。
  await page.waitForTimeout(400);
  const afterFirst = await messageRows(page).count();
  const entryAfterFirst = await loadOlderCandidates(page).count();

  await loadOlderCandidates(page).first().dispatchEvent('click');
  await expect.poll(() => messageRows(page).count(), { timeout: 40_000 }).toBeGreaterThanOrEqual(300);
  await page.waitForTimeout(400);
  const afterSecond = await messageRows(page).count();
  const entryAfterSecond = await loadOlderCandidates(page).count();
  const firstSeen = await messageList(page).getByText(S.firstText).count();

  const delta = afterFirst - before;
  expect({
    before,
    deltaFirstLoad: delta,
    deltaInRange: delta >= 100 && delta <= 140,
    entryStillVisibleAfterFirst: entryAfterFirst > 0,
    afterSecond,
    entryGoneAfterSecond: entryAfterSecond === 0,
    earliestSeen: firstSeen > 0,
  }, `首屏 ${before};第一次后 ${afterFirst}(+${delta});入口候选 ${entryAfterFirst};第二次后 ${afterSecond};入口候选 ${entryAfterSecond};最早一条命中 ${firstSeen};首次请求 ${reqs.filter((r) => r.sid === S.sid).map((r) => r.url).join(' | ')}`).toEqual({
    before: expect.any(Number),
    deltaFirstLoad: expect.any(Number),
    deltaInRange: true,
    entryStillVisibleAfterFirst: true,
    afterSecond: 300,
    entryGoneAfterSecond: true,
    earliestSeen: true,
  });
});

test('B3 (旧行为)行为7 短会话(20 条)打开:不显示加载更早入口,DOM 消息行 = 全量 20', async ({ page }) => {
  test.skip(!UI_READY(), '需要 run.sh 起的共享实例 + dev server');
  const S = seedHistory(`b3-${uniq('')}`, { count: 20 });
  const reqs = watchHistoryRequests(page);
  await boot(page);
  await openSessionBySearch(page, S.firstText, S.lastText);
  await historyRequestsFor(page, reqs, S.sid);
  await expect(messageRows(page).first(), '短会话应有已挂载的消息行').toBeVisible({ timeout: 30_000 });

  const count = await messageRows(page).count();
  const entryCount = await loadOlderCandidates(page).count();
  const firstSeen = await messageList(page).getByText(S.firstText).count();
  expect({
    count,
    loadOlderEntries: entryCount,
    firstSeen: firstSeen > 0,
  }, `短会话 DOM 消息行 ${count};入口候选 ${entryCount};最早一条命中 ${firstSeen};请求 ${reqs.filter((r) => r.sid === S.sid).map((r) => r.url).join(' | ')}`).toEqual({
    count: 20,
    loadOlderEntries: 0,
    firstSeen: true,
  });
});

test('B4 行为6 静默刷新:300 条会话只加载首屏,文件追加触发刷新后已加载消息数不减少,刷新请求 limit ≥ 已加载条数', async ({ page }) => {
  test.skip(!UI_READY(), '需要 run.sh 起的共享实例 + dev server');
  const S = seedHistory(`b4-${uniq('')}`, { count: 300 });
  const reqs = watchHistoryRequests(page);
  await boot(page);
  await openSessionBySearch(page, S.firstText, S.lastText);
  const initialReqs = await historyRequestsFor(page, reqs, S.sid);
  await expect(messageRows(page).first(), '首屏应有已挂载的消息行').toBeVisible({ timeout: 30_000 });

  const firstReq = initialReqs[0];
  const beforeCount = await messageRows(page).count();
  const beforeLimit = firstReq.params.limit ?? null;
  const appendedText = appendUserRecord(S);
  const triggerAt = Date.now();
  await page.evaluate((sid) => {
    // 与 useWebSocket 收到 file-change 后派发的是同一个事件;不依赖被禁用的文件监听。
    window.dispatchEvent(new CustomEvent('cgui:sessions-changed', { detail: { path: `/${sid}.jsonl` } }));
  }, S.sid);

  const refreshReq = await waitFor(() => reqs.find((r) => r.sid === S.sid && r.at >= triggerAt) ?? null, 30_000, 100);
  expect(refreshReq, `文件追加后应触发一次静默刷新请求(已记录的请求:${reqs.map((r) => `${r.at}:${r.url}`).join(' | ')})`).toBeTruthy();
  await page.waitForTimeout(800);
  const afterCount = await messageRows(page).count();
  const refreshLimit = refreshReq?.params.limit ?? null;
  const appendedSeen = await messageList(page).getByText(appendedText).count();

  expect({
    firstLimit: beforeLimit,
    firstPageInRange: beforeCount >= 100 && beforeCount <= 140,
    beforeCount,
    refreshHasLimit: refreshLimit !== null,
    refreshLimitAtLeastLoaded: Number(refreshLimit) >= beforeCount,
    refreshLimit,
    afterCount,
    afterNotLess: afterCount >= beforeCount,
    appendedSeen: appendedSeen > 0,
  }, `首屏请求 ${firstReq.url};静默刷新请求 ${refreshReq?.url};刷新前消息行 ${beforeCount};刷新后 ${afterCount};追加消息命中 ${appendedSeen}`).toEqual({
    firstLimit: '120',
    firstPageInRange: true,
    beforeCount: expect.any(Number),
    refreshHasLimit: true,
    refreshLimitAtLeastLoaded: true,
    refreshLimit: expect.any(String),
    afterCount: expect.any(Number),
    afterNotLess: true,
    appendedSeen: true,
  });
});
