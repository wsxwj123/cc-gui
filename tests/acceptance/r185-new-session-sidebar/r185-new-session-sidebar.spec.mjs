// r185-new-session-sidebar 黑盒验收:后端不监听会话目录(CGUI_DISABLE_FILE_WATCHER=1)时,新建会话发出第一条消息后,
// 不用等这一轮结束,侧栏里就出现这个新会话(所有打开着的页面都一样)。
// 只依据接口文件的行为清单 N1–N7;只通过页面观测(侧栏会话行 / 停止键 / 消息区)和假命令行的状态文件;假命令行见 helpers/fake-claude.mjs。
// 两趟运行:主趟(目录监听关)跑 N1–N5、N7;监听趟(目录监听开)只跑 N6。用例里按 R185_PASS 自跳。
import { test, expect } from '@playwright/test';
import { seedWorkspace, writeScenario, resetStatus, readStatus } from './helpers/fixtures.mjs';
import {
  openApp, openWorkspaceGroup, clickSession, openNewSession, sendText, stopBtn, readList, waitProcessed, waitStopGone, uniqueTag,
} from './helpers/runtime.mjs';

const PASS = process.env.R185_PASS || 'main';
const ROWS = '[data-cgui="session-row"]';

/** 每个用例现建一个全新工作区(带本用例独有标记的种子会话)+ 写场景(形态列表)+ 清状态文件。 */
function prepare(shapes) {
  const ctx = seedWorkspace(uniqueTag('t'));
  writeScenario({ shapes });
  resetStatus(ctx.workspaceName);
  return ctx;
}
const rowCount = (page) => page.locator(ROWS).count();

/** 记下页面真的发出 POST /api/chat 的那一刻(Date.now())。 */
function trackChatPost(page) {
  const rec = { t: null };
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/chat' && rec.t === null) rec.t = Date.now();
  });
  return rec;
}
async function chatPostTime(page, rec) {
  const end = Date.now() + 10_000;
  while (rec.t === null && Date.now() < end) await page.waitForTimeout(50);
  expect(rec.t, '发送后 10 秒内页面应发出 POST /api/chat').not.toBeNull();
  return rec.t;
}
/** 轮询到会话行数 = n 或到 untilMs(Date.now() 刻度)为止,返回最后读到的行数。 */
async function waitRows(page, n, untilMs) {
  let c = await rowCount(page);
  while (c !== n && Date.now() < untilMs) { await page.waitForTimeout(100); c = await rowCount(page); }
  const atDeadline = c;
  late.ms = null;
  // 只为失败信息:截止时没到位的话,再多看最多 35 秒它什么时候才出现(不影响断言,断言看截止时的读数)
  const hardEnd = Date.now() + 35_000;
  while (c !== n && atDeadline !== n && Date.now() < hardEnd) { await page.waitForTimeout(200); c = await rowCount(page); }
  if (atDeadline !== n && c === n) late.ms = Date.now() - untilMs;
  return atDeadline;
}
const late = { ms: null };
const lateNote = () => (late.ms === null ? '(之后 35 秒内也没出现)' : `(截止后又过 ${late.ms} 毫秒才出现)`);
/** 在 ms 毫秒内每 step 毫秒读一次行数,返回全部读数。 */
async function sampleRows(page, ms, step = 200) {
  const out = [];
  const end = Date.now() + ms;
  while (Date.now() < end) { out.push(await rowCount(page)); await page.waitForTimeout(step); }
  return out;
}
/** 新建会话 → 发第一条消息 → 等停止键出现(回合进行中)→ 点种子会话行切走。返回发请求的时刻与本工作区行数读数需要的上下文。 */
async function startAndSwitchAway(page, ctx, tag) {
  await openNewSession(page, ctx);
  const rec = trackChatPost(page);
  await sendText(page, `R185-${tag}-${uniqueTag()} 你好`);
  const t0 = await chatPostTime(page, rec);
  await expect(stopBtn(page).first(), `${tag}:发出第一条消息后停止键应可见(回合进行中)`).toBeVisible({ timeout: 15_000 });
  await clickSession(page, 'seed', ctx);
  return t0;
}
const fakeStatus = (ctx) => readStatus(ctx.workspaceName);

test('N1 新建会话发第一条消息,回合进行中切到种子会话:5 秒内本工作区会话行变 2 行,且那一轮未结束', async ({ page }) => {
  test.skip(PASS === 'watch', 'N1 属于主趟(目录监听关)');
  const ctx = prepare(['hold:30']);
  const t0 = await startAndSwitchAway(page, ctx, 'N1');
  const rows = await waitRows(page, 2, t0 + 5_000);
  expect(rows, `N1:从发出 POST /api/chat 起 5 秒内,本工作区会话行应为 2(种子 + 新会话);实际 ${rows} ${lateNote()}`).toBe(2);
  const st = fakeStatus(ctx);
  expect(st, 'N1:假命令行应已收到 1 条消息且那一轮仍未结束(processed = 0)').toMatchObject({ received: 1, processed: 0 });
});

test('N2 第二个页面(另一个浏览器上下文,已展开该工作区):第一个页面做 N1的操作后,第二个页面 5 秒内也变 2 行', async ({ page, browser }) => {
  test.skip(PASS === 'watch', 'N2 属于主趟(目录监听关)');
  const ctx = prepare(['hold:30']);
  const context2 = await browser.newContext();
  try {
    const page2 = await context2.newPage();
    await openApp(page2);
    await openWorkspaceGroup(page2, ctx);
    expect(await rowCount(page2), 'N2:第二个页面展开后,本工作区应先只有 1 行(种子)').toBe(1);
    const t0 = await startAndSwitchAway(page, ctx, 'N2');
    const rows2 = await waitRows(page2, 2, t0 + 5_000);
    expect(rows2, `N2:从第一个页面发出 POST /api/chat 起 5 秒内,第二个页面本工作区会话行应为 2;实际 ${rows2} ${lateNote()}`).toBe(2);
    expect(fakeStatus(ctx), 'N2:那一轮仍未结束').toMatchObject({ received: 1, processed: 0 });
  } finally {
    await context2.close();
  }
});

test('N3 新建会话发第一条消息后点停止(命令行收到停止不输出结束事件直接退出),再切到种子会话:停止后 5 秒内本工作区 2 行', async ({ page }) => {
  test.skip(PASS === 'watch', 'N3 属于主趟(目录监听关)');
  const ctx = prepare(['hold-die:30']);
  await openNewSession(page, ctx);
  await sendText(page, `R185-N3-${uniqueTag()} 你好`);
  await expect(stopBtn(page).first(), 'N3:发出消息后停止键应可见').toBeVisible({ timeout: 15_000 });
  await stopBtn(page).first().click();
  const tStop = Date.now();
  await clickSession(page, 'seed', ctx);
  const rows = await waitRows(page, 2, tStop + 5_000);
  expect(rows, `N3:点停止后 5 秒内,本工作区会话行应为 2(不必刷新页面);实际 ${rows} ${lateNote()}`).toBe(2);
  expect(fakeStatus(ctx), 'N3:假命令行已收到 1 条消息、没有输出过结束事件(processed = 0)').toMatchObject({ received: 1, processed: 0 });
});

test('N4 做完 N1的操作后等那一轮正常结束再等 8 秒:这 8 秒里会话行都不超过 2,第 8 秒时是 2 行', async ({ page }) => {
  test.skip(PASS === 'watch', 'N4 属于主趟(目录监听关)');
  const ctx = prepare(['hold:8']);
  await startAndSwitchAway(page, ctx, 'N4');
  expect(await waitProcessed(page, ctx, 1, 25_000), 'N4:第 1 条的回合应在 25 秒内结束(processed ≥ 1)').toBeGreaterThanOrEqual(1);
  const seen = await sampleRows(page, 8_000);
  const final = await waitRows(page, 2, Date.now());
  expect(Math.max(...seen), `N4:回合结束后 8 秒内会话行不应超过 2(重复的第三行);读数 = ${JSON.stringify(seen)}`).toBeLessThanOrEqual(2);
  expect(final, `N4:回合结束再等 8 秒后本工作区应是 2 行;实际 ${final}`).toBe(2);
});

test('N5 在种子会话里再发一条消息:回合进行中与结束后本工作区会话行一直是 1 行', async ({ page }) => {
  test.skip(PASS === 'watch', 'N5 属于主趟(目录监听关)');
  const ctx = prepare(['hold:6']);
  await openApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'seed', ctx);
  await expect(page.locator('[data-cgui="message-list"]'), 'N5:种子会话的历史回复应显示').toContainText('R185 历史回复', { timeout: 20_000 });
  await sendText(page, `R185-N5-${uniqueTag()} 再问一句`);
  await expect(stopBtn(page).first(), 'N5:发出消息后停止键应可见').toBeVisible({ timeout: 15_000 });
  const during = await sampleRows(page, 2_000);
  expect(during, `N5:回合进行中会话行应一直是 1;读数 = ${JSON.stringify(during)}`).toEqual(during.map(() => 1));
  expect(await waitProcessed(page, ctx, 1, 20_000), 'N5:回合应结束(processed ≥ 1)').toBeGreaterThanOrEqual(1);
  expect(await waitStopGone(page, 15_000), 'N5:回合结束后停止键应消失').toBe(true);
  const after = await sampleRows(page, 2_000);
  expect(after, `N5:回合结束后会话行应一直是 1;读数 = ${JSON.stringify(after)}`).toEqual(after.map(() => 1));
});

test('N6 后端开着目录监听时做 N1的操作:8 秒内变 2 行,且那一轮结束后仍是 2 行', async ({ page }) => {
  test.skip(PASS !== 'watch', 'N6 属于监听趟(后端不设 CGUI_DISABLE_FILE_WATCHER)');
  const ctx = prepare(['hold:8']);
  const t0 = await startAndSwitchAway(page, ctx, 'N6');
  const rows = await waitRows(page, 2, t0 + 8_000);
  expect(rows, `N6:从发出 POST /api/chat 起 8 秒内,本工作区会话行应为 2;实际 ${rows} ${lateNote()}`).toBe(2);
  expect(await waitProcessed(page, ctx, 1, 25_000), 'N6:第 1 条的回合应结束(processed ≥ 1)').toBeGreaterThanOrEqual(1);
  const seen = await sampleRows(page, 2_000);
  expect(seen, `N6:那一轮结束后本工作区会话行应一直是 2;读数 = ${JSON.stringify(seen)}`).toEqual(seen.map(() => 2));
});

test('N7 命令行输出初始化事件后立刻异常退出、没写会话文件:15 秒内会话行一直是 1,之后种子会话里发消息仍能得到回复', async ({ page }) => {
  test.skip(PASS === 'watch', 'N7 属于主趟(目录监听关)');
  const ctx = prepare(['crash', 'normal']);
  await openNewSession(page, ctx);
  const rec = trackChatPost(page);
  await sendText(page, `R185-N7-${uniqueTag()} 你好`);
  const t0 = await chatPostTime(page, rec);
  const seen = [];
  while (Date.now() < t0 + 15_000) { seen.push(await rowCount(page)); await page.waitForTimeout(300); }
  expect(seen.length, 'N7:15 秒内应采到足够多次读数').toBeGreaterThan(20);
  expect(seen, `N7:15 秒内本工作区会话行应一直是 1(不出现空会话行);读数 = ${JSON.stringify(seen)}`).toEqual(seen.map(() => 1));
  expect(fakeStatus(ctx), 'N7:假命令行收到过 1 条消息,没有正常结束').toMatchObject({ received: 1, processed: 0 });
  await clickSession(page, 'seed', ctx);
  await sendText(page, `R185-N7b-${uniqueTag()} 种子里再问`);
  await expect.poll(async () => (await readList(page)).includes('R185OK'), { message: 'N7:种子会话里发消息后应得到回复(R185OK)', timeout: 25_000 }).toBe(true);
});
