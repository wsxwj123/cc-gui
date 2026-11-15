// r190-send-leave-stall 黑盒验收:新会话界面里发出的第一条消息,即使按回车后马上切到别的会话,也会发给命令行;
// 新会话照常出现在侧栏,进去能看到这条消息和回复。
// 只依据接口文件的行为清单 F1–F6;只通过页面观测(侧栏会话行 / 用户气泡 / 回复文字块)、假命令行的收信日志与会话记录文件;假命令行见 helpers/fake-claude.mjs。
import { test, expect } from '@playwright/test';
import { seedWorkspace, readReceivedTexts, countTranscriptUserLines } from './helpers/fixtures.mjs';
import {
  openApp, reloadApp, openNewSession, enterNewSessionFromLoaded, composerBox, sendText, sessionRows, clickSeedRow, ROWS,
  userBubbleCount, assistantBlockCount, waitProcessed, uniqueTag,
} from './helpers/runtime.mjs';

const receivedCount = (ctx, M) => readReceivedTexts(ctx.workspaceName).filter((t) => t.includes(M)).length;

/** 等假命令行收到 M(最晚到 deadlineMs,Date.now() 刻度);收到后再等 1.5 秒抓重复投递;返回最终收到的次数。 */
async function waitReceived(page, ctx, M, deadlineMs) {
  let n = receivedCount(ctx, M);
  while (n < 1 && Date.now() < deadlineMs) { await page.waitForTimeout(100); n = receivedCount(ctx, M); }
  if (n >= 1) { await page.waitForTimeout(1500); n = receivedCount(ctx, M); }
  return n;
}

/**
 * 新会话界面输入 M 按回车,然后切到侧栏里的种子会话。
 *   slowActiveMs:填好输入框之后、按回车之前,把 GET /api/agents/active 的响应拖慢这么久(只拖慢,内容不改)。
 *   gapMs:按回车到点侧栏之间等多久;0 = 不留空档(按回车后下一条语句就点,侧栏行的定位器事先备好)。
 */
async function sendAndLeave(page, ctx, tag, { slowActiveMs = 0, gapMs = 300 } = {}) {
  await openNewSession(page, ctx);
  const M = `R190-${tag}-${uniqueTag()} 你好`;
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(M);
  if (slowActiveMs > 0) {
    await page.route('**/api/agents/active**', async (route) => {
      await new Promise((r) => setTimeout(r, slowActiveMs));
      await route.continue().catch(() => {});
    });
  }
  const seedRow = sessionRows(page).filter({ hasText: ctx.seed.marker }).first();
  const tEnter = Date.now();
  await box.press('Enter');
  if (gapMs > 0) await page.waitForTimeout(gapMs);
  await seedRow.click();
  return { M, tEnter };
}

test('F1 【复现】后台状态轮询慢 2 秒,新会话发 M 按回车后 0.3 秒切走:10 秒内命令行收到 M 恰好 1 次', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  const { M, tEnter } = await sendAndLeave(page, ctx, 'F1', { slowActiveMs: 2_000, gapMs: 300 });
  const n = await waitReceived(page, ctx, M, tEnter + 10_000);
  expect(n, `F1:从按回车起 10 秒内,命令行收到 M 应恰好 1 次;实际 ${n} 次`).toBe(1);
});

test('F2 【复现】不拖慢任何请求,按回车和点侧栏另一个会话之间不留空档:10 秒内命令行收到 M 恰好 1 次', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  const { M, tEnter } = await sendAndLeave(page, ctx, 'F2', { slowActiveMs: 0, gapMs: 0 });
  const n = await waitReceived(page, ctx, M, tEnter + 10_000);
  expect(n, `F2:从按回车起 10 秒内,命令行收到 M 应恰好 1 次;实际 ${n} 次`).toBe(1);
});

test('F3 【复现】做 F1 的操作:侧栏出现这个新会话(那一行有 M),点进去 M 的用户气泡恰好 1 个并看得到第一段回复', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  const { M, tEnter } = await sendAndLeave(page, ctx, 'F3', { slowActiveMs: 2_000, gapMs: 300 });
  const newRow = sessionRows(page).filter({ hasText: M });
  await expect.poll(() => newRow.count(), { message: `F3:从按回车起 20 秒内,侧栏里应出现含 M 文字的新会话行(恰好 1 行)`, timeout: 20_000 }).toBe(1);
  const n = await waitReceived(page, ctx, M, tEnter + 15_000);
  expect(n, `F3:命令行收到 M 应恰好 1 次;实际 ${n} 次`).toBe(1);
  await newRow.first().click();
  await expect.poll(() => userBubbleCount(page, M), { message: 'F3:点进新会话后,M 的用户气泡应恰好 1 个', timeout: 20_000 }).toBe(1);
  await expect.poll(() => assistantBlockCount(page, 'R190OK'), { message: 'F3:点进新会话后应看得到命令行对 M 的第一段回复(R190OK)', timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1500);
  expect(await userBubbleCount(page, M), 'F3:等 1.5 秒后 M 的用户气泡仍应恰好 1 个(不重复)').toBe(1);
});

test('F4 【复现】做 F1 的操作,等 5 秒刷新页面再点「新建会话」:新会话界面里没有「未发出的排队消息」,也没有 M 的文字', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  const { M } = await sendAndLeave(page, ctx, 'F4', { slowActiveMs: 2_000, gapMs: 300 });
  await page.waitForTimeout(5_000);
  await reloadApp(page);
  await enterNewSessionFromLoaded(page, ctx);
  // 3 秒内每 200 毫秒读一次「侧栏以外」的全部文字和输入框内容,任何一次出现都算(提示可能晚一点才画出来)。
  const hits = [];
  const end = Date.now() + 3_000;
  while (Date.now() < end) {
    const snap = await page.evaluate(({ sel, m }) => {
      const c = document.body.cloneNode(true);
      c.querySelectorAll(sel).forEach((e) => e.remove());
      const text = c.textContent || '';
      const vals = [...document.querySelectorAll('textarea,input')].map((e) => e.value || '');
      return { notice: text.includes('未发出的排队消息'), mText: text.includes(m), mInInput: vals.some((v) => v.includes(m)) };
    }, { sel: '[data-cgui="sidebar"],[data-cgui="session-row"]', m: M });
    if (snap.notice) hits.push('出现「未发出的排队消息」');
    if (snap.mText) hits.push('页面(侧栏以外)出现 M 的文字');
    if (snap.mInInput) hits.push('输入框里出现 M 的文字');
    await page.waitForTimeout(200);
  }
  expect([...new Set(hits)], 'F4:刷新后新会话界面里不应出现「未发出的排队消息」,也不应出现 M 的文字').toEqual([]);
});

test('F5 【相邻回归】新会话发 M 按回车不切走:用户气泡恰好 1 个,第一段回复出现,命令行只收到 1 次,回合结束后记录文件里 M 恰好 1 条', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  await openNewSession(page, ctx);
  const M = `R190-F5-${uniqueTag()} 你好`;
  const tEnter = Date.now();
  await sendText(page, M);
  await expect.poll(() => userBubbleCount(page, M), { message: 'F5:M 的用户气泡应恰好 1 个', timeout: 20_000 }).toBe(1);
  await expect.poll(() => assistantBlockCount(page, 'R190OK'), { message: 'F5:第一段回复(R190OK)应出现', timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  const n = await waitReceived(page, ctx, M, tEnter + 10_000);
  expect(n, `F5:命令行应只收到 1 次 M;实际 ${n} 次`).toBe(1);
  expect(await waitProcessed(page, ctx, 1, 20_000), 'F5:回合应结束(processed ≥ 1)').toBeGreaterThanOrEqual(1);
  expect(await userBubbleCount(page, M), 'F5:回合结束后 M 的用户气泡仍应恰好 1 个').toBe(1);
  const inFile = countTranscriptUserLines(ctx.tag, M);
  expect(inFile, `F5:回合结束后会话记录文件里 M 这条用户消息应恰好 1 条;实际 ${inFile} 条`).toBe(1);
});

test('F6 【相邻回归】新会话发 M 按回车,发送请求发出 1 秒后再切走:命令行收到 M 恰好 1 次,侧栏出现这个新会话', async ({ page }) => {
  const ctx = seedWorkspace(uniqueTag('t'));
  await openNewSession(page, ctx);
  const M = `R190-F6-${uniqueTag()} 你好`;
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(M);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/chat', { timeout: 15_000 });
  const tEnter = Date.now();
  await box.press('Enter');
  await sent;
  await page.waitForTimeout(1_000);
  await clickSeedRow(page, ctx);
  const n = await waitReceived(page, ctx, M, tEnter + 10_000);
  expect(n, `F6:命令行收到 M 应恰好 1 次;实际 ${n} 次`).toBe(1);
  const newRow = page.locator(ROWS).filter({ hasText: M });
  await expect.poll(() => newRow.count(), { message: 'F6:侧栏里应出现含 M 文字的新会话行(恰好 1 行)', timeout: 20_000 }).toBe(1);
});
