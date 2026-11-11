// r151l 补验收 B7(第三轮窄复审:跨会话 loading 泄漏):
//   A(300 条)点「加载更早」→ 请求在飞时切到 B(60 条)。B 首屏落地时若分页账还是 A 的
//   (loading:true)被抄进 B 的新账,B 的「加载更早」入口会永久显示 disabled 的加载文案,
//   后续刷新/点击都清不掉。修法方向:仅同会话时保留 loading;切会话 reset 时让旧 older 响应过期。
// 本用例只观察 DOM / 网络,不 import 产品代码、不读内部 store:
//   · 「加载更早」入口 = [data-history-load-older](既有可观察身份);无入口也算正常(短会话)。
//   · B 的 60 行用 [data-cgui="message-list"] [data-turn-uuid] 计数(与 B1–B6 同口径)。
//   · A 的旧 older 请求用 page.route 扣住不返回(比固定 sleep 更确定),等 B 的状态取完再放行,
//     确保"切到 B 时 A 的响应仍在飞"这一前提真实成立。
import { test, expect } from '@playwright/test';
import { seedHistory, uniq } from './helpers/fixtures.mjs';
import {
  boot,
  openSessionBySearch,
  messageList,
  messageRows,
  loadOlderCandidates,
  watchHistoryRequests,
} from './helpers/ui.mjs';
import { messagesPath, clickLoadOlder } from './helpers/paging.mjs';

test.describe.configure({ timeout: 240_000 });

const UI_READY = () => Boolean(process.env.R151L_UI_BASE);

/**
 * 监听某会话「加载更早」(带 before)请求的最终去向。
 * r168 起前端会在切会话时取消在飞的旧请求,所以"最后一次状态"有两种都算满足前提:
 *   landed    —— 响应落地(之后必须被丢弃);
 *   cancelled —— 请求失败 / 被中止(requestfailed)。
 * 只记录事实,不对去向做取舍;后续的"不混入 / 不串 / 账从 120 重来"断言与去向无关,一条不放宽。
 */
function watchOlderOutcome(page, sid) {
  const isOlder = (url) => {
    try {
      const u = new URL(url);
      return u.pathname === messagesPath(sid) && u.searchParams.has('before');
    } catch { return false; }
  };
  const state = { outcome: null, status: null, response: null, errorText: null };
  let done = () => {};
  const settled = new Promise((resolve) => { done = resolve; });
  page.on('response', (res) => {
    if (state.outcome || !isOlder(res.url())) return;
    state.outcome = 'landed';
    state.status = res.status();
    state.response = res;
    done(state);
  });
  page.on('requestfailed', (req) => {
    if (state.outcome || !isOlder(req.url())) return;
    state.outcome = 'cancelled';
    state.errorText = req.failure()?.errorText ?? 'unknown';
    done(state);
  });
  const describe = () => (state.outcome === 'landed'
    ? `落地(HTTP ${state.status})`
    : state.outcome === 'cancelled' ? `被取消(${state.errorText})` : '尚无结果');
  return { state, settled, describe };
}

/** 打开会话后等该会话的第一条历史请求落地(与 B1–B6 同口径)。 */
async function historyRequestsFor(page, reqs, sid) {
  await expect.poll(() => reqs.filter((r) => r.sid === sid).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  return reqs.filter((r) => r.sid === sid);
}

/**
 * 「加载更早」入口的可观察状态(只看 DOM):
 * count=0 表示没有入口;B 只有 60 条、本来就没有更早,没有入口是正常的。
 * 有入口时:disabled 必须为 false、文案不得是加载中/正在加载,才算可点击。
 */
async function loadOlderEntryState(page) {
  const wrap = page.locator('[data-history-load-older]');
  const count = await wrap.count();
  if (!count) return { count: 0, buttonCount: 0, text: null, disabled: null, loadingText: false };
  const btn = wrap.first().locator('button');
  const buttonCount = await btn.count();
  const text = (await wrap.first().innerText()).replace(/\s+/g, ' ').trim();
  const disabled = buttonCount ? await btn.first().isDisabled() : null;
  return { count, buttonCount, text, disabled, loadingText: /加载中|正在加载/.test(text) };
}

/** 入口可用 = 没有入口(短会话),或有一个可点击且不在 loading 的入口。 */
const entryUsable = (s) => s.count === 0
  || (s.buttonCount === 1 && s.disabled === false && s.loadingText === false);

const entryDesc = (s) => (s.count ? `「${s.text}」disabled=${s.disabled}` : '无入口');

test('B7 窄复审 切会话不泄漏 loading:A 的「加载更早」在飞时切到 B,B 的入口不显示 loading/disabled、B 不被 A 混入;旧响应落地后仍干净;切回 A 首屏 120 且入口可点、点击 200', async ({ page }) => {
  test.skip(!UI_READY(), '需要 run.sh 起的共享实例 + dev server');
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const A = seedHistory(`b7a-${uniq('')}`, { count: 300 });
  const B = seedHistory(`b7b-${uniq('')}`, { count: 60 });
  const reqs = watchHistoryRequests(page);
  await boot(page);

  // ── 打开 A:首屏 120、「加载更早」入口可点 ──────────────────────────────
  await openSessionBySearch(page, A.firstText, A.lastText);
  await historyRequestsFor(page, reqs, A.sid);
  await expect.poll(() => messageRows(page).count(), { timeout: 30_000 }).toBe(120);
  const aEntryBefore = await loadOlderEntryState(page);
  expect({
    aRows: await messageRows(page).count(),
    aEntryCount: aEntryBefore.count,
    aEntryDisabled: aEntryBefore.disabled,
    aEntryNoLoadingText: !aEntryBefore.loadingText,
    aEntryUsable: entryUsable(aEntryBefore),
  }, `A 首屏应 120 行且入口可点(入口:${entryDesc(aEntryBefore)})`).toEqual({
    aRows: 120,
    aEntryCount: 1,
    aEntryDisabled: false,
    aEntryNoLoadingText: true,
    aEntryUsable: true,
  });

  // ── 扣住 A 的 older 请求:它不返回,就不可能提前落地 ────────────────────
  let delayedSeen = false;
  let releaseOlder = () => {};
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  await page.route('**/api/sessions/*/messages*', async (route) => {
    try {
      const u = new URL(route.request().url());
      if (u.pathname === messagesPath(A.sid) && u.searchParams.has('before')) {
        delayedSeen = true;
        await olderGate;
      }
    } catch { /* 非 HTTP 请求照常放行 */ }
    // 旧请求若已被前端取消,这里放行会报"请求已结束",属预期,不当作失败。
    try { await route.continue(); } catch { /* 请求已被取消 */ }
  });
  const stale = watchOlderOutcome(page, A.sid);
  await loadOlderCandidates(page).first().dispatchEvent('click');
  await expect.poll(() => delayedSeen, { timeout: 15_000 }).toBe(true);

  // ── 请求在飞时切到 B,取 B 打开后的可观察状态(此时旧响应仍被扣住)────────
  let bFacts;
  try {
    await openSessionBySearch(page, B.firstText, B.lastText);
    await expect.poll(() => messageRows(page).count(), { timeout: 40_000 }).toBe(60);
    await page.waitForTimeout(400);
    bFacts = {
      rows: await messageRows(page).count(),
      entry: await loadOlderEntryState(page),
      aLastLeak: await messageList(page).getByText(A.lastText).count(),
      aOldPageLeak: await messageList(page).getByText(A.texts[60]).count(),
      bLast: await messageList(page).getByText(B.lastText).count(),
      aOlderNotLanded: stale.state.outcome !== 'landed',
      aOlderOutcomeNow: stale.describe(),
    };
  } finally {
    releaseOlder();
  }

  expect({
    bRows: bFacts.rows,
    bEntryCount: bFacts.entry.count,
    bEntryDisabled: bFacts.entry.count === 0 ? null : false,
    bEntryNoLoadingText: !bFacts.entry.loadingText,
    bEntryUsable: entryUsable(bFacts.entry),
    aLastLeakIntoB: bFacts.aLastLeak,
    aOldPageLeakIntoB: bFacts.aOldPageLeak,
    bLastInB: bFacts.bLast,
    aOlderNotLandedAtCheck: bFacts.aOlderNotLanded,
    pageErrors,
  }, `B 打开后:${bFacts.rows} 行;入口 ${entryDesc(bFacts.entry)};A 末条混入 ${bFacts.aLastLeak};A 旧页混入 ${bFacts.aOldPageLeak};B 末条命中 ${bFacts.bLast};A 旧请求此刻:${bFacts.aOlderOutcomeNow}(放行前不得已落地=${bFacts.aOlderNotLanded});页面错误 ${JSON.stringify(pageErrors)}`).toEqual({
    bRows: 60,
    bEntryCount: expect.any(Number),
    bEntryDisabled: bFacts.entry.count === 0 ? null : false,
    bEntryNoLoadingText: true,
    bEntryUsable: true,
    aLastLeakIntoB: 0,
    aOldPageLeakIntoB: 0,
    bLastInB: 1,
    aOlderNotLandedAtCheck: true,
    pageErrors: [],
  });

  // ── 放行 A 的旧响应:落地后 B 仍 60 行、无 loading 残留、不被混入 ─────────
  // 前提:A 的旧「加载更早」请求最终要么落地(之后被丢弃)要么被取消(失败/中止),两者都算。
  await Promise.race([
    stale.settled,
    new Promise((r) => setTimeout(r, 30_000)),
  ]);
  const staleOutcome = stale.state.outcome;
  const staleStatus = stale.state.status;
  const staleBody = staleOutcome === 'landed' ? await stale.state.response.json().catch(() => null) : null;
  console.log(`[r151l-B7] A 的旧「加载更早」请求最后:${stale.describe()}`);
  expect(['landed', 'cancelled'], `A 的旧「加载更早」请求最后应是落地或被取消,实际:${stale.describe()}`).toContain(staleOutcome);
  await page.waitForTimeout(800);
  const bAfter = {
    rows: await messageRows(page).count(),
    entry: await loadOlderEntryState(page),
    aLastLeak: await messageList(page).getByText(A.lastText).count(),
    aOldPageLeak: await messageList(page).getByText(A.texts[60]).count(),
    bLast: await messageList(page).getByText(B.lastText).count(),
  };
  await page.unroute('**/api/sessions/*/messages*');

  expect({
    staleOutcomeOk: staleOutcome === 'landed' ? (staleStatus === 200 && Array.isArray(staleBody?.messages) && staleBody.messages.length === 120) : staleOutcome === 'cancelled',
    bRows: bAfter.rows,
    bEntryCount: bAfter.entry.count,
    bEntryDisabled: bAfter.entry.count === 0 ? null : false,
    bEntryNoLoadingText: !bAfter.entry.loadingText,
    bEntryUsable: entryUsable(bAfter.entry),
    aLastLeakIntoB: bAfter.aLastLeak,
    aOldPageLeakIntoB: bAfter.aOldPageLeak,
    bLastInB: bAfter.bLast,
    pageErrors,
  }, `A 旧「加载更早」请求最后:${stale.describe()}(落地须 200 且 120 条;取消则无应答)。之后:B ${bAfter.rows} 行;入口 ${entryDesc(bAfter.entry)};A 末条混入 ${bAfter.aLastLeak};A 旧页混入 ${bAfter.aOldPageLeak};B 末条命中 ${bAfter.bLast};页面错误 ${JSON.stringify(pageErrors)}`).toEqual({
    staleOutcomeOk: true,
    bRows: 60,
    bEntryCount: expect.any(Number),
    bEntryDisabled: bAfter.entry.count === 0 ? null : false,
    bEntryNoLoadingText: true,
    bEntryUsable: true,
    aLastLeakIntoB: 0,
    aOldPageLeakIntoB: 0,
    bLastInB: 1,
    pageErrors: [],
  });

  // ── 切回 A:首屏重新 120、入口可点,点击正常加载一页(200)──────────────
  await openSessionBySearch(page, A.firstText, A.lastText);
  await expect.poll(() => messageRows(page).count(), { timeout: 40_000 }).toBe(120);
  await page.waitForTimeout(400);
  const aBackEntry = await loadOlderEntryState(page);
  const bLeakIntoA = await messageList(page).getByText(B.lastText).count();
  const aLastInA = await messageList(page).getByText(A.lastText).count();
  expect({
    aRows: await messageRows(page).count(),
    aEntryCount: aBackEntry.count,
    aEntryDisabled: aBackEntry.count === 0 ? null : false,
    aEntryNoLoadingText: !aBackEntry.loadingText,
    aEntryUsable: entryUsable(aBackEntry),
    bLeakIntoA,
    aLastInA,
    pageErrors,
  }, `切回 A:${await messageRows(page).count()} 行;入口 ${entryDesc(aBackEntry)};B 末条混入 ${bLeakIntoA};A 末条命中 ${aLastInA};页面错误 ${JSON.stringify(pageErrors)}`).toEqual({
    aRows: 120,
    aEntryCount: 1,
    aEntryDisabled: false,
    aEntryNoLoadingText: true,
    aEntryUsable: true,
    bLeakIntoA: 0,
    aLastInA: 1,
    pageErrors: [],
  });

  const aOlder = await clickLoadOlder(page, reqs, A.sid);
  await expect.poll(() => messageRows(page).count(), { timeout: 40_000 }).toBe(240);
  expect({
    status: aOlder.status,
    fetched: Array.isArray(aOlder.body?.messages) ? aOlder.body.messages.length : null,
    before: aOlder.request?.params.before ?? null,
    limit: aOlder.request?.params.limit ?? null,
    rowsAfter: await messageRows(page).count(),
  }, `切回 A 点「加载更早」应正常 200 并前插一页(请求 ${aOlder.request?.url})`).toEqual({
    status: 200,
    fetched: 120,
    before: '180',
    limit: '120',
    rowsAfter: 240,
  });
});
