// r146c(R3 第二轮返工)验收(黑盒)。只由 run.sh 调起:tests/acceptance/r146c-rollback/run.sh [-g 'C1']
// 基建照抄 r146b-rollback(helpers 为副本)。拦请求只拖延、不改响应(C4 例外:造一次裁剪失败)。
//   C1 拉历史挂起时切走  C2 等停止落地期间切走(冻住定时器)  C3 提示不挂到别的会话
//   C4 裁剪失败时提示不说"已回退"  C6 裁空那一支告诉用户内容去了首页  C5 裁空会话后项目不从列表消失
// 会把会话裁空的 C6 / C5 放最后:修前裁空会让同一实例里排在后面的用例打不开夹具项目(就是 C5 要锁的那个问题)。
import { test, expect } from '@playwright/test';
import { NAV, R146, countTranscriptLines, encodeProjectDir, fixtureCwd, live, transcriptMentions } from './helpers/fixtures.mjs';
import {
  boot, clearSlowStart, clearSlowStartFor, composer, holdRequests, openSessionBySearch, releaseAllRuns,
  releaseChunk2, releaseTurnEnd, sendPrompt, sessionRow, switchTo, waitTurnRunning,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;
const LEFT_NOTICE = /原定的重发没有发出/;
const paneText = (page) => page.locator('[data-testid="pane"]').first().innerText();

const openFixture = async (page) => {
  await boot(page);
  await openSessionBySearch(page, NAV.mark);
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
};
const cleanup = async (page) => {
  try { await page.unrouteAll({ behavior: 'ignoreErrors' }); } catch { /* 页面可能已关 */ }
  clearSlowStart(CTL);
  for (const { sid } of R146) clearSlowStartFor(CTL, sid);
  releaseAllRuns(CTL);
};

async function runOneTurn(page, S, prompt) {
  await switchTo(page, S.mark);
  await sendPrompt(page, prompt);
  await waitTurnRunning(page, S.sid, prompt);
  releaseChunk2(CTL, S.sid);
  releaseTurnEnd(CTL, S.sid);
  await expect(page.getByText(live.final(S.sid), { exact: false }).first(), '这一轮应跑完').toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('button', { name: /^停止/ }), '回合结束后不应再有停止按钮').toHaveCount(0, { timeout: 20_000 });
}
async function rollbackMenu(page, text, itemName) {
  const card = page.locator('[data-message-id]').filter({ hasText: text }).first();
  await card.hover();
  await card.getByTitle('回滚 / 重新编辑').click();
  // 只认真正的 <button>:侧栏会话行是 div[role=button],它的名字(会话标题)可能恰好含菜单项的字。
  await page.getByRole('button', { name: itemName }).and(page.locator('button')).click();
}
/** 编辑后重发的准备:回退菜单 →「编辑后重发」→ 输入框里改成 edited(还没按 Enter)。 */
async function prepareEdit(page, pa1, edited) {
  await rollbackMenu(page, pa1, /编辑后重发/);
  const box = composer(page);
  await expect(box, '「编辑后重发」应把原文放进输入框').toHaveValue(pa1, { timeout: 10_000 });
  await box.fill(edited);
  return box;
}
/** 裁剪(提交那一次)完成之后,把这条会话的第一次拉历史挂住。 */
async function holdHistoryAfterTrim(page, sid) {
  let trimmed = false;
  let held = 0;
  let open;
  const gate = new Promise((r) => { open = r; });
  await page.route('**/api/sessions/*/trim', async (route) => {
    const resp = await route.fetch();
    let dry = true;
    try { dry = JSON.parse(route.request().postData() || '{}').dryRun !== false; } catch { /* */ }
    await route.fulfill({ response: resp });
    if (!dry) trimmed = true;
  });
  await page.route('**/api/sessions/*/messages*', async (route) => {
    const req = route.request();
    if (!trimmed || held > 0 || req.method() !== 'GET' || !req.url().includes(sid)) return route.continue();
    held += 1;
    await gate;
    return route.continue().catch(() => {});
  });
  return { held: () => held, release: () => open() };
}
/** 回到 A:输入框里应是 expected,并能看到"重发没有发出"的提示。 */
async function expectLeftInA(page, A, expected) {
  await switchTo(page, A.mark);
  await expect(composer(page), '回到 A:输入框里应是本来要重发的内容').toHaveValue(expected, { timeout: 10_000 });
  await expect.poll(async () => LEFT_NOTICE.test(await paneText(page)), { message: '回到 A 应能看到"重发没有发出"的提示', timeout: 10_000 }).toBe(true);
}

test.describe('常规', () => {
  test.beforeEach(async ({ page }) => openFixture(page));
  test.afterEach(async ({ page }) => cleanup(page));

  test('C1 编辑后重发、裁剪已返回、拉历史期间切走:回到 A 输入框里是改后的文字且有提示,改后文字不进 B', async ({ page }) => {
    const A = R146[0]; const Bx = R146[1];
    const pa1 = 'R146c C1 A 第一轮原文:稍后编辑后重发,拉历史期间切走。';
    const edited = 'R146c C1 A 改写后的文字:拉历史期间切走也不能丢。';
    await switchTo(page, Bx.mark);
    await runOneTurn(page, A, pa1);
    const box = await prepareEdit(page, pa1, edited);
    const h = await holdHistoryAfterTrim(page, A.sid);
    await box.press('Enter');
    await expect.poll(() => h.held(), { message: '裁剪已提交、拉历史应被拦住', timeout: 20_000 }).toBeGreaterThan(0);
    await switchTo(page, Bx.mark);
    h.release();
    await page.waitForTimeout(6_000);
    expect(transcriptMentions(Bx.sid, edited), '改后的文字被发进了 B').toBe(0);
    expect(countTranscriptLines(A.sid, 'user', pa1), 'A 的会话记录应已裁剪').toBe(0);
    await expectLeftInA(page, A, edited);
    expect(transcriptMentions(A.sid, edited), '切走后不应自动重发进 A').toBe(0);
  });

  test('C3 留给 A 的提示只在 A 上显示:回到 A 看到后不关,再切到 C,C 上不应出现', async ({ page }) => {
    const A = R146[3]; const Bx = R146[4]; const Cx = R146[5];
    const pa1 = 'R146c C3 A 第一轮:稍后「仅回退消息」,裁剪期间切走。';
    await switchTo(page, Bx.mark);
    await switchTo(page, Cx.mark);
    await runOneTurn(page, A, pa1);
    const trim = await holdRequests(page, '**/api/sessions/*/trim', (u, m) => m === 'POST');
    await rollbackMenu(page, pa1, /仅回退消息/);
    await expect.poll(() => trim.held(), { message: '裁剪请求应已发出并被拦住', timeout: 20_000 }).toBeGreaterThan(0);
    await switchTo(page, Bx.mark);
    trim.release();
    await expect.poll(() => countTranscriptLines(A.sid, 'user', pa1), { timeout: 20_000 }).toBe(0);
    await page.waitForTimeout(4_000);
    await expectLeftInA(page, A, pa1);
    await switchTo(page, Cx.mark);
    await page.waitForTimeout(1_000);
    expect(LEFT_NOTICE.test(await paneText(page)), '留给 A 的提示挂到了 C 上').toBe(false);
  });

  test('C4 裁剪失败、期间切走:回到 A 的提示如实说裁剪失败,不说"会话记录已回退"', async ({ page }) => {
    const A = R146[6]; const Bx = R146[7];
    const pa1 = 'R146c C4 A 第一轮:稍后「仅回退消息」,裁剪会失败。';
    await switchTo(page, Bx.mark);
    await runOneTurn(page, A, pa1);
    let open; const gate = new Promise((r) => { open = r; }); let held = 0;
    await page.route('**/api/sessions/*/trim', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      held += 1; await gate;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'R146c 模拟裁剪失败' }) });
    });
    await rollbackMenu(page, pa1, /仅回退消息/);
    await expect.poll(() => held, { message: '裁剪请求应已发出并被拦住', timeout: 20_000 }).toBeGreaterThan(0);
    await switchTo(page, Bx.mark);
    open();
    await page.waitForTimeout(4_000);
    await switchTo(page, A.mark);
    await expect.poll(async () => /裁剪失败/.test(await paneText(page)), { message: '回到 A 应能看到"裁剪失败"', timeout: 10_000 }).toBe(true);
    expect(/会话记录已回退/.test(await paneText(page)), '裁剪失败了,提示却说"会话记录已回退"').toBe(false);
    expect(countTranscriptLines(A.sid, 'user', pa1), '裁剪失败,A 的会话记录应原样还在').toBe(1);
  });
});

test.describe('冻住定时器', () => {
  test.beforeEach(async ({ page }) => { await page.clock.install(); await openFixture(page); });
  test.afterEach(async ({ page }) => cleanup(page));

  test('C2 编辑后重发、拉历史已回来、等停止落地再重发的那段里切走:回到 A 输入框里是改后的文字且有提示', async ({ page }) => {
    const A = R146[9]; const Bx = R146[10];
    const pa1 = 'R146c C2 A 第一轮原文:稍后编辑后重发,在等停止落地的那段里切走。';
    const edited = 'R146c C2 A 改写后的文字:等停止落地期间切走也不能丢。';
    await switchTo(page, Bx.mark);
    await runOneTurn(page, A, pa1);
    const box = await prepareEdit(page, pa1, edited);
    const h = await holdHistoryAfterTrim(page, A.sid);
    await box.press('Enter');
    await expect.poll(() => h.held(), { message: '裁剪已提交、拉历史应被拦住', timeout: 20_000 }).toBeGreaterThan(0);
    // 冻住定时器(网络与点击照常):拉历史放行后回退走到"等停止落地再重发",它的第一跳定时器被冻住
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1);
    h.release();
    await page.waitForTimeout(1_500);
    await sessionRow(page, Bx.mark).click({ force: true });
    await page.waitForTimeout(1_500);
    expect(await page.locator('[data-testid="pane"]').first().getAttribute('data-owner-key'), '应已切到 B').toBe(Bx.sid);
    await page.clock.resume();
    await page.waitForTimeout(6_000);
    expect(transcriptMentions(Bx.sid, edited), '改后的文字被发进了 B').toBe(0);
    await expectLeftInA(page, A, edited);
    expect(transcriptMentions(A.sid, edited), '切走后不应自动重发进 A').toBe(0);
  });
});

test.describe('裁空会话', () => {
  test.beforeEach(async ({ page }) => openFixture(page));
  test.afterEach(async ({ page }) => cleanup(page));

  test('C6 回退唯一一轮(会话被裁空)、裁剪期间切走:此刻所在的 B 上说明内容去了首页「未发出的消息」', async ({ page }) => {
    const A = R146[12]; const Bx = R146[13];
    const firstUser = `${A.mark} 先来一句话`;
    await switchTo(page, Bx.mark);
    await switchTo(page, A.mark);
    const trim = await holdRequests(page, '**/api/sessions/*/trim', (u, m) => m === 'POST');
    await rollbackMenu(page, firstUser, /仅回退消息/);
    await expect.poll(() => trim.held(), { message: '裁剪请求应已发出并被拦住', timeout: 20_000 }).toBeGreaterThan(0);
    await switchTo(page, Bx.mark);
    trim.release();
    await expect.poll(() => countTranscriptLines(A.sid, 'user', firstUser), { message: 'A 应已被裁空', timeout: 20_000 }).toBe(0);
    await expect.poll(async () => /未发出的消息/.test(await paneText(page)), { message: 'B 上应说明内容去了首页「未发出的消息」', timeout: 10_000 }).toBe(true);
  });

  test('C5 回退唯一一轮把会话裁空、裁剪期间切走(不重发)后,项目不能从项目列表消失,新开页面仍能打开同项目的会话', async ({ page, browser }) => {
    // 不切走时裁空后会自动重发、新建出一条会话,项目随之又能列出来;切走时不重发,裁空的会话就成了
    // 该项目里最新修改、却没有 cwd 的那个文件(r146b 里 T4→T0 必红的现场)。
    const A = R146[15]; const Bx = R146[16];
    const firstUser = `${A.mark} 先来一句话`;
    await switchTo(page, Bx.mark);
    await switchTo(page, A.mark);
    const trim = await holdRequests(page, '**/api/sessions/*/trim', (u, m) => m === 'POST');
    await rollbackMenu(page, firstUser, /仅回退消息/);
    await expect.poll(() => trim.held(), { message: '裁剪请求应已发出并被拦住', timeout: 20_000 }).toBeGreaterThan(0);
    await switchTo(page, Bx.mark);
    trim.release();
    await expect.poll(() => countTranscriptLines(A.sid, 'user', firstUser), { message: 'A 应已被裁空', timeout: 20_000 }).toBe(0);
    await page.waitForTimeout(3_000);
    const hash = encodeProjectDir(fixtureCwd());
    const projects = await (await page.request.get('/api/projects')).json();
    expect(Array.isArray(projects) && projects.some((p) => p.hash === hash), `项目列表里没有夹具项目了(返回 ${JSON.stringify(projects).slice(0, 200)})`).toBe(true);
    const ctx2 = await browser.newContext({ baseURL: process.env.R118_UI_BASE, viewport: { width: 1440, height: 900 } });
    try {
      const p2 = await ctx2.newPage();
      await openFixture(p2);
    } finally { await ctx2.close(); }
  });
});
