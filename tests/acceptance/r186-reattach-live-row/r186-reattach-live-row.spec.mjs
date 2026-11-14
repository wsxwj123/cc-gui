// r186-reattach-live-row 黑盒验收:页面中途接上一条正在跑的回合(刷新页面后重新打开正在跑的会话)时,
// 带实时状态的那一行就是这一轮最后一组工具调用的折叠头(可点开 / 收起);实时状态只出现一处;「上次更新」仍显示;
// 这一轮还没有助手内容写进会话文件时,最下面仍有一行不可点的实时状态;回合结束或被停止后实时状态消失。
// 只依据接口文件的行为清单 L1–L9;只通过页面观测;假命令行见 helpers/fake-claude.mjs。
import { test as base, expect } from '@playwright/test';
import { seedWorkspace, writeScenario, release } from './helpers/fixtures.mjs';
import { pageErrorLists, reloadApp, openWorkspaceGroup, clickSession, openNewSession, openSeedSession, sendText, stopBtn, waitStage, waitStopGone, uniqueTag } from './helpers/runtime.mjs';
import { liveInfo, describeLive, toolCardVisible, expectCards, readList, stripDigits, settledLive } from './helpers/observe.mjs';

// 每条用例都监听页面未捕获错误(pageerror),出现即失败。
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    pageErrorLists.set(page, errors);
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await use(page);
    expect(errors, '页面不应出现未捕获错误(pageerror)').toEqual([]);
  },
});

/** 每个用例现建一个全新工作区(含种子会话)+ 写这个工作区的场景。 */
function prepare(mode) {
  const ctx = seedWorkspace(uniqueTag('t'));
  writeScenario(ctx.workspaceName, { mode });
  return ctx;
}

/** 新建会话 → 发消息 → 工具轮:等到第 2 次工具已返回、第 3 次已发出(此时第 3 次挂着)。 */
async function startToolRound(page, ctx) {
  await openNewSession(page, ctx);
  await sendText(page, `请跑工具 ${uniqueTag('M')}`);
  await expect(stopBtn(page), '发出消息后应看到停止键').toBeVisible({ timeout: 20_000 });
  await waitStage(page, ctx, 'tool3-sent');
}

/** 刷新页面 → 展开工作区 → 在侧栏点开会话(who = 'fresh' 新建的会话 | 'seed' 种子会话)→ 等停止键再次出现。 */
async function refreshReopen(page, ctx, who = 'fresh') {
  await reloadApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, who, ctx);
  await expect(stopBtn(page), '刷新重开后应再次出现停止键(回合仍在跑)').toBeVisible({ timeout: 20_000 });
}

/** 工具轮 + 刷新重开,返回稳定后的状态行现状。 */
async function toolRoundReopened(page, ctx) {
  await startToolRound(page, ctx);
  await refreshReopen(page, ctx);
  return await settledLive(page);
}

const liveLine = (page) => page.locator('[data-live-line]');

// ───────────────────────── 复现 ─────────────────────────
test('L1【复现】工具轮刷新重开:恰 1 个状态行且在折叠头里、回合容器含 R186TOOL-、点它展开 TOOL-1/2 的工具卡、再点收起', async ({ page }) => {
  const ctx = prepare('tools');
  const info = await toolRoundReopened(page, ctx);
  const d = describeLive(info);
  expect.soft(info.lines, `L1:页面上应恰有 1 个 [data-live-line];实际 ${d}`).toBe(1);
  expect.soft(info.inHead, `L1:这个状态行应在某个 [data-work-group-head] 里(是折叠头本身);实际 ${d}`).toBe(1);
  expect.soft(info.turnTexts.some((t) => t && t.includes('R186TOOL-')), `L1:状态行所在的回合容器文字应含 R186TOOL-;实际容器文字 = ${JSON.stringify(info.turnTexts)}`).toBe(true);
  expect.soft(await toolCardVisible(page, 'R186TOOL-1'), 'L1:刷新重开后 R186TOOL-1 的工具卡应不可见(组默认收起)').toBe(false);
  // 点状态行:展开
  await liveLine(page).first().click({ timeout: 10_000 });
  await expectCards(page, true, `L1:点状态行后,R186TOOL-1 与 R186TOOL-2 的工具卡应变为可见;点击前现状 ${d}`);
  // 再点:收起
  await liveLine(page).first().click({ timeout: 10_000 });
  await expectCards(page, false, 'L1:再点一次状态行后,R186TOOL-1 与 R186TOOL-2 的工具卡应都不可见');
});

test('L2【复现】工具轮刷新重开:转圈指示恰 1 个,折叠头之外没有单独多出的状态行', async ({ page }) => {
  const ctx = prepare('tools');
  const info = await toolRoundReopened(page, ctx);
  const d = describeLive(info);
  expect.soft(info.indicators, `L2:页面上 [data-live-indicator] 应恰有 1 个;实际 ${d}`).toBe(1);
  expect.soft(info.outHead, `L2:不在任何 [data-work-group-head] 里的 [data-live-line] 应为 0(最下面没有单独多出的一行);实际 ${d}`).toBe(0);
});

// ───────────────────────── 守卫 ─────────────────────────
test('L3【守卫】工具轮刷新重开:页面可见文字里有「上次更新」', async ({ page }) => {
  const ctx = prepare('tools');
  await toolRoundReopened(page, ctx);
  await expect.poll(async () => await page.evaluate(() => document.body.innerText.includes('上次更新')), { timeout: 25_000, message: 'L3:页面可见文字里应出现「上次更新」' }).toBe(true);
});

test('L4【守卫】空等轮刷新重开:恰 1 个状态行且不在折叠头里;点它后 2 秒内消息区文字(去掉数字)不变', async ({ page }) => {
  const ctx = prepare('idle');
  await openNewSession(page, ctx);
  await sendText(page, `请空等 ${uniqueTag('M')}`);
  await expect(stopBtn(page), '发出消息后应看到停止键').toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2000);
  await refreshReopen(page, ctx);
  const info = await settledLive(page);
  const d = describeLive(info);
  expect.soft(info.lines, `L4:页面上应恰有 1 个 [data-live-line];实际 ${d}`).toBe(1);
  expect.soft(info.inHead, `L4:这个状态行不应在任何 [data-work-group-head] 里;实际 ${d}`).toBe(0);
  const before = stripDigits(await readList(page));
  await liveLine(page).first().click({ timeout: 10_000 });
  await page.waitForTimeout(2000);
  const after = stripDigits(await readList(page));
  expect(after, 'L4:点状态行后 2 秒内,消息区可见文字(去掉数字后)应保持不变(它不可点)').toBe(before);
});

test('L5【守卫】工具轮一直停在会话里:恰 1 个状态行且在折叠头里;点它 TOOL-1 工具卡可见,再点不可见', async ({ page }) => {
  const ctx = prepare('tools');
  await startToolRound(page, ctx);
  const info = await settledLive(page);
  const d = describeLive(info);
  expect.soft(info.lines, `L5:页面上应恰有 1 个 [data-live-line];实际 ${d}`).toBe(1);
  expect.soft(info.inHead, `L5:这个状态行应在某个 [data-work-group-head] 里;实际 ${d}`).toBe(1);
  await liveLine(page).first().click({ timeout: 10_000 });
  await expect.poll(async () => await toolCardVisible(page, 'R186TOOL-1'), { timeout: 15_000, message: `L5:点状态行后 R186TOOL-1 的工具卡应可见;点击前现状 ${d}` }).toBe(true);
  await liveLine(page).first().click({ timeout: 10_000 });
  await expect.poll(async () => await toolCardVisible(page, 'R186TOOL-1'), { timeout: 15_000, message: 'L5:再点一次后 R186TOOL-1 的工具卡应不可见' }).toBe(false);
});

test('L6【守卫】工具轮第 3 次工具挂着时切到种子会话、等 2 秒再切回:同 L5 的断言', async ({ page }) => {
  const ctx = prepare('tools');
  await startToolRound(page, ctx);
  await clickSession(page, 'seed', ctx);
  await expect(page.locator('[data-cgui="message-list"]'), 'L6:切到种子会话后应显示种子的历史回复').toContainText('R186SEED-历史回合收尾', { timeout: 20_000 });
  await page.waitForTimeout(2000);
  await clickSession(page, 'fresh', ctx);
  await expect(stopBtn(page), 'L6:切回后应有停止键(回合仍在跑)').toBeVisible({ timeout: 20_000 });
  const info = await settledLive(page);
  const d = describeLive(info);
  expect.soft(info.lines, `L6:页面上应恰有 1 个 [data-live-line];实际 ${d}`).toBe(1);
  expect.soft(info.inHead, `L6:这个状态行应在某个 [data-work-group-head] 里;实际 ${d}`).toBe(1);
  await liveLine(page).first().click({ timeout: 10_000 });
  await expect.poll(async () => await toolCardVisible(page, 'R186TOOL-1'), { timeout: 15_000, message: `L6:点状态行后 R186TOOL-1 的工具卡应可见;点击前现状 ${d}` }).toBe(true);
  await liveLine(page).first().click({ timeout: 10_000 });
  await expect.poll(async () => await toolCardVisible(page, 'R186TOOL-1'), { timeout: 15_000, message: 'L6:再点一次后 R186TOOL-1 的工具卡应不可见' }).toBe(false);
});

test('L7【守卫】工具轮刷新重开后放行:20 秒内 R186DONE 出现、停止键消失,之后状态行与转圈指示都是 0 个', async ({ page }) => {
  const ctx = prepare('tools');
  await toolRoundReopened(page, ctx);
  release(ctx.workspaceName);
  await expect(page.locator('[data-cgui="message-list"]'), 'L7:放行后 20 秒内应出现 R186DONE').toContainText('R186DONE', { timeout: 20_000 });
  expect(await waitStopGone(page, 20_000), 'L7:放行后 20 秒内停止键应消失').toBe(true);
  await expect.poll(async () => { const i = await liveInfo(page); return { lines: i.lines, indicators: i.indicators }; }, { timeout: 5_000, message: 'L7:回合结束后状态行与转圈指示都应是 0 个' }).toEqual({ lines: 0, indicators: 0 });
});

test('L8【守卫】在种子会话里发工具轮、刷新重开:恰 1 个状态行;含 R186SEED- 的回合容器里没有状态行', async ({ page }) => {
  const ctx = prepare('tools');
  await openSeedSession(page, ctx);
  await sendText(page, `请跑工具 ${uniqueTag('M')}`);
  await expect(stopBtn(page), '发出消息后应看到停止键').toBeVisible({ timeout: 20_000 });
  await waitStage(page, ctx, 'tool3-sent');
  await refreshReopen(page, ctx, 'seed');
  const info = await settledLive(page);
  const d = describeLive(info);
  expect.soft(info.lines, `L8:页面上应恰有 1 个 [data-live-line];实际 ${d}`).toBe(1);
  const seedTurns = await page.evaluate(() => [...document.querySelectorAll('[data-turn-uuid]')]
    .filter((t) => (t.innerText || '').includes('R186SEED-'))
    .map((t) => t.querySelectorAll('[data-live-line]').length));
  expect.soft(seedTurns.length, 'L8:应能找到文字含 R186SEED- 的种子回合容器').toBeGreaterThanOrEqual(1);
  expect.soft(seedTurns.filter((n) => n > 0).length, `L8:含 R186SEED- 的回合容器里不应有状态行;各容器内状态行数 = ${JSON.stringify(seedTurns)}`).toBe(0);
});

test('L9【守卫】工具轮刷新重开后点停止:15 秒内停止键消失,之后状态行与转圈指示都是 0 个', async ({ page }) => {
  const ctx = prepare('tools');
  await toolRoundReopened(page, ctx);
  await stopBtn(page).first().click({ timeout: 10_000 });
  expect(await waitStopGone(page, 15_000), 'L9:点停止后 15 秒内停止键应消失').toBe(true);
  await expect.poll(async () => { const i = await liveInfo(page); return { lines: i.lines, indicators: i.indicators }; }, { timeout: 5_000, message: 'L9:被停止后状态行与转圈指示都应是 0 个' }).toEqual({ lines: 0, indicators: 0 });
});
