// r191-reattach-live-text 黑盒验收:一条会话的回复正在输出时刷新页面再回到这条会话,
// 正在写的那一段正文(还没写进会话文件)要在页面重新连上后马上出现、跟着输出继续增长,写完后恰好出现一次,后面的每一段同样边写边显示。
// 只依据接口文件的行为清单 L1–L4;只通过页面观测;假命令行见 helpers/fake-claude.mjs(慢速正文剧本 P0 → 工具 → P1 → 工具 → P2)。
import { test as base, expect } from '@playwright/test';
import { seedWorkspace, writtenFlagExists, readStage, abortRound } from './helpers/fixtures.mjs';
import { reloadApp, openWorkspaceGroup, clickSession, openNewSession, sendText, stopBtn, messageList, waitStage, waitStopGone, uniqueTag } from './helpers/runtime.mjs';
import { snap, sampleFor, waitSnap } from './helpers/observe.mjs';

// 每条用例现建一个全新工作区(含种子会话);用例结束(含失败)时让假命令行把这一轮尽快收尾,免得遗留的长回合拖累后面的用例。
const test = base.extend({
  ctx: async ({}, use) => {
    const ctx = seedWorkspace(uniqueTag('t'));
    await use(ctx);
    abortRound(ctx.workspaceName);
  },
});

/** 新建会话 → 发消息 → 等页面上出现 P1 的开头(= 刷新之前页面正常显示、P1 已开始输出);并自证 P1 此刻还没写盘。 */
async function startRoundUntilP1(page, ctx) {
  await openNewSession(page, ctx);
  await sendText(page, `请慢速输出 ${uniqueTag('M')}`);
  await expect(stopBtn(page), '发出消息后应看到停止键').toBeVisible({ timeout: 20_000 });
  const seen = await waitSnap(page, (s) => s.p1First >= 1, 45_000);
  expect(seen, '刷新之前:45 秒内页面上应出现 R191-P1-001(P1 开始输出;夹具没按剧本跑则这里先红)').not.toBeNull();
  expect(writtenFlagExists(ctx.workspaceName, 'P1'), '夹具自证:页面刚出现 P1 的开头时,P1 的写盘标志不应存在').toBe(false);
  expect(readStage(ctx.workspaceName), '夹具自证:假命令行此刻应在输出 P1').toBe('p1-streaming');
}

/** P1 开始约 3 秒后刷新页面 → 展开工作区 → 在侧栏点开新建的会话 → 等停止键与对话区出现。返回此刻的时间戳(「页面加载完回到会话」)。 */
async function refreshAfterP1Started(page, ctx) {
  await page.waitForTimeout(3000);
  expect(writtenFlagExists(ctx.workspaceName, 'P1'), '夹具自证:刷新时 P1 还没写盘').toBe(false);
  await reloadApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'fresh', ctx);
  await expect(stopBtn(page), '刷新重开后应再次出现停止键(回合仍在跑)').toBeVisible({ timeout: 20_000 });
  await expect(messageList(page), '刷新重开后对话区应出现').toBeVisible({ timeout: 20_000 });
  return Date.now();
}

const FINAL_OK = { p0: 1, p1: 1, p2: 1, p1Last: 1, p2Last: 1, streamFail: false };
const pickFinal = (s) => ({ p0: s.p0First, p1: s.p1First, p2: s.p2First, p1Last: s.p1Last, p2Last: s.p2Last, streamFail: s.streamFail });

// ───────────────────────── 复现 ─────────────────────────
test('L1【复现】刷新后正在写的 P1 在写完之前就出现并增长', async ({ page, ctx }) => {
  await startRoundUntilP1(page, ctx);
  await refreshAfterP1Started(page, ctx);

  // 刷新后 25 秒内页面上出现 R191-P1-001;读到它的那一刻 P1 的写盘标志还不存在。
  const first = await waitSnap(page, (s) => s.p1First >= 1, 25_000);
  const flagAtRead = writtenFlagExists(ctx.workspaceName, 'P1');
  expect(first, 'L1:刷新回到会话后 25 秒内,页面上应出现 R191-P1-001(正在写的这一段的开头);实际一直没出现').not.toBeNull();
  expect(flagAtRead, 'L1:读到 R191-P1-001 的那一刻,P1 的写盘标志应还不存在(证明它是写完之前显示的)').toBe(false);

  // 再过 2 秒读一次:P1 的最大片号比上一次大(跟着输出继续增长)。
  await page.waitForTimeout(2000);
  const later = await snap(page);
  expect(later.maxP1, `L1:2 秒后页面上 P1 的最大片号应比上一次(${first.maxP1})大`).toBeGreaterThan(first.maxP1);
});

test('L2【复现】写完后 P1 开头只出现一次;P2 同样边写边显示;回合结束后各段完整且各一次', async ({ page, ctx }) => {
  await startRoundUntilP1(page, ctx);
  await refreshAfterP1Started(page, ctx);

  // 等 P1 的写盘标志出现(P1 共约 40 秒)。
  const flagDeadline = Date.now() + 70_000;
  while (!writtenFlagExists(ctx.workspaceName, 'P1')) {
    if (Date.now() > flagDeadline) throw new Error(`夹具自证:70 秒内 P1 的写盘标志没出现;假命令行阶段 = ${readStage(ctx.workspaceName)}`);
    await page.waitForTimeout(50);
  }
  // 从这一刻起 3 秒内每 100 毫秒读一次:R191-P1-001 的出现次数每一次都是 1。
  const samples = await sampleFor(page, 3000, 100);
  const counts = samples.map((s) => s.p1First);
  expect(samples.length, 'L2:3 秒内应读到至少 15 次').toBeGreaterThanOrEqual(15);
  expect(counts, `L2:P1 写盘后 3 秒内每次读到的 R191-P1-001 出现次数都应是 1(不为 0 也不为 2);实际序列 = ${JSON.stringify(counts)}`).toEqual(counts.map(() => 1));

  // 在 P2 的写盘标志出现之前,页面上出现 R191-P2-001。
  let p2Seen = null;
  let p2FlagAtRead = null;
  const p2Deadline = Date.now() + 30_000;
  for (;;) {
    const s = await snap(page);
    if (s.p2First >= 1) { p2Seen = s; p2FlagAtRead = writtenFlagExists(ctx.workspaceName, 'P2'); break; }
    if (writtenFlagExists(ctx.workspaceName, 'P2') || Date.now() > p2Deadline) break;
    await page.waitForTimeout(100);
  }
  expect(p2Seen, 'L2:P2 的写盘标志出现之前,页面上应已出现 R191-P2-001(P2 边写边显示);实际在写盘标志出现时仍没有').not.toBeNull();
  expect(p2FlagAtRead, 'L2:读到 R191-P2-001 的那一刻,P2 的写盘标志应还不存在').toBe(false);

  // 回合结束(停止键消失)后 3 秒内每 300 毫秒读一次:各段的头与尾各恰好 1 次,没有「会话流连接失败」。
  expect(await waitStopGone(page, 40_000), 'L2:回合应在 40 秒内结束(停止键消失)').toBe(true);
  expect(readStage(ctx.workspaceName), '夹具自证:回合是正常跑完的').toBe('done');
  const final = await sampleFor(page, 3000, 300);
  expect(final.length, 'L2:回合结束后 3 秒内应读到至少 8 次').toBeGreaterThanOrEqual(8);
  const bad = final.map(pickFinal).filter((x) => JSON.stringify(x) !== JSON.stringify(FINAL_OK));
  expect(bad, `L2:回合结束后每次读到的 P0/P1/P2 开头、P1/P2 最后一片都应恰好 1 次且无「会话流连接失败」(期望 ${JSON.stringify(FINAL_OK)});不符的读数 = ${JSON.stringify(bad.slice(0, 3))}`).toEqual([]);
});

test('L3【复现】刷新后点停止:内容不丢、不重复、不闪,并且页面把会话文件重新读回来', async ({ page, ctx }) => {
  await startRoundUntilP1(page, ctx);
  await refreshAfterP1Started(page, ctx);

  // 刷新后 25 秒内页面上出现 R191-P1-001(与 L1 相同的前提);出现后再等 3 秒,点停止。
  const first = await waitSnap(page, (s) => s.p1First >= 1, 25_000);
  expect(first, 'L3:刷新回到会话后 25 秒内,页面上应出现 R191-P1-001(正在写的这一段的开头);实际一直没出现').not.toBeNull();
  await page.waitForTimeout(3000);
  expect(writtenFlagExists(ctx.workspaceName, 'P1'), '夹具自证:点停止时 P1 还没正常写盘').toBe(false);
  await stopBtn(page).first().click({ timeout: 10_000 });
  const t0 = Date.now();

  // 从点击起每 300 毫秒读一次,读到「停止键已消失且页面上出现 R191-P1-STOPPED」之后再满 3 秒为止;从点击算起最长 30 秒。
  const samples = [];
  let bothAt = null;
  for (;;) {
    const s = await snap(page);
    const now = Date.now();
    samples.push({ t: now - t0, p0: s.p0First, p1: s.p1First, stopped: s.p1Stopped, stopBtns: s.stopBtns, streamFail: s.streamFail });
    if (bothAt === null && s.stopBtns === 0 && s.p1Stopped >= 1) bothAt = now;
    if (bothAt !== null && now - bothAt >= 3000) break;
    if (now - t0 >= 30_000) break;
    await page.waitForTimeout(300);
  }
  expect(bothAt, `L3:点停止后 30 秒内应读到「停止键已消失且页面上出现 R191-P1-STOPPED」;实际没有。最后几次读数 = ${JSON.stringify(samples.slice(-3))}`).not.toBeNull();

  // 每一次读数里 R191-P0-001、R191-P1-001 恰好 1 次。
  const bad = samples.filter((x) => x.p0 !== 1 || x.p1 !== 1);
  expect(bad, `L3:点停止后每次读到的 R191-P0-001、R191-P1-001 都应恰好 1 次(不丢、不重复);不符的读数 = ${JSON.stringify(bad.slice(0, 3))}`).toEqual([]);

  // 停止键在点击后 15 秒内消失。
  const goneAt = samples.find((x) => x.stopBtns === 0);
  expect(goneAt, 'L3:点停止后停止键应消失;实际整个读数期间一直在').toBeDefined();
  expect(goneAt.t, `L3:点停止后 15 秒内停止键应消失;实际在点击后 ${goneAt.t} 毫秒`).toBeLessThanOrEqual(15_000);

  // R191-P1-STOPPED 在停止键消失后 10 秒内出现;出现之后的每次读数里恰好 1 次。
  const stoppedAt = samples.find((x) => x.stopped >= 1);
  expect(stoppedAt, 'L3:页面上应出现 R191-P1-STOPPED(证明页面把会话文件重新读回来了);实际没有').toBeDefined();
  expect(stoppedAt.t - goneAt.t, `L3:R191-P1-STOPPED 应在停止键消失后 10 秒内出现;实际晚了 ${stoppedAt.t - goneAt.t} 毫秒(停止键消失于点击后 ${goneAt.t} 毫秒)`).toBeLessThanOrEqual(10_000);
  const afterStopped = samples.filter((x) => x.t >= stoppedAt.t);
  const notOnce = afterStopped.filter((x) => x.stopped !== 1);
  expect(notOnce, `L3:R191-P1-STOPPED 出现之后每次读数里都应恰好 1 次;不符的读数 = ${JSON.stringify(notOnce.slice(0, 3))}`).toEqual([]);

  // 页面上没有「会话流连接失败」。
  expect(samples.filter((x) => x.streamFail).length, 'L3:页面上不应出现「会话流连接失败」').toBe(0);
});

// ───────────────────────── 相邻回归(改动前就应通过) ─────────────────────────
test('L4【守卫】不刷新时显示不变:P1 输出期间片号在增长,回合结束后 P0 / P1 / P2 开头各恰好 1 次', async ({ page, ctx }) => {
  await startRoundUntilP1(page, ctx);
  const a = await snap(page);
  await page.waitForTimeout(2000);
  const b = await snap(page);
  expect(b.maxP1, `L4:隔 2 秒后页面上 P1 的最大片号应比上一次(${a.maxP1})大`).toBeGreaterThan(a.maxP1);
  expect(await waitStopGone(page, 80_000), 'L4:回合应在 80 秒内结束(停止键消失)').toBe(true);
  expect(readStage(ctx.workspaceName), '夹具自证:回合是正常跑完的').toBe('done');
  const final = await sampleFor(page, 3000, 300);
  expect(final.length, 'L4:回合结束后 3 秒内应读到至少 8 次').toBeGreaterThanOrEqual(8);
  const bad = final.map((s) => ({ p0: s.p0First, p1: s.p1First, p2: s.p2First })).filter((x) => x.p0 !== 1 || x.p1 !== 1 || x.p2 !== 1);
  expect(bad, `L4:回合结束后每次读到的 R191-P0-001、R191-P1-001、R191-P2-001 都应恰好 1 次;不符的读数 = ${JSON.stringify(bad.slice(0, 3))}`).toEqual([]);
});
