// 行为 2、3(复现,修复前应红)与行为 6、7、8(相邻回归,修复前后都应绿)。只跑 WebKit。
// 每条自己造 600 条会话、自己摆场景;"接 N 的状态"都由用例自己从头点出来,不依赖别的用例。
import { test, expect } from '@playwright/test';
import {
  openFixture, clickLoadOlderAtTop, clickAndTrackFirstRow, wheelUpUntilStuck, metricsOrFail, backBtn, entry,
  rowCount, textInView, appendAndRefresh, sleep,
} from './helpers/ui.mjs';

test.describe.configure({ timeout: 300_000 });

/** 点 n 次「加载更早」(每次点之前先翻到顶)。 */
async function clickTimes(page, n) {
  for (let i = 0; i < n; i += 1) await clickLoadOlderAtTop(page);
}

test('行为2 看历史期间点第4次(最后一次)「加载更早」:眼前那条消息留在原位(偏差≤4px),共600行,入口消失,无页面错误', async ({ page }) => {
  const { errors } = await openFixture(page, 'b2');
  await clickTimes(page, 3);
  const { before, afterDist } = await clickAndTrackFirstRow(page);
  const rowsAfter = await rowCount(page);
  const entryAfter = await entry(page).count();
  const shift = afterDist === null ? null : Math.abs(afterDist - before.dist);
  const facts = { mStillOnPage: afterDist !== null, shiftWithin4px: shift !== null && shift <= 4, rowsAfter, entryAfter, pageErrors: errors };
  expect(facts, `M=${before.uuid}「${before.text}」点击前距顶 ${before.dist.toFixed(1)}px,点击后 ${afterDist === null ? '已不在页面上' : `${afterDist.toFixed(1)}px(偏差 ${shift.toFixed(1)}px)`};行数 ${rowsAfter};入口 ${entryAfter}`).toEqual({
    mStillOnPage: true, shiftWithin4px: true, rowsAfter: 600, entryAfter: 0, pageErrors: [],
  });
});

test('行为3 全部加载完后只往上滚直到滚不动:会话的第1条消息在视口内', async ({ page }) => {
  const { S, errors } = await openFixture(page, 'b3');
  await clickTimes(page, 4);
  const end = await wheelUpUntilStuck(page);
  const inView = await textInView(page, S.texts[0]);
  expect({ firstInView: inView, pageErrors: errors }, `滚不动时 scrollTop=${end.top.toFixed(0)},消息行 ${end.rows},超时=${end.timedOut};第1条「${S.texts[0]}」${inView ? '在' : '不在'}视口内`).toEqual({ firstInView: true, pageErrors: [] });
});

test('行为6 全部加载完后点「回到底部」:贴底且最新一条在视口;追加2条并刷新后新消息在视口且仍贴底;再只往上滚到底,第1条在视口', async ({ page }) => {
  const { S, errors } = await openFixture(page, 'b6');
  await clickTimes(page, 4);
  await expect(backBtn(page), '前置:翻到顶后应有「回到底部」按钮').toBeVisible({ timeout: 15_000 });
  await backBtn(page).click();
  await expect.poll(async () => (await metricsOrFail(page)).dist, { message: '点「回到底部」后应贴底(离底 ≤2px)', timeout: 15_000 }).toBeLessThanOrEqual(2);
  expect(await textInView(page, S.texts[599]), `点「回到底部」后最新一条「${S.texts[599]}」应在视口内`).toBe(true);

  const added = await appendAndRefresh(page, S, 2);
  await expect.poll(() => textInView(page, added[1]), { message: `追加后新消息「${added[1]}」应出现在视口内`, timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await metricsOrFail(page)).dist, { message: '追加刷新后应仍贴底(离底 ≤2px)', timeout: 10_000 }).toBeLessThanOrEqual(2);

  const end = await wheelUpUntilStuck(page);
  const inView = await textInView(page, S.texts[0]);
  expect({ firstInView: inView, pageErrors: errors }, `往上滚到底时 scrollTop=${end.top.toFixed(0)},消息行 ${end.rows},超时=${end.timedOut};第1条「${S.texts[0]}」${inView ? '在' : '不在'}视口内`).toEqual({ firstInView: true, pageErrors: [] });
});

test('行为7 加载360条后点「回到底部」再追加60条并刷新:仍贴底,最新一条在视口,页面上消息行≤100', async ({ page }) => {
  const { S, errors } = await openFixture(page, 'b7');
  await clickTimes(page, 2);
  await expect(backBtn(page), '前置:翻到顶后应有「回到底部」按钮').toBeVisible({ timeout: 15_000 });
  await backBtn(page).click();
  await expect.poll(async () => (await metricsOrFail(page)).dist, { message: '点「回到底部」后应贴底(离底 ≤2px)', timeout: 15_000 }).toBeLessThanOrEqual(2);

  const added = await appendAndRefresh(page, S, 60);
  await sleep(500);
  const last = added[added.length - 1];
  const m = await metricsOrFail(page);
  const inView = await textInView(page, last);
  const rowsAfter = await rowCount(page);
  expect({ atBottom: m.dist <= 2, lastInView: inView, rowsAtMost100: rowsAfter <= 100, pageErrors: errors }, `离底 ${m.dist.toFixed(1)}px;最新一条「${last}」${inView ? '在' : '不在'}视口内;消息行 ${rowsAfter}`).toEqual({
    atBottom: true, lastInView: true, rowsAtMost100: true, pageErrors: [],
  });
});

test('行为8 连点前两次「加载更早」:每次点完眼前那条消息都留在原位(偏差≤4px),消息行依次为240、360', async ({ page }) => {
  const { errors } = await openFixture(page, 'b8');
  const first = await clickAndTrackFirstRow(page);
  const rows1 = await rowCount(page);
  const second = await clickAndTrackFirstRow(page);
  const rows2 = await rowCount(page);
  const shiftOf = (t) => (t.afterDist === null ? null : Math.abs(t.afterDist - t.before.dist));
  const s1 = shiftOf(first);
  const s2 = shiftOf(second);
  const facts = {
    firstShiftWithin4px: s1 !== null && s1 <= 4,
    rowsAfterFirst: rows1,
    secondShiftWithin4px: s2 !== null && s2 <= 4,
    rowsAfterSecond: rows2,
    pageErrors: errors,
  };
  expect(facts, `第1次 M=${first.before.uuid} 偏差 ${s1 === null ? '行已不在页面上' : `${s1.toFixed(1)}px`};第2次 M=${second.before.uuid} 偏差 ${s2 === null ? '行已不在页面上' : `${s2.toFixed(1)}px`};行数 ${rows1} → ${rows2}`).toEqual({
    firstShiftWithin4px: true, rowsAfterFirst: 240, secondShiftWithin4px: true, rowsAfterSecond: 360, pageErrors: [],
  });
});
