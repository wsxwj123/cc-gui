// r151l 补验收(B4b / B5 / B6):判官指出的 3 处验收缺口里,前两处必须补、B6 可选。
// 只新增用例与 helpers/paging.mjs,不改 B1–B4 的任何既有断言。
//   B4b:先加载到 240 条再触发静默刷新 —— 覆盖"首屏 120 时 limit≥已加载恒真"的空转。
//   B5 :600 条连续加载 —— 覆盖 >400 条切回既有 30 行渐进挂载、入口消失、顶部提示。
//   B6 :加载更早的旧响应在切会话后落地 —— 覆盖旧响应丢弃(不混入另一个会话)。
// 2000 条上限不做 UI 用例(17 页太慢),由 tests/unit/check-r151l-history-page.mjs 覆盖,见报告。
import { test, expect } from '@playwright/test';
import { seedHistory, appendUserRecord, uniq } from './helpers/fixtures.mjs';
import { boot, openSessionBySearch, messageList, messageRows, loadOlderCandidates, watchHistoryRequests } from './helpers/ui.mjs';
import { waitFor, messageText } from './helpers/history.mjs';
import { clickLoadOlder, olderRequests, messagesPath, pagingFacts } from './helpers/paging.mjs';

test.describe.configure({ timeout: 240_000 });

const UI_READY = () => Boolean(process.env.R151L_UI_BASE);

/** 打开会话后等该会话的第一条历史请求落地(与 B1–B4 同口径)。 */
async function historyRequestsFor(page, reqs, sid) {
  await expect.poll(() => reqs.filter((r) => r.sid === sid).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  return reqs.filter((r) => r.sid === sid);
}

test('B4b 行为6 静默刷新合并:加载到 240 条后文件追加触发刷新,刷新 limit≥240、DOM 行不减少、第 181 条与第二批最旧一条都还在、追加消息可见', async ({ page }) => {
  test.skip(!UI_READY(), '需要 run.sh 起的共享实例 + dev server');
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const S = seedHistory(`b4b-${uniq('')}`, { count: 300 });
  const reqs = watchHistoryRequests(page);
  await boot(page);
  await openSessionBySearch(page, S.firstText, S.lastText);
  const initialReqs = await historyRequestsFor(page, reqs, S.sid);
  await expect(messageRows(page).first(), '首屏应有已挂载的消息行').toBeVisible({ timeout: 30_000 });
  await expect.poll(() => messageRows(page).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(100);
  const initialRows = await messageRows(page).count();

  // 先把已加载数从 120 抬到 240,否则"刷新 limit ≥ 已加载"在 120 上恒真 = 空转(判官缺口 1)。
  expect(await loadOlderCandidates(page).count(), '300 条会话首屏应有「加载更早」入口').toBeGreaterThan(0);
  const older = await clickLoadOlder(page, reqs, S.sid);
  expect(older.status, `第一次「加载更早」应 200(应答:${JSON.stringify(older.body)?.slice(0, 200)})`).toBe(200);
  expect(older.body?.messages?.length, '第一次「加载更早」应取回一页 120 条').toBe(120);
  await expect.poll(() => messageRows(page).count(), { timeout: 40_000 }).toBeGreaterThanOrEqual(240);
  await page.waitForTimeout(400);

  const loadedBeforeRefresh = await messageRows(page).count();
  // 第二批(60..179)的最旧一条:刷新若把旧前缀丢掉,它必然消失。
  const oldestOfNewPage = S.texts[60];
  // 第 181 条(index 180):属于首屏(180..299),判官要求的"更早的已加载消息仍在"。
  const message181 = S.texts[180];
  expect({
    loadedBeforeRefresh,
    oldestNewPageBefore: await messageList(page).getByText(oldestOfNewPage).count(),
    message181Before: await messageList(page).getByText(message181).count(),
  }, `刷新前 DOM ${loadedBeforeRefresh};第二批最旧 ${await messageList(page).getByText(oldestOfNewPage).count()};第181条 ${await messageList(page).getByText(message181).count()}`).toEqual({
    loadedBeforeRefresh: expect.any(Number),
    oldestNewPageBefore: 1,
    message181Before: 1,
  });

  const appendedText = appendUserRecord(S);
  const triggerAt = Date.now();
  await page.evaluate((sid) => {
    // 与 useWebSocket 的 file-change 分支派发同一个事件;共享实例已禁用文件监听,不依赖它。
    window.dispatchEvent(new CustomEvent('cgui:sessions-changed', { detail: { path: `/${sid}.jsonl` } }));
  }, S.sid);

  const refreshReq = await waitFor(() => reqs.find((r) => r.sid === S.sid && r.at >= triggerAt) ?? null, 30_000, 100);
  expect(refreshReq, `文件追加后应触发一次静默刷新请求(已记录:${reqs.filter((r) => r.sid === S.sid).map((r) => `${r.at}:${r.url}`).join(' | ')})`).toBeTruthy();
  await expect.poll(() => messageList(page).getByText(appendedText).count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);

  const refreshLimit = refreshReq?.params.limit ?? null;
  const afterCount = await messageRows(page).count();
  const oldestNewPageAfter = await messageList(page).getByText(oldestOfNewPage).count();
  const message181After = await messageList(page).getByText(message181).count();
  const appendedSeen = await messageList(page).getByText(appendedText).count();
  const initialLimit = initialReqs[0]?.params.limit ?? null;

  expect({
    initialLimit,
    initialPageInRange: initialRows >= 100 && initialRows <= 140,
    initialRows,
    loadedBeforeRefresh,
    refreshHasLimit: refreshLimit !== null,
    refreshLimitAtLeastLoaded: refreshLimit !== null && Number(refreshLimit) >= loadedBeforeRefresh,
    refreshLimit,
    afterCount,
    afterNotLess: afterCount >= loadedBeforeRefresh,
    oldestNewPageAfter,
    message181After,
    appendedSeen,
    pageErrors,
  }, `首屏 ${initialLimit};静默刷新 ${refreshReq?.url};刷新前 ${loadedBeforeRefresh} 行;刷新后 ${afterCount} 行;第二批最旧命中 ${oldestNewPageAfter};第181条命中 ${message181After};追加消息命中 ${appendedSeen};页面错误 ${JSON.stringify(pageErrors)}`).toEqual({
    initialLimit: '120',
    initialPageInRange: true,
    initialRows: expect.any(Number),
    loadedBeforeRefresh: expect.any(Number),
    refreshHasLimit: true,
    refreshLimitAtLeastLoaded: true,
    refreshLimit: expect.any(String),
    afterCount: expect.any(Number),
    afterNotLess: true,
    oldestNewPageAfter: 1,
    message181After: 1,
    appendedSeen: 1,
    pageErrors: [],
  });
});

test('B5 >400 条渐进挂载:600 条连续点「加载更早」四次全部生效,最后一次后入口消失、DOM 行数回落且顶部有"更早的 N 条"提示、无错误', async ({ page }) => {
  test.skip(!UI_READY(), '需要 run.sh 起的共享实例 + dev server');
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const S = seedHistory(`b5-${uniq('')}`, { count: 600 });
  const reqs = watchHistoryRequests(page);
  await boot(page);
  await openSessionBySearch(page, S.firstText, S.lastText);
  const initialReqs = await historyRequestsFor(page, reqs, S.sid);
  await expect(messageRows(page).first(), '首屏应有已挂载的消息行').toBeVisible({ timeout: 30_000 });
  await expect.poll(() => messageRows(page).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(100);
  const initialRows = await messageRows(page).count();
  const initialLimit = initialReqs[0]?.params.limit ?? null;

  // 600 条 = 首屏 120(480..599)+ 四页 120(360..479 / 240..359 / 120..239 / 0..119)。
  const clicks = [];
  const expectedBefores = [480, 360, 240, 120];
  for (let i = 0; i < expectedBefores.length; i += 1) {
    const expectedBefore = expectedBefores[i];
    expect(await loadOlderCandidates(page).count(), `第 ${i + 1} 次点击前应仍有「加载更早」入口`).toBeGreaterThan(0);
    const { request, body, status } = await clickLoadOlder(page, reqs, S.sid);
    const msgTexts = Array.isArray(body?.messages) ? body.messages.map(messageText) : [];
    clicks.push({
      status,
      before: request?.params.before ?? null,
      limit: request?.params.limit ?? null,
      fetched: msgTexts.length,
      first: msgTexts[0] ?? null,
      last: msgTexts[msgTexts.length - 1] ?? null,
      expectedFirst: S.texts[expectedBefore - 120],
      expectedLast: S.texts[expectedBefore - 1],
    });
    await page.waitForTimeout(300);
  }

  const afterClicks = await pagingFacts(page, { sid: S.sid, reqs });
  const afterRows = await messageRows(page).count();
  const placeholderOk = afterClicks.placeholderCount === 1 && /^更早的 \d+ 条消息尚未加载/.test(afterClicks.placeholderText || '');

  expect({
    initialLimit,
    initialRowsInRange: initialRows >= 100 && initialRows <= 140,
    initialRows,
    clicks,
    eachFetched120: clicks.every((c) => c.fetched === 120),
    eachBeforeExpected: clicks.map((c) => c.before).join(',') === expectedBefores.map((n) => String(n)).join(','),
    eachLimit120: clicks.every((c) => c.limit === '120'),
    eachWindowCorrect: clicks.every((c) => c.first === c.expectedFirst && c.last === c.expectedLast),
    eachStatus200: clicks.every((c) => c.status === 200),
    entryGoneAtEnd: afterClicks.entry === 0,
    rowCountInRange: afterRows >= 1 && afterRows <= 600,
    trimmedBelowFull: afterRows < 600,
    placeholderCount: afterClicks.placeholderCount,
    placeholderOk,
    placeholderText: afterClicks.placeholderText,
    capNotice: afterClicks.cap,
    pageErrors,
  }, `首屏 limit=${initialLimit} DOM=${initialRows};四页:${clicks.map((c) => `${c.status} before=${c.before} limit=${c.limit} n=${c.fetched} first=${c.first} last=${c.last}`).join(' | ')};最终入口 ${afterClicks.entry};DOM ${afterRows};占位 ${afterClicks.placeholderCount}「${afterClicks.placeholderText}」;上限提示 ${afterClicks.cap};页面错误 ${JSON.stringify(pageErrors)}`).toEqual({
    initialLimit: '120',
    initialRowsInRange: true,
    initialRows: expect.any(Number),
    clicks: expect.any(Array),
    eachFetched120: true,
    eachBeforeExpected: true,
    eachLimit120: true,
    eachWindowCorrect: true,
    eachStatus200: true,
    entryGoneAtEnd: true,
    rowCountInRange: true,
    trimmedBelowFull: true,
    placeholderCount: 1,
    placeholderOk: true,
    placeholderText: expect.any(String),
    capNotice: 0,
    pageErrors: [],
  });

  // 入口消失后不再能加载:再派发一次点击事件也不该发新请求(入口已不在 DOM)。
  const beforeClickCount = olderRequests(reqs, S.sid).length;
  await page.evaluate(() => {
    const btn = document.querySelector('[data-history-load-older] button');
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  expect(olderRequests(reqs, S.sid).length, '入口消失后不应再发出「加载更早」请求').toBe(beforeClickCount);
});

test('B6 (可选)旧响应丢弃:加载更早的请求在飞时切到另一个会话,旧响应落地不混入 B;切回 A 也不串、分页账从 120 重来', async ({ page }) => {
  test.skip(!UI_READY(), '需要 run.sh 起的共享实例 + dev server');
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const A = seedHistory(`b6a-${uniq('')}`, { count: 300 });
  const B = seedHistory(`b6b-${uniq('')}`, { count: 60 });
  const reqs = watchHistoryRequests(page);
  await boot(page);
  await openSessionBySearch(page, A.firstText, A.lastText);
  await historyRequestsFor(page, reqs, A.sid);
  await expect.poll(() => messageRows(page).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(100);
  const aInitialRows = await messageRows(page).count();
  const entry = loadOlderCandidates(page).first();
  expect(await loadOlderCandidates(page).count(), 'A(300 条)首屏应有「加载更早」入口').toBeGreaterThan(0);

  // 只延迟 A 的「加载更早」请求:让它在切到 B 之后才回来。
  let delayedSeen = false;
  await page.route('**/api/sessions/*/messages*', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === messagesPath(A.sid) && u.searchParams.has('before')) {
      delayedSeen = true;
      await new Promise((r) => setTimeout(r, 2_500));
    }
    await route.continue();
  });
  const staleResponseP = page.waitForResponse((res) => {
    try {
      const u = new URL(res.url());
      return u.pathname === messagesPath(A.sid) && u.searchParams.has('before');
    } catch { return false; }
  }, { timeout: 30_000 });
  await entry.dispatchEvent('click');
  await expect.poll(() => delayedSeen, { timeout: 10_000 }).toBe(true);

  // 请求在飞时切到 B。
  await openSessionBySearch(page, B.firstText, B.lastText);
  await expect.poll(() => messageRows(page).count(), { timeout: 30_000 }).toBe(60);
  const staleResponse = await staleResponseP;
  expect(staleResponse.status(), `A 的旧「加载更早」应答应 200`).toBe(200);
  await page.waitForTimeout(800);
  const bRows = await messageRows(page).count();
  const aLastLeakIntoB = await messageList(page).getByText(A.lastText).count();
  const aOldPageLeakIntoB = await messageList(page).getByText(A.texts[60]).count();
  const bLastInB = await messageList(page).getByText(B.lastText).count();

  // 再切回 A:旧响应不能把 A 的分页账留成 240(必须是新开的 120)。
  const backAt = Date.now();
  await openSessionBySearch(page, A.firstText, A.lastText);
  await expect.poll(() => messageRows(page).count(), { timeout: 30_000 }).toBe(120);
  const backReq = await waitFor(() => reqs.find((r) => r.sid === A.sid && r.at >= backAt) ?? null, 20_000, 100);
  const aRows = await messageRows(page).count();
  const aEntry = await loadOlderCandidates(page).count();
  const bLeakIntoA = await messageList(page).getByText(B.lastText).count();
  const aLastInA = await messageList(page).getByText(A.lastText).count();
  await page.unroute('**/api/sessions/*/messages*');

  expect({
    aInitialRowsInRange: aInitialRows >= 100 && aInitialRows <= 140,
    aInitialRows,
    bRowsAfterStale: bRows,
    bStillFull: bRows === 60,
    aLastLeakIntoB,
    aOldPageLeakIntoB,
    bLastInB,
    backLimit: backReq?.params.limit ?? null,
    backHasBefore: backReq ? backReq.params.before !== undefined : null,
    aRowsAfterBack: aRows,
    aEntryAfterBack: aEntry,
    bLeakIntoA,
    aLastInA,
    pageErrors,
  }, `A 首屏 ${aInitialRows};切 B 后 ${bRows} 行(B 末条命中 ${bLastInB};A 末条混入 ${aLastLeakIntoB};A 旧页混入 ${aOldPageLeakIntoB});切回 A 请求 ${backReq?.url};A 行 ${aRows};入口候选 ${aEntry};B 末条混入 A ${bLeakIntoA};A 末条命中 ${aLastInA};页面错误 ${JSON.stringify(pageErrors)}`).toEqual({
    aInitialRowsInRange: true,
    aInitialRows: expect.any(Number),
    bRowsAfterStale: 60,
    bStillFull: true,
    aLastLeakIntoB: 0,
    aOldPageLeakIntoB: 0,
    bLastInB: 1,
    backLimit: '120',
    backHasBefore: false,
    aRowsAfterBack: 120,
    aEntryAfterBack: 1,
    bLeakIntoA: 0,
    aLastInA: 1,
    pageErrors: [],
  });
});
