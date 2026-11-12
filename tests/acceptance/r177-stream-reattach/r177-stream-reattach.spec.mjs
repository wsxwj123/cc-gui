// r177-stream-reattach 黑盒验收:在「命令行开口之前切走再切回」时,回复正文应和不切走时一样实时显示、逐片段增长;
// 之后再切换不重复不缺少;点停止后已显示的内容保留。
// 只依据接口文件的行为清单 S1–S10;只通过页面观测(文案 / data-* 锚点);假命令行见 helpers/fake-claude.mjs。
// 记号:T0 = 假命令行开口的时刻(夹具状态文件 openedAt)。启动延迟 8 秒、片段间隔 50 毫秒、正文 1200 片段(约 60 秒)。
// S5、S10 按接口文件「说明」允许,把正文改成 400 片段(约 20 秒),期望值相应为 400,用例名里写明。
import { test, expect } from '@playwright/test';
import { seedPair, writeScenario, resetStatus, readStatus, requestAbort } from './helpers/fixtures.mjs';
import {
  openApp, reloadApp, openWorkspaceGroup, clickSession, openJia, sendText, stopBtn, composerBox, Watch, expectGrowth, uniqueTag,
} from './helpers/runtime.mjs';

/** 每个用例现建一对全新的甲 / 乙(各自独有标记、独立工作区)+ 写场景 + 清状态文件。 */
let currentCtx = null;
function prepare(scenario = {}) {
  const ctx = seedPair(uniqueTag('t'));
  currentCtx = ctx;
  writeScenario({ startDelayMs: 8000, chunkIntervalMs: 50, chunkCount: 1200, mode: 'normal', ...scenario });
  resetStatus(ctx.workspaceName);
  return ctx;
}

// 用例收场:让假命令行把遗留的长回合尽快正常收尾,免得占着后端、拖慢下一个用例(最多等 10 秒)。
test.afterEach(async () => {
  if (!currentCtx) return;
  const name = currentCtx.workspaceName;
  requestAbort(name);
  for (let i = 0; i < 100; i += 1) {
    const st = readStatus(name);
    if (!st || st.openedAt == null || st.ended) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  currentCtx = null;
});

/** 在当前会话发一条消息,等到页面真的向后端发出「发起对话」的请求,返回请求发出的时刻。
 *  原来返回的是点发送的时刻:机器一忙,0.6 秒后请求可能还没发出去,这时切走的就不是「等连接」的那一段
 *  (消息会留到切回才发),S2 / S3 因此时红时绿。现在各用例里的「发出后 0.6 秒」都从请求发出算起。 */
async function sendMessage(page, text) {
  const isChatStart = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/chat';
  const posted = page.waitForRequest(isChatStart, { timeout: 15_000 });
  await sendText(page, text);
  await posted;
  return Date.now();
}
const waitUntilTime = async (page, tMs) => { const d = tMs - Date.now(); if (d > 0) await page.waitForTimeout(d); };

/** S1 的操作:在甲发消息;发出 0.6 秒后点乙,再过 2 秒点回甲。返回 { tSend, tBack }。要求点回时夹具还没开口。 */
async function sendThenAwayAndBack(page, ctx, { awayMs = 2000 } = {}) {
  const tSend = await sendMessage(page, `${ctx.jia.marker} 请连续输出`);
  await waitUntilTime(page, tSend + 600);
  await clickSession(page, 'yi', ctx);
  const tAway = Date.now();
  await waitUntilTime(page, tAway + awayMs);
  const st = readStatus(ctx.workspaceName);
  expect(st && st.openedAt, `前置:点回会话甲时命令行应还没开口(状态文件 openedAt 应为空);实际 openedAt=${st && st.openedAt}`).toBeNull();
  await clickSession(page, 'jia', ctx);
  return { tSend, tBack: Date.now() };
}

/** 等 T0 之后 6 秒内片段数 ≥ 20(S1 / S6 的第一步)。 */
async function expectFirstTwentyWithin6s(page, w, what) {
  const t0 = await w.waitOpened(20_000);
  expect(t0, `${what}:夹具在 20 秒内应开口`).not.toBeNull();
  const r = await w.until((s) => s.n >= 20, t0 + 6000 - Date.now());
  expect(r.ok, `${what}:T0 之后 6 秒内页面上的正文片段数应 ≥ 20;最后一次读到 ${r.s.n}(夹具已输出 ${r.s.fxAfter};停止键${r.s.stop ? '在' : '不在'})`).toBe(true);
  return t0;
}

// ───────────────────────── S1 ─────────────────────────
test('S1 开口前切走再切回:T0 后 6 秒内片段数 ≥ 20,之后每 3 秒至少多 20,停止键一直在,无「接管/连接中断」', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const w = new Watch(page, ctx);
  await sendThenAwayAndBack(page, ctx);
  // 先把全部观察做完(含只打印不断言的诊断),再统一断言:这样断言失败时诊断输出也完整。
  const t0 = await w.waitOpened(20_000);
  const first = t0 == null ? null : await w.until((s) => s.n >= 20, t0 + 6000 - Date.now());
  const wins = await w.windows(3, 3000);
  if (t0 != null) await w.holdUntil(t0 + 24_000);
  if (t0 != null) {
    const parts = [];
    for (let k = 1; k <= 12; k += 1) {
      const s = w.samples.find((x) => x.t >= t0 + 2000 * k);
      if (s) parts.push(`T0+${2 * k}s=${s.n}/${s.fxAfter}`);
    }
    console.log(`[S1 诊断] 页面片段数/夹具已输出数,T0 起每 2 秒:${parts.join(' ')}`);
  }
  expect(t0, 'S1:夹具在 20 秒内应开口').not.toBeNull();
  expect(first.ok, `S1:T0 之后 6 秒内页面上的正文片段数应 ≥ 20;最后一次读到 ${first.s.n}(夹具已输出 ${first.s.fxAfter};停止键${first.s.stop ? '在' : '不在'})`).toBe(true);
  expectGrowth(wins, 20, 'S1');
  const inObs = w.samples.filter((s) => s.t >= wins[0].start.t && s.t <= wins[wins.length - 1].end.t);
  const noStop = inObs.filter((s) => !s.stop).length;
  expect(noStop, `S1:连续观察 9 秒期间停止键应一直在;${inObs.length} 次读数里有 ${noStop} 次不在`).toBe(0);
  expect(w.count((s) => s.takeover), 'S1:页面上不应出现「接管」「连接中断」字样;出现的读数次数').toBe(0);
});

// ───────────────────────── S2 ─────────────────────────
test('S2 开口前切走、停到 T0+3 秒再切回:6 秒内片段数 ≥ 夹具已输出的 80%,之后每 3 秒至少多 20', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const w = new Watch(page, ctx);
  const tSend = await sendMessage(page, `${ctx.jia.marker} 请连续输出`);
  await waitUntilTime(page, tSend + 600);
  await clickSession(page, 'yi', ctx);
  let t0 = null;
  for (let i = 0; i < 160 && t0 == null; i += 1) { const st = readStatus(ctx.workspaceName); t0 = st && st.openedAt; if (t0 == null) await page.waitForTimeout(100); }
  if (t0 == null) {
    // 只打印不参与断言的诊断:夹具一直没开口时,点回甲之后它会不会开口(判断「消息没送到命令行」是否要等会话回到前台)。
    await clickSession(page, 'jia', ctx);
    const tSwitch = Date.now();
    let late = null;
    for (let i = 0; i < 200 && late == null; i += 1) { const st = readStatus(ctx.workspaceName); late = st && st.openedAt; if (late == null) await page.waitForTimeout(100); }
    console.log(`[S2 诊断] 切走 16 秒夹具未开口;点回甲后 ${late == null ? '20 秒内仍未开口' : `${Math.round((late - tSwitch) / 100) / 10} 秒开口`}`);
  }
  expect(t0, 'S2:夹具在 16 秒内应开口').not.toBeNull();
  await waitUntilTime(page, t0 + 3000);
  await clickSession(page, 'jia', ctx);
  const tBack = Date.now();
  const r = await w.until((s) => s.fxBefore > 0 && s.n >= 0.8 * s.fxBefore, tBack + 6000 - Date.now());
  expect(r.ok, `S2:切回后 6 秒内页面上的正文片段数应 ≥ 夹具已输出片段数的 80%;最后一次读到 ${r.s.n},夹具已输出 ${r.s.fxBefore}(80% = ${Math.ceil(0.8 * r.s.fxBefore)})`).toBe(true);
  const wins = await w.windows(2, 3000);
  expectGrowth(wins, 20, 'S2');
});

// ───────────────────────── S3 ─────────────────────────
test('S3 先切走再切回、等到 60 片段后再切走 2 秒切回:不丢(≥N)、不重复(≤夹具+5),之后每 3 秒至少多 20', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const w = new Watch(page, ctx);
  await sendThenAwayAndBack(page, ctx);
  const t0 = await w.waitOpened(20_000);
  expect(t0, 'S3:夹具在 20 秒内应开口').not.toBeNull();
  const reach = await w.until((s) => s.n >= 60, 20_000);
  expect(reach.ok, `S3:前置——T0 之后应等到页面片段数 ≥ 60;最后一次读到 ${reach.s.n}(夹具已输出 ${reach.s.fxAfter})`).toBe(true);
  const N = reach.s.n;
  await clickSession(page, 'yi', ctx);
  await page.waitForTimeout(2000);
  await clickSession(page, 'jia', ctx);
  const tBack = Date.now();
  const noLoss = await w.until((s) => s.n >= N, tBack + 2000 - Date.now());
  const at2s = await w.holdUntil(tBack + 2000);
  console.log(`[S3 诊断] N=${N} 切回后2秒页面片段数=${at2s.n} 当时夹具已输出=${at2s.fxAfter}`);
  expect(noLoss.ok, `S3:切回后 2 秒内片段数应 ≥ 切走前的 ${N};最后一次读到 ${noLoss.s.n}`).toBe(true);
  expect(at2s.n, `S3:切回后 2 秒时片段数应 ≤ 夹具已输出(${at2s.fxAfter})+5(不重复);实际 ${at2s.n}`).toBeLessThanOrEqual(at2s.fxAfter + 5);
  const wins = await w.windows(2, 3000);
  expectGrowth(wins, 20, 'S3');
});

// ───────────────────────── S4 ─────────────────────────
test('S4 切走再切回、T0+8 秒点停止:5 秒内停止键消失,第 6 秒片段数在被打断数的 90%~+5 内,出现「Request interrupted/已中断」', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const w = new Watch(page, ctx);
  await sendThenAwayAndBack(page, ctx);
  const t0 = await w.waitOpened(20_000);
  expect(t0, 'S4:夹具在 20 秒内应开口').not.toBeNull();
  await w.holdUntil(t0 + 8000);
  await expect(stopBtn(page), 'S4:前置——T0+8 秒时停止键应在').toHaveCount(1, { timeout: 3000 });
  await stopBtn(page).click();
  const tStop = Date.now();
  const gone = await w.until((s) => !s.stop, 5000);
  expect(gone.ok, `S4:点停止后 5 秒内停止键应消失;5 秒后仍在,页面片段数 ${gone.s.n}`).toBe(true);
  const at6s = await w.holdUntil(tStop + 6000);
  const I = at6s.interruptedAtChunks;
  expect(I, 'S4:夹具状态文件应记下被打断时已输出片段数(说明打断请求送到了命令行)').not.toBeNull();
  expect(at6s.n, `S4:停止后第 6 秒片段数应 ≥ 被打断数 ${I} 的 90%(${Math.ceil(0.9 * I)});实际 ${at6s.n}`).toBeGreaterThanOrEqual(Math.ceil(0.9 * I));
  expect(at6s.n, `S4:停止后第 6 秒片段数应 ≤ 被打断数 ${I}+5;实际 ${at6s.n}`).toBeLessThanOrEqual(I + 5);
  expect(at6s.interrupted, 'S4:停止后第 6 秒页面上应有 Request interrupted 或「已中断」字样').toBe(true);
});

// ───────────────────────── S5 ─────────────────────────
test('S5 切走再切回、回合自然结束(正文 400 片段版):片段数 =400,刷新并点回会话甲后仍 =400', async ({ page }) => {
  const ctx = prepare({ chunkCount: 400 });
  await openJia(page, ctx);
  const w = new Watch(page, ctx);
  await sendThenAwayAndBack(page, ctx);
  const done = await w.until((s) => s.ended, 60_000);
  expect(done.ok, 'S5:夹具应在 60 秒内跑完这一回合').toBe(true);
  const gone = await w.until((s) => !s.stop, 20_000);
  expect(gone.ok, `S5:回合自然结束后停止键应消失;20 秒后仍在,页面片段数 ${gone.s.n}`).toBe(true);
  const settled = await w.hold(3000);
  expect(settled.n, `S5:回合结束后页面上的正文片段数应等于 400;实际 ${settled.n}`).toBe(400);

  await reloadApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'jia', ctx);
  await expect(page.locator('[data-cgui="message-list"]'), 'S5:刷新点回会话甲后应显示历史回复').toContainText('R177 历史回复', { timeout: 20_000 });
  const w2 = new Watch(page, ctx);
  const after = await w2.hold(3000);
  expect(after.n, `S5:刷新并点回会话甲后片段数应仍等于 400(不重复、不缺);实际 ${after.n}`).toBe(400);
});

// ───────────────────────── S6 ─────────────────────────
test('S6 不切走的对照:T0 后 6 秒内片段数 ≥ 20,之后每 3 秒至少多 20', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const w = new Watch(page, ctx);
  await sendMessage(page, `${ctx.jia.marker} 请连续输出`);
  await expectFirstTwentyWithin6s(page, w, 'S6');
  const wins = await w.windows(2, 3000);
  expectGrowth(wins, 20, 'S6');
});

// ───────────────────────── S7 ─────────────────────────
test('S7 已开始输出后再切走(≥60 片段时):切回 2 秒内 ≥ 切走前,2 秒时 ≤ 夹具+5,之后每 3 秒至少多 20', async ({ page }) => {
  const ctx = prepare();
  await openJia(page, ctx);
  const w = new Watch(page, ctx);
  await sendMessage(page, `${ctx.jia.marker} 请连续输出`);
  const t0 = await w.waitOpened(20_000);
  expect(t0, 'S7:夹具在 20 秒内应开口').not.toBeNull();
  const reach = await w.until((s) => s.n >= 60, 20_000);
  expect(reach.ok, `S7:前置——应等到页面片段数 ≥ 60;最后一次读到 ${reach.s.n}(夹具已输出 ${reach.s.fxAfter})`).toBe(true);
  const before = reach.s.n;
  await clickSession(page, 'yi', ctx);
  await page.waitForTimeout(2000);
  await clickSession(page, 'jia', ctx);
  const tBack = Date.now();
  const noLoss = await w.until((s) => s.n >= before, tBack + 2000 - Date.now());
  expect(noLoss.ok, `S7:切回后 2 秒内片段数应 ≥ 切走前的 ${before};最后一次读到 ${noLoss.s.n}`).toBe(true);
  const at2s = await w.holdUntil(tBack + 2000);
  expect(at2s.n, `S7:切回后 2 秒时片段数应 ≤ 夹具已输出(${at2s.fxAfter})+5;实际 ${at2s.n}`).toBeLessThanOrEqual(at2s.fxAfter + 5);
  const wins = await w.windows(2, 3000);
  expectGrowth(wins, 20, 'S7');
});

// ───────────────────────── S8 ─────────────────────────
test('S8 新会话第一条消息:开口前切到乙,T0+3 秒且侧栏出现新会话行后点回,6 秒内 ≥ 夹具的 80%,之后每 3 秒至少多 20', async ({ page }) => {
  const ctx = prepare();
  await openApp(page);
  await openWorkspaceGroup(page, ctx);
  const pr = page.locator('[data-cgui="project-row"]').filter({ hasText: ctx.workspaceName }).first();
  await pr.hover();
  await pr.locator('xpath=..').locator('[data-cgui="new-session-btn"]').click({ force: true });
  const w = new Watch(page, ctx);
  const tSend = await sendMessage(page, `S8 新会话 ${ctx.tag} 请连续输出`);
  await waitUntilTime(page, tSend + 600);
  await clickSession(page, 'yi', ctx);
  let t0 = null;
  for (let i = 0; i < 160 && t0 == null; i += 1) { const st = readStatus(ctx.workspaceName); t0 = st && st.openedAt; if (t0 == null) await page.waitForTimeout(100); }
  expect(t0, 'S8:夹具在 16 秒内应开口').not.toBeNull();
  await waitUntilTime(page, t0 + 3000);
  // 关着文件监听时新会话不会自己出现在侧栏:刷新页面后才列出,再展开工作区点它的行。
  // 第一次刷新就点;若此时侧栏还没列出新会话,每 2 秒再刷新一次(最多到 T0+40 秒,仍在回合进行中),并打印诊断。
  let listedAfterMs = null;
  for (let i = 0; i < 20 && listedAfterMs == null; i += 1) {
    await reloadApp(page);
    await openWorkspaceGroup(page, ctx);
    const texts = await page.locator('[data-cgui="session-row"]').allInnerTexts();
    if (texts.some((t) => !t.includes(ctx.yi.marker) && !t.includes(ctx.jia.marker))) listedAfterMs = Date.now() - t0;
    else await page.waitForTimeout(2000);
  }
  console.log(`[S8 诊断] 新会话行${listedAfterMs == null ? '到 T0+40 秒仍未被列出' : `在 T0+${(listedAfterMs / 1000).toFixed(1)} 秒的刷新后列出`}`);
  await clickSession(page, 'fresh', ctx, { timeout: 5_000 });
  const tBack = Date.now();
  const r = await w.until((s) => s.fxBefore > 0 && s.n >= 0.8 * s.fxBefore, tBack + 6000 - Date.now());
  expect(r.ok, `S8:刷新并点开新会话后 6 秒内页面上的正文片段数应 ≥ 夹具已输出片段数的 80%;最后一次读到 ${r.s.n},夹具已输出 ${r.s.fxBefore}(80% = ${Math.ceil(0.8 * r.s.fxBefore)})`).toBe(true);
  const wins = await w.windows(2, 3000);
  expectGrowth(wins, 20, 'S8');
});

// ───────────────────────── S9 ─────────────────────────
test('S9 启动失败:切走再切回,等夹具退出后 8 秒,停止键不在,消息区没有残留「正在输出」', async ({ page }) => {
  const ctx = prepare({ mode: 'startfail' });
  await openJia(page, ctx);
  const w = new Watch(page, ctx);
  const tSend = await sendMessage(page, `${ctx.jia.marker} 请连续输出`);
  await waitUntilTime(page, tSend + 600);
  await clickSession(page, 'yi', ctx);
  await page.waitForTimeout(2000);
  await clickSession(page, 'jia', ctx);
  // 一直等到夹具退出(状态文件 exitedAt),再过 8 秒读页面。
  let exitedAt = null;
  for (let i = 0; i < 300 && exitedAt == null; i += 1) { const st = readStatus(ctx.workspaceName); exitedAt = st && st.exitedAt; if (exitedAt == null) await page.waitForTimeout(100); }
  expect(exitedAt, 'S9:夹具应在 30 秒内因启动失败退出(状态文件 exitedAt 有值)').not.toBeNull();
  const last = await w.holdUntil(exitedAt + 8000);
  // 启动失败的报错文字显示不显示,不在本轮范围内,不断言。
  expect(last.stop, 'S9:夹具退出 8 秒后停止键应不在').toBe(false);
  expect(last.listOutputting, 'S9:夹具退出 8 秒后消息区里不应残留「正在输出」字样').toBe(false);
});

// ───────────────────────── S10 ─────────────────────────
test('S10 回合结束后的一致性,不切走(正文 400 片段版):片段数 =400,刷新并点回会话甲后仍 =400', async ({ page }) => {
  const ctx = prepare({ chunkCount: 400 });
  await openJia(page, ctx);
  const w = new Watch(page, ctx);
  await sendMessage(page, `${ctx.jia.marker} 请连续输出`);
  const done = await w.until((s) => s.ended, 60_000);
  expect(done.ok, 'S10:夹具应在 60 秒内跑完这一回合').toBe(true);
  const gone = await w.until((s) => !s.stop, 20_000);
  expect(gone.ok, `S10:回合自然结束后停止键应消失;20 秒后仍在,页面片段数 ${gone.s.n}`).toBe(true);
  const settled = await w.hold(3000);
  expect(settled.n, `S10:回合结束后页面上的正文片段数应等于 400;实际 ${settled.n}`).toBe(400);

  await reloadApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'jia', ctx);
  await expect(page.locator('[data-cgui="message-list"]'), 'S10:刷新点回会话甲后应显示历史回复').toContainText('R177 历史回复', { timeout: 20_000 });
  const w2 = new Watch(page, ctx);
  const after = await w2.hold(3000);
  expect(after.n, `S10:刷新并点回会话甲后片段数应仍等于 400(不重复、不缺);实际 ${after.n}`).toBe(400);
});
