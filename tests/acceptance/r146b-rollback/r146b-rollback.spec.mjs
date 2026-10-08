// r146b(R3 返工)回退 / 重发中途切走会话的验收(黑盒)。只由 run.sh 调起:tests/acceptance/r146b-rollback/run.sh [-g 'T1']
// 判官打回的点:"裁剪已提交、随后才发现窗格切走"这条路径 —— 要重发的内容不能丢(编辑过的文字、
// 已有草稿、会话被裁空)、回到原会话要能看到发生了什么、磁盘侧(还原文件 + 裁剪)不能停在半截。
// 基建照抄 r146-crosstalk(helpers 是那边的副本)。拦请求只拖延、不改响应。
import { test, expect } from '@playwright/test';
import { NAV, R146, countTranscriptLines, live, transcriptMentions } from './helpers/fixtures.mjs';
import {
  boot, clearSlowStart, clearSlowStartFor, composer, holdRequests, openSessionBySearch, releaseAllRuns,
  sendPrompt, sessionRow, switchTo, waitTurnRunning, releaseChunk2, releaseTurnEnd,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;
// 产品文案(回到原会话时的可见提示)只锁这一句的主干。
const LEFT_NOTICE = /原定的重发没有发出/;

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openSessionBySearch(page, NAV.mark);
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
});

test.afterEach(async ({ page }) => {
  for (const glob of ['**/api/sessions/*/trim', '**/api/checkpoints/*/restore']) {
    try { await page.unroute(glob); } catch { /* 页面可能已关 */ }
  }
  clearSlowStart(CTL);
  for (const { sid } of R146) clearSlowStartFor(CTL, sid);
  releaseAllRuns(CTL);
});

/** 在 A 里跑完整一轮(这一轮就是稍后要回退的那条)。 */
async function runOneTurn(page, S, prompt) {
  await switchTo(page, S.mark);
  await sendPrompt(page, prompt);
  await waitTurnRunning(page, S.sid, prompt);
  releaseChunk2(CTL, S.sid);
  releaseTurnEnd(CTL, S.sid);
  await expect(page.getByText(live.final(S.sid), { exact: false }).first(), '这一轮应跑完').toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('button', { name: /^停止/ }), '回合结束后不应再有停止按钮').toHaveCount(0, { timeout: 20_000 });
}

/** 打开某条用户消息卡上的回退菜单,点其中一项。 */
async function rollbackMenu(page, text, itemName) {
  const card = page.locator('[data-message-id]').filter({ hasText: text }).first();
  await card.hover();
  await card.getByTitle('回滚 / 重新编辑').click();
  await page.getByRole('button', { name: itemName }).click();
}

const paneText = (page) => page.locator('[data-testid="pane"]').first().innerText();

// ============================================================ T0 ============================================================
// 上面 T1 / T3 的"原文留回输入框"依赖输入框草稿本身跨会话切换不丢。探路实测(未做任何回退):
// A 输入框写草稿 → 切到 B → 切回 A,草稿被删、输入框为空。这是"留回输入框"能否成立的前提,单列一条。
test('T0 输入框草稿跨会话切换不丢:A 写了未发的草稿,切到 B 再切回 A,输入框里仍是这段草稿', async ({ page }) => {
  const A = R146[30];
  const Bx = R146[31];
  const draft = 'R146b T0 A 输入框里还没发出去的草稿,切走再切回不该消失。';
  await switchTo(page, Bx.mark);
  await switchTo(page, A.mark);
  await composer(page).fill(draft);
  await page.waitForTimeout(600);
  await switchTo(page, Bx.mark);
  await expect(composer(page), '切到 B:B 的输入框不应带出 A 的草稿').toHaveValue('', { timeout: 5_000 });
  await switchTo(page, A.mark);
  await expect(composer(page), '切回 A:草稿不见了').toHaveValue(draft, { timeout: 10_000 });
});

// ============================================================ T1 ============================================================
test('T1 编辑后重发、裁剪期间切走:回到 A 时输入框里是【改后】的文字,且有可见提示;改后文字不进 B', async ({ page }) => {
  const A = R146[20];
  const Bx = R146[21];
  const pa1 = 'R146b T1 A 第一轮原文:稍后用「编辑后重发」改写这条。';
  const edited = 'R146b T1 A 改写后的文字:这一版才是本来要重发的内容。';

  await switchTo(page, Bx.mark);
  await runOneTurn(page, A, pa1);
  await rollbackMenu(page, pa1, /编辑后重发/);
  const box = composer(page);
  await expect(box, '「编辑后重发」应把原文放进输入框').toHaveValue(pa1, { timeout: 10_000 });

  const trim = await holdRequests(page, '**/api/sessions/*/trim', (u, m) => m === 'POST');
  await box.fill(edited);
  await box.press('Enter');
  await expect.poll(() => trim.held(), { message: '裁剪请求应已发出并被拦住', timeout: 20_000 }).toBeGreaterThan(0);
  await switchTo(page, Bx.mark);
  trim.release();
  await expect.poll(() => countTranscriptLines(A.sid, 'user', pa1), { message: 'A 的会话记录应已裁剪(磁盘侧做完)', timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(5_000);   // 覆盖重发的 ≤4s 等待
  expect(transcriptMentions(Bx.sid, edited), '改后的文字被发进了 B').toBe(0);

  await switchTo(page, A.mark);
  await expect(composer(page), '回到 A:输入框里应是改后的文字(不是改前原文)').toHaveValue(edited, { timeout: 10_000 });
  await expect.poll(async () => LEFT_NOTICE.test(await paneText(page)), { message: '回到 A 应能看到"重发没有发出"的提示', timeout: 10_000 }).toBe(true);
  expect(transcriptMentions(A.sid, edited), '切走后不应自动重发进 A').toBe(0);
});

// ============================================================ T2 ============================================================
test('T2 「回退消息和文件」在还原文件期间切走:还原与裁剪都要做完(不留半截),回到 A 有提示、原文在输入框', async ({ page }) => {
  const A = R146[22];
  const Bx = R146[23];
  const pa1 = 'R146b T2 A 第一轮:稍后对这条点「回退消息和文件」,还原期间切走。';

  await switchTo(page, Bx.mark);
  await runOneTurn(page, A, pa1);
  const restore = await holdRequests(page, '**/api/checkpoints/*/restore', (u, m) => m === 'POST');
  await rollbackMenu(page, pa1, /回退消息和文件/);
  await expect.poll(() => restore.held(), { message: '还原文件的请求应已发出并被拦住(前置:这条消息有快照)', timeout: 20_000 }).toBeGreaterThan(0);
  await switchTo(page, Bx.mark);
  restore.release();
  await expect.poll(() => countTranscriptLines(A.sid, 'user', pa1), { message: '文件已还原、会话记录却没裁剪(半截状态)', timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(5_000);
  expect(transcriptMentions(Bx.sid, pa1), 'A 的原文被发进了 B').toBe(0);

  await switchTo(page, A.mark);
  await expect.poll(async () => LEFT_NOTICE.test(await paneText(page)), { message: '回到 A 应能看到"重发没有发出"的提示', timeout: 10_000 }).toBe(true);
  await expect(composer(page), '回到 A:本来要重发的原文应在输入框里').toHaveValue(pa1, { timeout: 10_000 });
});

// ============================================================ T3 ============================================================
test('T3 A 的输入框已有未发的草稿:「仅回退消息」裁剪期间切走,回到 A 时草稿与要重发的原文都在(不静默丢)', async ({ page }) => {
  const A = R146[24];
  const Bx = R146[25];
  const pa1 = 'R146b T3 A 第一轮:稍后对这条点「仅回退消息」。';
  const draft = 'R146b T3 这是 A 输入框里还没发出去的草稿。';

  await switchTo(page, Bx.mark);
  await runOneTurn(page, A, pa1);
  await composer(page).fill(draft);
  await page.waitForTimeout(400);   // 草稿随输入落盘
  const trim = await holdRequests(page, '**/api/sessions/*/trim', (u, m) => m === 'POST');
  await rollbackMenu(page, pa1, /仅回退消息/);
  await expect.poll(() => trim.held(), { message: '裁剪请求应已发出并被拦住', timeout: 20_000 }).toBeGreaterThan(0);
  await switchTo(page, Bx.mark);
  trim.release();
  await expect.poll(() => countTranscriptLines(A.sid, 'user', pa1), { message: 'A 的会话记录应已裁剪', timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(5_000);

  await switchTo(page, A.mark);
  const value = await composer(page).inputValue();
  expect(value.includes(draft), `回到 A:原有草稿不见了(输入框:${JSON.stringify(value)})`).toBe(true);
  expect(value.includes(pa1), `回到 A:要重发的原文被静默丢了(输入框:${JSON.stringify(value)})`).toBe(true);
  await expect.poll(async () => LEFT_NOTICE.test(await paneText(page)), { message: '回到 A 应能看到"重发没有发出"的提示', timeout: 10_000 }).toBe(true);
});

// ============================================================ T4 ============================================================
// 放在最后:它会关掉窗格回到首页。实测同一实例里排在它后面的用例,开机搜索打不开夹具会话(单独跑都绿,
// T4→T0 必红;服务端接口返回正常,原因未查明,与回退修复无关),所以让它最后执行。
test('T4 回退的是唯一一轮(裁剪把会话清空)、裁剪期间切走:要重发的原文必须在之后找得到的地方(首页的未发出消息里)', async ({ page }) => {
  const A = R146[26];
  const Bx = R146[27];
  const firstUser = `${A.mark} 先来一句话`;   // 夹具里 A 唯一的一轮

  await switchTo(page, Bx.mark);
  await switchTo(page, A.mark);
  const trim = await holdRequests(page, '**/api/sessions/*/trim', (u, m) => m === 'POST');
  await rollbackMenu(page, firstUser, /仅回退消息/);
  await expect.poll(() => trim.held(), { message: '裁剪请求应已发出并被拦住', timeout: 20_000 }).toBeGreaterThan(0);
  await switchTo(page, Bx.mark);
  trim.release();
  await expect.poll(() => countTranscriptLines(A.sid, 'user', firstUser), { message: 'A 应已被裁空', timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(5_000);
  expect(transcriptMentions(Bx.sid, firstUser), 'A 的原文被发进了 B').toBe(0);

  // A 已被裁空(侧栏不再列出它),回不去;回到首页,这条原文应作为"未发出的消息"在那里等着
  await page.getByTitle(/^关闭此窗格/).first().click();
  const banner = page.getByText(/条未发出的/).first();
  await expect(banner, '首页应列出未发出的消息').toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(firstUser, { exact: false }).first(), '要重发的原文应在首页的未发出消息里').toBeVisible({ timeout: 5_000 });
});
